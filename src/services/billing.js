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

const FREE_MONTHLY_LIMIT = Number.parseInt(process.env.FREE_MONTHLY_LIMIT, 10) > 0
  ? Number.parseInt(process.env.FREE_MONTHLY_LIMIT, 10)
  : 25;

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

// Decide whether an org may run `requested` more analyses this period.
// Returns { allowed, limit, used, plan }.
function checkQuota(billing, used, requested) {
  const limit = limitFor(billing);
  const plan = billing ? billing.plan : 'free';
  if (limit === null) return { allowed: true, limit: null, used, plan };
  return { allowed: used + requested <= limit, limit, used, plan };
}

module.exports = {
  FREE_MONTHLY_LIMIT,
  getStripe,
  isBillingConfigured,
  priceIdForPlan,
  planForPriceId,
  isUnlimited,
  limitFor,
  checkQuota,
};
