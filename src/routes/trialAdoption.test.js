'use strict';

/**
 * src/routes/trialAdoption.test.js — who ends up owning the trial.
 *
 * The bridge between "a trial is running" and "somebody owns it" used to be an
 * email match, which was both unsafe (an unproved address let anyone claim a
 * company's organization) and unreliable (prospects pay from one address and
 * sign up with another). It is now the token, carried through Checkout on the
 * success URL and mailed as a second copy.
 *
 * The six cases below are the contract. The first is the one email matching
 * could never handle; the fourth is the hole it opened.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cvs-trial-adopt-'));
process.env.DATABASE_PATH = path.join(TMP_DIR, 'test.db');
process.env.STRIPE_SECRET_KEY = 'sk_test_stub_adopt';
process.env.STRIPE_PRICE_PRO = 'price_stub_pro';
process.env.STRIPE_PRICE_TEAM = 'price_stub_team';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_stub';
process.env.PUBLIC_APP_URL = 'https://cvsprings.test';
process.env.ADMIN_OWNER_EMAIL = 'operator@cvsprings.test';

const SUBS = new Map();
let seq = 0;
const nextId = (p) => `${p}_${++seq}`;
const sessionParams = [];

const fakeStripe = () => ({
  customers: {
    create: async (p) => ({ id: nextId('cus') }),
    retrieve: async (id) => ({ id, invoice_settings: {} }),
    update: async (id, p) => ({ id, ...p }),
  },
  checkout: {
    sessions: {
      create: async (p) => {
        sessionParams.push(p);
        const id = nextId('sub');
        SUBS.set(id, { id, customer: p.customer, status: 'trialing', items: { data: [] } });
        return { id: nextId('cs'), url: 'https://checkout.stripe.com/stub', subscription: id };
      },
    },
  },
  billingPortal: { sessions: { create: async () => ({ url: 'https://billing.stripe.com/stub' }) } },
  subscriptions: {
    retrieve: async (id) => SUBS.get(id) || { id, status: 'trialing', items: { data: [] } },
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
const db = require('../services/db');
const auth = require('../services/authService');
const trialAdoption = require('../services/trialAdoption');
const { TRIAL_WELCOME } = require('../services/trialEmail');
const authRouter = require('./auth');
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
  // Mirrors src/index.js. It also lets each simulated prospect below arrive
  // from its own address, so the REAL signup limiter (5/hour per IP) stays
  // mounted and enforcing rather than being stubbed out of the way.
  app.set('trust proxy', true);
  app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), billingRouter.handleWebhook);
  app.use(express.json());
  app.use('/api/auth', authRouter);
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

let clock = Math.floor(Date.now() / 1000);
async function webhook(type, object) {
  clock += 1;
  const res = await fetch(base + '/api/billing/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': 'stub' },
    body: JSON.stringify({ id: nextId('evt'), type, created: clock, data: { object } }),
  });
  assert.equal(res.status, 200);
}

async function mintToken(email, companyName, campaign = 'q1') {
  const res = await fetch(base + '/admin/trial-invites', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${operatorToken}` },
    body: JSON.stringify({ invites: [{ email, company_name: companyName, campaign }] }),
  });
  assert.equal(res.status, 201);
  return (await res.json()).invites[0];
}

/**
 * Run a prospect all the way through Checkout: mint, /start, and the completion
 * webhook. Leaves a redeemed token with an org behind it and no account yet.
 */
async function runCheckout(inviteEmail, companyName, { checkoutEmail } = {}) {
  const invite = await mintToken(inviteEmail, companyName);
  const started = await fetch(`${base}/start?t=${invite.token}`, { redirect: 'manual' });
  assert.equal(started.status, 302);

  const row = db.findTrialInviteByToken(invite.token);
  await webhook('checkout.session.completed', {
    id: nextId('cs'),
    customer: row.stripeCustomerId,
    subscription: [...SUBS.values()].find((sub) => sub.customer === row.stripeCustomerId).id,
    customer_details: { email: checkoutEmail || inviteEmail },
    metadata: { orgId: row.orgId, plan: 'pro', trial_token: invite.token, campaign: 'q1' },
  });
  return { invite, orgId: row.orgId, customerId: row.stripeCustomerId };
}

