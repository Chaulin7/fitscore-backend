'use strict';

/**
 * src/services/metricsSchedule.js — the daily metrics_daily snapshot timer.
 *
 * Kept apart from services/metrics.js so that module stays what its header
 * claims: read-only functions with no timers and no lifecycle. A test that
 * wants to call planBreakdown() should not have to think about whether
 * requiring it started a background job.
 *
 * NO EXTERNAL CRON. Render's free tier has no scheduler, and a cron-triggered
 * HTTP endpoint would be a second, unauthenticated way to reach this. A plain
 * setInterval inside the process is sufficient because the job is idempotent —
 * see runDailySnapshot: today's row is an upsert of absolute values, and missed
 * days are reconstructed from created_at columns still on disk. A restart-heavy
 * deploy day converges on exactly the same table as a process that ran for a
 * month.
 *
 * The timer is .unref()'d, matching startWalCheckpointing / startRetentionSchedule
 * / startProvenanceSweep — a snapshot job must never be the reason the process
 * refuses to exit.
 */

const metrics = require('./metrics');
const stripeReconcile = require('./stripeReconcile');
const { getDb } = require('./db');

const SNAPSHOT_INTERVAL_MS = 24 * 60 * 60 * 1000;

let snapshotTimer = null;

/**
 * Run the job once, swallowing failures.
 *
 * A snapshot is reporting, not product behaviour. If it throws — a locked
 * database, a disk that filled up — the right outcome is a loud log line and a
 * server that keeps screening CVs, not a crashed process. The next tick tries
 * again, and the backfill means the missed day is recovered rather than lost.
 */
function runSnapshotSafely() {
  try {
    const result = metrics.runDailySnapshot();
    console.log('[metrics] daily snapshot written', result);
    return result;
  } catch (err) {
    console.error('[metrics] daily snapshot failed:', err && err.message);
    return null;
  }
}

/**
 * Reconcile against Stripe and store the result for the page to read.
 *
 * This is the PASSIVE half of the drift feature. The admin page renders
 * drift_count and drift_checked_at straight out of metrics_daily and makes no
 * API call of its own; ?reconcile=1 remains the on-demand full check, with the
 * itemised findings this only counts.
 *
 * Self-gating on DRIFT_MIN_GAP_MS. The snapshot job runs on every boot, and a
 * Render deploy is a boot — without the gate, a busy afternoon of deploys would
 * be a dozen full sweeps of the Stripe API.
 *
 * On failure the previous count and timestamp are LEFT ALONE and only the error
 * is recorded. Writing a zero would say "checked, nothing wrong" about a check
 * that never happened, and that is the one wrong answer here: it is
 * indistinguishable from good news.
 */
async function runDriftCheckSafely(now = Date.now()) {
  try {
    if (!metrics.driftCheckDue(now)) return null;

    const result = await stripeReconcile.reconcile();
    if (!result.configured) {
      // Not an outage — this deployment has no Stripe keys. Recorded as an
      // error rather than as zero drift, for the same reason a failure is.
      metrics.recordDriftFailure(result.error);
      return null;
    }

    const stored = metrics.recordDriftCheck(result.driftCount);
    console.log('[metrics] drift check stored', {
      ...stored, checked: result.checked, cancelFlagsWritten: result.cancelFlagsWritten,
    });
    return stored;
  } catch (err) {
    const message = err && err.message ? err.message : 'unknown error';
    console.error('[metrics] drift check failed — previous count left intact:', message);
    try { metrics.recordDriftFailure(message); } catch (_) { /* nothing left to do */ }
    return null;
  }
}

/**
 * One tick: the local snapshot first, then the network-dependent drift check.
 *
 * Ordered so a Stripe outage can never cost the snapshot. runSnapshotSafely is
 * synchronous and has already committed by the time the await below is reached.
 */
async function runTick() {
  runSnapshotSafely();
  await runDriftCheckSafely();
}

/** Start the schedule. Idempotent — safe to call more than once. */
function startMetricsSnapshotSchedule() {
  if (snapshotTimer) return;
  getDb(); // ensure the schema exists before the first write
  snapshotTimer = setInterval(() => { runTick(); }, SNAPSHOT_INTERVAL_MS);
  snapshotTimer.unref();
  // On boot, so a fresh deploy has today's row immediately. Deliberately not
  // awaited: the drift check talks to Stripe over the network and the server
  // must start accepting traffic without waiting on a third party.
  runTick();
}

function stopMetricsSnapshotSchedule() {
  if (snapshotTimer) { clearInterval(snapshotTimer); snapshotTimer = null; }
}

module.exports = {
  SNAPSHOT_INTERVAL_MS,
  runSnapshotSafely,
  runDriftCheckSafely,
  runTick,
  startMetricsSnapshotSchedule,
  stopMetricsSnapshotSchedule,
};
