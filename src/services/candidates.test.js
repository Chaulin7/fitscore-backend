'use strict';

/**
 * src/services/candidates.test.js
 *
 * Real (surrogate) candidate identity, replacing the name-hash. Uses the Node.js
 * built-in test runner (node --test).
 *
 * Covers (STEP 6):
 *  - two identical names in one org get DISTINCT ids; filtering one returns only
 *    that one's rows (this is the bug — asserted directly)
 *  - the same person uploaded to two runs -> two candidate records, filtered independently
 *  - cross-org isolation on the new tables and the modified query (incl. a nonce
 *    reused across orgs never resolving to another org's run)
 *  - backfill: every pre-existing row ends up at exactly one legacy candidate, no orphans
 *  - filter and export agree on the same result set for the same filter input
 *  - an old-format hash link still resolves (not a silent empty set)
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fitscore-candidates-test-'));
process.env.DATABASE_PATH = path.join(TMP_DIR, 'candidates-test.db');

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');

const {
  getDb, closeDb, insertAudit, queryAuditLog, getFilteredAuditRows,
  getAuditFilterValues, backfillLegacyCandidates,
} = require('./db');

let seq = 0;
// insertAudit takes a SERVER-CONSTRUCTED provenance record plus the recruiter's
// own input; the candidate name and file name are facts about the analysis and
// so arrive in `bound`, not as loose arguments. Candidate identity, run
// grouping and org scoping — what this file actually tests — are unchanged.
const save = (orgId, name, opts = {}) =>
  insertAudit({
    bound: { candidateName: name, fileName: (opts.file || name) + '.pdf' },
    role: opts.role || 'Engineer', runNonce: opts.nonce, decision: opts.decision,
  }, orgId, opts.user || 'user-1');
const runOf = (candidateId) => getDb().prepare('SELECT run_id AS r FROM candidates WHERE id = ?').get(candidateId).r;
const orgOfCandidate = (candidateId) => getDb().prepare('SELECT org_id AS o FROM candidates WHERE id = ?').get(candidateId).o;

// Seed a pre-migration row directly: legacy hash present, no surrogate fk.
function seedLegacy(orgId, hash, name) {
  const id = 'leg-' + (++seq);
  getDb().prepare('INSERT INTO audit_log (id, org_id, candidate_id, candidate_name, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, orgId, hash, name, 'user-1', new Date(Date.now() - seq * 1000).toISOString());
  return id;
}

after(() => { closeDb(); });

describe('the bug: identical names get distinct identities', () => {
  test('two different applicants named the same in one org get distinct ids; filtering one returns only that one', () => {
    const a = save('org-1', 'Jane Smith', { nonce: 'pass-1', file: 'jane-a' });
    const b = save('org-1', 'Jane Smith', { nonce: 'pass-1', file: 'jane-b' });

    assert.ok(a.candidateId && b.candidateId);
    assert.notEqual(a.candidateId, b.candidateId, 'same name must NOT share an id');

    const qa = queryAuditLog({ orgId: 'org-1', candidateId: a.candidateId });
    assert.equal(qa.total, 1);
    assert.equal(qa.rows[0].id, a.id, "filtering candidate A returns only A's row");

    const qb = queryAuditLog({ orgId: 'org-1', candidateId: b.candidateId });
    assert.equal(qb.total, 1);
    assert.equal(qb.rows[0].id, b.id);
  });

  test('same batch nonce groups saves into ONE run, still as distinct candidates', () => {
    const p1 = save('org-1', 'Person One', { nonce: 'batch-9' });
    const p2 = save('org-1', 'Person Two', { nonce: 'batch-9' });
    assert.notEqual(p1.candidateId, p2.candidateId);
    assert.equal(runOf(p1.candidateId), runOf(p2.candidateId), 'one screening pass = one run');
  });
});

describe('same person across two runs', () => {
  test('produces two candidate records that filter independently', () => {
    const first = save('org-2', 'Chris Lee', { nonce: 'run-A', role: 'Backend' });
    const second = save('org-2', 'Chris Lee', { nonce: 'run-B', role: 'Frontend' });

    assert.notEqual(first.candidateId, second.candidateId);
    assert.notEqual(runOf(first.candidateId), runOf(second.candidateId), 'two runs');

    assert.deepEqual(queryAuditLog({ orgId: 'org-2', candidateId: first.candidateId }).rows.map((r) => r.id), [first.id]);
    assert.deepEqual(queryAuditLog({ orgId: 'org-2', candidateId: second.candidateId }).rows.map((r) => r.id), [second.id]);
  });
});

describe('cross-org isolation', () => {
  test('a candidate id from org B never matches in org A, and a reused nonce never crosses orgs', () => {
    const a = save('org-A', 'Same Name', { nonce: 'shared-nonce' });
    const b = save('org-B', 'Same Name', { nonce: 'shared-nonce' });

    // Same nonce, different orgs -> different server-minted runs.
    assert.notEqual(runOf(a.candidateId), runOf(b.candidateId));
    assert.equal(orgOfCandidate(a.candidateId), 'org-A');
    assert.equal(orgOfCandidate(b.candidateId), 'org-B');

    // Filtering org A by org B's candidate id returns nothing.
    assert.equal(queryAuditLog({ orgId: 'org-A', candidateId: b.candidateId }).total, 0);
    assert.equal(queryAuditLog({ orgId: 'org-B', candidateId: a.candidateId }).total, 0);

    // Every new table row is scoped to its org.
    assert.equal(getDb().prepare("SELECT COUNT(*) n FROM screening_runs WHERE org_id = 'org-A'").get().n >= 1, true);
    assert.equal(getDb().prepare("SELECT org_id o FROM run_nonces WHERE nonce = 'shared-nonce' AND org_id = 'org-A'").get().o, 'org-A');
  });
});

describe('legacy backfill', () => {
  test('every pre-existing row ends up at exactly one legacy candidate; no orphans; collisions stay merged', () => {
    // org BF-1: two rows share hash h1 (a merge we cannot undo), one row on h2.
    seedLegacy('BF-1', 'h1', 'Pat Kim');
    seedLegacy('BF-1', 'h1', 'Pat Kim');
    seedLegacy('BF-1', 'h2', 'Dana Fox');
    // Same hash VALUE in a different org must be a different candidate.
    seedLegacy('BF-2', 'h1', 'Sam Roe');

    const res = backfillLegacyCandidates();
    assert.ok(res.rowsLinked >= 4);

    // No orphans anywhere.
    assert.equal(getDb().prepare('SELECT COUNT(*) n FROM audit_log WHERE candidate_fk IS NULL').get().n, 0);

    // h1 rows in BF-1 collapse to ONE legacy candidate.
    const h1a = getDb().prepare("SELECT DISTINCT candidate_fk c FROM audit_log WHERE org_id = 'BF-1' AND candidate_id = 'h1'").all();
    assert.equal(h1a.length, 1);
    const prov = getDb().prepare('SELECT provenance p FROM candidates WHERE id = ?').get(h1a[0].c).p;
    assert.equal(prov, 'legacy_hash');

    // Distinct hash -> distinct legacy candidate; cross-org hash collision stays separate.
    const h2a = getDb().prepare("SELECT DISTINCT candidate_fk c FROM audit_log WHERE org_id = 'BF-1' AND candidate_id = 'h2'").all();
    const h1b = getDb().prepare("SELECT DISTINCT candidate_fk c FROM audit_log WHERE org_id = 'BF-2' AND candidate_id = 'h1'").all();
    assert.notEqual(h1a[0].c, h2a[0].c);
    assert.notEqual(h1a[0].c, h1b[0].c);
  });
});

describe('filter and export agree', () => {
  test('the filter query and the CSV export resolve the same rows for the same candidate id', () => {
    // A legacy candidate with several rows (via backfill) gives a multi-row candidate.
    seedLegacy('AGREE', 'agree-hash', 'Robin Vale');
    seedLegacy('AGREE', 'agree-hash', 'Robin Vale');
    seedLegacy('AGREE', 'agree-hash', 'Robin Vale');
    backfillLegacyCandidates();
    const fk = getDb().prepare("SELECT candidate_fk c FROM audit_log WHERE org_id = 'AGREE' AND candidate_id = 'agree-hash' LIMIT 1").get().c;

    const filtered = queryAuditLog({ orgId: 'AGREE', candidateId: fk });
    const exported = getFilteredAuditRows({ orgId: 'AGREE', candidateId: fk });
    assert.equal(filtered.total, 3);
    assert.deepEqual(filtered.rows.map((r) => r.id), exported.map((r) => r.id), 'filter and export must agree');

    // Dropdown endpoint stays coherent + org-scoped (actors/actions only).
    const dd = getAuditFilterValues('AGREE');
    assert.ok(Array.isArray(dd.actors) && Array.isArray(dd.actions));
  });
});

describe('old-format link resolves, never silent-empty', () => {
  test('filtering by an old candidate hash still returns its legacy rows', () => {
    seedLegacy('OLD', 'oldhash', 'Lee Park');
    seedLegacy('OLD', 'oldhash', 'Lee Park');
    backfillLegacyCandidates();

    // An old shared link carried candidateId=<hash>; it must resolve, not vanish.
    const q = queryAuditLog({ orgId: 'OLD', candidateId: 'oldhash' });
    assert.ok(q.total >= 2, 'old hash link must resolve to the legacy rows, not return empty as if nothing matched');
    for (const row of q.rows) assert.ok(row.candidateLegacy, 'resolved rows are flagged legacy');
  });
});
