'use strict';

/**
 * src/services/entitlements.js — subscription status -> what the account may do.
 *
 * ONE mapping, one place. Before the no-card trial there were three predicates
 * scattered across services/billing.js and middleware/auth.js, each spelling out
 * its own set of "healthy" statuses:
 *
 *   isUnlimited()        active | past_due
 *   hasActiveTeamPlan()  active | past_due
 *   requireSession()     (called hasActiveTeamPlan)
 *
 * Every one of those sets omits `trialing`, which was harmless while nothing
 * could be in it and is a silent product failure the moment a 30-day trial
 * exists: a trialing Pro org would have been capped at the FREE tier's ten
 * analyses a month, and a trialing Team org would have locked out every member
 * on their next request. The bug is not in any one of those lists — it is in
 * there being three lists. So the lists are gone and each of those predicates
 * now asks this module.
 *
 * `paused` is the other status this exists for. Stripe pauses a subscription
 * whose trial ended with no payment method (trial_settings.end_behavior
 * .missing_payment_method = 'pause'), which is a state the product had no way
 * to express: the account is neither entitled nor gone. READ_ONLY is that
 * state, and the rule for it is one sentence — they may read every byte they
 * put in, and may write nothing new.
 *
 * NOTHING IS DELETED at any level. Losing entitlement stops writes; it never
 * touches stored data. A customer who adds a card on day 35 finds their audit
 * log exactly as they left it.
 */

/** The three entitlement levels, ordered least -> most. */
const ENTITLEMENT = Object.freeze({
  NONE: 'none',
  READ_ONLY: 'read_only',
  FULL: 'full',
});

const ORDER = Object.freeze([ENTITLEMENT.NONE, ENTITLEMENT.READ_ONLY, ENTITLEMENT.FULL]);

/**
 * The status -> entitlement table, exactly as the trial spec states it.
 *
 * `past_due` is not in the spec's list and is FULL here, which is not an
 * oversight: it is the documented existing behaviour (docs/billing/README.md —
 * "access is kept and a warning is surfaced in the UI; the org is not cut off
 * immediately"), and a dunning window that quietly became a lockout would be a
 * regression dressed up as a new feature.
 *
 * `incomplete` is NONE at the subscription level — its first payment never
 * cleared, so it has never entitled anything. What that means for an ORG is
 * decided by entitlementForOrg() below, not here.
 */
const BY_STATUS = Object.freeze({
  trialing: ENTITLEMENT.FULL,
  active: ENTITLEMENT.FULL,
  past_due: ENTITLEMENT.FULL,
  paused: ENTITLEMENT.READ_ONLY,
  canceled: ENTITLEMENT.NONE,
  unpaid: ENTITLEMENT.NONE,
  incomplete: ENTITLEMENT.NONE,
  incomplete_expired: ENTITLEMENT.NONE,
});

/**
 * What a subscription in this status grants.
 *
 * Fails closed: an unrecognised status — a new one Stripe adds, a typo, null —
 * grants nothing. A caller that wants "no subscription means the free tier"
 * wants entitlementForOrg(), which says so explicitly.
 *
 * @param {string|null|undefined} status a Stripe subscription status
 * @returns {'full'|'read_only'|'none'}
 */
function entitlementForStatus(status) {
  if (typeof status !== 'string') return ENTITLEMENT.NONE;
  const level = BY_STATUS[status];
  return level || ENTITLEMENT.NONE;
}

/**
 * What an ORGANIZATION may do — the function routes actually call.
 *
 * The distinction from entitlementForStatus() is load-bearing and worth being
 * explicit about, because collapsing the two locks out most of the user base.
 *
 * An org with no live subscription is on the FREE tier, and the free tier is a
 * product we ship, not a punishment: full access, capped at FREE_MONTHLY_LIMIT
 * analyses a month by the quota gate, which is a separate axis from this one.
 * So a canceled subscription resolves to "free tier, full access" — the churn
 * behaviour docs/billing/README.md has always described — rather than to a
 * locked door. The status map only decides anything while the org is claiming a
 * PAID plan, which is precisely when a paused or dead subscription must bite.
 *
 * A comped org is fully entitled by definition; it holds a grant instead of a
 * subscription, so no status applies to it.
 *
 * @param {object|null} orgBilling a row from db.getOrgBilling()
 * @returns {'full'|'read_only'|'none'}
 */
function entitlementForOrg(orgBilling) {
  if (!orgBilling) return ENTITLEMENT.FULL; // unknown org -> free tier, quota-capped
  if (orgBilling.comped === 1 || orgBilling.comped === true) return ENTITLEMENT.FULL;

  const plan = orgBilling.plan || 'free';
  const status = orgBilling.subscriptionStatus || null;

  // Free tier: the quota gate is the only thing standing between this org and
  // an analysis, and it is not this function's job.
  if (plan === 'free') return ENTITLEMENT.FULL;

  const level = entitlementForStatus(status);
  // A paid plan whose subscription grants nothing falls back to the free tier
  // rather than to a lockout. The one exception is 'paused', which is a state
  // the customer can get OUT of by adding a card — reverting it to the free
  // tier would hand a trialist ten free analyses a month forever and remove
  // every reason to pay.
  if (level === ENTITLEMENT.NONE) {
    return status === 'paused' ? ENTITLEMENT.READ_ONLY : ENTITLEMENT.FULL;
  }
  return level;
}

/** Whether this entitlement permits creating or modifying data. */
function canWrite(level) {
  return level === ENTITLEMENT.FULL;
}

/** Whether this entitlement permits reading existing data. */
function canRead(level) {
  return level === ENTITLEMENT.FULL || level === ENTITLEMENT.READ_ONLY;
}

/** Whether `a` grants at least as much as `b`. */
function atLeast(a, b) {
  return ORDER.indexOf(a) >= ORDER.indexOf(b);
}

/**
 * Whether an org may perform a WRITE right now, with the reason when it may not.
 *
 * Returned rather than thrown so the two callers that need it — the middleware
 * below and the plan panel — agree on the wording without either restating it.
 */
function writeAccessFor(orgBilling) {
  const level = entitlementForOrg(orgBilling);
  if (canWrite(level)) return { allowed: true, level, code: null, message: null };
  if (level === ENTITLEMENT.READ_ONLY) {
    return {
      allowed: false,
      level,
      code: 'SUBSCRIPTION_PAUSED',
      message: 'Your trial ended without a payment method, so this account is read-only. '
        + 'Your data is intact — add a card to restore full access.',
    };
  }
  return {
    allowed: false,
    level,
    code: 'SUBSCRIPTION_INACTIVE',
    message: 'This organization\'s subscription is not active. Your data is intact — '
      + 'reactivate the plan to restore access.',
  };
}

module.exports = {
  ENTITLEMENT,
  ORDER,
  entitlementForStatus,
  entitlementForOrg,
  canWrite,
  canRead,
  atLeast,
  writeAccessFor,
};
