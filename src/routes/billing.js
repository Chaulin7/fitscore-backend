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

function appBaseUrl(req) {
  const fromEnv = (process.env.APP_BASE_URL || '').replace(/\/+$/, '');
  if (fromEnv) return fromEnv;
  return `${req.protocol}://${req.get('host')}`;
}

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
    });
    res.json({ url: session.url });
  } catch (err) {
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
// always sets state from the event, never blindly toggles.
function applySubscription(orgId, subscription) {
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

  try {
    const obj = event.data.object;
    switch (event.type) {
      case 'checkout.session.completed': {
        // Resolve org by metadata or customer; fetch the subscription for full state.
        const orgId = (obj.metadata && obj.metadata.orgId) || orgIdFromCustomer(obj.customer);
        if (orgId && obj.customer) setOrgStripeCustomerId(orgId, obj.customer);
        if (orgId && obj.subscription) {
          const sub = await stripe.subscriptions.retrieve(obj.subscription);
          applySubscription(orgId, sub);
        }
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const orgId = (obj.metadata && obj.metadata.orgId) || orgIdFromCustomer(obj.customer);
        if (orgId) {
          if (event.type === 'customer.subscription.deleted') {
            setOrgPlan(orgId, { plan: 'free', subscriptionStatus: 'canceled', currentPeriodEnd: null });
          } else {
            applySubscription(orgId, obj);
          }
        }
        break;
      }
      case 'invoice.payment_failed': {
        const orgId = orgIdFromCustomer(obj.customer);
        if (orgId) {
          // Keep access; surface a warning in the UI.
          const current = getOrgBilling(orgId);
          setOrgPlan(orgId, {
            plan: current && current.plan ? current.plan : 'free',
            subscriptionStatus: 'past_due',
            currentPeriodEnd: current ? current.currentPeriodEnd : null,
          });
        }
        break;
      }
      default:
        break; // ignore unhandled event types
    }
    res.json({ received: true });
  } catch (err) {
    // Returning 500 asks Stripe to retry; our handlers are idempotent.
    res.status(500).json({ error: err.message, code: 'WEBHOOK_HANDLER_ERROR' });
  }
}

module.exports = router;
module.exports.handleWebhook = handleWebhook;
