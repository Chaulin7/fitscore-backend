'use strict';

/**
 * src/routes/pricingCheckoutFlow.test.js — the live billing path, end to end.
 *
 * pricingCheckout.test.js holds the contract to source: what the buttons say,
 * what the plan ids are, that the ?plan= handover is validated. This file runs
 * the thing. A real server (own process, throwaway database) serves the real
 * pages; the browser code is lifted out of those served pages and executed
 * against them over HTTP. Only the Stripe SDK is stubbed, at the network
 * boundary (test/helpers/stripe-stub.js) — the owner check, the plan guard, the
 * webhook handler and every database write are the shipped ones.
 *
 * This exists because the failure mode it guards is invisible to unit tests:
 * every individual piece can be correct while the journey still charges the
 * wrong org, charges an org twice, or bounces a signed-in visitor to a login
 * screen. That is money and it is the front door, so it is worth the ~4s.
 *
 * The tests run in declaration order and share state — the account created in
 * one is the account subscribed in the next, which is the point: it is one
 * journey, not seven independent assertions.
 *
 * DATABASE_PATH is set below, before anything requires services/db. That is not
 * merely convention here: db.assertNotTheRealDatabase() makes it a hard
 * precondition under the test runner, so a future edit that drops it fails
 * instead of quietly opening the developer's data/audit.db.
 */

const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const {
  extractFunction, scriptBlockContaining, makeDom, recordingFetch,
} = require('../../test/helpers/pageSandbox');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cvsprings-checkout-e2e-'));
const DB_FILE = path.join(TMP_DIR, 'pricing-checkout-e2e.db');
const STUB_LOG = path.join(TMP_DIR, 'stripe-calls.log');
const STUB_FAULT_FILE = path.join(TMP_DIR, 'stripe-fault');
const REPO_ROOT = path.join(__dirname, '..', '..');

const PRICE_PRO = 'price_stub_pro';
const PRICE_TEAM = 'price_stub_team';

let server = null;
let BASE = '';

// Shared journey state.
let indexHtml = '';
let appHtml = '';
let checkoutBlock = '';   // the landing page's purchase script, verbatim
let appBlock = '';        // app.html's main script block, verbatim
let owner = null;         // signup response for the org that buys
let member = null;        // a non-owner in that same org
let proCustomerId = null;

// --- server lifecycle ------------------------------------------------------

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

before(async () => {
  fs.writeFileSync(STUB_LOG, '');
  const port = await freePort();
  BASE = 'http://127.0.0.1:' + port;

  server = spawn(
    process.execPath,
    ['-r', path.join(REPO_ROOT, 'test', 'helpers', 'stripe-stub.js'), 'src/index.js'],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        DATABASE_PATH: DB_FILE, // explicit; inherited NODE_TEST_CONTEXT makes it mandatory
        STUB_LOG,
        STUB_FAULT_FILE,
        STRIPE_SECRET_KEY: 'sk_test_stub',
        STRIPE_PRICE_PRO: PRICE_PRO,
        STRIPE_PRICE_TEAM: PRICE_TEAM,
        STRIPE_WEBHOOK_SECRET: 'whsec_stub',
        PUBLIC_APP_URL: BASE, // canonical; APP_BASE_URL still works as a deprecated alias
        RETENTION_PURGE_MODE: 'dryrun',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });

  for (let i = 0; i < 80; i++) {
    if (server.exitCode !== null) throw new Error('server exited early:\n' + log);
    try {
      const r = await fetch(BASE + '/health');
      if (r.ok) break;
    } catch (_) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
    if (i === 79) throw new Error('server did not start:\n' + log);
  }

  indexHtml = await (await fetch(BASE + '/')).text();
  appHtml = await (await fetch(BASE + '/signup?plan=pro')).text();
  checkoutBlock = scriptBlockContaining(indexHtml, 'Self-serve purchase from the pricing cards');
  appBlock = scriptBlockContaining(appHtml, 'function capturePlanIntent');
});

after(() => {
  if (server) server.kill('SIGKILL');
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}
});

