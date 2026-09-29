'use strict';

/**
 * GET /api/plans — the public tier table.
 *
 * Serves the marketing-safe view of src/config/plans.js so the pricing page and
 * the in-product Settings render from the same definitions the server gates on.
 * This replaced public/plans.js, a browser-only copy that the server could not
 * read — which is how the tier copy and the enforced behaviour drifted apart in
 * the first place.
 *
 * No auth: it is the pricing page, visible to logged-out visitors. Cacheable
 * for a short window — the content only changes on deploy, and a stale copy is
 * cosmetic (every gate is enforced server-side, never from this payload).
 */

const express = require('express');
const { marketingView, localizedMarketingView, CURRENCY } = require('../config/plans');
const ui = require('../i18n/ui');

const router = express.Router();

/** €49 / € 49 / 49 € — the locale's currency format, whole euros. */
function priceFormatter(lang) {
  return (amount) => ui.core.formatNumber(lang, amount, {
    style: 'currency', currency: CURRENCY.code, minimumFractionDigits: 0, maximumFractionDigits: 0,
  });
}

// Computed once at module load: the table is static per deploy. English is
// marketingView() exactly, as it always was; nl/de translate the copy and the
// price FORMAT, never an amount, a plan id or a capability flag.
const PAYLOADS = Object.freeze(Object.fromEntries(ui.SUPPORTED.map((lang) => [
  lang,
  lang === ui.DEFAULT_LANG
    ? marketingView()
    : localizedMarketingView(lang, (key, vars) => (ui.hasKey(key) ? ui.t(lang, key, vars) : null), priceFormatter(lang)),
])));

// ?lang=nl|de selects the copy. Only the query string, never the cookie: this
// response is publicly cacheable, and the URL is its whole cache key.
router.get('/', (req, res) => {
  const lang = ui.normalizeLang(req.query && req.query.lang) || ui.DEFAULT_LANG;
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.json(PAYLOADS[lang]);
});

router.priceFormatter = priceFormatter;

module.exports = router;
