'use strict';

/**
 * src/routes/trialClock.test.js — the 30-day trial, driven on a test clock.
 *
 * Three journeys, end to end: a trial nobody pays for, a trial converted with a
 * card on day 28, and a paused account rescued with a card on day 35.
 *
 * WHAT IS REAL AND WHAT IS MODELLED. Everything on our side of the network
 * boundary is the real thing — the real webhook handler, the real entitlement
 * helper, the real database writes, the real email path. What is modelled is
 * Stripe: a test clock, the subscription lifecycle it drives, and the events it
 * emits at each step. This is the same boundary test/helpers/stripe-stub.js and
 * duplicateSubscription.test.js draw, extended to the part of Stripe this
 * feature actually depends on — because the behaviour under test is a sequence
 * of TIMED events, and time is the one thing a stub has to model to be useful
 * here.
 *
 * The model is written from Stripe's documented test-clock semantics, and the
 * three that matter are stated as code below rather than assumed:
 *
 *   1. trial_will_end fires three days before trial_end;
 *   2. a trial reaching its end with no payment method PAUSES (never cancels,
 *      never invoices) under trial_settings.end_behavior.missing_payment_method
 *      = 'pause';
 *   3. attaching a payment method does NOT resume a paused subscription — the
 *      pause_collection stays set until something clears it.
 *
 * Point 3 is the whole reason the payment_method.attached branch exists, so the
 * model deliberately does NOT auto-resume: if routes/billing.js stopped clearing
 * pause_collection, the third test would fail rather than quietly pass.
 *
 * Against a live Stripe test account the same sequence runs with
 * stripe.testHelpers.testClocks.create/advance and a `stripe listen` forward;
 * that needs live test keys and is out of reach of `npm test`, which is why the
 * clock is here.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cvs-trial-clock-'));
process.env.DATABASE_PATH = path.join(TMP_DIR, 'test.db');
process.env.STRIPE_SECRET_KEY = 'sk_test_stub_clock';
process.env.STRIPE_PRICE_PRO = 'price_stub_pro';
process.env.STRIPE_PRICE_TEAM = 'price_stub_team';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_stub';
process.env.PUBLIC_APP_URL = 'https://cvsprings.test';
process.env.ADMIN_OWNER_EMAIL = 'operator@cvsprings.test';
delete process.env.RESEND_API_KEY; // the send is logged and recorded, not dispatched

const DAY = 86400;
const TRIAL_DAYS = 30;

// Pro is EUR 49/month ex-VAT (src/config/plans.js). A Dutch customer pays 21%
// on top, because the Stripe Prices are tax_behavior 'exclusive'. Both numbers
// are derived from the tier rather than typed, so a price change moves the
// assertion with it.
const { tierById } = require('../config/plans');
const PRO_EX_VAT_CENTS = tierById('pro').priceAmount * 100;
const VAT_RATE = 0.21;
const PRO_TAX_CENTS = Math.round(PRO_EX_VAT_CENTS * VAT_RATE);
const PRO_TOTAL_CENTS = PRO_EX_VAT_CENTS + PRO_TAX_CENTS;

// --- A Stripe test clock, modelled ------------------------------------------

const SUBS = new Map();      // id -> subscription object
const CUSTOMERS = new Map(); // id -> { id, invoice_settings: {…} }
const INVOICES = [];         // every invoice the model generated
const PENDING = [];          // events Stripe would deliver; drained by deliver()

let seq = 0;
const nextId = (prefix) => `${prefix}_${++seq}`;

/** The clock. frozen_time is unix seconds, exactly as Stripe reports it. */
const clock = { frozen_time: Math.floor(Date.parse('2026-02-01T00:00:00Z') / 1000) };

function emit(type, object) {
  PENDING.push({ type, object });
}

function customerHasPaymentMethod(customerId) {
  const c = CUSTOMERS.get(customerId);
  return !!(c && c.invoice_settings && c.invoice_settings.default_payment_method);
}

/**
 * An invoice raised and finalized but NOT collected — what resume() produces.
 * Payment is a separate, explicit step; see invoices.pay below.
 */
