'use strict';

/**
 * src/services/billing.js
 *
 * Plan logic + Stripe client. All Stripe identifiers come from env/config —
 * nothing is hardcoded, so the later domain switch is an env + dashboard
 * change only.
 *
 * Plans (attached to the organization, not the user):
 *  - free: up to FREE_MONTHLY_LIMIT analyses per org per calendar month
 *  - pro:  unlimited, single org
 *  - team: unlimited, allows multiple member users
 */

let Stripe = null;
try { Stripe = require('stripe'); } catch (_) { /* SDK optional until configured */ }

const {
  PLANS, FREE_MONTHLY_LIMIT, ENTITLEMENT_AXES, capabilitiesFor, phraseForAxis,
} = require('../config/plans');

// Seat cap for an org allowed multiple members (0 = unlimited). Lives here,
// next to hasActiveTeamPlan, because the two together ARE the seat gate;
// routes/team.js imports it rather than re-reading the environment, so the
// capacity check and the capacity we advertise are one number.
const TEAM_MAX_MEMBERS = Number.parseInt(process.env.TEAM_MAX_MEMBERS, 10) >= 0
  ? Number.parseInt(process.env.TEAM_MAX_MEMBERS, 10)
  : 0; // 0 = unlimited

// Lazily created so the app boots even when billing isn't configured.
let _stripe = null;
function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY || !Stripe) return null;
  if (!_stripe) _stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  return _stripe;
}

function isBillingConfigured() {
  return !!getStripe();
}

function priceIdForPlan(plan) {
  if (plan === 'pro') return process.env.STRIPE_PRICE_PRO || null;
  if (plan === 'team') return process.env.STRIPE_PRICE_TEAM || null;
  return null;
}

// Map a Stripe price ID back to our plan name (used by the webhook).
function planForPriceId(priceId) {
  if (priceId && priceId === process.env.STRIPE_PRICE_PRO) return 'pro';
  if (priceId && priceId === process.env.STRIPE_PRICE_TEAM) return 'team';
  return null;
}

// Unlimited when on a paid plan with an active (or past_due — grace) subscription.
function isUnlimited(billing) {
  if (!billing) return false;
  const paid = billing.plan === 'pro' || billing.plan === 'team';
  const ok = billing.subscriptionStatus === 'active' || billing.subscriptionStatus === 'past_due';
  return paid && ok;
}

// Effective monthly limit (null = unlimited).
function limitFor(billing) {
  return isUnlimited(billing) ? null : FREE_MONTHLY_LIMIT;
}

// Whether an org may have more than one active user (Team plan, active or in
// the past_due grace window). Free/Pro orgs stay owner-only.
function hasActiveTeamPlan(billing) {
  if (!billing) return false;
  const ok = billing.subscriptionStatus === 'active' || billing.subscriptionStatus === 'past_due';
  return billing.plan === 'team' && ok;
}

// Decide whether an org may run `requested` more analyses this period.
// Returns { allowed, limit, used, plan }.
function checkQuota(billing, used, requested) {
  const limit = limitFor(billing);
  const plan = billing ? billing.plan : 'free';
  if (limit === null) return { allowed: true, limit: null, used, plan };
  return { allowed: used + requested <= limit, limit, used, plan };
}

// --- Entitlement axes (what a tier actually grants) -------------------------

/**
 * The enforced entitlement vector for a tier, as if its subscription were
 * healthy.
 *
 * Every value is produced by running the REAL gate rather than by reading a
 * table that describes it: the quota axis calls limitFor(), the seat axis calls
 * hasActiveTeamPlan(), and branding calls capabilitiesFor(). A synthetic
 * 'active' billing record is passed in because the question here is what the
 * TIER grants, not what this particular org's subscription status currently
 * permits — an org in past_due still needs to be told what Team would give it.
 *
 * Consequence worth stating: if a gate changes, these values change with it. No
 * copy anywhere needs updating for the upgrade surface to stay truthful.
 *
 * @param {string} tierId 'free' | 'pro' | 'team'
 * @returns {{analysesPerMonth: number|null, seats: number|null, customBranding: boolean}}
 *   null means unbounded on that axis.
 */
function entitlementAxesFor(tierId) {
  const healthy = { plan: tierId, subscriptionStatus: 'active' };
  const multiSeat = hasActiveTeamPlan(healthy);
  return {
    analysesPerMonth: limitFor(healthy),
    seats: multiSeat ? (TEAM_MAX_MEMBERS || null) : 1,
    customBranding: !!capabilitiesFor(tierId).customBranding,
  };
}

