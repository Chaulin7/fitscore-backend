'use strict';

/**
 * src/routes/planSummary.test.js
 *
 * GET /api/billing/plan-summary — the payload behind the topbar plan panel.
 *
 * The panel is a place a customer reads their entitlements and decides whether
 * to spend money, so the risks worth pinning here are about TRUTH rather than
 * rendering:
 *
 *   1. What a tier GAINS must come from the axes the server gates on, not from
 *      the marketing copy next to them. `highlights` is prose; if the upgrade
 *      list were derived by diffing those strings, rewording one would silently
 *      empty or corrupt the list on the surface that sells the upgrade. There
 *      is a test below that rewords every highlight and asserts the computed
 *      gains do not move.
 *   2. A comped org is fully entitled with no subscription behind it. Offering
 *      it checkout would attach a real paid subscription to an account that is
 *      deliberately not paying.
 *   3. "Cannot manage billing" has three distinct causes and the panel says
 *      something different for each, so the reason travels with the flag.
 *   4. Org scoping: one tenant's session must never read another's plan.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

// Before services/db is first required — it reads DATABASE_PATH at module load.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cvs-plansum-'));
process.env.DATABASE_PATH = path.join(TMP_DIR, 'test.db');

// A key makes isBillingConfigured() true, which is what production looks like.
// The Stripe client is constructed lazily and nothing here calls out to it —
// no request is ever made. Without this every owner would come back as
// BILLING_NOT_CONFIGURED and the interesting states would be unreachable; the
// unconfigured branch gets its own test below, which unsets it deliberately.
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_stub_plansummary';

const express = require('express');
const db = require('../services/db');
const auth = require('../services/authService');
const billingRouter = require('../routes/billing');
const billingSvc = require('../services/billing');
const { PLANS } = require('../config/plans');

const ORG_A = 'org-a';
const ORG_B = 'org-b';

let app;
let token; // whichever session the current test is acting as

// The router declares requireSession on every route, so these tests mint REAL
// sessions rather than standing in for the middleware. That is the stricter
// choice and it caught a real constraint: requireSession also enforces the seat
// gate, so a non-owner member only has a live session while their org holds an
// active Team plan. The member cases below are written on Team for that reason
// — on Free or Pro a member is stopped before the handler ever runs.
const TOKENS = {};

before(() => {
  db.getDb();

  const now = new Date().toISOString();
  const insertOrg = db.getDb().prepare(
    'INSERT INTO organizations (id, name, created_at) VALUES (?, ?, ?)',
  );
  insertOrg.run(ORG_A, 'Acme', now);
  insertOrg.run(ORG_B, 'Beta', now);

  const insertUser = db.getDb().prepare(
    'INSERT INTO users (id, org_id, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  insertUser.run('user-a', ORG_A, 'owner@acme.example', 'x', 'owner', now);
  insertUser.run('member-a', ORG_A, 'member@acme.example', 'x', 'member', now);
  insertUser.run('user-b', ORG_B, 'owner@beta.example', 'x', 'owner', now);

  TOKENS['user-a'] = auth.createSession('user-a').rawToken;
  TOKENS['member-a'] = auth.createSession('member-a').rawToken;
  TOKENS['user-b'] = auth.createSession('user-b').rawToken;
  token = TOKENS['user-a'];

  app = express();
  app.use(express.json());
  app.use('/api/billing', billingRouter);
});

function actAs(userId) { token = TOKENS[userId]; }

after(() => {
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}
});

let server; let base;
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { try { server.close(); } catch (_) {} });

async function summary() {
  const res = await fetch(`${base}/api/billing/plan-summary`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: await res.json() };
}

function setPlan(orgId, fields) {
  db.setOrgPlan(orgId, {
    plan: fields.plan,
    subscriptionStatus: fields.subscriptionStatus || null,
    currentPeriodEnd: fields.currentPeriodEnd || null,
  });
  if ('customerId' in fields) db.setOrgStripeCustomerId(orgId, fields.customerId);
  if ('comped' in fields) {
    db.getDb().prepare('UPDATE organizations SET comped = ? WHERE id = ?')
      .run(fields.comped ? 1 : 0, orgId);
  }
}

describe('plan-summary: tier identification', () => {
  test('a brand-new org reports free, with the free quota as its limit', async () => {
    actAs('user-a');
    setPlan(ORG_A, { plan: 'free', comped: false, customerId: null });
    const { status, body } = await summary();
    assert.equal(status, 200);
    assert.equal(body.plan, 'free');
    assert.equal(body.planName, 'Free');
    assert.equal(body.usage.analyses.limit, billingSvc.FREE_MONTHLY_LIMIT);
    assert.equal(body.usage.seats.limit, 1);
  });

  test('a Pro org reports pro, unlimited analyses and a single seat', async () => {
    setPlan(ORG_A, { plan: 'pro', subscriptionStatus: 'active', customerId: 'cus_a' });
    const { body } = await summary();
    assert.equal(body.plan, 'pro');
    assert.equal(body.usage.analyses.limit, null, 'null = unlimited');
    assert.equal(body.usage.seats.limit, 1);
  });

  test('a Team org reports team and the seat cap from the enforcement source', async () => {
    setPlan(ORG_A, { plan: 'team', subscriptionStatus: 'active', customerId: 'cus_a' });
    const { body } = await summary();
    assert.equal(body.plan, 'team');
    assert.equal(body.usage.analyses.limit, null);
    // TEAM_MAX_MEMBERS is 0 (unlimited) unless configured; the endpoint must
    // publish the enforced cap, never the 'multiple' display string.
    assert.equal(body.usage.seats.limit, billingSvc.TEAM_MAX_MEMBERS || null);
    assert.notEqual(body.usage.seats.limit, 'multiple');
  });

  test('usage counts are the real per-period counters, scoped to the org', async () => {
    setPlan(ORG_A, { plan: 'free', customerId: null });
    db.incrementUsage(ORG_A, 3);
    const { body } = await summary();
    assert.equal(body.usage.analyses.used, 3);
    assert.equal(body.usage.seats.used, 2, 'ORG_A has an owner and a member');
  });
});

describe('plan-summary: upgrade targets', () => {
  before(() => { actAs('user-a'); });

  test('free is offered both paid tiers, in ascending order', async () => {
    setPlan(ORG_A, { plan: 'free', comped: false, customerId: null });
    const { body } = await summary();
    assert.deepEqual(body.upgrades.map((u) => u.id), ['pro', 'team']);
    assert.deepEqual(body.upgrades.map((u) => u.plan), ['pro', 'team']);
  });

  test('pro is offered team only', async () => {
    setPlan(ORG_A, { plan: 'pro', subscriptionStatus: 'active', customerId: 'cus_a' });
    const { body } = await summary();
    assert.deepEqual(body.upgrades.map((u) => u.id), ['team']);
  });

  test('team is offered nothing — the empty list is what hides the section', async () => {
    setPlan(ORG_A, { plan: 'team', subscriptionStatus: 'active', customerId: 'cus_a' });
    const { body } = await summary();
    assert.deepEqual(body.upgrades, []);
  });

  test('gains are the enforced differences, not the whole feature list', async () => {
    setPlan(ORG_A, { plan: 'pro', subscriptionStatus: 'active', customerId: 'cus_a' });
    const { body } = await summary();
    const team = body.upgrades.find((u) => u.id === 'team');
    assert.deepEqual(team.gains.map((g) => g.axis), ['seats'],
      'Pro already has unlimited analyses and white-label, so only seats is a gain');
  });

  test('free -> pro gains volume and branding but NOT seats (both are single-user)', async () => {
    setPlan(ORG_A, { plan: 'free', comped: false, customerId: null });
    const { body } = await summary();
    const pro = body.upgrades.find((u) => u.id === 'pro');
    assert.deepEqual(pro.gains.map((g) => g.axis), ['analysesPerMonth', 'customBranding']);
    const team = body.upgrades.find((u) => u.id === 'team');
    assert.deepEqual(team.gains.map((g) => g.axis), ['analysesPerMonth', 'seats', 'customBranding']);
  });

  test('every gain carries a human label alongside the machine axis', async () => {
    setPlan(ORG_A, { plan: 'free', comped: false, customerId: null });
    const { body } = await summary();
    for (const u of body.upgrades) {
      for (const g of u.gains) {
        assert.ok(g.label && typeof g.label === 'string', `${u.id}/${g.axis} has no label`);
        assert.ok('from' in g && 'to' in g, 'the axis values are the computed answer');
      }
    }
  });
});

describe('gains survive a rewording of the marketing copy', () => {
  /**
   * The property this whole design exists for.
   *
   * `highlights` is prose that a non-engineer may reasonably reword. If gains
   * were a set difference over those strings, this edit would change the
   * upgrade surface — most likely to an empty list, which reads as "upgrading
   * gets you nothing". Here every highlight on every tier is replaced with
   * unrecognisable text and the computed axes must not move.
   */
  test('rewriting every highlight leaves the computed gains identical', () => {
    const before = {
      freePro: billingSvc.gainsBetween('free', 'pro'),
      freeTeam: billingSvc.gainsBetween('free', 'team'),
      proTeam: billingSvc.gainsBetween('pro', 'team'),
    };

    const originals = PLANS.tiers.map((t) => t.highlights);
    try {
      PLANS.tiers.forEach((t, i) => {
        t.highlights = [`totally different copy ${i}`, 'another rewrite', 'third string'];
      });
      assert.deepEqual(billingSvc.gainsBetween('free', 'pro'), before.freePro);
      assert.deepEqual(billingSvc.gainsBetween('free', 'team'), before.freeTeam);
      assert.deepEqual(billingSvc.gainsBetween('pro', 'team'), before.proTeam);
    } finally {
      PLANS.tiers.forEach((t, i) => { t.highlights = originals[i]; });
    }
  });

  test('gains are still non-empty for a real upgrade (guards a vacuous pass)', () => {
    assert.ok(billingSvc.gainsBetween('free', 'pro').length > 0);
    assert.deepEqual(billingSvc.gainsBetween('team', 'pro'), [], 'a downgrade gains nothing');
    assert.deepEqual(billingSvc.gainsBetween('pro', 'pro'), [], 'same tier gains nothing');
  });
});

