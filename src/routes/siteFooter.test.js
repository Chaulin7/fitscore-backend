'use strict';

/**
 * src/routes/siteFooter.test.js — the footer every served page carries.
 *
 * 1. One tagline, everywhere: the landing page's "Deterministic CV screening ·
 * Made in the Netherlands", translated through the one common.footerTagline
 * key. The pages used to disagree (the doc pages and the app said
 * "deterministic, rules-based CV screening"), and nothing noticed, because each
 * page is its own file with its own copy of the footer.
 *
 * 2. Every footer link goes somewhere. The landing footer shipped three
 * href="#" links (Privacy, DPA, Imprint) that looked live and did nothing.
 *
 * 3. The Imprint and the contact page are one click from every page —
 * including the app, whose sign-in screen covers the dashboard footer.
 *
 * The page list is read from HTML_PAGES in src/index.js rather than repeated
 * here, so a page added to the served set is checked without anyone having to
 * remember this file.
 */

const fs = require('node:fs');
const path = require('node:path');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { buildVariants, PAGE_CONFIG } = require('../i18n/pages');
const { decodeEntities, mask } = require('../i18n/prerender');
const { CONTACT_EMAIL } = require('../config/legal');
const ui = require('../i18n/ui');

const ROOT = path.join(__dirname, '..', '..');
const read = (page) => fs.readFileSync(path.join(ROOT, 'public', page), 'utf8');

const SERVED_PAGES = (() => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'index.js'), 'utf8');
  const m = /const HTML_PAGES = \[([^\]]+)\]/.exec(src);
  return [...m[1].matchAll(/'([^']+\.html)'/g)].map((x) => x[1]);
})();

// Scripts and comments are masked first: a commented-out link is not a link.
const footerBlocks = (html) => mask(html).masked.match(/<footer\b[\s\S]*?<\/footer>/gi) || [];
const isEnglishOnly = (page) => PAGE_CONFIG[page] && PAGE_CONFIG[page].kind === 'english-only';
const TAGLINE_EN = ui.messagesFor('en')['common.footerTagline'];

test('the served page list is the one src/index.js serves (guards a vacuous pass)', () => {
  assert.ok(SERVED_PAGES.length >= 8, SERVED_PAGES.join(', '));
  for (const page of ['index.html', 'app.html', 'terms.html', 'privacy.html']) assert.ok(SERVED_PAGES.includes(page), page);
});

describe('one footer tagline on every page', () => {
  test('it is the landing page\'s line', () => {
    assert.equal(TAGLINE_EN, 'Deterministic CV screening · Made in the Netherlands');
  });

  for (const page of SERVED_PAGES) {
    test(page, () => {
      const footers = footerBlocks(read(page));
      assert.ok(footers.length > 0, `${page} has no <footer>`);
      const all = footers.join('\n');
      if (isEnglishOnly(page)) {
        // Terms and Privacy carry no i18n markup at all (i18n:check enforces
        // that), so the English line is written out.
        assert.ok(decodeEntities(all).includes(TAGLINE_EN), `${page}: footer does not say "${TAGLINE_EN}"`);
      } else {
        assert.match(all, /data-i18n="common\.footerTagline"/, `${page}: footer tagline is not the common.footerTagline key`);
      }
      assert.doesNotMatch(all, /rules-based CV screening/i, `${page}: the retired footer line is back`);
    });
  }

  test('nl and de variants say it in their own language', () => {
    const templates = Object.fromEntries(Object.keys(PAGE_CONFIG).map((p) => [p, read(p)]));
    const { variants } = buildVariants(templates);
    for (const [page, byLang] of Object.entries(variants)) {
      if (isEnglishOnly(page)) continue;
      for (const lang of ['nl', 'de']) {
        const expected = ui.core.escapeHtml(ui.messagesFor(lang)['common.footerTagline']);
        assert.notEqual(expected, ui.core.escapeHtml(TAGLINE_EN), `${lang} has no translation of the tagline`);
        assert.ok(footerBlocks(byLang[lang]).join('\n').includes(expected), `${page} [${lang}]`);
      }
    }
  });
});

// --- links -----------------------------------------------------------------------

const hrefOf = (tag) => {
  const m = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3]) : null;
};
const footerAnchors = (html) => footerBlocks(html).flatMap((b) => b.match(/<a\b[^>]*>/gi) || []);

