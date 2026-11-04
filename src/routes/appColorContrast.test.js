'use strict';

/**
 * src/routes/appColorContrast.test.js
 *
 * Text colours in public/app.html held to WCAG AA (4.5:1) that are not the
 * muted/inactive greys (those are mutedTextContrast.test.js):
 *
 *   - the footer's bottom row, translucent white over the navy footer
 *     (was .4 alpha, 3.71:1);
 *   - success and warning text, --text-success / --text-warning (the weight
 *     total, "Settings saved", "None missing" and the plan ticks were #059669
 *     and #16a34a, 3.30–3.77:1);
 *   - the rank badges: dark text on gold, white on silver and bronze (white
 *     on gold was 2.15:1, white on the old bronze 3.19:1);
 *   - the score-ring numbers, which can be darker than their ring (the
 *     Experience and Education numbers were 3.19:1 and 3.77:1);
 *   - text on tinted fills: error messages, the plan alert, the file chip and
 *     the template chip's remove buttons, the anonymize "?" on hover, the
 *     template-migration button;
 *   - input placeholders (were #d1d5db, 1.47:1);
 *   - the sample-CV chip's "(example)" label (was #4338ca at .7 opacity, 3.69:1).
 *
 * Colours are read from the page's own CSS and markup, so the test follows them.
 */

