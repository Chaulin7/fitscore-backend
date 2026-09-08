'use strict';

/**
 * src/routes/trialStart.js — GET /start?t=<token>, the no-card trial entry point.
 *
 * A prospect clicks a link from a campaign email and lands in Stripe Checkout
 * with a 30-day trial already applied and no card asked for. That is the whole
 * surface: one GET, no session, no form.
 *
 * IT DOES NOT TOUCH THE EXISTING CHECKOUT PATH. POST /api/billing/checkout is
 * untouched, still owner-only, still card-first, still refuses anything that is
 * not a strict upgrade. This is a second door with its own rules, not a flag on
 * the first one — which is why the trial-specific Stripe parameters live here
 * and appear nowhere in routes/billing.js.
 *
 * WHY AN ORGANIZATION IS CREATED HERE. Every downstream trial webhook —
 * trial_will_end, the pause, payment_method.attached, invoice.paid — has to find
 * an account, and the only handle Stripe carries is the customer id. The
 * existing resolver is customer -> organizations.stripe_customer_id, so a trial
 * has to hang off an organization from the first minute or every one of those
 * events lands nowhere.
 *
 * The org is created with no user, and the prospect claims it by following the
 * /signup?t=<token> link this route puts on the Checkout success URL — see
 * services/trialAdoption.js. Possession of the token is the proof of claim;
 * matching on the email address is not, and used to be.
 */

const express = require('express');

const billing = require('../services/billing');
const auth = require('../services/authService');
const trialInvites = require('../services/trialInvites');
const {
  getOrgBilling, setOrgStripeCustomerId, createTrialOrganization, setOrgTrialCampaign,
} = require('../services/db');
const { baseUrlFor } = require('../config/appUrl');

const router = express.Router();

/**
 * Where an unusable link sends the visitor: the ordinary pricing page, with a
 * soft note. Not a 404 and not an error page — somebody we invited is standing
 * in front of us, and the worst outcome is that they conclude the product is
 * broken and leave. They can still buy from here.
 *
 * ONE value for every failure. The server log distinguishes unknown from
 * expired from already-redeemed; the redirect does not, because a response that
 * says "that token is expired" rather than "no such token" confirms the token
 * exists, and this endpoint is unauthenticated. The visitor is told the link
 * cannot be used and shown the prices, which is the same useful thing in all
 * three cases.
 */
const SOFT_FAIL = 'unavailable';

function softFail(req, res, reason, detail) {
  console.warn('[trial] /start refused', { reason, ...(detail || {}) });
  return res.redirect(302, `${baseUrlFor(req)}/?trial=${SOFT_FAIL}#pricing`);
}

/**
 * Where an invite sent to somebody who is ALREADY a customer goes.
 *
 * The login form, not the pricing page. This person does not need to be sold
 * anything — they have a live subscription — and the failure this prevents is
 * expensive: without it, an operator who put an existing customer on a campaign
 * list would give them a second organization with a second trialing
 * subscription, and the account they actually use would be untouched while a
 * duplicate billed alongside it.
 */
function alreadyCustomer(req, res, detail) {
  console.warn('[trial] /start refused: the invited address is already a customer', detail || {});
  return res.redirect(302, `${baseUrlFor(req)}/login?trial=existing_account`);
}

/**
 * The plan a trial opens at. Pro unless ?plan=team, exactly as specified —
 * anything else (a typo, a probe, 'free') falls to Pro rather than erroring,
 * because a mistyped query parameter should not cost us the prospect.
 */
function planFromQuery(query) {
  return (query && String(query.plan || '').trim().toLowerCase() === 'team') ? 'team' : 'pro';
}

/**
 * Subscription states in which the invited address is already a customer.
 *
 * Deliberately NOT billing.LIVE_SUBSCRIPTION_STATUSES, which also contains
 * 'paused'. A paused org is a lapsed trial that never converted — exactly the
 * account an operator might legitimately re-invite — and refusing it would
 * leave them with no way back in. These three are the states where a second
 * trial would sit alongside something already running or already billing.
 */
const ALREADY_CUSTOMER_STATUSES = new Set(['trialing', 'active', 'past_due']);