// Each call arrives from a distinct address: these are different prospects, and
// collapsing them onto one IP would hit the signup limiter rather than the
// behaviour under test.
let signupIp = 0;
const signup = (body, qs = '') => fetch(base + '/api/auth/signup' + qs, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Forwarded-For': `203.0.113.${(signupIp += 1) % 250}`,
  },
  body: JSON.stringify(body),
});

const PW = 'CorrectHorseBattery1!';

// --- 1 ----------------------------------------------------------------------

describe('the token adopts even when the signup email differs from Checkout', () => {
  let ctx;

  before(async () => {
    // Invited founder, paid by the bookkeeper, signs up as somebody else again.
    // Email matching handles none of this; the token handles all of it.
    ctx = await runCheckout('founder@alpha.test', 'Alpha BV', { checkoutEmail: 'finance@alpha.test' });
  });

  test('the trial is running with no account attached yet', () => {
    assert.ok(db.findTrialInviteByToken(ctx.invite.token).redeemedAt);
    assert.equal(db.findTrialInviteByToken(ctx.invite.token).consumedAt, null);
    assert.equal(auth.listOrgUsers(ctx.orgId).length, 0);
  });

  test('signing up with a THIRD address still lands on the trial org', async () => {
    const res = await signup({
      email: 'recruiter@alpha.test', password: PW, orgName: 'Ignored', trialToken: ctx.invite.token,
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.trialAdopted, true);
    assert.equal(body.user.orgId, ctx.orgId, 'the org the trial is billing on');
    assert.equal(body.org.name, 'Alpha BV', 'not the orgName they typed');

    const user = auth.findUserByEmail('recruiter@alpha.test');
    assert.equal(user.org_id, ctx.orgId);
    assert.equal(user.role, 'owner');
  });

  test('the token is now consumed, and records who consumed it', () => {
    const row = db.findTrialInviteByToken(ctx.invite.token);
    assert.ok(row.consumedAt);
    assert.equal(row.consumedByUserId, auth.findUserByEmail('recruiter@alpha.test').id);
  });

  test('no throwaway organization was left behind', () => {
    const orgs = db.getDb().prepare(
      'SELECT COUNT(*) AS n FROM organizations WHERE name = ?',
    ).get('Ignored');
    assert.equal(orgs.n, 0, 'the org created before adoption was cleaned up');
  });

  test('the token also arrives by email, for the prospect who closed the tab', () => {
    const welcomes = db.listTrialEmails(ctx.orgId).filter((e) => e.kind === TRIAL_WELCOME);
    const addresses = welcomes.map((e) => e.toEmail).sort();
    assert.deepEqual(addresses, ['finance@alpha.test', 'founder@alpha.test'],
      'both the payer and the invited address get the claim link');
  });

  test('the success URL carried the token', () => {
    const params = sessionParams.find((p) => p.metadata.trial_token === ctx.invite.token);
    assert.equal(params.success_url, `https://cvsprings.test/signup?t=${ctx.invite.token}`);
  });
});

// --- 2 ----------------------------------------------------------------------

describe('a consumed token does not adopt twice', () => {
  let ctx;

  before(async () => {
    ctx = await runCheckout('first@beta.test', 'Beta BV');
    const res = await signup({ email: 'first@beta.test', password: PW, trialToken: ctx.invite.token });
    assert.equal(res.status, 201);
    assert.equal((await res.json()).trialAdopted, true);
  });

  test('a second signup on the same link gets its own organization instead', async () => {
    const res = await signup({
      email: 'second@beta.test', password: PW, orgName: 'Second Co', trialToken: ctx.invite.token,
    });
    assert.equal(res.status, 201, 'the signup still succeeds — an unusable link must not block it');
    const body = await res.json();
    assert.equal(body.trialAdopted, false);
    assert.notEqual(body.user.orgId, ctx.orgId, 'they did NOT land on the trial org');
    assert.equal(body.org.name, 'Second Co');
  });

  test('the trial org still has exactly one owner', () => {
    const members = auth.listOrgUsers(ctx.orgId);
    assert.equal(members.length, 1);
    assert.equal(members[0].email, 'first@beta.test');
  });

  test('and consumed_at was not moved', () => {
    const row = db.findTrialInviteByToken(ctx.invite.token);
    assert.equal(row.consumedByUserId, auth.findUserByEmail('first@beta.test').id);
  });
});

// --- 3 ----------------------------------------------------------------------

describe('an expired signup link falls through to an ordinary signup', () => {
  let ctx;

  before(async () => {
    ctx = await runCheckout('late@gamma.test', 'Gamma BV');
    // 14 days on, to the hour after the link died.
    db.getDb().prepare('UPDATE trial_invites SET signup_expires_at = ? WHERE token = ?')
      .run(new Date(Date.now() - 3600_000).toISOString(), ctx.invite.token);
  });

  test('the account is created, on its own org, with nothing adopted', async () => {
    const res = await signup({
      email: 'late@gamma.test', password: PW, orgName: 'Late Co', trialToken: ctx.invite.token,
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.trialAdopted, false);
    assert.notEqual(body.user.orgId, ctx.orgId);
    assert.equal(body.org.name, 'Late Co');
  });

  test('the token stays unconsumed, so an operator can still extend it', () => {
    assert.equal(db.findTrialInviteByToken(ctx.invite.token).consumedAt, null);
  });

  test('the trial org is still ownerless — the trial did not go to the wrong account', () => {
    assert.equal(auth.listOrgUsers(ctx.orgId).length, 0);
  });

  test('extending the deadline makes the link work again', () => {
    db.getDb().prepare('UPDATE trial_invites SET signup_expires_at = ? WHERE token = ?')
      .run(new Date(Date.now() + 86400_000).toISOString(), ctx.invite.token);
    const user = auth.findUserByEmail('late@gamma.test');
    const result = trialAdoption.adoptByToken(ctx.invite.token, user.id);
    assert.equal(result.adopted, true);
    assert.equal(auth.findUserById(user.id).org_id, ctx.orgId);
  });
});

// --- 4 ----------------------------------------------------------------------

describe('the email fallback never fires on an unverified address', () => {
  let ctx;

  before(async () => {
    ctx = await runCheckout('owner@delta.test', 'Delta BV');
  });

  test('signing up WITHOUT a token adopts nothing, even on an exact email match', async () => {
    // This is the org-takeover the token replaced: nothing here proves the
    // person signing up owns owner@delta.test.
    const res = await signup({ email: 'owner@delta.test', password: PW, orgName: 'Delta Fresh' });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.trialAdopted, false, 'signup must never adopt by email');
    assert.notEqual(body.user.orgId, ctx.orgId);
    assert.equal(db.findTrialInviteByToken(ctx.invite.token).consumedAt, null);
    assert.equal(auth.listOrgUsers(ctx.orgId).length, 0, 'the trial org is untouched');
  });

  test('calling the fallback directly still refuses while the address is unproved', () => {
    const user = auth.findUserByEmail('owner@delta.test');
    assert.equal(db.isEmailVerified(user.id), false, 'nothing in this codebase verifies emails yet');

    const result = trialAdoption.adoptByVerifiedEmail(user.id);
    assert.equal(result.adopted, false);
    assert.equal(result.outcome, trialAdoption.OUTCOME.UNVERIFIED_EMAIL);
    assert.notEqual(auth.findUserById(user.id).org_id, ctx.orgId);
  });

  test('adoption fires once the address IS verified', () => {
    // db.markEmailVerified is the counterpart a real verification step calls;
    // this stands in for that step, which does not exist yet.
    const user = auth.findUserByEmail('owner@delta.test');
    db.markEmailVerified(user.id);

    const result = trialAdoption.adoptByVerifiedEmail(user.id);
    assert.equal(result.adopted, true);
    assert.equal(result.orgId, ctx.orgId);
    assert.equal(auth.findUserById(user.id).org_id, ctx.orgId);
    assert.ok(db.findTrialInviteByToken(ctx.invite.token).consumedAt);
  });

  test('and it will not fire a second time', () => {
    const user = auth.findUserByEmail('owner@delta.test');
    const again = trialAdoption.adoptByVerifiedEmail(user.id);
    assert.equal(again.adopted, false);
    assert.equal(again.outcome, trialAdoption.OUTCOME.NO_MATCH);
  });
});

// --- 5 ----------------------------------------------------------------------

describe('an address that already has an account', () => {
  let existingOrgId;

  before(async () => {
    const org = auth.createOrganization('Epsilon Recruitment');
    existingOrgId = org.id;
    auth.createUser({
      email: 'owner@epsilon.test',
      passwordHash: await auth.hashPassword(PW),
      orgId: org.id,
      role: 'owner',
    });
  });

  test('the trial attaches to their existing org — no second org is created', async () => {
    const invite = await mintToken('owner@epsilon.test', 'Epsilon Recruitment');
    const res = await fetch(`${base}/start?t=${invite.token}`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location'), /checkout\.stripe\.com/);

    const row = db.findTrialInviteByToken(invite.token);
    assert.equal(row.orgId, existingOrgId, 'the trial went onto the account they already have');

    const orgsNamed = db.getDb().prepare(
      'SELECT COUNT(*) AS n FROM organizations WHERE name = ?',
    ).get('Epsilon Recruitment');
    assert.equal(orgsNamed.n, 1, 'exactly one Epsilon org exists');
  });

  test('and signing up again is refused with an explanation, not a duplicate account', async () => {
    const invite = db.getDb().prepare(
      'SELECT token FROM trial_invites WHERE email = ? ORDER BY created_at DESC LIMIT 1',
    ).get('owner@epsilon.test');

    const res = await signup({ email: 'owner@epsilon.test', password: PW, trialToken: invite.token });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.code, 'TRIAL_ALREADY_YOURS');
    assert.match(body.error, /log in/i);

    const users = db.getDb().prepare('SELECT COUNT(*) AS n FROM users WHERE email = ?').get('owner@epsilon.test');
    assert.equal(users.n, 1, 'still exactly one account');
  });
});

// --- 7 ----------------------------------------------------------------------

describe('/start on an address whose trial PAUSED', () => {
  /**
   * A prospect whose first trial ran out without a card, re-invited on a later
   * campaign. Their analyses, audit log and templates are all on the paused
   * org. Creating a second org for them would leave them staring at an empty
   * product with no route back to any of it — the duplicate-account failure
   * this bridge exists to prevent, reached from the other direction.
   */
  let pausedOrgId;
  let orgCountBefore;

  before(async () => {
    const first = await runCheckout('lapsed@eta.test', 'Eta Recruitment');
    pausedOrgId = first.orgId;

    // The account is claimed and in use — this is a real customer's data.
    const res = await signup({ email: 'lapsed@eta.test', password: PW, trialToken: first.invite.token });
    assert.equal(res.status, 201);
    assert.equal((await res.json()).trialAdopted, true);

    // Day 30 arrives with no payment method.
    db.setOrgPlan(pausedOrgId, {
      plan: 'pro', subscriptionStatus: 'paused', currentPeriodEnd: null, stripeSubscriptionId: 'sub_eta',
    });

    orgCountBefore = db.getDb().prepare('SELECT COUNT(*) AS n FROM organizations').get().n;
  });

  test('a fresh invite redirects to the resume path', async () => {
    const invite = await mintToken('lapsed@eta.test', 'Eta Recruitment', 'q3-winback');
    const res = await fetch(`${base}/start?t=${invite.token}`, { redirect: 'manual' });

    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), 'https://cvsprings.test/login?trial=resume');
  });

  test('NO new organization was created', () => {
    const after = db.getDb().prepare('SELECT COUNT(*) AS n FROM organizations').get().n;
    assert.equal(after, orgCountBefore, 'a second org would have hidden their data from them');

    const named = db.getDb().prepare('SELECT COUNT(*) AS n FROM organizations WHERE name = ?').get('Eta Recruitment');
    assert.equal(named.n, 1);
  });

  test('the invite is not consumed, and records the org it resolved to', () => {
    const row = db.getDb().prepare(
      'SELECT token, org_id AS orgId, consumed_at AS consumedAt, redeemed_at AS redeemedAt '
      + 'FROM trial_invites WHERE campaign = ? ORDER BY created_at DESC LIMIT 1',
    ).get('q3-winback');

    assert.equal(row.orgId, pausedOrgId, 'it resolved to the existing paused org');
    assert.equal(row.consumedAt, null, 'nothing was claimed — there is nothing new to claim');
    assert.equal(row.redeemedAt, null, 'and no trial was started');
  });

  test('nothing was sent to Stripe', async () => {
    const before = sessionParams.length;
    const invite = await mintToken('lapsed@eta.test', 'Eta Recruitment', 'q3-winback-2');
    await fetch(`${base}/start?t=${invite.token}`, { redirect: 'manual' });
    assert.equal(sessionParams.length, before, 'no second subscription was opened');
  });

  test('their data and their account are untouched', () => {
    const owner = auth.listOrgUsers(pausedOrgId).find((u) => u.role === 'owner');
    assert.ok(owner, 'they still own the paused org');
    assert.equal(owner.email, 'lapsed@eta.test');
    const billing = db.getOrgBilling(pausedOrgId);
    assert.equal(billing.plan, 'pro', 'the plan is retained');
    assert.equal(billing.subscriptionStatus, 'paused');
    assert.equal(billing.stripeSubscriptionId, 'sub_eta', 'the subscription the resume path will un-pause');
  });
});

