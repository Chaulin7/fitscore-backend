'use strict';

/**
 * src/config/impressum.test.js — the Imprint / Colofon / Impressum page
 * (§ 5 DDG, art. 3:15d BW).
 *
 * It must state exactly the registered facts, identically in every language,
 * and nothing it was not asked to state. Both halves matter: a wrong KvK
 * number looks as correct as the right one, and an added "liability
 * disclaimer" or ODR link is a legal statement nobody decided to make (the EU
 * ODR platform closed in July 2025, so a link to it is simply dead).
 */

const fs = require('node:fs');
const path = require('node:path');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { buildVariants, variantPath } = require('../i18n/pages');
const { decodeEntities } = require('../i18n/prerender');
const ui = require('../i18n/ui');
const { LEGAL_NAME, KVK, BTW_ID, FOOTER_LINE, CONTACT_EMAIL } = require('./legal');

const raw = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'impressum.html'), 'utf8');
// The startup substitution src/index.js performs.
const html = raw
  .replaceAll('__LEGAL_FOOTER__', FOOTER_LINE)
  .replaceAll('__LEGAL_NAME__', LEGAL_NAME)
  .replaceAll('__CONTACT_EMAIL__', CONTACT_EMAIL)
  .replaceAll('__LEGAL_KVK__', KVK)
  .replaceAll('__LEGAL_BTW__', BTW_ID);
const { variants, problems } = buildVariants({ 'impressum.html': html });

// Exactly the supplied values, in page order. `null` is the contact-form row,
// whose value is a link (checked separately). An object is a value worded per
// language; everything else reads the same in every language.
const FACTS = [
  ['imprint.label.company', `${LEGAL_NAME} (besloten vennootschap / private limited company)`],
  ['imprint.label.tradeName', 'CVsprings'],
  ['imprint.label.address', 'Leidsegracht 34, 1016 CM Amsterdam, Netherlands'],
  ['imprint.label.seat', 'Amsterdam'],
  ['imprint.label.representedBy', 'Jasper Joy, director (bestuurder / Geschäftsführer)'],
  ['imprint.label.email', 'jasper@cvsprings.com'],
  ['imprint.label.contactForm', null],
  ['imprint.label.kvk', { en: '42135911', nl: '42135911', de: 'Kamer van Koophandel (KvK), Niederlande, Nr. 42135911' }],
  ['imprint.label.vat', 'NL005523705B04'],
  ['imprint.label.responsible', 'Jasper Joy'],
];
const HEADINGS = { en: 'Imprint', nl: 'Colofon', de: 'Impressum' };

const text = (s) => decodeEntities(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
const rows = (page) => {
  const dl = /<dl class="imprint">([\s\S]*?)<\/dl>/.exec(page)[1];
  return [...dl.matchAll(/<dt\b[^>]*>([\s\S]*?)<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/g)].map((m) => ({ dt: text(m[1]), ddHtml: m[2], dd: text(m[2]) }));
};
const body = (page) => /<div class="page">([\s\S]*?)<footer/.exec(page)[1];

test('the page builds in every language with no i18n problems', () => {
  assert.deepEqual(problems, []);
  assert.deepEqual(Object.keys(variants['impressum.html']).sort(), ['de', 'en', 'nl']);
});

for (const lang of ['en', 'nl', 'de']) {
  describe(`[${lang}]`, () => {
    const page = variants['impressum.html'][lang];
    const messages = ui.messagesFor(lang);

    test(`is headed "${HEADINGS[lang]}"`, () => {
      assert.match(page, new RegExp(`<h1 data-i18n="imprint.title">${HEADINGS[lang]}</h1>`));
      assert.equal(messages['imprint.title'], HEADINGS[lang]);
    });

    test('states exactly the registered facts, with translated labels', () => {
      const found = rows(page);
      assert.equal(found.length, FACTS.length, found.map((r) => r.dt).join(' | '));
      FACTS.forEach(([labelKey, value], i) => {
        assert.equal(found[i].dt, messages[labelKey], `row ${i + 1} label`);
        const expected = value && typeof value === 'object' ? value[lang] : value;
        if (expected !== null) assert.equal(found[i].dd, expected, `row ${i + 1} (${found[i].dt}) value`);
      });
    });

    test('the email is a mailto link and the contact form row links the same-language form', () => {
      const row = (key) => rows(page).find((r) => r.dt === messages[key]);
      assert.match(row('imprint.label.email').ddHtml, /^<a href="mailto:jasper@cvsprings\.com">jasper@cvsprings\.com<\/a>$/);
      assert.match(row('imprint.label.contactForm').ddHtml, new RegExp(`<a href="${variantPath('contact.html', lang)}"`));
      assert.equal(row('imprint.label.contactForm').dd, messages['imprint.contactFormLink']);
    });

    test('the statutory seat and the register line read as specified', () => {
      const line = (key) => { const r = rows(page).find((x) => x.dt === messages[key]); return `${r.dt}: ${r.dd}`; };
      assert.equal(line('imprint.label.seat'), {
        en: 'Statutory seat: Amsterdam', nl: 'Statutaire zetel: Amsterdam', de: 'Satzungsmäßiger Sitz: Amsterdam',
      }[lang]);
      assert.equal(line('imprint.label.kvk'), {
        en: 'Dutch Chamber of Commerce (KvK): 42135911',
        nl: 'Kamer van Koophandel (KvK): 42135911',
        de: 'Handelsregister: Kamer van Koophandel (KvK), Niederlande, Nr. 42135911',
      }[lang]);
    });

    test('says nothing it was not asked to say', () => {
      const b = body(page);
      assert.doesNotMatch(b, /tel:|\+\d{2}[\s\d]{6,}|\b(phone|telefoon|telefon)\b/i, 'no phone number');
      assert.doesNotMatch(b, /\bODR\b|ec\.europa\.eu|online dispute|streitbeilegung|geschillen/i, 'no ODR link or dispute-resolution statement');
      assert.doesNotMatch(b, /liabilit|haftung|aansprakelijk|copyright|©|urheber|auteursrecht|disclaimer/i, 'no liability or copyright statement');
    });
  });
}

test('the legal name, registry numbers and email come from src/config/legal.js, not the page', () => {
  for (const p of ['__LEGAL_NAME__', '__LEGAL_KVK__', '__LEGAL_BTW__', '__CONTACT_EMAIL__']) assert.ok(raw.includes(p), p);
  for (const v of [LEGAL_NAME, KVK, BTW_ID, CONTACT_EMAIL]) assert.ok(!raw.includes(v), `public/impressum.html hardcodes ${v}`);
});
