'use strict';

/**
 * src/routes/phoneLayout.test.js — the two layout rules that kept Terms and
 * Privacy from fitting a 375px phone (164px and 278px of sideways scroll):
 *
 *   - a top bar of page links must wrap on phones (or, like the app's, fold
 *     into a menu). As one fixed-height row it runs off-screen and drags the
 *     whole page wide with it;
 *   - a wide table scrolls inside its own box, never the page.
 *
 * Layout cannot be measured without a browser, so this checks the CSS and
 * markup that produce it — enough to stop a new or edited page from quietly
 * dropping either rule. The page list comes from HTML_PAGES in src/index.js.
 */

const fs = require('node:fs');
const path = require('node:path');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..', '..');
const read = (page) => fs.readFileSync(path.join(ROOT, 'public', page), 'utf8');
const SERVED_PAGES = (() => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'index.js'), 'utf8');
  return [...(/const HTML_PAGES = \[([^\]]+)\]/.exec(src)[1]).matchAll(/'([^']+\.html)'/g)].map((m) => m[1]);
})();

const styles = (html) => [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n');
const phoneBlocks = (css) => [...css.matchAll(/@media\s*\(max-width:\s*640px\)\s*\{([\s\S]*?\})\s*\}/g)].map((m) => m[1]);

describe('a top bar of page links wraps on phones', () => {
  const withTopbar = SERVED_PAGES.filter((p) => /<div class="topbar">[\s\S]*?class="nav-btn"/.test(read(p)));

  test('the scan finds the doc pages (guards a vacuous pass)', () => {
    for (const p of ['terms.html', 'privacy.html', 'compliance.html', 'integrations.html']) assert.ok(withTopbar.includes(p), p);
  });

  for (const page of withTopbar) {
    test(page, () => {
      const css = styles(read(page));
      const wraps = phoneBlocks(css).some((b) => /\.topbar\s*\{[^}]*flex-wrap:\s*wrap/.test(b));
      // The app's alternative: below 1100px its links collapse into a drawer.
      const folds = /@media\s*\(max-width:\s*\d+px\)\s*\{[^@]*?\.topbar-nav\s*\{\s*display:\s*none/.test(css);
      assert.ok(wraps || folds,
        `${page}: no @media(max-width:640px) rule lets .topbar wrap; at 375px its links run off the page`);
    });
  }
});

describe('Terms and Privacy: tables scroll inside their own box', () => {
  for (const page of ['terms.html', 'privacy.html']) {
    test(page, () => {
      const html = read(page);
      const tables = (html.match(/<table\b/g) || []).length;
      const wrapped = (html.match(/<div class="table-scroll"[^>]*>\s*<table\b/g) || []).length;
      assert.equal(wrapped, tables, `${page}: ${tables - wrapped} table(s) can widen the page`);
      if (tables) assert.match(styles(html), /\.table-scroll\s*\{[^}]*overflow-x:\s*auto/);
    });
  }
});
