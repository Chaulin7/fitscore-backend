'use strict';

/**
 * src/routes/billing.js — Stripe subscription billing (per organization).
 *
 * Router (mounted under /api/billing, behind requireSession):
 *   GET  /usage     current plan + usage (any member)
 *   POST /checkout  start a Checkout Session (owner only)
 *   POST /portal    open the Billing Portal (owner only)
 *
 * Webhook handler is exported separately and mounted in index.js BEFORE the
 * JSON body parser, with express.raw, and is exempt from auth (Stripe can't
 * send a session token). Stripe is the source of truth for plan state.
 *
 * All Stripe identifiers and the webhook secret come from env/config.
 */

const express = require('express');
const { requireSession } = require('../middleware/auth');
const auth = require('../services/authService');
const billing = require('../services/billing');
const {
  getOrgBilling, getUsageCount, currentPeriodKey,
  setOrgStripeCustomerId, findOrgByStripeCustomerId, setOrgPlan,
} = require('../services/db');
const { tierById, PLANS, ENTITLEMENT_AXES, phraseForAxis } = require('../config/plans');
const { baseUrlFor } = require('../config/appUrl');

const router = express.Router();

function sendError(res, status, code, message) {
  return res.status(status).json({ error: message, code });
}

function requireOwner(req, res, next) {
  const user = auth.findUserById(req.userId);
  if (!user || user.org_id !== req.orgId || user.role !== 'owner') {
    return sendError(res, 403, 'OWNER_REQUIRED', 'Only the organization owner can manage billing.');
  }
  return next();
}

// Stripe success/cancel and portal-return URLs. Resolved by the one shared
// helper (src/config/appUrl.js) rather than reading APP_BASE_URL directly, so a
// deployment that sets only PUBLIC_APP_URL no longer sends customers back to the
// proxy host after paying.
const appBaseUrl = baseUrlFor;

