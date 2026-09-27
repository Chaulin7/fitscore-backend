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
  markTrialInviteRedeemed, findTrialInviteByToken, findTrialInviteByOrg,
  getOrgTrial, setOrgTrialCampaign, markOrgConverted,
  setResumeError, getResumeError, markFreeTierSince,
} = require('../services/db');
const trialEmail = require('../services/trialEmail');
const trialInvites = require('../services/trialInvites');
const { isFailedTrialFirstCharge } = require('../services/entitlements');
const { tierById, PLANS, ENTITLEMENT_AXES, phraseForAxis, CURRENCY } = require('../config/plans');
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
  // Paused outranks everything below it. A paused org is read-only RIGHT NOW,
  // which is more urgent than a failing payment on an account that still works.
  // It used to fall through to 'pro_active' — so the panel told a locked-out
  // customer their plan was fine and offered them nothing but "Manage billing".
  if (status === 'paused') return 'paused';
  // A trial whose resume was declined reads as past_due at Stripe but is, to
  // the customer, still the paused account they were trying to restart. Same
  // screen, same three ways out — plus resumeError explaining the decline, so
  // they do not retry the card that just failed.
  if (isFailedTrialFirstCharge(b)) return 'paused';
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
    case 'paused':
      // Three ways out, and NONE of them is a fresh Checkout at the same tier —
      // that would leave the paused subscription alive beside a new one. Each
      // of these acts on the subscription the org already has.
      return [
        { id: 'continue_pro', label: 'Continue on Pro', kind: 'primary', action: 'resumeSubscription', plan: 'pro', anchor: 'analyses' },
        { id: 'continue_team', label: 'Continue on Team', kind: 'ghost', action: 'resumeSubscription', plan: 'team', anchor: 'footer' },
        // Destructive: it cancels the subscription. The client confirms first,
        // and the endpoint requires an explicit acknowledgement of its own.
        { id: 'continue_free', label: 'Continue on Free', kind: 'ghost', action: 'continueOnFree', confirm: true, anchor: 'footer' },
      ];
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
      // Why the last resume attempt failed, when one did. The panel renders
      // this on the paused screen so a declined card is explained rather than
      // presented as the same dead end the customer started from.
      resumeError: (() => { const e = getResumeError(req.orgId); return e ? e.message : null; })(),
      freeTierSince: b.freeTierSince || null,
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
    // THE INVARIANT, enforced server-side rather than by hiding a button: an
    // organization never holds more than one non-canceled subscription. A
    // paused subscription is not canceled — it carries the plan and bills the
    // moment it resumes — so a paused org must never be sold a second one.
    // The way forward for them is POST /resume or POST /continue-free, both of
    // which act on the subscription they already have.
    if (billing.checkoutBlockedReason(currentBilling) === 'SUBSCRIPTION_PAUSED') {
      return sendError(res, 409, 'SUBSCRIPTION_PAUSED',
        'This organization already has a paused subscription. Resume it or move to Free '
        + 'instead of starting a new one.');
    }
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

/**
 * POST /api/billing/resume { plan: 'pro' | 'team' } (owner only)
 *
 * The way out of a paused trial, for a customer who wants to keep paying.
 *
 * IT NEVER CREATES A SUBSCRIPTION. The org already has one — paused, carrying
 * its plan, ready to bill. All this does is collect a card, because the reason
 * Stripe paused it is that there is no payment method. The card arriving fires
 * payment_method.attached, and the handler for that resumes the EXISTING
 * subscription and pays its resumption invoice. That is the single resume path;
 * this endpoint deliberately owns none of it.
 *
 * CHECKOUT IN SETUP MODE, not the billing portal. Both can take a card, and the
 * portal needs no code — but the portal is a general-purpose account screen: it
 * opens on cancel, plan-switch and invoice-history controls, which is a strange
 * place to send somebody whose account is locked and who was asked one question.
 * Setup mode is single-purpose, its success and cancel URLs are ours, and it
 * puts the card on the customer exactly the way the resume path expects. The
 * portal stays available separately for people who want to manage billing.
 *
 * A Team choice is recorded on the subscription's metadata rather than applied
 * now: if the customer abandons Checkout, nothing has changed, and the org is
 * still one paused Pro subscription rather than a paused Team one it never
 * agreed to pay for. The switch happens at resume, next to the payment.
 */
