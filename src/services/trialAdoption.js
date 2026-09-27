'use strict';

/**
 * src/services/trialAdoption.js — attaching a person to the trial they started.
 *
 * GET /start creates the organization before the account exists, because the
 * Stripe customer has to hang off something the trial webhooks can resolve. So
 * there is always a gap between "the trial is running" and "somebody owns it",
 * and this module is the only thing allowed to close it.
 *
 * TWO ROUTES IN, and they are not equally trusted:
 *
 *   the token   adoptByToken(). The prospect followed /signup?t=<token>, a
 *               122-bit secret we sent to the invited address and that came
 *               back to us. Possession of it is the proof. This is the primary
 *               path and the only one that works today.
 *
 *   the address adoptByVerifiedEmail(). A fallback for the prospect who lost
 *               the link. It requires a PROVED address, which is why it is
 *               currently unreachable — see below.
 *
 * WHY EMAIL MATCHING ALONE WAS REPLACED. The previous bridge adopted any org
 * reserved for the address being signed up with. Nothing proved the person
 * signing up owned that address, so anyone who learned a prospect's email — a
 * forwarded invite, a guess at firstname@company.com — could sign up as them
 * and receive the company's trial organization, its Stripe customer and every
 * byte in it. It was also unreliable in the ordinary case: prospects routinely
 * pay from one address and sign up with another, and an email match silently
 * did nothing for them.
 */

const {
  findTrialInviteByToken, findAdoptableInviteByEmail, markTrialInviteConsumed,
  isEmailVerified, setUserOrg, nowIso,
} = require('./db');
const auth = require('./authService');
const trialInvites = require('./trialInvites');

/** Why an adoption did not happen. Server-side vocabulary; never shown raw. */
const OUTCOME = Object.freeze({
  ADOPTED: 'ADOPTED',
  NO_TOKEN: 'NO_TOKEN',
  NO_MATCH: 'NO_MATCH',
  INVALID: 'INVALID',
  UNVERIFIED_EMAIL: 'UNVERIFIED_EMAIL',
  RACE_LOST: 'RACE_LOST',
});

/**
 * Attach `userId` to the organization an invite reserved, and spend the link.
 *
 * The consume happens FIRST and its result decides everything: markTrialInviteConsumed
 * is a single UPDATE guarded by `consumed_at IS NULL`, so if two requests carry
 * the same link only one of them gets `true` back and only that one moves a
 * user. Doing it the other way round — adopt, then mark — would let both win
 * and leave the second user's own organization orphaned.
 */
function consumeAndAttach(invite, userId) {
  const consumed = markTrialInviteConsumed(invite.token, { consumedAt: nowIso(), userId });
  if (!consumed) return { adopted: false, outcome: OUTCOME.RACE_LOST, orgId: null, token: invite.token };

  setUserOrg(userId, invite.orgId);
  console.log('[trial] organization adopted', {
    token: invite.token, orgId: invite.orgId, userId, campaign: invite.campaign || null,
  });
  return { adopted: true, outcome: OUTCOME.ADOPTED, orgId: invite.orgId, token: invite.token };
}

/**
 * Adopt via the signup link. The primary path.
 *
 * Returns `adopted: false` for every failure rather than throwing, because the
 * caller's correct response to an unusable link is to carry on with an ordinary
 * signup — never to fail the account creation. A prospect whose link expired
 * still wants an account.
 *
 * @param {string} token the raw ?t= value
 * @param {string} userId the account to attach
 * @returns {{adopted: boolean, outcome: string, orgId: string|null, token: string|null}}
 */
function adoptByToken(token, userId, now = Date.now()) {
  if (!token) return { adopted: false, outcome: OUTCOME.NO_TOKEN, orgId: null, token: null };

  const check = trialInvites.validateSignupToken(token, now);
  if (!check.ok) {
    console.warn('[trial] signup link not usable', {
      reason: check.reason, userId, token: check.invite ? check.invite.token : null,
    });
    return { adopted: false, outcome: OUTCOME.INVALID, orgId: null, token: null };
  }
  return consumeAndAttach(check.invite, userId);
}

/**
 * Adopt by matching a PROVED email address. The fallback.
 *
 * UNREACHABLE TODAY, and deliberately so. It refuses unless
 * users.email_verified_at is set, and nothing in this codebase sets it: there
 * is no email-verification step yet. The gate is written now, ahead of the
 * mechanism, because the alternative is discovering later that the fallback was
 * wired into signup — where an address is by definition unproved — and has been
 * handing organizations to whoever typed the right string.
 *
 * THE CONSTRAINT, for whoever builds verification: this may only ever be called
 * from the point at which an address has just been PROVED. Never from signup,
 * never from login, never on a timer. The correct call site is the success
 * branch of a verify-email handler, immediately after it marks the address
 * verified. It re-checks isEmailVerified() itself rather than trusting its
 * caller, so a call from the wrong place fails closed instead of silently
 * adopting — but a caller that marks verified and then calls this from a place
 * that is not a verification step defeats that, which is why the rule is stated
 * here rather than only implied.
 *
 * @param {string} userId the account whose address has just been proved
 */
function adoptByVerifiedEmail(userId, now = Date.now()) {
  const user = auth.findUserById(userId);
  if (!user) return { adopted: false, outcome: OUTCOME.NO_MATCH, orgId: null, token: null };

  // The gate. Re-read from the database, never taken from a caller's argument.
  if (!isEmailVerified(userId)) {
    return { adopted: false, outcome: OUTCOME.UNVERIFIED_EMAIL, orgId: null, token: null };
  }

  const invite = findAdoptableInviteByEmail(user.email, new Date(now).toISOString());
  if (!invite) return { adopted: false, outcome: OUTCOME.NO_MATCH, orgId: null, token: null };

  return consumeAndAttach(invite, userId);
}

/**
 * The invite a signup link refers to, for display before an account exists.
 *
 * Publishes only what the page needs to say "you are completing setup for
 * Acme BV": the company name and the invited address. Never the org id, the
 * Stripe customer or the campaign — a caller holding the token is a prospect,
 * not an operator.
 */
function describeSignupToken(token, now = Date.now()) {
  const check = trialInvites.validateSignupToken(token, now);
  if (!check.ok) return { valid: false, companyName: null, email: null };
  return {
    valid: true,
    companyName: check.invite.companyName || null,
    email: check.invite.email,
  };
}

/**
 * The account already holding the organization this token points at, if any.
 *
 * Used by the signup route to tell somebody who already has an account to log
 * in, rather than refusing them with a bare "email taken" that does not explain
 * that their trial is already waiting on the other side of the login form.
 */
function existingOwnerForToken(token) {
  const invite = findTrialInviteByToken(String(token || '').trim());
  if (!invite || !invite.orgId) return null;
  return auth.listOrgUsers(invite.orgId).find((u) => u.role === 'owner') || null;
}

module.exports = {
  OUTCOME,
  adoptByToken,
  adoptByVerifiedEmail,
  describeSignupToken,
  existingOwnerForToken,
};
