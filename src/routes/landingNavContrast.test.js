'use strict';

/**
 * src/routes/landingNavContrast.test.js
 *
 * The landing nav's buttons are <a> elements inside .navlinks, and the plain
 * nav-link colour rule (.navlinks a, specificity 0,1,1) outranks the button
 * rules (.btn-primary / .btn-ghost, 0,1,0). That is how "Book a demo" came to
 * render ink-soft text on an ink background — 2.2:1, under WCAG AA — while the
 * stylesheet read as if .btn-primary set it.
 *
 * These tests resolve the colours the way the cascade does for the nav buttons
 * specifically, from the page's own :root tokens, and hold every state to AA
 * (4.5:1 for text at this size).
 */

const fs = require('node:fs');
const path = require('node:path');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const HTML = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf8');
const CSS = /<style>([\s\S]*?)<\/style>/.exec(HTML)[1].replace(/\/\*[\s\S]*?\*\//g, '');

const TOKENS = Object.fromEntries(
  [.../--([a-z-]+):(#[0-9A-Fa-f]{6})/g[Symbol.matchAll](/:root\{([\s\S]*?)\}/.exec(CSS)[1])].map((m) => [m[1], m[2]]),
);

function luminance(hex) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** The last declaration of `prop` among rules whose selector list contains `selector` exactly. */
function declared(selector, prop) {
  let value = null;
  for (const m of CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1].split(',').map((s) => s.trim());
    if (!selectors.includes(selector)) continue;
    const d = new RegExp('(?:^|;)\\s*' + prop + '\\s*:\\s*([^;]+)').exec(m[2]);
    if (d) value = d[1].trim();
  }
  return value;
}
const resolve = (v) => {
  const m = /^var\(--([a-z-]+)\)$/.exec(v || '');
  return m ? TOKENS[m[1]] : v;
};

// The first match wins: most specific selector the nav buttons can hit, first.
function color(state, kind) {
  const hover = state === 'hover' ? ':hover' : '';
  for (const sel of [`.navlinks a.${kind}${hover}`, `.navlinks a${hover}`, `.${kind}${hover}`, `.${kind}`]) {
    const v = declared(sel, 'color');
    if (v) return resolve(v);
  }
  return null;
}
function background(state, kind) {
  for (const sel of state === 'hover' ? [`.${kind}:hover`, `.${kind}`] : [`.${kind}`]) {
    const v = declared(sel, 'background');
    if (v && v !== 'transparent') return resolve(v);
  }
  return TOKENS.paper; // ghost buttons sit on the paper-coloured nav
}

describe('landing nav buttons meet WCAG AA contrast', () => {
  for (const kind of ['btn-primary', 'btn-ghost']) {
    for (const state of ['rest', 'hover']) {
      test(`${kind} (${state})`, () => {
        const fg = color(state, kind);
        const bg = background(state, kind);
        assert.ok(fg && bg, `could not resolve colours for ${kind} ${state}`);
        const ratio = contrast(fg, bg);
        assert.ok(ratio >= 4.5, `${kind} ${state}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1, under 4.5:1`);
      });
    }
  }

  test('"Book a demo" is the primary nav button these rules govern', () => {
    assert.match(HTML, /<a class="btn btn-primary nav-cta nav-demo" href="#demo"/);
  });

  test('the resolver sees the old failure (guards a vacuous pass)', () => {
    // Without the override, the link colour wins: ink-soft on ink.
    assert.ok(contrast(TOKENS['ink-soft'], TOKENS.ink) < 4.5);
  });
});