router.post('/resume', requireSession, requireOwner, async (req, res) => {
  try {
    const stripe = billing.getStripe();
    if (!stripe) return sendError(res, 503, 'BILLING_NOT_CONFIGURED', 'Billing is not configured on the server.');

    const plan = (req.body || {}).plan || 'pro';
    if (plan !== 'pro' && plan !== 'team') {
      return sendError(res, 400, 'VALIDATION_ERROR', "plan must be 'pro' or 'team'.");
    }

    const orgBilling = getOrgBilling(req.orgId) || {};
    if (!billing.isPaused(orgBilling)) {
      return sendError(res, 409, 'NOT_PAUSED',
        'This organization has no paused subscription to resume.');
    }
    const subscriptionId = orgBilling.stripeSubscriptionId;
    const customerId = orgBilling.stripeCustomerId;
    if (!subscriptionId || !customerId) {
      return sendError(res, 409, 'NO_SUBSCRIPTION', 'No paused subscription is attached to this organization.');
    }
    if (plan === 'team' && !billing.priceIdForPlan('team')) {
      return sendError(res, 503, 'BILLING_NOT_CONFIGURED', 'No price configured for the team plan.');
    }

    // Record the intent. Applied by the resume path, beside the payment.
    try {
      await stripe.subscriptions.update(subscriptionId, {
        metadata: { ...(orgBilling.metadata || {}), pending_plan: plan },
      });
    } catch (err) {
      console.warn('[trial] could not record the pending plan', { subscriptionId, error: err.message });
    }

    // A new attempt supersedes whatever the last one said went wrong.
    setResumeError(req.orgId, null);

    const base = appBaseUrl(req);
    const session = await stripe.checkout.sessions.create({
      mode: 'setup',
      customer: customerId,
      // Required in setup mode — Stripe answers "Missing required param:
      // currency" without it. Taken from config/plans so it cannot drift from
      // the currency the prices are actually denominated in.
      currency: CURRENCY.code.toLowerCase(),
      success_url: `${base}/?billing=resumed`,
      cancel_url: `${base}/?billing=cancel`,
      metadata: { orgId: req.orgId, resume_plan: plan, subscriptionId },
      // The address is already on the customer from the trial checkout; this
      // keeps it current and keeps Stripe Tax able to locate them.
      customer_update: { address: 'auto', name: 'auto' },
    });
    return res.json({ url: session.url });
  } catch (err) {
    if (isTaxConfigError(err)) return sendError(res, 503, 'TAX_NOT_CONFIGURED', taxConfigMessage(err));
    return sendError(res, 502, 'STRIPE_ERROR', err.message);
  }
});

/**
 * POST /api/billing/continue-free { confirm: true } (owner only)
 *
 * The other way out: keep the account, drop the subscription.
 *
 * DESTRUCTIVE IN ONE DIRECTION ONLY — it cancels a subscription, which cannot
 * be undone; the customer would have to buy again. So it requires an explicit
 * `confirm: true` in the body on top of the client's own confirmation dialog.
 * Two confirmations for one irreversible act is not excessive when the same
 * button is two pixels from "Continue on Pro".
 *
 * NO DATA IS TOUCHED. Every screening, audit record, report and template stays
 * exactly where it is and stays readable and exportable — the Free tier is a
 * product, not a tombstone. The only thing that changes is what they may
 * CREATE from here.
 *
 * The month's usage counter is zeroed. usage_counters is a running monthly
 * total, so an org that downgrades on the 20th would otherwise meet the Free
 * cap already spent on work it did during a paid trial — charged, in effect,
 * for the trial twice.
 */
