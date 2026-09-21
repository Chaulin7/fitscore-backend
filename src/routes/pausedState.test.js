'use strict';

/**
 * src/routes/pausedState.test.js — the paused screen and the two ways out.
 *
 * THE INVARIANT under test throughout: an organization never holds more than
 * one non-canceled subscription. A paused subscription is not canceled — it
 * carries the plan and bills the moment it resumes — so every path that might
 * sell, resume or switch has to respect it.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cvs-paused-'));
process.env.DATABASE_PATH = path.join(TMP_DIR, 'test.db');
process.env.STRIPE_SECRET_KEY = 'sk_test_stub_paused';
process.env.STRIPE_PRICE_PRO = 'price_stub_pro';
process.env.STRIPE_PRICE_TEAM = 'price_stub_team';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_stub';
process.env.PUBLIC_APP_URL = 'https://cvsprings.test';

const SUBS = new Map();
const calls = [];
let payThrows = null;
let seq = 0;
const nextId = (p) => `${p}_${++seq}`;

function subObj(id, customer, status, priceId, extra = {}) {
  return {
    id, customer, status,
    items: { data: [{ id: `si_${id}`, price: { id: priceId } }] },
    metadata: {}, pause_collection: null, latest_invoice: null,
    ...extra,
  };
}

const INVOICES = new Map();

const fakeStripe = () => ({
  customers: {
    create: async () => ({ id: nextId('cus') }),
    retrieve: async (id) => ({ id, invoice_settings: {} }),
    update: async (id, p) => { calls.push({ call: 'customers.update', id, p }); return { id, ...p }; },
  },
  checkout: {
    sessions: {
      create: async (p) => {
        calls.push({ call: 'checkout.sessions.create', mode: p.mode, customer: p.customer, metadata: p.metadata });
        return { id: nextId('cs'), url: 'https://checkout.stripe.com/' + p.mode };
      },
    },
  },
  billingPortal: { sessions: { create: async () => ({ url: 'https://billing.stripe.com/stub' }) } },
  subscriptions: {
    retrieve: async (id) => ({ ...SUBS.get(id) }),
    list: async ({ customer }) => ({ data: [...SUBS.values()].filter((s) => s.customer === customer).map((s) => ({ ...s })) }),
    cancel: async (id) => {
      calls.push({ call: 'subscriptions.cancel', id });
      const s = SUBS.get(id); if (s) s.status = 'canceled'; return { ...s };
    },
    update: async (id, p) => {
      calls.push({ call: 'subscriptions.update', id, p });
      const s = SUBS.get(id); if (!s) return { id };
      if (p.metadata) s.metadata = { ...p.metadata };
      if (p.items && p.items[0] && p.items[0].price) s.items.data[0].price = { id: p.items[0].price };
      if (p.default_payment_method) s.default_payment_method = p.default_payment_method;
      return { ...s };
    },
    resume: async (id, p) => {
      calls.push({ call: 'subscriptions.resume', id, p });
      const s = SUBS.get(id);
      if (!s || s.status !== 'paused') return { ...s };
      const inv = { id: nextId('in'), subscription: id, status: 'open', total: 5929, amount_paid: 0 };
      INVOICES.set(inv.id, inv);
      s.latest_invoice = inv.id;
      return { ...s };
    },
  },
  invoices: {
    retrieve: async (id) => ({ ...INVOICES.get(id) }),
    pay: async (id) => {
      calls.push({ call: 'invoices.pay', id });
      if (payThrows) { const e = new Error(payThrows.message); e.code = payThrows.code; e.type = 'StripeCardError'; throw e; }
      const inv = INVOICES.get(id);
      inv.status = 'paid'; inv.amount_paid = inv.total;
      const s = SUBS.get(inv.subscription);
      if (s) { s.status = 'active'; }
      return { ...inv };
    },
  },
  paymentMethods: { attach: async (pm, { customer }) => ({ id: pm, customer }) },
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
const billingRouter = require('./billing');
const { entitlementForOrg, ENTITLEMENT } = require('../services/entitlements');

const CUS = 'cus_paused';
let server; let base; let token; let orgId;

before(async () => {
  db.getDb();
  const org = auth.createOrganization('Paused Co');
  orgId = org.id;
  const user = auth.createUser({
    email: 'owner@paused.test', passwordHash: await auth.hashPassword('CorrectHorseBattery1!'),
    orgId, role: 'owner',
  });
  token = auth.createSession(user.id).rawToken;
  db.setOrgStripeCustomerId(orgId, CUS);

  const app = express();
  app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), billingRouter.handleWebhook);
  app.use(express.json());
  app.use('/api/billing', billingRouter);
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  try { server.close(); } catch (_) {}
  Module._load = origLoad;
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}
});

const call = (method, url, body) => fetch(base + url, {
  method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

let clock = Math.floor(Date.now() / 1000);
async function webhook(type, object) {
  clock += 1;
  const res = await fetch(base + '/api/billing/webhook', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': 'stub' },
    body: JSON.stringify({ id: nextId('evt'), type, created: clock, data: { object } }),
  });
  return res.status;
}

/** Put the org in the paused state with exactly one paused Pro subscription. */
function setPaused(subId = 'sub_paused') {
  SUBS.clear(); INVOICES.clear();
  SUBS.set(subId, subObj(subId, CUS, 'paused', 'price_stub_pro'));
  db.setOrgPlan(orgId, {
    plan: 'pro', subscriptionStatus: 'paused', currentPeriodEnd: null, stripeSubscriptionId: subId,
  });
  db.setResumeError(orgId, null);
  return subId;
}
const liveSubs = () => [...SUBS.values()].filter((s) => s.status !== 'canceled');