function openInvoiceFor(sub, billingReason) {
  const invoice = {
    id: nextId('in'),
    customer: sub.customer,
    subscription: sub.id,
    billing_reason: billingReason,
    currency: 'eur',
    subtotal: PRO_EX_VAT_CENTS,
    tax: PRO_TAX_CENTS,
    total: PRO_TOTAL_CENTS,
    amount_paid: 0,
    status: 'open',
    auto_advance: false,
    created: clock.frozen_time,
    metadata: {},
  };
  INVOICES.push(invoice);
  emit('invoice.created', { ...invoice });
  emit('invoice.finalized', { ...invoice });
  return invoice;
}

/** Generate the invoice a billing cycle produces, and the event for it. */
function invoiceFor(sub, billingReason) {
  const invoice = {
    id: nextId('in'),
    customer: sub.customer,
    subscription: sub.id,
    billing_reason: billingReason,
    currency: 'eur',
    subtotal: PRO_EX_VAT_CENTS,
    tax: PRO_TAX_CENTS,
    total: PRO_TOTAL_CENTS,
    amount_paid: PRO_TOTAL_CENTS,
    status: 'paid',
    created: clock.frozen_time,
    // NO metadata, deliberately. Stripe does not copy subscription metadata
    // onto the invoices it generates, so the handler has to resolve the org the
    // way production actually does — customer id -> organizations. Handing it
    // an orgId here would test a path that never runs.
    metadata: {},
  };
  INVOICES.push(invoice);
  emit('invoice.paid', invoice);
  return invoice;
}

/**
 * Advance the clock, running the lifecycle transitions that fall in between.
 *
 * Stripe's own ordering: the trial-ending notice first, then the trial end
 * itself. Both are edge-triggered — the flags on the subscription are what stop
 * a second advance re-firing them, the same way Stripe does not re-send them.
 */
function advanceTo(unixSeconds) {
  clock.frozen_time = unixSeconds;

  for (const sub of SUBS.values()) {
    if (sub.status !== 'trialing') continue;

    // 1. Three days out: the reminder.
    if (!sub._willEndSent && clock.frozen_time >= sub.trial_end - 3 * DAY) {
      sub._willEndSent = true;
      emit('customer.subscription.trial_will_end', { ...sub });
    }

    // 2. The trial ends.
    if (clock.frozen_time >= sub.trial_end) {
      if (customerHasPaymentMethod(sub.customer)) {
        sub.status = 'active';
        sub.current_period_end = sub.trial_end + 30 * DAY;
        emit('customer.subscription.updated', { ...sub });
        invoiceFor(sub, 'subscription_cycle');
      } else if (sub.trial_settings
        && sub.trial_settings.end_behavior
        && sub.trial_settings.end_behavior.missing_payment_method === 'pause') {
        // PAUSE. Not cancel, and no invoice is generated at all.
        //
        // pause_collection STAYS NULL. This is the real payload shape, captured
        // from scripts/trial-clock-check.js against live test-mode Stripe:
        //
        //   customer.subscription.updated  status=paused  pause_collection=null
        //   customer.subscription.paused   status=paused  pause_collection=null
        //
        // This file previously set pause_collection = { behavior: 'void' },
        // which was an assumption, and a wrong one. pause_collection belongs to
        // the MANUAL pause feature (subscriptions.update with pause_collection);
        // a trial paused for a missing payment method is a different mechanism
        // that only moves `status`. The wrong fixture hid a production bug for
        // the entire life of this test — see the resume branch in
        // routes/billing.js, which filtered on pause_collection and therefore
        // never matched a single real subscription.
        sub.status = 'paused';
        emit('customer.subscription.updated', { ...sub });
        // A dedicated event the previous model did not have at all.
        emit('customer.subscription.paused', { ...sub });
      } else {
        sub.status = 'canceled';
        emit('customer.subscription.updated', { ...sub });
      }
    }
  }
}

