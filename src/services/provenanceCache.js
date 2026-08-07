'use strict';

/**
 * src/services/provenanceCache.js
 *
 * Server-side binding for a single analysis's provenance (extraction facts +
 * the exact weights the engine applied + the scorer's identity). The
 * analyze -> save flow is stateless HTTP from the client's perspective:
 * /api/analyze mints an opaque analysisId per scored result, returns it, and
 * the client echoes it back when saving an audit record. The server remembers
 * every record it issues, keyed by (orgId, analysisId), and the save persists
 * the SERVER-HELD copy — the client echo is only a lookup key.
 *
 * Keyed by analysisId, NOT textSha256: the same CV analysed twice under
 * different weights produces two records (two analysisIds), so saving the first
 * result records the first analysis's weights. A textSha256 key would collide
 * (same CV -> same key) and let a later analysis clobber an earlier one's
 * weights — the last-writer-wins bug this replaces.
 *
 * BACKED BY SQLITE, on the same database (and therefore the same persistent
 * disk) as everything else. It was an in-memory Map, which meant every deploy
 * and every idle spin-down voided all outstanding bindings: the save that
 * followed recorded the client's numbers as fact and said nothing. Restarts
 * are routine, so that was the common case rather than the edge one. WAL
 * checkpointing and graceful shutdown cover this table automatically, because
 * it shares the single handle from db.getDb().
 *
 * Bounds are now TTL-only. The old 5000-entry cap was a memory constraint and
 * is deliberately gone: remember() is called once per candidate, so a single
 * 200-CV batch wrote 200 entries and a busy org would evict its own oldest
 * bindings — precisely the ones a recruiter saves first, working top-down
 * through a ranked list. On disk a row is a few hundred bytes; the TTL and the
 * sweep are the right bound.
 */

// Lazily required: db.js resolves DATABASE_PATH at module load, and tests set
// that env var before requiring anything. Touching it at import time here
// would open the wrong database.
function db() {
  return require('./db').getDb();
}

const TTL_MS = 24 * 60 * 60 * 1000;            // provenance is claimable for 24h after analysis
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;      // hourly expiry sweep

// The exact key set a provenance record may carry. remember() rejects anything
// else, which is the guard against the bug this replaced: a spread and a
// literal sharing `engineVersion`, where the extractor's version was silently
// overwritten by the scorer's. A typo or a reintroduced spread now fails loudly
// at the point of writing rather than producing a plausible-looking record.
const ALLOWED_KEYS = Object.freeze([
  'analysisId',
  'extractorEngine', 'extractorVersion', 'assemblerVersion',
  'textSha256', 'pageCount', 'charCount',
  'scorerEngine', 'scorerVersion', 'scoringWeights',
]);

/**
 * Store the provenance for one analysis. Called by /api/analyze for every
 * scored result it returns.
 *
 * Idempotent per (orgId, analysisId): a re-issue replaces and re-dates the row
 * rather than erroring, matching the Map's set() semantics.
 */
function remember(orgId, record) {
  if (!orgId || !record || typeof record.analysisId !== 'string') return;

  const unexpected = Object.keys(record).filter((k) => !ALLOWED_KEYS.includes(k));
  if (unexpected.length) {
    // Loud, but not fatal to the analysis the user is waiting on: drop the
    // binding rather than serve a 500, and make the cause obvious in the logs.
    console.error('[provenance] refusing to store a record with unexpected keys',
      { orgId, analysisId: record.analysisId, unexpected });
    return;
  }

  const now = Date.now();
  db().prepare(`
    INSERT INTO analysis_provenance (org_id, analysis_id, payload, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(org_id, analysis_id) DO UPDATE SET
      payload = excluded.payload, created_at = excluded.created_at, expires_at = excluded.expires_at
  `).run(orgId, record.analysisId, JSON.stringify(record), now, now + TTL_MS);
}

/**
 * Resolve an echoed analysisId to the server-held record for this org, or null
 * if the server never issued it or it has expired.
 *
 * Signature unchanged from the in-memory version, so callers did not change.
 * Expired rows are deleted on read, mirroring the Map's delete-on-expiry — but
 * an analysis that is never saved is never read, which is why the periodic
 * sweep below also exists.
 */
function lookup(orgId, analysisId) {
  if (!orgId || typeof analysisId !== 'string') return null;
  const row = db().prepare(
    'SELECT payload, expires_at AS expiresAt FROM analysis_provenance WHERE org_id = ? AND analysis_id = ?',
  ).get(orgId, analysisId);
  if (!row) return null;
  if (Date.now() > row.expiresAt) {
    db().prepare('DELETE FROM analysis_provenance WHERE org_id = ? AND analysis_id = ?')
      .run(orgId, analysisId);
    return null;
  }
  try {
    return JSON.parse(row.payload);
  } catch (err) {
    // Unparseable payload is corruption, not a miss: say so, then fail closed.
    console.error('[provenance] stored payload is not valid JSON — treating as unbound',
      { orgId, analysisId, message: err && err.message });
    return null;
  }
}

/**
 * Delete every expired binding. Returns the number removed.
 *
 * Deliberately NOT routed through runRetentionPurge(): that path is gated
 * behind RETENTION_PURGE_MODE and defaults to a dry run, because it deletes
 * candidate data and must not act by accident. This is cache eviction of the
 * server's own short-lived records, and must not inherit a safety flag that
 * exists to protect something else.
 */
function sweepExpired(now = Date.now()) {
  const info = db().prepare('DELETE FROM analysis_provenance WHERE expires_at <= ?').run(now);
  return info.changes || 0;
}

let sweepTimer = null;
function startProvenanceSweep() {
  if (sweepTimer) return;
  const tick = () => {
    try {
      const removed = sweepExpired();
      if (removed) console.log(`[provenance] swept ${removed} expired binding(s)`);
    } catch (err) {
      console.error('[provenance] sweep failed:', err && err.message);
    }
  };
  sweepTimer = setInterval(tick, SWEEP_INTERVAL_MS);
  sweepTimer.unref();
  tick(); // clear anything left over from a previous run on boot
}

function stopProvenanceSweep() {
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
}

// Test-only: the row count, for asserting the sweep actually removes things.
function _count() {
  return db().prepare('SELECT COUNT(*) AS c FROM analysis_provenance').get().c;
}

module.exports = {
  remember, lookup,
  sweepExpired, startProvenanceSweep, stopProvenanceSweep,
  TTL_MS, SWEEP_INTERVAL_MS, ALLOWED_KEYS, _count,
};
