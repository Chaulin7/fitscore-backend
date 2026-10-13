'use strict';

/**
 * src/routes/appColorContrast.test.js
 *
 * Text colours in public/app.html that axe flagged under WCAG AA (4.5:1) and
 * that are not the muted/inactive greys (those are mutedTextContrast.test.js):
 *
 *   - the footer's bottom row, translucent white over the navy footer
 *     (was .4 alpha, 3.71:1);
 *   - the weight total in its valid state (was #059669, 3.76:1 on white);
 *   - the rank-2 badge, white on a grey gradient (was #9ca3af→#6b7280,
 *     2.54:1 at the light end).
 *
 * Colours are read from the page's own CSS, so the test follows the stylesheet.
 */

const fs = require('node:fs');
const path = require('node:path');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const HTML = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'app.html'), 'utf8');
const CSS = /<style>([\s\S]*?)<\/style>/.exec(HTML)[1].replace(/\/\*[\s\S]*?\*\//g, '');

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

const assertAA = (fg, bg, what) => {
  const ratio = contrast(fg, bg);
  assert.ok(ratio >= 4.5, `${what}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1, under 4.5:1`);
};

describe('app.html text colours meet WCAG AA contrast', () => {
  const FOOTER = declared('.site-footer', 'background');

  test('footer bottom row on the navy footer', () => {
    const fg = declared('.footer-bottom', 'color');
    assert.ok(FOOTER && fg, 'could not resolve the footer colours');
    assertAA(over(fg, FOOTER), FOOTER, '.footer-bottom');
  });

  test('valid weight total on the surfaces around it', () => {
    const fg = declared('.w-sum.ok', 'color');
    assert.ok(fg, 'could not resolve .w-sum.ok');
    // White card, the weight cards' #fafafa, and the page background.
    for (const bg of ['#ffffff', '#fafafa', '#f0f2f5']) assertAA(fg, bg, '.w-sum.ok');
  });

  test('white rank-2 badge text across its whole gradient', () => {
    const bg = declared('.r2', 'background');
    const stops = (bg || '').match(/#[0-9a-fA-F]{6}/g) || [];
    assert.ok(stops.length >= 2, `could not resolve the .r2 gradient: ${bg}`);
    assert.equal(declared('.r2', 'color'), '#fff');
    // Between two greys the gradient's luminance is monotonic, so its ends bound it.
    for (const stop of stops) assertAA('#ffffff', stop, '.r2 gradient stop');
  });

  test('the old colours fail where the new ones pass (guards a vacuous pass)', () => {
    assert.ok(contrast(over('rgba(255,255,255,.4)', '#0a1f3d'), '#0a1f3d') < 4.5);
    assert.ok(contrast('#059669', '#ffffff') < 4.5);
    assert.ok(contrast('#ffffff', '#9ca3af') < 4.5);
  });
});
