'use strict';

/**
 * src/routes/analyzeQuota.test.js
 *
 * The Free-tier monthly quota, tested at the two levels that matter.
 *
 * Discovery for the limit change turned up that nothing anywhere asserted the
 * quota BOUNDARY. Everything asserted around it — that a free org reports the
 * free limit, that an over-quota meter clamps — but not the one property the
 * whole feature exists for: that the Nth analysis is allowed and the N+1th is
 * not. A limit that is off by one in either direction would have passed the
 * entire suite.
 *
 * Two levels, deliberately:
 *
 *   1. reserveUsage() — the atomic gate itself. Fast and exact, so this is
 *      where the full 1..N sequence is walked one analysis at a time, and
 *      where the "a batch is rejected whole" property is pinned. That property
 *      is a transaction guarantee, not a route behaviour: the route never sees
 *      a partial reservation because the reservation either commits entirely
 *      or not at all.
 *
 *   2. POST /api/analyze and /batch over real HTTP, through requireSession and
 *      the real router — because "the gate is server-side" is a claim about
 *      the wire, not about a function. These assert the 402 QUOTA_EXCEEDED
 *      contract a client actually receives.
 *
 * Every assertion reads FREE_MONTHLY_LIMIT rather than a literal. The point of
 * the test is the boundary, wherever it currently sits; hardcoding the number
 * here would mean changing the limit requires editing the test that is
 * supposed to be guarding it.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// Before services/db is first required — it reads DATABASE_PATH at module load.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cvs-quota-'));
process.env.DATABASE_PATH = path.join(TMP_DIR, 'test.db');

const express = require('express');
const db = require('../services/db');
const auth = require('../services/authService');
const analyzeRouter = require('./analyze');
const { requireSession } = require('../middleware/auth');
const { FREE_MONTHLY_LIMIT } = require('../config/plans');

const LIMIT = FREE_MONTHLY_LIMIT;

// A real PDF that extracts cleanly, so a permitted analysis actually succeeds
// rather than passing the gate and then failing for an unrelated reason.
const GOOD_CV = path.join(__dirname, '..', '..', 'test', 'fixtures', 'cv_single_column.pdf');
// >= 50 chars, or validateJobDescription rejects before the gate is reached.
const JD = 'Senior backend engineer with strong Node.js and SQL experience, '
  + 'responsible for API design, data modelling and production operations.';

const ORG_FREE = 'org-free';
const ORG_PRO = 'org-pro';
const TOKENS = {};

let app;
let server;
let base;

before(async () => {
  db.getDb();
  const now = new Date().toISOString();
  const insertOrg = db.getDb().prepare('INSERT INTO organizations (id, name, created_at) VALUES (?, ?, ?)');
  insertOrg.run(ORG_FREE, 'Free Co', now);
  insertOrg.run(ORG_PRO, 'Pro Co', now);

  const insertUser = db.getDb().prepare(
    'INSERT INTO users (id, org_id, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  insertUser.run('u-free', ORG_FREE, 'owner@free.example', 'x', 'owner', now);
  insertUser.run('u-pro', ORG_PRO, 'owner@pro.example', 'x', 'owner', now);
  TOKENS['u-free'] = auth.createSession('u-free').rawToken;
  TOKENS['u-pro'] = auth.createSession('u-pro').rawToken;

  db.setOrgPlan(ORG_PRO, { plan: 'pro', subscriptionStatus: 'active', currentPeriodEnd: null });

  app = express();
  // Mounted as src/index.js mounts it, minus the generic express-rate-limit
  // burst guard: that is an orthogonal abuse control with its own coverage, and
  // including it would make this file's pass/fail depend on request timing.
  // requireSession IS included — the gate reads req.orgId, which it sets, and
  // an org id that came from the session rather than the request is the whole
  // reason the quota cannot be moved by a client.
  app.use('/api/analyze', requireSession, analyzeRouter);
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  try { server.close(); } catch (_) { /* already closed */ }
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) { /* best effort */ }
});

/** Wipe the org's counter so each test starts from a known position. */
function resetUsage(orgId) {
  db.getDb().prepare('DELETE FROM usage_counters WHERE org_id = ?').run(orgId);
}
const usage = (orgId) => db.getUsageCount(orgId);

beforeEach(() => { resetUsage(ORG_FREE); resetUsage(ORG_PRO); });

function fileBlob(absPath, name, type = 'application/pdf') {
  return new File([fs.readFileSync(absPath)], name, { type });
}