// --- harness ---------------------------------------------------------------

function stripeCalls() {
  return fs.readFileSync(STUB_LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}
function checkoutSessions() {
  return stripeCalls().filter((c) => c.call === 'checkout.sessions.create');
}

/** Make the next Stripe call fail the way a misconfigured account would. */
function injectFault(kind) { fs.writeFileSync(STUB_FAULT_FILE, kind); }
function clearFault() { try { fs.rmSync(STUB_FAULT_FILE); } catch (_) {} }

/** The landing page's purchase script, live, with a session of our choosing. */
function landingPage(sessionToken) {
  const store = sessionToken ? { cvsprings_session_token: sessionToken } : {};
  const dom = makeDom(BASE + '/', store);
  const http = recordingFetch(BASE);
  const ctx = vm.createContext({
    document: dom.document, window: dom.window, localStorage: dom.localStorage,
    CustomEvent: dom.CustomEvent, fetch: http,
    console, setTimeout, encodeURIComponent, URL, URLSearchParams, Promise, Error, Object, Array, JSON,
  });
  vm.runInContext(checkoutBlock, ctx);

  // The CTA buttons the card renderer emits, with the attributes it gives them.
  const buttons = {};
  for (const plan of ['pro', 'team']) {
    buttons[plan] = dom.mkEl('cta-' + plan, {
      attrs: { 'data-plan': plan },
      selectors: ['#pricingTiers button[data-action="startCheckout"]'],
    });
    buttons[plan].dataset.action = 'startCheckout';
    buttons[plan].textContent = plan === 'pro' ? 'Get Pro — €49/month' : 'Get Team — €199/month';
    dom.mkEl('tierMsg-' + plan);
  }
  const settle = () => new Promise((r) => setTimeout(r, 250));
  return { dom, http, buttons, ctx, settle, msg: (p) => dom.els['tierMsg-' + p] };
}

/** app.html's post-auth resume, with the app's own api()/refreshUsage(). */
function appSession(sessionToken, pendingPlan) {
  const dom = makeDom(BASE + '/signup?plan=' + pendingPlan);
  const toasts = [];
  const ctx = vm.createContext({
    window: dom.window, document: dom.document, history: { replaceState() {} },
    fetch: recordingFetch(BASE), console, setTimeout,
    URL, URLSearchParams, FormData, Promise, Error, Object, JSON,
    toast: (m) => toasts.push(String(m)),
    handleApiError: (e, m) => toasts.push(m + ': ' + e.message),
    handleUnauthorized: () => {},
    renderPlanChip: () => {},
    getSessionToken: () => sessionToken,
    API_BASE: BASE,
  });
  vm.runInContext([
    'const RETRY_SAFE_PATHS=[];',
    extractFunction(appBlock, '_isRetrySafe'),
    extractFunction(appBlock, 'api'),
    'let _billing=null;',
    extractFunction(appBlock, 'refreshUsage'),
    extractFunction(appBlock, 'startCheckout'),
    'let _pendingCheckoutPlan = ' + JSON.stringify(pendingPlan) + ';',
    extractFunction(appBlock, 'stripPlanParam'),
    extractFunction(appBlock, 'resumeCheckoutIntent'),
  ].join('\n'), ctx);
  // resumeCheckoutIntent() calls startCheckout() without awaiting it (the page
  // is navigating away at that point), so settle after it resolves.
  const run = async () => {
    await vm.runInContext('resumeCheckoutIntent()', ctx);
    await new Promise((r) => setTimeout(r, 250));
  };
  return { ctx, dom, toasts, run };
}

async function post(path, body, token) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** Move an org onto a plan the way payment does: through the real webhook. */
async function applySubscriptionWebhook(orgId, customerId, priceId) {
  const res = await fetch(BASE + '/api/billing/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': 'stub' },
    body: JSON.stringify({
      id: 'evt_' + Math.random().toString(36).slice(2),
      type: 'customer.subscription.updated',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: 'sub_stub_' + priceId,
          status: 'active',
          customer: customerId,
          metadata: { orgId },
          current_period_end: Math.floor(Date.now() / 1000) + 2592000,
          items: { data: [{ price: { id: priceId } }] },
        },
      },
    }),
  });
  assert.equal(res.status, 200, await res.text());
}

