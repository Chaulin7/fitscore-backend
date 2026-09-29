'use strict';

/**
 * src/routes/batchFailures.test.js — a CV that fails in a batch is a failure,
 * never a score.
 *
 * Before this, a batch file that failed validation or extraction came back
 * with an `error` and no score, was sorted as if it scored 0, and was shown,
 * ranked, averaged and exported as a 0-score candidate. The contract now:
 *
 *   - the batch response marks it status 'failed' with its code and reason,
 *     and carries no score field at all;
 *   - the scored CVs in the same batch are byte-identical to scoring them
 *     without the failed ones (names included, when anonymised);
 *   - it can never be saved, so no decision can be recorded against it — and
 *     the server says so itself rather than relying on the client;
 *   - a record that has no score (the pre-binding app could save one) is kept
 *     out of the bias report and the stats, cannot take a decision, and
 *     cannot produce a report.
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fitscore-batchfail-test-'));
process.env.DATABASE_PATH = path.join(TMP_DIR, 'batchfail.db');

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { getDb, closeDb } = require('../services/db');
const analyzeRouter = require('./analyze');
const auditRouter = require('./audit');
const statsRouter = require('./stats');

const FIX = path.join(__dirname, '..', '..', 'test', 'fixtures');
const GOOD_A = fs.readFileSync(path.join(FIX, 'cv_single_column.pdf'));
const GOOD_B = fs.readFileSync(path.join(FIX, 'cv_two_column.pdf'));
// A page with nothing on it: pdf.js reads it, and there is no text.
const BLANK_PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n'
  + '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n'
  + '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
const CORRUPT_PDF = Buffer.from('%PDF-1.7\n' + '\u0000ÿ garbage '.repeat(50), 'latin1');
const NOT_A_PDF = Buffer.from('hello world, this is not a pdf');

const JD = 'Senior data analyst with SQL, Python and Power BI, stakeholder management, five years of experience and a Bachelor degree.';
const ORG = 'org-batchfail';
const SCORE_FIELDS = ['overall', 'scores', 'verdict', 'found', 'missing', 'skills', 'recommendations', 'matches', 'analysisId', 'candidateName'];

let server; let base;
before(async () => {
  getDb();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.orgId = ORG; req.userId = 'u-batchfail'; req.user = { email: 'recruiter@batchfail.test' }; next(); });
  app.use('/api/analyze', analyzeRouter);
  app.use('/api/audit', auditRouter);
  app.use('/api/stats', statsRouter);
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { if (server) server.close(); closeDb(); try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {} });

async function batch(files, fields = {}) {
  const fd = new FormData();
  for (const [name, buf] of files) fd.append('cvs', new Blob([buf], { type: 'application/pdf' }), name);
  fd.append('jobDescription', JD);
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  const res = await fetch(base + '/api/analyze/batch', { method: 'POST', body: fd });
  return { status: res.status, body: await res.json() };
}
const json = async (method, p, body) => {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, body: ct.includes('json') ? await res.json() : await res.text() };
};
// Everything about a scored result except what is per-request by design.
const stable = (r) => { const { analysisId, analysisTimestamp, ...rest } = r; return rest; };
const byFile = (results) => Object.fromEntries(results.filter((r) => r.status === 'scored').map((r) => [r.fileName, stable(r)]));

describe('the batch response', () => {
  let mixed;
  before(async () => {
    mixed = await batch([['blank.pdf', BLANK_PDF], ['a.pdf', GOOD_A], ['corrupt.pdf', CORRUPT_PDF], ['b.pdf', GOOD_B], ['notes.pdf', NOT_A_PDF]]);
  });

  test('a failed CV is status "failed", with its code and reason, and no score field at all', () => {
    assert.equal(mixed.status, 200);
    const failed = mixed.body.results.filter((r) => r.status === 'failed');
    assert.deepEqual(failed.map((r) => [r.fileName, r.code, r.reason || null]), [
      ['blank.pdf', 'IMAGE_ONLY_PDF', null],
      ['corrupt.pdf', 'UNPROCESSABLE_FILE', 'PDF'],
      ['notes.pdf', 'INVALID_FILE', 'FILE_TYPE'],
    ], 'failed files keep upload order, after the scored ones');
    for (const r of failed) {
      for (const f of SCORE_FIELDS) assert.equal(f in r, false, `${r.fileName} must not carry "${f}"`);
      assert.equal(typeof r.error, 'string');
      assert.equal(r.displayName, r.fileName.replace(/\.pdf$/, ''));
    }
  });

  test('scored CVs come first, ranked by score; the counts say what happened', () => {
    const { results, count, scored, failed } = mixed.body;
    assert.deepEqual([count, scored, failed], [5, 2, 3]);
    assert.deepEqual(results.slice(0, 2).map((r) => r.status), ['scored', 'scored']);
    assert.ok(results[0].overall >= results[1].overall);
    for (const r of results.slice(0, 2)) assert.equal(typeof r.analysisId, 'string', 'a scored CV is bound and saveable');
  });

  test('the scored CVs are byte-identical to scoring them without the failed files', async () => {
    const alone = await batch([['a.pdf', GOOD_A], ['b.pdf', GOOD_B]]);
    assert.deepEqual(byFile(mixed.body.results), byFile(alone.body.results));
    // And each one to the single-CV endpoint, on the fields both return.
    const fd = new FormData();
    fd.append('cv', new Blob([GOOD_A], { type: 'application/pdf' }), 'a.pdf');
    fd.append('jobDescription', JD);
    const single = await (await fetch(base + '/api/analyze', { method: 'POST', body: fd })).json();
    const a = byFile(mixed.body.results)['a.pdf'];
    for (const f of ['overall', 'scores', 'verdict', 'found', 'missing', 'skills', 'recommendations', 'extraction']) {
      assert.deepEqual(a[f], single[f], `batch "${f}" differs from single`);
    }
  });

  test('anonymised names count scored candidates only, so a failure does not shift them', async () => {
    const withFailure = await batch([['blank.pdf', BLANK_PDF], ['a.pdf', GOOD_A]], { anonymize: 'true' });
    const withoutFailure = await batch([['a.pdf', GOOD_A]], { anonymize: 'true' });
    assert.deepEqual(byFile(withFailure.body.results), byFile(withoutFailure.body.results));
    assert.equal(byFile(withFailure.body.results)['a.pdf'].candidateName, 'Candidate #1');
  });
});

describe('a failed CV can never be recorded', () => {
  test('it has no analysis id to save with, and a save without one writes nothing', async () => {
    const r = await json('POST', '/api/audit', { decision: 'shortlist' });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'ANALYSIS_ID_REQUIRED');
  });

  test('a binding without a score is refused by the save path itself', async () => {
    const { body } = await batch([['a.pdf', GOOD_A]]);
    const id = body.results[0].analysisId;
    // Simulate a regression that bound an unscored analysis.
    const row = getDb().prepare('SELECT payload FROM analysis_provenance WHERE org_id = ? AND analysis_id = ?').get(ORG, id);
    const payload = JSON.parse(row.payload); delete payload.overall;
    getDb().prepare('UPDATE analysis_provenance SET payload = ? WHERE org_id = ? AND analysis_id = ?').run(JSON.stringify(payload), ORG, id);
    const before = getDb().prepare('SELECT COUNT(*) n FROM audit_log').get().n;
    const r = await json('POST', '/api/audit', { analysisId: id, decision: 'shortlist' });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'NOT_SCORED');
    assert.equal(getDb().prepare('SELECT COUNT(*) n FROM audit_log').get().n, before, 'no row was written');
  });
});

describe('a stored record without a score (as the pre-binding app could save)', () => {
  let legacyId; let scoredId;
  before(async () => {
    const { body } = await batch([['a.pdf', GOOD_A]]);
    const saved = await json('POST', '/api/audit', { analysisId: body.results[0].analysisId, decision: 'hold', role: 'Analyst' });
    assert.equal(saved.status, 201);
    scoredId = saved.body.id;
    legacyId = 'legacy-unscored-1';
    getDb().prepare(`INSERT INTO audit_log (id, user_id, org_id, candidate_name, file_name, overall, decision, role, anonymized, created_at, updated_at)
      VALUES (?, 'legacy', ?, 'broken', 'broken.pdf', NULL, 'shortlist', 'Analyst', 1, ?, ?)`)
      .run(legacyId, ORG, new Date().toISOString(), new Date().toISOString());
  });

  test('the bias report leaves it out of every figure, and says so', async () => {
    const r = await json('GET', '/api/audit/bias-report');
    assert.equal(r.status, 200);
    assert.equal(r.body.scope.totalRecords, getDb().prepare('SELECT COUNT(*) n FROM audit_log WHERE org_id = ? AND overall IS NOT NULL').get(ORG).n);
    assert.equal(r.body.scope.excludedUnscored, 1);
    assert.ok(r.body.limitations.some((l) => /1 record without a score .* is excluded/.test(l)));
    // Its "shortlist" would otherwise be the only shortlist in the org.
    for (const band of r.body.decisionConsistency.bands) assert.equal(band.shortlist, 0);
    assert.equal(r.body.anonymisation.anonymised.count, 0, 'the unscored row was the only anonymised one');
  });

  test('the stats leave it out', async () => {
    const r = await json('GET', '/api/stats/overview');
    assert.equal(r.status, 200);
    assert.equal(r.body.totalShortlisted, 0);
    assert.equal(r.body.totalAnalyses, getDb().prepare('SELECT COUNT(*) n FROM audit_log WHERE org_id = ? AND overall IS NOT NULL').get(ORG).n);
  });

  test('a decision cannot be set on it; it can be cleared, and a note still saved', async () => {
    const set = await json('PATCH', '/api/audit/' + legacyId, { decision: 'reject' });
    assert.equal(set.status, 409);
    assert.equal(set.body.code, 'NOT_SCORED');
    assert.equal(set.body.field, 'decision');
    assert.equal(getDb().prepare('SELECT decision FROM audit_log WHERE id = ?').get(legacyId).decision, 'shortlist', 'unchanged');
    assert.equal((await json('PATCH', '/api/audit/' + legacyId, { decision: null })).status, 200);
    assert.equal((await json('PATCH', '/api/audit/' + legacyId, { note: 'file was unreadable' })).status, 200);
    // A scored record is unaffected.
    assert.equal((await json('PATCH', '/api/audit/' + scoredId, { decision: 'shortlist' })).status, 200);
  });

  test('it cannot produce a candidate report (which would show a 0)', async () => {
    const r = await json('GET', '/api/audit/report/' + legacyId);
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'NOT_SCORED');
  });
});