router.post('/continue-free', requireSession, requireOwner, async (req, res) => {
  try {
    const stripe = billing.getStripe();
    if (!stripe) return sendError(res, 503, 'BILLING_NOT_CONFIGURED', 'Billing is not configured on the server.');

    if (!(req.body || {}).confirm) {
      return sendError(res, 400, 'CONFIRMATION_REQUIRED',
        'Moving to Free cancels the subscription and cannot be undone. Send { "confirm": true } to proceed.');
    }

    const orgBilling = getOrgBilling(req.orgId) || {};
    if (!billing.isPaused(orgBilling)) {
      return sendError(res, 409, 'NOT_PAUSED', 'This organization has no paused subscription.');
    }
    const subscriptionId = orgBilling.stripeSubscriptionId;

    if (subscriptionId) {
      try {
        await stripe.subscriptions.cancel(subscriptionId);
      } catch (err) {
        // A subscription Stripe has already removed is not an error here: the
        // goal state is "no live subscription", and that is the goal state.
        if (!/No such subscription|already canceled/i.test(err.message || '')) {
          return sendError(res, 502, 'STRIPE_ERROR', err.message);
        }
        console.warn('[trial] subscription already gone at continue-free', { subscriptionId });
      }
    }

    // Written here rather than waiting for customer.subscription.deleted, so
    // the response the customer gets back is already true. The webhook applies
    // the same absolute state when it lands, which is why that is safe.
    setOrgPlan(req.orgId, {
      plan: 'free',
      subscriptionStatus: 'canceled',
      currentPeriodEnd: null,
      stripeSubscriptionId: null,
      cancelAtPeriodEnd: 0,
    });
    setResumeError(req.orgId, null);
    const periodKey = currentPeriodKey();
    markFreeTierSince(req.orgId, new Date().toISOString());

    console.log('[trial] org moved to Free after a paused trial', { orgId: req.orgId, subscriptionId });
    return res.json({
      plan: 'free',
      subscriptionStatus: 'canceled',
      usage: { periodKey, analyses: { used: getUsageCount(req.orgId, periodKey), limit: billing.FREE_MONTHLY_LIMIT } },
      dataRetained: true,
    });
  } catch (err) {
    return sendError(res, 500, 'INTERNAL_ERROR', err.message);
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
    // Same tier, OR paused at ANY tier.
    //
    // The same-tier rule above protects a legitimate second subscription at a
    // different tier. A PAUSED one is never that: it is a lapsed trial the
    // customer is not using, and leaving it alive means it resumes and bills
    // alongside whatever they just started. That is the duplicate the
    // one-subscription invariant forbids, so paused loses regardless of tier.
    const otherIsPausedAnyTier = other.status === 'paused';
    if (!otherIsPausedAnyTier && billing.planForPriceId(priceIdOf(other)) !== plan) continue;
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

// --- No-card trial webhook branches -----------------------------------------
//
// Four events the paid path never sees, because the paid path takes a card up
// front. Each is handled in its own function so the dispatcher below stays a
// dispatcher, and so the one that MUST be idempotent can say why in its own
// header rather than in a comment three levels deep.

/**
 * Who the trial reminder goes to.
 *
 * The invited address first: it is the person we chose to give the trial to and
 * the only address we know is real at the point the org may still have no user.
 * Then the org's owner, for a trial started from an existing account. The Stripe
 * customer's email is the last resort — it is the same address in almost every
 * case, but it is the one we did not write ourselves.
 */
function trialRecipientFor(orgId, subscription) {
  const invite = orgId ? findTrialInviteByOrg(orgId) : null;
  if (invite && invite.email) return { email: invite.email, companyName: invite.companyName || null };

  const trial = orgId ? getOrgTrial(orgId) : null;
  if (trial && trial.inviteEmail) return { email: trial.inviteEmail, companyName: null };

  if (orgId) {
    const owner = auth.listOrgUsers(orgId).find((u) => u.role === 'owner');
    if (owner && owner.email) {
      const org = auth.getOrganizationById(orgId);
      return { email: owner.email, companyName: org ? org.name : null };
    }
  }

  const fromStripe = subscription && subscription.customer_email;
  return fromStripe ? { email: fromStripe, companyName: null } : { email: null, companyName: null };
}

/**
 * A billing-portal link for the reminder email.
 *
 * Best-effort: if Stripe will not mint one, the email still goes out saying so,
 * because a reminder without a link is worth far more than no reminder.
 */
async function billingPortalUrlFor(stripe, customerId, returnUrl) {
  if (!stripe || !customerId) return null;
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId, return_url: returnUrl,
    });
    return session.url || null;
  } catch (err) {
    console.warn('[trial] could not create a portal link for the reminder', { customerId, error: err.message });
    return null;
  }
}

/**
 * customer.subscription.trial_will_end — three days out, ask for a card.
 *
 * Never throws: services/trialEmail.sendTrialWillEnd swallows delivery failures
 * into a trial_emails row. A mail provider outage must not make this webhook
 * 500, because that asks Stripe to redeliver the whole lifecycle event.
 */
