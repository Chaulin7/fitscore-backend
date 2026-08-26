'use strict';

/**
 * src/config/plans.js — SINGLE SOURCE OF TRUTH for CVsprings plan tiers.
 *
 * Canonical and server-side. The pricing page and the in-product Settings both
 * read it over GET /api/plans (see src/routes/plans.js), so tier name, price,
 * feature copy and capability flags are defined exactly once. This file
 * replaced public/plans.js, which was browser-only and therefore unreadable by
 * the code that actually enforces the tiers.
 *
 * LIMITS below are what the backend actually ENFORCES today:
 *   - monthly analysis quota — Free = 25/month (FREE_MONTHLY_LIMIT), Pro/Team
 *     unlimited (src/services/billing.js)
 *   - seats — Team = multi-user, Free/Pro = single user (same file)
 *   - customBranding — whether the report header may carry the org's own mark
 *     instead of the CVsprings brandmark (src/services/branding.js)
 *
 * That third axis is why `capabilities` exists. Report branding used to be
 * gated by calling isUnlimited(), a quota predicate borrowed for a question it
 * does not answer — which meant branding entitlement could never diverge from
 * quota entitlement even where the product wanted it to. The flag below is now
 * the ONLY expression of that gate: nothing downstream compares tier names.
 *
 * `baseline` = features available on EVERY plan (NOT plan-gated in code). They
 * are listed once here rather than duplicated per tier. Note that branded PDF
 * reports are baseline — every report at every tier carries a mark and a
 * provenance footer. The paid differentiator is WHOSE brand, never whether
 * there is one.
 *
 * FOLLOW-UP (separate backend ticket): 'Audit log, change history & CSV export'
 * and 'Bias monitoring report' are slated to become paid-only (the compliance
 * differentiator). When that server-side gating lands, MOVE those two out of
 * `baseline` and into the Pro/Team tiers' highlights here.
 */

const WHITE_LABEL_HIGHLIGHT =
  'White-label reports — replace the CVsprings mark with your own logo';

/**
 * The Free tier's monthly analysis cap.
 *
 * Read from the environment HERE rather than in services/billing.js, which used
 * to own it, so the number this file publishes as a tier limit and the number
 * the quota check enforces cannot be two different numbers. billing.js now
 * imports it and re-exports it, so every existing caller is unaffected.
 */
const FREE_MONTHLY_LIMIT = Number.parseInt(process.env.FREE_MONTHLY_LIMIT, 10) > 0
  ? Number.parseInt(process.env.FREE_MONTHLY_LIMIT, 10)
  : 25;

/**
 * The ENFORCED entitlement axes, and the only vocabulary used to describe them.
 *
 * `highlights` below is marketing prose. It is the right thing to *show* a
 * customer and the wrong thing to *compute* with: rewording one string, or
 * reordering a list, would silently change any answer derived by comparing
 * those strings between tiers. The upgrade surface asks exactly such a question
 * — "what does Team give me that Pro does not?" — so it is computed from the
 * three axes the server actually gates on (see entitlementAxesFor in
 * services/billing.js) and only *phrased* from here.
 *
 * PHRASE is the single set of strings. `highlights` is built from it and
 * phraseForAxis() reads from it, so a wording change moves both together and
 * moves neither out of step with the gate. What a tier grants is decided by the
 * axis VALUES; what we call it is decided here.
 */
const PHRASE = Object.freeze({
  analysesCapped: (n) => `${n} CV analyses / month`,
  analysesUnlimited: 'Unlimited CV analyses',
  seatsSingle: 'Single user',
  seatsMulti: 'Multiple team members',
  whiteLabel: WHITE_LABEL_HIGHLIGHT,
});

// Order is the order a gains list reads in: volume, then people, then branding.
const ENTITLEMENT_AXES = Object.freeze(['analysesPerMonth', 'seats', 'customBranding']);

/**
 * How to say what an axis value grants. Derived from the VALUE, never matched
 * against a highlight string — that is the coupling this exists to avoid.
 * Returns null where the value grants nothing worth naming (e.g. branding off).
 * @param {string} axis one of ENTITLEMENT_AXES
 * @param {number|null|boolean} value the enforced value on the tier in question
 */
