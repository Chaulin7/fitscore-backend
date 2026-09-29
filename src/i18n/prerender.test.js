'use strict';

/**
 * src/i18n/prerender.test.js — the server-side translation pass over the
 * pages, run against the real pages and dictionaries.
 */

const fs = require('node:fs');
const path = require('node:path');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { scan, markupToTemplate, localizeMarkup, rewriteLinks, decodeEntities } = require('./prerender');
const { buildVariants, PAGE_CONFIG, routesFor } = require('./pages');
const ui = require('./ui');
const core = require('../../public/i18n.js');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const read = (p) => fs.readFileSync(path.join(PUBLIC_DIR, p), 'utf8');
const TRANSLATED = Object.keys(PAGE_CONFIG).filter((p) => PAGE_CONFIG[p].kind !== 'english-only');
const EN = ui.messagesFor('en');

describe('the English left in the markup is what en.json says', () => {
  // So a translator reading the page reads the real source string, and the
  // existing tests that assert on page text are asserting on the shipped copy.
  for (const page of TRANSLATED) {
    test(page, () => {
      const html = read(page);
      const items = scan(html);
      assert.ok(items.length > 0, `${page} has no translatable elements`);
      for (const item of items) {
        if (item.kind === 'attr') {
          const tag = new RegExp(`<${item.tag}\\b[^>]*data-i18n-attr="[^"]*\\b${item.attr}:${item.key.replace(/\./g, '\\.')}\\b[^"]*"[^>]*>`).exec(html);
          const value = tag && new RegExp(`\\s${item.attr}="([^"]*)"`).exec(tag[0]);
          if (!value) continue; // an attribute the pre-render adds, e.g. aria-label beside a placeholder
          assert.equal(core.interpolate(EN[item.key], item.vars, 'en'), decodeEntities(value[1]).trim(), `${page}: ${item.attr} of ${item.key}`);
        } else {
          assert.equal(core.interpolate(EN[item.key], item.vars, 'en'), markupToTemplate(item.inner, item.kind), `${page}: ${item.key}`);
        }
      }
    });
  }
});

describe('pre-rendered variants', () => {
  const templates = Object.fromEntries(Object.keys(PAGE_CONFIG).map((p) => [p, read(p)]));
  const { variants, problems } = buildVariants(templates);

  test('the real pages build with no problems (every key known, every element well-formed)', () => {
    assert.deepEqual(problems, []);
  });

  for (const page of TRANSLATED) {
    for (const lang of ui.SUPPORTED) {
      test(`${page} [${lang}]: lang attribute, one dictionary block, no leftover placeholders`, () => {
        const html = variants[page][lang];
        assert.match(html, new RegExp(`<html lang="${lang}"`));
        const dicts = html.match(/<script type="application\/json" id="i18n-dict"[^>]*>([\s\S]*?)<\/script>/g) || [];
        assert.equal(dicts.length, 1);
        const payload = JSON.parse(/>([\s\S]*?)<\/script>$/.exec(dicts[0])[1]);
        assert.equal(payload.lang, lang);
        assert.doesNotMatch(html, /__(I18N_HEAD|LANG_SWITCHER\w*|I18N_ENGLISH_ONLY)__/);
        assert.match(html, /<script src="\/i18n\.js\?v=[0-9a-f]+" nonce="__CSP_NONCE__"><\/script>/);
        assert.match(html, /data-lang-switch/);
      });
    }
  }

  test('every translated element carries its translation in nl and de', () => {
    for (const page of TRANSLATED) {
      for (const lang of ['nl', 'de']) {
        const messages = ui.messagesFor(lang);
        for (const item of scan(variants[page][lang])) {
          if (item.kind !== 'text') continue;
          const expected = core.escapeHtml(core.interpolate(messages[item.key], item.vars, lang));
          assert.equal(item.inner, expected, `${page} [${lang}] ${item.key}`);
        }
      }
    }
  });

  test('the legal pages are served exactly as written, English only', () => {
    for (const page of ['terms.html', 'privacy.html']) {
      assert.deepEqual(Object.keys(variants[page]), ['en']);
      assert.equal(variants[page].en, templates[page]);
      assert.match(templates[page], /TODO\(i18n-legal\)/);
    }
  });

  test('compliance.html: the shell is translated, the regulatory body is marked English', () => {
    const nl = variants['compliance.html'].nl;
    assert.match(nl, /<div class="i18n-english-only" role="note" lang="nl">Deze pagina is op dit moment alleen in het Engels beschikbaar\.<\/div>/);
    assert.match(nl, /<div class="hero" lang="en">/);
    assert.match(nl, /How CVsprings approaches the EU AI Act/, 'the body must stay in English');
    assert.match(nl, /data-action="copyNotice" data-target="noticeEn" data-i18n="compliance.copy">Kopiëren</);
    assert.doesNotMatch(variants['compliance.html'].en, /i18n-english-only/);
  });

  test('the provenance/legal footer survives in every language', () => {
    for (const page of TRANSLATED) {
      for (const lang of ui.SUPPORTED) {
        assert.match(variants[page][lang], /<footer[\s\S]*__LEGAL_FOOTER__[\s\S]*<\/footer>/, `${page} [${lang}]`);
      }
    }
  });

  test('the switcher on a marketing page links to the variants; in the app it is buttons', () => {
    const idx = variants['index.html'].de;
    assert.match(idx, /<a class="lang-item" role="menuitemradio" aria-checked="true" lang="de"[^>]*href="\/de\/" hreflang="de">/);
    assert.match(idx, /aria-label="Sprache: Deutsch"/);
    const app = variants['app.html'].nl;
    assert.match(app, /<button type="button" class="lang-item" role="menuitemradio" aria-checked="true" lang="nl"/);
    const switchers = app.match(/<div class="lang-switch lang-switch--(\w+)" data-lang-switch>/g) || [];
    assert.deepEqual(switchers.map((m) => /--(\w+)/.exec(m)[1]), ['auth', 'drawer', 'dark'], 'sign-in screen, mobile drawer and top bar');
  });
});