async function handleTrialWillEnd(req, stripe, subscription, orgId) {
  const { email, companyName } = trialRecipientFor(orgId, subscription);
  const plan = billing.planForPriceId(priceIdOf(subscription))
    || (subscription.metadata && subscription.metadata.plan) || 'pro';
  const tier = tierById(plan);
  const portalUrl = await billingPortalUrlFor(stripe, subscription.customer, `${appBaseUrl(req)}/`);

  const result = await trialEmail.sendTrialWillEnd({
    orgId,
    subscriptionId: subscription.id,
    toEmail: email,
    companyName,
    planName: tier ? tier.name : 'Pro',
    trialEndsAt: subscription.trial_end ? new Date(subscription.trial_end * 1000).toISOString() : null,
    portalUrl,
  });
  console.log('[trial] trial_will_end handled', {
    orgId, subscriptionId: subscription.id, sent: result.sent, skipped: result.skipped,
  });
}

/**
 * customer.subscription.paused — tell them, once.
 *
 * Writes NO state. The status is already correct by the time this runs:
 * customer.subscription.updated carries the same transition and goes through
 * the ordering guard, which is where plan state belongs. This handler exists
 * for the one thing that event cannot do, which is say something to the person
 * whose account just stopped working.
 */
async function handleSubscriptionPaused(req, stripe, subscription, orgId) {
  const { email, companyName } = trialRecipientFor(orgId, subscription);
  const plan = billing.planForPriceId(priceIdOf(subscription))
    || (subscription.metadata && subscription.metadata.plan) || 'pro';
  const tier = tierById(plan);
  const base = appBaseUrl(req);
  const portalUrl = await billingPortalUrlFor(stripe, subscription.customer, `${base}/`);

  const result = await trialEmail.sendTrialPaused({
    orgId,
    subscriptionId: subscription.id,
    toEmail: email,
    companyName,
    planName: tier ? tier.name : 'Pro',
    portalUrl,
    appUrl: `${base}/dashboard`,
  });
  console.log('[trial] subscription paused — notice handled', {
    orgId, subscriptionId: subscription.id, sent: result.sent, skipped: result.skipped,
  });
}

/**
 * A customer-facing sentence for a failed resume.
 *
 * Stripe's own decline messages are written for the cardholder and are more
 * specific than anything worth inventing here ("Your card was declined.",
 * "Your card has insufficient funds."), so they are preferred when present.
 * Anything else collapses to a generic line — an internal Stripe error is not
 * the customer's problem to read.
 */
function declineReason(err) {
  const declineCodes = new Set(['card_declined', 'expired_card', 'incorrect_cvc', 'insufficient_funds', 'processing_error']);
  if (err && err.code && declineCodes.has(err.code) && err.message) return err.message;
  if (err && err.type === 'StripeCardError' && err.message) return err.message;
  return 'The card could not be charged. Try a different payment method.';
}

/**
 * payment_method.attached — the card arrived, so resume.
 *
 * THIS IS REQUIRED, and it is the single least obvious thing in the feature.
 * Attaching a payment method does NOT resume a paused subscription. Stripe's
 * own documentation is explicit: a trial that ends with no payment method and
 * `missing_payment_method: 'pause'` moves to status `paused` and "remains
 * `paused` until explicitly resumed". Without this handler a customer adds
 * their card, sees the portal confirm it, and stays locked in read-only
 * forever with no error anywhere to explain why.
 *
 * DETECTION IS BY STATUS, NOT BY pause_collection. This is the correction a
 * live test-clock run forced (scripts/trial-clock-check.js). The two are
 * different mechanisms:
 *
 *   status === 'paused'   a trial ended with no payment method. This is the
 *                         one this product produces, and pause_collection on
 *                         such a subscription is NULL.
 *   pause_collection set  the MANUAL pause feature, applied through
 *                         subscriptions.update. It does not change `status`,
 *                         and nothing in this product ever sets it.
 *
 * The previous version filtered on `sub.pause_collection` being truthy, which
 * is never true for a trial pause, so it returned early every single time. The
 * bug survived because the test stub asserted the same wrong shape — it set
 * pause_collection = { behavior: 'void' } on pause, and so agreed with the code
 * about something Stripe does not do.
 *
 * AND THE RESUME ACTION IS subscriptions.resume, not an update that clears
 * pause_collection. Clearing a field that is already null does nothing.
 * `billing_cycle_anchor: 'now'` resets the cycle and raises a full-amount
 * invoice with no proration, which is what converts the trial into money
 * immediately rather than at some inherited anchor date.
 *
 * IDEMPOTENT by construction, which matters because Stripe redelivers and
 * because a customer may attach several cards:
 *   - only a subscription whose status is 'paused' is touched, so a second
 *     delivery (by which time it is 'active') does nothing;
 *   - the default payment method is only set when the customer has none, so a
 *     later card never silently replaces the one they chose;
 *   - resume() on an already-active subscription is not called at all.
 *
 * ORDER IS LOAD-BEARING: the default payment method is set BEFORE the resume.
 * Resuming generates an invoice that Stripe finalizes immediately, and per the
 * docs, if there is no payment attempt within 23 hours Stripe voids it and the
 * subscription stays paused. Resuming first would race the customer's own card.
 */