/**
 * Whether the invited address already belongs to a paying or trialing account.
 *
 * Checked BEFORE any organization is created, which is the whole point: the
 * previous ordering resolved (and could create) an org and only then asked
 * whether it had a live subscription, so an invite sent to an existing customer
 * whose address happened not to resolve left an empty org behind on every
 * click.
 */
function invitedAddressIsCustomer(invite) {
  // The org the token already points at, then the one its address resolves to.
  const candidates = [];
  if (invite.orgId) candidates.push(invite.orgId);
  const existingUser = auth.findUserByEmail(invite.email);
  if (existingUser && existingUser.org_id) candidates.push(existingUser.org_id);

  for (const orgId of candidates) {
    const b = getOrgBilling(orgId);
    if (b && ALREADY_CUSTOMER_STATUSES.has(b.subscriptionStatus)) {
      return { blocked: true, orgId, status: b.subscriptionStatus };
    }
  }
  return { blocked: false, orgId: null, status: null };
}

/**
 * The organization this trial belongs to.
 *
 * Three cases, in order of how much we already know:
 *   1. the token has been through here before (an abandoned Checkout) — reuse
 *      the org it already reserved, so a second click does not create a second
 *      org and a second Stripe customer;
 *   2. the invited address already has an account — the trial belongs to it,
 *      not to a new empty shell beside it;
 *   3. nobody yet — reserve one, named for the company on the invite.
 */
function resolveOrgForInvite(invite) {
  if (invite.orgId) return { orgId: invite.orgId, created: false };

  const existingUser = auth.findUserByEmail(invite.email);
  if (existingUser && existingUser.org_id) return { orgId: existingUser.org_id, created: false };

  const org = createTrialOrganization({
    name: invite.companyName || invite.email,
    email: invite.email,
  });
  return { orgId: org.id, created: true };
}

/** Create the org's Stripe customer, or reuse the one it already has. */
async function ensureCustomer(stripe, orgId, invite) {
  const current = getOrgBilling(orgId);
  if (current && current.stripeCustomerId) return current.stripeCustomerId;

  const org = auth.getOrganizationById(orgId);
  const customer = await stripe.customers.create({
    email: invite.email,
    name: (org && org.name) || invite.companyName || undefined,
    metadata: { orgId, trial_token: invite.token, ...(invite.campaign ? { campaign: invite.campaign } : {}) },
  });
  setOrgStripeCustomerId(orgId, customer.id);
  return customer.id;
}

