'use strict';

/**
 * src/routes/planCheckoutGuard.test.js
 *
 * The guards in front of Stripe on POST /api/billing/checkout and /portal.
 *
 * These are money paths, and the failure they prevent is expensive and quiet:
 * Checkout will happily open a SECOND subscription against the same customer,
 * so an owner who clicks Upgrade on the tier they already hold gets billed
 * twice for one plan and nothing in the product looks wrong afterwards.
 *
 * Every assertion that a request was REFUSED is paired with a check that
 * nothing reached Stripe, using the stub's call log. "Returned 400" and
 * "returned 400 having already created the subscription" are very different
 * outcomes and only the log tells them apart.
 *
 * Stripe is stubbed at the network boundary (test/helpers/stripe-stub.js);
 * the owner check, the tier guard and every database write are the real ones.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cvs-guard-'));
process.env.DATABASE_PATH = path.join(TMP_DIR, 'test.db');
process.env.STRIPE_SECRET_KEY = 'sk_test_stub_guard';
process.env.STRIPE_PRICE_PRO = 'price_stub_pro';
process.env.STRIPE_PRICE_TEAM = 'price_stub_team';

// --- Stripe, stubbed in-process -------------------------------------------
// The shared helper is built for a spawned server (it logs to a file via
// STUB_LOG). These tests run in-process, so the same interception is done here
// against an in-memory log — simpler to assert and with no child process.
const calls = [];
const fakeStripe = () => ({
  customers: {
    create: async (p) => {
      const id = 'cus_stub_' + calls.length;
      calls.push({ call: 'customers.create', orgId: p.metadata && p.metadata.orgId, id });
      return { id };
    },
  },
  checkout: {
    sessions: {
      create: async (p) => {
        calls.push({ call: 'checkout.sessions.create', customer: p.customer, price: p.line_items[0].price, metadata: p.metadata });
        return { id: 'cs_stub', url: 'https://checkout.stripe.com/c/pay/stub' };
      },
    },
  },
  billingPortal: {
    sessions: {
      create: async (p) => {
        calls.push({ call: 'billingPortal.sessions.create', customer: p.customer });
        return { url: 'https://billing.stripe.com/p/stub' };
      },
    },
  },
});
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'stripe') return fakeStripe;
  return origLoad.call(this, request, parent, isMain);
};

const express = require('express');
const db = require('../services/db');
const auth = require('../services/authService');
const billingRouter = require('../routes/billing');

const ORG_A = 'guard-org-a';
const ORG_B = 'guard-org-b';

let server; let base; let token;
const TOKENS = {};

before(async () => {
  db.getDb();
  const now = new Date().toISOString();
  const insertOrg = db.getDb().prepare('INSERT INTO organizations (id, name, created_at) VALUES (?, ?, ?)');
  insertOrg.run(ORG_A, 'Acme', now);
  insertOrg.run(ORG_B, 'Beta', now);
  const insertUser = db.getDb().prepare(
    'INSERT INTO users (id, org_id, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  insertUser.run('g-owner-a', ORG_A, 'a@acme.example', 'x', 'owner', now);
  insertUser.run('g-owner-b', ORG_B, 'b@beta.example', 'x', 'owner', now);
  insertUser.run('g-member-a', ORG_A, 'm@acme.example', 'x', 'member', now);

  TOKENS['g-owner-a'] = auth.createSession('g-owner-a').rawToken;
  TOKENS['g-owner-b'] = auth.createSession('g-owner-b').rawToken;
  TOKENS['g-member-a'] = auth.createSession('g-member-a').rawToken;
  token = TOKENS['g-owner-a'];

  const app = express();
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

function actAs(userId) { token = TOKENS[userId]; }

async function post(p, body) {
  const res = await fetch(base + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json() };
}

function setPlan(orgId, fields) {
  db.setOrgPlan(orgId, {
    plan: fields.plan,
    subscriptionStatus: fields.subscriptionStatus || null,
    currentPeriodEnd: null,
  });
  db.setOrgStripeCustomerId(orgId, fields.customerId || null);
  db.getDb().prepare('UPDATE organizations SET comped = ? WHERE id = ?')
    .run(fields.comped ? 1 : 0, orgId);
}

function stripeCalls() { return calls.slice(); }
function callsSince(n) { return calls.slice(n); }

describe('checkout: only a genuine upgrade reaches Stripe', () => {
  before(() => actAs('g-owner-a'));

  test('free -> pro is allowed and sends the configured Pro price', async () => {
    setPlan(ORG_A, { plan: 'free', customerId: null, comped: false });
    const n = calls.length;
    const res = await post('/api/billing/checkout', { plan: 'pro' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const sent = callsSince(n).find((c) => c.call === 'checkout.sessions.create');
    assert.ok(sent, 'a legitimate upgrade must actually reach Stripe');
    assert.equal(sent.price, 'price_stub_pro');
    assert.equal(sent.metadata.orgId, ORG_A, 'the session is bound to the session org');
  });

  test('pro -> pro is refused as PLAN_NOT_AN_UPGRADE and bills nothing', async () => {
    setPlan(ORG_A, { plan: 'pro', subscriptionStatus: 'active', customerId: 'cus_a', comped: false });
    const n = calls.length;
    const res = await post('/api/billing/checkout', { plan: 'pro' });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'PLAN_NOT_AN_UPGRADE');
    assert.deepEqual(callsSince(n), [], 'a second subscription would double-bill the org');
  });

  test('team -> pro (a downgrade) is refused and bills nothing', async () => {
    setPlan(ORG_A, { plan: 'team', subscriptionStatus: 'active', customerId: 'cus_a', comped: false });
    const n = calls.length;
    const res = await post('/api/billing/checkout', { plan: 'pro' });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'PLAN_NOT_AN_UPGRADE');
    assert.deepEqual(callsSince(n), []);
  });

  test('team -> team is refused too', async () => {
    setPlan(ORG_A, { plan: 'team', subscriptionStatus: 'active', customerId: 'cus_a', comped: false });
    const n = calls.length;
    const res = await post('/api/billing/checkout', { plan: 'team' });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'PLAN_NOT_AN_UPGRADE');
    assert.deepEqual(callsSince(n), []);
  });

  test('pro -> team is allowed (the guard is not simply refusing everything)', async () => {
    setPlan(ORG_A, { plan: 'pro', subscriptionStatus: 'active', customerId: 'cus_a', comped: false });
    const n = calls.length;
    const res = await post('/api/billing/checkout', { plan: 'team' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const sent = callsSince(n).find((c) => c.call === 'checkout.sessions.create');
    assert.equal(sent.price, 'price_stub_team');
  });

  test('an unknown tier is rejected before any tier logic runs', async () => {
    setPlan(ORG_A, { plan: 'free', customerId: null, comped: false });
    for (const plan of ['enterprise', 'FREE', '', null, 42, { id: 'pro' }]) {
      const n = calls.length;
      const res = await post('/api/billing/checkout', { plan });
      assert.equal(res.status, 400, `plan=${JSON.stringify(plan)} should be refused`);
      assert.equal(res.body.code, 'VALIDATION_ERROR');
      assert.deepEqual(callsSince(n), []);
    }
  });

  test("a cancelling Pro subscription cannot be 'renewed' by buying Pro again", async () => {
    // cancel_at_period_end reports status 'active' until the moment it lapses.
    // Buying the same tier again would leave a duplicate subscription running
    // past the cancellation instead of resuming the existing one.
    setPlan(ORG_A, { plan: 'pro', subscriptionStatus: 'active', customerId: 'cus_a', comped: false });
    db.getDb().prepare('UPDATE organizations SET cancel_at_period_end = 1 WHERE id = ?').run(ORG_A);
    const n = calls.length;
    const res = await post('/api/billing/checkout', { plan: 'pro' });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'PLAN_NOT_AN_UPGRADE');
    assert.deepEqual(callsSince(n), [], 'the fix is Resume in the portal, not a second subscription');
    db.getDb().prepare('UPDATE organizations SET cancel_at_period_end = 0 WHERE id = ?').run(ORG_A);
  });
});

describe('checkout: comped orgs are never sold anything', () => {
  before(() => actAs('g-owner-a'));
  after(() => setPlan(ORG_A, { plan: 'free', customerId: null, comped: false }));

  test('a comped org is refused with PLAN_COMPED and reaches no Stripe call', async () => {
    setPlan(ORG_A, { plan: 'pro', subscriptionStatus: null, customerId: null, comped: true });
    const n = calls.length;
    const res = await post('/api/billing/checkout', { plan: 'team' });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'PLAN_COMPED');
    assert.deepEqual(callsSince(n), [],
      'a real subscription must not be attached to an account that is entitled without paying');
  });

  test('a comped FREE org is refused as well', async () => {
    setPlan(ORG_A, { plan: 'free', customerId: null, comped: true });
    const n = calls.length;
    const res = await post('/api/billing/checkout', { plan: 'pro' });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'PLAN_COMPED');
    assert.deepEqual(callsSince(n), []);
  });
});

describe('checkout: authorization', () => {
  test('a non-owner member cannot open checkout for their org', async () => {
    // The member needs a live session to get as far as the owner check, which
    // means the org must hold Team (requireSession's seat gate).
    setPlan(ORG_A, { plan: 'team', subscriptionStatus: 'active', customerId: 'cus_a', comped: false });
    actAs('g-member-a');
    const n = calls.length;
    const res = await post('/api/billing/checkout', { plan: 'team' });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'OWNER_REQUIRED');
    assert.deepEqual(callsSince(n), []);
  });

  test('an unauthenticated caller is refused', async () => {
    const n = calls.length;
    const res = await fetch(base + '/api/billing/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: 'pro' }),
    });
    assert.equal(res.status, 401);
    assert.deepEqual(callsSince(n), []);
  });

  test('checkout is bound to the session org, never to an org named by the caller', async () => {
    setPlan(ORG_A, { plan: 'pro', subscriptionStatus: 'active', customerId: 'cus_a', comped: false });
    setPlan(ORG_B, { plan: 'free', customerId: null, comped: false });
    actAs('g-owner-b');
    const n = calls.length;
    // Owner B asks for Pro while naming org A in the body. The body field is
    // ignored: the org comes from the session, so this is B's own free -> pro.
    const res = await post('/api/billing/checkout', { plan: 'pro', orgId: ORG_A });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const sent = callsSince(n).find((c) => c.call === 'checkout.sessions.create');
    assert.equal(sent.metadata.orgId, ORG_B, 'the caller must not be able to bill another tenant');
    assert.notEqual(sent.metadata.orgId, ORG_A);
  });
});

describe('portal: only an org with a real Stripe customer can open one', () => {
  test('a free org with no customer is refused NO_CUSTOMER, not sent to a broken portal', async () => {
    actAs('g-owner-a');
    setPlan(ORG_A, { plan: 'free', customerId: null, comped: false });
    const n = calls.length;
    const res = await post('/api/billing/portal', {});
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'NO_CUSTOMER');
    assert.deepEqual(callsSince(n), []);
  });

  test('a comped paid org has no customer either, and is refused the same way', async () => {
    actAs('g-owner-a');
    setPlan(ORG_A, { plan: 'pro', subscriptionStatus: null, customerId: null, comped: true });
    const n = calls.length;
    const res = await post('/api/billing/portal', {});
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'NO_CUSTOMER',
      'being on a paid tier is not the same as having something to manage');
    assert.deepEqual(callsSince(n), []);
  });

  test('a paying org opens a portal against its OWN customer id', async () => {
    setPlan(ORG_A, { plan: 'pro', subscriptionStatus: 'active', customerId: 'cus_for_a', comped: false });
    setPlan(ORG_B, { plan: 'pro', subscriptionStatus: 'active', customerId: 'cus_for_b', comped: false });
    actAs('g-owner-b');
    const n = calls.length;
    const res = await post('/api/billing/portal', {});
    assert.equal(res.status, 200);
    const sent = callsSince(n).find((c) => c.call === 'billingPortal.sessions.create');
    assert.equal(sent.customer, 'cus_for_b');
    assert.notEqual(sent.customer, 'cus_for_a', 'tenant isolation on the portal too');
  });

  test('a member cannot open the portal', async () => {
    setPlan(ORG_A, { plan: 'team', subscriptionStatus: 'active', customerId: 'cus_for_a', comped: false });
    actAs('g-member-a');
    const n = calls.length;
    const res = await post('/api/billing/portal', {});
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'OWNER_REQUIRED');
    assert.deepEqual(callsSince(n), []);
  });

  test('a past_due org still reaches the portal — that is the whole recovery path', async () => {
    setPlan(ORG_A, { plan: 'pro', subscriptionStatus: 'past_due', customerId: 'cus_for_a', comped: false });
    actAs('g-owner-a');
    const n = calls.length;
    const res = await post('/api/billing/portal', {});
    assert.equal(res.status, 200);
    assert.ok(res.body.url, 'a locked-out customer must be able to fix their card');
    const sent = callsSince(n).find((c) => c.call === 'billingPortal.sessions.create');
    assert.equal(sent.customer, 'cus_for_a');
  });
});

describe('the stub is actually wired (guards against vacuous "nothing was sent")', () => {
  test('a successful call does appear in the log', () => {
    assert.ok(stripeCalls().some((c) => c.call === 'checkout.sessions.create'));
    assert.ok(stripeCalls().some((c) => c.call === 'billingPortal.sessions.create'));
  });
});