async function handlePaymentMethodAttached(stripe, paymentMethod) {
  const customerId = paymentMethod && paymentMethod.customer;
  if (!stripe || !customerId) return;

  let list;
  try {
    list = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 });
  } catch (err) {
    console.warn('[trial] could not list subscriptions to resume', { customerId, error: err.message });
    return;
  }

  const orgId = orgIdFromCustomer(customerId);
  const orgBilling = orgId ? getOrgBilling(orgId) : null;
  // Only a trial-originated account takes the past_due branch below. An
  // ordinary customer in dunning has Stripe's own retry schedule working on
  // their behalf, and charging them the instant they touch a card would jump
  // ahead of it.
  const trialOrigin = !!(orgBilling && orgBilling.trialOriginAt);

  /**
   * Subscriptions a newly-added card can rescue. TWO entry states, one path.
   *
   *   paused    the trial ended with no payment method. Needs resume() and then
   *             payment of the invoice that raises.
   *   past_due  the resumption invoice was DECLINED. Stripe does not put the
   *             subscription back to paused — it moves it to past_due and
   *             leaves that invoice open. Nothing else in the system pays it,
   *             so before this branch existed a customer who came back with a
   *             working card stayed read-only forever with an open EUR 59.29
   *             invoice and no way to settle it. Verified live, not assumed.
   *
   * They differ by one step — whether a resume is needed — so this is one loop
   * with that step conditional, rather than a second handler that would drift.
   */
  const recoverable = ((list && list.data) || []).filter((sub) => {
    if (!sub) return false;
    if (sub.status === 'paused') return true;
    return sub.status === 'past_due' && trialOrigin && !!sub.latest_invoice;
  });
  if (recoverable.length === 0) return; // nothing to rescue: a normal card update

  // Whether the card we are replacing is known to be bad.
  //
  // A past_due trial subscription is past_due BECAUSE its default payment
  // method was just declined. Leaving that card as the default and paying with
  // it would decline again, so the new card takes over. In the paused case
  // nothing has failed and the rule stays the conservative one: set a default
  // only when there is none, never overwrite a deliberate choice.
  const replacingFailedCard = recoverable.some((sub) => sub.status === 'past_due');
  try {
    const customer = await stripe.customers.retrieve(customerId);
    const hasDefault = customer && customer.invoice_settings
      && customer.invoice_settings.default_payment_method;
    if (!hasDefault || replacingFailedCard) {
      await stripe.customers.update(customerId, {
        invoice_settings: { default_payment_method: paymentMethod.id },
      });
    }
  } catch (err) {
    console.warn('[trial] could not set the default payment method', { customerId, error: err.message });
  }

  for (const sub of recoverable) {
    try {
      // --- apply a pending tier change, before the money moves -------------
      // POST /resume records { pending_plan } on the subscription when the
      // customer chose a different tier on their way out of the pause. It is
      // applied HERE, beside the payment, rather than when they clicked: an
      // abandoned Checkout then leaves the org exactly as it was — one paused
      // subscription at the tier they actually had — instead of a paused Team
      // subscription nobody agreed to pay for.
      //
      // Switching the price on the EXISTING subscription is what keeps the
      // one-subscription invariant. The alternative — cancel the paused one and
      // sell a new Team subscription — has a window in which both exist, loses
      // the trial's lineage and metadata, and puts the customer through a
      // second checkout for something they already told us they wanted.
      // Only while paused. Switching the price of a subscription mid-dunning
      // would change what the already-open invoice was supposed to collect.
      const pendingPlan = sub.status === 'paused' && sub.metadata && sub.metadata.pending_plan;
      const targetPrice = pendingPlan ? billing.priceIdForPlan(pendingPlan) : null;
      const currentPrice = priceIdOf(sub);
      if (targetPrice && currentPrice && targetPrice !== currentPrice) {
        const itemId = sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].id;
        if (itemId) {
          // NO proration_behavior. Stripe refuses it outright on a paused
          // subscription — "You cannot set `proration_behavior` while a
          // subscription is `paused`" — and sending it aborts the whole resume,
          // leaving the customer paused with a recorded failure.
          //
          // Omitting it is not a compromise here. The resume immediately after
          // this uses billing_cycle_anchor 'now', which per Stripe's docs
          // resets the cycle and generates NO prorations: the customer is
          // billed one full period at the new price, which is the intended
          // outcome. Prorating the paused gap would charge them for time they
          // had no access to.
          await stripe.subscriptions.update(sub.id, {
            items: [{ id: itemId, price: targetPrice }],
            metadata: { ...sub.metadata, pending_plan: '' },
          });
          console.log('[trial] switched the paused subscription to a new tier before resuming', {
            subscriptionId: sub.id, from: billing.planForPriceId(currentPrice), to: pendingPlan,
          });
        }
      }

      // Name the card on the SUBSCRIPTION as well, not only on the customer.
      // A live test-clock run showed the resumption invoice being raised with a
      // PaymentIntent stuck at requires_payment_method, and then voided, while
      // the customer's invoice_settings.default_payment_method was correctly
      // set — so the customer-level default alone is not what Stripe charges a
      // resumption against. Only set when the subscription has none of its own.
      if (!sub.default_payment_method || replacingFailedCard) {
        await stripe.subscriptions.update(sub.id, { default_payment_method: paymentMethod.id });
      }

      // The one step the two entry states do not share. A past_due subscription
      // is already out of the pause — its invoice exists and is waiting — so
      // resuming it again would be wrong and Stripe refuses it anyway.
      const resumed = sub.status === 'paused'
        ? await stripe.subscriptions.resume(sub.id, { billing_cycle_anchor: 'now' })
        : await stripe.subscriptions.retrieve(sub.id);

      // PAY THE RESUMPTION INVOICE. resume() raises and finalizes it but does
      // NOT collect it: a live run showed the invoice sitting `open` with
      // auto_advance false and its PaymentIntent at requires_confirmation, and
      // Stripe voids it after 23 hours, leaving the customer paused. The docs
      // say the subscription becomes active only "if the invoice is paid or
      // marked uncollectible" — so paying it is the step that finishes the
      // resume, and without it the whole flow silently reverts.
      //
      // Guarded on status 'open', so a redelivery (by which time it is 'paid')
      // pays nothing twice.
      let finalStatus = resumed && resumed.status;
      const invoiceId = resumed && resumed.latest_invoice;
      // Keyed on the INVOICE being open rather than on the subscription's
      // status, so both entry states settle through the same line: a resumed
      // subscription is 'paused' with a fresh invoice, a declined one is
      // 'past_due' with the old one. Either way there is exactly one open
      // invoice and paying it is what makes the subscription active.
      if ((finalStatus === 'paused' || finalStatus === 'past_due') && invoiceId) {
        const invoice = await stripe.invoices.retrieve(invoiceId);
        if (invoice && invoice.status === 'open') {
          // A DECLINE LANDS HERE, as a thrown Stripe error. It must not be
          // swallowed: Stripe voids an unpaid resumption invoice after 23 hours
          // and leaves the subscription paused, so a customer whose card was
          // refused would otherwise see the same locked screen with no reason
          // and try the same card again.
          // Named explicitly rather than relying on the default resolving in
          // time — the customer added THIS card to settle THIS invoice.
          const paid = await stripe.invoices.pay(invoiceId, { payment_method: paymentMethod.id });
          console.log('[trial] paid the resumption invoice', {
            subscriptionId: sub.id, invoiceId, status: paid && paid.status, amountPaid: paid && paid.amount_paid,
          });
          const after = await stripe.subscriptions.retrieve(sub.id);
          finalStatus = after && after.status;
        }
      }
      if (finalStatus === 'active' && orgId) setResumeError(orgId, null);
      console.log('[trial] recovered a subscription after a card was added', {
        customerId, subscriptionId: sub.id, from: sub.status, status: finalStatus,
      });
    } catch (err) {
      // The org stays PAUSED and therefore read-only — never shown as active —
      // and the reason is recorded for the panel to render.
      const declineMessage = declineReason(err);
      console.error('[trial] could not recover a subscription', {
        customerId, subscriptionId: sub.id, from: sub.status, orgId, error: err.message,
      });
      if (orgId) setResumeError(orgId, declineMessage);
    }
  }
}