const fs = require('node:fs');
const path = require('node:path');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const HTML = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'app.html'), 'utf8');
const CSS = /<style>([\s\S]*?)<\/style>/.exec(HTML)[1].replace(/\/\*[\s\S]*?\*\//g, '');

const TOKENS = Object.fromEntries(
  [.../--([a-z-]+):(#[0-9A-Fa-f]{6})/g[Symbol.matchAll](/:root\{([^}]*)\}/.exec(CSS)[1])].map((m) => [m[1], m[2].toLowerCase()]),
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
const hex = (rgb) => '#' + rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
const channels = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

/** `rgba(r,g,b,a)` over an opaque hex background, as the browser composites it. */
function over(rgba, bg) {
  const [r, g, b, a] = /rgba\(([^)]+)\)/.exec(rgba)[1].split(',').map(Number);
  return hex([r, g, b].map((v, i) => v * a + channels(bg)[i] * (1 - a)));
}

/** A colour value as a 6-digit hex: expands #abc, resolves var(--token), drops !important. */
function resolve(v) {
  const s = String(v || '').replace(/!important/, '').trim().toLowerCase();
  const t = /^var\(--([a-z-]+)\)$/.exec(s);
  if (t) return TOKENS[t[1]] || null;
  if (/^#[0-9a-f]{3}$/.test(s)) return '#' + [...s.slice(1)].map((c) => c + c).join('');
  return /^#[0-9a-f]{6}$/.test(s) ? s : null;
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
const colour = (selector, prop = 'color') => {
  const v = resolve(declared(selector, prop));
  assert.ok(v, `could not resolve ${prop} of ${selector}: ${declared(selector, prop)}`);
  return v;
};

/** Points along a two-stop linear gradient, interpolated in sRGB as browsers do by default. */
function gradientSamples(background) {
  const stops = (background || '').match(/#[0-9a-fA-F]{6}/g) || [];
  assert.equal(stops.length, 2, `expected a two-stop gradient: ${background}`);
  const [a, b] = stops.map(channels);
  return Array.from({ length: 11 }, (_, i) => hex(a.map((v, k) => v + (b[k] - v) * (i / 10))));
}

const assertAA = (fg, bg, what) => {
  const ratio = contrast(fg, bg);
  assert.ok(ratio >= 4.5, `${what}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1, under 4.5:1`);
};

describe('app.html text colours meet WCAG AA contrast', () => {
  const FOOTER = declared('.site-footer', 'background');
  const PAGE = colour('body', 'background');

  test('footer bottom row on the navy footer', () => {
    const fg = declared('.footer-bottom', 'color');
    assert.ok(FOOTER && fg, 'could not resolve the footer colours');
    assertAA(over(fg, FOOTER), FOOTER, '.footer-bottom');
  });

  test('success and warning tokens on every surface they sit on', () => {
    // White cards and panels, #fafafa weight cards, #f8fafc plan and retention
    // panels; warning also marks rows on #fffbeb (failed rows, dry runs).
    for (const bg of ['#ffffff', '#fafafa', '#f8fafc']) assertAA(TOKENS['text-success'], bg, '--text-success');
    for (const bg of ['#ffffff', '#fafafa', '#f8fafc', '#fffbeb']) assertAA(TOKENS['text-warning'], bg, '--text-warning');
  });

  test('success text uses the token', () => {
    for (const sel of ['.w-sum.ok', '.pp-ent li::before']) assert.equal(declared(sel, 'color'), 'var(--text-success)', sel);
    assert.match(HTML, /id="settingsSavedMsg" style="[^"]*color:var\(--text-success\)/);
    assert.match(HTML, /color:var\(--text-success\);font-size:13px' \}, I18N\.t\('app\.results\.noneMissing'\)/);
  });

  test('warning and success text go through the tokens, not their hexes', () => {
    // The hexes may still appear as fills (the bronze badge starts at #b45309).
    const hits = HTML.match(/(?<![-\w])color\s*:\s*#(b45309|047857|059669|16a34a|d1d5db)\b/gi);
    assert.equal(hits, null, `use var(--text-warning) / var(--text-success) / var(--text-inactive): ${hits}`);
  });

  for (const badge of ['.r1', '.r2', '.r3']) {
    test(`${badge} rank badge text across its whole gradient`, () => {
      const fg = colour(badge);
      for (const stop of gradientSamples(declared(badge, 'background'))) assertAA(fg, stop, `${badge} gradient`);
    });
  }

  test('score-ring numbers on the white score box', () => {
    const box = colour('.score-box', 'background');
    const calls = [...HTML.matchAll(/ringBox\(I18N\.t\('common\.dimension\.(\w+)'\),[^,]+,false,'([^']+)'(?:,'([^']+)')?\)/g)];
    assert.equal(calls.length, 4, 'expected the four dimension rings');
    for (const [, dim, ring, text] of calls) assertAA(resolve(text || ring), box, `${dim} score number`);
  });

  test('text on tinted fills', () => {
    assertAA(colour('.msg-err'), colour('.msg-err', 'background'), '.msg-err');
    assertAA(colour('.pp-alert-b'), colour('.pp-alert', 'background'), '.pp-alert-b');
    const chip = colour('.file-chip', 'background');
    assertAA(colour('.file-chip button'), chip, '.file-chip button');
    assertAA(colour('.file-chip button:hover'), chip, '.file-chip button:hover');
    assertAA(colour('.tpl-chip-del'), '#ffffff', '.tpl-chip-del');
    assertAA(colour('.tpl-chip-del:hover'), colour('.tpl-chip-del:hover', 'background'), '.tpl-chip-del:hover');
    assertAA(colour('.anon-tooltip-wrap:hover .anon-tooltip-icon'), PAGE, 'anonymize "?" on hover');
  });

  test('sample-CV chip "(example)" label, at full opacity', () => {
    const tag = '.file-chip.sample-chip .sample-tag';
    const op = declared(tag, 'opacity');
    assert.ok(op === null || Number(op) === 1, `${tag} is faded with opacity ${op}; use a colour that passes instead`);
    const fg = resolve(declared(tag, 'color')) || colour('.file-chip.sample-chip');
    assertAA(fg, colour('.file-chip.sample-chip', 'background'), tag);
  });

  test('template-migration button', () => {
    const style = /class="tpl-mig-upload" style="([^"]*)"/.exec(HTML)[1];
    const bg = resolve(/background:([^;]+)/.exec(style)[1]);
    const fg = resolve(/(?:^|;)color:([^;]+)/.exec(style)[1]);
    assertAA(fg, bg, '.tpl-mig-upload');
  });

  test('placeholders on their fields', () => {
    for (const [field, ph] of [['.text-input', '.text-input::placeholder'], ['.textarea', '.textarea::placeholder'], ['.row-notes', '.row-notes::placeholder']]) {
      assertAA(colour(ph), colour(field, 'background'), ph);
    }
  });

  test('the old colours fail where the new ones pass (guards a vacuous pass)', () => {
    assert.ok(contrast(over('rgba(255,255,255,.4)', '#0a1f3d'), '#0a1f3d') < 4.5);
    assert.ok(contrast('#059669', '#ffffff') < 4.5);
    assert.ok(contrast('#16a34a', '#ffffff') < 4.5);
    assert.ok(contrast('#ffffff', '#9ca3af') < 4.5);
    assert.ok(contrast('#ffffff', '#f59e0b') < 4.5);
    assert.ok(contrast('#ffffff', '#d97706') < 4.5);
    assert.ok(contrast('#d97706', '#ffffff') < 4.5);
    assert.ok(contrast('#a16207', '#fef3c7') < 4.5);
    assert.ok(contrast('#dc2626', '#fef2f2') < 4.5);
    assert.ok(contrast('#93c5fd', '#eff6ff') < 4.5);
    assert.ok(contrast('#dc2626', '#eff6ff') < 4.5);
    assert.ok(contrast('#6366f1', '#f0f2f5') < 4.5);
    assert.ok(contrast('#ffffff', '#ea580c') < 4.5);
    assert.ok(contrast('#d1d5db', '#ffffff') < 4.5);
    assert.ok(contrast(over('rgba(67,56,202,.7)', '#eef2ff'), '#eef2ff') < 4.5); // #4338ca at .7
  });
});