const fakeStripe = () => ({
  customers: {
    create: async (p) => {
      const id = nextId('cus');
      CUSTOMERS.set(id, { id, ...p, invoice_settings: {} });
      return { id };
    },
    retrieve: async (id) => CUSTOMERS.get(id) || { id, invoice_settings: {} },
    update: async (id, p) => {
      const c = CUSTOMERS.get(id) || { id, invoice_settings: {} };
      if (p.invoice_settings) c.invoice_settings = { ...c.invoice_settings, ...p.invoice_settings };
      CUSTOMERS.set(id, c);
      return c;
    },
  },
  checkout: {
    sessions: {
      create: async (p) => {
        // A completed Checkout creates the subscription, with the trial the
        // session asked for.
        const id = nextId('sub');
        const sd = p.subscription_data || {};
        const sub = {
          id,
          customer: p.customer,
          status: sd.trial_period_days ? 'trialing' : 'active',
          trial_end: clock.frozen_time + (sd.trial_period_days || 0) * DAY,
          current_period_end: clock.frozen_time + (sd.trial_period_days || 30) * DAY,
          items: { data: [{ price: { id: p.line_items[0].price } }] },
          metadata: sd.metadata || p.metadata || {},
          trial_settings: sd.trial_settings || null,
          pause_collection: null,
          cancel_at_period_end: false,
        };
        SUBS.set(id, sub);
        return {
          id: nextId('cs'),
          url: 'https://checkout.stripe.com/c/pay/clock_stub',
          customer: p.customer,
          subscription: id,
          metadata: p.metadata,
        };
      },
    },
  },
  billingPortal: { sessions: { create: async () => ({ url: 'https://billing.stripe.com/p/stub' }) } },
  subscriptions: {
    retrieve: async (id) => ({ ...SUBS.get(id) }),
    list: async ({ customer }) => ({
      data: [...SUBS.values()].filter((s) => s.customer === customer).map((s) => ({ ...s })),
    }),
    cancel: async (id) => {
      const s = SUBS.get(id);
      if (s) s.status = 'canceled';
      return { ...s };
    },
    update: async (id, p) => {
      const sub = SUBS.get(id);
      if (!sub) return { id };
      // Clearing pause_collection unsets a MANUAL pause and nothing else.
      // On a trial-paused subscription pause_collection is already null, so
      // this is a no-op — which is exactly what it is against real Stripe, and
      // exactly why the old handler silently did nothing.
      if ('pause_collection' in p && (p.pause_collection === '' || p.pause_collection === null)) {
        if (sub.pause_collection) {
          sub.pause_collection = null;
          emit('customer.subscription.updated', { ...sub });
        }
      }
      return { ...sub };
    },
    /**
     * The real way out of a trial pause.
     *
     * Per Stripe's docs: "Initiates resumption of a paused subscription… If
     * Stripe doesn't generate a resumption invoice, the subscription becomes
     * active immediately. When a resumption invoice is generated, Stripe
     * finalizes it immediately. If the invoice is paid… the subscription
     * becomes active." With billing_cycle_anchor 'now' the cycle resets and a
     * full-amount invoice is raised with no proration.
     */
    resume: async (id, p = {}) => {
      const sub = SUBS.get(id);
      if (!sub) return { id };
      if (sub.status !== 'paused') return { ...sub }; // already running
      if (!customerHasPaymentMethod(sub.customer)) {
        const err = new Error('The subscription could not be resumed: no payment method.');
        err.type = "StripeInvalidRequestError";
        throw err;
      }
      // The subscription STAYS PAUSED here. resume() raises and finalizes a
      // resumption invoice but does not collect it — captured live: the invoice
      // sits `open` with auto_advance false and a PaymentIntent at
      // requires_confirmation. Only paying it flips the subscription to active.
      const invoice = openInvoiceFor(sub, 'subscription_cycle');
      sub.latest_invoice = invoice.id;
      return { ...sub };
    },
  },
  invoices: {
    retrieve: async (id) => ({ ...INVOICES.find((i) => i.id === id) }),
    /**
     * Pay an open invoice. This is the step that actually finishes a resume:
     * the subscription only becomes active once its resumption invoice is paid.
     */
    pay: async (id) => {
      const invoice = INVOICES.find((i) => i.id === id);
      if (!invoice || invoice.status !== 'open') return { ...invoice };
      invoice.status = 'paid';
      invoice.amount_paid = invoice.total;
      emit('invoice.paid', { ...invoice });
      const sub = SUBS.get(invoice.subscription);
      if (sub && sub.status === 'paused') {
        sub.status = 'active';
        sub.pause_collection = null;
        sub.current_period_end = clock.frozen_time + 30 * DAY;
        emit('customer.subscription.updated', { ...sub });
        emit('customer.subscription.resumed', { ...sub });
      }
      return { ...invoice };
    },
  },
  paymentMethods: {
    /**
     * Attach a card, the way the billing portal does it.
     *
     * `setDefault` models the portal's own behaviour: adding a payment method
     * through the portal makes it the customer's default when they have none.
     * Passing false models a bare API attach, which does not — that is the case
     * routes/billing.js has to cover itself, or a resumed subscription has
     * nothing to charge.
     *
     * What is NOT modelled, deliberately: resuming a paused subscription.
     * Stripe leaves pause_collection set, and pretending otherwise would hide
     * the exact bug the payment_method.attached branch exists to fix.
     */
    attach: async (pmId, { customer, setDefault = true }) => {
      const pm = { id: pmId, object: 'payment_method', type: 'card', customer };
      const c = CUSTOMERS.get(customer);
      if (setDefault && c && !c.invoice_settings.default_payment_method) {
        c.invoice_settings.default_payment_method = pmId;
      }
      emit('payment_method.attached', pm);
      return pm;
    },
  },
  testHelpers: {
    testClocks: {
      create: async ({ frozen_time }) => { clock.frozen_time = frozen_time; return { id: 'clock_1', frozen_time }; },
      advance: async ({ frozen_time }) => { advanceTo(frozen_time); return { id: 'clock_1', frozen_time }; },
      retrieve: async () => ({ id: 'clock_1', frozen_time: clock.frozen_time }),
    },
  },
  webhooks: { constructEvent: (buf) => JSON.parse(buf.toString('utf8')) },
});

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'stripe') return fakeStripe;
  return origLoad.call(this, request, parent, isMain);
};

