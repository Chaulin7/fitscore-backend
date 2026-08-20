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
function applySubscription(orgId, subscription, eventCreated) {
  const status = subscription.status; // active, past_due, canceled, ...
  const priceId = subscription.items && subscription.items.data && subscription.items.data[0]
    && subscription.items.data[0].price && subscription.items.data[0].price.id;
  let plan = billing.planForPriceId(priceId);

  // Terminal states fall back to free.
  if (status === 'canceled' || status === 'unpaid' || status === 'incomplete_expired') {
    plan = 'free';
  }
  if (!plan) plan = 'free';

  const currentPeriodEnd = subscription.current_period_end
    ? new Date(subscription.current_period_end * 1000).toISOString()
    : null;

  setOrgPlan(orgId, {
    plan,
    subscriptionStatus: plan === 'free' ? null : status,
    currentPeriodEnd,
    eventCreated,
    stripeSubscriptionId: subscription.id || null,
  });
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
            applySubscription(orgId, sub, event.created); // writes subscription id too
          }
        } else if (event.type === 'customer.subscription.deleted') {
          setOrgPlan(orgId, {
            plan: 'free', subscriptionStatus: 'canceled', currentPeriodEnd: null,
            eventCreated: event.created, stripeSubscriptionId: null, // clear on cancel
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
          applySubscription(orgId, obj, event.created);
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