// GET /api/billing/usage — plan + usage for the current period (any member)
router.get('/usage', requireSession, (req, res) => {
  try {
    const b = getOrgBilling(req.orgId) || { plan: 'free', subscriptionStatus: null, currentPeriodEnd: null };
    const periodKey = currentPeriodKey();
    res.json({
      plan: b.plan || 'free',
      subscriptionStatus: b.subscriptionStatus || null,
      currentPeriodEnd: b.currentPeriodEnd || null,
      used: getUsageCount(req.orgId, periodKey),
      limit: billing.limitFor(b), // null = unlimited
      periodKey,
      billingConfigured: billing.isBillingConfigured(),
    });
  } catch (err) {
    sendError(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// --- Plan summary (the nav plan panel) --------------------------------------

// A comped org is fully entitled with no Stripe subscription behind it. It has
// no customer id, so the portal would 400, and sending it to checkout would
// attach a real paid subscription to an account that is deliberately not
// paying. Both surfaces are therefore suppressed for it rather than offered
// and then failed.
function isComped(orgBilling) {
  return !!orgBilling && (orgBilling.comped === 1 || orgBilling.comped === true);
}

/**
 * Whether a comp should stop this org opening Checkout.
 *
 * Being comped is NOT itself a reason to refuse. A comp is a grant with no
 * subscription behind it, so there is nothing a new checkout could duplicate,
 * and a design partner deciding to start paying is a conversion rather than an
 * error — refusing it meant a customer who wanted to pay us could not.
 *
 * The narrow case that IS a hazard: a comped org that somehow already carries a
 * subscription id. That one is duplicable, so it keeps the refusal.
 */
function compedBlocksCheckout(orgBilling) {
  return isComped(orgBilling) && !!(orgBilling && orgBilling.stripeSubscriptionId);
}

/**
 * Why billing cannot be managed, or null when it can.
 *
 * These are three genuinely different states and the panel says something
 * different for each: a member is told who CAN do it, an org with no customer
 * is told there is nothing to manage yet, and an unconfigured deployment is
 * told it is the server. Collapsing them into one boolean is what produces an
 * action area that is simply empty for a member with no explanation.
 */
function billingBlockReason({ isOwner, orgBilling, configured }) {
  if (!isOwner) return 'NOT_OWNER';
  if (!configured) return 'BILLING_NOT_CONFIGURED';
  if (isComped(orgBilling)) return 'COMPED';
  if (!orgBilling || !orgBilling.stripeCustomerId) return 'NO_CUSTOMER';
  return null;
}

/**
 * The panel's state, derived from the authoritative subscription record.
 *
 * Keyed on the TERMINAL SET rather than on individual statuses, so a churned
 * org resolves to 'free' however it churned — canceled, unpaid or
 * incomplete_expired all mean the same thing to a customer looking at the
 * panel: they are on Free and the way forward is to buy.
 */
function planPanelState(orgBilling) {
  const b = orgBilling || {};
  const plan = b.plan || 'free';
  const status = b.subscriptionStatus || null;

  if (plan === 'free' || billing.TERMINAL_SUBSCRIPTION_STATUSES.has(status)) return 'free';
  // Ordered by urgency. past_due outranks a scheduled cancellation because the
  // customer is actively losing access; a scheduled cancellation is not urgent
  // until it happens.
  if (status === 'past_due') return 'past_due';
  if (status === 'incomplete') return 'incomplete';
  if (b.cancelAtPeriodEnd === 1 || b.cancelAtPeriodEnd === true) return 'cancel_scheduled';
  return plan === 'team' ? 'team_active' : 'pro_active';
}

/**
 * The actions the panel may offer, for this state and this member.
 *
 * The whole mapping lives here so the client renders a list rather than
 * re-deciding from a status string it was handed. At most ONE action is
 * `primary`; `anchor` says where it belongs — next to the limit it unlocks, or
 * in the footer.
 *
 * Non-owners get an empty list. The buttons are not merely hidden: POST
 * /checkout and POST /portal are both behind requireOwner and answer 403, so
 * an empty list here and a refusal there are the same rule stated twice.
 */
function planActions(state, { isOwner, canCheckout, canPortal, plan }) {
  if (!isOwner) return [];

  // The price rides on the button rather than in a block of copy beside it:
  // constraint is no secondary upsell copy, but a control that spends money
  // has to say how much. Composed from config/plans.js, never typed here.
  const upgradeLabel = (targetPlan) => {
    const t = tierById(targetPlan);
    return t ? `Upgrade to ${t.name} — ${t.priceLabel}${t.per || ''}` : 'Upgrade';
  };
  const checkout = (id, label, kind, targetPlan, anchorTo) => (canCheckout
    ? [{ id, label, kind, action: 'startPlanCheckout', plan: targetPlan, anchor: anchorTo }] : []);
  const portal = (id, label, kind) => (canPortal
    ? [{ id, label, kind, action: 'openBillingPortal', anchor: 'footer' }] : []);

  switch (state) {
    case 'free':
      // Pro is the primary; Team stays reachable as a ghost so a free agency
      // that needs seats is not forced to buy Pro first. Still one primary.
      return [
        ...checkout('upgrade_pro', upgradeLabel('pro'), 'primary', 'pro', 'analyses'),
        ...checkout('upgrade_team', upgradeLabel('team'), 'ghost', 'team', 'footer'),
      ];
    case 'pro_active':
      // NO UPGRADE ACTION HERE — deliberately, and temporarily.
      //
      // POST /checkout always opens a NEW Checkout Session, and the webhook
      // de-duplication is scoped to the same tier on purpose, so it does not
      // touch a Pro subscription when a Team one appears. A Pro org that
      // upgraded through this button therefore ended up with BOTH
      // subscriptions live: 49 + 199 = 248 EUR a month, recurring, with
      // nothing in the product showing the second one.
      //
      // The fix is a tier change on the existing subscription
      // (subscriptions.update with proration) rather than a second session.
      // Until that lands, the safe move is to not offer the button: an owner
      // who wants Team can be moved by hand, and nobody is silently
      // double-charged in the meantime.
      //
      // TO RESTORE: put the checkout(...) line back once the proration path
      // exists, and point it at that path rather than at Checkout.
      //
      // Side effect worth knowing: a comped Pro org also loses this button.
      // Checkout would actually be safe for them (they hold no subscription to
      // duplicate), but the gate is kept total rather than conditional so
      // there is one rule to reason about while the real fix is built.
      return portal('manage_billing', 'Manage billing', 'primary');
    case 'team_active':
      return portal('manage_billing', 'Manage billing', 'primary');
    case 'past_due':
      // No upsell while a payment is failing.
      return portal('update_payment', 'Update payment method', 'primary');
    case 'incomplete':
      // The portal cannot finish a subscription whose first payment never
      // cleared — Stripe expires it within about a day. A fresh checkout at the
      // SAME tier is the recovery, and the webhook de-duplication cancels
      // whichever attempt loses, so this does not route around that guard.
      return checkout('complete_payment', 'Complete payment', 'primary', plan, 'footer');
    case 'cancel_scheduled':
      return portal('reactivate', 'Reactivate plan', 'primary');
    default:
      return [];
  }
}

// GET /api/billing/plan-summary — everything the plan panel renders (any member)
//
// Deliberately separate from /usage: that endpoint runs after every analysis
// and its shape is depended on by the nav chip, so it stays small and hot.
// This one is fetched only when the panel opens and may be as rich as the
// panel needs. Nothing here is trusted from the client — plan, price,
// entitlements, usage and upgrade targets are all read server-side from the
// session's org.
router.get('/plan-summary', requireSession, (req, res) => {
  try {
    const b = getOrgBilling(req.orgId) || {};
    const plan = b.plan || 'free';
    const tier = tierById(plan) || tierById('free');
    const user = auth.findUserById(req.userId);
    const isOwner = !!(user && user.org_id === req.orgId && user.role === 'owner');
    const configured = billing.isBillingConfigured();
    const comped = isComped(b);
    const periodKey = currentPeriodKey();

    const blockReason = billingBlockReason({ isOwner, orgBilling: b, configured });
    const axes = billing.entitlementAxesFor(tier.id);

    // Upgrade targets: strictly higher tiers only, and none at all for a comped
    // org (see isComped above). Each carries what it GAINS over the current
    // tier, computed from the enforced axes rather than from tier copy.
    // Ranked from the same baseline POST /checkout uses, so the panel never
    // offers a purchase the server would refuse, nor hides one it would accept.
    // For a comped org that baseline is 'free' — the grant is not a
    // subscription — which is what lets it convert at its own tier.
    const upgradeBlocked = compedBlocksCheckout(b);
    const rankFrom = comped ? 'free' : tier.id;
    const upgrades = upgradeBlocked ? [] : PLANS.tiers
      .filter((t) => billing.isUpgradeFrom(rankFrom, t.id) && t.upgradePlan)
      .map((t) => ({
        id: t.id,
        plan: t.upgradePlan,
        name: t.name,
        priceLabel: t.priceLabel,
        per: t.per,
        taxNote: t.taxNote || null,
        tagline: t.tagline,
        // Gains from the same baseline, so a card cannot advertise a gain the
        // ranking did not consider.
        gains: billing.gainsBetween(rankFrom, t.id),
      }));

    const state = planPanelState(b);
    const actions = planActions(state, {
      isOwner,
      canCheckout: configured && !upgradeBlocked,
      canPortal: blockReason === null,
      plan: tier.id,
    });

    res.json({
      state,
      actions,
      plan: tier.id,
      planName: tier.name,
      priceLabel: tier.priceLabel,
      per: tier.per,
      taxNote: tier.taxNote || null,
      subscriptionStatus: b.subscriptionStatus || null,
      currentPeriodEnd: b.currentPeriodEnd || null,
      cancelAtPeriodEnd: b.cancelAtPeriodEnd === 1 || b.cancelAtPeriodEnd === true,
      comped,
      isOwner,
      billingConfigured: configured,
      // One positive flag plus the reason it is false, so the panel never has
      // to infer "why" from a combination of other fields.
      canManageBilling: blockReason === null,
      billingBlockReason: blockReason,
      canUpgrade: isOwner && configured && !upgradeBlocked,
      usage: {
        periodKey,
        analyses: { used: getUsageCount(req.orgId, periodKey), limit: axes.analysesPerMonth },
        seats: { used: auth.countOrgUsers(req.orgId), limit: axes.seats },
      },
      // What this tier grants, phrased from the same axis values the gates read.
      entitlements: ENTITLEMENT_AXES
        .map((axis) => ({ axis, value: axes[axis], label: phraseForAxis(axis, axes[axis]) }))
        .filter((e) => e.label),
      upgrades,
    });
  } catch (err) {
    sendError(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// --- Stripe Tax misconfiguration ------------------------------------------
// Turning automatic_tax on moves a whole class of failure from "impossible" to
// "one dashboard setting away": Stripe Tax needs an origin address on the
// account, at least one active registration, and a tax_behavior on every Price
// (a Price created with tax_behavior 'unspecified' cannot be used with
// automatic tax, and that field is immutable, so it needs a NEW Price).
//
// All of those surface as a generic Stripe error at session creation, which
// previously became a 502 STRIPE_ERROR and, on the pricing page, a button that
// silently did nothing. None of them are the customer's fault or the code's;
// they are all "go fix the Stripe dashboard". They get their own code so the
// logs, the owner's toast and the visitor's message all say tax.
//
// Matched on Stripe's own error codes first, then on the parameter/message,
// because the parameter-level failures (automatic_tax[enabled], tax_behavior)
// arrive without a stable machine code.
const TAX_ERROR_CODES = new Set([
  'customer_tax_location_invalid',
  'tax_id_invalid',
  'invalid_tax_location',
]);

function isTaxConfigError(err) {
  if (!err) return false;
  if (err.code && TAX_ERROR_CODES.has(err.code)) return true;
  const haystack = `${err.param || ''} ${err.message || ''}`;
  return /automatic_tax|tax_id_collection|tax_behavior|tax registration|origin address|stripe tax|tax settings/i
    .test(haystack);
}

function taxConfigMessage(err) {
  // The underlying text is kept: it is the fastest route to the offending
  // setting, and this endpoint is owner-only, so it is not leaking to the world.
  const detail = err && err.message ? ` Stripe said: ${err.message}` : '';
  return 'Checkout could not start because this account\'s Stripe Tax configuration is '
    + 'incomplete. Stripe Tax needs an origin address, at least one active tax registration, '
    + `and a tax behavior set on each price.${detail}`;
}

// POST /api/billing/checkout { plan: 'pro'|'team' } (owner only)
router.post('/checkout', requireSession, requireOwner, async (req, res) => {
  try {
    const stripe = billing.getStripe();
    if (!stripe) return sendError(res, 503, 'BILLING_NOT_CONFIGURED', 'Billing is not configured on the server.');

    const plan = (req.body || {}).plan;
    if (plan !== 'pro' && plan !== 'team') {
      return sendError(res, 400, 'VALIDATION_ERROR', "plan must be 'pro' or 'team'.");
    }

    // Refuse anything that is not a strict upgrade from what the org is on.
    //
    // The same-tier case is the expensive one: Checkout would happily open a
    // SECOND subscription against the same customer and bill the org twice for
    // one plan. A Pro org whose subscription is set to cancel at period end is
    // refused here too — the fix for that is Resume in the portal, not a
    // duplicate subscription that outlives the cancellation.
    //
    // A comped org is refused for the opposite reason: it is entitled without
    // paying, and checkout would attach a real subscription it should not have.
    const currentBilling = getOrgBilling(req.orgId) || {};
    // Ranked against the tier the org EFFECTIVELY holds, not the stored plan
    // string: an org whose subscription died without reaching a terminal status
    // (notably 'incomplete') still reads as plan='pro' and would otherwise be
    // permanently refused the very purchase it is trying to make.
    const currentPlan = billing.effectiveTierFor(currentBilling);
    if (compedBlocksCheckout(currentBilling)) {
      return sendError(res, 400, 'PLAN_COMPED',
        'This account is on a complimentary plan with a subscription already attached. '
        + 'Contact support to change it.');
    }
    // Rank against what a second checkout could DUPLICATE, which is a live
    // subscription — not what the org is entitled to. A comp confers a tier
    // with nothing behind it, so it must not block conversion to paying.
    // Deliberately computed here rather than inside effectiveTierFor(): that
    // function answers "what tier does this org hold", and teaching it to
    // answer 'free' for a comped org would be a trap for any future caller
    // that reached for it to gate a feature.
    const rankAgainst = isComped(currentBilling) ? 'free' : currentPlan;
    if (!billing.isUpgradeFrom(rankAgainst, plan)) {
      return sendError(res, 400, 'PLAN_NOT_AN_UPGRADE',
        `This organization is already on the ${rankAgainst} plan.`);
    }

    const priceId = billing.priceIdForPlan(plan);
    if (!priceId) return sendError(res, 503, 'BILLING_NOT_CONFIGURED', `No price configured for the ${plan} plan.`);

    // Create or reuse the org's Stripe customer.
    let { stripeCustomerId } = getOrgBilling(req.orgId) || {};
    if (!stripeCustomerId) {
      const user = auth.findUserById(req.userId);
      const org = auth.getOrganizationById(req.orgId);
      const customer = await stripe.customers.create({
        email: user ? user.email : undefined,
        name: org ? org.name : undefined,
        metadata: { orgId: req.orgId },
      });
      stripeCustomerId = customer.id;
      setOrgStripeCustomerId(req.orgId, stripeCustomerId);
    }

    const base = appBaseUrl(req);
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: stripeCustomerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${base}/?billing=success`,
      cancel_url: `${base}/?billing=cancel`,
      metadata: { orgId: req.orgId, plan },
      subscription_data: { metadata: { orgId: req.orgId, plan } },

      // --- Stripe Tax ------------------------------------------------------
      // Stripe decides the rate. Nothing here encodes a rate, a country or a
      // threshold: that logic lives in the Stripe dashboard's tax settings and
      // registrations, which change without a deploy.
      //
      // We create the Customer ourselves (above) with no address — the app
      // holds none — so on a first purchase there is nothing for Stripe Tax to
      // locate. Checkout collects a billing address when automatic_tax is on,
      // and customer_update writes it back onto the Customer so the second
      // purchase, the subscription renewals and the invoices all have it.
      // Without customer_update, Stripe rejects the session outright for an
      // existing Customer.
      automatic_tax: { enabled: true },
      tax_id_collection: { enabled: true }, // EU B2B: VAT number -> reverse charge
      customer_update: { address: 'auto', name: 'auto' },
    });
    res.json({ url: session.url });
  } catch (err) {
    if (isTaxConfigError(err)) {
      return sendError(res, 503, 'TAX_NOT_CONFIGURED', taxConfigMessage(err));
    }
    sendError(res, 502, 'STRIPE_ERROR', err.message);
  }
});

// POST /api/billing/portal (owner only)
router.post('/portal', requireSession, requireOwner, async (req, res) => {
  try {
    const stripe = billing.getStripe();
    if (!stripe) return sendError(res, 503, 'BILLING_NOT_CONFIGURED', 'Billing is not configured on the server.');
    const { stripeCustomerId } = getOrgBilling(req.orgId) || {};
    if (!stripeCustomerId) return sendError(res, 400, 'NO_CUSTOMER', 'No billing customer yet. Upgrade first.');
    const session = await stripe.billingPortal.sessions.create({
      customer: stripeCustomerId,
      return_url: `${appBaseUrl(req)}/`,
    });
    res.json({ url: session.url });
  } catch (err) {
    sendError(res, 502, 'STRIPE_ERROR', err.message);
  }
});

// --- Webhook (raw body, signature-verified, auth-exempt) -------------------

// Applies a Stripe Subscription object to our org plan state. Idempotent:
// always sets state from the event, never blindly toggles. `eventCreated`
// (unix seconds) advances the ordering guard so later stale events are skipped.
// The price on a subscription object, or null. Stripe nests this four deep and
// every level is optional on a malformed or partially expanded object.
function priceIdOf(subscription) {
  return (subscription && subscription.items && subscription.items.data
    && subscription.items.data[0] && subscription.items.data[0].price
    && subscription.items.data[0].price.id) || null;
}

// Statuses in which a subscription still exists as far as billing is concerned.
// Deliberately wider than billing.LIVE_SUBSCRIPTION_STATUSES: 'incomplete' is
// included here precisely because it is the one that needs cancelling.
const NON_TERMINAL_SUBSCRIPTION_STATUSES = new Set([
  'active', 'past_due', 'trialing', 'paused', 'incomplete',
]);

/**
 * Cancel any OTHER subscription on the same customer for the same tier.
 *
 * Checkout is mode:'subscription' with no reference to an existing
 * subscription, so every session creates a new one — Stripe does not reuse or
 * supersede the old object. Combined with the ~23h window in which an
 * 'incomplete' subscription can still be completed by a late 3DS confirmation,
 * a customer can finish with two live subscriptions at the same tier: the org
 * row holds one stripe_subscription_id, and the other bills forever with
 * nothing in the product referring to it.
 *
 * Scoped to the SAME tier on purpose. A different tier on the same customer is
 * the Pro -> Team upgrade path, which also leaves two subscriptions today but
 * is a separate problem with a different correct answer (proration on the
 * existing subscription, not a second checkout), and silently cancelling
 * someone's other tier here would be worse than the bug.
 *
 * Best-effort: a failure to reach Stripe must not fail the webhook, because the
 * org's own plan state has already been written correctly by the caller and
 * services/stripeReconcile.js reports the duplicate either way.
 */
async function cancelSupersededSubscriptions(subscription, plan) {
  const stripe = billing.getStripe();
  if (!stripe || !subscription || !subscription.id || !subscription.customer) return;
  if (!plan || plan === 'free') return;
  // Only a subscription that is actually billing supersedes another. An
  // 'incomplete' one arriving must never cancel the active subscription.
  if (!billing.LIVE_SUBSCRIPTION_STATUSES.has(subscription.status)) return;

  let list;
  try {
    list = await stripe.subscriptions.list({ customer: subscription.customer, status: 'all', limit: 100 });
  } catch (err) {
    console.warn('[billing] could not list subscriptions to de-duplicate', { error: err.message });
    return;
  }
  for (const other of (list && list.data) || []) {
    if (!other || other.id === subscription.id) continue;
    if (!NON_TERMINAL_SUBSCRIPTION_STATUSES.has(other.status)) continue;
    if (billing.planForPriceId(priceIdOf(other)) !== plan) continue;
    try {
      await stripe.subscriptions.cancel(other.id);
      console.warn('[billing] cancelled a superseded duplicate subscription', {
        kept: subscription.id, cancelled: other.id, customer: subscription.customer, plan,
      });
    } catch (err) {
      console.warn('[billing] could not cancel superseded subscription', {
        subscriptionId: other.id, error: err.message,
      });
    }
  }
}

/**
 * Whether a plan-REMOVING event actually concerns the subscription this org is
 * on. Cancelling a superseded duplicate makes Stripe emit a deleted/canceled
 * event for it, and without this that event would land on the org and downgrade
 * the customer who just paid — the ordering guard cannot help, because the
 * cancellation is genuinely the newer event.
 *
 * A null stored id means we are not tracking one yet, so the event is accepted.
 */
function concernsCurrentSubscription(orgId, subscriptionId) {
  const stored = getOrgBilling(orgId);
  const current = stored && stored.stripeSubscriptionId;
  if (!current || !subscriptionId) return true;
  return current === subscriptionId;
}

async function applySubscription(orgId, subscription, eventCreated) {
  const status = subscription.status; // active, past_due, canceled, ...
  const priceId = priceIdOf(subscription);
  let plan = billing.planForPriceId(priceId);

  // Terminal states fall back to free — but only when the event is about the
  // subscription this org is actually on. A canceled duplicate must not
  // downgrade an org whose real subscription is healthy.
  const terminal = billing.TERMINAL_SUBSCRIPTION_STATUSES.has(status);
  if (terminal) {
    if (!concernsCurrentSubscription(orgId, subscription.id)) {
      console.warn('[billing] ignoring terminal event for a superseded subscription', {
        orgId, subscriptionId: subscription.id, status,
      });
      return;
    }
    plan = 'free';
  }
  if (!plan) plan = 'free';

  const currentPeriodEnd = subscription.current_period_end
    ? new Date(subscription.current_period_end * 1000).toISOString()
    : null;

  setOrgPlan(orgId, {
    plan,
    // A terminal status is kept verbatim. It used to be nulled here, which
    // dropped a churned org into the same bucket as one that never subscribed
    // — the exact distinction services/metrics.js documents. NULL still means
    // never subscribed; it is no longer overloaded to also mean "churned".
    subscriptionStatus: terminal ? status : (plan === 'free' ? null : status),
    currentPeriodEnd,
    eventCreated,
    stripeSubscriptionId: subscription.id || null,
    // Pending cancellation. Read straight off the subscription object rather
    // than inferred from the status, because a subscription set to stop at the
    // end of the period reports status 'active' until the moment it does.
    // Falls to 0 when the plan lands on free, where a pending cancellation on
    // a subscription that no longer applies would be a stale flag.
    cancelAtPeriodEnd: plan === 'free' ? 0 : (subscription.cancel_at_period_end ? 1 : 0),
    // The comp is spent once a real subscription is billing. Left set, metrics
    // would report a paying customer as EUR 0 MRR forever (services/metrics.js
    // returns zero for any comped org) and stripeReconcile would keep filing
    // them under "comped, no customer, expected" while they have both.
    // Cleared ONLY on a live status: an incomplete attempt must not revoke a
    // grant the customer still depends on. Branding survives either way —
    // capabilitiesFor grants it on pro and team, so a converted org keeps it
    // through the paid path instead of the comp short-circuit.
    ...(billing.LIVE_SUBSCRIPTION_STATUSES.has(status) ? { comped: 0 } : {}),
  });

  // After our own state is correct, not before: if this call fails the org is
  // still on the right plan and the duplicate is merely un-cleaned, which
  // stripeReconcile reports.
  await cancelSupersededSubscriptions(subscription, plan);
}

function orgIdFromCustomer(customerId) {
  if (!customerId) return null;
  const org = findOrgByStripeCustomerId(customerId);
  return org ? org.id : null;
}

async function handleWebhook(req, res) {
  const stripe = billing.getStripe();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripe || !secret) {
    return res.status(503).json({ error: 'Billing webhook not configured.', code: 'BILLING_NOT_CONFIGURED' });
  }

  let event;
  try {
    const sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(req.body, sig, secret); // req.body is the raw Buffer
  } catch (err) {
    return res.status(400).json({ error: `Webhook signature verification failed: ${err.message}`, code: 'BAD_SIGNATURE' });
  }

  // Events that mutate org plan state; all resolve orgId the same way and go
  // through the ordering guard below.
  const PLAN_MUTATING = new Set([
    'checkout.session.completed',
    'customer.subscription.created',
    'customer.subscription.updated',
    'customer.subscription.deleted',
    'invoice.payment_failed',
  ]);

  try {
    const obj = event.data.object;

    if (PLAN_MUTATING.has(event.type)) {
      const orgId = (obj.metadata && obj.metadata.orgId) || orgIdFromCustomer(obj.customer);
      if (orgId) {
        // Ordering guard: Stripe does NOT guarantee delivery order. Skip any
        // event older than the last one applied to this org, so a delayed
        // subscription.updated can't resurrect a canceled/downgraded plan.
        const stored = getOrgBilling(orgId);
        const lastApplied = stored ? stored.stripeEventCreated : null;
        if (lastApplied != null && event.created < lastApplied) {
          console.warn('[billing] stale Stripe event skipped', {
            type: event.type, eventId: event.id, eventCreated: event.created, lastApplied, orgId,
          });
          return res.json({ received: true }); // 200 — Stripe must NOT retry stale events
        }

        if (event.type === 'checkout.session.completed') {
          if (obj.customer) setOrgStripeCustomerId(orgId, obj.customer);
          if (obj.subscription) {
            const sub = await stripe.subscriptions.retrieve(obj.subscription);
            await applySubscription(orgId, sub, event.created); // writes subscription id too
          }
        } else if (event.type === 'customer.subscription.deleted') {
          if (!concernsCurrentSubscription(orgId, obj.id)) {
            console.warn('[billing] ignoring deletion of a superseded subscription', {
              orgId, subscriptionId: obj.id,
            });
            return res.json({ received: true });
          }
          setOrgPlan(orgId, {
            plan: 'free', subscriptionStatus: 'canceled', currentPeriodEnd: null,
            eventCreated: event.created, stripeSubscriptionId: null, // clear on cancel
            // The pending cancellation has now happened, so the flag that
            // predicted it is spent. Left set, this org would sit in the
            // "churning" figure forever, double-counting a loss already taken.
            cancelAtPeriodEnd: 0,
          });
        } else if (event.type === 'invoice.payment_failed') {
          // Keep access; surface a warning in the UI. Leave subscription id as-is.
          const current = getOrgBilling(orgId);
          setOrgPlan(orgId, {
            plan: current && current.plan ? current.plan : 'free',
            subscriptionStatus: 'past_due',
            currentPeriodEnd: current ? current.currentPeriodEnd : null,
            eventCreated: event.created,
          });
        } else {
          // customer.subscription.created / customer.subscription.updated
          await applySubscription(orgId, obj, event.created);
        }
      }
    }

    res.json({ received: true });
  } catch (err) {
    // Returning 500 asks Stripe to retry; our handlers are idempotent.
    res.status(500).json({ error: err.message, code: 'WEBHOOK_HANDLER_ERROR' });
  }
}

module.exports = router;
module.exports.handleWebhook = handleWebhook;
// Exported so the tests drive the real state->action mapping rather than a
// transcription of it, and so the panel tests render real action sets.
module.exports.planPanelState = planPanelState;
module.exports.planActions = planActions;
