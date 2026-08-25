'use strict';

/**
 * src/routes/pricingCheckout.test.js
 *
 * Self-serve purchase from the public pricing cards.
 *
 * The Pro and Team cards used to end in "Book a demo", so the only way to buy
 * was to talk to a human first. They now open Stripe Checkout directly, which
 * puts three things at risk that source can actually be held to:
 *
 *   1. The BUTTON LABEL carries a price. If that price is retyped in
 *      public/index.html it will eventually disagree with the price the card
 *      above it shows and the amount Stripe charges. Every part of the label
 *      must come out of the /api/plans payload (src/config/plans.js).
 *   2. The PLAN ID the button sends must be one POST /api/billing/checkout
 *      accepts — the in-product upgrade route, not a parallel one.
 *   3. The ?plan= handover for logged-out visitors is a URL parameter, i.e.
 *      attacker-controlled, and must be validated against plans.js rather than
 *      forwarded to Stripe as given.
 *
 * The CTA renderer and the intent validator are pulled out of the shipped HTML
 * and executed here, so these assertions run the real code paths rather than a
 * copy of them.
 */

const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const INDEX_HTML = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
const APP_HTML = fs.readFileSync(path.join(PUBLIC_DIR, 'app.html'), 'utf8');
const BILLING_SRC = fs.readFileSync(path.join(__dirname, 'billing.js'), 'utf8');

const { extractFunction, extractLine } = require('../../test/helpers/pageSandbox');

const { marketingView, productJsonLd, PLANS: RAW_PLANS, CURRENCY, TAX } = require('../config/plans');
const PLANS = marketingView();
const PAID_TIERS = PLANS.tiers.filter((t) => t.upgradePlan);
const FREE_TIER = PLANS.tiers.find((t) => !t.upgradePlan);


/**
 * Prose about the code must not read as the code. Both pages now carry comments
 * that quote a price while explaining why prices are not written there — the
 * scanner below would otherwise flag its own documentation.
 *
 * Line comments are stripped only when they occupy the whole line, so a "//"
 * inside an https:// URL cannot swallow real markup and hide a genuine offender.
 */
