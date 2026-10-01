'use strict';

/**
 * src/routes/siteFooter.test.js — the footer every served page carries.
 *
 * One tagline, everywhere: the landing page's "Deterministic CV screening ·
 * Made in the Netherlands", translated through the one common.footerTagline
 * key. The pages used to disagree (the doc pages and the app said
 * "deterministic, rules-based CV screening"), and nothing noticed, because each
 * page is its own file with its own copy of the footer.
 *
 * The page list is read from HTML_PAGES in src/index.js rather than repeated
 * here, so a page added to the served set is checked without anyone having to
 * remember this file.
 */

const fs = require('node:fs');
const path = require('node:path');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { buildVariants, PAGE_CONFIG } = require('../i18n/pages');
const { decodeEntities } = require('../i18n/prerender');
const ui = require('../i18n/ui');

const ROOT = path.join(__dirname, '..', '..');
const read = (page) => fs.readFileSync(path.join(ROOT, 'public', page), 'utf8');

const SERVED_PAGES = (() => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'index.js'), 'utf8');
  const m = /const HTML_PAGES = \[([^\]]+)\]/.exec(src);
  return [...m[1].matchAll(/'([^']+\.html)'/g)].map((x) => x[1]);
})();

const footerBlocks = (html) => html.match(/<footer\b[\s\S]*?<\/footer>/gi) || [];
const isEnglishOnly = (page) => PAGE_CONFIG[page] && PAGE_CONFIG[page].kind === 'english-only';
const TAGLINE_EN = ui.messagesFor('en')['common.footerTagline'];

test('the served page list is the one src/index.js serves (guards a vacuous pass)', () => {
  assert.ok(SERVED_PAGES.length >= 8, SERVED_PAGES.join(', '));
  for (const page of ['index.html', 'app.html', 'terms.html', 'privacy.html']) assert.ok(SERVED_PAGES.includes(page), page);
});

describe('one footer tagline on every page', () => {
  test('it is the landing page\'s line', () => {
    assert.equal(TAGLINE_EN, 'Deterministic CV screening · Made in the Netherlands');
  });

  for (const page of SERVED_PAGES) {
    test(page, () => {
      const footers = footerBlocks(read(page));
      assert.ok(footers.length > 0, `${page} has no <footer>`);
      const all = footers.join('\n');
      if (isEnglishOnly(page)) {
        // Terms and Privacy carry no i18n markup at all (i18n:check enforces
        // that), so the English line is written out.
        assert.ok(decodeEntities(all).includes(TAGLINE_EN), `${page}: footer does not say "${TAGLINE_EN}"`);
      } else {
        assert.match(all, /data-i18n="common\.footerTagline"/, `${page}: footer tagline is not the common.footerTagline key`);
      }
      assert.doesNotMatch(all, /rules-based CV screening/i, `${page}: the retired footer line is back`);
    });
  }

  test('nl and de variants say it in their own language', () => {
    const templates = Object.fromEntries(Object.keys(PAGE_CONFIG).map((p) => [p, read(p)]));
    const { variants } = buildVariants(templates);
    for (const [page, byLang] of Object.entries(variants)) {
      if (isEnglishOnly(page)) continue;
      for (const lang of ['nl', 'de']) {
        const expected = ui.core.escapeHtml(ui.messagesFor(lang)['common.footerTagline']);
        assert.notEqual(expected, ui.core.escapeHtml(TAGLINE_EN), `${lang} has no translation of the tagline`);
        assert.ok(footerBlocks(byLang[lang]).join('\n').includes(expected), `${page} [${lang}]`);
      }
    }
  });
});
