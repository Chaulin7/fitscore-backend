'use strict';

/**
 * src/routes/errorReasons.test.js
 *
 * Errors the app shows now carry a stable `reason` (a sub-code under `code`)
 * and `params` (the values the English sentence is built from), so the app can
 * say the same refusal in Dutch or German. The English `error` text is
 * unchanged — older clients, logs and support tooling keep reading it.
 *
 * These pin the contract where the errors are made (the validators) and at the
 * wire (a real analyze router), and that `params` carries the numbers and file
 * names the translated sentence needs rather than leaving them in English prose.
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fitscore-reasons-test-'));
process.env.DATABASE_PATH = path.join(TMP_DIR, 'reasons.db');

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const fileSec = require('../services/fileSecurity');
const { validateRetentionDays, closeDb } = require('../services/db');
const analyzeRouter = require('./analyze');

const SVG = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'brandmark.svg'));
const PDF = fs.readFileSync(path.join(__dirname, '..', '..', 'test', 'fixtures', 'cv_single_column.pdf'));

function thrown(fn) {
  try { fn(); } catch (e) { return e; }
  assert.fail('expected a throw');
}

describe('file validation names which refusal it is', () => {
  test('a logo that is not PNG/JPEG', () => {
    const e = thrown(() => fileSec.validateLogoUpload(SVG, 'logo'));
    assert.equal(e.code, 'INVALID_FILE');
    assert.equal(e.reason, 'LOGO_TYPE');
    assert.match(e.message, /PNG or JPEG/, 'the English message is unchanged');
  });

  test('no logo at all', () => {
    assert.equal(thrown(() => fileSec.validateLogoUpload(Buffer.alloc(0), 'logo')).reason, 'LOGO_MISSING');
  });

  test('an oversized CV carries its name and the limit as params', () => {
    const e = thrown(() => fileSec.validateUploadedFile(
      { size: fileSec.MAX_FILE_BYTES + 1, originalname: 'Jansen.pdf', path: '/nonexistent' }, 'cv'));
    assert.equal(e.reason, 'FILE_TOO_LARGE');
    assert.deepEqual({ ...e.params }, { name: 'Jansen.pdf', mb: Math.round(fileSec.MAX_FILE_BYTES / (1024 * 1024)) });
    assert.match(e.message, /"Jansen\.pdf" exceeds the \d+ MB per-file limit\./);
  });

  test('too many files in a batch', () => {
    const files = Array.from({ length: fileSec.MAX_BATCH_FILES + 1 }, () => ({ size: 1 }));
    const e = thrown(() => fileSec.validateBatch(files, 'cvs'));
    assert.equal(e.reason, 'TOO_MANY_FILES');
    assert.equal(e.params.max, fileSec.MAX_BATCH_FILES);
  });
});

describe('retention validation', () => {
  test('below the floor carries the floor', () => {
    const r = validateRetentionDays(30);
    assert.equal(r.code, 'RETENTION_BELOW_FLOOR');
    assert.equal(r.params.min, 180);
  });
  test('not a whole number, and above the maximum, are told apart', () => {
    assert.equal(validateRetentionDays('abc').reason, 'NOT_WHOLE_DAYS');
    const long = validateRetentionDays(999999);
    assert.equal(long.reason, 'TOO_LONG');
    assert.ok(long.params.max > 180);
  });
});

describe('the analyze route puts reason and params on the wire', () => {
  let server; let base;
  before(async () => {
    const app = express();
    app.use((req, _res, next) => { req.orgId = 'org-reasons'; req.userId = 'u'; next(); });
    app.use('/api/analyze', analyzeRouter);
    await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => { if (server) server.close(); closeDb(); });

  async function post(fields) {
    const fd = new FormData();
    fd.append('cv', new Blob([PDF], { type: 'application/pdf' }), 'cv.pdf');
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    const res = await fetch(base + '/api/analyze', { method: 'POST', body: fd });
    return { status: res.status, body: await res.json() };
  }

  test('a job description under the minimum', async () => {
    const { status, body } = await post({ jobDescription: 'too short' });
    assert.equal(status, 400);
    assert.equal(body.code, 'VALIDATION_ERROR');
    assert.equal(body.field, 'jobDescription');
    assert.equal(body.reason, 'TOO_SHORT');
    assert.deepEqual(body.params, { min: 50 });
    assert.equal(body.error, 'jobDescription must be at least 50 characters.');
  });

  test('weights that do not sum to 100 report the total', async () => {
    const { body } = await post({
      jobDescription: 'Senior engineer with Node.js, SQL and ten years of backend experience in fintech.',
      weights: JSON.stringify({ kw: 50, sk: 30, ex: 20, ed: 10 }),
    });
    assert.equal(body.reason, 'WEIGHTS_SUM');
    assert.deepEqual(body.params, { total: 110 });
  });

  test('an error with no sub-code sends neither field', async () => {
    const fd = new FormData();
    fd.append('jobDescription', 'x'.repeat(60));
    const res = await fetch(base + '/api/analyze', { method: 'POST', body: fd });
    const body = await res.json();
    assert.equal(body.code, 'NO_FILE');
    assert.equal('reason' in body, false);
    assert.equal('params' in body, false);
  });
});
