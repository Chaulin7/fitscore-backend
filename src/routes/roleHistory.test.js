'use strict';

/**
 * src/routes/roleHistory.test.js — GET /api/audit/roles and
 * /api/audit/roles/:role/history.
 *
 * The history used to select only the overall score, so the table's four
 * sub-score columns always read "—". It now returns them, and — like every
 * surface that ranks or averages — leaves out records without a score (a CV
 * that could not be analysed; see services/scoredRecord.js), in the list and
 * in the role counts alike.
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fitscore-rolehist-test-'));
process.env.DATABASE_PATH = path.join(TMP_DIR, 'rolehist.db');

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { getDb, closeDb } = require('../services/db');
const auditRouter = require('./audit');

const ORG = 'org-rolehist';
let server; let base;

function row(id, name, overall, subs, decision, minutesAgo, role = 'Controller', org = ORG) {
  const at = new Date(Date.now() - minutesAgo * 60000).toISOString();
  getDb().prepare(`INSERT INTO audit_log (id, user_id, org_id, candidate_name, overall, keywords_score, skills_score,
      experience_score, education_score, decision, role, anonymized, created_at, updated_at)
    VALUES (?, 'u', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`)
    .run(id, org, name, overall, ...(subs || [null, null, null, null]), decision, role, at, at);
}

before(async () => {
  getDb();
  // Newest first: the newest is NOT the highest.
  row('r1', 'Newest', 55, [50, 60, 55, 40], 'hold', 1);
  row('r2', 'Best', 91, [95, 90, 88, 80], 'shortlist', 2);
  row('r3', 'Oldest', 72, [70, 75, 70, 60], null, 3);
  row('r4', 'Unscored', null, null, 'shortlist', 0); // the pre-binding app could save this
  row('r5', 'Other org', 99, [99, 99, 99, 99], null, 0, 'Controller', 'org-other');
  row('r6', 'Only unscored', null, null, null, 0, 'Ghost role');
  const app = express();
  app.use((req, _res, next) => { req.orgId = ORG; req.userId = 'u'; next(); });
  app.use('/api/audit', auditRouter);
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { if (server) server.close(); closeDb(); try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {} });

const get = async (p) => (await fetch(base + p)).json();

describe('role history', () => {
  test('each record carries its four sub-scores', async () => {
    const history = await get('/api/audit/roles/Controller/history');
    const best = history.find((r) => r.candidateName === 'Best');
    assert.deepEqual(best.scores, { keywords: 95, skills: 90, experience: 88, education: 80 });
    for (const r of history) {
      for (const k of ['keywords', 'skills', 'experience', 'education']) assert.equal(typeof r.scores[k], 'number', `${r.candidateName}.${k}`);
    }
  });

  test('newest first, scored records only, this org only', async () => {
    const history = await get('/api/audit/roles/Controller/history');
    assert.deepEqual(history.map((r) => r.candidateName), ['Newest', 'Best', 'Oldest']);
  });

  test('the role counts match the tables: scored records only', async () => {
    const roles = await get('/api/audit/roles');
    assert.deepEqual(roles.map((r) => [r.role, r.count]), [['Controller', 3]],
      'a role whose only records are unscored has no tab');
  });
});
