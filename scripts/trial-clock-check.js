#!/usr/bin/env node
'use strict';

/**
 * scripts/trial-clock-check.js — drive the no-card trial against REAL Stripe.
 *
 * NOT part of the test suite. `npm test` globs src/**\/*.test.js; this lives in
 * scripts/ and is run by hand, because it needs three things a test cannot
 * have: live test-mode keys, the app running on :3000, and `stripe listen`
 * forwarding to /api/billing/webhook.
 *
 * What it is for: src/routes/trialClock.test.js models Stripe's test-clock
 * behaviour at the network boundary. A model is a claim about somebody else's
 * system, and the only way to find out where the claim is wrong is to run the
 * same journey against the real thing and compare. This prints that comparison.
 *
 * It reports differences. It does NOT reconcile them — a model that silently
 * grew to match whatever Stripe did today would stop being a check on anything.
 *
 *   node scripts/trial-clock-check.js              interactive (pauses at day 27)
 *   node scripts/trial-clock-check.js --no-pause   unattended
 *   node scripts/trial-clock-check.js --cleanup    delete leftovers and exit
 *
 * SAFETY
 *   - refuses any key that is not sk_test_ / rk_test_;
 *   - every write carries an idempotency key;
 *   - every create is preceded by a list, so a retry adopts what is already
 *     there instead of making a second one;
 *   - the test clock is deleted at the end, which takes its customer and
 *     subscription with it.
 */

require('dotenv').config();

const readline = require('readline');

const MARKER = 'trial-clock-check';
const DAY = 86400;

/**
 * Per-run state, so idempotency keys are stable WITHIN a run and distinct
 * BETWEEN runs.
 *
 * A fixed key was the obvious first move and it is wrong: Stripe rejects a key
 * reused with different parameters, and the clock's frozen_time necessarily
 * differs every run, so the second run died with "Keys for idempotent requests
 * can only be used with the same parameters". Keys exist to make a RETRY safe,
 * not to make two different runs collide.
 *
 * Kept in data/, which is already gitignored. Deleted by cleanup, so the next
 * run starts fresh; surviving it means a run was interrupted and the next
 * invocation resumes the same logical run with the same keys and the same
 * frozen_time — which is exactly what makes resuming safe.
 */
const fs = require('fs');
const path = require('path');
const RUN_FILE = path.join(__dirname, '..', 'data', '.trial-clock-run.json');

function loadRun() {
  try { return JSON.parse(fs.readFileSync(RUN_FILE, 'utf8')); } catch (_) { return null; }
}
function saveRun(run) {
  fs.mkdirSync(path.dirname(RUN_FILE), { recursive: true });
  fs.writeFileSync(RUN_FILE, JSON.stringify(run, null, 2));
}
function clearRun() {
  try { fs.unlinkSync(RUN_FILE); } catch (_) {}
}

let RUN = loadRun();
const IDEM = (step) => `${MARKER}-${step}-${RUN.id}`;

const args = process.argv.slice(2);
const NO_PAUSE = args.includes('--no-pause');
const CLEANUP_ONLY = args.includes('--cleanup');
// --scenarios runs the four paused-recovery journeys instead of the single
// trial walk-through. Each builds its own clock, drives the REAL app endpoints,
// asserts the one-subscription invariant, and deletes its clock.
const SCENARIOS = args.includes('--scenarios');

// --- Guards -----------------------------------------------------------------

const KEY = (process.env.STRIPE_SECRET_KEY || '').trim();
if (!KEY || KEY === 'REPLACE_WITH_SK_TEST') {
  console.error('STRIPE_SECRET_KEY is not set in .env.');
  process.exit(1);
}
if (KEY.startsWith('sk_live_') || KEY.startsWith('rk_live_')) {
  console.error('REFUSING TO RUN: STRIPE_SECRET_KEY is a LIVE key. This script creates');
  console.error('subscriptions and advances clocks; it must only ever touch test mode.');
  process.exit(1);
}
if (!KEY.startsWith('sk_test_') && !KEY.startsWith('rk_test_')) {
  console.error('REFUSING TO RUN: STRIPE_SECRET_KEY has an unrecognised prefix.');
  process.exit(1);
}

const PRICE_PRO = process.env.STRIPE_PRICE_PRO;
if (!PRICE_PRO) {
  console.error('STRIPE_PRICE_PRO is not set in .env.');
  process.exit(1);
}