// Whether `to` is strictly more entitlement than `from` on one axis. null is
// unbounded, so it beats every number; false < true for the boolean axis.
function axisImproves(axis, from, to) {
  if (axis === 'customBranding') return !from && !!to;
  if (to === null) return from !== null;
  if (from === null) return false;
  return to > from;
}

/**
 * What moving from one tier to another actually gains, per enforced axis.
 *
 * The `axis`/`from`/`to` fields are the computed answer; `label` is only how it
 * is said (config/plans.js PHRASE). A caller comparing gains should compare
 * axes — rewording a phrase must not read as a different entitlement, which is
 * the property planSummary.test.js pins.
 *
 * @returns {Array<{axis: string, from: *, to: *, label: string}>}
 */
function gainsBetween(fromTierId, toTierId) {
  const from = entitlementAxesFor(fromTierId);
  const to = entitlementAxesFor(toTierId);
  const gains = [];
  for (const axis of ENTITLEMENT_AXES) {
    if (!axisImproves(axis, from[axis], to[axis])) continue;
    const label = phraseForAxis(axis, to[axis]);
    if (label) gains.push({ axis, from: from[axis], to: to[axis], label });
  }
  return gains;
}

// Tier position, taken from the declared low->high order in config/plans.js so
// nothing here re-states the ranking. -1 for anything unrecognised, which makes
// an unknown tier compare as below every real one (fails closed at the guard).
function planRank(tierId) {
  return PLANS.tiers.findIndex((t) => t.id === tierId);
}

/**
 * Subscription statuses in which a SECOND checkout for the same tier would
 * duplicate a subscription the org already holds.
 *
 * Deliberately not the same set as the entitlement predicates above. A trialing
 * or paused subscription grants nothing right now, but it is live: it will bill
 * when the trial converts or collection resumes, so selling the same tier again
 * produces two subscriptions. `incomplete` is the opposite case — the initial
 * payment never succeeded, the subscription bills nothing and Stripe expires it
 * within about a day — so there is nothing there to duplicate.
 */
const LIVE_SUBSCRIPTION_STATUSES = new Set(['active', 'past_due', 'trialing', 'paused']);

function hasLiveSubscription(orgBilling) {
  return !!orgBilling && LIVE_SUBSCRIPTION_STATUSES.has(orgBilling.subscriptionStatus);
}

/**
 * The tier the checkout guard ranks against.
 *
 * The stored `plan` string alone is the wrong input. The webhook resets plan to
 * 'free' on the terminal states (canceled, unpaid, incomplete_expired and the
 * subscription.deleted branch), so those recover on their own — but `incomplete`
 * is not in that list, which leaves an org sitting at plan='pro' with a dead
 * subscription, no entitlement, and a guard that refuses to let it buy Pro. The
 * owner is trying to give us money and cannot.
 *
 * So a paid plan only counts as held while a subscription is actually live at
 * it. A comped org keeps its tier — it is entitled with no subscription by
 * design, and checkout refuses it earlier and for its own reason.
 */
function effectiveTierFor(orgBilling) {
  if (!orgBilling) return 'free';
  const plan = orgBilling.plan || 'free';
  if (plan === 'free') return 'free';
  if (orgBilling.comped === 1 || orgBilling.comped === true) return plan;
  return hasLiveSubscription(orgBilling) ? plan : 'free';
}

// Whether `target` is a genuine upgrade from `current`. Used by the checkout
// guard to refuse a same-tier repurchase (which would attach a SECOND Stripe
// subscription to the org, i.e. bill twice) and any downgrade.
function isUpgradeFrom(currentTierId, targetTierId) {
  const a = planRank(currentTierId);
  const b = planRank(targetTierId);
  return b >= 0 && b > a;
}

module.exports = {
  FREE_MONTHLY_LIMIT,
  TEAM_MAX_MEMBERS,
  entitlementAxesFor,
  gainsBetween,
  planRank,
  isUpgradeFrom,
  LIVE_SUBSCRIPTION_STATUSES,
  hasLiveSubscription,
  effectiveTierFor,
  getStripe,
  isBillingConfigured,
  priceIdForPlan,
  planForPriceId,
  isUnlimited,
  hasActiveTeamPlan,
  limitFor,
  checkQuota,
};