function phraseForAxis(axis, value) {
  if (axis === 'analysesPerMonth') {
    return value == null ? PHRASE.analysesUnlimited : PHRASE.analysesCapped(value);
  }
  if (axis === 'seats') return value === 1 ? PHRASE.seatsSingle : PHRASE.seatsMulti;
  if (axis === 'customBranding') return value ? PHRASE.whiteLabel : null;
  return null;
}

// Money is stored ONCE per tier, as a number (`priceAmount`), and the display
// string is derived from it. Before, `priceLabel: '€49'` was the only record of
// the price, which was fine while the only consumer was a card that prints it —
// but the search-engine structured data on the pricing page needs a numeric
// amount and an ISO currency code, and re-deriving those by parsing '€49' would
// have made a second, quietly divergent source of the price. CURRENCY carries
// both forms of the currency for the same reason.
const CURRENCY = { symbol: '€', code: 'EUR' };
const priceLabelFor = (amount) => `${CURRENCY.symbol}${amount}`;

/**
 * Whether the amounts above are the total a customer pays.
 *
 * They are NOT: the Stripe Prices behind STRIPE_PRICE_PRO / STRIPE_PRICE_TEAM
 * are `tax_behavior: 'exclusive'`, so Stripe Tax adds VAT on top at checkout — a
 * Dutch customer is charged 49 x 1.21 = 59.29. Advertising a bare "€49" as the
 * price is therefore a claim that is not true for most buyers.
 *
 * ONE constant drives both expressions of that fact: the human qualifier next to
 * every rendered price, and `valueAddedTaxIncluded` in the structured data a
 * crawler reads. If the Stripe Prices are ever recreated as 'inclusive' (the
 * field is immutable, so that means new Price objects and new env values), flip
 * `included` here and every price on the site follows.
 *
 * `note` is deliberately not rendered on the Free tier: VAT on €0 is €0, and a
 * qualifier there is noise, not accuracy.
 */
const TAX = Object.freeze({
  included: false,
  note: 'excl. VAT',
});

// The qualifier a tier should display, or null where it does not apply.
const taxNoteFor = (amount) => (TAX.included || !amount ? null : TAX.note);

const PLANS = {
  currency: CURRENCY.symbol,
  currencyCode: CURRENCY.code,

  // Included on all plans (not gated in code).
  baseline: [
    'Deterministic, explainable scoring engine',
    'Skill & eligibility extraction',
    'Single & batch CV upload',
    'Audit log, change history & CSV export',
    'Professional branded PDF assessment reports',
    'Bias monitoring report',
    'Role templates & presets',
  ],

  // Ordered low -> high; `highlights` are the ENFORCED per-tier differentiators.
  tiers: [
    {
      id: 'free', name: 'Free', priceAmount: 0, priceLabel: priceLabelFor(0), per: '/month',
      taxNote: taxNoteFor(0),
      tagline: 'Try CVsprings on a real role.',
      limits: { analysesPerMonth: FREE_MONTHLY_LIMIT, seats: 1 },
      capabilities: { customBranding: false },
      highlights: [PHRASE.analysesCapped(FREE_MONTHLY_LIMIT), PHRASE.seatsSingle],
    },
    {
      id: 'pro', name: 'Pro', priceAmount: 49, priceLabel: priceLabelFor(49), per: '/month', featured: true,
      taxNote: taxNoteFor(49),
      tagline: 'For recruiters screening at volume.',
      limits: { analysesPerMonth: null, seats: 1 },
      capabilities: { customBranding: true },
      highlights: [PHRASE.analysesUnlimited, PHRASE.seatsSingle, PHRASE.whiteLabel],
      upgradePlan: 'pro', // -> POST /api/billing/checkout {plan:'pro'} (existing flow)
    },
    {
      id: 'team', name: 'Team', priceAmount: 199, priceLabel: priceLabelFor(199), per: '/month',
      taxNote: taxNoteFor(199),
      tagline: 'For agencies with a screening team.',
      limits: { analysesPerMonth: null, seats: 'multiple' },
      capabilities: { customBranding: true },
      highlights: [PHRASE.analysesUnlimited, PHRASE.seatsMulti, PHRASE.whiteLabel],
      upgradePlan: 'team',
    },
  ],
};

// Capabilities applied when a plan id is unknown, missing, or malformed.
// Deliberately the free set: an org whose plan cannot be identified gets the
// least entitlement, never the most.
const FALLBACK_CAPABILITIES = Object.freeze({ customBranding: false });