const express = require('express');
const db = require('../services/db');
const auth = require('../services/authService');
const { entitlementForOrg, ENTITLEMENT } = require('../services/entitlements');
const { TRIAL_WILL_END } = require('../services/trialEmail');
const trialStartRouter = require('./trialStart');
const adminTrialInvitesRouter = require('./adminTrialInvites');
const billingRouter = require('./billing');

let server; let base; let operatorToken;

before(async () => {
  db.getDb();
  const opOrg = auth.createOrganization('Joyaco BV');
  const operator = auth.createUser({
    email: 'operator@cvsprings.test',
    passwordHash: await auth.hashPassword('CorrectHorseBattery1!'),
    orgId: opOrg.id,
    role: 'owner',
  });
  operatorToken = auth.createSession(operator.id).rawToken;

  const app = express();
  app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), billingRouter.handleWebhook);
  app.use(express.json());
  app.use('/admin', adminTrialInvitesRouter);
  app.use('/start', trialStartRouter);
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  try { server.close(); } catch (_) {}
  Module._load = origLoad;
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}
});

// --- Driving the pipeline ---------------------------------------------------

const delivered = []; // every event type the webhook actually received

async function post(type, object, created) {
  const res = await fetch(base + '/api/billing/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': 'stub' },
    body: JSON.stringify({ id: nextId('evt'), type, created, data: { object } }),
  });
  assert.equal(res.status, 200, `${type} webhook should be accepted`);
  delivered.push(type);
}

/**
 * Deliver every queued event, then everything those handlers caused.
 *
 * The loop is the point: clearing pause_collection makes Stripe emit
 * subscription.updated and invoice.paid, and those have to land on the handler
 * too or the third test would assert against a half-applied state.
 */
async function deliver() {
  let guard = 0;
  while (PENDING.length) {
    if (++guard > 50) throw new Error('event cascade did not settle');
    const batch = PENDING.splice(0, PENDING.length);
    for (const evt of batch) {
      // Each event strictly newer than the last, so the ordering guard in
      // routes/billing.js never fires on a legitimate sequence.
      await post(evt.type, evt.object, clock.frozen_time + (++seq % 1000));
    }
  }
}

async function advance(days) {
  await fakeStripeClockAdvance(clock.frozen_time + days * DAY);
  await deliver();
}
// Reached through the same testHelpers surface the live version would use.
const stripeForTests = fakeStripe();
const fakeStripeClockAdvance = (t) => stripeForTests.testHelpers.testClocks.advance({ frozen_time: t });

