'use strict';

/**
 * src/routes/audit.test.js
 *
 * Filtered audit-log endpoint (GET /api/audit) + CSV export. Uses the Node.js
 * built-in test runner (node --test) and drives the real router over HTTP with
 * a stubbed auth middleware that injects req.orgId — so org scoping is exercised
 * exactly as in production (server-derived, never from the caller).
 *
 * Covers (STEP 5):
 *  - a user in org A cannot retrieve org B rows via ANY combination of params
 *  - date boundaries are inclusive at both ends
 *  - total is correct and independent of limit/offset
 *  - pagination across a block of identical timestamps returns each row once
 *  - a malformed date returns 400, not a silently-unfiltered result set
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

// Isolate on a throwaway sqlite file. Must be set BEFORE ./db is first required.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fitscore-audit-route-test-'));
process.env.DATABASE_PATH = path.join(TMP_DIR, 'audit-route-test.db');

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { getDb, closeDb, candidateIdFor } = require('../services/db');
const provenance = require('../services/provenanceCache');
const auditRouter = require('./audit');

const ORG_A = 'org-a';
const ORG_B = 'org-b';
const ORG_AMS = 'org-ams'; // Europe/Amsterdam, for timezone tests

function makeOrg(id, timezone) {
  getDb().prepare('INSERT INTO organizations (id, name, created_at, timezone) VALUES (?, ?, ?, ?)')
    .run(id, id, new Date().toISOString(), timezone);
}

let server;
let baseUrl;
let seq = 0;

// Insert a row directly so created_at can be controlled precisely (insertAudit
// always stamps "now"). Mirrors how insertAudit derives candidate_id.
function seed({ orgId, name = 'Candidate', userId = 'user-1', decision = null, createdAt }) {
  const id = `rec-${String(++seq).padStart(4, '0')}`;
  getDb().prepare(
    `INSERT INTO audit_log (id, org_id, candidate_id, candidate_name, user_id, decision, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, orgId, candidateIdFor(orgId, name), name, userId, decision, createdAt);
  return id;
}

async function get(query, orgId = ORG_A) {
  const res = await fetch(`${baseUrl}/api/audit${query}`, { headers: { 'x-test-org': orgId } });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}
async function post(body, orgId = ORG_A) {
  const res = await fetch(`${baseUrl}/api/audit`, {
    method: 'POST', headers: { 'x-test-org': orgId, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

before(async () => {
  const app = express();
  app.use(express.json());
  // Stubbed auth: org scope is server-derived here exactly like the real
  // middleware sets req.orgId. The router must never let a query param override it.
  app.use((req, _res, next) => { req.orgId = req.header('x-test-org'); req.userId = 'tester'; next(); });
  app.use('/api/audit', auditRouter);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  // Existing UTC-boundary assertions below rely on UTC day bounds, so pin the
  // test orgs to UTC. A separate org exercises Europe/Amsterdam.
  makeOrg(ORG_A, 'UTC');
  makeOrg(ORG_B, 'UTC');
  makeOrg(ORG_AMS, 'Europe/Amsterdam');

  // Org A: a spread of dates + decisions + actors.
  seed({ orgId: ORG_A, name: 'Alice', userId: 'a-user', decision: 'shortlist', createdAt: '2026-01-10T09:00:00.000Z' });
  seed({ orgId: ORG_A, name: 'Bob',   userId: 'a-user', decision: 'reject',    createdAt: '2026-01-15T12:00:00.000Z' });
  seed({ orgId: ORG_A, name: 'Carol', userId: 'b-user', decision: 'hold',      createdAt: '2026-02-01T00:00:00.000Z' });
  // Boundary rows: exact start and end of 2026-01-20 (UTC).
  seed({ orgId: ORG_A, name: 'Dawn',  userId: 'a-user', decision: null, createdAt: '2026-01-20T00:00:00.000Z' });
  seed({ orgId: ORG_A, name: 'Dusk',  userId: 'a-user', decision: null, createdAt: '2026-01-20T23:59:59.999Z' });

  // Org B: rows that must never surface for org A.
  seed({ orgId: ORG_B, name: 'Eve',    userId: 'a-user', decision: 'shortlist', createdAt: '2026-01-12T10:00:00.000Z' });
  seed({ orgId: ORG_B, name: 'Mallory', userId: 'a-user', decision: 'reject',   createdAt: '2026-01-18T10:00:00.000Z' });
});

after(() => {
  if (server) server.close();
  closeDb();
});

describe('GET /api/audit — tenant isolation', () => {
  test('org A never receives org B rows under any param combination', async () => {
    const bId = getDb().prepare("SELECT id FROM audit_log WHERE org_id = ? AND candidate_name = 'Eve'").get(ORG_B).id;
    const bCandidateId = candidateIdFor(ORG_B, 'Eve');

    const attempts = [
      '',                                              // no filters
      '?limit=200',                                    // wide page
      `?runId=${bId}`,                                 // B's exact run id
      `?candidateId=${bCandidateId}`,                  // B's candidate id
      '?actor=a-user',                                 // actor value shared across orgs
      '?action=shortlist',                             // decision shared across orgs
      '?from=2026-01-01&to=2026-12-31',                // full-year range
      `?candidateId=${bCandidateId}&actor=a-user&action=shortlist`,
    ];
    for (const q of attempts) {
      const { status, body } = await get(q, ORG_A);
      assert.equal(status, 200, `status for ${q || '(none)'}`);
      const names = body.rows.map((r) => r.candidateName);
      assert.ok(!names.includes('Eve') && !names.includes('Mallory'), `leaked org B rows for query "${q}"`);
      for (const r of body.rows) {
        // Every returned row's candidate_id must belong to org A, proving scope.
        assert.notEqual(r.candidateId, bCandidateId, `org B candidate surfaced for "${q}"`);
      }
    }
  });

  test("querying B's run id from org A returns nothing (no cross-tenant existence leak)", async () => {
    const bId = getDb().prepare("SELECT id FROM audit_log WHERE org_id = ? AND candidate_name = 'Mallory'").get(ORG_B).id;
    const { status, body } = await get(`?runId=${bId}`, ORG_A);
    assert.equal(status, 200);
    assert.equal(body.total, 0);
    assert.equal(body.rows.length, 0);
  });
});

describe('GET /api/audit — date boundaries', () => {
  test('from/to are inclusive at both ends of the day', async () => {
    // 2026-01-20 has one row at 00:00:00.000 and one at 23:59:59.999.
    const { body } = await get('?from=2026-01-20&to=2026-01-20', ORG_A);
    const names = body.rows.map((r) => r.candidateName).sort();
    assert.deepEqual(names, ['Dawn', 'Dusk']);
    assert.equal(body.total, 2);
  });

  test('range endpoints include rows dated exactly on the bound', async () => {
    const { body } = await get('?from=2026-01-10&to=2026-01-15', ORG_A);
    const names = body.rows.map((r) => r.candidateName).sort();
    assert.deepEqual(names, ['Alice', 'Bob']); // 2026-01-10 and 2026-01-15 both included
  });
});

describe('GET /api/audit — total vs pagination', () => {
  test('total counts all matching rows, independent of limit/offset', async () => {
    const full = await get('?from=2026-01-01&to=2026-12-31', ORG_A);
    assert.equal(full.body.total, 5); // all org A rows

    const paged = await get('?from=2026-01-01&to=2026-12-31&limit=2&offset=2', ORG_A);
    assert.equal(paged.body.total, 5);          // total unchanged by paging
    assert.equal(paged.body.rows.length, 2);    // page respects limit
    assert.equal(paged.body.limit, 2);
    assert.equal(paged.body.offset, 2);
  });

  test('limit is clamped to a 200 max', async () => {
    const { body } = await get('?limit=99999', ORG_A);
    assert.equal(body.limit, 200);
  });
});

describe('GET /api/audit — pagination across identical timestamps', () => {
  const TS = '2026-06-06T06:06:06.000Z';
  let ids;
  before(() => {
    ids = [];
    for (let i = 0; i < 5; i++) ids.push(seed({ orgId: ORG_A, name: `Tie ${i}`, createdAt: TS }));
  });

  test('every row in a same-timestamp block is returned exactly once while paging', async () => {
    const seen = [];
    for (let offset = 0; offset < 10; offset += 2) {
      const { body } = await get(`?from=2026-06-06&to=2026-06-06&limit=2&offset=${offset}`, ORG_A);
      for (const r of body.rows) seen.push(r.id);
      if (offset + 2 >= body.total) break;
    }
    const unique = new Set(seen);
    assert.equal(unique.size, seen.length, 'a row was returned on more than one page');
    assert.equal(unique.size, 5, 'not every tied-timestamp row was returned');
    for (const id of ids) assert.ok(unique.has(id), `missing row ${id}`);
  });
});

describe('GET /api/audit — malformed input', () => {
  test('a malformed from date returns 400, never a silently-unfiltered set', async () => {
    const { status, body } = await get('?from=not-a-date', ORG_A);
    assert.equal(status, 400);
    assert.equal(body.field, 'from');
    assert.ok(!Array.isArray(body.rows));
  });

  test('a calendar-impossible date (2026-02-31) returns 400', async () => {
    const { status, body } = await get('?to=2026-02-31', ORG_A);
    assert.equal(status, 400);
    assert.equal(body.field, 'to');
  });

  test('an invalid order value returns 400', async () => {
    const { status, body } = await get('?order=sideways', ORG_A);
    assert.equal(status, 400);
    assert.equal(body.field, 'order');
  });
});

describe('GET /api/audit — action maps to decision', () => {
  test('action filters on the record decision', async () => {
    const { body } = await get('?action=reject&from=2026-01-01&to=2026-12-31', ORG_A);
    const names = body.rows.map((r) => r.candidateName);
    assert.deepEqual(names, ['Bob']);
  });
});

describe('GET /api/audit — org-timezone day boundaries', () => {
  // 23:30 UTC on Jan 19 is 00:30 local on Jan 20 in Europe/Amsterdam (CET, +01).
  before(() => {
    getDb().prepare('INSERT INTO audit_log (id, org_id, candidate_name, user_id, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('ams-1', ORG_AMS, 'Nacht', 'a-user', '2026-01-19T23:30:00.000Z');
  });

  test('an event at 00:30 local falls on the correct local day, not the previous one', async () => {
    const jan20 = await get('?from=2026-01-20&to=2026-01-20', ORG_AMS);
    assert.equal(jan20.body.total, 1, 'must be included in its local day (Jan 20)');
    assert.equal(jan20.body.rows[0].candidateName, 'Nacht');
    assert.equal(jan20.body.timezone, 'Europe/Amsterdam');

    const jan19 = await get('?from=2026-01-19&to=2026-01-19', ORG_AMS);
    assert.equal(jan19.body.total, 0, 'must NOT appear on the previous UTC day');
  });

  test('the response advertises the org timezone', async () => {
    const { body } = await get('', ORG_A);
    assert.equal(body.timezone, 'UTC');
  });
});

describe('POST /api/audit — server-authoritative scoring inputs (analysisId-bound)', () => {
  // Bind server-side provenance for a specific analysis, as /api/analyze would:
  // keyed by analysisId, carrying the extraction textSha256 + the exact weights.
  function rememberAnalysis(orgId, analysisId, textSha256, weights) {
    provenance.remember(orgId, { analysisId, textSha256, scoringWeights: weights, engineVersion: 'cvsprings-lexical-scorer@test' });
  }
  const saveBody = (analysisId, textSha256, clientWeights) => ({
    candidateName: 'Weighted Wendy', fileName: 'w.pdf', overall: 70,
    scores: { keywords: 1, skills: 2, experience: 3, education: 4 },
    weights: clientWeights, // CLIENT weights — must be ignored for weights_json
    analysisId,
    analysisDetail: { extraction: { textSha256 } },
  });

  test('records the SERVER weights, not the client-supplied ones', async () => {
    const server = { kw: 40, sk: 30, ex: 20, ed: 10 };
    rememberAnalysis(ORG_A, 'an-server', 'sha-server', server);
    const { status, body } = await post(saveBody('an-server', 'sha-server', { kw: 90, sk: 10, ex: 0, ed: 0 }), ORG_A);
    assert.equal(status, 201);
    assert.deepEqual(body.weightsJson, server, 'weights_json must be what the engine actually used');
    assert.equal(body.engineVersion, 'cvsprings-lexical-scorer@test');
  });

  test('Q1: same CV under W1 then W2 — saving the W1 result records W1 (no last-writer clobber)', async () => {
    const SHA = 'sha-same-cv';
    const W1 = { kw: 70, sk: 10, ex: 10, ed: 10 };
    const W2 = { kw: 10, sk: 10, ex: 10, ed: 70 };
    // Tab A analysed the CV under W1; Tab B analysed the SAME CV under W2. Same
    // textSha256, but distinct analysisIds.
    rememberAnalysis(ORG_A, 'an-W1', SHA, W1);
    rememberAnalysis(ORG_A, 'an-W2', SHA, W2);
    // Save the W1 result (from Tab A): scores were computed under W1.
    const saved = await post(saveBody('an-W1', SHA, /*client echo of*/ W1), ORG_A);
    assert.deepEqual(saved.body.weightsJson, W1, 'the row must record W1, the weights its score was computed under');
    // And the W2 analysis still resolves independently to W2.
    const savedB = await post(saveBody('an-W2', SHA, W2), ORG_A);
    assert.deepEqual(savedB.body.weightsJson, W2);
  });

  test('batch: 25 candidates in one run each bind their own analysisId + weights', async () => {
    const SHA = 'sha-batch';
    const saves = [];
    for (let i = 0; i < 25; i++) {
      const w = { kw: i, sk: 25 - i, ex: 0, ed: 75 };
      rememberAnalysis(ORG_A, `an-batch-${i}`, SHA + '-' + i, w);
      saves.push(post(saveBody(`an-batch-${i}`, SHA + '-' + i, { kw: 1, sk: 1, ex: 1, ed: 97 }), ORG_A));
    }
    const results = await Promise.all(saves);
    const ids = new Set();
    for (let i = 0; i < 25; i++) {
      assert.deepEqual(results[i].body.weightsJson, { kw: i, sk: 25 - i, ex: 0, ed: 75 }, `candidate ${i} weights`);
      ids.add(results[i].body.id);
    }
    assert.equal(ids.size, 25, 'all 25 are distinct rows');
  });

  test('textSha256 mismatch against a valid analysisId records NULL (defense check), not the bound weights', async () => {
    rememberAnalysis(ORG_A, 'an-mismatch', 'sha-real', { kw: 40, sk: 30, ex: 20, ed: 10 });
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...a) => warnings.push(a.join(' '));
    try {
      // Valid analysisId, but the echoed extraction sha does NOT match.
      const { body } = await post(saveBody('an-mismatch', 'sha-TAMPERED', { kw: 1, sk: 1, ex: 1, ed: 97 }), ORG_A);
      assert.equal(body.weightsJson, null, 'must not record the bound weights on a sha mismatch');
      assert.equal(body.engineVersion, null);
    } finally { console.warn = origWarn; }
    assert.ok(warnings.some((w) => /mismatch/i.test(w)), 'a mismatch is logged server-side');
  });

  test('a missing/unknown analysisId records NULL (never the client echo)', async () => {
    const { body } = await post(saveBody('an-never-issued', 'sha-x', { kw: 100, sk: 0, ex: 0, ed: 0 }), ORG_A);
    assert.equal(body.weightsJson, null);
    assert.equal(body.engineVersion, null);
  });

  test('weights_json is immutable — a later edit to the row does not change it', async () => {
    rememberAnalysis(ORG_A, 'an-immutable', 'sha-immutable', { kw: 55, sk: 15, ex: 15, ed: 15 });
    const created = await post(saveBody('an-immutable', 'sha-immutable', { kw: 0, sk: 0, ex: 0, ed: 100 }), ORG_A);
    const id = created.body.id;
    await fetch(`${baseUrl}/api/audit/${id}`, {
      method: 'PATCH', headers: { 'x-test-org': ORG_A, 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'shortlist' }),
    });
    const after = await get(`?candidateId=${created.body.candidateId}`, ORG_A);
    const row = after.body.rows.find((r) => r.id === id);
    assert.deepEqual(row.weightsJson, { kw: 55, sk: 15, ex: 15, ed: 15 }, 'weights snapshot unchanged by a later edit');
    assert.equal(row.decision, 'shortlist');
  });
});