// Retries and a generous timeout. The first run of this script died on
// "An error occurred with our connection to Stripe. Request was retried 2 times"
// while paging the events list, and took its cleanup down with it — leaving a
// live test clock, customer and subscription behind. A long-running script that
// creates remote objects has to survive a flaky connection or it litters.
const stripe = require('stripe')(KEY, { maxNetworkRetries: 4, timeout: 30000 });
const db = require('../src/services/db');

// --- What the stub in src/routes/trialClock.test.js models -------------------
//
// Transcribed from that file's clock, so the comparison below is against the
// model as written rather than against my memory of it. Each entry is
// "the stub emits this event at this point in the journey".
const STUB_MODEL = {
  'subscription created': ['(none — the stub creates the object silently)'],
  'day 27': ['customer.subscription.trial_will_end'],
  'day 30, no card': ['customer.subscription.updated'],
  'day 30, card on file': ['customer.subscription.updated', 'invoice.paid'],
  'card attached': ['payment_method.attached'],
  'resumption charged': ['customer.subscription.updated', 'customer.subscription.resumed', 'invoice.paid'],
};

// --- Helpers ----------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hr(title) {
  console.log('\n' + '='.repeat(78));
  console.log(title);
  console.log('='.repeat(78));
}

async function pause(message) {
  if (NO_PAUSE) {
    console.log(`\n[--no-pause] would have paused here: ${message}`);
    return;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise((resolve) => rl.question(`\n${message}\n  press Enter to continue… `, () => { rl.close(); resolve(); }));
}

/** Advance a test clock and wait for Stripe to finish processing it. */
async function advanceTo(clockId, unixSeconds, label) {
  console.log(`\n-> advancing clock to ${label} (${new Date(unixSeconds * 1000).toISOString()})`);
  await stripe.testHelpers.testClocks.advance(clockId, { frozen_time: unixSeconds });
  // advance() returns immediately with status 'advancing'. Everything the clock
  // triggers happens while it is in that state, so polling to 'ready' is what
  // makes the events below complete rather than half-arrived.
  for (let i = 0; i < 120; i += 1) {
    const clock = await stripe.testHelpers.testClocks.retrieve(clockId);
    if (clock.status === 'ready') { console.log('   clock ready'); return clock; }
    if (clock.status === 'internal_failure') throw new Error('test clock entered internal_failure');
    await sleep(1000);
  }
  throw new Error('test clock did not become ready within 120s');
}

/** Whether an event concerns the objects this run created. */
function isOurs(evt, customerId, subId) {
  const o = (evt.data && evt.data.object) || {};
  return o.id === customerId || o.id === subId
    || o.customer === customerId || o.subscription === subId
    || (o.lines && o.lines.data || []).some((l) => l.subscription === subId);
}

/**
 * Stripe events since `sinceTs`, oldest first, bounded.
 *
 * Explicitly paged rather than auto-paginated. The `for await` form walks every
 * page until exhausted, and with `stripe listen` running the account produces
 * enough events that one flaky page killed the whole run. MAX_PAGES caps it and
 * a transient error returns what we have rather than throwing.
 */
const MAX_PAGES = 6;
async function eventsSince(sinceTs) {
  const out = [];
  let starting_after;
  try {
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const res = await stripe.events.list({
        created: { gte: sinceTs }, limit: 100, ...(starting_after ? { starting_after } : {}),
      });
      out.push(...res.data);
      if (!res.has_more || !res.data.length) break;
      starting_after = res.data[res.data.length - 1].id;
    }
  } catch (err) {
    console.log(`   (warning: event fetch interrupted — ${err.message}; reporting ${out.length} so far)`);
  }
  return out.sort((a, b) => a.created - b.created || String(a.id).localeCompare(String(b.id)));
}

/**
 * Wait until no NEW event has arrived for `quietMs`.
 * Webhook delivery and event generation both lag the clock advance.
 */
async function settle(sinceTs, quietMs = 6000, maxMs = 60000) {
  const started = Date.now();
  let lastCount = -1;
  let lastChange = Date.now();
  while (Date.now() - started < maxMs) {
    let evts;
    try { evts = await eventsSince(sinceTs); } catch (_) { await sleep(2000); continue; }
    if (evts.length !== lastCount) { lastCount = evts.length; lastChange = Date.now(); }
    else if (Date.now() - lastChange >= quietMs) return evts;
    await sleep(1500);
  }
  return eventsSince(sinceTs);
}