describe('plan-summary: who may act', () => {
  test('an owner on a paid plan with a customer may manage billing', async () => {
    actAs('user-a');
    setPlan(ORG_A, { plan: 'pro', subscriptionStatus: 'active', customerId: 'cus_a', comped: false });
    const { body } = await summary();
    assert.equal(body.isOwner, true);
    assert.equal(body.canManageBilling, true);
    assert.equal(body.billingBlockReason, null);
  });

  // On Team, because requireSession's seat gate only lets a non-owner hold a
  // live session while the org has an active Team plan. A member on Pro never
  // reaches this handler at all — they are stopped with SEAT_LIMIT upstream.
  test('a member is blocked with NOT_OWNER, which is not the same as having no customer', async () => {
    actAs('member-a');
    setPlan(ORG_A, { plan: 'team', subscriptionStatus: 'active', customerId: 'cus_a', comped: false });
    const { status, body } = await summary();
    assert.equal(status, 200);
    assert.equal(body.isOwner, false);
    assert.equal(body.canManageBilling, false);
    assert.equal(body.billingBlockReason, 'NOT_OWNER');
    assert.equal(body.canUpgrade, false, 'a member must not get a CTA that will 403');
    // The member still sees the plan itself — being unable to change it is not
    // a reason to be unable to see it.
    assert.equal(body.plan, 'team');
    assert.ok(body.entitlements.length > 0);
  });

  test('the NOT_OWNER block is about role, not about a missing customer', async () => {
    actAs('member-a');
    setPlan(ORG_A, { plan: 'team', subscriptionStatus: 'active', customerId: 'cus_a', comped: false });
    const member = (await summary()).body;
    actAs('user-a');
    const owner = (await summary()).body;
    // Same org, same Stripe customer, same tier — only the role differs.
    assert.equal(member.billingBlockReason, 'NOT_OWNER');
    assert.equal(owner.billingBlockReason, null);
    assert.equal(owner.canManageBilling, true);
  });

  test('an owner on free is blocked with NO_CUSTOMER, and gets no portal button', async () => {
    actAs('user-a');
    setPlan(ORG_A, { plan: 'free', customerId: null, comped: false });
    const { body } = await summary();
    assert.equal(body.canManageBilling, false);
    assert.equal(body.billingBlockReason, 'NO_CUSTOMER');
    assert.equal(body.canUpgrade, true, 'a free owner may still buy');
  });

  test('a deployment without Stripe configured says so rather than blaming the user', async () => {
    actAs('user-a');
    setPlan(ORG_A, { plan: 'pro', subscriptionStatus: 'active', customerId: 'cus_a', comped: false });
    const key = process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_SECRET_KEY;
    try {
      const { body } = await summary();
      assert.equal(body.billingConfigured, false);
      assert.equal(body.canManageBilling, false);
      assert.equal(body.billingBlockReason, 'BILLING_NOT_CONFIGURED');
      assert.equal(body.canUpgrade, false, 'no point offering checkout with no Stripe');
    } finally { process.env.STRIPE_SECRET_KEY = key; }
  });
});