beforeEach(() => { calls.length = 0; payThrows = null; });

describe('the paused panel state', () => {
  before(() => setPaused());

  test('a paused org is no longer reported as pro_active', async () => {
    const res = await call('GET', '/api/billing/plan-summary');
    const body = await res.json();
    assert.equal(body.state, 'paused');
    assert.equal(body.subscriptionStatus, 'paused');
  });

  test('it offers exactly three ways out, and none of them is a new checkout', async () => {
    const body = await (await call('GET', '/api/billing/plan-summary')).json();
    const ids = body.actions.map((a) => a.id);
    assert.deepEqual(ids.sort(), ['continue_free', 'continue_pro', 'continue_team']);
    for (const a of body.actions) {
      assert.notEqual(a.action, 'startPlanCheckout', `${a.id} must not open a fresh checkout`);
    }
    assert.equal(body.actions.find((a) => a.id === 'continue_free').confirm, true,
      'the destructive one is marked for confirmation');
  });

  test('the org is read-only while paused', () => {
    assert.equal(entitlementForOrg(db.getOrgBilling(orgId)), ENTITLEMENT.READ_ONLY);
  });
});

describe('the invariant: checkout is refused while paused', () => {
  beforeEach(() => setPaused());

  test('POST /checkout is refused at every tier', async () => {
    for (const plan of ['pro', 'team']) {
      const res = await call('POST', '/api/billing/checkout', { plan });
      assert.equal(res.status, 409, plan);
      assert.equal((await res.json()).code, 'SUBSCRIPTION_PAUSED');
    }
    assert.equal(calls.filter((c) => c.call === 'checkout.sessions.create').length, 0,
      'nothing reached Stripe');
    assert.equal(liveSubs().length, 1, 'still exactly one subscription');
  });
});