/**
 * invoice.paid — the trial turned into money.
 *
 * "The first post-trial invoice" is identified as the first PAID invoice with a
 * non-zero amount on an account that came in through a trial. The trial's own
 * opening invoice is EUR 0, so the amount test excludes it without needing to
 * trust billing_reason, which differs between a trial that converted on
 * schedule and one resumed by hand after a pause.
 *
 * db.markOrgConverted carries the idempotency: it writes only where
 * trial_converted_at IS NULL, so Stripe's redeliveries cannot move the
 * conversion date or double-count the campaign.
 */
function handleInvoicePaid(invoice, orgId) {
  if (!orgId) return;
  const amountPaid = Number(invoice && invoice.amount_paid) || 0;
  if (amountPaid <= 0) return; // the EUR 0 trial invoice

  const trial = getOrgTrial(orgId);
  const invite = findTrialInviteByOrg(orgId);
  // Only trial-originated accounts convert. An ordinary paid customer's monthly
  // invoice is not a trial conversion and must not be counted as one.
  if (!trial || (!trial.campaign && !invite)) return;
  if (trial.convertedAt) return; // already converted; nothing to say

  const campaign = trial.campaign || (invite && invite.campaign) || null;
  const converted = markOrgConverted(orgId, {
    convertedAt: new Date().toISOString(),
    campaign,
  });
  if (converted) {
    console.log('[trial] converted', {
      orgId, campaign, invoiceId: invoice.id, amountPaid, currency: invoice.currency,
    });
  }
}

