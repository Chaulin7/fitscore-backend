'use strict';

/**
 * src/config/plansI18n.test.js — the tier table in three languages.
 *
 * plans.js stays the single source of truth: English is its copy, verbatim,
 * and a translation may change WORDS and the price FORMAT — never an amount,
 * a plan id, a limit or a capability, which are what the server gates on and
 * Stripe charges.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { marketingView, localizedMarketingView, PLANS, BASELINE_IDS, HIGHLIGHT_IDS } = require('./plans');
const ui = require('../i18n/ui');
const plansRouter = require('../routes/plans');

const translatorFor = (lang) => (key, vars) => (ui.hasKey(key) ? ui.t(lang, key, vars) : null);

describe('English through the dictionary is plans.js exactly', () => {
  test('en.json reproduces marketingView(), price labels included', () => {
    const viaDictionary = localizedMarketingView('en', translatorFor('en'), plansRouter.priceFormatter('en'));
    assert.deepEqual(viaDictionary, { ...marketingView(), lang: 'en' });
  });

  test('every baseline entry and highlight has a translation id', () => {
    assert.equal(BASELINE_IDS.length, PLANS.baseline.length);
    for (const t of PLANS.tiers) assert.equal((HIGHLIGHT_IDS[t.id] || []).length, t.highlights.length, t.id);
  });
});

describe('nl and de translate the copy and nothing else', () => {
  for (const lang of ['nl', 'de']) {
    test(lang, () => {
      const en = marketingView();
      const tr = localizedMarketingView(lang, translatorFor(lang), plansRouter.priceFormatter(lang));
      assert.equal(tr.tiers.length, en.tiers.length);
      tr.tiers.forEach((t, i) => {
        const e = en.tiers[i];
        for (const k of ['id', 'featured', 'limits', 'capabilities', 'upgradePlan']) assert.deepEqual(t[k], e[k], `${lang} ${e.id}.${k}`);
        assert.notEqual(t.tagline, e.tagline, `${lang} ${e.id} tagline untranslated`);
        assert.equal(t.highlights.length, e.highlights.length);
        assert.equal(Boolean(t.taxNote), Boolean(e.taxNote), 'VAT qualifier presence follows plans.js');
      });
      assert.equal(tr.baseline.length, en.baseline.length);
    });
  }

  test('prices are formatted for the locale, amounts unchanged', () => {
    // ICU builds differ on WHICH non-breaking space (U+00A0 / U+202F) they
    // use; the format is what is under test, so any space counts as one.
    const labels = (lang) => localizedMarketingView(lang, translatorFor(lang), plansRouter.priceFormatter(lang))
      .tiers.map((t) => t.priceLabel.replace(/[\u00a0\u202f ]/g, ' '));
    assert.deepEqual(labels('en'), ['€0', '€49', '€199']);
    assert.deepEqual(labels('nl'), ['€ 0', '€ 49', '€ 199']);
    assert.deepEqual(labels('de'), ['0 €', '49 €', '199 €']);
  });
});

describe('GET /api/plans?lang=', () => {
  let server; let base;
  before(async () => {
    const app = express();
    app.use('/api/plans', plansRouter);
    server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());

  test('no lang: the English table, exactly as before', async () => {
    const res = await fetch(base + '/api/plans');
    assert.deepEqual(await res.json(), marketingView());
    assert.equal(res.headers.get('cache-control'), 'public, max-age=300');
  });

  test('lang=nl / lang=de translate; an unsupported lang falls back to English', async () => {
    assert.equal((await (await fetch(base + '/api/plans?lang=nl')).json()).tiers[0].name, 'Gratis');
    assert.equal((await (await fetch(base + '/api/plans?lang=de')).json()).tiers[1].per, '/Monat');
    assert.deepEqual(await (await fetch(base + '/api/plans?lang=fr')).json(), marketingView());
  });

  test('the cookie never changes this publicly cacheable response', async () => {
    const res = await fetch(base + '/api/plans', { headers: { Cookie: 'lang=de', 'Accept-Language': 'de' } });
    assert.deepEqual(await res.json(), marketingView());
  });
});