describe('Continue on Pro — resumes the existing subscription', () => {
  beforeEach(() => setPaused());

  test('it opens Checkout in SETUP mode and creates no subscription', async () => {
    const res = await call('POST', '/api/billing/resume', { plan: 'pro' });
    assert.equal(res.status, 200);
    assert.match((await res.json()).url, /checkout\.stripe\.com\/setup/);

    const session = calls.find((c) => c.call === 'checkout.sessions.create');
    assert.equal(session.mode, 'setup', 'setup mode: it collects a card, it does not sell a subscription');
    assert.equal(session.customer, CUS);
    assert.equal(liveSubs().length, 1, 'no second subscription was created');
  });

  test('the card arriving resumes the EXISTING subscription and pays its invoice', async () => {
    await call('POST', '/api/billing/resume', { plan: 'pro' });
    await webhook('payment_method.attached', { id: 'pm_1', object: 'payment_method', customer: CUS });

    const resumed = calls.find((c) => c.call === 'subscriptions.resume');
    assert.ok(resumed, 'resume() was called');
    assert.equal(resumed.id, 'sub_paused', 'on the subscription the org already had');
    assert.equal(resumed.p.billing_cycle_anchor, 'now');
    assert.ok(calls.find((c) => c.call === 'invoices.pay'), 'and the resumption invoice was paid');
    assert.equal(SUBS.get('sub_paused').status, 'active');
    assert.equal(liveSubs().length, 1);
  });

  test('a redelivered attach on an active subscription does nothing', async () => {
    await call('POST', '/api/billing/resume', { plan: 'pro' });
    await webhook('payment_method.attached', { id: 'pm_1', object: 'payment_method', customer: CUS });
    calls.length = 0;
    await webhook('payment_method.attached', { id: 'pm_1', object: 'payment_method', customer: CUS });
    assert.equal(calls.filter((c) => c.call === 'subscriptions.resume').length, 0);
    assert.equal(calls.filter((c) => c.call === 'invoices.pay').length, 0);
  });

  test('resume is refused when nothing is paused', async () => {
    db.setOrgPlan(orgId, { plan: 'pro', subscriptionStatus: 'active', currentPeriodEnd: null, stripeSubscriptionId: 'sub_paused' });
    const res = await call('POST', '/api/billing/resume', { plan: 'pro' });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).code, 'NOT_PAUSED');
  });
});

describe('Continue on Team — switches the price, never adds a subscription', () => {
  beforeEach(() => setPaused());

  test('the tier choice is recorded but NOT applied until the card arrives', async () => {
    await call('POST', '/api/billing/resume', { plan: 'team' });
    assert.equal(SUBS.get('sub_paused').metadata.pending_plan, 'team');
    assert.equal(SUBS.get('sub_paused').items.data[0].price.id, 'price_stub_pro',
      'abandoning checkout must leave the org exactly as it was');
    assert.equal(liveSubs().length, 1);
  });

  test('the card arriving switches the price on the existing subscription, then resumes it', async () => {
    await call('POST', '/api/billing/resume', { plan: 'team' });
    await webhook('payment_method.attached', { id: 'pm_2', object: 'payment_method', customer: CUS });

    assert.equal(SUBS.get('sub_paused').items.data[0].price.id, 'price_stub_team', 'switched to Team');
    const priceSwitch = calls.find((c) => c.call === 'subscriptions.update' && c.p.items);
    assert.equal(priceSwitch.p.proration_behavior, undefined,
      'proration_behavior must NOT be sent — Stripe refuses it on a paused subscription and the '
      + 'whole resume aborts. billing_cycle_anchor "now" on the resume already means no prorations.');
    assert.equal(SUBS.get('sub_paused').status, 'active');
  });

  test('EXACTLY ONE live subscription afterwards — the hole is closed', async () => {
    await call('POST', '/api/billing/resume', { plan: 'team' });
    await webhook('payment_method.attached', { id: 'pm_2', object: 'payment_method', customer: CUS });
    assert.equal(liveSubs().length, 1, 'a paused Pro sub AND a new Team sub is the bug this closes');
    assert.equal(calls.filter((c) => c.call === 'checkout.sessions.create' && c.mode === 'subscription').length, 0,
      'no subscription-mode checkout was ever opened');
  });
});

describe('Continue on Free — cancels, keeps everything', () => {
  beforeEach(() => setPaused());

  test('it refuses without an explicit confirmation', async () => {
    const res = await call('POST', '/api/billing/continue-free', {});
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, 'CONFIRMATION_REQUIRED');
    assert.equal(calls.filter((c) => c.call === 'subscriptions.cancel').length, 0);
  });

  test('confirmed, it cancels the subscription and moves the org to Free', async () => {
    const res = await call('POST', '/api/billing/continue-free', { confirm: true });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.plan, 'free');
    assert.equal(body.dataRetained, true);

    assert.ok(calls.find((c) => c.call === 'subscriptions.cancel' && c.id === 'sub_paused'));
    assert.equal(liveSubs().length, 0, 'no subscription left behind to resume and bill later');
    const billing = db.getOrgBilling(orgId);
    assert.equal(billing.plan, 'free');
    assert.equal(billing.stripeSubscriptionId, null);
  });

  test('the Free cap counts only work done AFTER the downgrade', async () => {
    // Trial-period work, charged to the month the downgrade happens in.
    db.incrementUsage(orgId, 8);
    assert.equal(db.getUsageCount(orgId), 8);

    await call('POST', '/api/billing/continue-free', { confirm: true });

    assert.equal(db.getUsageCount(orgId), 0,
      'the trial month must not arrive pre-spent against the Free cap');
    assert.ok(db.getFreeTierSince(orgId), 'and the downgrade is stamped');

    db.incrementUsage(orgId, 2);
    assert.equal(db.getUsageCount(orgId), 2, 'new work counts normally');
  });

  test('the org has full access on Free, and its data is untouched', async () => {
    await call('POST', '/api/billing/continue-free', { confirm: true });
    assert.equal(entitlementForOrg(db.getOrgBilling(orgId)), ENTITLEMENT.FULL,
      'Free is a product, not a lockout');
    assert.ok(auth.getOrganizationById(orgId), 'the organization still exists');
  });
});

