'use strict';

/**
 * src/routes/cspInlineHandlers.test.js
 *
 * Helmet sets script-src-attr 'none' (src/index.js), which does not merely
 * discourage inline on* handler attributes — it blocks them. An onclick that
 * slips into a served page is therefore not a style problem, it is a dead
 * control, and it fails silently: the markup renders, the button looks live,
 * and nothing happens when a user clicks it.
 *
 * That is exactly how public/compliance.html shipped two inert "Copy" buttons.
 * Nothing in the suite looked at the served HTML for this, so it stayed broken.
 *
 * This scans every page the server templates and renders.
 */

const path = require('node:path');
const fs = require('node:fs');

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

// Kept in step with HTML_PAGES in src/index.js — the pages served through the
// nonce-substituting template routes.
const SERVED_PAGES = [
  'index.html', 'app.html', 'compliance.html', 'integrations.html',
  'terms.html', 'privacy.html', 'bias-report.html',
];

// Strip <script>…</script> and <!-- … --> before scanning, so JS assignments
// (`let onboarded = '0'`) and commented-out markup cannot masquerade as
// attributes. What is left is markup, where an on*= really is an attribute.
function markupOnly(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
}

const INLINE_HANDLER = /<[a-zA-Z][^>]*?\son[a-zA-Z]+\s*=\s*["']/g;

describe('CSP: no inline on* handlers survive in served pages', () => {
  for (const page of SERVED_PAGES) {
    test(`${page} has no inline event-handler attributes`, () => {
      const file = path.join(PUBLIC_DIR, page);
      assert.ok(fs.existsSync(file), `${page} is listed as served but missing from public/`);
      const found = markupOnly(fs.readFileSync(file, 'utf8')).match(INLINE_HANDLER) || [];
      assert.deepEqual(
        found, [],
        `${page} carries ${found.length} inline handler attribute(s), which script-src-attr 'none' blocks. `
        + 'Wire the control through the delegated data-action map instead. Offenders: ' + found.join(' | '),
      );
    });
  }

  test('the scanner actually detects a handler (guards against a vacuous pass)', () => {
    const sample = '<button class="x" onclick="doThing()">Go</button>';
    assert.equal((markupOnly(sample).match(INLINE_HANDLER) || []).length, 1);
  });

  test('the scanner does not flag JS assignments or comments', () => {
    const sample = '<script>let onboarded = "0"; var online="y";</script>'
      + '<!-- <button onclick="old()">x</button> -->'
      + '<button data-action="copyNotice">Copy</button>';
    assert.deepEqual(markupOnly(sample).match(INLINE_HANDLER) || [], []);
  });

  test('every page listed here is one the server templates', () => {
    // If src/index.js gains a page, this test should gain it too — otherwise a
    // new page is served with no inline-handler coverage at all.
    const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    const declared = /const HTML_PAGES = \[([^\]]+)\]/.exec(indexSrc);
    assert.ok(declared, 'could not find HTML_PAGES in src/index.js');
    const served = [...declared[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(
      [...served].sort(), [...SERVED_PAGES].sort(),
      'HTML_PAGES in src/index.js and SERVED_PAGES here have drifted apart',
    );
  });
});

describe('compliance.html Copy buttons are wired through delegation', () => {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'compliance.html'), 'utf8');

  test('both buttons carry data-action + data-target', () => {
    const buttons = html.match(/<button[^>]*class="copy-btn"[^>]*>/g) || [];
    assert.equal(buttons.length, 2, 'expected the two notice-template Copy buttons');
    for (const b of buttons) {
      assert.match(b, /data-action="copyNotice"/, b);
      assert.match(b, /data-target="notice(En|Nl)"/, b);
      assert.doesNotMatch(b, /onclick/, b);
    }
  });

  test('the targets they name actually exist on the page', () => {
    for (const id of ['noticeEn', 'noticeNl']) {
      assert.match(html, new RegExp('id="' + id + '"'), `#${id} must exist for Copy to read`);
    }
  });

  test('a delegated click listener is registered', () => {
    assert.match(html, /closest\('\[data-action\]'\)/);
    assert.match(html, /click:\s*\{\s*copyNotice\s*\}/);
  });
});
