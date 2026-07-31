'use strict';

/**
 * src/services/branding.test.js
 *
 * Plan-gating of report branding. Custom report branding is a paid feature:
 * free orgs render with platform branding plus a "Made with CVsprings" footer
 * credit regardless of what they have saved; Pro/Team render with their own and
 * never carry a credit.
 *
 * Covers (TESTS): free org WITH custom branding set (overrides ignored, credit
 * shown), Pro with custom branding (own branding, no credit), Pro with NO
 * custom branding (platform branding, still no credit — the credit is strictly
 * a free-tier element, decoupled from which logo is shown), and Team behaving
 * as Pro. Plus: the entitlement axis (inactive/cancelled subscriptions,
 * fail-closed on a missing billing row), that a downgrade takes effect on the
 * next call with nothing cached, and that the credit actually reaches the
 * rendered pdfmake footer — and only for free orgs.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveBranding,
  FREE_TIER_CREDIT_TEXT,
  DEFAULT_BRAND_NAME,
  DEFAULT_BRAND_COLOR,
} = require('./branding');
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

describe('platform brand identity', () => {
  // Guarded so a deployment that deliberately white-labels via BRAND_NAME still
  // passes; unset (the normal case, including CI) this pins the code default.
  test('the default platform brand is CVsprings, not the legal entity', { skip: !!process.env.BRAND_NAME }, () => {
    assert.equal(DEFAULT_BRAND_NAME, 'CVsprings');
  });

  test('report header and free-tier credit name the same brand', { skip: !!process.env.BRAND_NAME }, () => {
    const doc = buildReportDoc(AUDIT, resolveBranding(NO_BRANDING, FREE));
    const heading = textsIn(doc.content).find((t) => t.includes('Candidate Assessment Report'));
    assert.ok(heading.startsWith(DEFAULT_BRAND_NAME), `header was: ${heading}`);
    assert.ok(
      FREE_TIER_CREDIT_TEXT.includes(DEFAULT_BRAND_NAME),
      `header says "${DEFAULT_BRAND_NAME}" but credit says "${FREE_TIER_CREDIT_TEXT}"`,
    );
  });
});

describe('free tier', () => {
  test('custom branding is ignored and the credit is shown', () => {
    const b = resolveBranding(CUSTOM, FREE);
    assert.equal(b.name, DEFAULT_BRAND_NAME, 'org display name must not be used');
    assert.equal(b.color, DEFAULT_BRAND_COLOR, 'org colour must not be used');
    assert.equal(b.logoUrl, null, 'org logo must not be used');
    assert.equal(b.showCredit, true);
    assert.equal(b.creditText, FREE_TIER_CREDIT_TEXT);
  });

  test('org with no branding set also gets the credit', () => {
    const b = resolveBranding(NO_BRANDING, FREE);
    assert.equal(b.showCredit, true);
    assert.equal(b.creditText, FREE_TIER_CREDIT_TEXT);
  });
});

describe('paid tiers', () => {
  test('Pro with custom branding: own branding, no credit', () => {
    const b = resolveBranding(CUSTOM, PRO);
    assert.equal(b.name, 'Acme Recruitment');
    assert.equal(b.color, '#ff0066');
    assert.equal(b.logoUrl, 'https://acme.example/logo.png');
    assert.equal(b.showCredit, false);
    assert.equal(b.creditText, null);
  });

  test('Pro with NO custom branding: clean platform branding, still no credit', () => {
    const b = resolveBranding(NO_BRANDING, PRO);
    assert.equal(b.name, DEFAULT_BRAND_NAME);
    assert.equal(b.color, DEFAULT_BRAND_COLOR);
    assert.equal(b.showCredit, false, 'paid orgs are never nagged, branded or not');
    assert.equal(b.creditText, null);
  });

  test('Team behaves exactly as Pro', () => {
    assert.deepEqual(resolveBranding(CUSTOM, TEAM), resolveBranding(CUSTOM, PRO));
    assert.deepEqual(resolveBranding(NO_BRANDING, TEAM), resolveBranding(NO_BRANDING, PRO));
  });

  test('past_due keeps entitlement (grace window, matches the quota gate)', () => {
    const b = resolveBranding(CUSTOM, { plan: 'pro', subscriptionStatus: 'past_due' });
    assert.equal(b.name, 'Acme Recruitment');
    assert.equal(b.showCredit, false);
  });
});

describe('entitlement is server-side and fails closed', () => {
  test('paid plan with an inactive subscription is treated as free', () => {
    for (const status of ['canceled', 'incomplete', 'unpaid', null]) {
      const b = resolveBranding(CUSTOM, { plan: 'pro', subscriptionStatus: status });
      assert.equal(b.showCredit, true, `status=${status} must not grant branding`);
      assert.equal(b.name, DEFAULT_BRAND_NAME);
    }
  });

  test('missing or omitted billing row resolves to free, not paid', () => {
    assert.equal(resolveBranding(CUSTOM, null).showCredit, true);
    assert.equal(resolveBranding(CUSTOM, undefined).showCredit, true);
    assert.equal(resolveBranding(CUSTOM).showCredit, true);
  });

  test('a client-supplied flag on the branding row cannot buy entitlement', () => {
    const spoofed = { ...CUSTOM, showCredit: false, plan: 'team', entitled: true };
    const b = resolveBranding(spoofed, FREE);
    assert.equal(b.showCredit, true);
    assert.equal(b.name, DEFAULT_BRAND_NAME);
  });
});

describe('downgrade takes effect immediately (nothing cached)', () => {
  test('same org branding + changed plan flips the result on the next call', () => {
    const asPro = resolveBranding(CUSTOM, PRO);
    assert.equal(asPro.showCredit, false);
    assert.equal(asPro.name, 'Acme Recruitment');

    // Downgrade: the org row is untouched, only billing changed.
    const asFree = resolveBranding(CUSTOM, FREE);
    assert.equal(asFree.showCredit, true, 'next report must revert to the credit');
    assert.equal(asFree.name, DEFAULT_BRAND_NAME);

    // ...and back again, proving neither direction is sticky.
    assert.equal(resolveBranding(CUSTOM, PRO).showCredit, false);
  });

  test('returns a fresh object each call (no shared/memoised instance)', () => {
    const a = resolveBranding(CUSTOM, PRO);
    const b = resolveBranding(CUSTOM, PRO);
    assert.notEqual(a, b, 'must not hand back a memoised object');
    assert.deepEqual(a, b);
    a.name = 'mutated';
    assert.equal(resolveBranding(CUSTOM, PRO).name, 'Acme Recruitment');
  });
});

// Walk a pdfmake node tree collecting every string, so footer assertions do not
// depend on the exact column layout.
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

const AUDIT = {
  id: 'aud_1', candidateName: 'Sam Rivers', overall: 72, role: 'Backend Engineer',
  scores: { keywords: 70, skills: 80 }, analysisDetail: { found: ['Node.js'], missing: ['Kubernetes'] },
};

describe('credit reaches the rendered report footer', () => {
  test('free org: footer carries the credit text and the brandmark', () => {
    const doc = buildReportDoc(AUDIT, resolveBranding(CUSTOM, FREE));
    const footer = doc.footer(1, 1);
    assert.ok(textsIn(footer).includes(FREE_TIER_CREDIT_TEXT), 'credit text missing from footer');
    assert.equal(svgsIn(footer).length, 1, 'expected exactly one brandmark in the footer');
    // The org's own branding must not have leaked into the body either.
    assert.ok(!textsIn(doc.content).some((t) => t.includes('Acme Recruitment')));
  });

  test('free org: the credit is footer-only, never in the body', () => {
    const doc = buildReportDoc(AUDIT, resolveBranding(CUSTOM, FREE));
    assert.ok(!textsIn(doc.content).includes(FREE_TIER_CREDIT_TEXT));
    assert.equal(svgsIn(doc.content).length, 0, 'no brandmark anywhere in the body');
    assert.equal(svgsIn(doc.header(2)).length, 0, 'no brandmark in the running header');
  });

  test('paid org: no credit text and no CVsprings mark anywhere', () => {
    const doc = buildReportDoc(AUDIT, resolveBranding(CUSTOM, PRO));
    const everywhere = [...textsIn(doc.footer(1, 1)), ...textsIn(doc.content), ...textsIn(doc.header(2))];
    assert.ok(!everywhere.includes(FREE_TIER_CREDIT_TEXT));
    assert.equal(svgsIn(doc.footer(1, 1)).length, 0);
    assert.equal(svgsIn(doc.content).length, 0);
    // ...and the org's own branding IS applied.
    assert.ok(textsIn(doc.content).some((t) => t.includes('Acme Recruitment')));
  });

  test('paid org with no branding: platform branding, still no credit', () => {
    const doc = buildReportDoc(AUDIT, resolveBranding(NO_BRANDING, TEAM));
    assert.ok(!textsIn(doc.footer(1, 1)).includes(FREE_TIER_CREDIT_TEXT));
    assert.equal(svgsIn(doc.footer(1, 1)).length, 0);
    assert.ok(textsIn(doc.content).some((t) => t.includes(DEFAULT_BRAND_NAME)));
  });

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

  test('report ID and pagination survive alongside the credit', () => {
    const footer = buildReportDoc(AUDIT, resolveBranding(CUSTOM, FREE)).footer(2, 3);
    const texts = textsIn(footer);
    assert.ok(texts.some((t) => t.includes('Report ID: aud_1')));
    assert.ok(texts.some((t) => t.includes('Page 2 of 3')));
  });
});
