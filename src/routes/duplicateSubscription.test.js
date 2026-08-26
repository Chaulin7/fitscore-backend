'use strict';

/**
 * src/routes/duplicateSubscription.test.js
 *
 * Two live subscriptions on one customer, and the webhook path that prevents it.
 *
 * The window: POST /api/billing/checkout is mode:'subscription' with no
 * reference to an existing subscription, so Stripe creates a NEW one for every
 * session — it never reuses or supersedes the previous object. A subscription
 * whose first payment did not clear sits in 'incomplete' and stays completable
 * for roughly 23 hours, so a late 3DS confirmation can move it to active long
 * after the owner gave up and checked out again. Both then bill.
 *
 * That is invisible from inside the product: organizations holds ONE
 * stripe_subscription_id, so whichever webhook lands last is the only one the
 * app knows about. The other charges the customer every month with nothing in
 * the UI referring to it.
 *
 * Both orders are exercised below, because they are genuinely different code
 * paths, and the invariant is the same either way: exactly one subscription
 * survives, and the org is left on the paid plan.
 *
 * The second hazard has its own tests here too. Cancelling the duplicate makes
 * Stripe emit a deleted/canceled event for it, and the handler used to treat
 * ANY such event as "this org is now free" — so the cleanup would have
 * downgraded the customer who had just successfully paid. The event ordering
 * guard cannot catch that: the cancellation really is the newer event.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cvs-dup-'));
process.env.DATABASE_PATH = path.join(TMP_DIR, 'test.db');
process.env.STRIPE_SECRET_KEY = 'sk_test_stub_dup';
process.env.STRIPE_PRICE_PRO = 'price_stub_pro';
process.env.STRIPE_PRICE_TEAM = 'price_stub_team';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_stub';

// --- a Stripe stub that DOES model a subscription set -----------------------
// The shared helper returns an empty list because it models no lifecycle. This
// one holds subscriptions so the de-duplication has something real to find.
const SUBS = new Map(); // id -> { id, customer, status, items, metadata }
const cancelled = [];
let cancelThrows = false; // fault injection for the best-effort cleanup path

function subObj(id, customer, status, priceId, orgId) {
  return {
    id, customer, status,
    items: { data: [{ price: { id: priceId } }] },
    metadata: { orgId },
    current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
    cancel_at_period_end: false,
  };
}

const fakeStripe = () => ({
  customers: { create: async () => ({ id: 'cus_dup' }) },
  checkout: { sessions: { create: async () => ({ id: 'cs', url: 'https://checkout.stripe.com/stub' }) } },
  billingPortal: { sessions: { create: async () => ({ url: 'https://billing.stripe.com/stub' }) } },
  subscriptions: {
    retrieve: async (id) => SUBS.get(id) || { id, status: 'active', items: { data: [] } },
    list: async ({ customer }) => ({
      data: [...SUBS.values()].filter((s) => s.customer === customer),
    }),
    cancel: async (id) => {
      if (cancelThrows) {
        const err = new Error('Stripe is unavailable');
        err.type = 'StripeAPIError';
        throw err;
      }
      const s = SUBS.get(id);
      if (s) s.status = 'canceled';
      cancelled.push(id);
      return s || { id, status: 'canceled' };
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
const billingRouter = require('../routes/billing');

const ORG = 'dup-org';
const CUS = 'cus_dup';
let server; let base;

before(async () => {
  db.getDb();
  const now = new Date().toISOString();
  db.getDb().prepare('INSERT INTO organizations (id, name, created_at) VALUES (?, ?, ?)')
    .run(ORG, 'Dup Co', now);
  db.setOrgStripeCustomerId(ORG, CUS);

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

let clock = Math.floor(Date.now() / 1000);
async function webhook(type, object) {
  clock += 1; // each event strictly newer, so the ordering guard never fires
  const res = await fetch(base + '/api/billing/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': 'stub' },
    body: JSON.stringify({ id: 'evt_' + clock, type, created: clock, data: { object } }),
  });
  return res.status;
}

function orgRow() {
  return db.getDb().prepare(
    'SELECT plan, subscription_status AS status, stripe_subscription_id AS subId FROM organizations WHERE id = ?',
  ).get(ORG);
}
function liveSubs() {
  return [...SUBS.values()].filter((s) => s.status !== 'canceled').map((s) => s.id).sort();
}

beforeEach(() => {
  SUBS.clear();
  cancelled.length = 0;
  cancelThrows = false;
  db.setOrgPlan(ORG, { plan: 'free', subscriptionStatus: null, currentPeriodEnd: null, stripeSubscriptionId: null });
  db.getDb().prepare('UPDATE organizations SET stripe_event_created = NULL WHERE id = ?').run(ORG);
});

describe('order 1: the owner re-buys, then the abandoned attempt completes late', () => {
  test('exactly one subscription survives and the org stays on Pro', async () => {
    // A: first attempt, 3DS not yet confirmed.
    SUBS.set('sub_A', subObj('sub_A', CUS, 'incomplete', 'price_stub_pro', ORG));
    await webhook('customer.subscription.created', SUBS.get('sub_A'));
    assert.equal(orgRow().plan, 'pro', 'incomplete still records the tier it was for');

    // B: owner gives up and buys again; this one clears immediately.
    SUBS.set('sub_B', subObj('sub_B', CUS, 'active', 'price_stub_pro', ORG));
    await webhook('customer.subscription.created', SUBS.get('sub_B'));

    assert.deepEqual(liveSubs(), ['sub_B'], 'the abandoned incomplete attempt must be cancelled');
    assert.deepEqual(cancelled, ['sub_A']);
    const row = orgRow();
    assert.equal(row.plan, 'pro');
    assert.equal(row.subId, 'sub_B', 'the org tracks the subscription that actually billed');
  });

  test('the resulting cancellation event does not downgrade the paying customer', async () => {
    SUBS.set('sub_A', subObj('sub_A', CUS, 'incomplete', 'price_stub_pro', ORG));
    await webhook('customer.subscription.created', SUBS.get('sub_A'));
    SUBS.set('sub_B', subObj('sub_B', CUS, 'active', 'price_stub_pro', ORG));
    await webhook('customer.subscription.created', SUBS.get('sub_B'));

    // Stripe now reports the cancellation we just caused. It is the NEWEST
    // event, so the ordering guard offers no protection here.
    await webhook('customer.subscription.deleted', SUBS.get('sub_A'));

    const row = orgRow();
    assert.equal(row.plan, 'pro', 'the customer paid; cleaning up the duplicate must not downgrade them');
    assert.equal(row.subId, 'sub_B');
  });

  test('the real subscription being deleted DOES still downgrade (guards a vacuous pass)', async () => {
    SUBS.set('sub_B', subObj('sub_B', CUS, 'active', 'price_stub_pro', ORG));
    await webhook('customer.subscription.created', SUBS.get('sub_B'));
    assert.equal(orgRow().plan, 'pro');

    await webhook('customer.subscription.deleted', SUBS.get('sub_B'));
    assert.equal(orgRow().plan, 'free', 'a genuine cancellation must still take effect');
  });
});

describe('order 2: the abandoned attempt completes late, after the re-buy is already active', () => {
  test('exactly one subscription survives and the org stays on Pro', async () => {
    SUBS.set('sub_A', subObj('sub_A', CUS, 'incomplete', 'price_stub_pro', ORG));
    await webhook('customer.subscription.created', SUBS.get('sub_A'));
    SUBS.set('sub_B', subObj('sub_B', CUS, 'active', 'price_stub_pro', ORG));
    await webhook('customer.subscription.created', SUBS.get('sub_B'));
    // Cleanup already cancelled A above; simulate Stripe having accepted the
    // late 3DS confirmation anyway by putting A back in play, which is the
    // worst-case race this test exists for.
    SUBS.get('sub_A').status = 'active';
    cancelled.length = 0;

    await webhook('customer.subscription.updated', SUBS.get('sub_A'));

    assert.equal(liveSubs().length, 1, 'a customer must never be left billing twice for one tier');
    assert.deepEqual(cancelled, ['sub_B'], 'the later activation supersedes the earlier one');
    assert.equal(orgRow().plan, 'pro');
    assert.equal(orgRow().subId, 'sub_A', 'the org tracks whichever subscription won');
  });

  test('and the follow-up cancellation event still does not downgrade', async () => {
    SUBS.set('sub_A', subObj('sub_A', CUS, 'incomplete', 'price_stub_pro', ORG));
    SUBS.set('sub_B', subObj('sub_B', CUS, 'active', 'price_stub_pro', ORG));
    await webhook('customer.subscription.created', SUBS.get('sub_B'));
    SUBS.get('sub_A').status = 'active';
    await webhook('customer.subscription.updated', SUBS.get('sub_A'));
    await webhook('customer.subscription.deleted', SUBS.get('sub_B'));

    assert.equal(orgRow().plan, 'pro');
    assert.equal(orgRow().subId, 'sub_A');
  });
});

describe('the cleanup is narrow enough to be safe', () => {
  test('a different tier on the same customer is left alone', async () => {
    // Pro -> Team via a second checkout also leaves two subscriptions, but the
    // right fix there is proration on the existing one, not silent
    // cancellation from a webhook. This asserts we do not overreach.
    SUBS.set('sub_pro', subObj('sub_pro', CUS, 'active', 'price_stub_pro', ORG));
    await webhook('customer.subscription.created', SUBS.get('sub_pro'));
    SUBS.set('sub_team', subObj('sub_team', CUS, 'active', 'price_stub_team', ORG));
    await webhook('customer.subscription.created', SUBS.get('sub_team'));

    assert.deepEqual(liveSubs(), ['sub_pro', 'sub_team'], 'cross-tier cleanup is deliberately not done here');
    assert.equal(orgRow().plan, 'team');
  });

  test('an incomplete subscription arriving never cancels the active one', async () => {
    SUBS.set('sub_live', subObj('sub_live', CUS, 'active', 'price_stub_pro', ORG));
    await webhook('customer.subscription.created', SUBS.get('sub_live'));
    SUBS.set('sub_new', subObj('sub_new', CUS, 'incomplete', 'price_stub_pro', ORG));
    await webhook('customer.subscription.created', SUBS.get('sub_new'));

    assert.ok(liveSubs().includes('sub_live'), 'a non-billing attempt must not evict a paying subscription');
    assert.deepEqual(cancelled, [], 'nothing should have been cancelled by an incomplete arrival');
  });

  test('already-terminal subscriptions are not re-cancelled', async () => {
    SUBS.set('sub_old', subObj('sub_old', CUS, 'canceled', 'price_stub_pro', ORG));
    SUBS.set('sub_new', subObj('sub_new', CUS, 'active', 'price_stub_pro', ORG));
    await webhook('customer.subscription.created', SUBS.get('sub_new'));
    assert.deepEqual(cancelled, [], 'a canceled subscription needs no cancelling');
  });

  test('a Stripe failure during cleanup does not fail the webhook or the plan write', async () => {
    SUBS.set('sub_A', subObj('sub_A', CUS, 'incomplete', 'price_stub_pro', ORG));
    SUBS.set('sub_B', subObj('sub_B', CUS, 'active', 'price_stub_pro', ORG));
    cancelThrows = true; // Stripe is down exactly when we try to tidy up

    const status = await webhook('customer.subscription.created', SUBS.get('sub_B'));

    assert.equal(status, 200,
      'a 500 here would make Stripe retry this event forever over a cleanup failure');
    assert.equal(orgRow().plan, 'pro', 'org state is written before the cleanup is attempted');
    assert.equal(orgRow().subId, 'sub_B');
    assert.deepEqual(cancelled, [], 'the cancellation genuinely failed');
    assert.ok(liveSubs().includes('sub_A'),
      'the duplicate survives, which is what stripeReconcile exists to report');
  });

  test('the fault injection actually bites (guards a vacuous pass)', async () => {
    SUBS.set('sub_A', subObj('sub_A', CUS, 'incomplete', 'price_stub_pro', ORG));
    SUBS.set('sub_B', subObj('sub_B', CUS, 'active', 'price_stub_pro', ORG));
    cancelThrows = false;
    await webhook('customer.subscription.created', SUBS.get('sub_B'));
    assert.deepEqual(cancelled, ['sub_A'], 'without the fault, the same flow does cancel');
  });
});
