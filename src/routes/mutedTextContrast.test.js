'use strict';

/**
 * src/routes/mutedTextContrast.test.js
 *
 * Secondary text was #6b7280 ("muted") and #9ca3af ("inactive"). axe flagged
 * both under WCAG AA: #6b7280 is 4.31:1 on the #f0f2f5 page background, and
 * #9ca3af is 2.53:1 even on white. Every page now routes that text through
 * --text-muted / --text-inactive, declared in each page's own :root because
 * the pages (and the two server-rendered documents) carry their own <style>.
 *
 * These tests keep the copies identical, hold both values to 4.5:1 on every
 * surface they are used on, and stop the old literals coming back as text
 * colours.
 */

const fs = require('node:fs');
const path = require('node:path');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..', '..');
const FILES = [
  'public/app.html',
  'public/bias-report.html',
  'public/compliance.html',
  'public/contact.html',
  'public/integrations.html',
  'public/privacy.html',
  'public/terms.html',
  'src/routes/adminMetrics.js',
  'src/routes/audit.js',
];
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// Rules that set `color` but colour no text: the empty-state icon is a
// decorative SVG stroked with currentColor.
const NON_TEXT = [/\.empty-state-rich \.empty-icon\{[^}]*\}/g];

const TOKENS = { 'text-muted': '#5f6673', 'text-inactive': '#676d7b' };

// The surfaces this text sits on, darkest last: white cards, table heads and
// tinted panels, then the page background itself.
const SURFACES = ['#ffffff', '#fafafa', '#f9fafb', '#f8faff', '#f8fafc', '#f7f9fc', '#f3f4f6', '#f0f2f5'];

function luminance(hex) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

describe('muted and inactive text tokens', () => {
  for (const file of FILES) {
    test(`${file} declares both tokens with the shared values`, () => {
      const src = read(file);
      for (const [name, value] of Object.entries(TOKENS)) {
        const m = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(src);
        assert.ok(m, `${file} does not declare --${name}`);
        assert.equal(m[1].toLowerCase(), value, `${file} --${name}`);
      }
    });

    test(`${file} sets no text colour to the old greys`, () => {
      const src = NON_TEXT.reduce((s, re) => s.replace(re, ''), read(file));
      const hits = src.match(/(?<![-\w])color\s*:\s*['"]?\s*#(6b7280|9ca3af)\b/gi);
      assert.equal(hits, null, `use var(--text-muted) / var(--text-inactive) instead: ${hits}`);
    });
  }

  for (const [name, value] of Object.entries(TOKENS)) {
    for (const bg of SURFACES) {
      test(`--${name} ${value} on ${bg} is at least 4.5:1`, () => {
        const ratio = contrast(value, bg);
        assert.ok(ratio >= 4.5, `${value} on ${bg} is ${ratio.toFixed(2)}:1`);
      });
    }
  }

  // Two lighter one-off greys, used only as text on white (2.00:1 and 2.44:1):
  // the template panel footer and the change-history timestamps and notes.
  test('public/app.html has no #b0b8c4 or #9aa6c0 left', () => {
    const hits = read('public/app.html').match(/#(b0b8c4|9aa6c0)\b/gi);
    assert.equal(hits, null, `use var(--text-inactive) instead: ${hits}`);
  });

  test('the old values fail where the new ones pass (guards a vacuous pass)', () => {
    assert.ok(contrast('#6b7280', '#f0f2f5') < 4.5);
    assert.ok(contrast('#9ca3af', '#ffffff') < 4.5);
    assert.ok(contrast('#b0b8c4', '#ffffff') < 4.5);
    assert.ok(contrast('#9aa6c0', '#ffffff') < 4.5);
  });
});