// --- 6 ----------------------------------------------------------------------

describe('/start refuses an invite whose address is already a paying customer', () => {
  let payingOrgId;

  before(async () => {
    const org = auth.createOrganization('Zeta Group');
    payingOrgId = org.id;
    auth.createUser({
      email: 'owner@zeta.test',
      passwordHash: await auth.hashPassword(PW),
      orgId: org.id,
      role: 'owner',
    });
    db.setOrgPlan(org.id, {
      plan: 'pro', subscriptionStatus: 'active', currentPeriodEnd: null, stripeSubscriptionId: 'sub_zeta',
    });
  });

  test('they are sent to login, and no Checkout Session is created', async () => {
    const before = sessionParams.length;
    const invite = await mintToken('owner@zeta.test', 'Zeta Group');
    const res = await fetch(`${base}/start?t=${invite.token}`, { redirect: 'manual' });

    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), 'https://cvsprings.test/login?trial=existing_account');
    assert.equal(sessionParams.length, before, 'nothing was sent to Stripe');
  });

  test('no second trialing organization was created beside their real one', () => {
    const orgsNamed = db.getDb().prepare(
      'SELECT COUNT(*) AS n FROM organizations WHERE name = ?',
    ).get('Zeta Group');
    assert.equal(orgsNamed.n, 1);
    assert.equal(db.getOrgBilling(payingOrgId).subscriptionStatus, 'active', 'their subscription is untouched');
  });

  test('trialing and past_due are refused the same way', async () => {
    for (const status of ['trialing', 'past_due']) {
      db.setOrgPlan(payingOrgId, {
        plan: 'pro', subscriptionStatus: status, currentPeriodEnd: null, stripeSubscriptionId: 'sub_zeta',
      });
      const invite = await mintToken('owner@zeta.test', 'Zeta Group');
      const res = await fetch(`${base}/start?t=${invite.token}`, { redirect: 'manual' });
      assert.equal(res.headers.get('location'), 'https://cvsprings.test/login?trial=existing_account', status);
    }
  });
});