describe('XSS in the server-side pass', () => {
  test('a hostile translation value is escaped, not rendered', () => {
    const html = '<p data-i18n="x.y">placeholder</p><input data-i18n-attr="placeholder:x.y">';
    const out = localizeMarkup(html, { lang: 'en', lookup: () => '"><script>alert(1)</script>' });
    assert.doesNotMatch(out, /<script>/);
    assert.match(out, /<p data-i18n="x.y">&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/p>/);
    assert.match(out, /placeholder="&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;"/);
  });

  test('hostile data-i18n-vars are escaped in text, attributes and rich text', () => {
    const vars = JSON.stringify({ n: '<img src=x onerror=alert(1)>' }).replace(/"/g, '&quot;');
    const html = `<p data-i18n="a.b" data-i18n-vars="${vars}">x</p>`
      + `<b data-i18n-html="c_html" data-i18n-vars="${vars}">x <a href="/ok">y</a></b>`;
    const lookup = (k) => (k === 'a.b' ? 'Hi {n}' : '<strong>{n}</strong> <a0>go</a0>');
    const out = localizeMarkup(html, { lang: 'en', lookup });
    // The vars attribute itself is the page author's quoted markup; what matters
    // is the rendered CONTENT, so look at the output with those attributes removed.
    assert.doesNotMatch(out.replace(/\sdata-i18n-vars="[^"]*"/g, ''), /<img/);
    assert.match(out, /Hi &lt;img src=x onerror=alert\(1\)&gt;/);
    assert.match(out, /<strong>&lt;img src=x onerror=alert\(1\)&gt;<\/strong> <a href="\/ok">go<\/a>/);
  });

  test('the dictionary block cannot be closed from inside a message', () => {
    const templates = { 'index.html': read('index.html') };
    // Every embedded message is JSON with '<' escaped; prove it on the real payload.
    const { variants } = buildVariants(templates);
    const block = /<script type="application\/json" id="i18n-dict"[^>]*>([\s\S]*?)<\/script>/.exec(variants['index.html'].en)[1];
    assert.doesNotMatch(block, /</);
  });

  test('unknown keys leave the markup untouched and are reported', () => {
    const problems = [];
    const out = localizeMarkup('<p data-i18n="nope">English</p>', { lang: 'nl', lookup: () => null, onProblem: (p) => problems.push(p) });
    assert.equal(out, '<p data-i18n="nope">English</p>');
    assert.deepEqual(problems, ['unknown key nope']);
  });

  test('prose that quotes the attributes is never rewritten', () => {
    const html = '<!-- <p data-i18n="x">c</p> --><script>var s=\'<p data-i18n="x">c</p>\';</script>';
    assert.equal(localizeMarkup(html, { lang: 'en', lookup: () => 'CHANGED' }), html);
  });
});

describe('same-language navigation on the /nl/ and /de/ variants', () => {
  test('marketing links move to the variant; app, legal and asset links do not', () => {
    const html = '<a href="/">h</a><a href="/#recording">r</a><a href="/bias-report.html">b</a>'
      + '<a href="/demo-transcript.html">t</a><a href="/login">l</a><a href="/terms.html">t</a><a href="/eu-ai-act-checklist.pdf">p</a>';
    const out = rewriteLinks(html, routesFor('nl'));
    assert.equal(out, '<a href="/nl/">h</a><a href="/nl/#recording">r</a><a href="/nl/bias-report.html">b</a>'
      + '<a href="/nl/demo-transcript">t</a><a href="/login">l</a><a href="/terms.html">t</a><a href="/eu-ai-act-checklist.pdf">p</a>');
  });
});
