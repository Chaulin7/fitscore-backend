'use strict';

/**
 * src/config/platformOwner.js — who the platform operator is.
 *
 * ONE definition, used by two callers that must never disagree:
 *
 *   routes/adminMetrics.isOwner   the guard on /admin/metrics
 *   routes/auth                   the isPlatformOwner flag on the session
 *                                 payload, which decides whether the SPA
 *                                 renders the "Metrics" menu item
 *
 * Before this existed the rule lived inside the route. Copying it into the auth
 * payload would have created a second expression of "who is the owner" that
 * drifts silently: the failure mode is a menu item that appears for somebody the
 * guard then 404s, or — worse and quieter — vanishes for the one person it is
 * for, with no error anywhere to say why.
 *
 * THE EMAIL IS NEVER SENT TO A CLIENT. isPlatformOwner() returns a boolean and
 * that boolean is all the API publishes. A client that learns the address learns
 * which account to go after; a client that learns "not you" learns nothing.
 *
 * The flag is a RENDERING HINT, never an authorisation. Anyone can set it in
 * their own browser and reveal the menu item; clicking it still meets the real
 * guard, which re-derives ownership here from the session on the server and
 * 404s. Nothing downstream trusts the client's copy — same rule config/plans.js
 * states for capability flags.
 */

const crypto = require('crypto');

/**
 * The single account permitted through the admin guard.
 *
 * ADMIN_OWNER_EMAIL first so a deployment can move it without a code change,
 * falling back to OWNER_EMAIL (already used by authService.migrateLegacyData to
 * create the owner user at boot) and finally to the operator address this was
 * built for.
 *
 * Note the contrast with services/branding.isCompedOrg(), which goes out of its
 * way NOT to hardcode an address: that is an ENTITLEMENT path, where a
 * hardcoded email would decide what a paying customer receives. This is an
 * internal access gate for one operator, and an env-overridable constant is the
 * honest expression of "there is exactly one of these".
 */
function ownerEmail() {
  const configured = process.env.ADMIN_OWNER_EMAIL || process.env.OWNER_EMAIL;
  return String(configured || 'jasperjoy99@gmail.com').trim().toLowerCase();
}

/**
 * Whether `email` is the operator address.
 *
 * Timing-safe. An email is not a secret and this is close to paranoia, but the
 * guard in front of /admin/metrics answers 404 to everything, so per-character
 * timing is the one signal a prober could still read off it. The fix costs
 * nothing, and putting it HERE means the auth payload cannot accidentally do
 * the naive comparison the guard was careful to avoid.
 */
function isOwnerEmail(email) {
  const actual = Buffer.from(String(email || '').trim().toLowerCase(), 'utf8');
  const expected = Buffer.from(ownerEmail(), 'utf8');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/**
 * Whether a user row is the platform operator.
 *
 * Requires BOTH the address and role 'owner'. The address alone would be enough
 * today, but role is what every other privileged route in this codebase checks
 * (routes/org.js, routes/team.js, routes/billing.js), and an account demoted to
 * member while keeping its address should not still hold the one cross-tenant
 * key in the product.
 *
 * Accepts either shape of user object in circulation — the raw database row
 * (snake_case) and the API's serialised user (camelCase) — because the guard
 * reads one and the auth payload builds the other, and a silent `undefined`
 * here would fail OPEN on the role check.
 */
function isPlatformOwner(user) {
  if (!user) return false;
  const role = user.role;
  return role === 'owner' && isOwnerEmail(user.email);
}

module.exports = { ownerEmail, isOwnerEmail, isPlatformOwner };
