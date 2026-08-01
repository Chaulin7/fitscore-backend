'use strict';

/**
 * src/services/retention.test.js
 *
 * Configurable audit-log retention: the 180-day floor and the batched purge job.
 * Uses the Node.js built-in test runner (node --test).
 *
 * Covers (STEP 4):
 *  - retention_days < 180 rejected at the API validation layer AND, independently,
 *    inside the purge job (a sub-floor value still purges at the floor, not below)
 *  - purge respects org boundaries (org A's purge never touches org B rows)
 *  - batch deletion correct across a batch boundary (2500 eligible rows)
 *  - a purge_runs record is written even when zero rows match
 *  - purge audit events themselves survive a subsequent purge
 *  - interrupting mid-batch leaves no partial transaction and no orphaned lock
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

// Isolate on a throwaway sqlite file. Must be set BEFORE ./db is first required.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fitscore-retention-test-'));
process.env.DATABASE_PATH = path.join(TMP_DIR, 'retention-test.db');
// These suites exercise real deletion, so default to live mode. The dry-run
// suite at the bottom overrides per-call (and restores) to test the default.
process.env.RETENTION_PURGE_MODE = 'live';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const {
  getDb, closeDb, runRetentionPurge, validateRetentionDays,
  deleteAllOrgAuditData, countPurgeableRows, getRetentionStats,
  FEATURE_REQUEST_RETENTION_DAYS,
  RETENTION_FLOOR_DAYS, RETENTION_DEFAULT_DAYS,
} = require('./db');

const DAY_MS = 24 * 60 * 60 * 1000;
let seq = 0;

// Insert an org with an exact retention value (bypasses the API validator so the
// job's independent floor enforcement can be tested). The schema's sub-floor
// reconciliation only runs at DB open, so a value set here afterwards persists.
function makeOrg(retentionDays) {
  const id = `org-${++seq}`;
  getDb().prepare('INSERT INTO organizations (id, name, created_at, retention_days) VALUES (?, ?, ?, ?)')
    .run(id, 'Org ' + id, new Date().toISOString(), retentionDays);
  return id;
}
function seedRow(orgId, ageDays) {
  const id = `a-${++seq}`;
  const createdAt = new Date(Date.now() - ageDays * DAY_MS).toISOString();
  getDb().prepare('INSERT INTO audit_log (id, org_id, candidate_id, candidate_name, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, orgId, 'cid-' + id, 'Candidate', 'user-1', createdAt);
  return id;
}
function seedMany(orgId, count, ageDays) {
  const insert = getDb().prepare('INSERT INTO audit_log (id, org_id, candidate_id, candidate_name, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  const createdAt = new Date(Date.now() - ageDays * DAY_MS).toISOString();
  const tx = getDb().transaction((n) => {
    for (let i = 0; i < n; i++) { const id = `a-${++seq}`; insert.run(id, orgId, 'cid-' + id, 'Candidate', 'user-1', createdAt); }
  });
  tx(count);
}
// feature_requests carries user_email (personal data) and free text, so it is on
// the same retention clock. created_at is written as an ISO-8601 string with a
// 'T', exactly like audit_log and like the cutoff the purge computes.
function seedFeatureRequest(orgId, ageDays, category = 'product') {
  const id = `fr-${++seq}`;
  const createdAt = new Date(Date.now() - ageDays * DAY_MS).toISOString();
  getDb().prepare(`
    INSERT INTO feature_requests (id, org_id, user_email, category, title, body, plan_tier, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pro', 'new', ?)
  `).run(id, orgId, `user-${id}@example.com`, category, 'Title ' + id, 'Body for ' + id, createdAt);
  return id;
}
const auditCount = (orgId) => getDb().prepare('SELECT COUNT(*) AS n FROM audit_log WHERE org_id = ?').get(orgId).n;
const featureRequestCount = (orgId) => getDb().prepare('SELECT COUNT(*) AS n FROM feature_requests WHERE org_id = ?').get(orgId).n;
const purgeRuns = (orgId) => getDb().prepare('SELECT * FROM purge_runs WHERE org_id = ? ORDER BY ran_at DESC, id DESC').all(orgId);
const purgeEvents = (orgId) => getDb().prepare("SELECT * FROM audit_changes WHERE org_id = ? AND field = '__retention_purge__'").all(orgId);

after(() => { closeDb(); });

describe('retention floor — API validation layer', () => {
  test('a value below 180 is rejected with the regulatory-floor message', () => {
    const r = validateRetentionDays(90);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'RETENTION_BELOW_FLOOR');
    assert.match(r.message, /six months/i);
  });
  test('180 is accepted; 0 ("keep forever") is now rejected; the default is accepted', () => {
    assert.equal(validateRetentionDays(RETENTION_FLOOR_DAYS).ok, true);
    assert.equal(validateRetentionDays(0).ok, false);
    assert.equal(validateRetentionDays(RETENTION_DEFAULT_DAYS).ok, true);
  });
  test('non-integers are rejected', () => {
    assert.equal(validateRetentionDays('abc').ok, false);
    assert.equal(validateRetentionDays(180.5).ok, false);
  });
});

describe('retention floor — purge job enforces it independently', () => {
  test('an org set below the floor still purges at 180 days, not below', () => {
    const org = makeOrg(90); // below floor — could only arrive via a non-API path
    const oldId = seedRow(org, 200);  // older than the floor -> must be deleted
    const midId = seedRow(org, 100);  // inside the floor window -> must survive
    runRetentionPurge();
    const remaining = getDb().prepare('SELECT id FROM audit_log WHERE org_id = ?').all(org).map((r) => r.id);
    assert.ok(!remaining.includes(oldId), '200-day row should be purged');
    assert.ok(remaining.includes(midId), '100-day row must survive the floor (naive 90-day purge would have removed it)');
  });
});

describe('purge respects org boundaries', () => {
  test("purging org A never touches org B rows", () => {
    const orgA = makeOrg(180);
    const orgB = makeOrg(730);
    seedRow(orgA, 200); // eligible under A's 180-day retention
    const bId = seedRow(orgB, 200); // NOT eligible under B's 730-day retention
    runRetentionPurge();
    assert.equal(auditCount(orgA), 0, "org A's old row purged");
    assert.equal(auditCount(orgB), 1, "org B's row untouched");
    assert.equal(getDb().prepare('SELECT id FROM audit_log WHERE id = ?').get(bId).id, bId);
  });
});

describe('batch deletion across a batch boundary', () => {
  test('2500 eligible rows are deleted in 1000-row batches; recent rows survive', () => {
    const org = makeOrg(180);
    seedMany(org, 2500, 300); // all eligible
    seedRow(org, 5); seedRow(org, 5); seedRow(org, 5); // 3 recent, must survive
    assert.equal(auditCount(org), 2503);

    let batchCalls = 0;
    runRetentionPurge({ batchHook: (orgId, total) => { if (orgId === org) batchCalls++; } });

    assert.equal(auditCount(org), 3, 'exactly the 3 recent rows remain');
    assert.equal(batchCalls, 3, 'ceil(2500/1000) = 3 batches (1000, 1000, 500)');
    const run = purgeRuns(org)[0];
    assert.equal(run.rows_deleted, 2500);
    assert.equal(run.status, 'success');
  });
});

describe('purge_runs on a zero-row run', () => {
  test('a run that matches no rows still writes exactly one purge_runs record', () => {
    const org = makeOrg(730);
    seedRow(org, 10); // recent — nothing eligible
    runRetentionPurge();
    const runs = purgeRuns(org);
    assert.equal(runs.length, 1, 'exactly one record (a missing record must mean the job did not run)');
    assert.equal(runs[0].rows_deleted, 0);
    assert.equal(runs[0].status, 'success');
    assert.ok(runs[0].cutoff_date, 'cutoff recorded even on a zero-row run');
  });
});

describe('purge audit events outlive the rows they removed', () => {
  test('purge events survive a subsequent purge', () => {
    const org = makeOrg(180);
    seedMany(org, 5, 300);
    runRetentionPurge();                 // deletes 5, writes one purge event
    const after1 = purgeEvents(org);
    assert.ok(after1.length >= 1, 'a purge event was written');
    const detail = JSON.parse(after1[0].new_value);
    assert.equal(detail.rowsDeleted, 5);
    assert.ok(detail.cutoffDate);

    runRetentionPurge();                 // a later purge must NOT remove the event
    const after2 = purgeEvents(org);
    assert.equal(after2.length, after1.length, 'purge events are exempt from deletion');
  });
});

describe('interrupting mid-batch', () => {
  test('a failure between batches leaves no partial transaction and no orphaned lock', () => {
    const org = makeOrg(180);
    seedMany(org, 2500, 300);

    let thrown = false;
    assert.doesNotThrow(() => {
      // The job wraps each org in its own try/catch, so the thrown error is
      // caught and recorded rather than propagating out of runRetentionPurge.
      runRetentionPurge({
        batchHook: (orgId, total) => {
          if (orgId === org && !thrown) { thrown = true; throw new Error('simulated interruption'); }
        },
      });
    });

    // First batch (1000) committed atomically; the remaining 1500 are intact —
    // no half-applied transaction.
    assert.equal(auditCount(org), 1500, 'exactly the first committed batch was removed');
    const run = purgeRuns(org)[0];
    assert.equal(run.status, 'error');
    assert.match(run.error_text, /simulated interruption/);

    // The DB is immediately usable — no lock stranded by the interruption.
    assert.doesNotThrow(() => {
      seedRow(org, 1);
      getDb().prepare('SELECT COUNT(*) AS n FROM audit_log WHERE org_id = ?').get(org);
    });
  });
});

describe('dry-run mode', () => {
  test('dryrun writes a purge_runs row with a non-zero would-delete count but deletes nothing', () => {
    const org = makeOrg(180);
    seedMany(org, 12, 300); // all eligible under 180-day retention
    assert.equal(auditCount(org), 12);

    const res = runRetentionPurge({ mode: 'dryrun' });
    assert.equal(res.mode, 'dryrun');
    assert.equal(res.rowsDeleted, 0, 'a dry run deletes nothing');

    // Row count unchanged.
    assert.equal(auditCount(org), 12, 'dryrun must leave the audit rows in place');

    // A purge_runs record with status='dryrun' and the exact would-delete count.
    const run = purgeRuns(org)[0];
    assert.equal(run.status, 'dryrun');
    assert.equal(run.rows_deleted, 12, 'rows_deleted holds the would-delete count');

    // No purge audit event — nothing was actually removed.
    assert.equal(purgeEvents(org).length, 0);
  });

  test('live deletion is opt-in: an unset or invalid mode resolves to dryrun', () => {
    const saved = process.env.RETENTION_PURGE_MODE;
    try {
      delete process.env.RETENTION_PURGE_MODE; // unset -> safe default
      const org1 = makeOrg(180); seedMany(org1, 4, 300);
      runRetentionPurge();
      assert.equal(auditCount(org1), 4, 'unset mode must not delete');
      assert.equal(purgeRuns(org1)[0].status, 'dryrun');

      process.env.RETENTION_PURGE_MODE = 'LIVEISH'; // typo -> not exactly 'live'
      const org2 = makeOrg(180); seedMany(org2, 3, 300);
      runRetentionPurge();
      assert.equal(auditCount(org2), 3, 'a non-"live" value must be treated as dryrun');
      assert.equal(purgeRuns(org2)[0].status, 'dryrun');
    } finally {
      if (saved === undefined) delete process.env.RETENTION_PURGE_MODE;
      else process.env.RETENTION_PURGE_MODE = saved;
    }
  });
});

// ── feature_requests: its OWN retention clock ───────────────────────────────
// FEATURE_REQUEST_RETENTION_DAYS (365) is deliberately independent of the org's
// retention_days, which carries the AI Act Art. 19 180-day floor and 3650-day
// ceiling. Feedback carrying user_email is neither an AI Act log nor candidate
// data, so it is held to plain data minimisation instead.

const FR_DAYS = FEATURE_REQUEST_RETENTION_DAYS;

describe('feature_requests retention is decoupled from retention_days', () => {
  test('a high-retention org does NOT keep feature requests past their own window', () => {
    // The exact case that fails under inheritance: retention_days=3650 would
    // have kept this for a decade.
    const org = makeOrg(3650);
    seedFeatureRequest(org, FR_DAYS + 35);   // past the feature-request window
    seedFeatureRequest(org, FR_DAYS - 35);   // still inside it
    seedRow(org, 3000);                      // audit row, still inside 3650 days

    runRetentionPurge({ mode: 'live' });

    assert.equal(featureRequestCount(org), 1, 'only the in-window feature request survives');
    assert.equal(auditCount(org), 1, "the org's audit retention is untouched by this change");
  });

  test('a floor-retention org KEEPS feature requests the audit window would have purged', () => {
    // The other direction: retention_days=180 would have purged a 300-day-old
    // feature request. Its own window is 365, so it stays.
    const org = makeOrg(180);
    seedFeatureRequest(org, 300);
    seedRow(org, 300);                       // audit row IS eligible at 180 days

    runRetentionPurge({ mode: 'live' });

    assert.equal(featureRequestCount(org), 1, '300 days is inside the 365-day feature-request window');
    assert.equal(auditCount(org), 0, 'the audit row still purges on the org window');
  });

  test('rows past the feature-request window are deleted whatever the org window is', () => {
    for (const retentionDays of [180, 730, 3650]) {
      const org = makeOrg(retentionDays);
      seedFeatureRequest(org, FR_DAYS + 10);
      seedFeatureRequest(org, FR_DAYS + 200);
      seedFeatureRequest(org, 10);
      runRetentionPurge({ mode: 'live' });
      assert.equal(featureRequestCount(org), 1, `retention_days=${retentionDays} must not change the outcome`);
    }
  });

  test('the cutoff comparison is ISO-8601 with a T, matching how created_at is written', () => {
    const org = makeOrg(3650);
    const id = seedFeatureRequest(org, FR_DAYS + 35);
    const stored = getDb().prepare('SELECT created_at FROM feature_requests WHERE id = ?').get(id).created_at;
    // A space-separated datetime('now') value would sort BEFORE every ISO string
    // and silently never match the window. Pin the stored format.
    assert.match(stored, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.ok(!stored.includes(' '), 'no space-separated datetime() format');

    runRetentionPurge({ mode: 'live' });
    assert.equal(featureRequestCount(org), 0, 'an ISO-stored row must actually match the ISO cutoff');
  });

  test('purging one org never touches another org feature requests', () => {
    const a = makeOrg(180);
    const b = makeOrg(180);
    seedFeatureRequest(a, FR_DAYS + 35);   // eligible
    seedFeatureRequest(b, 10);             // not eligible

    runRetentionPurge({ mode: 'live' });

    assert.equal(featureRequestCount(a), 0);
    assert.equal(featureRequestCount(b), 1, "another org's in-window request is untouched");
  });

  test('feature requests fold into the run total and the single purge_runs row', () => {
    const org = makeOrg(180);
    seedMany(org, 2, 300);                 // 2 audit rows, eligible at 180 days
    seedFeatureRequest(org, FR_DAYS + 35); // 1 feature request, eligible at 365
    seedFeatureRequest(org, FR_DAYS + 40); // 1 more
    seedFeatureRequest(org, 300);          // NOT eligible on its own clock

    runRetentionPurge({ mode: 'live' });

    const runs = purgeRuns(org);
    assert.equal(runs.length, 1, 'still exactly one purge_runs row per org per run');
    assert.equal(runs[0].rows_deleted, 4, '2 audit rows + 2 feature requests, on their separate cutoffs');
    assert.equal(auditCount(org), 0);
    assert.equal(featureRequestCount(org), 1);
  });

  test('a dry run counts feature requests on their own cutoff but deletes nothing', () => {
    const org = makeOrg(180);
    seedMany(org, 3, 300);                 // eligible on the audit window
    seedFeatureRequest(org, FR_DAYS + 35); // eligible on the feature-request window
    seedFeatureRequest(org, 300);          // inside the feature-request window

    const res = runRetentionPurge({ mode: 'dryrun' });

    assert.equal(res.rowsDeleted, 0, 'a dry run deletes nothing');
    assert.equal(featureRequestCount(org), 2, 'both feature requests survive a dry run');
    assert.equal(purgeRuns(org)[0].rows_deleted, 4, '3 audit + 1 feature request would go');
  });

  test('countPurgeableRows previews the same cutoffs the purge applies', () => {
    const org = makeOrg(180);
    seedMany(org, 2, 300);                 // audit-eligible
    seedFeatureRequest(org, FR_DAYS + 35); // feature-request-eligible
    seedFeatureRequest(org, 300);          // audit window would have caught this; its own does not

    const preview = countPurgeableRows(org, 180);
    assert.equal(preview.wouldDelete, 3, 'preview must use the independent feature-request cutoff');

    // Each count comes with the date that governs it, so the UI never shows one
    // window's date beside the other window's rows.
    assert.equal(preview.auditWouldDelete, 2, 'the part attributable to the previewed retention_days');
    assert.equal(preview.featureRequestWouldDelete, 1);
    assert.equal(preview.featureRequestRetentionDays, FR_DAYS);
    assert.match(preview.featureRequestCutoffDate, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.notEqual(preview.featureRequestCutoffDate, preview.cutoffDate, 'the two windows are different dates');
    const frAge = (Date.now() - Date.parse(preview.featureRequestCutoffDate)) / DAY_MS;
    assert.ok(Math.abs(frAge - FR_DAYS) < 1, `feature-request cutoff should be ~${FR_DAYS}d ago, was ~${Math.round(frAge)}d`);

    runRetentionPurge({ mode: 'live' });
    assert.equal(purgeRuns(org)[0].rows_deleted, preview.wouldDelete, 'preview matched reality');
    assert.equal(featureRequestCount(org), 1);
  });

  test('getRetentionStats reports each window with the date that governs it', () => {
    const org = makeOrg(180);
    seedMany(org, 2, 300);                 // audit-eligible
    seedFeatureRequest(org, FR_DAYS + 35); // feature-request-eligible
    seedFeatureRequest(org, 300);          // stored, not yet eligible

    const s = getRetentionStats(org);

    assert.equal(s.auditWouldDeleteNow, 2);
    assert.equal(s.featureRequestWouldDeleteNow, 1);
    assert.equal(s.wouldDeleteNow, 3, 'the combined total still predicts the whole purge');
    assert.equal(s.featureRequestRowCount, 2, 'all stored feature requests, not just eligible ones');
    assert.equal(s.featureRequestRetentionDays, FR_DAYS);

    const auditAge = (Date.now() - Date.parse(s.cutoffDate)) / DAY_MS;
    const frAge = (Date.now() - Date.parse(s.featureRequestCutoffDate)) / DAY_MS;
    assert.ok(Math.abs(auditAge - 180) < 1, 'cutoffDate is the audit window');
    assert.ok(Math.abs(frAge - FR_DAYS) < 1, 'featureRequestCutoffDate is the feature-request window');
    assert.notEqual(s.cutoffDate, s.featureRequestCutoffDate);
  });

  test('getRetentionStats.wouldDeleteNow spans both cutoffs; rowCount stays audit-only', () => {
    const org = makeOrg(180);
    seedMany(org, 2, 300);                 // audit-eligible
    seedRow(org, 5);                       // audit, in window
    seedFeatureRequest(org, FR_DAYS + 35); // feature-request-eligible
    seedFeatureRequest(org, 300);          // not eligible on its own clock

    const stats = getRetentionStats(org);
    assert.equal(stats.wouldDeleteNow, 3, '2 audit + 1 feature request');
    assert.equal(stats.rowCount, 3, 'rowCount is the audit-log figure only');
    // cutoffDate still describes the AUDIT window (180 days), not the
    // feature-request one (365) — the two are now different dates.
    const ageDays = (Date.now() - Date.parse(stats.cutoffDate)) / DAY_MS;
    assert.ok(Math.abs(ageDays - 180) < 1, `cutoffDate should be ~180 days ago, was ~${Math.round(ageDays)}`);
    assert.ok(Math.abs(ageDays - FR_DAYS) > 1, 'cutoffDate must not be the feature-request window');

    runRetentionPurge({ mode: 'live' });
    assert.equal(purgeRuns(org)[0].rows_deleted, 3, 'stats predicted the purge exactly');
  });
});

describe('right to erasure covers feature_requests', () => {
  test('deleteAllOrgAuditData removes the org feature requests and reports the count', () => {
    const org = makeOrg(180);
    seedRow(org, 1); seedRow(org, 1);
    seedFeatureRequest(org, 1); seedFeatureRequest(org, 200); seedFeatureRequest(org, 1);
    assert.equal(featureRequestCount(org), 3);

    const res = deleteAllOrgAuditData(org);

    assert.equal(res.recordsDeleted, 2);
    assert.equal(res.featureRequestsDeleted, 3);
    assert.equal(featureRequestCount(org), 0, 'no personal data may survive an erasure');
    assert.equal(auditCount(org), 0);
  });

  test('erasure is org-scoped', () => {
    const a = makeOrg(180); const b = makeOrg(180);
    seedFeatureRequest(a, 1); seedFeatureRequest(b, 1);

    deleteAllOrgAuditData(a);

    assert.equal(featureRequestCount(a), 0);
    assert.equal(featureRequestCount(b), 1, "another org's requests must be untouched");
  });

  test('erasure ignores age — even in-window rows go', () => {
    const org = makeOrg(3650); // nothing would ever be purge-eligible
    seedFeatureRequest(org, 0);
    deleteAllOrgAuditData(org);
    assert.equal(featureRequestCount(org), 0);
  });
});
