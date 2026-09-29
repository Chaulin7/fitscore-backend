'use strict';

/**
 * src/i18n/appRender.test.js — the app's renderers, in every UI language.
 *
 * The functions are lifted out of public/app.html and run against miniDom with
 * the real public/i18n.js and the real dictionary for each language, exactly
 * as the other pageSandbox tests do for English. For each surface:
 *
 *   - no translation key is left showing (a missing key renders as the key),
 *   - in Dutch and German, none of the surface's English copy survives,
 *   - what the code acts on is language-free: option values stay the decision
 *     codes, data-* attributes are the same in every language.
 *
 * Scorer text (Why this score?, Recommendations) is English on purpose until
 * Phase 3; it is checked for being marked lang="en", not for being translated.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { extractFunction, extractLine, i18nFor } = require('../../test/helpers/pageSandbox');

const APP_HTML = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'app.html'), 'utf8');
const LANGS = ['en', 'nl', 'de'];
const RAW_KEY = /\b(?:app|settings|errors|plans|common|auth)\.[a-zA-Z_]+\.[a-zA-Z0-9_.]+|\b(?:app|settings|errors)\.[a-zA-Z_]+\b(?![@\w])/;

const FUNCTIONS = [
  'h', 'appendKids', 'fill', 'setKey', 'svg', 'decisionLabel', 'getScoreThreshold', 'scoreColor',
  'fmtInOrgTz', 'auditActiveFilterCount', 'renderAuditTable', 'renderAuditPager', 'updateAuditLegacyNote',
  'fmtDayLabel', 'biasReportScope', 'listOf', 'updateBiasGenScope',
  'retMonths', 'fmtDate', 'fmtDateTime', 'renderRetentionStats', 'renderPurgeRuns',
  '_fmtWhen', 'renderTeam', 'renderBatchResults', 'updateBatchSummary',
  'renderSingleResult', 'ringBox', 'buildWhyNodes', 'renderPlanChip', 'renderFileList', 'fileKey',
  'isFailedResult', 'failedReason', 'apiErrorText', 'isNetworkError', 'exportBatchCsv', 'escCsv',
];
const CONSTANTS = ['const DECISION_KEYS =', 'const BIAS_FILTER_KEYS ='];

const IDS = [
  'auditBody', 'auditPager', 'auditLegacyNote', 'biasGenScope', 'retStats', 'retHistoryWrap', 'retHistory',
  'teamBody', 'teamInviteRow', 'batchResults', 'singleResults', 'batchTitle', 'batchBody', 'batchSummary',
  'bsTotalCVs', 'bsAvgScore', 'bsShortlisted', 'bsSubThreshold', 'bsTopCandidate', 'resultName', 'scoreRow',
  'singleWhy', 'foundChips', 'missingChips', 'planChip', 'planChipLabel', 'fileList', 'fileListHead',
  'batchFailedNote', 'bsFailedSub',
];

function appSandbox(lang, state = {}) {
  const { I18N, document } = i18nFor(lang);
  for (const id of IDS) {
    const el = document.createElement('div');
    el.id = id;
    document.documentElement.appendChild(el);
  }
  for (const id of ['skillsTable', 'recsTable']) {
    const table = document.createElement('table');
    table.id = id;
    table.appendChild(document.createElement('tbody'));
    document.documentElement.appendChild(table);
  }
  const ctx = vm.createContext({
    I18N, document, console,
    localStorage: { getItem: () => null },
    requestAnimationFrame: (fn) => fn(),
    getBatchNote: () => '',
    syncFeatureRequestNav: () => {},
    auditFilter: Object.assign({ from: '', to: '', search: '', actor: '', action: '', order: 'desc', limit: 50, offset: 0, total: 0 }, state.auditFilter),
    _auditTimezone: 'Europe/Amsterdam',
    _team: state.team || null,
    _teamIsOwner: !!state.teamIsOwner,
    selectedFiles: state.files || [],
    mode: 'batch',
    lastBatchResults: state.batch || [],
    download: (name, body) => { ctx.__downloaded = { name, body }; },
  });
  vm.runInContext([
    ...CONSTANTS.map((c) => extractLine(APP_HTML, c)),
    ...FUNCTIONS.map((n) => extractFunction(APP_HTML, n)),
  ].join('\n'), ctx);
  const byId = (id) => document.getElementById(id);
  return { ctx, byId, run: (src) => vm.runInContext(src, ctx) };
}

function text(el) { return el.textContent.replace(/\s+/g, ' ').trim(); }

// English giveaways per surface: if one of these survives in nl/de, a string
// was missed. ("Shortlist" is the glossary term in all three languages.)
const ENGLISH = {
  audit: /Show all events|legacy ID|\(anon\)|Change history|Delete record|Showing \d|Prev|Next|\bHold\b|\bReject\b|Note…/,
  auditEmpty: /No audit events yet|No events match|Clear all filters|Try widening/,
  scope: /Covers|all roles|every record|is not applied|filters are not applied|onwards|everything up to|all dates/,
  retention: /Purge mode|Audit rows stored|Oldest retained|Deletes events before|Feature requests stored|Next purge|past the retention|dry run|would delete|Ran at|Duration/,
  team: /Members|Pending invites|last active|Revoke|Remove|owner\)|member\)|seats used/,
  batch: /Ranked results|Candidate #|— Decision —|\bSave\b|\bNotes\b|\bHold\b|\bReject\b/,
  single: /Overall|Keywords Found|None found|None missing|Found|Missing|No skills data|No recommendations|Anonymous Candidate/,
  chip: /Payment issue|Free ·/,
  files: /staged|Clear all|Remove /,
};

const RECORDS = [
  { id: 'r1', createdAt: '2026-03-15T09:30:00.000Z', candidateId: 'c1', candidateName: 'Jansen', role: 'Controller', overall: 81, scores: { keywords: 80, skills: 90, experience: 70, education: 60 }, decision: 'shortlist', note: 'good', reviewedBy: 'a@b.nl', anonymized: true, candidateLegacy: true },
  { id: 'r2', createdAt: '2026-03-16T09:30:00.000Z', candidateId: 'c2', candidateName: 'Müller', role: '', overall: 40, scores: {}, decision: 'hold', note: '', reviewedBy: '' },
];

describe('the audit log', () => {
  for (const lang of LANGS) {
    test(`${lang}: rows, pager and legacy note`, () => {
      const { byId, run } = appSandbox(lang, { auditFilter: { total: 120, offset: 50, limit: 50 } });
      run('renderAuditTable(' + JSON.stringify(RECORDS) + '); renderAuditPager(); updateAuditLegacyNote(' + JSON.stringify(RECORDS) + ')');
      const all = text(byId('auditBody')) + ' ' + text(byId('auditPager')) + ' ' + text(byId('auditLegacyNote'))
        + ' ' + byId('auditBody').innerHTML.match(/(?:title|aria-label|placeholder)="[^"]*"/g).join(' ');
      assert.doesNotMatch(all, RAW_KEY);
      if (lang === 'en') assert.match(all, /Showing 51–100 of 120/);
      else assert.doesNotMatch(all, ENGLISH.audit);
      // Decisions: labels translated, values the stored codes.
      const values = [...byId('auditBody').innerHTML.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]);
      assert.deepEqual([...new Set(values)], ['', 'shortlist', 'hold', 'reject']);
    });
    test(`${lang}: the empty and no-match states`, () => {
      for (const auditFilter of [{}, { actor: 'u1' }]) {
        const { byId, run } = appSandbox(lang, { auditFilter });
        run('renderAuditTable([])');
        assert.doesNotMatch(text(byId('auditBody')), RAW_KEY);
        if (lang !== 'en') assert.doesNotMatch(text(byId('auditBody')), ENGLISH.auditEmpty);
      }
    });
  }
  test('dates follow the language, in the org timezone', () => {
    const cell = (lang) => { const s = appSandbox(lang); s.run('renderAuditTable(' + JSON.stringify(RECORDS) + ')'); return s.byId('auditBody').querySelector('td').textContent; };
    // 09:30 UTC is 10:30 in Amsterdam in March. English is pinned exactly; the
    // nl/de separators vary by ICU version, so those pin month and clock.
    assert.equal(cell('en'), '15 Mar 2026, 10:30');
    assert.match(cell('nl'), /^15 mrt 2026\D+10:30$/);
    assert.match(cell('de'), /^15\. März 2026\D+10:30$/);
  });
});

describe('the bias report scope line', () => {
  for (const lang of LANGS) {
    test(`${lang}: bounded, open-ended and with unsupported filters`, () => {
      for (const auditFilter of [{}, { from: '2026-03-01', to: '2026-03-31' }, { from: '2026-03-01', actor: 'u', action: 'hold', search: 'x' }, { to: '2026-01-02', actor: 'u' }]) {
        const { byId, run } = appSandbox(lang, { auditFilter });
        run('updateBiasGenScope()');
        const t = text(byId('biasGenScope'));
        assert.doesNotMatch(t, RAW_KEY);
        if (lang !== 'en') assert.doesNotMatch(t, ENGLISH.scope);
      }
    });
  }
  test('English reads as it always did', () => {
    const { byId, run } = appSandbox('en', { auditFilter: { from: '2026-03-01', actor: 'u', action: 'hold' } });
    run('updateBiasGenScope()');
    assert.equal(text(byId('biasGenScope')),
      'Covers 1 Mar 2026 onwards, all roles.Your actor and action filters are not applied — bias reports are scoped by date only.');
  });
});

describe('data retention', () => {
  const stats = {
    purgeMode: 'dryrun', rowCount: 1234, oldestCreatedAt: '2025-01-02T00:00:00Z', cutoffDate: '2025-10-01T00:00:00Z',
    effectiveRetentionDays: 365, featureRequestRowCount: 3, featureRequestCutoffDate: '2026-03-01T00:00:00Z',
    featureRequestRetentionDays: 180, lastPurgeAt: '2026-09-28T02:00:00Z', auditWouldDeleteNow: 2, featureRequestWouldDeleteNow: 1,
  };
  const runs = [
    { ranAt: '2026-09-28T02:00:00Z', cutoffDate: '2025-09-28T00:00:00Z', rowsDeleted: 5, durationMs: 12, status: 'dryrun' },
    { ranAt: '2026-09-27T02:00:00Z', cutoffDate: '2025-09-27T00:00:00Z', rowsDeleted: 0, durationMs: 9, status: 'success' },
    { ranAt: '2026-09-26T02:00:00Z', cutoffDate: '2025-09-26T00:00:00Z', rowsDeleted: 0, durationMs: null, status: 'error', errorText: 'SQLITE_BUSY' },
  ];
  for (const lang of LANGS) {
    test(`${lang}: stats and purge runs`, () => {
      const { byId, run } = appSandbox(lang);
      run('renderRetentionStats(' + JSON.stringify(stats) + '); renderPurgeRuns(' + JSON.stringify(runs) + ')');
      const t = text(byId('retStats')) + ' ' + text(byId('retHistory'));
      assert.doesNotMatch(t, RAW_KEY);
      assert.match(t, /SQLITE_BUSY/, 'the server\'s diagnostic stays as written');
      if (lang === 'en') assert.match(t, /Audit rows stored: 1,234/);
      else assert.doesNotMatch(t, ENGLISH.retention);
      if (lang === 'de') assert.match(t, /1\.234/, 'numbers are formatted for the language');
    });
  }
});

describe('the team list', () => {
  const team = {
    me: { user: { email: 'owner@acme.test' } },
    data: { org: { teamPlan: true }, seatLimit: 5, members: [
      { id: 'u1', email: 'owner@acme.test', role: 'owner', lastLoginAt: '2026-09-01T10:00:00Z' },
      { id: 'u2', email: 'sam@acme.test', role: 'member', lastLoginAt: null },
    ] },
    invites: [{ id: 'i1', email: 'new@acme.test' }],
  };
  for (const lang of LANGS) {
    test(`${lang}: members, roles and pending invites`, () => {
      const { byId, run } = appSandbox(lang, { team, teamIsOwner: true });
      run('renderTeam()');
      const t = text(byId('teamBody'));
      assert.doesNotMatch(t, RAW_KEY);
      assert.match(t, /sam@acme\.test/);
      if (lang !== 'en') assert.doesNotMatch(t, ENGLISH.team);
      // The buttons still say what they do to the code.
      assert.match(byId('teamBody').innerHTML, /data-team="remove" data-id="u2"/);
      assert.match(byId('teamBody').innerHTML, /data-team="revoke" data-id="i1"/);
    });
    test(`${lang}: an org without the Team plan`, () => {
      const { byId, run } = appSandbox(lang, { team: { me: null, data: { org: { teamPlan: false }, members: [] }, invites: [] }, teamIsOwner: true });
      run('renderTeam()');
      assert.doesNotMatch(text(byId('teamBody')), RAW_KEY);
    });
  }
});

describe('analysis results', () => {
  const results = [
    { candidateName: 'Jansen', fileName: 'jansen.pdf', overall: 82, scores: { keywords: 80, skills: 85, experience: 90, education: 60 }, _decision: 'hold' },
    { anonymized: true, fileName: 'x.pdf', overall: 45, scores: { keywords: 40, skills: 50, experience: 45, education: 30 } },
  ];
  const single = {
    candidateName: 'Jansen', overall: 71, scores: { keywords: 70, skills: 75, experience: 80, education: 50 },
    found: ['sql'], missing: [], skills: [{ name: 'SQL', found: true }, { name: 'Power BI', found: false }],
    recommendations: [{ icon: 'Skills', text: 'Add <b>Power BI</b> projects.' }],
  };
  for (const lang of LANGS) {
    test(`${lang}: the batch table keeps each row's decision and says it in the language`, () => {
      const { byId, run } = appSandbox(lang);
      run('renderBatchResults(' + JSON.stringify(results) + ', "Controller")');
      const html = byId('batchBody').innerHTML;
      const t = text(byId('batchTitle')) + ' ' + text(byId('batchBody')) + ' ' + html.match(/(?:placeholder|aria-label)="[^"]*"/g).join(' ');
      assert.doesNotMatch(t, RAW_KEY);
      if (lang !== 'en') assert.doesNotMatch(t, ENGLISH.batch);
      assert.match(html, /data-action="batch-decision" data-idx="0"/);
      // The option values are the codes; the chosen one survives a re-render.
      assert.deepEqual([...html.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]).slice(0, 4), ['', 'shortlist', 'hold', 'reject']);
      assert.equal(byId('batchBody').querySelector('select').value, 'hold', 'a re-render keeps the recruiter\'s choice');
    });
    test(`${lang}: a single result, with the scorer's text left in English and marked so`, () => {
      const { byId, run } = appSandbox(lang);
      run('renderSingleResult(' + JSON.stringify(single) + ', "jansen.pdf", "Controller")');
      const chrome = ['resultName', 'scoreRow', 'foundChips', 'missingChips'].map((id) => text(byId(id))).join(' ')
        + ' ' + text(byId('skillsTable'));
      assert.doesNotMatch(chrome, RAW_KEY);
      if (lang !== 'en') assert.doesNotMatch(chrome, ENGLISH.single);
      // Scorer text: English, and inserted as text — the JD-derived <b> is not markup.
      assert.match(text(byId('singleWhy')), /^Overall: 71\/100/);
      assert.match(byId('singleWhy').innerHTML, /Add &lt;b&gt;Power BI&lt;\/b&gt; projects\./);
    });
  }
  test('the scorer blocks are marked lang="en" and carry the "(in English)" note', () => {
    assert.match(APP_HTML, /<div class="why-box" id="singleWhy" lang="en"><\/div>/);
    assert.match(APP_HTML, /<table class="data-table" id="recsTable">[\s\S]*?<tbody lang="en"><\/tbody>/);
    assert.equal((APP_HTML.match(/class="en-note" data-i18n="app\.results\.inEnglish"/g) || []).length, 2);
    assert.match(APP_HTML, /html\[lang="en"\] \.en-note\{display:none\}/);
  });
});

describe('a batch with files that could not be analysed', () => {
  // As the server returns it: scored first (ranked), failed after, in upload order.
  const batch = [
    { status: 'scored', candidateName: 'Jansen', fileName: 'jansen.pdf', overall: 82, scores: { keywords: 80, skills: 85, experience: 90, education: 60 }, analysisId: 'a1' },
    { status: 'scored', candidateName: 'Visser', fileName: 'visser.pdf', overall: 40, scores: { keywords: 30, skills: 50, experience: 45, education: 20 }, analysisId: 'a2' },
    { status: 'failed', fileName: 'scan.pdf', displayName: 'scan', code: 'IMAGE_ONLY_PDF', error: 'No text could be extracted — this PDF appears to be a scanned image.' },
    { status: 'failed', fileName: 'notes.pdf', displayName: 'notes', code: 'INVALID_FILE', reason: 'FILE_TYPE', params: { name: 'notes.pdf' }, error: '"notes.pdf" is not a valid PDF or DOCX file.' },
  ];
  const FAILED_EN = /Not analysed|could not be analysed|Fix the file|scanned image|not a valid PDF/;
  for (const lang of LANGS) {
    test(`${lang}: a failed file is its own row — reason and fix, no rank, score, decision or save`, () => {
      const { byId, run } = appSandbox(lang, { batch });
      run('renderBatchResults(lastBatchResults, "Controller")');
      const rows = byId('batchBody').querySelectorAll('tr');
      assert.equal(rows.length, 4);
      const failed = rows.filter((r) => r.getAttribute('data-failed') === '1');
      assert.equal(failed.length, 2);
      for (const r of failed) {
        assert.equal(r.querySelectorAll('select').length, 0, 'no decision can be picked');
        assert.equal(r.querySelectorAll('button').length, 0, 'no save');
        assert.equal(r.querySelectorAll('textarea').length, 0, 'no notes');
        assert.equal(r.querySelectorAll('.score-pill').length, 0, 'no score');
        assert.equal(r.querySelectorAll('.rank-badge').length, 0, 'no rank');
        assert.equal(r.hasAttribute('data-score'), false);
      }
      const failedText = failed.map(text).join(' ');
      assert.doesNotMatch(failedText, RAW_KEY);
      if (lang === 'en') assert.match(failedText, /Not analysed.*scanned image.*Fix the file and upload it again/);
      else assert.doesNotMatch(failedText, FAILED_EN);
      assert.match(failedText, /notes\.pdf/, 'the file name the reason is about');
      // Ranks count scored candidates only.
      assert.deepEqual(byId('batchBody').querySelectorAll('.rank-badge').map(text), ['1', '2']);
      // The title counts candidates, the note counts the failures.
      assert.match(text(byId('batchTitle')), /\b2\b/);
      assert.equal(byId('batchFailedNote').hidden, false);
      assert.doesNotMatch(text(byId('batchFailedNote')), RAW_KEY);
      if (lang !== 'en') assert.doesNotMatch(text(byId('batchFailedNote')), FAILED_EN);
    });
    test(`${lang}: the summary figures ignore failed files`, () => {
      const { byId, run } = appSandbox(lang, { batch });
      run('renderBatchResults(lastBatchResults, "")');
      assert.equal(text(byId('bsTotalCVs')), '2');
      assert.equal(text(byId('bsAvgScore')), '61', 'the mean of 82 and 40, not of 82, 40, 0 and 0');
      assert.equal(text(byId('bsShortlisted')), '1');
      assert.equal(text(byId('bsTopCandidate')), 'Jansen');
      assert.equal(byId('bsFailedSub').hidden, false);
      assert.match(text(byId('bsFailedSub')), /\b2\b/);
      assert.doesNotMatch(text(byId('bsFailedSub')), RAW_KEY);
    });
  }
  test('a batch where every file failed shows no figures, not zeros', () => {
    const { byId, run } = appSandbox('en', { batch: batch.slice(2) });
    run('renderBatchResults(lastBatchResults, "")');
    assert.equal(text(byId('bsTotalCVs')), '0');
    assert.equal(text(byId('bsAvgScore')), '—');
    assert.equal(text(byId('bsTopCandidate')), '—');
  });
  test('a batch with no failures shows no failure note', () => {
    const { byId, run } = appSandbox('de', { batch: batch.slice(0, 2) });
    run('renderBatchResults(lastBatchResults, "")');
    assert.equal(byId('batchFailedNote').hidden, true);
    assert.equal(byId('bsFailedSub').hidden, true);
  });
  test('an older server\'s error row (no status, no score) is still a failure, never a 0', () => {
    const { byId, run } = appSandbox('en', { batch: [{ candidateName: 'broken', fileName: 'broken.pdf', error: 'Unexpected.' }] });
    run('renderBatchResults(lastBatchResults, "")');
    assert.equal(byId('batchBody').querySelectorAll('tr')[0].getAttribute('data-failed'), '1');
    assert.equal(byId('batchBody').querySelectorAll('.score-pill').length, 0);
  });
  test('the CSV gives a failed file a status and its error, and empty score cells — never zeros', () => {
    const { ctx, run } = appSandbox('en', { batch });
    run('exportBatchCsv()');
    const lines = ctx.__downloaded.body.split('\n');
    assert.equal(lines[0], 'Rank,Candidate,Overall,Keywords,Skills,Experience,Education,Decision,Role,Status,Error');
    assert.equal(lines[1], '1,"Jansen",82,80,85,90,60,"","",scored,');
    assert.equal(lines[3], ',"scan",,,,,,,"",failed,"IMAGE_ONLY_PDF: No text could be extracted — this PDF appears to be a scanned image."');
    assert.equal(lines[4], ',"notes",,,,,,,"",failed,"INVALID_FILE.FILE_TYPE: ""notes.pdf"" is not a valid PDF or DOCX file."');
  });
});

describe('an audit record without a score', () => {
  const rec = { id: 'u1', createdAt: '2026-03-15T09:30:00.000Z', candidateId: 'c9', candidateName: 'broken', role: 'Analyst', overall: null, scores: {}, decision: '', note: '', reviewedBy: '' };
  for (const lang of LANGS) {
    test(`${lang}: shows no 0, says "not scored", and offers no decision or report`, () => {
      const { byId, run } = appSandbox(lang);
      run('renderAuditTable([' + JSON.stringify(rec) + '])');
      const row = byId('auditBody').querySelector('tr');
      assert.doesNotMatch(text(row), /\b0\b/);
      assert.equal(row.querySelector('.score-pill').textContent, '—');
      assert.ok(row.querySelector('.unscored-badge'));
      assert.doesNotMatch(text(row), RAW_KEY);
      assert.equal(row.querySelector('select').disabled, true);
      assert.equal(row.querySelectorAll('[data-action="audit-report"]').length, 0);
    });
  }
});

describe('the plan chip and the staged-file list', () => {
  for (const lang of LANGS) {
    test(`${lang}: free usage, past_due, and a staged batch`, () => {
      const { byId, run } = appSandbox(lang, { files: [{ name: 'a.pdf', size: 1, lastModified: 1 }, { name: 'b.pdf', size: 2, lastModified: 2 }] });
      run('renderPlanChip({ plan: "free", used: 3, limit: 10 })');
      const free = text(byId('planChipLabel')) + ' ' + byId('planChip').title;
      run('renderPlanChip({ plan: "pro", subscriptionStatus: "past_due" })');
      const pastDue = text(byId('planChipLabel')) + ' ' + byId('planChip').title;
      run('renderFileList()');
      const files = text(byId('fileList')) + ' ' + text(byId('fileListHead'));
      for (const t of [free, pastDue, files]) assert.doesNotMatch(t, RAW_KEY);
      if (lang !== 'en') {
        assert.doesNotMatch(free + ' ' + pastDue, ENGLISH.chip);
        assert.doesNotMatch(files, ENGLISH.files);
      }
      assert.match(free, /3\/10/);
    });
  }
});