/** What the APP did — read from its own database, not from Stripe. */
function dbSnapshot(orgId) {
  const billing = db.getOrgBilling(orgId) || {};
  const emails = db.listTrialEmails(orgId).map((e) => `${e.kind}->${e.toEmail}${e.error ? ' ERROR' : ''}`);
  const trial = db.getOrgTrial(orgId) || {};
  return {
    plan: billing.plan || null,
    status: billing.subscriptionStatus || null,
    subId: billing.stripeSubscriptionId || null,
    converted: trial.convertedAt || null,
    campaign: trial.campaign || null,
    emails,
  };
}

function printSnapshot(label, snap) {
  console.log(`   APP STATE after ${label}:`);
  console.log(`      plan=${snap.plan}  status=${snap.status}  subscription=${snap.subId}`);
  console.log(`      converted=${snap.converted || '(not yet)'}  campaign=${snap.campaign || '(none)'}`);
  console.log(`      trial emails: ${snap.emails.length ? snap.emails.join(', ') : '(none)'}`);
}

/** Print the events for one stage, with the subscription status each carried. */
function printEvents(stage, events, seenIds) {
  const fresh = events.filter((e) => !seenIds.has(e.id));
  fresh.forEach((e) => seenIds.add(e.id));
  console.log(`\n   STRIPE SENT (${fresh.length} events) during "${stage}":`);
  if (!fresh.length) console.log('      (none)');
  for (const e of fresh) {
    const o = e.data && e.data.object ? e.data.object : {};
    const bits = [];
    if (o.status) bits.push(`status=${o.status}`);
    if (o.object === 'subscription' && o.pause_collection) bits.push('pause_collection=SET');
    if (o.object === 'subscription' && o.pause_collection === null) bits.push('pause_collection=null');
    if (o.object === 'invoice') bits.push(`amount_paid=${o.amount_paid} billing_reason=${o.billing_reason}`);
    if (o.object === 'payment_method') bits.push(`customer=${o.customer}`);
    console.log(`      ${new Date(e.created * 1000).toISOString().slice(11, 19)}  ${e.type.padEnd(42)} ${bits.join('  ')}`);
  }
  return fresh.map((e) => e.type);
}

// --- Cleanup ----------------------------------------------------------------

async function findClock() {
  const clocks = await stripe.testHelpers.testClocks.list({ limit: 100 });
  return clocks.data.find((c) => c.name === MARKER) || null;
}

async function cleanup(orgId) {
  hr('CLEANUP');
  // Retried, and its failure is shouted rather than swallowed. A half-finished
  // cleanup leaves a billing subscription running in the account; the one thing
  // worse than that is not being told about it.
  let deleted = false;
  for (let attempt = 1; attempt <= 3 && !deleted; attempt += 1) {
    try {
      const clock = await findClock();
      if (!clock) { console.log('no test clock named ' + MARKER + ' to delete'); deleted = true; break; }
      await stripe.testHelpers.testClocks.del(clock.id);
      console.log(`deleted test clock ${clock.id} (its customer and subscription go with it)`);
      deleted = true;
    } catch (err) {
      console.log(`   cleanup attempt ${attempt} failed: ${err.message}`);
      await sleep(2000);
    }
  }
  if (!deleted) {
    console.error('\n*** CLEANUP FAILED — a test clock, customer and SUBSCRIPTION are still live.');
    console.error('*** Run:  node scripts/trial-clock-check.js --cleanup');
    process.exitCode = 1;
  }
  if (orgId) {
    const d = db.getDb();
    d.prepare('DELETE FROM trial_emails WHERE org_id = ?').run(orgId);
    d.prepare('DELETE FROM trial_invites WHERE org_id = ?').run(orgId);
    d.prepare('DELETE FROM organizations WHERE id = ?').run(orgId);
    console.log(`removed local org ${orgId} and its trial rows`);
  }
  clearRun();
  const left = await stripe.testHelpers.testClocks.list({ limit: 100 });
  console.log('test clocks remaining in account:', left.data.length);
}