describe('plan-summary: comped orgs', () => {
  before(() => { actAs('user-a'); });
  after(() => setPlan(ORG_A, { plan: 'free', comped: false, customerId: null }));

  test('a comped paid org reports comped and cannot manage billing', async () => {
    setPlan(ORG_A, { plan: 'pro', subscriptionStatus: null, customerId: null, comped: true });
    const { body } = await summary();
    assert.equal(body.plan, 'pro', 'entitlement is real even with no subscription');
    assert.equal(body.comped, true);
    assert.equal(body.canManageBilling, false);
    assert.equal(body.billingBlockReason, 'COMPED');
  });

  test('a comped org is offered no upgrades at all', async () => {
    setPlan(ORG_A, { plan: 'pro', subscriptionStatus: null, customerId: null, comped: true });
    const { body } = await summary();
    assert.deepEqual(body.upgrades, [],
      'checkout would attach a real subscription to an account that should not have one');
    assert.equal(body.canUpgrade, false);
  });

  test('a comped FREE org is likewise offered nothing', async () => {
    setPlan(ORG_A, { plan: 'free', customerId: null, comped: true });
    const { body } = await summary();
    assert.deepEqual(body.upgrades, []);
    assert.equal(body.canUpgrade, false);
  });

  test('clearing the flag restores the upgrade offer (guards a stuck-off test)', async () => {
    setPlan(ORG_A, { plan: 'free', customerId: null, comped: false });
    const { body } = await summary();
    assert.deepEqual(body.upgrades.map((u) => u.id), ['pro', 'team']);
  });
});

