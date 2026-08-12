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

// 30 days, up from 24 hours.
//
// The TTL used to be a cache bound: an expired entry degraded the save to
// client-supplied values. It is now a DEADLINE — the record is the sole source
// for the audit row, so expiry rejects the save outright. That changes what the
// number has to be sized against: not the median analyse->save gap but the
// slowest legitimate one. A Friday-afternoon batch reviewed on Monday already
// breaks 24h; a shortlist that goes to a hiring manager and comes back breaks a
// week. 30 days covers a hiring cycle including holidays.
//
// Cost is small: a payload is roughly 600-800 bytes, so 10k analyses/month
// retains ~8MB and 100k/month ~80MB, and the sweep is indexed on expires_at.
// Well below the 180-day retention floor for audit data.
//
// This is a judgement call with no operational evidence behind it. Every
// fail-closed rejection logs its analyse->save gap (see routes/audit.js) so the
// number can be revisited against real usage rather than re-guessed.
const TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;      // hourly expiry sweep

// The shape of the stored payload. Bumped when the key set changes in a way
// that makes an older payload unusable for an audit write — which is exactly
// what happened here: payloads written before field binding hold scoring INPUTS
// only, and an audit row now needs the OUTPUTS too. A row carrying an older
// version is not a cache miss and must not be reported as one; the save is
// rejected with its own code so a customer can be told what actually happened.
const PAYLOAD_VERSION = 1;

// The exact key set a provenance record may carry. remember() rejects anything
// else, which is the guard against the bug this replaced: a spread and a
// literal sharing `engineVersion`, where the extractor's version was silently
// overwritten by the scorer's. A typo or a reintroduced spread now fails loudly
// at the point of writing rather than producing a plausible-looking record.
//
// Extended for field binding: the audit row is now written ENTIRELY from this
// record plus the recruiter's own input, so every field the row needs has to be
// here. Scoring outputs (overall/scores/verdict) and the anonymisation flag
// were previously computed server-side and thrown away, leaving the client to
// assert them at save time.
const ALLOWED_KEYS = Object.freeze([
  'analysisId', 'bindingVersion',
  // Extraction facts — which reader turned the file into text.
  'extractorEngine', 'extractorVersion', 'assemblerVersion',
  'textSha256', 'pageCount', 'charCount',
  // Scoring inputs — which engine, under which weights.
  'scorerEngine', 'scorerVersion', 'scoringWeights',
  // Scoring outputs — what the engine actually produced.
  'overall', 'scores', 'verdict', 'analysisDetail',
  // Analysis context the row records as fact.
  'anonymized', 'candidateName', 'fileName', 'jdSnippet',
  'modelId', 'analysisTimestamp', 'appVersion',
]);

/**
 * Store the provenance for one analysis. Called by /api/analyze for every
 * scored result it returns.
 *
 * Idempotent per (orgId, analysisId): a re-issue replaces and re-dates the row
 * rather than erroring, matching the Map's set() semantics.
 */
const INSERT_SQL = `
  INSERT INTO analysis_provenance (org_id, analysis_id, payload, created_at, expires_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(org_id, analysis_id) DO UPDATE SET
    payload = excluded.payload, created_at = excluded.created_at, expires_at = excluded.expires_at
`;

// Keys outside ALLOWED_KEYS, or [] when the record is clean.
function unexpectedKeys(record) {
  return Object.keys(record).filter((k) => !ALLOWED_KEYS.includes(k));
}

function remember(orgId, record) {
  if (!orgId || !record || typeof record.analysisId !== 'string') return;

  const unexpected = unexpectedKeys(record);
  if (unexpected.length) {
    // Loud, but not fatal to the analysis the user is waiting on: drop the
    // binding rather than serve a 500, and make the cause obvious in the logs.
    console.error('[provenance] refusing to store a record with unexpected keys',
      { orgId, analysisId: record.analysisId, unexpected });
    return;
  }

  const now = Date.now();
  db().prepare(INSERT_SQL)
    .run(orgId, record.analysisId, JSON.stringify(record), now, now + TTL_MS);
}

