'use strict';

/**
 * src/routes/biasReportBranding.test.js
 *
 * The bias monitoring report on the same branding and provenance model as the
 * candidate PDF report.
 *
 * Covers (TESTS): that the bias report resolves its mark through the shared
 * resolver rather than a hardcoded asset, so a white-labelled org gets its own
 * mark and name on BOTH documents and an unentitled one gets the CVsprings
 * mark on both; the on:'light'/'dark' surface parameter and the needsPlate
 * signal; that the provenance footer renders at every tier, carries the same
 * fields and the same ISO 8601 UTC format as the candidate report, and is
 * reachable by no org setting; that the report fingerprint is deterministic
 * over its frozen input set; and that a record set spanning more than one
 * scoring engine raises a visible validity caveat.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveBranding, PROVENANCE_PLATFORM, ON_DARK_MARK_COLOR,
} = require('../services/branding');
const { tintedBrandmark } = require('../services/brandmark');
const { buildProvenance, isoUtc } = require('../services/provenance');
const {
  analyzeBias, reportFingerprint, scoringEngineSpan, BIAS_ENGINE_ID, RULESET_VERSION,
} = require('../services/biasAudit');
const { buildReportDoc } = require('./reportRenderer');
const { __test__ } = require('./audit');

const renderBiasReportHtml = __test__.renderBiasReportHtml;

const CUSTOM = {
  brandDisplayName: 'Acme Recruitment',
  brandLogoUrl: 'https://acme.example/logo.png',
  brandColor: '#ff0066',
};
const NO_BRANDING = { brandDisplayName: null, brandLogoUrl: null, brandColor: null };

const FREE = { plan: 'free', subscriptionStatus: null };
const PRO = { plan: 'pro', subscriptionStatus: 'active' };
const TEAM = { plan: 'team', subscriptionStatus: 'active' };
const COMPED = { plan: 'free', subscriptionStatus: null, comped: 1 };
const CANCELLED = { plan: 'pro', subscriptionStatus: 'canceled' };
const NULL_STATUS = { plan: 'pro', subscriptionStatus: null };

let seq = 0;
function rec(over = {}) {
  seq += 1;
  return {
    id: `rec-${seq}`,
    overall: 70, role: 'Backend Engineer', anonymized: false,
    decision: 'shortlist', verdict: 'strong',
    modelId: 'cvsprings-lexical-scorer@1.3.0',
    analysisTimestamp: '2026-06-02T09:15:00.000Z',
    scores: { keywords: 70, skills: 80, experience: 65, education: 90 },
    ...over,
  };
}
const RECORDS = () => [rec(), rec({ decision: 'reject', overall: 40 }), rec({ anonymized: true })];

function biasHtml(orgBranding, billing, records = RECORDS(), opts = {}) {
  const report = analyzeBias(records, { role: null, from: null, to: null, orgId: 'org-1', ...opts });
  const branding = resolveBranding(orgBranding, billing, { on: 'dark' });
  return { html: renderBiasReportHtml(report, branding), report, branding };
}

describe('the bias report resolves its mark, it does not hardcode one', () => {
  test('an entitled white-label org gets its own display name', () => {
    const { html } = biasHtml(CUSTOM, PRO);
    assert.ok(html.includes('Acme Recruitment'), 'org display name missing from the header');
  });

  test('the old hardcoded asset and wordmark are gone', () => {
    const { html } = biasHtml(CUSTOM, PRO);
    assert.ok(!html.includes('/brandmark-white.svg'), 'still referencing the static asset by src');
    assert.ok(!html.includes('<span class="wordmark">CVsprings</span>'),
      'still emitting the literal CVsprings wordmark');
  });

  test('the mark is inlined SVG, so it survives printing without background graphics', () => {
    const { html } = biasHtml(NO_BRANDING, FREE);
    assert.ok(/<span class="mark"[^>]*>\s*<svg/.test(html), 'expected inlined <svg> in the brandrow');
  });

  for (const [label, billing] of [['free', FREE], ['cancelled', CANCELLED], ['null status', NULL_STATUS]]) {
    test(`${label} org gets the CVsprings mark and name, not its own`, () => {
      const { html } = biasHtml(CUSTOM, billing);
      assert.ok(html.includes('CVsprings'), 'platform name missing');
      assert.ok(!html.includes('Acme Recruitment'), 'unentitled org must not be white-labelled');
    });
  }

  test('comped org is white-labelled despite a null subscription status', () => {
    const { html } = biasHtml(CUSTOM, COMPED);
    assert.ok(html.includes('Acme Recruitment'));
  });

  test('the two documents agree for the same org — no per-document inconsistency', () => {
    for (const [label, billing] of [['pro', PRO], ['team', TEAM], ['comped', COMPED],
      ['free', FREE], ['cancelled', CANCELLED]]) {
      const pdfName = resolveBranding(CUSTOM, billing).displayName;
      const biasName = resolveBranding(CUSTOM, billing, { on: 'dark' }).displayName;
      assert.equal(biasName, pdfName, `${label}: documents disagree on the display name`);
      const { html } = biasHtml(CUSTOM, billing);
      assert.ok(html.includes(pdfName), `${label}: bias report does not show ${pdfName}`);
    }
  });

  test('a white-labelled name is HTML-escaped on the way into the header', () => {
    const nasty = { ...CUSTOM, brandDisplayName: 'Acme <script>alert(1)</script>' };
    const { html } = biasHtml(nasty, PRO);
    assert.ok(!html.includes('<script>alert(1)</script>'), 'org display name was not escaped');
    assert.ok(html.includes('&lt;script&gt;'));
  });
});

describe('the surface parameter', () => {
  test("on:'dark' returns the #fff-tinted mark", () => {
    const b = resolveBranding(NO_BRANDING, FREE, { on: 'dark' });
    assert.equal(b.surface, 'dark');
    assert.equal(b.headerLogo, tintedBrandmark(ON_DARK_MARK_COLOR));
    assert.ok(b.headerLogo.includes('#fff'));
    assert.ok(!b.headerLogo.includes('#000'), 'source ink must be fully replaced');
  });

  test("on:'light' and the default are unchanged from merged behaviour", () => {
    const dflt = resolveBranding(NO_BRANDING, FREE);
    const light = resolveBranding(NO_BRANDING, FREE, { on: 'light' });
    assert.deepEqual(light, dflt, 'explicit light must equal the default');
    assert.equal(dflt.surface, 'light');
    assert.ok(dflt.headerLogo.includes('#0f2847'), 'light surface keeps the brand ink');
  });

  test('an unrecognised surface falls back to light rather than throwing', () => {
    assert.equal(resolveBranding(NO_BRANDING, FREE, { on: 'chartreuse' }).surface, 'light');
    assert.equal(resolveBranding(NO_BRANDING, FREE, {}).surface, 'light');
    assert.equal(resolveBranding(NO_BRANDING, FREE, null).surface, 'light');
  });

  test('the candidate report is untouched by the new parameter', () => {
    const doc = buildReportDoc({ id: 'a1' }, resolveBranding(NO_BRANDING, FREE));
    const svgs = [];
    (function walk(n) {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) return n.forEach(walk);
      if (typeof n.svg === 'string') svgs.push(n.svg);
      ['columns', 'stack'].forEach((k) => walk(n[k]));
    })(doc.content);
    assert.equal(svgs.length, 1);
    assert.ok(svgs[0].includes('#0f2847'), 'candidate report must still use the brand ink');
  });

  test('the white variant on disk is exactly what the resolver now produces', () => {
    // public/brandmark-white.svg stays for the static marketing pages, whose
    // plain <img> cannot inherit currentColor. This pins the two together.
    const fs = require('fs');
    const path = require('path');
    const onDisk = fs.readFileSync(
      path.join(__dirname, '..', '..', 'public', 'brandmark-white.svg'), 'utf8',
    );
    const body = onDisk.slice(onDisk.indexOf('<svg'));
    assert.equal(body.trim(), tintedBrandmark('#fff').trim(),
      'brandmark-white.svg has drifted from the source mark',
    );
  });
});

describe('needsPlate', () => {
  const asImage = (billing, on) => {
    const b = resolveBranding(CUSTOM, billing, { on });
    // No uploads exist yet, so drive the raster branch directly.
    return { ...b, headerLogoType: 'image', isCustom: true, needsPlate: on === 'dark' };
  };

  test("true only for on:'dark' with a raster logo", () => {
    assert.equal(asImage(PRO, 'dark').needsPlate, true);
    assert.equal(asImage(PRO, 'light').needsPlate, false);
  });

  test('false for the CVsprings mark on either surface, because it is tintable', () => {
    assert.equal(resolveBranding(NO_BRANDING, FREE, { on: 'dark' }).needsPlate, false);
    assert.equal(resolveBranding(NO_BRANDING, FREE, { on: 'light' }).needsPlate, false);
    assert.equal(resolveBranding(CUSTOM, PRO, { on: 'dark' }).needsPlate, false);
  });

  // PR #59 asserted here that the plate was deliberately NOT built, pinning a
  // temporary state. Logo uploads make needsPlate reachable in production, so
  // that deferral has come due and the assertion inverts.
  test('a raster logo on the dark header renders on a light plate', () => {
    const report = analyzeBias(RECORDS(), { orgId: 'org-1' });
    const branding = {
      ...resolveBranding(CUSTOM, PRO, { on: 'dark' }),
      headerLogo: 'data:image/png;base64,iVBORw0KGgo=', headerLogoType: 'image',
      isCustom: true, needsPlate: true,
    };
    const html = renderBiasReportHtml(report, branding);
    assert.ok(/class="mark markimg plate"/.test(html), 'plate class missing from the mark');
    assert.ok(html.includes('.brandrow .plate'), 'plate styling missing');
    assert.ok(/print-color-adjust: exact/.test(html),
      'the plate must survive printing with background graphics off');
  });

  test('no plate when the mark is the tintable CVsprings SVG', () => {
    const { html } = biasHtml(NO_BRANDING, FREE);
    assert.ok(!/markimg plate/.test(html), 'the SVG mark is recoloured, it needs no plate');
  });

  test('no plate for a raster logo on a light surface', () => {
    const report = analyzeBias(RECORDS(), { orgId: 'org-1' });
    const branding = {
      ...resolveBranding(CUSTOM, PRO, { on: 'dark' }),
      headerLogo: 'data:image/png;base64,iVBORw0KGgo=', headerLogoType: 'image',
      isCustom: true, needsPlate: false,
    };
    assert.ok(!/markimg plate/.test(renderBiasReportHtml(report, branding)));
  });

  test('an uploaded logo is bounded on the dark header, not stretched', () => {
    const report = analyzeBias(RECORDS(), { orgId: 'org-1' });
    const branding = {
      ...resolveBranding(CUSTOM, PRO, { on: 'dark' }),
      headerLogo: 'data:image/png;base64,iVBORw0KGgo=', headerLogoType: 'image',
      isCustom: true, needsPlate: true,
    };
    const html = renderBiasReportHtml(report, branding);
    assert.ok(html.includes('object-fit: contain'), 'aspect ratio must be preserved');
    assert.ok(/max-width: 104px/.test(html) && /max-height: 26px/.test(html),
      'the mark must be bounded in both axes');
  });
});

describe('provenance footer on the bias report', () => {
  const TIERS = [['free', NO_BRANDING, FREE], ['free + branding saved', CUSTOM, FREE],
    ['pro', CUSTOM, PRO], ['pro, nothing saved', NO_BRANDING, PRO],
    ['team', CUSTOM, TEAM], ['comped', CUSTOM, COMPED], ['cancelled', CUSTOM, CANCELLED]];

  for (const [label, orgBranding, billing] of TIERS) {
    test(`${label}: fingerprint, engine, ruleset, timestamp and platform string all present`, () => {
      const { html, report } = biasHtml(orgBranding, billing);
      assert.ok(html.includes('Report fingerprint'), 'fingerprint label missing');
      assert.ok(html.includes(report.reportFingerprint), 'fingerprint value missing');
      assert.ok(html.includes(BIAS_ENGINE_ID), 'engine missing');
      assert.ok(html.includes('Ruleset ' + RULESET_VERSION), 'ruleset missing');
      assert.ok(html.includes(PROVENANCE_PLATFORM), 'platform attribution missing');
      assert.match(html, /Generated \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
    });
  }

  test('no org setting can switch the footer off', () => {
    const hostile = {
      brandDisplayName: 'Acme', brandLogoUrl: 'https://acme.example/l.png', brandColor: '#ff0066',
      provenance: null, showProvenance: false, hideProvenance: true, footer: null,
      showCredit: false, creditText: null, comped: 1,
    };
    const { html } = biasHtml(hostile, TEAM);
    assert.ok(html.includes(PROVENANCE_PLATFORM));
    assert.ok(html.includes('Report fingerprint'));
  });

  test('nor can a branding object handed straight to the renderer', () => {
    const report = analyzeBias(RECORDS(), { orgId: 'org-1' });
    const branding = { ...resolveBranding(CUSTOM, PRO, { on: 'dark' }), provenance: null };
    const html = renderBiasReportHtml(report, branding);
    assert.ok(html.includes(PROVENANCE_PLATFORM));
  });

  test('it renders even with no branding argument at all', () => {
    const html = renderBiasReportHtml(analyzeBias(RECORDS(), { orgId: 'org-1' }));
    assert.ok(html.includes(PROVENANCE_PLATFORM));
    assert.ok(html.includes('CVsprings'), 'must fall back to the platform mark, not to nothing');
  });

  test('it is labelled a fingerprint, never a Report ID', () => {
    const { html } = biasHtml(NO_BRANDING, FREE);
    assert.ok(!/Report ID/i.test(html), 'must not imply a stored, lookup-able handle');
    assert.ok(html.includes('is not a stored reference and cannot be looked up'),
      'the explanation of what the fingerprint is must be on the report');
  });

  test('the RFC 1123 conversion is gone', () => {
    const { html } = biasHtml(NO_BRANDING, FREE);
    assert.ok(!/\b\d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT/.test(html),
      'toUTCString() output still present');
  });
});

describe('both documents agree on provenance', () => {
  test('same platform attribution string, from the same constant', () => {
    const AUDIT = { id: 'aud_1', appVersion: '2.4.1', modelId: 'm', analysisTimestamp: '2026-06-02T09:15:00.000Z' };
    const pdfFooter = JSON.stringify(buildReportDoc(AUDIT, resolveBranding(CUSTOM, PRO)).footer(1, 1));
    const { html } = biasHtml(CUSTOM, PRO);
    assert.ok(pdfFooter.includes(PROVENANCE_PLATFORM));
    assert.ok(html.includes(PROVENANCE_PLATFORM));
    assert.equal(PROVENANCE_PLATFORM, 'Generated by CVsprings');
  });

  test('both timestamps are ISO 8601 UTC', () => {
    const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
    const AUDIT = { id: 'aud_1', appVersion: '2.4.1', modelId: 'm', analysisTimestamp: '2026-06-02T09:15:00.000Z' };
    const pdfFooter = JSON.stringify(buildReportDoc(AUDIT, resolveBranding(NO_BRANDING, FREE)).footer(1, 1));
    assert.match(pdfFooter.match(/Generated (\S+?)[\\"' ]/)[1], ISO);
    const { html } = biasHtml(NO_BRANDING, FREE);
    assert.match(html.match(/Generated (\S+?)</)[1], ISO);
  });

  test('buildProvenance normalises absent fields to an em dash, never to a default', () => {
    const p = buildProvenance({ id: null, engine: '', ruleset: undefined });
    assert.equal(p.id, '—');
    assert.equal(p.engine, '—');
    assert.equal(p.ruleset, '—');
    assert.equal(p.assessed, '—');
    assert.match(p.generated, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(p.platform, PROVENANCE_PLATFORM);
  });

  test('the shared isoUtc rejects unusable dates rather than inventing one', () => {
    assert.equal(isoUtc('not a date'), null);
    assert.equal(isoUtc(null), null);
    assert.equal(isoUtc('2026-06-02T09:15:00.000Z'), '2026-06-02T09:15:00.000Z');
  });

  test('the provenance object is frozen', () => {
    const p = buildProvenance({ id: 'x', engine: 'e', ruleset: 'r' });
    assert.throws(() => { 'use strict'; p.platform = 'Generated by Acme'; }, TypeError);
  });
});

describe('report fingerprint', () => {
  const base = { orgId: 'org-1', role: null, from: null, to: null, recordIds: ['a', 'b', 'c'] };

  test('same inputs produce the same fingerprint', () => {
    assert.equal(reportFingerprint(base), reportFingerprint({ ...base }));
  });

  test('record order does not matter — the set does', () => {
    assert.equal(reportFingerprint(base), reportFingerprint({ ...base, recordIds: ['c', 'a', 'b'] }));
  });

  test('a changed record set changes the fingerprint', () => {
    assert.notEqual(reportFingerprint(base), reportFingerprint({ ...base, recordIds: ['a', 'b'] }),
      'a retention purge must be visible');
    assert.notEqual(reportFingerprint(base), reportFingerprint({ ...base, recordIds: ['a', 'b', 'c', 'd'] }));
  });

  test('every other frozen input also changes it', () => {
    assert.notEqual(reportFingerprint(base), reportFingerprint({ ...base, orgId: 'org-2' }));
    assert.notEqual(reportFingerprint(base), reportFingerprint({ ...base, role: 'Backend Engineer' }));
    assert.notEqual(reportFingerprint(base), reportFingerprint({ ...base, from: '2026-01-01' }));
    assert.notEqual(reportFingerprint(base), reportFingerprint({ ...base, to: '2026-12-31' }));
  });

  test('two orgs with identical record ids do not collide', () => {
    assert.notEqual(
      reportFingerprint({ ...base, orgId: 'org-1' }),
      reportFingerprint({ ...base, orgId: 'org-2' }),
    );
  });

  test('it is a plain lowercase hex digest, not a UUID', () => {
    assert.match(reportFingerprint(base), /^[0-9a-f]{32}$/);
  });

  test('analyzeBias reproduces the same fingerprint for the same records', () => {
    const records = RECORDS();
    const a = analyzeBias(records, { orgId: 'org-1' });
    const b = analyzeBias(records, { orgId: 'org-1' });
    assert.equal(a.reportFingerprint, b.reportFingerprint);
    const c = analyzeBias(records.slice(0, 2), { orgId: 'org-1' });
    assert.notEqual(a.reportFingerprint, c.reportFingerprint);
  });

  test('only opaque surrogate ids are hashed, nothing candidate-identifying', () => {
    // Same ids in both sets — that is the point. Only the identifying fields
    // differ, and they must make no difference.
    const same = RECORDS();
    const withNames = same.map((r) => ({ ...r, candidateName: 'Sam Rivers', fileName: 'sam.pdf' }));
    const withoutNames = same.map((r) => ({ ...r, candidateName: 'Someone Else', fileName: 'x.pdf' }));
    assert.equal(
      analyzeBias(withNames, { orgId: 'org-1' }).reportFingerprint,
      analyzeBias(withoutNames, { orgId: 'org-1' }).reportFingerprint,
      'candidate-identifying fields must not affect the fingerprint',
    );
  });
});

describe('mixed scoring-engine caveat', () => {
  const V1 = 'cvsprings-lexical-scorer@1.2.0';
  const V2 = 'cvsprings-lexical-scorer@1.3.0';

  test('a single engine version raises no caveat', () => {
    const span = scoringEngineSpan([rec({ modelId: V1 }), rec({ modelId: V1 })]);
    assert.equal(span.mixed, false);
    assert.equal(span.caveat, null);
    const { html } = biasHtml(NO_BRANDING, FREE, [rec({ modelId: V1 }), rec({ modelId: V1 })]);
    assert.ok(!html.includes('Before you read these figures'));
  });

  test('two engine versions raise one, and it names them', () => {
    const span = scoringEngineSpan([rec({ modelId: V1 }), rec({ modelId: V2 })]);
    assert.equal(span.mixed, true);
    assert.deepEqual(span.versions, [V1, V2]);
    assert.ok(span.caveat.includes(V1) && span.caveat.includes(V2));
  });

  test('the caveat renders above the statistics, at disclaimer weight', () => {
    const { html } = biasHtml(NO_BRANDING, FREE, [rec({ modelId: V1 }), rec({ modelId: V2 })]);
    assert.ok(html.includes('Before you read these figures'), 'caveat block missing');
    assert.ok(html.indexOf('Before you read these figures') < html.indexOf('Data Reliability'),
      'caveat must precede the statistics, not follow them');
    assert.ok(html.includes('class="caveat"'));
  });

  test('records with no recorded version count as a distinct group', () => {
    const span = scoringEngineSpan([rec({ modelId: V1 }), rec({ modelId: null })]);
    assert.equal(span.mixed, true);
    assert.equal(span.unrecorded, 1);
    assert.ok(span.caveat.includes('no engine version recorded'));
  });

  test('it is also carried in limitations, for consumers that read only those', () => {
    const report = analyzeBias([rec({ modelId: V1 }), rec({ modelId: V2 })], { orgId: 'org-1' });
    assert.ok(report.limitations.some((l) => l.includes('more than one version')));
  });

  test('the wording is plain and observational, not reassuring', () => {
    const span = scoringEngineSpan([rec({ modelId: V1 }), rec({ modelId: V2 })]);
    assert.ok(!/no bias|compliant|cleared|safe to/i.test(span.caveat));
    assert.ok(span.caveat.includes('not necessarily calculated on the same basis'));
  });
});

describe('bias engine identity', () => {
  test('it is the bias engine, not the lexical scorer', () => {
    assert.ok(BIAS_ENGINE_ID.startsWith('cvsprings-bias-audit@'));
    assert.ok(!BIAS_ENGINE_ID.includes('lexical-scorer'),
      "the scorer's version must not be stamped on a bias report");
  });

  test('it carries the package version, like MODEL_ID does', () => {
    const pkg = require('../../package.json').version;
    assert.equal(BIAS_ENGINE_ID, `cvsprings-bias-audit@${pkg}`);
    assert.equal(RULESET_VERSION, pkg);
  });

  test('analyzeBias reports both', () => {
    const r = analyzeBias(RECORDS(), { orgId: 'org-1' });
    assert.equal(r.engine, BIAS_ENGINE_ID);
    assert.equal(r.ruleset, RULESET_VERSION);
  });
});
