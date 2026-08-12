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

describe('POST /api/audit — the row is built from the binding, not the payload', () => {
  // REPLACES two blocks that asserted the previous contract, in which an
  // unbindable save still wrote a row carrying the client's own numbers and
  // flagged it `vouched:false`. The row landed either way and looked identical
  // in the audit log to one the server could stand behind. It now fails closed:
  // no binding, no row.
  //
  // The payload no longer has a path to the write at all — POST /api/audit
  // accepts analysisId, decision, note, role and runNonce and drops the rest
  // unread — so these assert that injected values have NO effect, rather than
  // that each one is individually sanitised.

  // A complete server record, as routes/analyze.provenanceRecord() builds one.
  function rememberAnalysis(orgId, analysisId, over = {}) {
    provenance.remember(orgId, {
      analysisId,
      bindingVersion: provenance.PAYLOAD_VERSION,
      extractorEngine: 'pdfjs', extractorVersion: '4.2.67', assemblerVersion: '1.0.0',
      textSha256: 'sha-' + analysisId, pageCount: 2, charCount: 4096,
      scorerEngine: 'cvsprings-lexical-scorer', scorerVersion: 'test',
      scoringWeights: { kw: 40, sk: 30, ex: 20, ed: 10 },
      overall: 72,
      scores: { keywords: 70, skills: 80, experience: 65, education: 75 },
      verdict: 'Good Match',
      analysisDetail: { found: ['a'], missing: [], skills: [], matches: [], recommendations: [{ icon: 'i', text: 'do the thing' }] },
      anonymized: false,
      candidateName: 'Bound Bella', fileName: 'bella.pdf',
      jdSnippet: 'a job description',
      modelId: 'cvsprings-lexical-scorer@test',
      analysisTimestamp: '2026-08-12T09:00:00.000Z',
      appVersion: '1.3.0',
      ...over,
    });
  }

  // Everything a hostile or merely stale client might send. None of it may
  // reach the row.
  const INJECTED = {
    candidateName: 'Injected Ivan', fileName: 'injected.pdf',
    overall: 99, scores: { keywords: 99, skills: 99, experience: 99, education: 99 },
    weights: { kw: 90, sk: 10, ex: 0, ed: 0 },
    verdict: 'Excellent Match', anonymized: true,
    jdSnippet: 'injected jd', appVersion: '9.9.9',
    modelId: 'evil-scorer@1.0.0', analysisTimestamp: '1999-01-01T00:00:00.000Z',
    analysisDetail: { found: ['injected'], recommendations: [{ icon: 'x', text: 'injected' }] },
    engineVersion: 'evil@1', bindingVersion: 99, bindingState: 'vouched',
    reviewedBy: 'attacker@example.com', userId: 'someone-else', orgId: 'org-b',
  };

  test('injected weight values have no effect on the recorded weights', async () => {
    rememberAnalysis(ORG_A, 'an-inject');
    const { status, body } = await post({ analysisId: 'an-inject', ...INJECTED }, ORG_A);
    assert.equal(status, 201);
    assert.deepEqual(body.weightsJson, { kw: 40, sk: 30, ex: 20, ed: 10 });
  });

  test('no injected field reaches the row — one assertion per field', async () => {
    rememberAnalysis(ORG_A, 'an-inject-all');
    const { body } = await post({ analysisId: 'an-inject-all', ...INJECTED }, ORG_A);
    assert.equal(body.candidateName, 'Bound Bella');
    assert.equal(body.fileName, 'bella.pdf');
    assert.equal(body.overall, 72);
    assert.deepEqual(body.scores, { keywords: 70, skills: 80, experience: 65, education: 75 });
    assert.equal(body.verdict, 'Good Match');
    assert.equal(body.anonymized, false);
    assert.equal(body.jdSnippet, 'a job description');
    assert.equal(body.appVersion, '1.3.0');
    assert.equal(body.modelId, 'cvsprings-lexical-scorer@test');
    assert.equal(body.analysisTimestamp, '2026-08-12T09:00:00.000Z');
    assert.equal(body.engineVersion, 'cvsprings-lexical-scorer@test');
    assert.equal(body.bindingVersion, 1, 'the client cannot set its own binding version');
  });

  test('the recruiter fields ARE taken from the payload — they are the only ones', async () => {
    rememberAnalysis(ORG_A, 'an-human');
    const { body } = await post({
      analysisId: 'an-human', decision: 'shortlist', note: 'strong on Go', role: 'Backend Engineer',
    }, ORG_A);
    assert.equal(body.decision, 'shortlist');
    assert.equal(body.note, 'strong on Go');
    assert.equal(body.role, 'Backend Engineer');
  });

  test('recorded weights match engine-applied weights across configurations', async () => {
    const configs = [
      { kw: 40, sk: 30, ex: 20, ed: 10 },
      { kw: 25, sk: 25, ex: 25, ed: 25 },
      { kw: 70, sk: 10, ex: 10, ed: 10 },
      { kw: 0, sk: 0, ex: 0, ed: 100 },
    ];
    for (const [i, w] of configs.entries()) {
      const id = 'an-cfg-' + i;
      rememberAnalysis(ORG_A, id, { scoringWeights: w });
      // Every save claims a different, wrong weight set.
      const { body } = await post({ analysisId: id, weights: { kw: 1, sk: 2, ex: 3, ed: 94 } }, ORG_A);
      assert.deepEqual(body.weightsJson, w, 'config ' + i);
    }
  });

  test('a slider moved between analyse and save cannot change the record', async () => {
    // The drift case, and the reason this is structural rather than validated:
    // the client used to read the sliders at SAVE time, so moving one after
    // analysing rewrote the recorded weights against an unchanged score. No
    // attacker required.
    const applied = { kw: 40, sk: 30, ex: 20, ed: 10 };
    rememberAnalysis(ORG_A, 'an-drift', { scoringWeights: applied });
    const movedSliders = { kw: 10, sk: 10, ex: 10, ed: 70 };
    const { body } = await post({ analysisId: 'an-drift', weights: movedSliders }, ORG_A);
    assert.deepEqual(body.weightsJson, applied);
    assert.notDeepEqual(body.weightsJson, movedSliders);
  });

  test('anonymized comes from the server, not any client assertion', async () => {
    // The bias report's primary grouping dimension.
    rememberAnalysis(ORG_A, 'an-anon-true', { anonymized: true });
    const a = await post({ analysisId: 'an-anon-true', anonymized: false }, ORG_A);
    assert.equal(a.body.anonymized, true);

    rememberAnalysis(ORG_A, 'an-anon-false', { anonymized: false });
    const b = await post({ analysisId: 'an-anon-false', anonymized: true }, ORG_A);
    assert.equal(b.body.anonymized, false);
  });

  test('scores come from the engine, and a claimed overall cannot move them', async () => {
    rememberAnalysis(ORG_A, 'an-scores', {
      overall: 41, scores: { keywords: 40, skills: 42, experience: 39, education: 44 },
    });
    const { body } = await post({ analysisId: 'an-scores', overall: 100, scores: { keywords: 100, skills: 100, experience: 100, education: 100 } }, ORG_A);
    assert.equal(body.overall, 41);
    assert.deepEqual(body.scores, { keywords: 40, skills: 42, experience: 39, education: 44 });
  });

  test('verdict is the engine band, not concatenated recommendation prose', async () => {
    rememberAnalysis(ORG_A, 'an-verdict', { verdict: 'Partial Match' });
    const { body } = await post({ analysisId: 'an-verdict', verdict: 'do the thing and the other thing' }, ORG_A);
    assert.equal(body.verdict, 'Partial Match');
    // The prose still has a home; it simply is not the verdict.
    assert.ok(body.analysisDetail.recommendations.some((r) => /do the thing/.test(r.text)));
  });

  test('the legacy client weights column is no longer written', async () => {
    rememberAnalysis(ORG_A, 'an-legacy');
    const { body } = await post({ analysisId: 'an-legacy', weights: { kw: 90, sk: 10, ex: 0, ed: 0 } }, ORG_A);
    assert.equal(body.weights, null, 'the retained legacy column must stay NULL on new rows');
    const raw = getDb().prepare('SELECT weights FROM audit_log WHERE id = ?').get(body.id);
    assert.equal(raw.weights, null);
  });

  test('weights_json is immutable — a later edit to the row does not change it', async () => {
    rememberAnalysis(ORG_A, 'an-immutable');
    const { body } = await post({ analysisId: 'an-immutable' }, ORG_A);
    await fetch(`${baseUrl}/api/audit/${body.id}`, {
      method: 'PATCH', headers: { 'x-test-org': ORG_A, 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'reject', note: 'changed my mind' }),
    });
    const after = getDb().prepare('SELECT weights_json AS w FROM audit_log WHERE id = ?').get(body.id);
    assert.deepEqual(JSON.parse(after.w), { kw: 40, sk: 30, ex: 20, ed: 10 });
  });
});