describe('plan-summary: tenant isolation', () => {
  test('a session for org B never reads org A plan state', async () => {
    setPlan(ORG_A, { plan: 'team', subscriptionStatus: 'active', customerId: 'cus_a', comped: false });
    setPlan(ORG_B, { plan: 'free', customerId: null, comped: false });

    actAs('user-b');
    const b = (await summary()).body;
    assert.equal(b.plan, 'free', 'org B is free regardless of what org A is on');
    assert.equal(b.usage.seats.used, 1, 'org B has one user; org A has two');

    actAs('user-a');
    const a = (await summary()).body;
    assert.equal(a.plan, 'team');
  });

  test('usage counters do not leak across orgs', async () => {
    db.incrementUsage(ORG_B, 7);
    actAs('user-b');
    const b = (await summary()).body;
    actAs('user-a');
    const a = (await summary()).body;
    assert.notEqual(a.usage.analyses.used, b.usage.analyses.used);
    assert.equal(b.usage.analyses.used, 7);
  });
});

describe('plan-summary: unauthenticated', () => {
  let realApp; let realServer; let realBase;

  before(async () => {
    // The REAL requireSession, not the stand-in above.
    realApp = express();
    realApp.use(express.json());
    realApp.use('/api/billing', billingRouter);
    realServer = realApp.listen(0);
    await new Promise((r) => realServer.once('listening', r));
    realBase = `http://127.0.0.1:${realServer.address().port}`;
  });
  after(() => { try { realServer.close(); } catch (_) {} });

  test('no token is 401 AUTH_REQUIRED, not an empty free-plan payload', async () => {
    const res = await fetch(`${realBase}/api/billing/plan-summary`);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.code, 'AUTH_REQUIRED');
    assert.ok(!('plan' in body), 'an unauthenticated caller learns nothing about any tenant');
  });

  test('a garbage bearer token is also 401', async () => {
    const res = await fetch(`${realBase}/api/billing/plan-summary`, {
      headers: { Authorization: 'Bearer not-a-real-token' },
    });
    assert.equal(res.status, 401);
  });
});
