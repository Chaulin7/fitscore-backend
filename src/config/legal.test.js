'use strict';

/**
 * src/config/legal.test.js
 *
 * Art. 3:15d BW is a permanence requirement, not a "there is a page for it"
 * requirement: name, KvK number and BTW-id have to be easily, directly and
 * permanently accessible from the site. Two things can quietly break that, and
 * neither shows up as a failure anywhere else:
 *
 *   1. A new page is added to the served set and nobody remembers the footer.
 *      The page renders perfectly and is simply non-compliant.
 *   2. Someone types the number into a template instead of taking it from the
 *      constant, and the two drift. A wrong KvK number looks exactly as
 *      correct as a right one.
 *
 * So this scans every served page for the placeholder, and — the part that
 * matters — fails if a page carries the values in its own text instead.
 */

const path = require('node:path');
const fs = require('node:fs');

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { LEGAL_NAME, KVK, BTW_ID, FOOTER_LINE } = require('./legal');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

// Kept in step with HTML_PAGES in src/index.js — the pages served through the
// substituting template routes, and therefore the pages where a placeholder
// resolves rather than shipping to the visitor as literal text.
const SERVED_PAGES = [
  'index.html', 'app.html', 'compliance.html', 'integrations.html',
  'terms.html', 'privacy.html', 'bias-report.html',
];

const FOOTER_TOKEN = '__LEGAL_FOOTER__';
const NAME_TOKEN = '__LEGAL_NAME__';
const read = (page) => fs.readFileSync(path.join(PUBLIC_DIR, page), 'utf8');
const footerBlocks = (html) => html.match(/<footer[\s\S]*?<\/footer>/gi) || [];

describe('the legal entity constants', () => {
  test('are the registered values', () => {
    assert.equal(LEGAL_NAME, 'Joyaco BV');
    assert.equal(KVK, '42135911');
    assert.equal(BTW_ID, 'NL005523705B04');
  });

  test('have the shape their registries issue', () => {
    // A KvK number is eight digits. The footer placeholder this replaced was
    // also eight, so nothing downstream was ever sized for seven — but state
    // the width here so a future edit to a shorter number fails loudly.
    assert.match(KVK, /^\d{8}$/);
    assert.match(BTW_ID, /^NL\d{9}B\d{2}$/);
  });

  test('render as one canonical line', () => {
    assert.equal(FOOTER_LINE, 'Joyaco BV · KvK 42135911 · BTW NL005523705B04');
  });

  test('contain nothing that HTML injection would have to escape', () => {
    assert.ok(!/[<>&"']/.test(FOOTER_LINE), 'FOOTER_LINE is substituted into HTML unescaped');
  });
});

describe('art. 3:15d BW: the details reach every served page', () => {
  for (const page of SERVED_PAGES) {
    test(`${page} carries the legal footer inside a <footer>`, () => {
      const html = read(page);
      assert.ok(html.includes(FOOTER_TOKEN), `${page} has no ${FOOTER_TOKEN}; it would ship without the entity details`);
      const blocks = footerBlocks(html);
      assert.ok(blocks.length > 0, `${page} has no <footer> element to carry the details`);
      assert.ok(
        blocks.some((b) => b.includes(FOOTER_TOKEN)),
        `${page} has ${FOOTER_TOKEN} outside its <footer>, where it is not permanently visible`,
      );
    });
  }
});

describe('the values live in exactly one place', () => {
  for (const page of SERVED_PAGES) {
    test(`${page} does not hardcode them`, () => {
      const html = read(page);
      for (const [label, value] of [['KvK number', KVK], ['BTW-id', BTW_ID], ['legal name', LEGAL_NAME]]) {
        assert.ok(
          !html.includes(value),
          `${page} spells out the ${label} instead of using ${FOOTER_TOKEN} / ${NAME_TOKEN}. `
          + 'Two copies of a registry number is one copy too many.',
        );
      }
    });

    test(`${page} carries no stale entity name or placeholder number`, () => {
      const html = read(page);
      assert.ok(!/chaulin/i.test(html), `${page} still names the previous operating entity`);
      assert.ok(!/KvK\s*0{7,}/i.test(html), `${page} still shows the placeholder KvK number`);
    });
  }
});
