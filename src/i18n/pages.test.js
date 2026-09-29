'use strict';

/**
 * src/i18n/pages.test.js — the served pages, over HTTP, from the real server.
 *
 * The same URL now answers in three languages, so the property that matters
 * most is that no HTML response can be kept by a shared cache and replayed to
 * someone who asked in another language. That is asserted here for every HTML
 * route src/index.js registers, under every way a request can name a language.
 * Then: /nl/ and /de/ routing, canonical + hreflang, and the dictionary route.
 *
 * A real process (own port, throwaway database), because the routes, their
 * order relative to express.static, and the helmet/CORS headers are src/index.js
 * wiring — a router mounted in isolation would not prove any of it.
 */

const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const REPO_ROOT = path.join(__dirname, '..', '..');
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cvs-i18n-pages-'));
const ORIGIN = 'https://cvsprings.test';
const EN_KEYS = Object.keys(require('../../locales/en.json'));

let server = null;
let BASE = '';

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  });
}

before(async () => {
  const port = await freePort();
  BASE = 'http://127.0.0.1:' + port;
  server = spawn(process.execPath, ['src/index.js'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_PATH: path.join(TMP_DIR, 'pages.db'),
      PUBLIC_APP_URL: ORIGIN,
      RETENTION_PURGE_MODE: 'dryrun',
      LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 80; i++) {
    if (server.exitCode !== null) throw new Error('server exited early:\n' + log);
    try { if ((await fetch(BASE + '/health')).ok) break; } catch (_) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
    if (i === 79) throw new Error('server did not start:\n' + log);
  }
});

after(() => {
  if (server) server.kill('SIGKILL');
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}
});

const get = (p, headers = {}) => fetch(BASE + p, { headers, redirect: 'manual' });

// Every HTML route src/index.js serves, unprefixed and prefixed.
const HTML_ROUTES = [
  '/', '/index.html', '/login', '/signup', '/signup?t=not-a-real-token', '/dashboard',
  '/app.html', '/compliance.html', '/integrations.html', '/bias-report.html',
  '/demo-transcript', '/demo-transcript.html', '/terms.html', '/privacy.html',
  '/nl/', '/de/', '/nl/bias-report.html', '/de/bias-report.html', '/nl/integrations.html',
  '/de/integrations.html', '/nl/compliance.html', '/de/compliance.html', '/nl/demo-transcript',
  '/de/demo-transcript.html',
];
const LANGUAGE_HINTS = {
  'no hints': {},
  'lang cookie': { Cookie: 'lang=nl' },
  'Accept-Language': { 'Accept-Language': 'de-DE,de;q=0.9' },
  'both': { Cookie: 'lang=de', 'Accept-Language': 'nl' },
};

describe('no HTML response can be stored by a shared cache', () => {
  for (const route of HTML_ROUTES) {
    test(route, async () => {
      for (const [label, headers] of Object.entries(LANGUAGE_HINTS)) {
        const res = await get(route, headers);
        assert.equal(res.status, 200, `${route} (${label})`);
        assert.match(res.headers.get('content-type'), /^text\/html/);
        const cc = res.headers.get('cache-control') || '';
        assert.match(cc, /\bprivate\b/, `${route} (${label}) Cache-Control: ${cc}`);
        assert.match(cc, /\bno-store\b/, `${route} (${label}) Cache-Control: ${cc}`);
        const vary = (res.headers.get('vary') || '').toLowerCase();
        assert.ok(vary.includes('cookie') && vary.includes('accept-language'), `${route} (${label}) Vary: ${vary}`);
        assert.match(res.headers.get('content-language') || '', /^(en|nl|de)$/);
        const body = await res.text();
        assert.doesNotMatch(body, /__CSP_NONCE__/, 'nonce placeholder must be substituted');
      }
    });
  }
});