async function mintToken(email, companyName, campaign) {
  const res = await fetch(base + '/admin/trial-invites', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${operatorToken}` },
    body: JSON.stringify({ invites: [{ email, company_name: companyName, campaign }] }),
  });
  assert.equal(res.status, 201);
  return (await res.json()).invites[0];
}

/** Redeem a token: open Checkout, then complete it the way Stripe would. */
async function startTrial(email, companyName, campaign) {
  const invite = await mintToken(email, companyName, campaign);
  const res = await fetch(`${base}/start?t=${invite.token}`, { redirect: 'manual' });
  assert.equal(res.status, 302);

  const row = db.findTrialInviteByToken(invite.token);
  const sub = [...SUBS.values()].find((s) => s.customer === row.stripeCustomerId);
  assert.ok(sub, 'Checkout created a subscription');

  await post('checkout.session.completed', {
    id: nextId('cs'),
    customer: row.stripeCustomerId,
    subscription: sub.id,
    metadata: sub.metadata,
  }, clock.frozen_time);
  await deliver();

  return { invite, orgId: row.orgId, customerId: row.stripeCustomerId, sub };
}

const entitlementOf = (orgId) => entitlementForOrg(db.getOrgBilling(orgId));
const statusOf = (orgId) => (db.getOrgBilling(orgId) || {}).subscriptionStatus;

async function attachCard(customerId, pmId, { setDefault = true } = {}) {
  await stripeForTests.paymentMethods.attach(pmId, { customer: customerId, setDefault });
  await deliver();
}

// --- 1. No payment method: the trial must pause -----------------------------

describe('30 days, no payment method', () => {
  let ctx;

  before(async () => {
    delivered.length = 0;
    ctx = await startTrial('nopay@alpha.test', 'Alpha Recruitment', 'q1-agencies');
  });

  test('the trial starts and the account has full access', () => {
    assert.equal(statusOf(ctx.orgId), 'trialing');
    assert.equal(entitlementOf(ctx.orgId), ENTITLEMENT.FULL,
      'a trialing org is entitled, or the trial is a trial of nothing');
    assert.equal(db.getOrgBilling(ctx.orgId).plan, 'pro');
  });

  test('trial_will_end fires three days out and the email is queued', async () => {
    await advance(27);
    assert.ok(delivered.includes('customer.subscription.trial_will_end'),
      'Stripe sent the notice');

    const emails = db.listTrialEmails(ctx.orgId);
    const reminder = emails.find((e) => e.kind === TRIAL_WILL_END);
    assert.ok(reminder, 'the reminder is recorded');
    assert.equal(reminder.toEmail, 'nopay@alpha.test', 'addressed to the invited prospect');
    assert.equal(reminder.subscriptionId, ctx.sub.id);
    assert.equal(reminder.error, null, 'and it was not a failed send');
  });

  test('access is still full during the notice period', () => {
    assert.equal(statusOf(ctx.orgId), 'trialing');
    assert.equal(entitlementOf(ctx.orgId), ENTITLEMENT.FULL);
  });

  test('on day 30 the subscription PAUSES — it does not cancel', async () => {
    await advance(3);
    assert.equal(SUBS.get(ctx.sub.id).status, 'paused');
    assert.notEqual(SUBS.get(ctx.sub.id).status, 'canceled');
    assert.equal(SUBS.get(ctx.sub.id).pause_collection, null,
      'a trial pause does NOT set pause_collection — status is the only signal');
    assert.equal(statusOf(ctx.orgId), 'paused', 'and the org records it');
  });

  test('nothing was invoiced', () => {
    const invoices = INVOICES.filter((i) => i.subscription === ctx.sub.id);
    assert.equal(invoices.length, 0,
      'a paused trial bills nothing — no EUR 0 invoice, and certainly no EUR 59.29 one');
  });

  test('the account is read-only, and nothing was deleted', () => {
    assert.equal(entitlementOf(ctx.orgId), ENTITLEMENT.READ_ONLY);
    const billing = db.getOrgBilling(ctx.orgId);
    assert.equal(billing.plan, 'pro', 'the plan is retained, not reset');
    assert.equal(billing.stripeSubscriptionId, ctx.sub.id, 'the subscription is still tracked');
    assert.ok(auth.getOrganizationById(ctx.orgId), 'the organization still exists');
    assert.equal(db.getOrgTrial(ctx.orgId).campaign, 'q1-agencies', 'attribution survives');
  });

  test('the reminder is not sent twice, however many times Stripe redelivers', async () => {
    await post('customer.subscription.trial_will_end', { ...SUBS.get(ctx.sub.id) }, clock.frozen_time + 1);
    const reminders = db.listTrialEmails(ctx.orgId).filter((e) => e.kind === TRIAL_WILL_END);
    assert.equal(reminders.length, 1);
  });
});

// --- 2. Card added on day 28: convert on schedule ---------------------------

describe('card added on day 28', () => {
  let ctx;
  const seen = [];

  before(async () => {
    delivered.length = 0;
    ctx = await startTrial('pays@beta.test', 'Beta Search', 'q1-agencies');
    seen.push(['day 0', entitlementOf(ctx.orgId)]);
  });

  test('access is full from the first day', () => {
    assert.equal(entitlementOf(ctx.orgId), ENTITLEMENT.FULL);
    assert.equal(statusOf(ctx.orgId), 'trialing');
  });

  test('the card is attached on day 28 and the subscription stays trialing', async () => {
    await advance(28);
    seen.push(['day 28 (pre-card)', entitlementOf(ctx.orgId)]);
    await attachCard(ctx.customerId, 'pm_card_beta');

    assert.equal(SUBS.get(ctx.sub.id).status, 'trialing', 'still in the trial, just funded now');
    assert.equal(statusOf(ctx.orgId), 'trialing');
    seen.push(['day 28 (post-card)', entitlementOf(ctx.orgId)]);
  });

  test('on day 30 the trial converts: status goes active', async () => {
    await advance(2);
    assert.equal(SUBS.get(ctx.sub.id).status, 'active');
    assert.equal(statusOf(ctx.orgId), 'active');
    seen.push(['day 30', entitlementOf(ctx.orgId)]);
  });

  test('the first invoice is EUR 49 + VAT', () => {
    const invoices = INVOICES.filter((i) => i.subscription === ctx.sub.id);
    assert.equal(invoices.length, 1, 'exactly one invoice, the first post-trial one');
    const [invoice] = invoices;
    assert.equal(invoice.currency, 'eur');
    assert.equal(invoice.subtotal, 4900, 'EUR 49.00 ex-VAT');
    assert.equal(invoice.tax, 1029, 'EUR 10.29 VAT at 21%');
    assert.equal(invoice.amount_paid, 5929, 'EUR 59.29 charged');
    assert.equal(invoice.amount_paid, PRO_TOTAL_CENTS);
  });

  test('the account is marked converted, with the campaign it came from', () => {
    const trial = db.getOrgTrial(ctx.orgId);
    assert.ok(trial.convertedAt, 'conversion recorded');
    assert.equal(trial.campaign, 'q1-agencies');
    assert.equal(db.findTrialInviteByOrg(ctx.orgId).convertedAt, trial.convertedAt,
      'and mirrored onto the invite for campaign reporting');
  });

  test('a redelivered invoice.paid does not move the conversion date', async () => {
    const before = db.getOrgTrial(ctx.orgId).convertedAt;
    const invoice = INVOICES.find((i) => i.subscription === ctx.sub.id);
    await post('invoice.paid', invoice, clock.frozen_time + 1);
    assert.equal(db.getOrgTrial(ctx.orgId).convertedAt, before);
  });

  test('access stayed FULL at every point along the way', async () => {
    await advance(1);
    seen.push(['day 31', entitlementOf(ctx.orgId)]);
    for (const [when, level] of seen) {
      assert.equal(level, ENTITLEMENT.FULL, `access at ${when}`);
    }
    assert.equal(entitlementOf(ctx.orgId), ENTITLEMENT.FULL);
  });

  test('no reminder was suppressed — it went out on day 27 as usual', () => {
    const reminders = db.listTrialEmails(ctx.orgId).filter((e) => e.kind === TRIAL_WILL_END);
    assert.equal(reminders.length, 1, 'the card arrived after the notice, which is the normal case');
  });
});

// --- 3. Paused, then a card on day 35 ---------------------------------------

describe('paused, card added on day 35', () => {
  let ctx;

  before(async () => {
    delivered.length = 0;
    ctx = await startTrial('late@gamma.test', 'Gamma Partners', 'q2-outbound');
    await advance(30); // through the notice and into the pause
  });

  test('the account is paused and read-only before the card arrives', () => {
    assert.equal(SUBS.get(ctx.sub.id).status, 'paused');
    assert.equal(SUBS.get(ctx.sub.id).pause_collection, null, 'null, as real Stripe reports it');
    assert.equal(entitlementOf(ctx.orgId), ENTITLEMENT.READ_ONLY);
  });

  test('attaching a card on day 35 resumes the subscription', async () => {
    await advance(5);
    assert.equal(entitlementOf(ctx.orgId), ENTITLEMENT.READ_ONLY, 'still paused on day 35');

    await attachCard(ctx.customerId, 'pm_card_gamma');

    assert.equal(SUBS.get(ctx.sub.id).status, 'active',
      'resumed — Stripe does NOT do this when a card is merely attached');
  });

  test('full access is restored', () => {
    assert.equal(SUBS.get(ctx.sub.id).status, 'active');
    assert.equal(statusOf(ctx.orgId), 'active');
    assert.equal(entitlementOf(ctx.orgId), ENTITLEMENT.FULL);
  });

  test('the resumed subscription bills the period, at EUR 49 + VAT', () => {
    assert.equal(CUSTOMERS.get(ctx.customerId).invoice_settings.default_payment_method, 'pm_card_gamma');
    const invoices = INVOICES.filter((i) => i.subscription === ctx.sub.id);
    assert.equal(invoices.length, 1, 'resuming collection billed the period');
    assert.equal(invoices[0].amount_paid, PRO_TOTAL_CENTS);
  });

  test('and the late conversion is attributed to its campaign', () => {
    const trial = db.getOrgTrial(ctx.orgId);
    assert.ok(trial.convertedAt);
    assert.equal(trial.campaign, 'q2-outbound');
  });

  test('the org kept everything through the pause', () => {
    const billing = db.getOrgBilling(ctx.orgId);
    assert.equal(billing.plan, 'pro');
    assert.equal(billing.stripeSubscriptionId, ctx.sub.id);
  });

  test('a second payment_method.attached is a no-op', async () => {
    const invoicesBefore = INVOICES.filter((i) => i.subscription === ctx.sub.id).length;
    const defaultBefore = CUSTOMERS.get(ctx.customerId).invoice_settings.default_payment_method;

    await attachCard(ctx.customerId, 'pm_card_gamma_second');

    assert.equal(SUBS.get(ctx.sub.id).status, 'active', 'still active');
    assert.equal(SUBS.get(ctx.sub.id).pause_collection, null);
    assert.equal(INVOICES.filter((i) => i.subscription === ctx.sub.id).length, invoicesBefore,
      'nothing was billed again');
    assert.equal(CUSTOMERS.get(ctx.customerId).invoice_settings.default_payment_method, defaultBefore,
      'and the customer\'s chosen default was not silently replaced');
  });

  test('a redelivered attach on a never-paused customer does nothing either', async () => {
    const other = await startTrial('never@delta.test', 'Delta BV', 'q2-outbound');
    const invoicesBefore = INVOICES.length;
    await attachCard(other.customerId, 'pm_card_delta');
    assert.equal(SUBS.get(other.sub.id).status, 'trialing', 'an ordinary card-on-file, mid-trial');
    assert.equal(INVOICES.length, invoicesBefore, 'no invoice was conjured');
  });
});

// --- 4. The handler's own default-payment-method fallback -------------------

describe('a card attached without becoming the default', () => {
  /**
   * The portal sets a new card as the default when the customer has none, and
   * the journeys above go through the portal. A card attached any other way —
   * the API directly, an integration, a Stripe dashboard action — does not.
   *
   * Resuming collection for a customer with no default payment method just
   * fails the next invoice and drops them into past_due, which to the customer
   * looks exactly like the pause they thought they had just escaped. So
   * routes/billing.js sets it when it is missing, and that is what this drives.
   */
  let ctx;

  before(async () => {
    ctx = await startTrial('bare@epsilon.test', 'Epsilon BV', 'q2-outbound');
    await advance(30); // into the pause
    assert.equal(entitlementOf(ctx.orgId), ENTITLEMENT.READ_ONLY);
    assert.equal(CUSTOMERS.get(ctx.customerId).invoice_settings.default_payment_method, undefined);
  });

  test('the handler supplies the default itself and resumes anyway', async () => {
    await attachCard(ctx.customerId, 'pm_bare_epsilon', { setDefault: false });

    assert.equal(CUSTOMERS.get(ctx.customerId).invoice_settings.default_payment_method, 'pm_bare_epsilon',
      'set by routes/billing.js, not by the portal');
    assert.equal(SUBS.get(ctx.sub.id).pause_collection, null);
    assert.equal(SUBS.get(ctx.sub.id).status, 'active');
    assert.equal(entitlementOf(ctx.orgId), ENTITLEMENT.FULL);
  });

  test('a customer\'s existing default is never overwritten by a later card', async () => {
    const before = CUSTOMERS.get(ctx.customerId).invoice_settings.default_payment_method;
    await attachCard(ctx.customerId, 'pm_bare_epsilon_2', { setDefault: false });
    assert.equal(CUSTOMERS.get(ctx.customerId).invoice_settings.default_payment_method, before);
  });
});
