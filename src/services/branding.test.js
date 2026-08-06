'use strict';

/**
 * src/services/branding.test.js
 *
 * Report branding is a FALLBACK CHAIN, not a gate: every report at every tier
 * is branded, and the paid feature is whose mark it carries.
 *
 * Covers (TESTS): the chain itself (free and unentitled orgs get the CVsprings
 * brandmark in the header, never a blank one); the entitlement axis, which is
 * expressed only as a capability flag on the plan table plus a live
 * subscription; the comped short-circuit for orgs with no Stripe subscription
 * to be live about; that the resolver never returns an empty shape; that the
 * provenance footer reaches every rendered report and cannot be removed by any
 * org setting; and that the legal entity can never appear as a brand — proven
 * under a hostile BRAND_NAME rather than skipped when one is set.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveBranding,
  isEntitledToCustomBranding,
  isCompedOrg,
  platformBrandName,
  PROVENANCE_PLATFORM,
  LEGAL_ENTITY_NAMES,
  BRAND_NAME_FALLBACK,
  BRAND_COLOR_FALLBACK,
} = require('./branding');
const { capabilitiesFor } = require('../config/plans');
const { buildReportDoc } = require('../routes/reportRenderer');

// A fully-configured org branding row (what getOrganizationBranding returns).
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

const AUDIT = {
  id: 'aud_1', candidateName: 'Sam Rivers', overall: 72, role: 'Backend Engineer',
  appVersion: '2.4.1', modelId: 'cvsprings-matcher-v3',
  analysisTimestamp: '2026-06-02T09:15:00.000Z',
  scores: { keywords: 70, skills: 80 },
  analysisDetail: { found: ['Node.js'], missing: ['Kubernetes'] },
};

// Run `fn` with BRAND_NAME/BRAND_COLOR forced, then restore. The resolver reads
// env at call time precisely so this is possible.
function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; process.env[k] = vars[k]; }
  try { return fn(); } finally {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}

// Walk a pdfmake node tree collecting every string, so assertions do not depend
// on the exact column/stack layout.
function textsIn(node, out = []) {
  if (node == null) return out;
  if (Array.isArray(node)) { node.forEach((n) => textsIn(n, out)); return out; }
  if (typeof node === 'string') { out.push(node); return out; }
  if (typeof node !== 'object') return out;
  if (typeof node.text === 'string') out.push(node.text);
  else if (Array.isArray(node.text)) textsIn(node.text, out);
  ['columns', 'stack', 'ul', 'ol'].forEach((k) => { if (node[k]) textsIn(node[k], out); });
  return out;
}
function svgsIn(node, out = []) {
  if (node == null || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach((n) => svgsIn(n, out)); return out; }
  if (typeof node.svg === 'string') out.push(node.svg);
  ['columns', 'stack'].forEach((k) => { if (node[k]) svgsIn(node[k], out); });
  return out;
}
function imagesIn(node, out = []) {
  if (node == null || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach((n) => imagesIn(n, out)); return out; }
  if (typeof node.image === 'string') out.push(node.image);
  ['columns', 'stack'].forEach((k) => { if (node[k]) imagesIn(node[k], out); });
  return out;
}
const footerTexts = (doc, p = 1, n = 1) => textsIn(doc.footer(p, n)).join(' ');

describe('the resolver always returns a usable shape', () => {
  const shapes = [
    ['free', NO_BRANDING, FREE], ['free + custom saved', CUSTOM, FREE],
    ['pro', CUSTOM, PRO], ['pro + nothing saved', NO_BRANDING, PRO],
    ['team', CUSTOM, TEAM], ['comped', NO_BRANDING, COMPED],
    ['no billing row', CUSTOM, null], ['nothing at all', null, null],
  ];
  for (const [label, orgBranding, billing] of shapes) {
    test(`${label}: never null/undefined/empty, always a header mark`, () => {
      const b = resolveBranding(orgBranding, billing);
      assert.ok(b && typeof b === 'object', 'must return an object');
      assert.ok(Object.keys(b).length > 0, 'must not be an empty object');
      assert.equal(typeof b.headerLogo, 'string');
      assert.ok(b.headerLogo.length > 0, 'header mark must never be empty');
      assert.ok(['svg', 'image'].includes(b.headerLogoType));
      assert.equal(typeof b.displayName, 'string');
      assert.ok(b.displayName.trim().length > 0);
      assert.equal(typeof b.isCustom, 'boolean');
      assert.match(b.color, /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/);
      assert.equal(b.provenance.platform, PROVENANCE_PLATFORM);
    });
  }
});

describe('the fallback chain', () => {
  test('free tier gets the CVsprings brandmark, as SVG', () => {
    const b = resolveBranding(NO_BRANDING, FREE);
    assert.equal(b.isCustom, false);
    assert.equal(b.headerLogoType, 'svg');
    assert.ok(b.headerLogo.includes('<svg'), 'must be SVG markup, not a path or URL');
    assert.equal(b.displayName, BRAND_NAME_FALLBACK);
  });

  test('free tier with custom branding saved still gets the CVsprings mark', () => {
    const b = resolveBranding(CUSTOM, FREE);
    assert.equal(b.isCustom, false);
    assert.equal(b.displayName, BRAND_NAME_FALLBACK, 'org display name must not be used');
    assert.equal(b.color, BRAND_COLOR_FALLBACK, 'org colour must not be used');
  });

  test('entitled org with no logo uploaded falls back to the CVsprings mark', () => {
    const b = resolveBranding(NO_BRANDING, PRO);
    assert.equal(b.isCustom, false);
    assert.equal(b.headerLogoType, 'svg');
    assert.ok(b.headerLogo.includes('<svg'));
  });

  test('entitled org gets its own display name and colour on the header', () => {
    const b = resolveBranding(CUSTOM, PRO);
    assert.equal(b.displayName, 'Acme Recruitment');
    assert.equal(b.color, '#ff0066');
  });

  test('Team behaves exactly as Pro', () => {
    assert.deepEqual(resolveBranding(CUSTOM, TEAM), resolveBranding(CUSTOM, PRO));
    assert.deepEqual(resolveBranding(NO_BRANDING, TEAM), resolveBranding(NO_BRANDING, PRO));
  });

  test('brandLogoUrl is NOT read by the render path', () => {
    // Deliberate: fetching an org-controlled remote URL during report
    // generation would add an SSRF surface and a third-party uptime
    // dependency. Uploads land in a follow-up; until then isCustom is false
    // for every org, however the URL field is configured.
    const b = resolveBranding({ ...CUSTOM, brandLogoUrl: 'https://evil.example/x.png' }, PRO);
    assert.equal(b.isCustom, false);
    assert.equal(b.headerLogoType, 'svg');
    assert.ok(!JSON.stringify(b).includes('evil.example'));
  });
});

describe('entitlement is a capability flag plus a live subscription', () => {
  test('the flag comes from the plan table, not a tier-name comparison', () => {
    assert.equal(capabilitiesFor('free').customBranding, false);
    assert.equal(capabilitiesFor('pro').customBranding, true);
    assert.equal(capabilitiesFor('team').customBranding, true);
  });

  test('an unknown plan id fails closed', () => {
    assert.equal(capabilitiesFor('enterprise').customBranding, false);
    assert.equal(capabilitiesFor(undefined).customBranding, false);
    assert.equal(isEntitledToCustomBranding({ plan: 'enterprise', subscriptionStatus: 'active' }), false);
  });

  test('a capable plan with a dead subscription is not entitled', () => {
    for (const status of ['canceled', 'incomplete', 'unpaid', null]) {
      assert.equal(
        isEntitledToCustomBranding({ plan: 'pro', subscriptionStatus: status }), false,
        `status=${status} must not grant white-label`,
      );
      assert.equal(resolveBranding(CUSTOM, { plan: 'pro', subscriptionStatus: status }).displayName,
        BRAND_NAME_FALLBACK);
    }
  });

  test('past_due keeps entitlement (grace window, matches the quota gate)', () => {
    const b = resolveBranding(CUSTOM, { plan: 'pro', subscriptionStatus: 'past_due' });
    assert.equal(b.displayName, 'Acme Recruitment');
  });

  test('missing or omitted billing row resolves unentitled, not entitled', () => {
    assert.equal(isEntitledToCustomBranding(null), false);
    assert.equal(isEntitledToCustomBranding(undefined), false);
    assert.equal(resolveBranding(CUSTOM, null).displayName, BRAND_NAME_FALLBACK);
    assert.equal(resolveBranding(CUSTOM).displayName, BRAND_NAME_FALLBACK);
  });

  test('a client-supplied flag on the branding row cannot buy entitlement', () => {
    const spoofed = { ...CUSTOM, comped: 1, plan: 'team', entitled: true, isCustom: true };
    const b = resolveBranding(spoofed, FREE);
    assert.equal(b.isCustom, false, 'comped on the BRANDING row must not be read');
    assert.equal(b.displayName, BRAND_NAME_FALLBACK);
  });

  test('downgrade takes effect on the next call, nothing cached', () => {
    assert.equal(resolveBranding(CUSTOM, PRO).displayName, 'Acme Recruitment');
    assert.equal(resolveBranding(CUSTOM, FREE).displayName, BRAND_NAME_FALLBACK);
    assert.equal(resolveBranding(CUSTOM, PRO).displayName, 'Acme Recruitment');
  });

  test('returns a fresh object each call (no memoised instance)', () => {
    const a = resolveBranding(CUSTOM, PRO);
    const b = resolveBranding(CUSTOM, PRO);
    assert.notEqual(a, b);
    assert.deepEqual(a, b);
    a.displayName = 'mutated';
    assert.equal(resolveBranding(CUSTOM, PRO).displayName, 'Acme Recruitment');
  });
});

describe('comped orgs', () => {
  test('comped resolves as entitled with a NULL subscription_status', () => {
    assert.equal(isCompedOrg(COMPED), true);
    assert.equal(isEntitledToCustomBranding(COMPED), true,
      'a comped org has no subscription to be live about');
    assert.equal(resolveBranding(CUSTOM, COMPED).displayName, 'Acme Recruitment');
  });

  test('comped accepts the SQLite integer and the boolean alike', () => {
    assert.equal(isEntitledToCustomBranding({ plan: 'free', subscriptionStatus: null, comped: 1 }), true);
    assert.equal(isEntitledToCustomBranding({ plan: 'free', subscriptionStatus: null, comped: true }), true);
  });

  test('comped = 0 is not entitled', () => {
    assert.equal(isCompedOrg({ plan: 'free', subscriptionStatus: null, comped: 0 }), false);
    assert.equal(isEntitledToCustomBranding({ plan: 'free', subscriptionStatus: null, comped: 0 }), false);
  });

  test('a comped org still gets the CVsprings mark when it has uploaded none', () => {
    const b = resolveBranding(NO_BRANDING, COMPED);
    assert.equal(b.headerLogoType, 'svg');
    assert.ok(b.headerLogo.includes('<svg'));
  });
});

describe('the legal entity can never appear as a brand', () => {
  const TIERS = [['free', FREE], ['pro', PRO], ['team', TEAM], ['comped', COMPED], ['no billing', null]];

  // Unconditional, and proven under the hostile config rather than skipped when
  // one is present: BRAND_NAME is operator-supplied, so pointing it at the
  // legal entity is exactly the misconfiguration the guard exists for.
  for (const legal of LEGAL_ENTITY_NAMES) {
    for (const [label, billing] of TIERS) {
      test(`BRAND_NAME="${legal}" does not reach the ${label} header`, () => {
        withEnv({ BRAND_NAME: legal }, () => {
          assert.equal(platformBrandName(), BRAND_NAME_FALLBACK);
          for (const orgBranding of [NO_BRANDING, CUSTOM]) {
            const b = resolveBranding(orgBranding, billing);
            assert.notEqual(b.displayName.toLowerCase(), legal.toLowerCase());
            assert.equal(b.provenance.platform, PROVENANCE_PLATFORM);
          }
        });
      });
    }
  }

  test('an org cannot white-label itself as the legal entity either', () => {
    const b = resolveBranding({ ...CUSTOM, brandDisplayName: 'Chaulin BV' }, PRO);
    assert.equal(b.displayName, BRAND_NAME_FALLBACK);
  });

  test('the rendered report never prints the legal entity, under hostile env', () => {
    withEnv({ BRAND_NAME: 'Chaulin' }, () => {
      const doc = buildReportDoc(AUDIT, resolveBranding(NO_BRANDING, FREE));
      const everywhere = [...textsIn(doc.content), footerTexts(doc), ...textsIn(doc.header(2))].join(' ');
      assert.ok(!/Chaulin/i.test(everywhere), 'legal entity leaked into the report');
      assert.ok(everywhere.includes('CVsprings'));
    });
  });

  test('the provenance string is hardcoded, immune to BRAND_NAME entirely', () => {
    withEnv({ BRAND_NAME: 'Totally Different Co' }, () => {
      const b = resolveBranding(CUSTOM, PRO);
      assert.equal(b.provenance.platform, 'Generated by CVsprings');
      assert.ok(!b.provenance.platform.includes('Totally Different'));
    });
  });
});

describe('the header mark reaches the rendered report', () => {
  test('free tier: the CVsprings mark is in the report body header', () => {
    const doc = buildReportDoc(AUDIT, resolveBranding(NO_BRANDING, FREE));
    assert.equal(svgsIn(doc.content).length, 1, 'expected exactly one brandmark in the header');
    assert.ok(svgsIn(doc.content)[0].includes('<svg'));
    assert.ok(textsIn(doc.content).some((t) => t.startsWith('CVsprings — Candidate Assessment Report')));
  });

  test('every tier renders a header mark — none is blank', () => {
    for (const [label, billing] of [['free', FREE], ['pro', PRO], ['team', TEAM], ['comped', COMPED],
      ['pro cancelled', { plan: 'pro', subscriptionStatus: 'canceled' }]]) {
      const doc = buildReportDoc(AUDIT, resolveBranding(CUSTOM, billing));
      const marks = svgsIn(doc.content).length + imagesIn(doc.content).length;
      assert.equal(marks, 1, `${label}: expected exactly one header mark, got ${marks}`);
    }
  });

  test('the mark is constrained by fit, so no logo can break the layout', () => {
    const doc = buildReportDoc(AUDIT, resolveBranding(NO_BRANDING, PRO));
    const findFit = (n) => {
      if (!n || typeof n !== 'object') return null;
      if (Array.isArray(n)) { for (const c of n) { const r = findFit(c); if (r) return r; } return null; }
      if ((n.svg || n.image) && Array.isArray(n.fit)) return n.fit;
      for (const k of ['columns', 'stack']) { const r = findFit(n[k]); if (r) return r; }
      return null;
    };
    const fit = findFit(doc.content);
    assert.ok(Array.isArray(fit) && fit.length === 2, 'header mark must carry a fit box');
    assert.ok(fit[0] > 0 && fit[1] > 0);
  });

  test('an image-type mark renders as { image: … }, not { svg: … }', () => {
    // The 'image' branch has no producer until uploads land, so drive it
    // directly — it must not be dead code by the time it does.
    const dataUri = 'data:image/png;base64,iVBORw0KGgo=';
    const doc = buildReportDoc(AUDIT, {
      ...resolveBranding(CUSTOM, PRO),
      headerLogo: dataUri, headerLogoType: 'image', isCustom: true,
    });
    assert.deepEqual(imagesIn(doc.content), [dataUri]);
    assert.equal(svgsIn(doc.content).length, 0, 'a raster logo must not go through the svg node');
  });

  test('a doc built without the resolver still gets the platform mark', () => {
    const doc = buildReportDoc(AUDIT, null);
    assert.equal(svgsIn(doc.content).length, 1);
    assert.ok(textsIn(doc.content).some((t) => t.includes('CVsprings')));
  });
});

describe('provenance footer — every report, every tier, not removable', () => {
  const ALL = [
    ['free', NO_BRANDING, FREE], ['free + branding saved', CUSTOM, FREE],
    ['pro, no branding', NO_BRANDING, PRO], ['pro + custom branding', CUSTOM, PRO],
    ['team', CUSTOM, TEAM], ['comped', CUSTOM, COMPED],
    ['pro cancelled', CUSTOM, { plan: 'pro', subscriptionStatus: 'canceled' }],
  ];

  for (const [label, orgBranding, billing] of ALL) {
    test(`${label}: footer carries id, engine, ruleset, both timestamps and the platform string`, () => {
      const doc = buildReportDoc(AUDIT, resolveBranding(orgBranding, billing));
      const foot = footerTexts(doc);
      assert.ok(foot.includes('aud_1'), 'report id missing');
      assert.ok(foot.includes('cvsprings-matcher-v3'), 'engine version missing');
      assert.ok(foot.includes('2.4.1'), 'ruleset version missing');
      assert.ok(foot.includes('2026-06-02T09:15:00.000Z'), 'assessed timestamp missing');
      assert.match(foot, /Generated \d{4}-\d{2}-\d{2}T[\d:.]+Z/, 'generated timestamp missing or not ISO 8601 UTC');
      assert.ok(foot.includes(PROVENANCE_PLATFORM), 'platform string missing');
    });
  }

  test('no org setting can switch the footer off', () => {
    // Every field an org can write, plus the retired flags and a few hopeful
    // ones, all set to their most "make it go away" value.
    const hostile = {
      brandDisplayName: 'Acme', brandLogoUrl: 'https://acme.example/l.png', brandColor: '#ff0066',
      provenance: null, showCredit: false, creditText: null, showProvenance: false,
      hideProvenance: true, footer: null, provenanceEnabled: false,
    };
    const doc = buildReportDoc(AUDIT, resolveBranding(hostile, TEAM));
    assert.ok(footerTexts(doc).includes(PROVENANCE_PLATFORM));
  });

  test('nor can a branding object handed straight to the renderer', () => {
    const doc = buildReportDoc(AUDIT, {
      ...resolveBranding(CUSTOM, PRO), provenance: null, showProvenance: false,
    });
    assert.ok(footerTexts(doc).includes(PROVENANCE_PLATFORM));
  });

  test('the resolved provenance object is frozen', () => {
    const b = resolveBranding(CUSTOM, PRO);
    assert.throws(() => { 'use strict'; b.provenance.platform = 'Generated by Acme'; }, TypeError);
    assert.equal(resolveBranding(CUSTOM, PRO).provenance.platform, PROVENANCE_PLATFORM);
  });

  test('it is on every page, not just the first', () => {
    const doc = buildReportDoc(AUDIT, resolveBranding(CUSTOM, TEAM));
    for (const page of [1, 2, 7]) {
      assert.ok(footerTexts(doc, page, 7).includes(PROVENANCE_PLATFORM), `page ${page} missing provenance`);
      assert.ok(footerTexts(doc, page, 7).includes(`Page ${page} of 7`), `page ${page} missing pagination`);
    }
  });

  test('a record with no engine/ruleset/timestamp still renders a complete footer', () => {
    const doc = buildReportDoc({ id: 'aud_bare' }, resolveBranding(NO_BRANDING, FREE));
    const foot = footerTexts(doc);
    assert.ok(foot.includes('aud_bare'));
    assert.ok(foot.includes(PROVENANCE_PLATFORM));
    assert.match(foot, /Generated \d{4}-\d{2}-\d{2}T/);
  });

  test('the generated timestamp is UTC ISO 8601', () => {
    const doc = buildReportDoc(AUDIT, resolveBranding(NO_BRANDING, FREE));
    const iso = footerTexts(doc).match(/Generated (\S+)/)[1];
    assert.match(iso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.ok(Math.abs(Date.now() - new Date(iso).getTime()) < 60_000, 'should be ~now');
  });

  test('assessed and generated are distinct fields, not the same value twice', () => {
    const foot = footerTexts(buildReportDoc(AUDIT, resolveBranding(NO_BRANDING, FREE)));
    assert.ok(foot.includes('Assessed 2026-06-02T09:15:00.000Z'));
    assert.ok(!foot.includes('Generated 2026-06-02T09:15:00.000Z'), 'generated must not copy assessed');
  });
});

describe('report delivery', () => {
  test('the PDF response is uncacheable, so a plan change cannot be served stale', () => {
    const { streamReport } = require('../routes/reportRenderer');
    const headers = {};
    const res = {
      setHeader: (k, v) => { headers[k] = v; },
      on: () => {}, once: () => {}, emit: () => {}, end: () => {}, write: () => true,
    };
    streamReport(AUDIT, res, 'r.pdf', resolveBranding(CUSTOM, FREE));
    assert.equal(headers['Cache-Control'], 'no-store');
  });
});