/**
 * Spend the trial token, keyed off the metadata the session carried.
 *
 * Best-effort and last: the subscription state is already written by the time
 * this runs, so a token that fails to flip leaves a customer with a working
 * trial and a reusable link, which is the right way round to fail.
 */
function redeemTrialToken(session, orgId) {
  const token = session && session.metadata && session.metadata.trial_token;
  if (!token) return null;
  const invite = findTrialInviteByToken(token);
  if (!invite) {
    console.warn('[trial] checkout completed with an unknown trial_token', { token, orgId });
    return null;
  }
  const spent = markTrialInviteRedeemed(token, {
    redeemedAt: new Date().toISOString(),
    orgId: orgId || invite.orgId,
    stripeCustomerId: session.customer || invite.stripeCustomerId,
    plan: (session.metadata && session.metadata.plan) || invite.plan,
    // The signup link's own, shorter deadline starts now — the trial is running
    // from this moment, so the link that claims it is live from this moment.
    signupExpiresAt: trialInvites.signupExpiryFrom(Date.now()),
  });
  if (orgId) setOrgTrialCampaign(orgId, invite.campaign);
  console.log('[trial] token redeemed', {
    token, orgId, campaign: invite.campaign || null, firstRedemption: spent,
  });
  return findTrialInviteByToken(token);
}

/**
 * The address to welcome, preferring the one the customer actually typed.
 *
 * Checkout collects its own email and it is frequently NOT the invited one —
 * the invite goes to a founder, the card is entered by whoever handles billing.
 * Both get the link: the person who paid needs it because they are holding the
 * tab, and the invited address needs it because they are the one we expect to
 * use the product. Deduplicated when they are the same, which is the common case.
 */
function welcomeRecipients(session, invite) {
  const checkoutEmail = (session && session.customer_details && session.customer_details.email)
    || (session && session.customer_email) || null;
  const addresses = [checkoutEmail, invite ? invite.email : null]
    .map((e) => (typeof e === 'string' ? e.trim().toLowerCase() : null))
    .filter(Boolean);
  return [...new Set(addresses)];
}

/**
 * Send the trial welcome, carrying the /signup?t= link.
 *
 * Covers the closed-tab case: Stripe returns the prospect to the signup form,
 * and if they close it the email is the only other copy of their claim link.
 * Best-effort — a mail failure must not fail the webhook, because the trial
 * itself is already correctly set up by the time this runs.
 */