async function postAnalyze(user, blob) {
  const form = new FormData();
  form.set('cv', blob || fileBlob(GOOD_CV, 'cv.pdf'));
  form.set('jobDescription', JD);
  const res = await fetch(`${base}/api/analyze`, {
    method: 'POST', headers: { Authorization: `Bearer ${TOKENS[user]}` }, body: form,
  });
  return { status: res.status, body: await res.json() };
}

async function postBatch(user, count) {
  const form = new FormData();
  for (let i = 0; i < count; i += 1) form.append('cvs', fileBlob(GOOD_CV, `cv-${i}.pdf`));
  form.set('jobDescription', JD);
  const res = await fetch(`${base}/api/analyze/batch`, {
    method: 'POST', headers: { Authorization: `Bearer ${TOKENS[user]}` }, body: form,
  });
  return { status: res.status, body: await res.json() };
}

// ---------------------------------------------------------------------------
// 1. The gate itself.
// ---------------------------------------------------------------------------

describe('reserveUsage: the boundary is exactly the limit', () => {
  test(`${LIMIT} single analyses are allowed, the ${LIMIT + 1}th is not`, () => {
    for (let i = 1; i <= LIMIT; i += 1) {
      const r = db.reserveUsage(ORG_FREE, 1, LIMIT);
      assert.equal(r.ok, true, `analysis #${i} of ${LIMIT} should be allowed`);
      assert.equal(r.used, i, `counter should read ${i} after analysis #${i}`);
    }
    const over = db.reserveUsage(ORG_FREE, 1, LIMIT);
    assert.equal(over.ok, false, `analysis #${LIMIT + 1} must be refused`);
    assert.equal(over.used, LIMIT, 'a refusal reports the count, and does not increment it');
    assert.equal(usage(ORG_FREE), LIMIT, 'a refused analysis must not consume quota');
  });

  test('a batch that would cross the limit is refused whole', () => {
    db.reserveUsage(ORG_FREE, LIMIT - 2, LIMIT);
    // Three more against two remaining: the partial-consumption bug would take
    // the two it can and bill for them. It must take none.
    const r = db.reserveUsage(ORG_FREE, 3, LIMIT);
    assert.equal(r.ok, false);
    assert.equal(usage(ORG_FREE), LIMIT - 2, 'a refused batch must consume nothing at all');

    // ...and the headroom it declined to use is still there afterwards.
    assert.equal(db.reserveUsage(ORG_FREE, 2, LIMIT).ok, true);
    assert.equal(usage(ORG_FREE), LIMIT);
  });

  test('a batch landing exactly on the limit is allowed', () => {
    const r = db.reserveUsage(ORG_FREE, LIMIT, LIMIT);
    assert.equal(r.ok, true, 'the limit is inclusive: N is allowed, N+1 is not');
    assert.equal(usage(ORG_FREE), LIMIT);
  });

  test('a null limit (Pro/Team) still counts but never refuses', () => {
    const r = db.reserveUsage(ORG_PRO, LIMIT + 500, null);
    assert.equal(r.ok, true);
    assert.equal(usage(ORG_PRO), LIMIT + 500, 'unlimited means uncapped, not unmetered');
  });

  test('refundUsage returns quota and floors at zero', () => {
    db.reserveUsage(ORG_FREE, LIMIT, LIMIT);
    db.refundUsage(ORG_FREE, 4);
    assert.equal(usage(ORG_FREE), LIMIT - 4);
    // Headroom is genuinely restored, not merely displayed.
    assert.equal(db.reserveUsage(ORG_FREE, 4, LIMIT).ok, true);

    db.refundUsage(ORG_FREE, LIMIT + 100);
    assert.equal(usage(ORG_FREE), 0, 'a refund must never drive the counter negative');
  });

  test('the counter is per period, so a new month starts clear', () => {
    db.reserveUsage(ORG_FREE, LIMIT, LIMIT, '2026-09');
    assert.equal(db.reserveUsage(ORG_FREE, 1, LIMIT, '2026-09').ok, false);
    assert.equal(db.reserveUsage(ORG_FREE, 1, LIMIT, '2026-10').ok, true, 'October must not inherit September');
    assert.equal(db.getUsageCount(ORG_FREE, '2026-09'), LIMIT, 'and must not disturb it either');
  });

  test('the counter is per org, so one tenant cannot exhaust another', () => {
    db.reserveUsage(ORG_FREE, LIMIT, LIMIT);
    assert.equal(db.reserveUsage(ORG_PRO, 1, LIMIT).ok, true);
  });
});

// ---------------------------------------------------------------------------
// 2. The wire.
// ---------------------------------------------------------------------------