/**
 * Store the provenance for a whole batch, atomically.
 *
 * One transaction, so an interrupted batch — deploy, crash, spin-down — leaves
 * EVERY candidate unbound rather than an arbitrary prefix bound and the rest
 * not. A partial prefix is the worst outcome available: the saves that follow
 * would be vouched for some candidates and silently client-asserted for the
 * others, with nothing on the record to say which were which.
 *
 * Callers must collect the records and call this AFTER their async work: a
 * better-sqlite3 transaction is synchronous and cannot span an await. It throws
 * "Transaction function cannot return a promise" if you try — and the writes
 * still land, one at a time, outside the transaction.
 *
 * Validates the whole set BEFORE opening the transaction. Unlike remember(),
 * which logs and drops a single malformed record, one bad record here aborts
 * the batch: an all-or-nothing set must not ship with a silent hole in it.
 *
 * @throws if any record is malformed, or if the commit fails
 * @returns {number} records written
 */
function rememberMany(orgId, records) {
  if (!orgId || !Array.isArray(records) || records.length === 0) return 0;

  for (const rec of records) {
    if (!rec || typeof rec.analysisId !== 'string') {
      throw new Error('provenance batch contains a record with no analysisId');
    }
    const unexpected = unexpectedKeys(rec);
    if (unexpected.length) {
      throw new Error(
        `provenance batch record ${rec.analysisId} has unexpected keys: ${unexpected.join(', ')}`,
      );
    }
  }

  const now = Date.now();
  const stmt = db().prepare(INSERT_SQL);
  // Serialising inside the transaction means a payload that cannot be
  // stringified rolls the whole batch back, rather than binding the records
  // that happened to come before it.
  const tx = db().transaction((recs) => {
    for (const rec of recs) {
      stmt.run(orgId, rec.analysisId, JSON.stringify(rec), now, now + TTL_MS);
    }
  });
  tx(records);
  return records.length;
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
 * Everything known about one binding, WITHOUT deleting anything.
 *
 * lookup() collapses "never issued", "expired" and "corrupt" into a single
 * null, which was fine when a miss silently degraded the save. It is not fine
 * now: the save is rejected, so the caller has to tell the user which of those
 * happened, and has to read created_at to report how long the analyse->save gap
 * actually was. Expired rows are left for the sweep rather than deleted on
 * read, so the timing is still readable while the rejection is being logged.
 *
 * Returns { found, expired, stale, createdAt, expiresAt, ageMs, record }.
 *   found   — a row exists for (orgId, analysisId)
 *   expired — it exists but is past its TTL
 *   stale   — it exists and is live, but predates the current PAYLOAD_VERSION
 *   record  — the parsed payload, or null when absent/unparseable
 */
function inspect(orgId, analysisId) {
  const miss = { found: false, expired: false, stale: false, createdAt: null, expiresAt: null, ageMs: null, record: null };
  if (!orgId || typeof analysisId !== 'string' || !analysisId) return miss;
  const row = db().prepare(
    'SELECT payload, created_at AS createdAt, expires_at AS expiresAt FROM analysis_provenance WHERE org_id = ? AND analysis_id = ?',
  ).get(orgId, analysisId);
  if (!row) return miss;

  const now = Date.now();
  const base = {
    found: true,
    expired: now > row.expiresAt,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    ageMs: now - row.createdAt,
  };

  let record = null;
  try { record = JSON.parse(row.payload); } catch (err) {
    console.error('[provenance] stored payload is not valid JSON',
      { orgId, analysisId, message: err && err.message });
    return { ...base, stale: false, record: null };
  }
  return { ...base, stale: record.bindingVersion !== PAYLOAD_VERSION, record };
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
  remember, rememberMany, lookup, inspect,
  sweepExpired, startProvenanceSweep, stopProvenanceSweep,
  TTL_MS, SWEEP_INTERVAL_MS, ALLOWED_KEYS, PAYLOAD_VERSION, _count,
};