// GET /start?t=<token>&plan=pro|team
router.get('/', async (req, res) => {
  const token = req.query ? req.query.t : null;
  const plan = planFromQuery(req.query);

  try {
    const check = trialInvites.validateToken(token);
    if (!check.ok) {
      return softFail(req, res, check.reason, { email: check.invite ? check.invite.email : null });
    }
    const invite = check.invite;

    const stripe = billing.getStripe();
    if (!stripe) return softFail(req, res, 'BILLING_NOT_CONFIGURED', { token: invite.token });

    const priceId = billing.priceIdForPlan(plan);
    if (!priceId) return softFail(req, res, 'NO_PRICE_CONFIGURED', { plan });

    // Before anything is created: is this address already a customer? Sending
    // them to login is both the honest answer and the thing that stops a
    // duplicate trialing subscription being opened next to their real one.
    const customer = invitedAddressIsCustomer(invite);
    if (customer.blocked) {
      return alreadyCustomer(req, res, {
        token: invite.token, orgId: customer.orgId, status: customer.status,
      });
    }

    const { orgId } = resolveOrgForInvite(invite);

    // The remaining live states — 'paused', and anything the set above does not
    // name — still must not be sold a second subscription, because Checkout
    // creates a NEW one every time. Same predicate POST /api/billing/checkout
    // uses, rather than a second copy of the status list.
    if (billing.hasLiveSubscription(getOrgBilling(orgId))) {
      return softFail(req, res, 'ALREADY_SUBSCRIBED', { orgId, token: invite.token });
    }

    const customerId = await ensureCustomer(stripe, orgId, invite);

    // Recorded BEFORE Checkout opens, so an abandoned session still leaves the
    // token pointing at its org and customer. redeemed_at stays null — the
    // token is not spent until checkout.session.completed says the prospect
    // finished, which is what lets them come back and try again.
    trialInvites.setTrialInviteTarget(invite.token, { orgId, stripeCustomerId: customerId, plan });
    setOrgTrialCampaign(orgId, invite.campaign);

    const base = baseUrlFor(req);
    // Stripe metadata values must be strings; a null campaign is omitted rather
    // than sent, because Stripe reads null as "delete this key".
    const metadata = {
      orgId,
      plan,
      trial_token: invite.token,
      ...(invite.campaign ? { campaign: invite.campaign } : {}),
    };

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      // The token rides the success URL, so the prospect lands on a signup form
      // that knows which trial they just started. This is what replaced
      // adoption by email match: possession of the token is the proof, and it
      // survives the prospect paying from one address and signing up with
      // another — which they routinely do.
      success_url: trialInvites.signupUrl(base, invite.token),
      cancel_url: `${base}/?billing=cancel`,
      metadata,

      // --- The no-card trial ------------------------------------------------
      // 'if_required' is what makes this a no-card trial: with a 100% trial
      // discount there is nothing to charge today, so Checkout collects no
      // payment method at all. Without it Checkout still asks for a card and
      // the whole proposition is gone.
      payment_method_collection: 'if_required',
      subscription_data: {
        trial_period_days: trialInvites.TRIAL_PERIOD_DAYS,
        // What Stripe does on day 30 when no card was ever added. 'pause' stops
        // collection and leaves the subscription — and everything the customer
        // put into the product — in place. The alternatives are 'cancel'
        // (churn by default) and 'create_invoice' (an invoice nobody can pay,
        // then dunning). Paused is the only one of the three that a customer
        // can walk back from by adding a card.
        //
        // NOTE, and this is the part that is easy to get wrong: adding a card
        // does NOT automatically resume a paused subscription. Stripe leaves
        // pause_collection set until something clears it. That something is the
        // payment_method.attached branch in routes/billing.js.
        trial_settings: { end_behavior: { missing_payment_method: 'pause' } },
        metadata,
      },

      // --- Stripe Tax on a EUR 0 first invoice ------------------------------
      // Both stay on. The first invoice being zero does not make the tax
      // treatment of the second one somebody else's problem, and a B2B customer
      // who cannot enter a VAT number at signup will be charged VAT on their
      // first real invoice and have to ask for it back.
      //
      // billing_address_collection: 'required' is load-bearing HERE in a way it
      // is not on the paid path. Stripe only surfaces the VAT-ID field when it
      // has a country to validate the number against, and it infers one from
      // the payment method — which this session deliberately does not collect.
      // Without this line, tax_id_collection is enabled and the field never
      // appears: VAT collection silently does nothing on exactly the sessions
      // this feature creates.
      automatic_tax: { enabled: true },
      tax_id_collection: { enabled: true },
      billing_address_collection: 'required',
      customer_update: { address: 'auto', name: 'auto' },

      // The invoice legal entity is the Stripe ACCOUNT's, and this session names
      // no other one — no on_behalf_of, no transfer_data, no Connect account.
      // That is what keeps every invoice from this flow issued by Joyaco BV
      // (src/config/legal.js), identically to the paid path. It is stated as an
      // absence on purpose: the way this constraint would break is by somebody
      // adding one of those parameters, not by removing something.
    });

    console.log('[trial] checkout opened', {
      orgId, plan, campaign: invite.campaign || null, token: invite.token, customer: customerId,
    });
    return res.redirect(302, session.url);
  } catch (err) {
    // Stripe refused, or something else did. The prospect gets the pricing page
    // rather than a stack trace; the operator gets the reason in the log.
    console.error('[trial] /start failed', { error: err.message, plan });
    return softFail(req, res, 'STRIPE_ERROR', { message: err.message });
  }
});

module.exports = router;
module.exports.planFromQuery = planFromQuery;
module.exports.SOFT_FAIL = SOFT_FAIL;
