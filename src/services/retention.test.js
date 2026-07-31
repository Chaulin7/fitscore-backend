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
const auditCount = (orgId) => getDb().prepare('SELECT COUNT(*) AS n FROM audit_log WHERE org_id = ?').get(orgId).n;
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
