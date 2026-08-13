'use strict';

/**
 * src/routes/biasReportWiring.test.js
 *
 * The Audit tab's bias-report generator, end to end: the scope the button
 * builds, the endpoint it opens, and the document that comes back.
 *
 * Covers:
 *  - the generate action calls /api/audit/bias-report/pdf with the Audit tab's
 *    active date filters, and with nothing at all when no filters are set
 *    (org-wide is a valid scope, not an error)
 *  - the scope line beside the button states what the report will cover,
 *    including the filters the endpoint cannot honour
 *  - from/to are inclusive org-local days, on the same semantics as the audit
 *    list endpoint — the report and the table must not disagree about a range
 *  - a 0-record scope renders the insufficient-data banner and HTTP 200, with
 *    no minimum-record gate anywhere
 *  - the multi-role caveat appears above Data Reliability, only when the
 *    records span more than one role
 *  - branding, the provenance footer and the on-dark plate all survive the real
 *    request path, not just a direct call to the renderer
 *
 * The frontend assertions run the functions AS SHIPPED: they are extracted from
 * public/app.html by name and evaluated in a vm sandbox. There is no DOM
 * library in this project and adding one for three pure functions is not worth
 * the dependency, but a hand-copied duplicate of the logic would test nothing.
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const vm = require('node:vm');

// Isolate on a throwaway sqlite file. Must be set BEFORE ./db is first required.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fitscore-bias-wiring-test-'));
process.env.DATABASE_PATH = path.join(TMP_DIR, 'bias-wiring-test.db');

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { getDb, closeDb, candidateIdFor } = require('../services/db');
const { assertSoberLanguage, roleSpan } = require('../services/biasAudit');
const authService = require('../services/authService');
const { requireSessionOrDownloadToken } = require('../middleware/auth');
const auditRouter = require('./audit');

const ORG_UTC = 'org-utc';       // UTC, for plain day-boundary assertions
const ORG_AMS = 'org-ams';       // Europe/Amsterdam, for offset assertions
const ORG_EMPTY = 'org-empty';   // no records at all
const ORG_BRAND = 'org-brand';   // white-labelled, entitled

// A 1x1 PNG, the smallest thing that satisfies the logo data-URI validator.
const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let server;
let baseUrl;
// A second app mounted behind the REAL auth middleware. The stubbed-auth app
// above cannot see the ?dt= allowlist, and the allowlist is where this feature
// broke: the button opens the report in a new tab, which cannot carry an
// Authorization header, so /bias-report/pdf has to be on it.
let realAuthServer;
let realAuthUrl;
let seq = 0;

function makeOrg(id, timezone, extra = {}) {
  getDb().prepare('INSERT INTO organizations (id, name, created_at, timezone) VALUES (?, ?, ?, ?)')
    .run(id, id, new Date().toISOString(), timezone);
  if (extra.plan) {
    getDb().prepare('UPDATE organizations SET plan = ?, subscription_status = ? WHERE id = ?')
      .run(extra.plan, extra.subscriptionStatus || null, id);
  }
  if (extra.brandDisplayName || extra.brandLogoData) {
    getDb().prepare('UPDATE organizations SET brand_display_name = ?, brand_logo_data = ? WHERE id = ?')
      .run(extra.brandDisplayName || null, extra.brandLogoData || null, id);
  }
}

// Insert directly so created_at and role are controlled precisely.
function seed({ orgId, name = 'Candidate', role = 'Backend Engineer', decision = 'shortlist', overall = 70, createdAt }) {
  const id = `bw-${String(++seq).padStart(4, '0')}`;
  getDb().prepare(
    `INSERT INTO audit_log (id, org_id, candidate_id, candidate_name, user_id, role, decision, overall, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, orgId, candidateIdFor(orgId, name), name, 'user-1', role, decision, overall, createdAt);
  return id;
}

async function getJson(query, orgId = ORG_UTC) {
  const res = await fetch(`${baseUrl}/api/audit/bias-report${query}`, { headers: { 'x-test-org': orgId } });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}
async function getHtml(query, orgId = ORG_UTC) {
  const res = await fetch(`${baseUrl}/api/audit/bias-report/pdf${query}`, { headers: { 'x-test-org': orgId } });
  return { status: res.status, html: await res.text(), contentType: res.headers.get('content-type') };
}

// --- the shipped frontend, extracted -----------------------------------------
// Pull named top-level function declarations (and the const the scope helpers
// read) out of public/app.html by brace matching, so these tests exercise the
// same source the browser runs.
const APP_HTML = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'app.html'), 'utf8');

function extractFunction(name) {
  const start = APP_HTML.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, `expected public/app.html to declare function ${name}()`);
  let depth = 0;
  let i = APP_HTML.indexOf('{', start);
  const open = i;
  for (; i < APP_HTML.length; i++) {
    if (APP_HTML[i] === '{') depth++;
    else if (APP_HTML[i] === '}') { depth--; if (depth === 0) break; }
  }
  assert.ok(i > open, `could not brace-match function ${name}()`);
  return APP_HTML.slice(start, i + 1);
}
function extractConst(decl) {
  const start = APP_HTML.indexOf('const ' + decl);
  assert.notEqual(start, -1, `expected public/app.html to declare const ${decl}`);
  const end = APP_HTML.indexOf('\n', start);
  return APP_HTML.slice(start, end);
}

// Build a sandbox holding the real functions plus the minimum they touch.
// `opened` records what openBiasReport would have handed to the browser.
function makeAppSandbox(filterState = {}) {
  const opened = [];
  const ctx = {
    API: 'https://api.example',
    auditFilter: Object.assign(
      { from: '', to: '', search: '', actor: '', action: '', order: 'desc', limit: 50, offset: 0, total: null },
      filterState,
    ),
    URLSearchParams,
    openWithDownloadToken: (url) => { opened.push(url); },
    escHtml: (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    opened,
  };
  vm.createContext(ctx);
  const src = [
    extractConst('BIAS_MONTHS'),
    extractFunction('buildBiasReportQuery'),
    extractFunction('fmtDayLabel'),
    extractFunction('biasReportScope'),
    extractFunction('openBiasReport'),
  ].join('\n');
  vm.runInContext(src, ctx);
  return ctx;
}

before(async () => {
  const app = express();
  app.use(express.json());
  // Stubbed auth, mirroring the real middleware: org scope is server-derived.
  app.use((req, _res, next) => { req.orgId = req.header('x-test-org'); req.userId = 'tester'; next(); });
  app.use('/api/audit', auditRouter);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const realApp = express();
  realApp.use(express.json());
  realApp.use('/api/audit', requireSessionOrDownloadToken, auditRouter);
  await new Promise((resolve) => { realAuthServer = realApp.listen(0, '127.0.0.1', resolve); });
  realAuthUrl = `http://127.0.0.1:${realAuthServer.address().port}`;

  makeOrg(ORG_UTC, 'UTC');
  makeOrg(ORG_AMS, 'Europe/Amsterdam');
  makeOrg(ORG_EMPTY, 'UTC');
  makeOrg(ORG_BRAND, 'UTC', {
    plan: 'pro', subscriptionStatus: 'active',
    brandDisplayName: 'Acme Recruitment', brandLogoData: PNG_1PX,
  });

  // ORG_UTC: a single role, with rows at both ends of 2026-03-15 UTC.
  seed({ orgId: ORG_UTC, name: 'Ana',  createdAt: '2026-03-15T00:00:00.000Z' });
  seed({ orgId: ORG_UTC, name: 'Ben',  createdAt: '2026-03-15T23:59:59.999Z' });
  seed({ orgId: ORG_UTC, name: 'Cara', createdAt: '2026-03-20T12:00:00.000Z' });
  seed({ orgId: ORG_UTC, name: 'Dev',  createdAt: '2026-04-02T12:00:00.000Z' });

  // ORG_AMS: 2026-03-15 local runs 2026-03-14T23:00Z .. 2026-03-15T22:59:59Z (UTC+1).
  seed({ orgId: ORG_AMS, name: 'Eve',  createdAt: '2026-03-14T23:30:00.000Z' }); // 00:30 local on the 15th
  seed({ orgId: ORG_AMS, name: 'Finn', createdAt: '2026-03-15T22:30:00.000Z' }); // 23:30 local on the 15th
  seed({ orgId: ORG_AMS, name: 'Gus',  createdAt: '2026-03-15T23:30:00.000Z' }); // 00:30 local on the 16th

  // ORG_BRAND: two roles, so the multi-role caveat has something to say.
  seed({ orgId: ORG_BRAND, name: 'Hana', role: 'Backend Engineer', createdAt: '2026-03-10T10:00:00.000Z' });
  seed({ orgId: ORG_BRAND, name: 'Iris', role: 'Backend Engineer', createdAt: '2026-03-11T10:00:00.000Z' });
  seed({ orgId: ORG_BRAND, name: 'Jae',  role: 'Data Analyst',     createdAt: '2026-03-12T10:00:00.000Z' });
});

after(() => {
  if (server) server.close();
  if (realAuthServer) realAuthServer.close();
  closeDb();
});

// ---------------------------------------------------------------------------
describe('the ?dt= download-token allowlist covers the report', () => {
  // Regression: the button opens the report in a new tab via a single-use
  // download token, exactly as the candidate report and CSV export do. The
  // allowlist named only those two, so the wired-up button 401'd in a real
  // browser while every stubbed-auth route test passed.
  const dt = () => authService.createDownloadToken({ orgId: ORG_BRAND, userId: 'tester' });

  test('a valid download token authenticates /bias-report/pdf', async () => {
    const res = await fetch(`${realAuthUrl}/api/audit/bias-report/pdf?dt=${dt()}`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Bias Monitoring Report/);
  });

  test('it carries the org scope from the token, not from the caller', async () => {
    const res = await fetch(`${realAuthUrl}/api/audit/bias-report/pdf?dt=${dt()}`);
    assert.match(await res.text(), /Acme Recruitment/);
  });

  test('the token survives the date params the button appends', async () => {
    const res = await fetch(`${realAuthUrl}/api/audit/bias-report/pdf?from=2026-03-10&to=2026-03-12&dt=${dt()}`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /3 records analysed/);
  });

  test('no token is still a 401 — the report is not public', async () => {
    const res = await fetch(`${realAuthUrl}/api/audit/bias-report/pdf`);
    assert.equal(res.status, 401);
  });

  test('a bogus token is a 401', async () => {
    const res = await fetch(`${realAuthUrl}/api/audit/bias-report/pdf?dt=not-a-real-token`);
    assert.equal(res.status, 401);
  });

  test('the token is single-use', async () => {
    const t = dt();
    assert.equal((await fetch(`${realAuthUrl}/api/audit/bias-report/pdf?dt=${t}`)).status, 200);
    assert.equal((await fetch(`${realAuthUrl}/api/audit/bias-report/pdf?dt=${t}`)).status, 401);
  });

  test('the JSON variant is NOT on the allowlist — nothing opens it in a window', async () => {
    const res = await fetch(`${realAuthUrl}/api/audit/bias-report?dt=${dt()}`);
    assert.equal(res.status, 401, 'a download token must not unlock the JSON endpoint');
  });
});

// ---------------------------------------------------------------------------
describe('Audit tab generate action — the URL it opens', () => {
  test('sends the active from/to date filters', () => {
    const ctx = makeAppSandbox({ from: '2026-03-01', to: '2026-03-31' });
    ctx.openBiasReport();
    assert.equal(ctx.opened.length, 1);
    const u = new URL(ctx.opened[0]);
    assert.equal(u.pathname, '/api/audit/bias-report/pdf');
    assert.equal(u.searchParams.get('from'), '2026-03-01');
    assert.equal(u.searchParams.get('to'), '2026-03-31');
  });

  test('uses the /pdf variant, which is what returns the printable page', () => {
    const ctx = makeAppSandbox();
    ctx.openBiasReport();
    assert.ok(ctx.opened[0].endsWith('/api/audit/bias-report/pdf'), ctx.opened[0]);
  });

  test('no filters produces an org-wide request — no date params at all', () => {
    const ctx = makeAppSandbox();
    ctx.openBiasReport();
    assert.equal(ctx.opened[0], 'https://api.example/api/audit/bias-report/pdf');
    assert.ok(!ctx.opened[0].includes('?'), 'an unfiltered scope must not send an empty query string');
  });

  test('an open-ended range sends only the bound that is set', () => {
    const fromOnly = makeAppSandbox({ from: '2026-03-01' });
    fromOnly.openBiasReport();
    let u = new URL(fromOnly.opened[0]);
    assert.equal(u.searchParams.get('from'), '2026-03-01');
    assert.equal(u.searchParams.get('to'), null);

    const toOnly = makeAppSandbox({ to: '2026-03-31' });
    toOnly.openBiasReport();
    u = new URL(toOnly.opened[0]);
    assert.equal(u.searchParams.get('from'), null);
    assert.equal(u.searchParams.get('to'), '2026-03-31');
  });

  test('filters the endpoint cannot honour are never silently sent', () => {
    const ctx = makeAppSandbox({ from: '2026-03-01', search: 'cand-123', actor: 'user-9', action: 'reject' });
    ctx.openBiasReport();
    const u = new URL(ctx.opened[0]);
    assert.deepEqual([...u.searchParams.keys()], ['from']);
  });
});

// ---------------------------------------------------------------------------
describe('Audit tab generate action — the scope it states', () => {
  test('a bounded range is stated as its two calendar days', () => {
    const ctx = makeAppSandbox({ from: '2026-03-01', to: '2026-03-31' });
    const s = ctx.biasReportScope();
    assert.equal(s.range, '1 Mar 2026 to 31 Mar 2026');
    assert.equal(s.unbounded, false);
  });

  test('no filters is stated as org-wide, not left to be inferred', () => {
    const ctx = makeAppSandbox();
    const s = ctx.biasReportScope();
    assert.equal(s.range, 'all dates');
    assert.equal(s.unbounded, true);
  });

  test('open-ended ranges read as ranges, not as blanks', () => {
    assert.equal(makeAppSandbox({ from: '2026-03-01' }).biasReportScope().range, '1 Mar 2026 onwards');
    assert.equal(makeAppSandbox({ to: '2026-03-31' }).biasReportScope().range, 'everything up to 31 Mar 2026');
  });

  test('day labels are formatted from the string, not reinterpreted through Date', () => {
    // A browser west of UTC would shift this back a day if it round-tripped
    // through Date, and the label would contradict the range actually sent.
    const ctx = makeAppSandbox();
    assert.equal(ctx.fmtDayLabel('2026-01-01'), '1 Jan 2026');
    assert.equal(ctx.fmtDayLabel('2026-12-31'), '31 Dec 2026');
  });

  // Arrays built inside the vm belong to that realm, so they are spread into
  // host arrays before comparison — deepStrictEqual checks the prototype.
  test('unsupported active filters are named so the scope is never a surprise', () => {
    const ctx = makeAppSandbox({ actor: 'user-9', action: 'reject', search: 'cand-1' });
    assert.deepEqual([...ctx.biasReportScope().ignored], ['candidate', 'actor', 'action']);
  });

  test('no unsupported filters means nothing to warn about', () => {
    assert.deepEqual([...makeAppSandbox({ from: '2026-03-01' }).biasReportScope().ignored], []);
  });
});

// ---------------------------------------------------------------------------
describe('bias report scope — inclusive org-local days', () => {
  test('to includes its own day (the whole end day, not up to midnight)', async () => {
    // Both 2026-03-15 rows sit inside a range ending on the 15th. Before the
    // fix the raw day string string-compared against the UTC ISO created_at and
    // dropped the entire day.
    const { status, body } = await getJson('?from=2026-03-15&to=2026-03-15');
    assert.equal(status, 200);
    assert.equal(body.scope.totalRecords, 2);
  });

  test('from includes rows at the exact start of its day', async () => {
    const { body } = await getJson('?from=2026-03-15&to=2026-03-20');
    assert.equal(body.scope.totalRecords, 3);
  });

  test('the range matches what the audit list endpoint returns for the same days', async () => {
    const q = '?from=2026-03-15&to=2026-03-20';
    const listRes = await fetch(`${baseUrl}/api/audit${q}&limit=200`, { headers: { 'x-test-org': ORG_UTC } });
    const list = await listRes.json();
    const report = (await getJson(q)).body;
    assert.equal(
      report.scope.totalRecords, list.total,
      'the report and the table must cover the same records for the same visible range',
    );
  });

  test('day bounds are resolved in the org timezone, not UTC', async () => {
    // Amsterdam is UTC+1 in March. 2026-03-15 local holds Eve (00:30) and Finn
    // (23:30) but not Gus, who is 00:30 on the 16th local.
    const { body } = await getJson('?from=2026-03-15&to=2026-03-15', ORG_AMS);
    assert.equal(body.scope.totalRecords, 2);
  });

  test('the report header still shows the calendar days the user asked for', async () => {
    const { body } = await getJson('?from=2026-03-15&to=2026-03-20');
    assert.equal(body.scope.from, '2026-03-15');
    assert.equal(body.scope.to, '2026-03-20');
  });

  test('a malformed date is a 400, never a silently unfiltered report', async () => {
    for (const q of ['?from=15-03-2026', '?to=not-a-date', '?from=2026-02-31']) {
      const { status, body } = await getJson(q);
      assert.equal(status, 400, `${q} must be rejected`);
      assert.match(String(body.error), /valid date/i);
    }
  });

  test('the same rules apply to the /pdf variant', async () => {
    const bad = await getHtml('?to=2026-13-45');
    assert.equal(bad.status, 400);
    const ok = await getHtml('?from=2026-03-15&to=2026-03-15');
    assert.equal(ok.status, 200);
    assert.match(ok.html, /2 records analysed/);
  });
});

// ---------------------------------------------------------------------------
describe('bias report at zero records', () => {
  test('an org with no records renders, with the insufficient banner and no error', async () => {
    const { status, html, contentType } = await getHtml('', ORG_EMPTY);
    assert.equal(status, 200);
    assert.match(contentType, /text\/html/);
    assert.match(html, /RELIABILITY: INSUFFICIENT/);
    assert.match(html, /0 records analysed/);
    assert.doesNotMatch(html, /INTERNAL_ERROR/);
  });

  test('a filtered range that matches nothing renders the same way, not an empty state', async () => {
    const { status, html } = await getHtml('?from=2020-01-01&to=2020-01-02');
    assert.equal(status, 200);
    assert.match(html, /RELIABILITY: INSUFFICIENT/);
    assert.match(html, /0 records analysed/);
  });

  test('the JSON variant reports insufficient rather than refusing', async () => {
    const { status, body } = await getJson('', ORG_EMPTY);
    assert.equal(status, 200);
    assert.equal(body.reliability, 'insufficient');
    assert.equal(body.scope.totalRecords, 0);
  });
});

// ---------------------------------------------------------------------------
describe('multi-role caveat', () => {
  test('is absent when every record shares one role', () => {
    const span = roleSpan([{ role: 'Backend Engineer' }, { role: 'Backend Engineer' }]);
    assert.equal(span.mixed, false);
    assert.equal(span.caveat, null);
  });

  test('is present when the records span more than one role', () => {
    const span = roleSpan([{ role: 'Backend Engineer' }, { role: 'Data Analyst' }]);
    assert.equal(span.mixed, true);
    assert.match(span.caveat, /span more than one role/);
  });

  test('names each role with its record count', () => {
    const span = roleSpan([
      { role: 'Backend Engineer' }, { role: 'Backend Engineer' }, { role: 'Data Analyst' },
    ]);
    assert.deepEqual(span.roles, [
      { role: 'Backend Engineer', count: 2 },
      { role: 'Data Analyst', count: 1 },
    ]);
    assert.match(span.caveat, /Backend Engineer \(2\)/);
    assert.match(span.caveat, /Data Analyst \(1\)/);
  });

  test('records with no role count as their own group', () => {
    const span = roleSpan([{ role: 'Backend Engineer' }, { role: null }]);
    assert.equal(span.mixed, true);
    assert.equal(span.unlabelled, 1);
    assert.match(span.caveat, /1 record has no role recorded/);
  });

  test('a single unlabelled group is not a span', () => {
    const span = roleSpan([{ role: null }, { role: null }]);
    assert.equal(span.mixed, false);
    assert.equal(span.caveat, null);
  });

  test('explains why cross-role figures are not comparable', () => {
    const span = roleSpan([{ role: 'A' }, { role: 'B' }]);
    assert.match(span.caveat, /scored against the job description for their own role/);
    assert.match(span.caveat, /not directly comparable/);
  });

  test('passes assertSoberLanguage', () => {
    const span = roleSpan([{ role: 'A' }, { role: 'B' }, { role: null }]);
    assert.doesNotThrow(() => assertSoberLanguage(span));
  });

  test('renders ABOVE the Data Reliability section', async () => {
    const { html } = await getHtml('', ORG_BRAND);
    const caveat = html.indexOf('span more than one role');
    const reliability = html.indexOf('Data Reliability');
    assert.notEqual(caveat, -1, 'the multi-role caveat must render');
    assert.notEqual(reliability, -1);
    assert.ok(caveat < reliability, 'the caveat must be met before the figures it qualifies');
  });

  test('renders at caveat weight, alongside the mixed-engine one', async () => {
    const { html } = await getHtml('', ORG_BRAND);
    assert.match(html, /<div class="caveat"><strong>Before you read these figures<\/strong>These records span more than one role/);
  });

  test('does not render for a single-role org', async () => {
    const { html } = await getHtml('', ORG_UTC);
    assert.doesNotMatch(html, /span more than one role/);
  });

  test('is also carried in limitations, for consumers that read only that', async () => {
    const { body } = await getJson('', ORG_BRAND);
    assert.ok(
      body.limitations.some((l) => /span more than one role/.test(l)),
      'the caveat must survive into the limitations list',
    );
  });
});

// ---------------------------------------------------------------------------
describe('the real request path still renders branding and provenance', () => {
  test('a white-labelled org gets its own mark and name through the HTTP route', async () => {
    const { status, html } = await getHtml('', ORG_BRAND);
    assert.equal(status, 200);
    assert.match(html, /Acme Recruitment/);
    assert.match(html, /<img src="data:image\/png;base64,/);
  });

  test('the on-dark plate is applied to a raster logo on the navy header', async () => {
    const { html } = await getHtml('', ORG_BRAND);
    assert.match(html, /class="mark markimg plate"/);
    assert.match(html, /\.brandrow \.plate\s*\{[^}]*print-color-adjust: exact/);
  });

  test('an unbranded org still gets the CVsprings mark, not a bare header', async () => {
    const { html } = await getHtml('', ORG_UTC);
    assert.match(html, /CVsprings/);
    assert.match(html, /<span class="mark" aria-hidden="true"><svg/);
    assert.doesNotMatch(html, /class="mark markimg/);
  });

  test('the provenance footer renders on a branded report', async () => {
    const { html } = await getHtml('', ORG_BRAND);
    assert.match(html, /class="prov-line"/);
    assert.match(html, /Fingerprint/i);
  });

  test('the provenance footer renders on an unbranded one too', async () => {
    const { html } = await getHtml('', ORG_UTC);
    assert.match(html, /class="prov-line"/);
  });

  test('the date-scoped report a filtered Audit tab opens carries all of it', async () => {
    // The exact URL the button builds for a bounded range, driven for real.
    const ctx = makeAppSandbox({ from: '2026-03-10', to: '2026-03-12' });
    ctx.openBiasReport();
    const query = new URL(ctx.opened[0]).search;

    const { status, html } = await getHtml(query, ORG_BRAND);
    assert.equal(status, 200);
    assert.match(html, /Acme Recruitment/);
    assert.match(html, /class="mark markimg plate"/);
    assert.match(html, /class="prov-line"/);
    assert.match(html, /3 records analysed/);
    assert.match(html, /2026-03-10 to 2026-03-12/);
  });
});

// ---------------------------------------------------------------------------
describe('no minimum-record gate exists', () => {
  test('every sample size from 0 to 3 returns 200 with a reliability banner', async () => {
    const cases = [
      ['', ORG_EMPTY],                                  // 0 records
      ['?from=2026-03-20&to=2026-03-20', ORG_UTC],      // 1 record
      ['?from=2026-03-15&to=2026-03-15', ORG_UTC],      // 2 records
      ['', ORG_BRAND],                                  // 3 records
    ];
    for (const [q, org] of cases) {
      const { status, html } = await getHtml(q, org);
      assert.equal(status, 200, `${org}${q} must render`);
      assert.match(html, /RELIABILITY: (INSUFFICIENT|LOW|MODERATE|HIGH)/, `${org}${q} must carry a banner`);
    }
  });
});

// ---------------------------------------------------------------------------
describe('the Audit tab markup wires the action up', () => {
  test('the generate button exists and is bound to openBiasReport', () => {
    assert.match(APP_HTML, /data-action="openBiasReport"/);
    assert.match(APP_HTML, /loadAudit, exportAuditCsv, openBiasReport,/);
  });

  test('the button says it opens a page, never "Download PDF"', () => {
    const btn = /<button[^>]*data-action="openBiasReport"[^>]*>([^<]*)<\/button>/.exec(APP_HTML);
    assert.ok(btn, 'the generate button must be in the markup');
    assert.doesNotMatch(btn[1], /download/i);
    assert.match(APP_HTML, /Opens a print-optimised page in a new tab/);
  });

  test('the button is never disabled — no record-count gate in the UI either', () => {
    const btn = /<button[^>]*data-action="openBiasReport"[^>]*>/.exec(APP_HTML)[0];
    assert.doesNotMatch(btn, /disabled/);
  });

  // The link has moved twice: out of the top nav into the account dropdown when
  // the header was restructured, then back to the nav under a shorter label
  // once the overflow was traced to the label rather than the item count. What
  // matters has never changed — it points at the methodology page and it is not
  // the generator — so the assertion tracks those two facts, not its position.
  test('the explainer link points at the methodology page and is named for it', () => {
    assert.match(APP_HTML, /<a class="nav-btn" href="\/bias-report\.html">Bias monitoring<\/a>/);
  });

  test('it is a nav link, not the generator', () => {
    const nav = /<nav class="topbar-nav"[^>]*>([\s\S]*?)<\/nav>/.exec(APP_HTML);
    assert.ok(nav, 'the primary nav must still exist');
    assert.match(nav[1], /bias-report\.html/);
    assert.doesNotMatch(nav[1], /openBiasReport/, 'the generator lives in the Audit tab');
  });

  test('the methodology links elsewhere in the app are untouched', () => {
    // The footer link and the in-app modal reference must keep pointing at the
    // static page — those are correct and out of scope for this change.
    assert.match(APP_HTML, /<a class="footer-link" href="\/bias-report\.html">Bias &amp; monitoring<\/a>/);
    assert.match(APP_HTML, /<a href="\/bias-report\.html" style="color:#0f2847">methodology page<\/a>/);
  });
});