function withoutComments(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

// extractFunction/extractLine live in test/helpers/pageSandbox.js — shared with
// pricingCheckoutFlow.test.js so there is one brace matcher, not two.

// ---------------------------------------------------------------------------
// The pricing-card CTA renderer, run against the real plan table.
// ---------------------------------------------------------------------------

const ctaSandbox = vm.createContext({});
vm.runInContext([
  extractFunction(INDEX_HTML, 'esc'),
  extractLine(INDEX_HTML, 'var DEMO_HREF='),
  extractLine(INDEX_HTML, 'var SECONDARY_DEMO='),
  extractFunction(INDEX_HTML, 'ctaHtml'),
].join('\n'), ctaSandbox);

function ctaFor(tier) {
  ctaSandbox.__t = tier;
  return vm.runInContext('ctaHtml(__t)', ctaSandbox);
}

describe('pricing cards sell the paid tiers instead of booking a call', () => {
  test('every purchasable tier renders a checkout button, not a demo link', () => {
    assert.ok(PAID_TIERS.length >= 2, 'expected Pro and Team to be purchasable');
    for (const t of PAID_TIERS) {
      const html = ctaFor(t);
      assert.match(html, /<button type="button" class="btn btn-primary" data-action="startCheckout"/, t.id);
      assert.match(html, new RegExp('data-plan="' + t.upgradePlan + '"'), t.id);
      assert.doesNotMatch(html, />Book a demo</, `${t.id}'s primary CTA must no longer be the demo form`);
    }
  });

  test('the label is composed from the plan table, price included', () => {
    // Pro reads "Get Pro — €49/month" today; the point of the assertion is that
    // it is BUILT from name + priceLabel + per, so it tracks plans.js.
    for (const t of PAID_TIERS) {
      const expected = `Get ${t.name} — ${t.priceLabel}${t.per}`;
      assert.match(ctaFor(t), new RegExp('>' + expected + '</button>'), t.id);
    }
    const pro = PAID_TIERS.find((t) => t.id === 'pro');
    assert.match(ctaFor(pro), />Get Pro — €49\/month</, 'sanity-check the current copy');
  });

  test('a price change in plans.js moves the button label with it', () => {
    // The real regression guard: no branch of the renderer may hardcode money.
    const html = ctaFor({ ...PAID_TIERS[0], name: 'Pro', priceLabel: '€61', per: '/month' });
    assert.match(html, />Get Pro — €61\/month</);
  });

  test('Free keeps "Start free" pointing at signup', () => {
    assert.ok(FREE_TIER, 'expected a tier with no upgradePlan');
    assert.equal(ctaFor(FREE_TIER), '<a class="btn btn-ghost" href="/signup">Start free</a>');
  });

  test('Team, and only Team, keeps a secondary route to the demo form', () => {
    const team = ctaFor(PAID_TIERS.find((t) => t.id === 'team'));
    assert.match(team, /<a class="tier-alt" href="#demo">Or book a demo<\/a>/);
    assert.doesNotMatch(ctaFor(PAID_TIERS.find((t) => t.id === 'pro')), /Or book a demo/);
  });

  test('each paid card has a status line for owner-only / billing-off replies', () => {
    for (const t of PAID_TIERS) {
      assert.match(ctaFor(t), new RegExp('id="tierMsg-' + t.upgradePlan + '"'), t.id);
    }
  });

  test('the "Get <tier>" label is composed, not written into the page', () => {
    for (const t of PAID_TIERS) {
      assert.doesNotMatch(withoutComments(INDEX_HTML), new RegExp('Get ' + t.name));
    }
  });

  test('the top-nav "Book a demo" CTA is untouched', () => {
    assert.match(INDEX_HTML, /<a class="btn btn-primary nav-cta nav-demo" href="#demo">Book a demo<\/a>/);
  });
});

describe('prices are one number per tier, in plans.js', () => {
  test('the display label is derived from the numeric amount', () => {
    // Two independent spellings of the same price is how a card ends up
    // advertising one number while the structured data publishes another.
    for (const t of RAW_PLANS.tiers) {
      assert.equal(typeof t.priceAmount, 'number', `${t.id} needs a numeric price`);
      assert.equal(t.priceLabel, `${CURRENCY.symbol}${t.priceAmount}`, t.id);
    }
  });

  test('the currency is carried in both display and ISO form', () => {
    assert.equal(CURRENCY.symbol, '€');
    assert.equal(CURRENCY.code, 'EUR');
    assert.equal(RAW_PLANS.currency, CURRENCY.symbol);
    assert.equal(RAW_PLANS.currencyCode, CURRENCY.code);
  });
});

describe('pricing structured data', () => {
  const ld = productJsonLd('https://cvsprings.com');

  test('it is a Product with one Offer per tier', () => {
    assert.equal(ld['@type'], 'Product');
    assert.equal(ld.offers.length, RAW_PLANS.tiers.length);
    assert.deepEqual(ld.offers.map((o) => o.name), RAW_PLANS.tiers.map((t) => t.name));
  });

  test('every offer states an amount, a currency and a billing period', () => {
    for (const [i, offer] of ld.offers.entries()) {
      const tier = RAW_PLANS.tiers[i];
      assert.equal(offer['@type'], 'Offer');
      assert.equal(offer.price, String(tier.priceAmount), tier.id);
      assert.equal(offer.priceCurrency, 'EUR', tier.id);
      // "€49" alone does not say per what.
      assert.equal(offer.priceSpecification['@type'], 'UnitPriceSpecification');
      assert.equal(offer.priceSpecification.unitCode, 'MON', tier.id);
      assert.equal(offer.priceSpecification.billingDuration, 1, tier.id);
      assert.equal(offer.priceSpecification.price, String(tier.priceAmount), tier.id);
    }
  });

  test('the marked-up price tracks plans.js, it is not a second copy', () => {
    // Every price in the JSON-LD must be findable in the tier table.
    const fromTable = new Set(RAW_PLANS.tiers.map((t) => String(t.priceAmount)));
    for (const offer of ld.offers) assert.ok(fromTable.has(offer.price), offer.name);
    assert.deepEqual(ld.offers.map((o) => o.price), ['0', '49', '199']);
  });

  test('offer URLs are absolute, or absent when no base URL is configured', () => {
    for (const offer of ld.offers) assert.match(offer.url, /^https:\/\/cvsprings\.com\/#pricing$/);
    for (const offer of productJsonLd(null).offers) {
      assert.equal('url' in offer, false, 'a relative URL would be unusable to a crawler');
    }
  });

  test('the page carries the placeholder the server substitutes', () => {
    assert.match(INDEX_HTML, /<script type="application\/ld\+json"[^>]*>__PRICING_JSONLD__<\/script>/);
    const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    assert.match(indexSrc, /replaceAll\('__PRICING_JSONLD__', pricingJsonLd\)/);
    // A '<' inside the JSON would otherwise be able to close the script element.
    assert.match(indexSrc, /replaceAll\('<', '\\\\u003c'\)/);
  });
});

describe('entitlement is decided before the visitor clicks', () => {
  test('a session triggers one paired lookup, not a click-and-see', () => {
    assert.match(INDEX_HTML, /Promise\.all\(\[\s*apiFetch\('\/api\/auth\/me'\),\s*apiFetch\('\/api\/billing\/usage'\),?\s*\]\)/);
    assert.match(INDEX_HTML, /document\.addEventListener\('cv:pricing_rendered',syncEntitlement\)/);
    assert.match(INDEX_HTML, /function syncEntitlement\(\)\{\s*if\(!token\(\)\)return;/);
  });

  test('members get a disabled button and a stated reason', () => {
    const fn = extractFunction(INDEX_HTML, 'applyEntitlement');
    assert.match(fn, /role==='owner'/);
    assert.match(fn, /btn\.disabled=true;/);
    assert.match(fn, /owner can start a subscription/);
    // Styled as a note, not as the error it would be after a failed click.
    assert.match(fn, /,true\)/);
  });

  test('the tier an org is already on is labelled, not sold', () => {
    const fn = extractFunction(INDEX_HTML, 'applyEntitlement');
    assert.match(fn, /plan===currentPlan/);
    assert.match(fn, /Your current plan/);
  });

  test('it fails open, leaving the server-enforced click path in charge', () => {
    assert.match(INDEX_HTML, /\.catch\(function\(\)\{ \/\* fail open — the click path still enforces \*\/ \}\)/);
  });
});

describe('the buttons reuse the in-product checkout route', () => {
  test('the page posts to /api/billing/checkout and creates no parallel route', () => {
    assert.match(INDEX_HTML, /apiFetch\('\/api\/billing\/checkout','POST',\{plan:plan\}\)/);
    const endpoints = [...INDEX_HTML.matchAll(/['"](\/api\/billing\/[a-z]+)['"]/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(endpoints)].sort(), ['/api/billing/checkout', '/api/billing/usage']);
  });

  test('every upgradePlan in plans.js is a plan the checkout route accepts', () => {
    // billing.js validates the body literally; if a tier is added to plans.js
    // with an id that route rejects, its button 400s on click.
    const guard = /plan !== '([a-z]+)' && plan !== '([a-z]+)'/.exec(BILLING_SRC);
    assert.ok(guard, 'could not find the plan guard in billing.js');
    const accepted = new Set([guard[1], guard[2]]);
    for (const t of PAID_TIERS) {
      assert.ok(accepted.has(t.upgradePlan), `POST /api/billing/checkout rejects '${t.upgradePlan}'`);
    }
  });

  test('the dashboard destination is a product route, not the login route', () => {
    assert.match(INDEX_HTML, /var APP_URL='\/dashboard';/);
    // Server-side: that path has to actually serve the app.
    const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    assert.match(indexSrc, /app\.get\('\/dashboard', serveNoncedHtml\('app\.html'\)\)/);
  });

  test('an org already on the plan is not sold a second subscription', () => {
    // usage is read BEFORE any session is created, and matching plan short-
    // circuits to the app instead of Stripe.
    assert.match(
      INDEX_HTML,
      /apiFetch\('\/api\/billing\/usage'\)[\s\S]{0,200}if\(b&&b\.plan===plan\)\{ window\.location=APP_URL; return null; \}/,
    );
  });

  test('logged-out visitors are sent to signup with the intent attached', () => {
    assert.match(INDEX_HTML, /if\(!token\(\)\)\{ toAuth\('\/signup',plan\); return; \}/);
    assert.match(INDEX_HTML, /window\.location=page\+'\?plan='\+encodeURIComponent\(plan\)/);
  });

  test('an expired session goes to login rather than a silent failure', () => {
    assert.match(INDEX_HTML, /if\(e\.status===401\)\{ dropToken\(\); toAuth\('\/login',plan\); return; \}/);
  });

  test('the buttons are wired by delegation, not inline handlers', () => {
    // Helmet sets script-src-attr 'none' — an onclick here would be a dead
    // button. (cspInlineHandlers.test.js scans for the attribute itself.)
    assert.match(INDEX_HTML, /click:\{ startCheckout: startCheckout \}/);
    assert.match(INDEX_HTML, /closest\('\[data-action\]'\)/);
  });
});

// ---------------------------------------------------------------------------
// ?plan= handover, validated against the plan table before it is trusted.
// ---------------------------------------------------------------------------

function capturePlanIntent(rawQuery, cfg) {
  const ctx = vm.createContext({
    loadPlans: () => Promise.resolve(cfg === undefined ? PLANS : cfg),
    URL,
    URLSearchParams,
    window: { location: { href: 'https://cvsprings.com/signup?' + rawQuery } },
    history: { replaceState() {} },
  });
  const script = [
    'let _pendingCheckoutPlan = null;',
    extractFunction(APP_HTML, 'stripPlanParam'),
    extractFunction(APP_HTML, 'capturePlanIntent'),
    'capturePlanIntent(new URLSearchParams(__q)).then(function(r){ return [r, _pendingCheckoutPlan]; });',
  ].join('\n');
  ctx.__q = rawQuery;
  return vm.runInContext(script, ctx);
}

describe('the signup handover validates the plan against plans.js', () => {
  test('a real purchasable tier survives', async () => {
    for (const t of PAID_TIERS) {
      const [returned, stored] = await capturePlanIntent('plan=' + t.id);
      assert.equal(returned, t.upgradePlan, t.id);
      assert.equal(stored, t.upgradePlan, t.id);
    }
  });

  test('unrecognised values are dropped, not forwarded', async () => {
    for (const bad of ['enterprise', 'PRO', 'pro;team', '../admin', '<script>', '']) {
      const [returned, stored] = await capturePlanIntent('plan=' + encodeURIComponent(bad));
      assert.equal(returned, null, `?plan=${bad} must be ignored`);
      assert.equal(stored, null, `?plan=${bad} must not be stored`);
    }
  });

  test('a tier with no checkout (Free) is not a purchase intent', async () => {
    const [returned] = await capturePlanIntent('plan=' + FREE_TIER.id);
    assert.equal(returned, null);
  });

  test('no plan param is a no-op', async () => {
    const [returned] = await capturePlanIntent('');
    assert.equal(returned, null);
  });

  test('the plan sent onward is the tier\'s upgradePlan, never the raw query', () => {
    assert.match(APP_HTML, /t\.id === raw && t\.upgradePlan/);
    assert.match(APP_HTML, /_pendingCheckoutPlan = tier \? tier\.upgradePlan : null/);
  });
});

describe('checkout resumes after signup instead of landing on the dashboard', () => {
  test('every successful auth consumes a pending intent', () => {
    // WAS a proximity regex with a 400-character window, which measured how
    // much source sat between the two rather than whether the call is in the
    // function at all — so an unrelated comment could fail it, and a call that
    // escaped into the NEXT function would pass. Brace-matching the body says
    // exactly what is meant.
    const fn = extractFunction(APP_HTML, 'onAuthed');
    assert.match(fn, /resumeCheckoutIntent\(\);/);
  });

  test('resuming goes through the same startCheckout the app uses', () => {
    const fn = extractFunction(APP_HTML, 'resumeCheckoutIntent');
    assert.match(fn, /startCheckout\(plan\)/);
    assert.doesNotMatch(fn, /checkout.sessions|stripe\./i);
  });

  test('an org already on that plan stays on the dashboard', () => {
    const fn = extractFunction(APP_HTML, 'resumeCheckoutIntent');
    assert.match(fn, /if \(b && b\.plan === plan\) \{[^}]*return; \}/);
  });

  test('non-owners get told to ask their owner rather than a 403', () => {
    const fn = extractFunction(APP_HTML, 'resumeCheckoutIntent');
    assert.match(fn, /role === 'owner'/);
    assert.match(fn, /Ask your organization owner/);
  });

  test('the intent is cleared once consumed, so a reload cannot replay it', () => {
    const fn = extractFunction(APP_HTML, 'resumeCheckoutIntent');
    assert.match(fn, /_pendingCheckoutPlan = null;[\s\S]{0,80}stripPlanParam\(\);/);
  });

  test('/signup?plan= opens on the signup form, not the login form', () => {
    assert.match(APP_HTML, /showAuthScreen\(planIntent && window\.location\.pathname === '\/signup' \? 'signup' : 'login'\)/);
  });
});

describe('no served page hardcodes a price', () => {
  // app.html carried 'Upgrade to Pro €49' and 'Team €199' in the quota prompt
  // for as long as those buttons existed: a second source of truth that no test
  // looked at, so a price change in plans.js would have left it silently wrong —
  // and, once the Stripe prices turned out to be ex-VAT, silently understating.
  // The scan covers both pages now, because covering one is what let it survive.
  const PAGES = { 'index.html': INDEX_HTML, 'app.html': APP_HTML };

  test('neither page contains a literal tier price', () => {
    for (const [name, html] of Object.entries(PAGES)) {
      const src = withoutComments(html);
      for (const t of PLANS.tiers) {
        assert.doesNotMatch(src, new RegExp(t.priceLabel.replace('€', '\\u20ac') + '(?![0-9])'),
          `${name} hardcodes ${t.priceLabel} — it must come from /api/plans`);
      }
    }
  });

  test('nor the VAT qualifier, which is also plans.js\'s to define', () => {
    for (const [name, html] of Object.entries(PAGES)) {
      assert.doesNotMatch(withoutComments(html), new RegExp(TAX.note),
        `${name} hardcodes "${TAX.note}" — read taxNote from the payload instead`);
    }
  });

  test('the scan would actually catch one (guards against a vacuous pass)', () => {
    const planted = '<div class="price">\u20ac49<small> /month</small></div>';
    assert.match(withoutComments(planted), new RegExp('\u20ac49(?![0-9])'));
  });

  test('every price render site reads taxNote from the payload', () => {
    // The four sites named in the change: two on the landing page, two in the app.
    // The button deliberately carries NO qualifier — it would be the second on
    // one card. The price line beside it is the single statement.
    assert.doesNotMatch(INDEX_HTML, /cta-tax/);
    assert.match(INDEX_HTML, /t\.taxNote\?' <span class="tax">'/);          // card price
    assert.match(APP_HTML, /p\.taxNote\?' <span style="font-weight:400">'/); // settings compare
    assert.match(APP_HTML, /tier\.taxNote\?' <span style="font-weight:400">'/); // detail modal
    assert.match(APP_HTML, /t\.taxNote\?' '\+t\.taxNote:''/);             // quota prompt
  });
});

describe('the tax qualifier has one source', () => {
  test('taxNote is set for paid tiers and withheld from Free', () => {
    // priceAmount is internal (marketingView does not publish it), so the rule
    // is asserted against the source table.
    for (const t of RAW_PLANS.tiers) {
      assert.equal(t.taxNote, t.priceAmount ? TAX.note : null, t.id);
    }
  });

  test('and it reaches the client over /api/plans', () => {
    const byId = Object.fromEntries(PLANS.tiers.map((t) => [t.id, t]));
    assert.equal(byId.pro.taxNote, TAX.note);
    assert.equal(byId.team.taxNote, TAX.note);
    assert.equal(byId.free.taxNote, null, 'VAT on €0 is €0 — a qualifier there is noise');
  });

  test('the JSON-LD says the indexed price excludes VAT', () => {
    for (const offer of productJsonLd('https://cvsprings.com').offers) {
      assert.equal(offer.priceSpecification.valueAddedTaxIncluded, false, offer.name);
    }
  });

  test('the display note and the structured-data flag come from one constant', () => {
    // Flipping TAX.included must move both, or they will disagree the day the
    // Stripe prices are recreated as inclusive.
    assert.equal(TAX.included, false);
    const src = fs.readFileSync(path.join(__dirname, '..', 'config', 'plans.js'), 'utf8');
    assert.match(src, /valueAddedTaxIncluded: TAX\.included/);
    assert.match(src, /TAX\.included \|\| !amount \? null : TAX\.note/);
  });
});