// ===========================================================================

describe('logged out: the pricing button hands the intent to signup', () => {
  test('clicking "Get Pro" goes to /signup?plan=pro and calls nothing', async () => {
    const page = landingPage(null);
    page.dom.click(page.buttons.pro);
    await page.settle();

    assert.equal(page.dom.nav.to, '/signup?plan=pro');
    assert.deepEqual(page.http.calls, [], 'a logged-out visitor has nothing to authenticate with');
    assert.equal(checkoutSessions().length, 0);
  });
});

describe('signup resumes into Checkout', () => {
  test('the ?plan= intent survives and the account is created as owner', async () => {
    const email = 'owner-' + Date.now() + '@example.com';
    const created = await post('/api/auth/signup', {
      email, password: 'correct-horse-battery', orgName: 'E2E Agency',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    owner = created.body;
    assert.equal(owner.user.role, 'owner');
  });

  test('the new owner lands in Stripe Checkout, not on the dashboard', async () => {
    const app = appSession(owner.sessionToken, 'pro');
    await app.run();

    assert.match(String(app.dom.nav.to), /^https:\/\/checkout\.stripe\.com\//);
    const session = checkoutSessions().at(-1);
    assert.equal(session.mode, 'subscription');
    assert.equal(session.price, PRICE_PRO, 'must charge the pro price');
    assert.equal(session.metadata.plan, 'pro');
    assert.equal(session.metadata.orgId, owner.user.orgId, 'must bill the org that just signed up');
    proCustomerId = session.customer;
  });
});

describe('an org already on the plan is not sold it twice', () => {
  before(async () => {
    await applySubscriptionWebhook(owner.user.orgId, proCustomerId, PRICE_PRO);
    const usage = await (await fetch(BASE + '/api/billing/usage', {
      headers: { Authorization: 'Bearer ' + owner.sessionToken },
    })).json();
    assert.equal(usage.plan, 'pro', 'webhook should have applied the subscription');
  });

  // This is the assertion the earlier scratchpad run left ambiguous: landing on
  // /login is ALSO what an expired session does. Three independent signals
  // separate the two, because "already subscribed" and "your session is dead"
  // are very different bugs to have shipped.
  test('the click is the already-subscribed branch, not the 401 branch', async () => {
    const page = landingPage(owner.sessionToken);
    const before = checkoutSessions().length;
    page.dom.click(page.buttons.pro);
    await page.settle();

    // 1. The session was genuinely authenticated: the usage lookup returned 200.
    const usage = page.http.find('GET', '/api/billing/usage');
    assert.ok(usage, 'the button must consult /api/billing/usage before creating anything');
    assert.equal(usage.status, 200, 'a valid session must NOT get a 401 from /api/billing/usage');

    // 2. The destination is the dashboard — an explicit product route, not an
    //    auth route that happens to redirect once bootAuth validates.
    assert.equal(page.dom.nav.to, '/dashboard');
    assert.doesNotMatch(page.dom.nav.to, /login/);

    // 3. The 401 branch drops the stored token; this one leaves it alone.
    assert.equal(page.dom.store.cvsprings_session_token, owner.sessionToken);

    // And the point of all of it: no second subscription.
    assert.equal(checkoutSessions().length, before);
    assert.equal(page.http.find('POST', '/api/billing/checkout'), undefined);
  });

  test('the post-signup resume refuses to double-subscribe too', async () => {
    const app = appSession(owner.sessionToken, 'pro');
    const before = checkoutSessions().length;
    await app.run();
    assert.equal(app.dom.nav.to, null, 'nothing to navigate to — they are already on it');
    assert.equal(checkoutSessions().length, before);
    assert.ok(app.toasts.some((t) => /already on the Pro plan/.test(t)), app.toasts.join(' | '));
  });

  test('a different tier is still purchasable from the same page', async () => {
    const page = landingPage(owner.sessionToken);
    page.dom.click(page.buttons.team);
    await page.settle();
    assert.match(String(page.dom.nav.to), /^https:\/\/checkout\.stripe\.com\//);
    const session = checkoutSessions().at(-1);
    assert.equal(session.price, PRICE_TEAM);
    assert.equal(session.metadata.plan, 'team');
  });
});

describe('an expired session is the OTHER /login', () => {
  test('a stale token goes to /login?plan=pro and is discarded', async () => {
    const page = landingPage('stale-token-no-longer-valid');
    page.dom.click(page.buttons.pro);
    await page.settle();

    assert.equal(page.http.find('GET', '/api/billing/usage').status, 401);
    assert.equal(page.dom.nav.to, '/login?plan=pro', 'intent must survive re-authentication');
    assert.equal(page.dom.store.cvsprings_session_token, undefined, 'the dead token must be dropped');
    assert.equal(checkoutSessions().filter((c) => c.metadata.plan === 'pro').length, 1);
  });
});

describe('non-owner members see it up front, not after a failed click', () => {
  before(async () => {
    // Members require an active Team plan on the org, so move it there first.
    await applySubscriptionWebhook(owner.user.orgId, proCustomerId, PRICE_TEAM);
    const invite = await post('/api/team/invite',
      { email: 'member-' + Date.now() + '@example.com' }, owner.sessionToken);
    assert.ok(invite.status < 300, JSON.stringify(invite.body));
    const token = new URL(invite.body.inviteUrl).searchParams.get('invite');
    const accepted = await post('/api/team/accept', { token, password: 'member-password-42' });
    assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
    member = accepted.body;
    assert.equal(member.user.role, 'member');
  });

  test('the member never gets an enabled purchase button', async () => {
    const page = landingPage(member.sessionToken);
    const before = checkoutSessions().length;
    page.ctx.document.dispatchEvent(new page.dom.CustomEvent('cv:pricing_rendered'));
    await page.settle();

    // Pro: not their plan, but not theirs to buy either.
    assert.equal(page.buttons.pro.disabled, true, 'a member must not be offered checkout');
    assert.match(page.msg('pro').innerHTML, /owner can start a subscription/);
    assert.match(page.msg('pro').className, /note/, 'stated up front, so not styled as an error');

    // Clicking is now impossible; prove it reaches no endpoint.
    assert.equal(page.dom.click(page.buttons.pro), false);
    await page.settle();
    assert.equal(page.http.find('POST', '/api/billing/checkout'), undefined);
    assert.equal(checkoutSessions().length, before);
  });

  test('the org owner still sees a live button for tiers they can buy', async () => {
    const page = landingPage(owner.sessionToken);
    page.ctx.document.dispatchEvent(new page.dom.CustomEvent('cv:pricing_rendered'));
    await page.settle();

    // The org is on team now, so team is the current plan and pro is not.
    assert.equal(page.buttons.team.disabled, true);
    assert.equal(page.buttons.team.textContent, 'Your current plan');
    assert.equal(page.buttons.pro.disabled, false, 'the owner may still change tier');
  });

  test('logged-out visitors are untouched by the entitlement pass', async () => {
    const page = landingPage(null);
    page.ctx.document.dispatchEvent(new page.dom.CustomEvent('cv:pricing_rendered'));
    await page.settle();
    assert.deepEqual(page.http.calls, [], 'no session, nothing to ask about');
    assert.equal(page.buttons.pro.disabled, false);
    assert.equal(page.buttons.pro.textContent, 'Get Pro — €49/month');
  });
});

describe('the served page carries pricing structured data', () => {
  test('JSON-LD is in the HTML itself, not built by script', () => {
    const { productJsonLd } = require('../config/plans');
    const block = /<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/.exec(indexHtml);
    assert.ok(block, 'the served landing page must carry a JSON-LD block');
    const parsed = JSON.parse(block[1]);
    assert.deepEqual(parsed, JSON.parse(JSON.stringify(productJsonLd(BASE))));
    assert.equal(parsed.offers.length, 3);
    assert.deepEqual(parsed.offers.map((o) => o.price), ['0', '49', '199']);
  });
});

describe('Stripe Tax is switched on in the session we send', () => {
  // Everything here asserts the REQUEST. The stub's response is our own
  // invention and proves nothing; what ships to Stripe is the contract.
  let sent = null;

  before(async () => {
    clearFault();
    const created = await post('/api/auth/signup', {
      email: 'tax-' + Date.now() + '@example.com', password: 'correct-horse-battery', orgName: 'Tax Co',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const res = await post('/api/billing/checkout', { plan: 'pro' }, created.body.sessionToken);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    sent = checkoutSessions().at(-1);
  });

  test('automatic_tax is enabled', () => {
    assert.deepEqual(sent.automatic_tax, { enabled: true });
  });

  test('tax_id_collection is enabled, so EU businesses can claim reverse charge', () => {
    assert.deepEqual(sent.tax_id_collection, { enabled: true });
  });

  test('customer_update lets Checkout write the address back to the Customer', () => {
    // Required whenever automatic_tax runs against a Customer we created
    // ourselves — and we always create one before opening Checkout, with no
    // address on it, so this is not optional here.
    assert.deepEqual(sent.customer_update, { address: 'auto', name: 'auto' });
  });

  test('no tax rate, country or threshold is sent — Stripe decides', () => {
    const raw = JSON.stringify(sent);
    assert.doesNotMatch(raw, /tax_rates/, 'a hardcoded rate would go stale silently');
    assert.doesNotMatch(raw, /\b(?:21|19|20)\b.*(?:vat|tax)/i);
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'routes', 'billing.js'), 'utf8');
    assert.doesNotMatch(src, /tax_rates|default_tax_rates/);
    assert.doesNotMatch(src, /'(?:NL|DE|BE|FR)'/, 'no country logic belongs in this codebase');
  });
});

describe('a misconfigured tax account is reported as such', () => {
  // Its own free-tier owner rather than the shared journey's, which is on Pro
  // by this point: checkout now refuses a same-tier repurchase before it ever
  // reaches Stripe (PLAN_NOT_AN_UPGRADE), so a Pro account could not get far
  // enough to exercise the tax branch. These tests are about how a Stripe
  // failure is REPORTED, so they need a request that legitimately reaches
  // Stripe in order to fail there.
  let taxOwner;

  before(async () => {
    clearFault();
    const created = await post('/api/auth/signup', {
      email: 'taxfail-' + Date.now() + '@example.com',
      password: 'correct-horse-battery',
      orgName: 'Tax Fail Co',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    taxOwner = created.body;
  });

  after(() => clearFault());

  test('a tax rejection becomes 503 TAX_NOT_CONFIGURED, not a generic failure', async () => {
    injectFault('tax');
    const res = await post('/api/billing/checkout', { plan: 'pro' }, taxOwner.sessionToken);
    clearFault();

    assert.equal(res.status, 503);
    assert.equal(res.body.code, 'TAX_NOT_CONFIGURED');
    // The message must name the cause; "Could not start checkout" is what this
    // whole branch exists to avoid.
    assert.match(res.body.error, /Stripe Tax configuration is incomplete/);
    assert.match(res.body.error, /origin address/);
    assert.match(res.body.error, /active tax registration/);
  });

  test('an unrelated Stripe failure still reports as a generic Stripe error', async () => {
    injectFault('generic');
    const res = await post('/api/billing/checkout', { plan: 'pro' }, taxOwner.sessionToken);
    clearFault();

    assert.equal(res.status, 502);
    assert.equal(res.body.code, 'STRIPE_ERROR', 'the tax branch must not swallow everything');
  });

  test('the pricing page treats the tax code as "cannot take payment", not a dead button', () => {
    const html = fs.readFileSync(path.join(REPO_ROOT, 'public', 'index.html'), 'utf8');
    assert.match(html, /e\.code==='BILLING_NOT_CONFIGURED'\|\|e\.code==='TAX_NOT_CONFIGURED'/);
  });
});