/** Footer links that go nowhere: no href, an empty one, "#", or javascript:. */
function deadLinks(html) {
  return footerAnchors(html).filter((tag) => {
    const href = hrefOf(tag);
    return href === null || /^\s*(#\s*)?$/.test(href) || /^\s*javascript:/i.test(href);
  });
}

const allVariants = (() => {
  const templates = Object.fromEntries(Object.keys(PAGE_CONFIG).map((p) => [p, read(p)]));
  return buildVariants(templates).variants;
})();

describe('every footer link goes somewhere', () => {
  test('the scanner catches each kind of dead link (guards a vacuous pass)', () => {
    const planted = '<footer><a href="#">a</a> <a href="">b</a> <a>c</a> <a href=" # ">d</a> '
      + '<a href="javascript:void(0)">e</a> <a href="/ok">f</a> <!-- <a href="#">commented</a> --></footer>'
      + '<a href="#">outside any footer</a>';
    assert.equal(deadLinks(planted).length, 5, deadLinks(planted).join(' '));
  });

  for (const page of SERVED_PAGES) {
    test(`${page}: no footer link is href="#", empty or missing`, () => {
      const html = read(page);
      assert.ok(footerAnchors(html).length > 0, `${page}: its footer has no links at all`);
      assert.deepEqual(deadLinks(html), []);
    });
  }

  test('the same holds for every rendered nl and de variant', () => {
    for (const [page, byLang] of Object.entries(allVariants)) {
      for (const [lang, html] of Object.entries(byLang)) assert.deepEqual(deadLinks(html), [], `${page} [${lang}]`);
    }
  });
});

describe('the Imprint and the contact page are one click from every page', () => {
  for (const page of SERVED_PAGES) {
    test(page, () => {
      const hrefs = footerAnchors(read(page)).map(hrefOf);
      assert.ok(hrefs.includes('/impressum'), `${page}: no footer link to /impressum`);
      assert.ok(hrefs.includes('/contact'), `${page}: no footer link to /contact`);
      if (page !== 'privacy.html') assert.ok(hrefs.includes('/privacy.html'), `${page}: no footer link to the Privacy Policy`);
    });
  }

  test('the app carries them on the dashboard footer AND on the sign-in screen that covers it', () => {
    const blocks = footerBlocks(read('app.html'));
    const dashboard = blocks.find((b) => /^<footer class="site-footer">/.test(b));
    const signIn = blocks.find((b) => /^<footer class="auth-legal">/.test(b));
    assert.ok(dashboard && signIn, 'expected both footers in app.html');
    assert.ok(/<div id="authScreen"[\s\S]*<footer class="auth-legal">/.test(mask(read('app.html')).masked), 'the sign-in links sit inside #authScreen');
    for (const [where, block] of [['dashboard', dashboard], ['sign-in screen', signIn]]) {
      const hrefs = (block.match(/<a\b[^>]*>/gi) || []).map(hrefOf);
      for (const want of ['/impressum', '/contact', '/privacy.html']) assert.ok(hrefs.includes(want), `${where}: ${want}`);
    }
  });

  test('on /nl/ and /de/ pages they lead to the same-language Imprint and contact page', () => {
    for (const [page, byLang] of Object.entries(allVariants)) {
      if (PAGE_CONFIG[page].kind !== 'marketing') continue;
      for (const lang of ['nl', 'de']) {
        const hrefs = footerAnchors(byLang[lang]).map(hrefOf);
        assert.ok(hrefs.includes(`/${lang}/impressum`), `${page} [${lang}]: ${hrefs.join(' ')}`);
        assert.ok(hrefs.includes(`/${lang}/contact`), `${page} [${lang}]: ${hrefs.join(' ')}`);
      }
    }
  });

  test('the link labels are translated', () => {
    const labels = (lang) => [ui.t(lang, 'common.footer.imprint'), ui.t(lang, 'common.footer.contact')];
    assert.deepEqual(labels('en'), ['Imprint / Impressum', 'Contact']);
    assert.deepEqual(labels('nl'), ['Colofon / Impressum', 'Contact']);
    assert.deepEqual(labels('de'), ['Impressum', 'Kontakt']);
  });
});

describe('the DPA link on the landing page', () => {
  // No DPA document is published: docs/privacy/dpa-template.md is an unsigned
  // draft. So the footer offers one on request instead of a dead link.
  test('asks for the DPA by email rather than linking a document that does not exist', () => {
    const tag = footerAnchors(read('index.html')).find((a) => /data-i18n="landing\.footer\.dpa"/.test(a));
    assert.ok(tag, 'the landing footer has a DPA link');
    assert.equal(hrefOf(tag), 'mailto:__CONTACT_EMAIL__?subject=DPA%20request');
    assert.equal(hrefOf(tag).replace('__CONTACT_EMAIL__', CONTACT_EMAIL), 'mailto:jasper@cvsprings.com?subject=DPA%20request');
  });

  test('its label says so, in every language', () => {
    assert.equal(ui.t('en', 'landing.footer.dpa'), 'DPA available on request');
    assert.equal(ui.t('nl', 'landing.footer.dpa'), 'Verwerkersovereenkomst op aanvraag');
    assert.equal(ui.t('de', 'landing.footer.dpa'), 'Auftragsverarbeitungsvertrag auf Anfrage');
  });
});
