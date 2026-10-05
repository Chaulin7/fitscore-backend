'use strict';

/**
 * src/routes/aiClaims.test.js — nothing we publish says the product IS AI.
 *
 * CVsprings scores with a deterministic, rules-based engine. The site and the
 * client documents used to call it "AI-based", "AI-assisted", "AI-powered",
 * and quoted UI hints about "the AI"; each was removed by hand, and nothing
 * stopped the next one. This scans what a reader actually gets:
 *
 *   - every served page, in every language it is rendered in (visible text:
 *     comments, scripts and styles skipped — counsel-review notes quote the
 *     old wording on purpose);
 *   - every dictionary string (page scripts render them at runtime);
 *   - every docs/ file shipped to clients (test/helpers/clientDocs.js).
 *
 * Denials ("Why we don't use AI", "not a machine-learning model", "no
 * third-party AI service") and EU AI Act citations ("AI systems used for
 * recruitment … are high-risk under Annex III") are not claims and pass.
 */

const fs = require('node:fs');
const path = require('node:path');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { buildVariants } = require('../i18n/pages');
const { SHIPPED } = require('../../test/helpers/clientDocs');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const CLAIMS = [
  /\bAI[- ](?:based|assisted|powered|generated|driven|enabled|supported)\b/i,
  /\bAI[- ]tool\b/i, // also the Dutch "AI-tool"
  /\b(?:is|as) an AI\b/i, // "CVsprings is an AI system"
  /\b(?:by|from) the AI\b(?![- ]Act)/i, // "not by the AI"
  /\bKI[- ](?:basiert|gestützt|Tool)/i,
  /\bAI[- ]gestuurd\b|\bop AI gebaseerd\b/i,
];

function claims(text) {
  const flat = text.replace(/\s+/g, ' ');
  return CLAIMS.flatMap((re) => {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    return [...flat.matchAll(g)].map((m) => flat.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40).trim());
  });
}

const visibleHtml = (html) => html
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<[^>]+>/g, ' ');

test('the detector flags claims and passes denials and citations (guards a vacuous pass)', () => {
  for (const c of ['an AI-based tool', 'AI-assisted scoring', 'an AI-powered analyzer', 'AI-generated assessment',
    'not by the AI', 'CVsprings is an AI system', 'een AI-tool', 'ein KI-gestütztes Werkzeug']) {
    assert.equal(claims(c).length, 1, c);
  }
  for (const ok of ["Why we don't use AI", 'not a machine-learning model', 'no third-party AI service',
    'AI systems used for recruitment are high-risk under Annex III', 'the EU AI Act', 'by the AI Act',
    'done by an AI system, the obligations follow', 'no AI/LLM provider']) {
    assert.deepEqual(claims(ok), [], ok);
  }
});

describe('served pages', () => {
  const pages = [...(/const HTML_PAGES = \[([^\]]+)\]/.exec(read('src/index.js'))[1]).matchAll(/'([^']+\.html)'/g)].map((m) => m[1]);
  const { variants } = buildVariants(Object.fromEntries(pages.map((p) => [p, read('public/' + p)])));
  for (const page of pages) {
    test(page, () => {
      for (const [lang, html] of Object.entries(variants[page])) {
        assert.deepEqual(claims(visibleHtml(html)), [], `${page} [${lang}] says the product is AI`);
      }
    });
  }
});

test('dictionaries', () => {
  for (const lang of ['en', 'nl', 'de']) {
    const dict = JSON.parse(read(`locales/${lang}.json`));
    const hits = Object.entries(dict).flatMap(([k, v]) => claims(v).map((c) => `${k}: ${c}`));
    assert.deepEqual(hits, [], `locales/${lang}.json`);
  }
});

describe('docs shipped to clients', () => {
  for (const file of SHIPPED) {
    test(file, () => {
      assert.deepEqual(claims(read(file).replace(/<!--[\s\S]*?-->/g, ' ')), [], `${file} says the product is AI`);
    });
  }
});
