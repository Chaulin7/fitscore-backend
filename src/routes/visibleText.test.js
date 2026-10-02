'use strict';

/**
 * src/routes/visibleText.test.js — no visitor ever reads "TODO".
 *
 * Operator to-dos lived in the pages as visible badges ("TODO — operator:
 * confirm the region…") and one leaked into a legal page's running text. A
 * reminder for the operator belongs in an HTML comment, where it stays in the
 * source and out of the page.
 *
 * Checked for every served page (HTML_PAGES in src/index.js) in every
 * language it is rendered in: the text a visitor sees, plus the attributes a
 * visitor sees (placeholder, title, alt, value). Comments, <script>, <style>
 * and <template> are not visible and are skipped. The dictionaries are checked
 * too, since the pages' scripts render their strings at runtime.
 */

const fs = require('node:fs');
const path = require('node:path');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { buildVariants } = require('../i18n/pages');
const { decodeEntities } = require('../i18n/prerender');

const ROOT = path.join(__dirname, '..', '..');
const SERVED_PAGES = (() => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'index.js'), 'utf8');
  return [...(/const HTML_PAGES = \[([^\]]+)\]/.exec(src)[1]).matchAll(/'([^']+\.html)'/g)].map((m) => m[1]);
})();

const TODO = /\bTODO\b/i;

// Unknown named entities (&Uuml; …) cannot spell TODO; treat them as a space.
const decode = (s) => s.replace(/&[#a-z0-9]+;/gi, (e) => { try { return decodeEntities(e); } catch (_) { return ' '; } });

/** Every visible "TODO" in a page: in its text, or in an attribute that renders. */
function visibleTodos(html) {
  const visible = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  const attrs = [...visible.matchAll(/\s(?:placeholder|title|alt|value)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)]
    .map((m) => decode(m[1] ?? m[2]));
  const text = decode(visible.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');
  return [
    ...[...text.matchAll(/.{0,50}\bTODO\b.{0,50}/gi)].map((m) => m[0].trim()),
    ...attrs.filter((a) => TODO.test(a)),
  ];
}

const templates = Object.fromEntries(SERVED_PAGES.map((p) => [p, fs.readFileSync(path.join(ROOT, 'public', p), 'utf8')]));
const { variants } = buildVariants(templates);

test('the detector sees text and visible attributes, and skips what is hidden (guards a vacuous pass)', () => {
  assert.equal(visibleTodos('<p>Region: <span class="todo">TODO — operator</span></p>').length, 1);
  assert.equal(visibleTodos('<input placeholder="TODO: name">').length, 1);
  assert.equal(visibleTodos('<p>T&#79;DO via an entity</p>').length, 1);
  assert.deepEqual(visibleTodos('<!-- TODO(operator): hidden --><p class="todo">fine</p><script>// TODO</script><style>/* TODO */</style>'), []);
});

test('every served page is checked', () => {
  assert.deepEqual(Object.keys(variants).sort(), [...SERVED_PAGES].sort());
  for (const p of ['privacy.html', 'terms.html', 'impressum.html', 'compliance.html', 'contact.html', 'index.html', 'app.html']) {
    assert.ok(SERVED_PAGES.includes(p), p);
  }
});

describe('no served page shows "TODO" to a visitor', () => {
  for (const page of SERVED_PAGES) {
    test(page, () => {
      for (const [lang, html] of Object.entries(variants[page])) {
        assert.deepEqual(visibleTodos(html), [], `${page} [${lang}] shows a TODO; move it into an HTML comment`);
      }
    });
  }
});

test('no dictionary string says "TODO" (page scripts render them at runtime)', () => {
  for (const lang of ['en', 'nl', 'de']) {
    const dict = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', lang + '.json'), 'utf8'));
    const hits = Object.entries(dict).filter(([, v]) => TODO.test(v)).map(([k]) => k);
    assert.deepEqual(hits, [], `locales/${lang}.json`);
  }
});
