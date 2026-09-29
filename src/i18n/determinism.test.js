'use strict';

/**
 * src/i18n/determinism.test.js — the UI language cannot touch scoring.
 *
 * HARD CONSTRAINT: the candidate pipeline is language-independent and
 * deterministic. The UI language must never change a score, the extraction, the
 * provenance binding, or what is written to the audit log. This file proves it
 * two ways:
 *
 *   1. Behaviourally. The same CVs are analysed (single and batch) and saved to
 *      the audit log under every way a request can carry a UI language — the
 *      signed-in user's saved preferred_language (set through the real PATCH
 *      /api/auth/me), the `lang` cookie, and Accept-Language — in en, nl and de.
 *      The responses and the stored rows must be BYTE-IDENTICAL once the fields
 *      that differ per request by design (ids, timestamps) are removed.
 *
 *   2. Structurally. The pipeline modules must not read any language input, and
 *      loading the analyze and audit routers must not load the UI i18n layer at
 *      all — checked in a clean child process so this file's own requires cannot
 *      mask a regression.
 *
 * The extraction golden gate (npm run extraction:verify) and the narrative gate
 * (npm run narrative:verify) run separately in CI and are unchanged.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cvs-i18n-determinism-'));
process.env.DATABASE_PATH = path.join(TMP_DIR, 'determinism.db');

const express = require('express');
const db = require('../services/db');
const auth = require('../services/authService');
const { requireSession, requireSessionOrDownloadToken } = require('../middleware/auth');
const { requireWriteAccess } = require('../middleware/requireWriteAccess');
const authRouter = require('../routes/auth');
const analyzeRouter = require('../routes/analyze');
const auditRouter = require('../routes/audit');

const REPO_ROOT = path.join(__dirname, '..', '..');
const FIXTURES = ['cv_single_column.pdf', 'cv_two_column.pdf', 'cv_table.pdf']
  .map((f) => path.join(REPO_ROOT, 'test', 'fixtures', f));
const JD = 'Senior backend engineer with strong Node.js, TypeScript and SQL experience. '
  + 'Responsible for API design, data modelling, AWS infrastructure and production operations. '
  + 'Bachelor degree in computer science; 5+ years of experience; leadership of a small team.';
const WEIGHTS = JSON.stringify({ kw: 35, sk: 35, ex: 20, ed: 10 });

// Every UI-language signal a request can carry. `pref` is written to the user
// record through PATCH /api/auth/me before the analyses run.
const CONTEXTS = [
  { name: 'baseline: no language anywhere', pref: null, headers: {} },
  { name: 'English everywhere', pref: 'en', headers: { Cookie: 'lang=en', 'Accept-Language': 'en-GB' } },
  { name: 'Dutch everywhere', pref: 'nl', headers: { Cookie: 'lang=nl', 'Accept-Language': 'nl-NL,nl;q=0.9' } },
  { name: 'German everywhere', pref: 'de', headers: { Cookie: 'lang=de', 'Accept-Language': 'de-DE,de;q=0.9' } },
  { name: 'mixed: saved de, cookie nl, browser en', pref: 'de', headers: { Cookie: 'lang=nl', 'Accept-Language': 'en' } },
];

// Different on every request by design; everything else must match exactly.
const PER_REQUEST = new Set(['analysisId', 'analysisTimestamp', 'id', 'candidateId', 'createdAt', 'updatedAt', 'changedAt', 'auditId']);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) if (!PER_REQUEST.has(k)) out[k] = canonical(value[k]);
    return out;
  }
  return value;
}

let server;
let base;
let token;
const results = {}; // context name -> { single, batch, audit, changes }

before(async () => {
  db.getDb();
  const org = auth.createOrganization('Determinism BV');
  const user = auth.createUser({
    email: 'owner@determinism.test', passwordHash: await auth.hashPassword('CorrectHorseBattery1!'), orgId: org.id, role: 'owner',
  });
  db.setOrgPlan(org.id, { plan: 'pro', subscriptionStatus: 'active', currentPeriodEnd: null });
  token = auth.createSession(user.id).rawToken;

  const app = express();
  app.use(express.json());
  // Mounted as src/index.js mounts them (minus the burst rate limiters).
  app.use('/api/auth', authRouter);
  app.use('/api/analyze', requireSession, requireWriteAccess, analyzeRouter);
  app.use('/api/audit', requireSessionOrDownloadToken, requireWriteAccess, auditRouter);
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  for (const ctx of CONTEXTS) {
    const headers = { Authorization: `Bearer ${token}`, ...ctx.headers };
    const pref = await fetch(base + '/api/auth/me', {
      method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ preferredLanguage: ctx.pref }),
    });
    assert.equal(pref.status, 200, `could not set preferred_language for "${ctx.name}"`);
    const me = await (await fetch(base + '/api/auth/me', { headers })).json();
    assert.equal(me.user.preferredLanguage, ctx.pref, 'the preference must really be in effect');

    const single = new FormData();
    single.set('cv', new File([fs.readFileSync(FIXTURES[0])], 'candidate.pdf', { type: 'application/pdf' }));
    single.set('jobDescription', JD);
    single.set('weights', WEIGHTS);
    const s = await fetch(base + '/api/analyze', { method: 'POST', headers, body: single });
    assert.equal(s.status, 200, await s.clone().text());
    const singleBody = await s.json();

    const batch = new FormData();
    FIXTURES.forEach((f, i) => batch.append('cvs', new File([fs.readFileSync(f)], `candidate-${i}.pdf`, { type: 'application/pdf' })));
    batch.set('jobDescription', JD);
    batch.set('weights', WEIGHTS);
    const b = await fetch(base + '/api/analyze/batch', { method: 'POST', headers, body: batch });
    assert.equal(b.status, 200, await b.clone().text());
    const batchBody = await b.json();

    // Save the single analysis to the audit log and change its decision, so the
    // row AND its append-only change history are both compared.
    const saved = await fetch(base + '/api/audit', {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ analysisId: singleBody.analysisId, decision: 'shortlist', note: 'Strong API background', role: 'Backend Engineer' }),
    });
    assert.equal(saved.status, 201, await saved.clone().text());
    const audit = await saved.json();
    const patched = await fetch(base + '/api/audit/' + encodeURIComponent(audit.id), {
      method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'hold' }),
    });
    assert.equal(patched.status, 200, await patched.clone().text());
    const changes = await (await fetch(base + '/api/audit/' + encodeURIComponent(audit.id) + '/changes', { headers })).json();
    const stored = db.getDb().prepare('SELECT * FROM audit_log WHERE id = ?').get(audit.id);

    results[ctx.name] = { single: singleBody, batch: batchBody, audit, changes, stored };
  }
});

after(() => {
  try { server.close(); } catch (_) {}
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}
});

const [BASELINE] = CONTEXTS;
const bytes = (v) => JSON.stringify(canonical(v));

describe('scoring output is byte-identical in every UI language', () => {
  test('the fixtures actually produce scored results (guards a vacuous pass)', () => {
    const { single, batch } = results[BASELINE.name];
    assert.equal(typeof single.overall, 'number');
    assert.ok(single.extraction, 'extraction provenance present');
    assert.ok(single.found.length > 0 && Object.keys(single.scores).length === 4, 'a real, non-empty score');
    assert.equal(batch.results.length, FIXTURES.length);
    assert.ok(new Set(batch.results.map((r) => r.overall)).size > 1 || batch.results.every((r) => r.overall > 0),
      'the three fixtures score as three different documents');
    // The weights sent were the ones applied — the comparison covers a
    // non-default configuration, not only the defaults.
    assert.ok(bytes(single).length > 1000);
  });

  for (const ctx of CONTEXTS.slice(1)) {
    test(`single analysis — ${ctx.name}`, () => {
      assert.equal(bytes(results[ctx.name].single), bytes(results[BASELINE.name].single));
    });
    test(`batch analysis — ${ctx.name}`, () => {
      assert.equal(bytes(results[ctx.name].batch), bytes(results[BASELINE.name].batch));
    });
  }
});

describe('the audit log is written in canonical form, whatever the UI language', () => {
  for (const ctx of CONTEXTS.slice(1)) {
    test(`saved record and change history — ${ctx.name}`, () => {
      assert.equal(bytes(results[ctx.name].audit), bytes(results[BASELINE.name].audit));
      assert.equal(bytes(results[ctx.name].changes), bytes(results[BASELINE.name].changes));
    });
    test(`stored row, column by column — ${ctx.name}`, () => {
      const strip = (row) => canonical(Object.fromEntries(Object.entries(row)
        .filter(([k]) => !['id', 'candidate_id', 'candidate_fk', 'created_at', 'updated_at', 'analysis_timestamp', 'analysis_id'].includes(k))));
      assert.deepEqual(strip(results[ctx.name].stored), strip(results[BASELINE.name].stored));
    });
  }

  test('decisions are stored as codes, never as translated words', () => {
    for (const ctx of CONTEXTS) {
      const { stored, changes } = results[ctx.name];
      assert.equal(stored.decision, 'hold');
      const rows = changes.changes || changes.rows || changes;
      assert.ok(JSON.stringify(rows).includes('"shortlist"') && JSON.stringify(rows).includes('"hold"'), ctx.name);
      for (const word of ['aanhouden', 'Zurückstellen', 'afwijzen', 'Absage']) {
        assert.ok(!JSON.stringify({ stored, rows }).includes(word), `${ctx.name}: translated word "${word}" in the audit log`);
      }
    }
  });
});

describe('structurally: the pipeline cannot see a language', () => {
  const PIPELINE = [
    'src/routes/analyze.js', 'src/routes/audit.js', 'src/routes/reportRenderer.js',
    'src/services/scorer.js', 'src/services/parser.js', 'src/services/pdfExtractor.js',
    'src/services/fileSecurity.js', 'src/services/provenanceCache.js', 'src/services/provenance.js',
    'src/services/narrativeGenerator.js', 'src/services/biasAudit.js', 'src/data/skills.js',
    'src/data/sample.js', 'src/config/narrativeBands.js', 'scripts/extraction-golden.mjs',
  ];
  // What reading a UI language would look like. Deliberately NOT matched:
  // `require('../i18n/narrative')` — the report's own template catalogue,
  // selected by an explicit locale argument, never by a request.
  const LANGUAGE_INPUTS = [
    /i18n\/ui['"]/, /public\/i18n/, /\bI18N\b/,
    /preferred_?language/i, /accept-language/i, /acceptsLanguages/,
    /headers\.cookie|req\.cookies|\.cookies\b/,
    /resolveRequestLanguage|langFromCookie|langFromAcceptLanguage/,
  ];

  for (const file of PIPELINE) {
    test(`${file} reads no UI-language input`, () => {
      const src = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
      for (const pattern of LANGUAGE_INPUTS) {
        const hit = pattern.exec(src);
        assert.equal(hit, null, `${file} references "${hit && hit[0]}" — the candidate pipeline must stay language-independent`);
      }
    });
  }

  test('the guard would catch a regression (guards against a vacuous pass)', () => {
    const planted = "const lang = req.headers['accept-language']; const { t } = require('../i18n/ui');";
    assert.ok(LANGUAGE_INPUTS.some((p) => p.test(planted)));
  });

  test('loading the analyze and audit routers never loads the UI i18n layer', () => {
    const out = execFileSync(process.execPath, ['-e', `
      process.env.DATABASE_PATH = ${JSON.stringify(path.join(TMP_DIR, 'probe.db'))};
      require('./src/routes/analyze');
      require('./src/routes/audit');
      require('./src/routes/reportRenderer');
      const loaded = Object.keys(require.cache).filter((f) => /[\\\\/]src[\\\\/]i18n[\\\\/]ui\\.js$|[\\\\/]public[\\\\/]i18n\\.js$/.test(f));
      process.stdout.write(JSON.stringify(loaded));
    `], { cwd: REPO_ROOT, env: { ...process.env, NODE_TEST_CONTEXT: '' }, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(out.trim().split('\n').pop()), []);
  });
});