// --- Main -------------------------------------------------------------------

// --- Paused-recovery scenarios ----------------------------------------------

const APP = process.env.CLOCK_CHECK_APP_URL || 'http://localhost:3000';

/** A fresh org + owner + session in the app's own database. */
async function makeOwnerSession(name) {
  const auth = require('../src/services/authService');
  const org = auth.createOrganization(name);
  const user = auth.createUser({
    email: `${MARKER}-${RUN.id}-${Math.random().toString(36).slice(2, 8)}@cvsprings.test`,
    passwordHash: await auth.hashPassword('CorrectHorseBattery1!'),
    orgId: org.id, role: 'owner',
  });
  return { orgId: org.id, token: auth.createSession(user.id).rawToken, email: user.email };
}

const appCall = (token, method, path, body) => fetch(APP + path, {
  method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

/** Build a customer + subscription on a clock and run it into the paused state. */
async function buildPausedOrg(label) {
  const frozen = Math.floor(Date.now() / 1000);
  const clock = await stripe.testHelpers.testClocks.create({ frozen_time: frozen, name: `${MARKER}-${label}` });
  const customer = await stripe.customers.create({
    test_clock: clock.id, email: `${label}@cvsprings.test`, name: label,
    address: { country: 'NL', postal_code: '1011AB', city: 'Amsterdam', line1: 'Teststraat 1' },
  });
  const session = await makeOwnerSession(`${MARKER}-${label}`);
  db.setOrgStripeCustomerId(session.orgId, customer.id);
  // Exactly what GET /start does, so the scenario exercises a trial-originated
  // org rather than a bare one that happens to have a subscription.
  db.setOrgTrialCampaign(session.orgId, MARKER);

  const sub = await stripe.subscriptions.create({
    customer: customer.id, items: [{ price: PRICE_PRO }],
    trial_period_days: 30,
    trial_settings: { end_behavior: { missing_payment_method: 'pause' } },
    automatic_tax: { enabled: true },
    metadata: { orgId: session.orgId, plan: 'pro', campaign: MARKER },
  });
  await advanceTo(clock.id, frozen + 31 * DAY, 'day 31');
  await sleep(6000); // let the webhook land

  const paused = await stripe.subscriptions.retrieve(sub.id);
  console.log(`   paused at Stripe: ${paused.status} | app records: ${(db.getOrgBilling(session.orgId) || {}).subscriptionStatus}`);
  return { clock, customer, sub, ...session };
}

const liveSubsFor = async (clockId) => {
  const l = await stripe.subscriptions.list({ test_clock: clockId, status: 'all', limit: 20 });
  return l.data.filter((x) => x.status !== 'canceled');
};

function check(label, ok, results) {
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  results.push(ok);
  return ok;
}

async function runScenarios() {
  const results = [];
  const clocks = [];

  try {
    // --- 1. Continue on Free ------------------------------------------------
    hr('SCENARIO 1 — Continue on Free');
    {
      const ctx = await buildPausedOrg('free');
      clocks.push(ctx.clock.id);
      const res = await appCall(ctx.token, 'POST', '/api/billing/continue-free', {});
      check('unconfirmed request is refused', res.status === 400, results);

      const ok = await appCall(ctx.token, 'POST', '/api/billing/continue-free', { confirm: true });
      const body = await ok.json();
      check('confirmed downgrade succeeds', ok.status === 200 && body.plan === 'free', results);
      check('exactly zero live subscriptions', (await liveSubsFor(ctx.clock.id)).length === 0, results);
      check('app is on Free', (db.getOrgBilling(ctx.orgId) || {}).plan === 'free', results);
      check('month usage reset to 0', db.getUsageCount(ctx.orgId) === 0, results);
      check('free_tier_since stamped', !!db.getFreeTierSince(ctx.orgId), results);
    }

    // --- 2. Continue on Pro -------------------------------------------------
    hr('SCENARIO 2 — Continue on Pro (resume the existing subscription)');
    {
      const ctx = await buildPausedOrg('pro');
      clocks.push(ctx.clock.id);
      const res = await appCall(ctx.token, 'POST', '/api/billing/resume', { plan: 'pro' });
      const body = await res.json();
      check('resume opens a SETUP-mode checkout', res.status === 200 && /checkout\.stripe\.com/.test(body.url || ''), results);

      // The card arriving is what the real customer's Checkout completion does.
      await stripe.paymentMethods.attach('pm_card_visa', { customer: ctx.customer.id });
      await sleep(10000);

      const sub = await stripe.subscriptions.retrieve(ctx.sub.id);
      check('the EXISTING subscription is active', sub.status === 'active' && sub.id === ctx.sub.id, results);
      check('exactly one live subscription', (await liveSubsFor(ctx.clock.id)).length === 1, results);
      const invs = await stripe.invoices.list({ customer: ctx.customer.id, limit: 5 });
      const paid = invs.data.find((i) => i.amount_paid > 0);
      check('an invoice for EUR 49 + VAT was paid', !!paid && paid.subtotal === 4900 && paid.amount_paid === 5929, results);
      check('app records active', (db.getOrgBilling(ctx.orgId) || {}).subscriptionStatus === 'active', results);
    }

    // --- 3. Pro -> Team from paused ----------------------------------------
    hr('SCENARIO 3 — Pro to Team from paused (the duplicate-subscription hole)');
    {
      const ctx = await buildPausedOrg('team');
      clocks.push(ctx.clock.id);
      const blocked = await appCall(ctx.token, 'POST', '/api/billing/checkout', { plan: 'team' });
      check('plain checkout is refused while paused', blocked.status === 409, results);

      await appCall(ctx.token, 'POST', '/api/billing/resume', { plan: 'team' });
      const mid = await stripe.subscriptions.retrieve(ctx.sub.id);
      check('the tier choice is recorded, not yet applied', mid.metadata.pending_plan === 'team'
        && mid.items.data[0].price.id === PRICE_PRO, results);

      await stripe.paymentMethods.attach('pm_card_visa', { customer: ctx.customer.id });
      await sleep(10000);

      const sub = await stripe.subscriptions.retrieve(ctx.sub.id);
      check('the SAME subscription now carries the Team price',
        sub.id === ctx.sub.id && sub.items.data[0].price.id === process.env.STRIPE_PRICE_TEAM, results);
      check('status is active', sub.status === 'active', results);
      const live = await liveSubsFor(ctx.clock.id);
      check(`EXACTLY ONE live subscription (found ${live.length})`, live.length === 1, results);
    }

    // --- 4. Declined card ---------------------------------------------------
    hr('SCENARIO 4 — declined card at resume');
    {
      const ctx = await buildPausedOrg('decline');
      clocks.push(ctx.clock.id);
      await appCall(ctx.token, 'POST', '/api/billing/resume', { plan: 'pro' });
      // pm_card_chargeCustomerFail attaches successfully and fails at CHARGE
      // time, which is the case under test. pm_card_chargeDeclined is refused
      // at attach, so the card never reaches the resume path at all.
      await stripe.paymentMethods.attach('pm_card_chargeCustomerFail', { customer: ctx.customer.id });
      await sleep(12000);

      const sub = await stripe.subscriptions.retrieve(ctx.sub.id);
      const b = db.getOrgBilling(ctx.orgId) || {};
      const ent = require('../src/services/entitlements').entitlementForOrg(b);
      console.log(`   [observed] stripe=${sub.status}  app=${b.subscriptionStatus}  entitlement=${ent}`);
      const invs = await stripe.invoices.list({ customer: ctx.customer.id, limit: 5 });
      for (const i of invs.data) console.log(`   [observed] invoice ${i.id} ${i.status} paid=${i.amount_paid}`);
      check(`the subscription does not become active (stripe=${sub.status})`, sub.status !== 'active', results);
      check(`the app never shows it as active (app=${b.subscriptionStatus})`, b.subscriptionStatus !== 'active', results);
      check(`entitlement is not full (${ent})`, ent !== 'full', results);
      const err = db.getResumeError(ctx.orgId);
      check(`a decline reason was recorded (${err ? JSON.stringify(err.message) : 'none'})`, !!err, results);
      check('exactly one live subscription', (await liveSubsFor(ctx.clock.id)).length === 1, results);
    }
  } finally {
    hr('CLEANUP');
    for (const id of clocks) {
      try { await stripe.testHelpers.testClocks.del(id); console.log('deleted clock', id); }
      catch (err) { console.error('could not delete clock', id, err.message); process.exitCode = 1; }
    }
    const d = db.getDb();
    for (const row of d.prepare("SELECT id FROM organizations WHERE name LIKE ?").all(`${MARKER}-%`)) {
      d.prepare('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE org_id = ?)').run(row.id);
      d.prepare('DELETE FROM users WHERE org_id = ?').run(row.id);
      d.prepare('DELETE FROM trial_emails WHERE org_id = ?').run(row.id);
      d.prepare('DELETE FROM usage_counters WHERE org_id = ?').run(row.id);
      d.prepare('DELETE FROM organizations WHERE id = ?').run(row.id);
    }
    console.log('removed local scenario orgs');
    clearRun();
  }

  hr('SCENARIO RESULTS');
  const passed = results.filter(Boolean).length;
  console.log(`${passed} / ${results.length} checks passed`);
  if (passed !== results.length) process.exitCode = 1;
}

async function main() {
  if (SCENARIOS) {
    if (!RUN) { RUN = { id: require('crypto').randomUUID().slice(0, 8), frozenTime: Math.floor(Date.now() / 1000) }; saveRun(RUN); }
    await runScenarios();
    return;
  }

  if (CLEANUP_ONLY) {
    if (!RUN) RUN = { id: 'cleanup', frozenTime: 0 }; // IDEM is unused on this path
    const org = db.getDb().prepare('SELECT id FROM organizations WHERE name = ?').get(MARKER);
    await cleanup(org ? org.id : null);
    return;
  }

  hr('SETUP');
  console.log('price (Pro, from .env):', PRICE_PRO);

  if (RUN) {
    console.log(`RESUMING run ${RUN.id} (started ${new Date(RUN.frozenTime * 1000).toISOString()})`);
  } else {
    RUN = { id: require('crypto').randomUUID().slice(0, 8), frozenTime: Math.floor(Date.now() / 1000) };
    saveRun(RUN);
    console.log(`new run ${RUN.id}`);
  }

  // --- re-list before creating, every time ---------------------------------
  let clock = await findClock();
  if (clock) {
    console.log(`REUSING existing test clock ${clock.id} (frozen at ${new Date(clock.frozen_time * 1000).toISOString()})`);
  } else {
    clock = await stripe.testHelpers.testClocks.create(
      { frozen_time: RUN.frozenTime, name: MARKER },
      { idempotencyKey: IDEM('clock') },
    );
    console.log(`created test clock ${clock.id} at ${new Date(clock.frozen_time * 1000).toISOString()}`);
  }

  const existingCustomers = await stripe.customers.list({ test_clock: clock.id, limit: 10 });
  let customer = existingCustomers.data[0] || null;
  if (customer) {
    console.log(`REUSING customer ${customer.id}`);
  } else {
    customer = await stripe.customers.create({
      email: 'clockcheck@cvsprings.test',
      name: 'Clock Check BV',
      test_clock: clock.id,
      // An address up front: with no payment method there is nothing for Stripe
      // Tax to locate, and the first real invoice would fail to compute tax.
      address: { country: 'NL', postal_code: '1011AB', city: 'Amsterdam', line1: 'Teststraat 1' },
      metadata: { purpose: MARKER },
    }, { idempotencyKey: IDEM('customer') });
    console.log(`created customer ${customer.id}`);
  }

  // --- local state, exactly as GET /start would leave it -------------------
  // Without an organization carrying this customer id, the webhook handler
  // resolves no org and does nothing: "what the handler did" would be blank for
  // every event, and the run would prove nothing.
  let org = db.getDb().prepare('SELECT id FROM organizations WHERE name = ?').get(MARKER);
  if (!org) {
    const created = db.createTrialOrganization({ name: MARKER, email: 'clockcheck@cvsprings.test' });
    org = { id: created.id };
    console.log(`created local org ${org.id}`);
  } else {
    console.log(`REUSING local org ${org.id}`);
  }
  db.setOrgStripeCustomerId(org.id, customer.id);
  db.setOrgTrialCampaign(org.id, MARKER);

  const existingSubs = await stripe.subscriptions.list({ test_clock: clock.id, status: 'all', limit: 10 });
  let sub = existingSubs.data[0] || null;
  const runStartedAt = Math.floor(Date.now() / 1000) - 5;

  if (sub) {
    console.log(`REUSING subscription ${sub.id} (status ${sub.status})`);
  } else {
    // Exactly what routes/trialStart.js puts on the Checkout Session.
    sub = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: PRICE_PRO }],
      trial_period_days: 30,
      trial_settings: { end_behavior: { missing_payment_method: 'pause' } },
      automatic_tax: { enabled: true },
      metadata: { orgId: org.id, plan: 'pro', campaign: MARKER, trial_token: MARKER },
    }, { idempotencyKey: IDEM('subscription') });
    console.log(`created subscription ${sub.id} status=${sub.status} trial_end=${new Date(sub.trial_end * 1000).toISOString()}`);
  }

  const seen = new Set();
  const byStage = {};

  await settle(runStartedAt, 4000, 20000);
  byStage['subscription created'] = printEvents('subscription created', await eventsSince(runStartedAt), seen);
  printSnapshot('creation', dbSnapshot(org.id));

  // --- day 27 --------------------------------------------------------------
  hr('STAGE 1 — advance to day 27 (trial_will_end fires 3 days out)');
  await advanceTo(clock.id, clock.frozen_time + 27 * DAY, 'day 27');
  await settle(runStartedAt);
  byStage['day 27'] = printEvents('day 27', await eventsSince(runStartedAt), seen);
  printSnapshot('day 27', dbSnapshot(org.id));

  await pause('Day 27 done. Check the app terminal and `stripe listen` output above.');

  // --- day 31, no card -----------------------------------------------------
  hr('STAGE 2 — advance past day 30 with NO payment method (should PAUSE)');
  await advanceTo(clock.id, clock.frozen_time + 31 * DAY, 'day 31');
  await settle(runStartedAt);
  byStage['day 30, no card'] = printEvents('past day 30, no card', await eventsSince(runStartedAt), seen);
  const afterPause = dbSnapshot(org.id);
  printSnapshot('day 31', afterPause);

  const subAfterPause = await stripe.subscriptions.retrieve(sub.id);
  console.log(`   STRIPE SUBSCRIPTION: status=${subAfterPause.status} pause_collection=${JSON.stringify(subAfterPause.pause_collection)}`);

  // --- attach a card -------------------------------------------------------
  hr('STAGE 3 — attach a payment method (should clear pause_collection)');
  const pms = await stripe.paymentMethods.list({ customer: customer.id, type: 'card', limit: 10 });
  if (pms.data.length) {
    console.log(`REUSING attached payment method ${pms.data[0].id}`);
  } else {
    const pm = await stripe.paymentMethods.attach('pm_card_visa', { customer: customer.id },
      { idempotencyKey: IDEM('pm-attach') });
    console.log(`attached ${pm.id}`);
  }
  await settle(runStartedAt, 8000, 60000);
  byStage['card attached'] = printEvents('card attached', await eventsSince(runStartedAt), seen);
  printSnapshot('card attached', dbSnapshot(org.id));

  const subResumed = await stripe.subscriptions.retrieve(sub.id);
  console.log(`   STRIPE SUBSCRIPTION: status=${subResumed.status} pause_collection=${JSON.stringify(subResumed.pause_collection)}`);

  // --- settle the resumption invoice ---------------------------------------
  // On a TEST CLOCK, billing is driven by clock time rather than wall time.
  // subscriptions.resume() raises and finalizes the invoice immediately, but
  // its PaymentIntent sits at requires_payment_method until the clock moves —
  // so without this the run reports status=paused and an unpaid invoice, and
  // looks like the resume failed when it merely had not been charged yet.
  // Against real time in production no such step exists: Stripe charges at once.
  hr('STAGE 4 — advance again: the resumed state must survive the next tick');
  // The resume completes synchronously in stage 3 now that the handler pays the
  // resumption invoice, so this is no longer what collects the money. It stays
  // because it is the cheap check that the account is genuinely running rather
  // than merely reporting active for an instant: an invoice left unpaid is
  // voided by Stripe after 23 hours and the subscription falls back to paused,
  // and this advance is what would expose that.
  await advanceTo(clock.id, clock.frozen_time + 31 * DAY + 3600, 'day 31 + 1h');
  await settle(runStartedAt, 8000, 90000);
  byStage['resumption charged'] = printEvents('resumption charged', await eventsSince(runStartedAt), seen);
  printSnapshot('resumption charged', dbSnapshot(org.id));

  const subFinal = await stripe.subscriptions.retrieve(sub.id);
  const cust = await stripe.customers.retrieve(customer.id);
  console.log(`   STRIPE SUBSCRIPTION: status=${subFinal.status} pause_collection=${JSON.stringify(subFinal.pause_collection)}`);
  console.log(`   DEFAULT PAYMENT METHOD: ${cust.invoice_settings && cust.invoice_settings.default_payment_method}`);
  const invs = await stripe.invoices.list({ customer: customer.id, limit: 10 });
  for (const inv of invs.data) {
    console.log(`   INVOICE ${inv.id}  status=${inv.status}  subtotal=${inv.subtotal} tax=${inv.tax} total=${inv.total} paid=${inv.amount_paid} ${inv.currency.toUpperCase()}  reason=${inv.billing_reason}`);
  }

  // --- the acceptance check ------------------------------------------------
  hr('ACCEPTANCE');
  const finalSnap = dbSnapshot(org.id);
  const paidInvoice = invs.data.find((i) => i.amount_paid > 0);
  const checks = [
    ['subscription status is active', subFinal.status === 'active'],
    ['card is the default payment method', !!(cust.invoice_settings && cust.invoice_settings.default_payment_method)],
    ['an invoice was PAID', !!paidInvoice],
    ['invoice is EUR 49 + VAT', !!paidInvoice && paidInvoice.subtotal === 4900 && paidInvoice.tax > 0],
    ['app records status active', finalSnap.status === 'active'],
    ['app entitlement is FULL', require('../src/services/entitlements').entitlementForOrg(db.getOrgBilling(org.id)) === 'full'],
  ];
  let allOk = true;
  for (const [label, ok] of checks) { console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) allOk = false; }
  if (!allOk) process.exitCode = 1;

  // --- comparison ----------------------------------------------------------
  hr('STUB MODEL vs WHAT STRIPE ACTUALLY SENT');
  console.log('Differences are REPORTED, not reconciled. src/routes/trialClock.test.js');
  console.log('is a claim about Stripe; this is the claim checked against Stripe.\n');
  for (const [stage, modelled] of Object.entries(STUB_MODEL)) {
    const actual = byStage[stage] || [];
    const actualSet = [...new Set(actual)];
    console.log(`STAGE: ${stage}`);
    console.log(`   stub models : ${modelled.join(', ')}`);
    console.log(`   stripe sent : ${actualSet.length ? actualSet.join(', ') : '(none)'}`);
    const missing = modelled.filter((t) => t.startsWith('customer') || t.startsWith('invoice') || t.startsWith('payment'))
      .filter((t) => !actualSet.includes(t));
    const extra = actualSet.filter((t) => !modelled.includes(t));
    if (missing.length) console.log(`   MODELLED BUT NOT SENT : ${missing.join(', ')}`);
    if (extra.length) console.log(`   SENT BUT NOT MODELLED : ${extra.join(', ')}`);
    if (!missing.length && !extra.length) console.log('   (match)');
    console.log();
  }

  hr('TOTALS');
  const all = await eventsSince(runStartedAt);
  const counts = {};
  for (const e of all) counts[e.type] = (counts[e.type] || 0) + 1;
  console.log(`Stripe emitted ${all.length} events across the run:`);
  for (const [t, n] of Object.entries(counts).sort()) console.log(`   ${String(n).padStart(3)}  ${t}`);
  const modelledTypes = new Set(Object.values(STUB_MODEL).flat().filter((t) => t.includes('.')));
  console.log(`\nThe stub models ${modelledTypes.size} distinct types; Stripe sent ${Object.keys(counts).length}.`);

  await cleanup(org.id);
}

main().catch(async (err) => {
  console.error('\nFAILED:', err.message);
  try {
    const o = db.getDb().prepare('SELECT id FROM organizations WHERE name = ?').get(MARKER);
    await cleanup(o ? o.id : null);
  } catch (cleanupErr) {
    // Never silent. The previous version swallowed this and still exited 0,
    // which is how a live test clock survived a "successful" run.
    console.error('*** CLEANUP ALSO FAILED:', cleanupErr.message);
    console.error('*** Run:  node scripts/trial-clock-check.js --cleanup');
  }
  process.exit(1);
});
