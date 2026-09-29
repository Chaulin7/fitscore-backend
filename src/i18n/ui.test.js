'use strict';

/**
 * src/i18n/ui.test.js — which language a request is answered in, and the
 * validation of a saved preference.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const ui = require('./ui');

const req = (headers = {}) => ({ headers });

describe('resolution order: URL prefix > cookie > Accept-Language > English', () => {
  test('nothing set: English', () => {
    assert.deepEqual(ui.resolveRequestLanguage(req()), { lang: 'en', source: 'default' });
  });

  test('Accept-Language alone', () => {
    assert.equal(ui.resolveRequestLanguage(req({ 'accept-language': 'nl-NL,nl;q=0.9,en;q=0.8' })).lang, 'nl');
  });

  test('the cookie beats Accept-Language', () => {
    const r = ui.resolveRequestLanguage(req({ cookie: 'x=1; lang=de; y=2', 'accept-language': 'nl' }));
    assert.deepEqual(r, { lang: 'de', source: 'cookie' });
  });

  test('a URL prefix beats the cookie', () => {
    const r = ui.resolveRequestLanguage(req({ cookie: 'lang=de', 'accept-language': 'de' }), { fixed: 'nl' });
    assert.deepEqual(r, { lang: 'nl', source: 'url' });
  });

  test('an unsupported or malformed cookie is ignored, not trusted', () => {
    for (const cookie of ['lang=fr', 'lang=', 'lang=nl%3Cscript', 'lang=../../etc', 'lang=%E0%A4%A']) {
      assert.equal(ui.resolveRequestLanguage(req({ cookie, 'accept-language': 'de' })).lang, 'de', cookie);
    }
  });
});

describe('Accept-Language parsing', () => {
  const cases = [
    ['de-CH', 'de'],
    ['nl-BE', 'nl'],
    ['en-US,en;q=0.9', 'en'],
    ['fr-FR,fr;q=0.9,de;q=0.8,nl;q=0.7', 'de'],
    ['fr, nl;q=0.5, de;q=0.6', 'de'],
    ['de;q=0, nl;q=0.1', 'nl'],
    ['*', null],
    ['fr, es', null],
    ['', null],
    ['nl;q=abc, de', 'de'],
  ];
  for (const [header, expected] of cases) {
    test(JSON.stringify(header) + ' -> ' + expected, () => {
      assert.equal(ui.langFromAcceptLanguage(header), expected);
    });
  }
});

describe('preferred_language validation', () => {
  test("accepts exactly 'en' | 'nl' | 'de' | null", () => {
    for (const v of ['en', 'nl', 'de']) assert.deepEqual(ui.validatePreferredLanguage(v), { ok: true, value: v });
    assert.deepEqual(ui.validatePreferredLanguage(null), { ok: true, value: null });
  });
  test('rejects everything else', () => {
    for (const v of ['fr', 'EN', 'nl-NL', '', ' nl', undefined, 0, true, {}, ['nl']]) {
      assert.equal(ui.validatePreferredLanguage(v).ok, false, JSON.stringify(v));
    }
  });
});

describe('dictionaries', () => {
  test('every language serves every English key (fallback fills gaps)', () => {
    const en = Object.keys(ui.messagesFor('en'));
    for (const lang of ui.SUPPORTED) assert.deepEqual(Object.keys(ui.messagesFor(lang)), en, lang);
  });

  test('nl and de are complete: nothing falls back to English today', () => {
    assert.deepEqual(ui.fallbackFor('nl'), []);
    assert.deepEqual(ui.fallbackFor('de'), []);
  });

  test('namespace filtering keeps only the requested prefixes', () => {
    const m = ui.messagesForNamespaces('nl', ['auth']);
    assert.ok(Object.keys(m).length > 0);
    assert.ok(Object.keys(m).every((k) => k.startsWith('auth.')));
  });

  test('VERSION is a stable content hash', () => {
    assert.match(ui.VERSION, /^[0-9a-f]{10}$/);
  });
});
