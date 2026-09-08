'use strict';

/**
 * src/routes/readOnlyAccess.test.js — what "read-only" means over HTTP.
 *
 * The entitlement mapping is unit-tested in services/entitlements.test.js. This
 * file asserts the part that only shows up wired together: that a paused
 * account can still READ everything it owns, cannot WRITE anything, and — the
 * one that would otherwise be found by a customer — can still reach the billing
 * portal, which is the only way out of the pause.
 *
 * Mounted exactly as src/index.js mounts them, middleware order included,
 * because the order is load-bearing: requireWriteAccess reads req.orgId and
 * would silently pass everything through if it ran before requireSession.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cvs-readonly-'));
process.env.DATABASE_PATH = path.join(TMP_DIR, 'test.db');
process.env.STRIPE_SECRET_KEY = 'sk_test_stub_ro';
process.env.STRIPE_PRICE_PRO = 'price_stub_pro';
process.env.STRIPE_PRICE_TEAM = 'price_stub_team';

const fakeStripe = () => ({
  customers: { create: async () => ({ id: 'cus_ro' }) },
  checkout: { sessions: { create: async () => ({ id: 'cs', url: 'https://checkout.stripe.com/stub' }) } },
  billingPortal: { sessions: { create: async () => ({ url: 'https://billing.stripe.com/p/stub' }) } },
  subscriptions: { retrieve: async (id) => ({ id, status: 'paused', items: { data: [] } }), list: async () => ({ data: [] }) },
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
const { requireSession } = require('../middleware/auth');
const { requireWriteAccess } = require('../middleware/requireWriteAccess');
const auditRouter = require('./audit');
const templatesRouter = require('./templates');
const orgRouter = require('./org');
const billingRouter = require('./billing');

let server; let base; let token; let orgId;

before(async () => {
  db.getDb();
  const org = auth.createOrganization('Paused Agency BV');
  orgId = org.id;
  const user = auth.createUser({
    email: 'owner@paused.test',
    passwordHash: await auth.hashPassword('CorrectHorseBattery1!'),
    orgId,
    role: 'owner',
  });
  token = auth.createSession(user.id).rawToken;

  const app = express();
  app.use(express.json());
  // Same order as src/index.js.
  app.use('/api/audit', requireSession, requireWriteAccess, auditRouter);
  app.use('/api/templates', requireSession, requireWriteAccess, templatesRouter);
  app.use('/api/org', orgRouter);
  app.use('/api/billing', billingRouter); // deliberately NOT gated
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
  method,
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

function setStatus(status, plan = 'pro') {
  db.setOrgPlan(orgId, { plan, subscriptionStatus: status, currentPeriodEnd: null });
}

describe('a trialing account writes normally', () => {
  before(() => setStatus('trialing'));

  test('a template can be created', async () => {
    const res = await call('POST', '/api/templates', { name: 'Trial template', role: 'Recruiter' });
    assert.ok(res.status < 400, `expected success, got ${res.status}`);
  });

  test('the audit log accepts nothing it should not, but is not entitlement-blocked', async () => {
    const res = await call('POST', '/api/audit', {});
    assert.notEqual(res.status, 402, 'refused on its own merits, not on entitlement');
  });
});

describe('a paused account is read-only', () => {
  before(() => setStatus('paused'));

  test('reads still work', async () => {
    for (const url of ['/api/templates', '/api/audit', '/api/audit/roles']) {
      const res = await call('GET', url);
      assert.ok(res.status < 400, `${url} should still be readable (got ${res.status})`);
    }
  });

  test('every write is refused with 402 SUBSCRIPTION_PAUSED', async () => {
    const writes = [
      ['POST', '/api/templates', { name: 'Nope', role: 'X' }],
      ['PATCH', '/api/templates/anything', { name: 'Nope' }],
      ['DELETE', '/api/templates/anything', null],
      ['POST', '/api/audit', { candidateName: 'X' }],
      ['PATCH', '/api/audit/anything', { decision: 'hire' }],
      ['DELETE', '/api/audit/anything', null],
    ];
    for (const [method, url, body] of writes) {
      const res = await call(method, url, body);
      assert.equal(res.status, 402, `${method} ${url}`);
      const payload = await res.json();
      assert.equal(payload.code, 'SUBSCRIPTION_PAUSED');
      assert.equal(payload.entitlement, 'read_only');
      assert.match(payload.error, /data is intact/i, 'the refusal says nothing was deleted');
    }
  });

  test('the org routes that authenticate per-route are gated too', async () => {
    const res = await call('PATCH', '/api/org', { name: 'Renamed' });
    assert.equal(res.status, 402);
    assert.equal((await res.json()).code, 'SUBSCRIPTION_PAUSED');
  });

  test('and nothing was deleted', () => {
    const templates = db.getDb().prepare('SELECT COUNT(*) AS n FROM templates WHERE org_id = ?').get(orgId);
    assert.ok(templates.n >= 1, 'the template written during the trial is still there');
    assert.ok(auth.getOrganizationById(orgId), 'the organization still exists');
    assert.equal(db.getOrgBilling(orgId).plan, 'pro', 'and it still holds its plan');
  });

  test('THE BILLING PORTAL STAYS REACHABLE — it is the only way out', async () => {
    db.setOrgStripeCustomerId(orgId, 'cus_ro');
    const res = await call('POST', '/api/billing/portal');
    assert.equal(res.status, 200, 'gating this would lock the customer away from the fix');
    assert.match((await res.json()).url, /^https:\/\/billing\.stripe\.com\//);
  });

  test('reading the plan panel still works, so the UI can explain the state', async () => {
    const res = await call('GET', '/api/billing/plan-summary');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.subscriptionStatus, 'paused');
  });
});

describe('restoring the subscription restores writes', () => {
  test('an org moved back to active can write again', async () => {
    setStatus('active');
    const res = await call('POST', '/api/templates', { name: 'Back in business', role: 'Recruiter' });
    assert.ok(res.status < 400, `expected success, got ${res.status}`);
  });

  test('a free org is never gated', async () => {
    setStatus(null, 'free');
    const res = await call('POST', '/api/templates', { name: 'Free tier template', role: 'Recruiter' });
    assert.ok(res.status < 400, 'Free is a product we ship, not a lockout');
  });

  test('a churned org falls back to Free rather than being locked out', async () => {
    setStatus('canceled', 'free');
    const res = await call('POST', '/api/templates', { name: 'After churn', role: 'Recruiter' });
    assert.ok(res.status < 400, 'docs/billing/README.md: the org returns to Free and the cap resumes');
  });
});
