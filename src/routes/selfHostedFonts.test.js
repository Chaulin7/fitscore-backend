'use strict';

/**
 * src/routes/selfHostedFonts.test.js — no page asks Google for a font.
 *
 * Every page used to load its typefaces from fonts.googleapis.com /
 * fonts.gstatic.com, which hands each visitor's IP address to Google (the
 * Privacy Policy had to list Google as a recipient for it). The same font files
 * are now served from public/assets/fonts/, and the CSP no longer admits the
 * Google domains, so a page that slipped a Google link back in would also break.
 *
 * Checked here: no served page, no stylesheet under public/, and no server code
 * that renders HTML mentions a Google font domain; each page that uses one of
 * the fonts links the local stylesheet; every file those stylesheets name
 * exists and is woff2; each family ships its licence. The CSP header itself is
 * checked over HTTP in src/i18n/pages.test.js.
 */

const fs = require('node:fs');
const path = require('node:path');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..', '..');
const PUBLIC = path.join(ROOT, 'public');
const GOOGLE_FONTS = /fonts\.googleapis\.com|fonts\.gstatic\.com/i;

const SERVED_PAGES = [...(/const HTML_PAGES = \[([^\]]+)\]/.exec(fs.readFileSync(path.join(ROOT, 'src/index.js'), 'utf8'))[1])
  .matchAll(/'([^']+\.html)'/g)].map((m) => m[1]);

function walk(dir, keep) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : walk(full, keep);
    return keep(e.name) ? [full] : [];
  });
}
const rel = (p) => path.relative(ROOT, p);

describe('no Google font domain anywhere a visitor can be sent to it', () => {
  test('the detector works (guards a vacuous pass)', () => {
    assert.match('<link href="https://fonts.googleapis.com/css2?family=Inter">', GOOGLE_FONTS);
    assert.match('src: url(https://fonts.gstatic.com/s/inter/v20/x.woff2)', GOOGLE_FONTS);
  });

  for (const page of SERVED_PAGES) {
    test(`public/${page}`, () => {
      assert.doesNotMatch(fs.readFileSync(path.join(PUBLIC, page), 'utf8'), GOOGLE_FONTS);
    });
  }

  test('every file under public/ (other HTML, CSS, JS)', () => {
    const hits = walk(PUBLIC, (n) => /\.(html|css|js|svg)$/.test(n))
      .filter((f) => GOOGLE_FONTS.test(fs.readFileSync(f, 'utf8'))).map(rel);
    assert.deepEqual(hits, []);
  });

  test('server code that renders HTML (reports, admin pages) and the CSP', () => {
    const hits = walk(path.join(ROOT, 'src'), (n) => n.endsWith('.js') && !n.endsWith('.test.js'))
      .filter((f) => GOOGLE_FONTS.test(fs.readFileSync(f, 'utf8'))).map(rel);
    assert.deepEqual(hits, []);
  });
});

describe('the self-hosted fonts', () => {
  const STYLESHEETS = {
    '/assets/fonts/inter.css': ['Inter'],
    '/assets/fonts/landing.css': ['Space Grotesk', 'IBM Plex Sans', 'IBM Plex Mono'],
  };

  test('each page that uses a family links the stylesheet that defines it', () => {
    for (const page of SERVED_PAGES) {
      const html = fs.readFileSync(path.join(PUBLIC, page), 'utf8');
      for (const [href, families] of Object.entries(STYLESHEETS)) {
        const uses = families.some((f) => new RegExp(`font-family:\\s*['"]?${f}`, 'i').test(html) || html.includes(`'${f}'`));
        if (uses) assert.ok(html.includes(`<link rel="stylesheet" href="${href}">`), `${page} uses ${families.join('/')} but does not link ${href}`);
      }
    }
  });

  for (const [href, families] of Object.entries(STYLESHEETS)) {
    test(`${href}: every face points at a real woff2 file, display swap`, () => {
      const css = fs.readFileSync(path.join(PUBLIC, href), 'utf8');
      const faces = css.match(/@font-face \{[\s\S]*?\}/g) || [];
      assert.ok(faces.length > 0);
      for (const f of families) assert.ok(css.includes(`font-family: '${f}'`), f);
      for (const face of faces) {
        assert.match(face, /font-display: swap;/);
        const url = /url\((\/assets\/fonts\/[^)]+\.woff2)\)/.exec(face);
        assert.ok(url, face);
        const file = path.join(PUBLIC, url[1]);
        assert.ok(fs.existsSync(file), `${url[1]} is missing`);
        assert.equal(fs.readFileSync(file).subarray(0, 4).toString('latin1'), 'wOF2', `${url[1]} is not woff2`);
      }
    });
  }

  test('every family directory ships its licence (SIL OFL 1.1)', () => {
    const dirs = fs.readdirSync(path.join(PUBLIC, 'assets/fonts'), { withFileTypes: true }).filter((e) => e.isDirectory());
    assert.equal(dirs.length, 4);
    for (const d of dirs) {
      const lic = path.join(PUBLIC, 'assets/fonts', d.name, 'OFL.txt');
      assert.ok(fs.existsSync(lic), `${d.name} has no OFL.txt`);
      assert.match(fs.readFileSync(lic, 'utf8'), /SIL OPEN FONT LICENSE Version 1\.1/i);
    }
  });
});

test('the Privacy Policy no longer lists Google Fonts', () => {
  const visible = fs.readFileSync(path.join(PUBLIC, 'privacy.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  assert.doesNotMatch(visible, /Google Fonts|Google LLC|fonts are loaded|Google&rsquo;s CDN/i);
});