describe('a declined card at resume', () => {
  beforeEach(() => {
    setPaused();
    payThrows = { code: 'card_declined', message: 'Your card was declined.' };
  });

  test('the subscription stays paused and the org is NEVER shown as active', async () => {
    await call('POST', '/api/billing/resume', { plan: 'pro' });
    await webhook('payment_method.attached', { id: 'pm_bad', object: 'payment_method', customer: CUS });

    assert.equal(SUBS.get('sub_paused').status, 'paused', 'still paused at Stripe');
    assert.equal(db.getOrgBilling(orgId).subscriptionStatus, 'paused', 'and in our own record');
    assert.equal(entitlementForOrg(db.getOrgBilling(orgId)), ENTITLEMENT.READ_ONLY);
  });

  test('the decline reason is recorded and surfaced on the panel', async () => {
    await call('POST', '/api/billing/resume', { plan: 'pro' });
    await webhook('payment_method.attached', { id: 'pm_bad', object: 'payment_method', customer: CUS });

    const stored = db.getResumeError(orgId);
    assert.ok(stored, 'a reason was recorded');
    assert.match(stored.message, /declined/i);

    const body = await (await call('GET', '/api/billing/plan-summary')).json();
    assert.equal(body.state, 'paused');
    assert.match(body.resumeError, /declined/i, 'so the screen can explain it rather than repeat itself');
  });

  test('a fresh resume attempt clears the previous failure', async () => {
    await call('POST', '/api/billing/resume', { plan: 'pro' });
    await webhook('payment_method.attached', { id: 'pm_bad', object: 'payment_method', customer: CUS });
    assert.ok(db.getResumeError(orgId));

    await call('POST', '/api/billing/resume', { plan: 'pro' });
    assert.equal(db.getResumeError(orgId), null);
  });

  test('a good card afterwards succeeds and clears the error', async () => {
    await call('POST', '/api/billing/resume', { plan: 'pro' });
    await webhook('payment_method.attached', { id: 'pm_bad', object: 'payment_method', customer: CUS });
    payThrows = null;
    await webhook('payment_method.attached', { id: 'pm_good', object: 'payment_method', customer: CUS });

    assert.equal(SUBS.get('sub_paused').status, 'active');
    assert.equal(db.getResumeError(orgId), null);
  });
});

describe('customer.subscription.paused — a side-effect hook only', () => {
  beforeEach(() => setPaused());

  test('it sends one email and writes no status', async () => {
    db.setOrgPlan(orgId, { plan: 'pro', subscriptionStatus: 'trialing', currentPeriodEnd: null, stripeSubscriptionId: 'sub_paused' });
    await webhook('customer.subscription.paused', { ...SUBS.get('sub_paused'), customer: CUS });

    assert.equal(db.getOrgBilling(orgId).subscriptionStatus, 'trialing',
      'status is written only by customer.subscription.updated, behind the ordering guard');
    const mails = db.listTrialEmails(orgId).filter((e) => e.kind === 'trial_paused');
    assert.equal(mails.length, 1);
  });

  test('a redelivery does not send twice', async () => {
    await webhook('customer.subscription.paused', { ...SUBS.get('sub_paused'), customer: CUS });
    await webhook('customer.subscription.paused', { ...SUBS.get('sub_paused'), customer: CUS });
    const mails = db.listTrialEmails(orgId).filter((e) => e.kind === 'trial_paused');
    assert.equal(mails.length, 1);
  });
});
