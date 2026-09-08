'use strict';

/**
 * src/routes/trialStart.test.js — minting a trial token, and spending it.
 *
 * Covers the two ends of the entry point: POST /admin/trial-invites (operator
 * only, 404 to everyone else) and GET /start (public, the token is the whole
 * credential).
 *
 * The Stripe session's parameters are asserted as SENT, not as a response we
 * invented: the stub records the object the route handed the SDK, and the
 * assertions read that. trial_period_days, the pause end-behaviour and
 * payment_method_collection are the three fields the feature IS — get any one
 * of them wrong and the trial either charges a card, cancels on day 30, or
 * never starts — so each is pinned individually rather than as a snapshot.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cvs-trial-start-'));
process.env.DATABASE_PATH = path.join(TMP_DIR, 'test.db');
process.env.STRIPE_SECRET_KEY = 'sk_test_stub_trial';
process.env.STRIPE_PRICE_PRO = 'price_stub_pro';
process.env.STRIPE_PRICE_TEAM = 'price_stub_team';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_stub';
process.env.PUBLIC_APP_URL = 'https://cvsprings.test';
process.env.ADMIN_OWNER_EMAIL = 'operator@cvsprings.test';

// --- Stripe stub ------------------------------------------------------------
const calls = [];
const CUSTOMERS = new Map();
let customerSeq = 0;

const fakeStripe = () => ({
  customers: {
    create: async (p) => {
      const id = `cus_trial_${++customerSeq}`;
      CUSTOMERS.set(id, { id, ...p });
      calls.push({ call: 'customers.create', email: p.email, name: p.name, metadata: p.metadata, id });
      return { id };
    },
    retrieve: async (id) => CUSTOMERS.get(id) || { id, invoice_settings: {} },
    update: async (id, p) => ({ id, ...p }),
  },
  checkout: {
    sessions: {
      create: async (p) => {
        calls.push({ call: 'checkout.sessions.create', params: p });
        return { id: 'cs_trial', url: 'https://checkout.stripe.com/c/pay/trial_stub' };
      },
    },
  },
  billingPortal: { sessions: { create: async (p) => ({ url: 'https://billing.stripe.com/p/stub' }) } },
  subscriptions: {
    retrieve: async (id) => ({ id, status: 'trialing', items: { data: [] } }),
    list: async () => ({ data: [] }),
    cancel: async (id) => ({ id, status: 'canceled' }),
    update: async (id, p) => ({ id, ...p }),
  },
  webhooks: { constructEvent: (buf) => JSON.parse(buf.toString('utf8')) },
});
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'stripe') return fakeStripe;
  return origLoad.call(this, request, parent, isMain);
};

const express = require('express');
const db = require('./../services/db');
const auth = require('./../services/authService');
const trialStartRouter = require('./trialStart');
const adminTrialInvitesRouter = require('./adminTrialInvites');
const billingRouter = require('./billing');

let server; let base; let operatorToken; let memberToken;

before(async () => {
  db.getDb();

  // The platform operator, who alone may mint invites.
  const opOrg = auth.createOrganization('Joyaco BV');
  const operator = auth.createUser({
    email: 'operator@cvsprings.test',
    passwordHash: await auth.hashPassword('CorrectHorseBattery1!'),
    orgId: opOrg.id,
    role: 'owner',
  });
  operatorToken = auth.createSession(operator.id).rawToken;

  // An ordinary owner of another org, who may not.
  const otherOrg = auth.createOrganization('Someone Else BV');
  const other = auth.createUser({
    email: 'nobody@example.com',
    passwordHash: await auth.hashPassword('CorrectHorseBattery1!'),
    orgId: otherOrg.id,
    role: 'owner',
  });
  memberToken = auth.createSession(other.id).rawToken;

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

beforeEach(() => { calls.length = 0; });

function mint(body, token = operatorToken) {
  return fetch(base + '/admin/trial-invites', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

const startRaw = (qs) => fetch(base + '/start' + qs, { redirect: 'manual' });
const lastSession = () => calls.filter((c) => c.call === 'checkout.sessions.create').pop();

let clock = Math.floor(Date.now() / 1000);
async function webhook(type, object) {
  clock += 1;
  return fetch(base + '/api/billing/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': 'stub' },
    body: JSON.stringify({ id: 'evt_' + clock, type, created: clock, data: { object } }),
  });
}

describe('POST /admin/trial-invites', () => {
  test('the operator gets tokens and full URLs back', async () => {
    const res = await mint({
      invites: [
        { email: 'lead@alpha.test', company_name: 'Alpha Recruitment', campaign: 'q1-agencies' },
        { email: 'lead@beta.test', company_name: 'Beta Search', campaign: 'q1-agencies' },
      ],
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.count, 2);
    assert.equal(body.trialPeriodDays, 30);
    assert.equal(body.invites.length, 2);
    for (const invite of body.invites) {
      assert.match(invite.token, /^[0-9a-f-]{36}$/);
      assert.equal(invite.url, `https://cvsprings.test/start?t=${invite.token}`,
        'the URL is built from PUBLIC_APP_URL, never from the request host');
      assert.equal(invite.campaign, 'q1-agencies');
    }
  });

  test('expiry defaults to 30 days out and is overridable', async () => {
    const dflt = await (await mint({ invites: [{ email: 'a@x.test' }] })).json();
    const days = Math.round((Date.parse(dflt.expiresAt) - Date.now()) / 86400000);
    assert.equal(days, 30);

    const custom = await (await mint({ invites: [{ email: 'b@x.test' }], expiresInDays: 7 })).json();
    assert.equal(Math.round((Date.parse(custom.expiresAt) - Date.now()) / 86400000), 7);

    const explicit = await (await mint({ invites: [{ email: 'c@x.test' }], expiresAt: '2027-01-01T00:00:00.000Z' })).json();
    assert.equal(explicit.expiresAt, '2027-01-01T00:00:00.000Z');
  });

  test('a bare array body works too', async () => {
    const res = await mint([{ email: 'array@x.test', company_name: 'Array Co' }]);
    assert.equal(res.status, 201);
    assert.equal((await res.json()).count, 1);
  });

  test('a bad address rejects the batch and lists every problem', async () => {
    const res = await mint({ invites: [{ email: 'ok@x.test' }, { email: 'nope' }] });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, 'VALIDATION_ERROR');
    assert.ok(Array.isArray(body.errors));
    assert.match(body.errors[0], /invites\[1\]/);
  });

  test('a non-operator gets the catch-all 404, not a 403', async () => {
    // A 403 here would confirm the endpoint exists to anyone with any session.
    const res = await mint({ invites: [{ email: 'x@x.test' }] }, memberToken);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.deepEqual(body, { error: 'Not found', code: 'NOT_FOUND', path: '/admin/trial-invites' });
  });

  test('an unauthenticated caller gets the same 404', async () => {
    const res = await mint({ invites: [{ email: 'x@x.test' }] }, null);
    assert.equal(res.status, 404);
    assert.equal((await res.json()).code, 'NOT_FOUND');
  });
});

describe('GET /start — a valid token', () => {
  let invite;

  before(async () => {
    const body = await (await mint({
      invites: [{ email: 'founder@gamma.test', company_name: 'Gamma Recruitment', campaign: 'q1-agencies' }],
    })).json();
    [invite] = body.invites;
  });

  test('redirects to Stripe Checkout', async () => {
    const res = await startRaw(`?t=${invite.token}`);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), 'https://checkout.stripe.com/c/pay/trial_stub');
  });

  test('the session is a 30-day no-card trial that PAUSES at the end', async () => {
    await startRaw(`?t=${invite.token}`);
    const { params } = lastSession();
    assert.equal(params.mode, 'subscription');
    assert.equal(params.subscription_data.trial_period_days, 30);
    assert.deepEqual(params.subscription_data.trial_settings,
      { end_behavior: { missing_payment_method: 'pause' } });
    assert.equal(params.payment_method_collection, 'if_required',
      'without this Checkout still asks for a card and it is not a no-card trial');
  });

  test('metadata carries the token, campaign and plan — on the session AND the subscription', async () => {
    await startRaw(`?t=${invite.token}`);
    const { params } = lastSession();
    for (const md of [params.metadata, params.subscription_data.metadata]) {
      assert.equal(md.trial_token, invite.token);
      assert.equal(md.campaign, 'q1-agencies');
      assert.equal(md.plan, 'pro');
      assert.ok(md.orgId, 'and the org every webhook resolves against');
    }
  });

  test('it defaults to Pro', async () => {
    await startRaw(`?t=${invite.token}`);
    assert.equal(lastSession().params.line_items[0].price, 'price_stub_pro');
  });

  test('?plan=team opens the Team price instead', async () => {
    const body = await (await mint({ invites: [{ email: 'team@delta.test', company_name: 'Delta', campaign: 'q1' }] })).json();
    await startRaw(`?t=${body.invites[0].token}&plan=team`);
    const { params } = lastSession();
    assert.equal(params.line_items[0].price, 'price_stub_team');
    assert.equal(params.metadata.plan, 'team');
  });

  test('an unrecognised ?plan falls back to Pro rather than failing', async () => {
    const body = await (await mint({ invites: [{ email: 'weird@eps.test' }] })).json();
    await startRaw(`?t=${body.invites[0].token}&plan=enterprise`);
    assert.equal(lastSession().params.line_items[0].price, 'price_stub_pro');
  });

  test('Stripe Tax and VAT ID collection stay on, EUR 0 first invoice notwithstanding', async () => {
    const body = await (await mint({ invites: [{ email: 'vat@zeta.test', company_name: 'Zeta BV' }] })).json();
    await startRaw(`?t=${body.invites[0].token}`);
    const { params } = lastSession();
    assert.deepEqual(params.automatic_tax, { enabled: true });
    assert.deepEqual(params.tax_id_collection, { enabled: true });
    // The field only appears when Stripe has a country to validate against, and
    // it normally infers one from the payment method — which this session does
    // not collect. Without this, VAT collection silently does nothing here.
    assert.equal(params.billing_address_collection, 'required');
    assert.deepEqual(params.customer_update, { address: 'auto', name: 'auto' });
  });

  test('nothing overrides the invoice legal entity', async () => {
    // Joyaco BV is the Stripe account's own entity. It stays that way precisely
    // because the session names no other one; this asserts the absence, since
    // that is how the constraint would be broken.
    await startRaw(`?t=${invite.token}`);
    const { params } = lastSession();
    for (const key of ['on_behalf_of', 'transfer_data', 'application_fee_amount', 'stripeAccount']) {
      assert.equal(params[key], undefined, `${key} must not be set`);
    }
  });

  test('an organization and a Stripe customer are reserved for the prospect', async () => {
    const stored = db.findTrialInviteByToken(invite.token);
    assert.ok(stored.orgId, 'the invite now points at an org');
    assert.ok(stored.stripeCustomerId, 'and at a Stripe customer');
    assert.equal(stored.redeemedAt, null, 'but the token is NOT spent until checkout completes');

    const org = auth.getOrganizationById(stored.orgId);
    assert.equal(org.name, 'Gamma Recruitment', 'named from the invite');
    assert.equal(db.getOrgTrial(stored.orgId).campaign, 'q1-agencies');
  });

  test('a second click reuses the same org and customer rather than making more', async () => {
    const before = db.findTrialInviteByToken(invite.token);
    const customersBefore = calls.filter((c) => c.call === 'customers.create').length;
    await startRaw(`?t=${invite.token}`);
    const after = db.findTrialInviteByToken(invite.token);
    assert.equal(after.orgId, before.orgId);
    assert.equal(after.stripeCustomerId, before.stripeCustomerId);
    assert.equal(calls.filter((c) => c.call === 'customers.create').length, customersBefore,
      'no second Stripe customer');
  });
});

describe('GET /start — the token is spent by checkout.session.completed', () => {
  test('redeemed_at is set from metadata.trial_token', async () => {
    const body = await (await mint({
      invites: [{ email: 'redeem@eta.test', company_name: 'Eta BV', campaign: 'q2-outbound' }],
    })).json();
    const [inv] = body.invites;
    await startRaw(`?t=${inv.token}`);
    const target = db.findTrialInviteByToken(inv.token);
    assert.equal(target.redeemedAt, null);

    await webhook('checkout.session.completed', {
      id: 'cs_1',
      customer: target.stripeCustomerId,
      subscription: 'sub_eta',
      metadata: { orgId: target.orgId, plan: 'pro', trial_token: inv.token, campaign: 'q2-outbound' },
    });

    const after = db.findTrialInviteByToken(inv.token);
    assert.ok(after.redeemedAt, 'the token is now spent');
    assert.equal(after.orgId, target.orgId);
    assert.equal(db.getOrgTrial(target.orgId).campaign, 'q2-outbound');
  });

  test('a spent token is refused on a second visit', async () => {
    const body = await (await mint({ invites: [{ email: 'once@theta.test' }] })).json();
    const [inv] = body.invites;
    await startRaw(`?t=${inv.token}`);
    const target = db.findTrialInviteByToken(inv.token);
    await webhook('checkout.session.completed', {
      id: 'cs_2', customer: target.stripeCustomerId, subscription: 'sub_theta',
      metadata: { orgId: target.orgId, plan: 'pro', trial_token: inv.token },
    });

    calls.length = 0;
    const res = await startRaw(`?t=${inv.token}`);
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location'), /\/\?trial=unavailable#pricing$/);
    assert.equal(lastSession(), undefined, 'no second Checkout Session was opened');
  });

  test('a redelivered completion does not re-redeem', async () => {
    const body = await (await mint({ invites: [{ email: 'dup@iota.test', campaign: 'q2-outbound' }] })).json();
    const [inv] = body.invites;
    await startRaw(`?t=${inv.token}`);
    const target = db.findTrialInviteByToken(inv.token);
    const session = {
      id: 'cs_3', customer: target.stripeCustomerId, subscription: 'sub_iota',
      metadata: { orgId: target.orgId, plan: 'pro', trial_token: inv.token },
    };
    await webhook('checkout.session.completed', session);
    const first = db.findTrialInviteByToken(inv.token).redeemedAt;
    await webhook('checkout.session.completed', session);
    assert.equal(db.findTrialInviteByToken(inv.token).redeemedAt, first,
      'the redemption timestamp does not move');
  });
});

describe('GET /start — an unusable token', () => {
  test('every failure lands on the pricing page with one soft message', async () => {
    const expired = await (await mint({ invites: [{ email: 'gone@x.test' }], expiresInDays: 1 })).json();
    db.getDb().prepare('UPDATE trial_invites SET expires_at = ? WHERE token = ?')
      .run(new Date(Date.now() - 86400000).toISOString(), expired.invites[0].token);

    const cases = [
      ['', 'no token at all'],
      ['?t=', 'an empty token'],
      ['?t=not-a-uuid', 'a malformed token'],
      ['?t=99999999-9999-4999-8999-999999999999', 'an unknown token'],
      [`?t=${expired.invites[0].token}`, 'an expired token'],
    ];

    for (const [qs, label] of cases) {
      calls.length = 0;
      const res = await startRaw(qs);
      assert.equal(res.status, 302, label);
      assert.equal(res.headers.get('location'), 'https://cvsprings.test/?trial=unavailable#pricing',
        `${label}: identical destination, so the response is not an oracle`);
      assert.equal(lastSession(), undefined, `${label}: nothing was sent to Stripe`);
    }
  });

  test('an org that already has a live subscription is not sold a second one', async () => {
    const body = await (await mint({ invites: [{ email: 'live@kappa.test', company_name: 'Kappa' }] })).json();
    const [inv] = body.invites;
    await startRaw(`?t=${inv.token}`);
    const target = db.findTrialInviteByToken(inv.token);
    db.setOrgPlan(target.orgId, {
      plan: 'pro', subscriptionStatus: 'active', currentPeriodEnd: null, stripeSubscriptionId: 'sub_live',
    });

    calls.length = 0;
    const res = await startRaw(`?t=${inv.token}`);
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location'), /trial=unavailable/);
    assert.equal(lastSession(), undefined, 'Checkout would have created a SECOND subscription');
  });
});

describe('GET /start — an existing account', () => {
  test('a trial for an address that already has an account lands on that org', async () => {
    const org = auth.createOrganization('Existing Agency BV');
    const user = auth.createUser({
      email: 'owner@existing.test',
      passwordHash: await auth.hashPassword('CorrectHorseBattery1!'),
      orgId: org.id,
      role: 'owner',
    });
    assert.ok(user);

    const body = await (await mint({ invites: [{ email: 'owner@existing.test', company_name: 'Existing Agency BV' }] })).json();
    await startRaw(`?t=${body.invites[0].token}`);

    const stored = db.findTrialInviteByToken(body.invites[0].token);
    assert.equal(stored.orgId, org.id, 'no empty shell org was created beside the real one');
    assert.equal(lastSession().params.metadata.orgId, org.id);
  });
});