describe('POST /api/analyze: the 402 a client actually receives', () => {
  test(`the ${LIMIT}th analysis succeeds and the ${LIMIT + 1}th is refused`, async () => {
    // Positioned one below the cap, so the next request IS the Nth.
    db.reserveUsage(ORG_FREE, LIMIT - 1, LIMIT);

    const nth = await postAnalyze('u-free');
    assert.equal(nth.status, 200, `analysis #${LIMIT} must be allowed: ${JSON.stringify(nth.body)}`);
    assert.equal(usage(ORG_FREE), LIMIT);

    const over = await postAnalyze('u-free');
    assert.equal(over.status, 402, `analysis #${LIMIT + 1} must be refused`);
    assert.equal(over.body.code, 'QUOTA_EXCEEDED');
    assert.equal(over.body.limit, LIMIT);
    assert.equal(over.body.used, LIMIT);
    assert.equal(over.body.plan, 'free');
    assert.equal(usage(ORG_FREE), LIMIT, 'the refused request must not have consumed quota');
  });

  test('a batch that would cross the limit is refused whole over HTTP', async () => {
    db.reserveUsage(ORG_FREE, LIMIT - 2, LIMIT);
    const res = await postBatch('u-free', 3);
    assert.equal(res.status, 402);
    assert.equal(res.body.code, 'QUOTA_EXCEEDED');
    assert.equal(usage(ORG_FREE), LIMIT - 2, 'no part of a refused batch may be billed');
  });

  test('a batch that fits exactly is accepted', async () => {
    db.reserveUsage(ORG_FREE, LIMIT - 2, LIMIT);
    const res = await postBatch('u-free', 2);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(usage(ORG_FREE), LIMIT);
  });

  test('an unlimited plan is not refused at the free limit', async () => {
    db.reserveUsage(ORG_PRO, LIMIT + 50, null);
    const res = await postAnalyze('u-pro');
    assert.equal(res.status, 200, 'a Pro org past the free cap must still analyse');
  });

  test('the quota cannot be moved by the client', async () => {
    // The org is taken from the session, and the limit from server config, so
    // there is nothing in a request a caller could set to raise either. Sending
    // the fields anyway must change nothing.
    db.reserveUsage(ORG_FREE, LIMIT, LIMIT);
    const form = new FormData();
    form.set('cv', fileBlob(GOOD_CV, 'cv.pdf'));
    form.set('jobDescription', JD);
    form.set('limit', String(LIMIT + 1000));
    form.set('plan', 'pro');
    form.set('orgId', ORG_PRO);
    const res = await fetch(`${base}/api/analyze`, {
      method: 'POST', headers: { Authorization: `Bearer ${TOKENS['u-free']}` }, body: form,
    });
    const body = await res.json();
    assert.equal(res.status, 402, 'client-supplied plan/limit/orgId must be ignored');
    assert.equal(body.limit, LIMIT);
    assert.equal(body.plan, 'free');
  });

  test('an unauthenticated request never reaches the gate', async () => {
    const form = new FormData();
    form.set('cv', fileBlob(GOOD_CV, 'cv.pdf'));
    form.set('jobDescription', JD);
    const res = await fetch(`${base}/api/analyze`, { method: 'POST', body: form });
    assert.equal(res.status, 401);
    assert.equal(usage(ORG_FREE), 0);
  });
});

describe('a failed analysis does not consume quota', () => {
  test('a file that fails extraction is refunded', async () => {
    db.reserveUsage(ORG_FREE, 5, LIMIT);
    // Passes multer's extension/mimetype filter, fails the authoritative
    // magic-byte check inside validateAndExtract — which is the branch that
    // refunds. A customer must not be billed for a file the server refused.
    const notAPdf = new File([Buffer.from('this is not a PDF at all')], 'broken.pdf', { type: 'application/pdf' });
    const res = await postAnalyze('u-free', notAPdf);

    assert.ok(res.status >= 400 && res.status < 500, `expected a client error, got ${res.status}`);
    assert.notEqual(res.status, 402, 'this must fail on the file, not the quota');
    assert.equal(usage(ORG_FREE), 5, 'a rejected file must leave the counter where it was');
  });

  test('a failed analysis at the boundary leaves the last slot usable', async () => {
    // The regression this guards: burning the final analysis on a file the
    // server itself rejected would lock the org out for the rest of the month.
    db.reserveUsage(ORG_FREE, LIMIT - 1, LIMIT);
    const notAPdf = new File([Buffer.from('still not a PDF')], 'broken.pdf', { type: 'application/pdf' });
    const failed = await postAnalyze('u-free', notAPdf);
    assert.notEqual(failed.status, 402);
    assert.equal(usage(ORG_FREE), LIMIT - 1, 'the reservation must have been returned');

    const good = await postAnalyze('u-free');
    assert.equal(good.status, 200, 'the last slot must still be usable after a failed upload');
  });
});