function tierById(planId) {
  if (typeof planId !== 'string') return null;
  return PLANS.tiers.find((t) => t.id === planId) || null;
}

/**
 * Capability flags for a plan id. Fails closed on anything unrecognised.
 * @param {string|null|undefined} planId
 * @returns {{customBranding: boolean}}
 */
function capabilitiesFor(planId) {
  const tier = tierById(planId);
  if (!tier || !tier.capabilities) return { ...FALLBACK_CAPABILITIES };
  return { ...FALLBACK_CAPABILITIES, ...tier.capabilities };
}

/**
 * The subset served over the public, unauthenticated GET /api/plans.
 *
 * An explicit allowlist rather than a copy of the whole object, so any internal
 * field added to a tier later has to be opted in to be published. Capability
 * flags ARE included: the client needs them to render entitlement-dependent UI
 * (e.g. the Settings branding panel's disabled state), and they are not
 * secrets. The server never trusts a client's copy — every gate re-reads this
 * module directly.
 */
function marketingView() {
  return {
    currency: PLANS.currency,
    baseline: [...PLANS.baseline],
    tiers: PLANS.tiers.map((t) => ({
      id: t.id,
      name: t.name,
      priceLabel: t.priceLabel,
      per: t.per,
      taxNote: t.taxNote || null, // null on Free; templates render it only when set
      tagline: t.tagline,
      featured: !!t.featured,
      limits: { ...t.limits },
      capabilities: capabilitiesFor(t.id),
      highlights: [...t.highlights],
      ...(t.upgradePlan ? { upgradePlan: t.upgradePlan } : {}),
    })),
  };
}

/**
 * schema.org Product + Offer structured data for the pricing section.
 *
 * The prices on the landing page are rendered by client-side JS from
 * /api/plans, so until this existed they were invisible to anything that does
 * not run scripts — crawlers, link unfurlers, price aggregators. This produces
 * the same three tiers as a server-rendered block, built from the SAME objects
 * the cards are built from, so the marked-up price cannot drift from the
 * displayed one.
 *
 * One Product with three Offers (rather than three Products) is the accurate
 * shape here: it is a single service sold at three subscription tiers. Each
 * Offer carries a UnitPriceSpecification because "€49" alone does not say per
 * what — `unitCode: 'MON'` (UN/CEFACT for month) plus billingDuration says it.
 *
 * @param {string|null} baseUrl absolute site origin; offer URLs are omitted
 *   when it is unset, since a relative URL in JSON-LD is not resolvable by a
 *   consumer that fetched the page from somewhere else.
 */
function productJsonLd(baseUrl) {
  const origin = typeof baseUrl === 'string' ? baseUrl.replace(/\/+$/, '') : '';
  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: 'CVsprings',
    description: 'Deterministic, rules-based CV screening for recruitment agencies. '
      + 'Explainable scores, reproducible results and an EU AI Act-aligned audit trail, '
      + 'with no language model in the candidate path.',
    brand: { '@type': 'Brand', name: 'CVsprings' },
    category: 'Recruitment screening software',
    offers: PLANS.tiers.map((t) => ({
      '@type': 'Offer',
      name: t.name,
      description: t.tagline,
      price: String(t.priceAmount),
      priceCurrency: CURRENCY.code,
      availability: 'https://schema.org/InStock',
      ...(origin ? { url: `${origin}/#pricing` } : {}),
      priceSpecification: {
        '@type': 'UnitPriceSpecification',
        price: String(t.priceAmount),
        priceCurrency: CURRENCY.code,
        billingDuration: 1,
        billingIncrement: 1,
        unitCode: 'MON', // UN/CEFACT: month
        // The prices above are ex-VAT. Without this, the markup asserts that
        // €49 is what a buyer pays, which is the same false claim in a form
        // search engines index and may surface as a price.
        valueAddedTaxIncluded: TAX.included,
      },
    })),
  };
}

module.exports = {
  PLANS,
  CURRENCY,
  TAX,
  FALLBACK_CAPABILITIES,
  FREE_MONTHLY_LIMIT,
  PHRASE,
  ENTITLEMENT_AXES,
  phraseForAxis,
  tierById,
  capabilitiesFor,
  marketingView,
  productJsonLd,
};