describe('which language a page is answered in', () => {
  const langOf = async (p, headers) => {
    const res = await get(p, headers);
    const html = await res.text();
    return { header: res.headers.get('content-language'), attr: /<html lang="([a-z]+)"/.exec(html)[1], html };
  };

  test('negotiated pages follow the cookie, then Accept-Language, then English', async () => {
    assert.equal((await langOf('/', {})).attr, 'en');
    assert.equal((await langOf('/', { 'Accept-Language': 'nl-BE' })).attr, 'nl');
    assert.equal((await langOf('/login', { Cookie: 'lang=de', 'Accept-Language': 'nl' })).attr, 'de');
  });

  test('a /nl/ or /de/ URL always wins over cookie and Accept-Language', async () => {
    const r = await langOf('/de/', { Cookie: 'lang=nl', 'Accept-Language': 'nl' });
    assert.equal(r.attr, 'de');
    assert.equal(r.header, 'de');
    assert.match(r.html, /Screening, das zweimal dieselbe Antwort gibt\./);
  });

  test('Terms and Privacy are English whatever is asked for', async () => {
    for (const p of ['/terms.html', '/privacy.html']) {
      const r = await langOf(p, { Cookie: 'lang=de', 'Accept-Language': 'de' });
      assert.equal(r.attr, 'en');
      assert.equal(r.header, 'en');
    }
  });

  test('/nl and /de redirect to the canonical trailing-slash URL, keeping the query', async () => {
    const res = await get('/nl?utm_source=x');
    assert.equal(res.status, 301);
    assert.equal(new URL(res.headers.get('location'), BASE).pathname + new URL(res.headers.get('location'), BASE).search, '/nl/?utm_source=x');
  });

  test('the app has no language prefixes', async () => {
    assert.equal((await get('/nl/login')).status, 404);
    assert.equal((await get('/de/dashboard')).status, 404);
  });
});

describe('SEO: canonical and hreflang on every marketing variant', () => {
  const PAGES = [
    ['/', '/nl/', '/de/'],
    ['/bias-report.html', '/nl/bias-report.html', '/de/bias-report.html'],
    ['/integrations.html', '/nl/integrations.html', '/de/integrations.html'],
    ['/compliance.html', '/nl/compliance.html', '/de/compliance.html'],
    ['/demo-transcript', '/nl/demo-transcript', '/de/demo-transcript'],
  ];
  for (const [en, nl, de] of PAGES) {
    test(en, async () => {
      for (const [lang, p] of [['en', en], ['nl', nl], ['de', de]]) {
        const html = await (await get(p)).text();
        const canon = html.match(/<link rel="canonical" href="([^"]+)">/g) || [];
        assert.equal(canon.length, 1, `${p}: exactly one canonical`);
        assert.equal(/href="([^"]+)"/.exec(canon[0])[1], ORIGIN + p, `${p}: self-referencing canonical`);
        const alt = Object.fromEntries([...html.matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)">/g)].map((m) => [m[1], m[2]]));
        assert.deepEqual(alt, { en: ORIGIN + en, nl: ORIGIN + nl, de: ORIGIN + de, 'x-default': ORIGIN + en }, p);
        assert.match(html, new RegExp(`<html lang="${lang}"`));
      }
    });
  }

  test('an unprefixed URL served in Dutch names the Dutch variant as canonical', async () => {
    const html = await (await get('/bias-report.html', { Cookie: 'lang=nl' })).text();
    assert.match(html, new RegExp(`<link rel="canonical" href="${ORIGIN}/nl/bias-report.html">`));
  });

  test('the app and the legal pages carry no hreflang alternates', async () => {
    for (const p of ['/login', '/terms.html', '/privacy.html']) {
      assert.doesNotMatch(await (await get(p)).text(), /hreflang=/, p);
    }
  });
});

describe('/locales/{lang}.json', () => {
  test('serves each supported dictionary, complete', async () => {
    for (const lang of ['en', 'nl', 'de']) {
      const res = await get(`/locales/${lang}.json`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.lang, lang);
      assert.deepEqual(Object.keys(body.messages), EN_KEYS);
    }
  });

  test('nothing else is reachable through it', async () => {
    for (const p of ['/locales/fr.json', '/locales/EN.json', '/locales/..%2Fpackage.json', '/locales/GLOSSARY.md', '/locales/en.json.bak']) {
      assert.equal((await get(p)).status, 404, p);
    }
  });
});