async function sendTrialWelcomeFor(req, session, invite, orgId) {
  if (!invite || !invite.orgId) return;
  const base = appBaseUrl(req);
  const signupUrl = trialInvites.signupUrl(base, invite.token);
  const tier = tierById(invite.plan || 'pro');
  const org = orgId ? auth.getOrganizationById(orgId) : null;

  for (const toEmail of welcomeRecipients(session, invite)) {
    await trialEmail.sendTrialWelcome({
      orgId,
      // Keyed per address so the send-once guard does not silence the second
      // recipient, while still stopping a redelivery re-mailing either.
      subscriptionId: `${session.subscription || invite.token}:${toEmail}`,
      toEmail,
      companyName: invite.companyName || (org ? org.name : null),
      planName: tier ? tier.name : 'Pro',
      signupUrl,
      trialEndsAt: null,
    });
  }
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

  // The no-card trial's own events. Deliberately a SEPARATE set, not four more
  // entries above, because none of them writes plan state and none of them
  // belongs behind the ordering guard:
  //
  //   trial_will_end       sends an email. Skipping it as "stale" would drop
  //                        the one message the conversion depends on.
  //   payment_method.attached  resumes the paused subscription at Stripe. It
  //                        carries no org state to be out of order with, and
  //                        the subscription.updated it provokes goes through
  //                        the guarded path above and is what actually writes
  //                        'active'.
  //   invoice.paid         records a conversion, guarded by its own
  //                        write-once column rather than by event ordering.
  //
  // Running them through the ordering guard would mean a redelivery arriving
  // after an unrelated newer event silently does nothing at all.
  const TRIAL_EVENTS = new Set([
    'customer.subscription.trial_will_end',
    'payment_method.attached',
    'invoice.paid',
    // A SIDE-EFFECT HOOK ONLY. It never writes status, and that is not
    // fastidiousness: a live run showed customer.subscription.resumed arriving
    // with a STALE payload (status 'trialing' on a subscription that had just
    // gone active), so these lifecycle events are not a trustworthy source of
    // state. customer.subscription.updated remains the only writer, behind the
    // ordering guard. This one exists to send one email.
    'customer.subscription.paused',
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
          // Spend the trial token, if this session came from GET /start. After
          // the subscription is applied, so a failure here cannot cost the
          // customer the trial they just started.
          const redeemed = redeemTrialToken(obj, orgId);
          // Then the welcome, carrying the /signup?t= link that attaches an
          // account to the trial now running.
          await sendTrialWelcomeFor(req, obj, redeemed, orgId);
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
          //
          // The 'paused' status arrives here, from a trial that ended with no
          // payment method. It needs no branch of its own: applySubscription
          // writes the status verbatim, the org KEEPS its paid plan and every
          // row it owns, and services/entitlements.js turns 'paused' into
          // read-only wherever access is decided. Nothing is deleted, here or
          // anywhere downstream — the whole reason 'pause' was chosen over
          // 'cancel' as the trial end behaviour.
          await applySubscription(orgId, obj, event.created);
          if (obj.status === 'paused') {
            console.log('[trial] subscription paused — account is read-only, data retained', {
              orgId, subscriptionId: obj.id,
            });
          }
        }
      }
    } else if (TRIAL_EVENTS.has(event.type)) {
      if (event.type === 'payment_method.attached') {
        // No org lookup: this one acts on Stripe, not on our database, and it
        // must work even for a customer whose org row is not linked yet.
        await handlePaymentMethodAttached(stripe, obj);
      } else {
        const orgId = (obj.metadata && obj.metadata.orgId) || orgIdFromCustomer(obj.customer);
        if (event.type === 'customer.subscription.trial_will_end') {
          await handleTrialWillEnd(req, stripe, obj, orgId);
        } else if (event.type === 'customer.subscription.paused') {
          await handleSubscriptionPaused(req, stripe, obj, orgId);
        } else if (event.type === 'invoice.paid') {
          handleInvoicePaid(obj, orgId);
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
// Exported for the trial tests, which drive the real branches rather than a
// re-implementation of them.
module.exports.handlePaymentMethodAttached = handlePaymentMethodAttached;
module.exports.handleInvoicePaid = handleInvoicePaid;
module.exports.planActions = planActions;
