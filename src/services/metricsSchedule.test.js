'use strict';

/**
 * src/services/metricsSchedule.test.js — the nightly job's wiring.
 *
 * The behaviour under test is what happens when Stripe DOESN'T answer. A drift
 * check that fails and writes zero is worse than one that never ran: zero reads
 * as "checked, everything agrees", which is indistinguishable from good news
 * and is the exact moment an operator stops looking.
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cvsprings-msched-test-'));
process.env.DATABASE_PATH = path.join(TMP_DIR, 'msched-test.db');

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { getDb, closeDb } = require('./db');
const metrics = require('./metrics');
const stripeReconcile = require('./stripeReconcile');
const schedule = require('./metricsSchedule');

const TODAY = new Date().toISOString().slice(0, 10);
const realReconcile = stripeReconcile.reconcile;

before(() => {
  getDb();
  getDb().prepare('INSERT INTO organizations (id, name, created_at) VALUES (?,?,?)')
    .run('org-1', 'Org One', new Date().toISOString());
});

after(() => {
  stripeReconcile.reconcile = realReconcile;
  schedule.stopMetricsSnapshotSchedule();
  closeDb();
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

beforeEach(() => { getDb().prepare('DELETE FROM metrics_daily').run(); });

describe('nightly drift check', () => {
  test('a successful check is stored for the page to read', async () => {
    stripeReconcile.reconcile = async () => ({
      configured: true, checked: 12, capped: false, findings: [], error: null,
      cancelFlagsWritten: 3, driftCount: 5,
    });
    await schedule.runDriftCheckSafely();

    const d = metrics.latestDriftCheck();
    assert.equal(d.count, 5);
    assert.ok(d.checkedAt);
    assert.equal(d.error, null);
  });

  test('a thrown Stripe error leaves the previous count intact', async () => {
    metrics.recordDriftCheck(5, TODAY, '2020-01-01T00:00:00.000Z'); // old enough to be due
    stripeReconcile.reconcile = async () => { throw new Error('connect ETIMEDOUT api.stripe.com'); };

    await schedule.runDriftCheckSafely();

    const d = metrics.latestDriftCheck();
    assert.equal(d.count, 5, 'a failed check overwrote a real count');
    assert.equal(d.checkedAt, '2020-01-01T00:00:00.000Z', 'a failed check moved the timestamp');
    assert.match(d.error, /ETIMEDOUT/);

    // And the stored column itself is untouched — not zero, not null.
    const row = getDb().prepare('SELECT * FROM metrics_daily WHERE date = ?').get(TODAY);
    assert.equal(row.drift_count, 5);
    assert.notEqual(row.drift_count, 0);
    assert.ok(row.drift_error);
  });

  test('an unconfigured Stripe is recorded as a failure, not as zero drift', async () => {
    metrics.recordDriftCheck(2, TODAY, '2020-01-01T00:00:00.000Z');
    stripeReconcile.reconcile = async () => ({
      configured: false, checked: 0, capped: false, findings: [],
      error: 'Stripe is not configured on this deployment (STRIPE_SECRET_KEY unset).',
    });

    await schedule.runDriftCheckSafely();

    const d = metrics.latestDriftCheck();
    assert.equal(d.count, 2, 'an unconfigured deployment reported itself as clean');
    assert.match(d.error, /not configured/);
  });

  test('a genuine zero IS stored — clean is a real answer', async () => {
    stripeReconcile.reconcile = async () => ({
      configured: true, checked: 12, capped: false, findings: [], error: null,
      cancelFlagsWritten: 0, driftCount: 0,
    });
    getDb().prepare('DELETE FROM metrics_daily').run();

    await schedule.runDriftCheckSafely();

    const d = metrics.latestDriftCheck();
    assert.equal(d.count, 0);
    assert.equal(d.error, null, 'a clean check still reported an error');
  });

  test('the check self-gates rather than sweeping Stripe on every deploy', async () => {
    let calls = 0;
    stripeReconcile.reconcile = async () => {
      calls += 1;
      return { configured: true, checked: 1, capped: false, findings: [], error: null, cancelFlagsWritten: 0, driftCount: 0 };
    };
    getDb().prepare('DELETE FROM metrics_daily').run();

    await schedule.runDriftCheckSafely();          // due — never checked
    await schedule.runDriftCheckSafely();          // not due — just ran
    await schedule.runDriftCheckSafely();          // still not due
    assert.equal(calls, 1, 'a deploy-heavy afternoon would be a dozen Stripe sweeps');

    // Past the gap, it runs again.
    await schedule.runDriftCheckSafely(Date.now() + metrics.DRIFT_MIN_GAP_MS + 1000);
    assert.equal(calls, 2);
  });

  test('a Stripe outage never costs the local snapshot', async () => {
    stripeReconcile.reconcile = async () => { throw new Error('stripe is down'); };
    getDb().prepare('DELETE FROM metrics_daily').run();

    await schedule.runTick();

    // The snapshot is synchronous and commits before the network call is even
    // reached, so the local figures land regardless.
    const row = getDb().prepare('SELECT * FROM metrics_daily WHERE date = ?').get(TODAY);
    assert.ok(row, 'the snapshot was lost to a Stripe failure');
    assert.equal(row.total_accounts, 1);
    assert.ok(row.drift_error);
  });
});