describe('POST /api/audit — fails closed', () => {
  async function captureWarn(fn) {
    const warn = []; const ow = console.warn;
    console.warn = (...a) => warn.push(a.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' '));
    try { return { result: await fn(), warn }; } finally { console.warn = ow; }
  }
  const rowCount = (orgId) => getDb().prepare('SELECT COUNT(*) AS c FROM audit_log WHERE org_id = ?').get(orgId).c;

  test('an unknown analysisId is rejected and writes NO row', async () => {
    const before = rowCount(ORG_A);
    const { status, body } = await post({ analysisId: 'never-issued', decision: 'shortlist' }, ORG_A);
    assert.equal(status, 409);
    assert.equal(body.code, 'ANALYSIS_EXPIRED');
    assert.equal(rowCount(ORG_A), before, 'a row that cannot be vouched for must not exist');
  });

  test('a missing analysisId is rejected with its own code', async () => {
    const before = rowCount(ORG_A);
    const { status, body } = await post({ decision: 'shortlist' }, ORG_A);
    assert.equal(status, 400);
    assert.equal(body.code, 'ANALYSIS_ID_REQUIRED');
    assert.equal(rowCount(ORG_A), before);
  });

  test('an expired binding is rejected', async () => {
    provenance.remember(ORG_A, {
      analysisId: 'an-expired', bindingVersion: provenance.PAYLOAD_VERSION,
      scorerEngine: 'e', scorerVersion: 'v', scoringWeights: { kw: 40, sk: 30, ex: 20, ed: 10 },
      overall: 50, scores: { keywords: 1, skills: 2, experience: 3, education: 4 },
      verdict: 'Partial Match', anonymized: false, candidateName: 'X', fileName: 'x.pdf',
    });
    getDb().prepare('UPDATE analysis_provenance SET expires_at = ? WHERE analysis_id = ?')
      .run(Date.now() - 1000, 'an-expired');
    const { status, body } = await post({ analysisId: 'an-expired' }, ORG_A);
    assert.equal(status, 409);
    assert.equal(body.code, 'ANALYSIS_EXPIRED');
    assert.match(body.error, /re-run/i, 'the message must tell the user what to do');
  });

  test('a pre-binding payload is DISTINGUISHABLE from ordinary expiry', async () => {
    // The deploy window: cached before this shipped, still live, but holding
    // scoring inputs only. A customer hitting this in the first 30 days should
    // be told what happened rather than have it guessed at.
    getDb().prepare(
      'INSERT INTO analysis_provenance (org_id, analysis_id, payload, created_at, expires_at) VALUES (?,?,?,?,?)',
    ).run(ORG_A, 'an-old-shape', JSON.stringify({
      analysisId: 'an-old-shape', scorerEngine: 'e', scorerVersion: 'v',
      scoringWeights: { kw: 40, sk: 30, ex: 20, ed: 10 },
    }), Date.now(), Date.now() + 3600000);
    const { status, body } = await post({ analysisId: 'an-old-shape' }, ORG_A);
    assert.equal(status, 409);
    assert.equal(body.code, 'ANALYSIS_PREDATES_BINDING');
    assert.notEqual(body.code, 'ANALYSIS_EXPIRED');
  });

  test('every rejection logs its cause and the analyse->save gap in hours', async () => {
    provenance.remember(ORG_A, {
      analysisId: 'an-gap', bindingVersion: provenance.PAYLOAD_VERSION,
      scorerEngine: 'e', scorerVersion: 'v', scoringWeights: { kw: 40, sk: 30, ex: 20, ed: 10 },
      overall: 50, scores: { keywords: 1, skills: 2, experience: 3, education: 4 },
      verdict: 'Partial Match', anonymized: false, candidateName: 'X', fileName: 'x.pdf',
    });
    // Age it 100 hours and expire it.
    const hundredHoursAgo = Date.now() - 100 * 3600000;
    getDb().prepare('UPDATE analysis_provenance SET created_at = ?, expires_at = ? WHERE analysis_id = ?')
      .run(hundredHoursAgo, Date.now() - 1000, 'an-gap');
    const { warn } = await captureWarn(() => post({ analysisId: 'an-gap' }, ORG_A));
    const line = warn.find((l) => /save rejected/.test(l));
    assert.ok(line, 'a rejection must be logged');
    assert.match(line, /analyseToSaveGapHours/);
    assert.match(line, /"cause":"unbound"/);
    assert.match(line, /100/, 'the gap must be reported in hours, for tuning the TTL');
  });

  test('a rejection with no binding at all reports a null gap, not zero', async () => {
    const { warn } = await captureWarn(() => post({ analysisId: 'nothing-here' }, ORG_A));
    const line = warn.find((l) => /save rejected/.test(l));
    assert.match(line, /"analyseToSaveGapHours":null/);
  });
});

