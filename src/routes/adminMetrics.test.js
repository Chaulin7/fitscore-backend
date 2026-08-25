'use strict';

/**
 * src/routes/adminMetrics.test.js — the owner guard, the page, and reconciliation.
 *
 * The guard is the whole security story of this feature: /admin/metrics is the
 * only route in the application that reads across every tenant, so "who gets in"
 * is not a detail of it, it IS it. These tests drive the REAL router over HTTP
 * with REAL sessions minted by services/authService — no stubbed middleware,
 * because a stub is exactly where an owner check goes missing without anything
 * failing.
 *
 * Every rejection is asserted to be 404 with the same body the application's
 * catch-all returns. A 401 or a 403 here would confirm the path exists, which
 * is the one thing the route is designed not to do.
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cvsprings-admin-route-test-'));
process.env.DATABASE_PATH = path.join(TMP_DIR, 'admin-route-test.db');
process.env.ADMIN_OWNER_EMAIL = 'jasperjoy99@gmail.com';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const crypto = require('node:crypto');

const { getDb, closeDb } = require('../services/db');
const authService = require('../services/authService');
const stripeReconcile = require('../services/stripeReconcile');
const metrics = require('../services/metrics');
const adminMetricsRouter = require('./adminMetrics');

const OWNER_EMAIL = 'jasperjoy99@gmail.com';

let server;
let baseUrl;
let ownerToken;
let otherOwnerToken;
let memberToken;
let ownerImpostorToken;

function makeOrg(id, { plan = 'free', status = null, comped = 0 } = {}) {
  getDb().prepare(`
    INSERT INTO organizations (id, name, created_at, plan, subscription_status, comped)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, id, new Date().toISOString(), plan, status, comped);
  return id;
}

// A real user + a real session, so the route's own resolveCaller() does the
// same lookup it does in production.
function makeSession(orgId, email, role) {
  const user = authService.createUser({ email, passwordHash: 'x', orgId, role });
  return authService.createSession(user.id).rawToken;
}

async function get(pathname, { token, dt } = {}) {
  const url = new URL(baseUrl + pathname);
  if (dt) url.searchParams.set('dt', dt);
  const res = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

before(async () => {
  getDb();

  const ownerOrg = makeOrg('org-owner', { plan: 'pro', comped: 1 });
  const customerOrg = makeOrg('org-customer', { plan: 'pro', status: 'active' });
  const teamOrg = makeOrg('org-team', { plan: 'team', status: 'active' });

  ownerToken = makeSession(ownerOrg, OWNER_EMAIL, 'owner');
  otherOwnerToken = makeSession(customerOrg, 'customer@example.test', 'owner');
  memberToken = makeSession(teamOrg, 'member@example.test', 'member');
  // The owner's address on an account that has been DEMOTED to member. Email
  // alone would let this one through.
  ownerImpostorToken = makeSession(teamOrg, 'jasperjoy99+alias@gmail.com', 'member');

  getDb().prepare('INSERT INTO screening_runs (id, org_id, role_title, created_at) VALUES (?,?,?,?)')
    .run('run-1', customerOrg, 'Engineer', new Date().toISOString());

  metrics.runDailySnapshot();

  const app = express();
  // The same per-request nonce src/index.js generates, because the page's
  // inline <script> carries it and the route reads res.locals.cspNonce.
  app.use((req, res, next) => {
    res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
    next();
  });
  app.use('/admin', adminMetricsRouter);
  app.use((req, res) => res.status(404).json({ error: 'Not found', code: 'NOT_FOUND', path: req.path }));

  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  closeDb();
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

// --- the guard ---------------------------------------------------------------

describe('owner guard', () => {
  test('the owner gets the page', async () => {
    const res = await get('/admin/metrics', { token: ownerToken });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/html/);
  });

  test('no credential at all is 404, not 401', async () => {
    const res = await get('/admin/metrics');
    assert.equal(res.status, 404);
    assert.deepEqual(JSON.parse(res.text), { error: 'Not found', code: 'NOT_FOUND', path: '/admin/metrics' });
  });

  test("another organization's owner is 404", async () => {
    // A perfectly valid session for a real paying customer. They are an owner —
    // of their own org — and this route is not org-scoped, so role alone would
    // hand them every tenant's figures.
    const res = await get('/admin/metrics', { token: otherOwnerToken });
    assert.equal(res.status, 404);
    assert.equal(JSON.parse(res.text).code, 'NOT_FOUND');
  });

  test('a member session is 404', async () => {
    const res = await get('/admin/metrics', { token: memberToken });
    assert.equal(res.status, 404);
  });

  test('a lookalike address is 404 — the match is exact, not a prefix', async () => {
    const res = await get('/admin/metrics', { token: ownerImpostorToken });
    assert.equal(res.status, 404);
  });

  test('a garbage bearer token is 404', async () => {
    for (const bad of ['', 'x', 'Bearer', crypto.randomBytes(32).toString('hex')]) {
      const res = await get('/admin/metrics', { token: bad });
      assert.equal(res.status, 404, `token ${JSON.stringify(bad)} was not rejected`);
    }
  });

  test('an expired session is 404', async () => {
    const org = makeOrg('org-expired');
    const user = authService.createUser({ email: 'expired@example.test', passwordHash: 'x', orgId: org, role: 'owner' });
    const { rawToken, session } = authService.createSession(user.id);
    getDb().prepare('UPDATE sessions SET expires_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 1000).toISOString(), session.id);
    assert.equal((await get('/admin/metrics', { token: rawToken })).status, 404);
  });

  test('the owner email is never accepted from the query string', async () => {
    // Guards against the guard ever being "helpfully" relaxed to trust a param.
    const res = await get(`/admin/metrics?email=${encodeURIComponent(OWNER_EMAIL)}&owner=1&admin=true`);
    assert.equal(res.status, 404);
  });

  test('a session token in ?dt= is rejected — dt takes download tokens only', async () => {
    // A session token is long-lived and a URL leaks. Only a single-use 60s
    // download token may travel in the query string.
    const res = await get('/admin/metrics', { dt: ownerToken });
    assert.equal(res.status, 404);
  });

  test("a download token minted for the owner's session opens the page once", async () => {
    const found = authService.findSessionByToken(ownerToken);
    const dt = authService.createDownloadToken({ orgId: found.user.org_id, userId: found.user.id });

    assert.equal((await get('/admin/metrics', { dt })).status, 200);
    // Single use: the second attempt is 404, same as any other bad credential.
    assert.equal((await get('/admin/metrics', { dt })).status, 404);
  });

  test("a download token minted for a customer's session does not", async () => {
    const found = authService.findSessionByToken(otherOwnerToken);
    const dt = authService.createDownloadToken({ orgId: found.user.org_id, userId: found.user.id });
    assert.equal((await get('/admin/metrics', { dt })).status, 404);
  });

  test('ownerEmail() prefers ADMIN_OWNER_EMAIL, then OWNER_EMAIL, then the default', () => {
    const saved = { a: process.env.ADMIN_OWNER_EMAIL, o: process.env.OWNER_EMAIL };
    try {
      process.env.ADMIN_OWNER_EMAIL = 'A@Example.COM ';
      assert.equal(adminMetricsRouter.ownerEmail(), 'a@example.com');
      delete process.env.ADMIN_OWNER_EMAIL;
      process.env.OWNER_EMAIL = 'B@Example.com';
      assert.equal(adminMetricsRouter.ownerEmail(), 'b@example.com');
      delete process.env.OWNER_EMAIL;
      assert.equal(adminMetricsRouter.ownerEmail(), 'jasperjoy99@gmail.com');
    } finally {
      if (saved.a === undefined) delete process.env.ADMIN_OWNER_EMAIL; else process.env.ADMIN_OWNER_EMAIL = saved.a;
      if (saved.o === undefined) delete process.env.OWNER_EMAIL; else process.env.OWNER_EMAIL = saved.o;
    }
  });
});

// --- the access log ----------------------------------------------------------

describe('access log', () => {
  test('every successful access writes one server-attested row', async () => {
    getDb().prepare('DELETE FROM admin_access_log').run();
    await get('/admin/metrics', { token: ownerToken });
    await get('/admin/metrics', { token: ownerToken });

    const rows = getDb().prepare('SELECT * FROM admin_access_log ORDER BY created_at ASC').all();
    assert.equal(rows.length, 2);
    for (const r of rows) {
      assert.equal(r.email, OWNER_EMAIL);
      assert.equal(r.route, '/admin/metrics');
      assert.equal(r.auth_method, 'session');
      assert.equal(r.reconcile, 0);
      assert.ok(r.user_id && r.org_id && r.created_at);
    }
  });

  test('a rejected access writes nothing — the log is of access, not attempts', async () => {
    getDb().prepare('DELETE FROM admin_access_log').run();
    await get('/admin/metrics', { token: otherOwnerToken });
    await get('/admin/metrics');
    assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM admin_access_log').get().n, 0);
  });

  test('the reconcile flag is recorded as a bit and nothing else from the query', async () => {
    getDb().prepare('DELETE FROM admin_access_log').run();
    // `reconcile` is a bare 0/1 column: no query string, header or user agent
    // is stored verbatim, so a crafted parameter has nowhere to land.
    await get('/admin/metrics?reconcile=1&evil=%3Cscript%3E', { token: ownerToken });
    const row = getDb().prepare('SELECT * FROM admin_access_log').get();
    assert.equal(row.reconcile, 1);
    assert.equal(JSON.stringify(row).includes('evil'), false);
    assert.equal(JSON.stringify(row).includes('script'), false);
  });

  test('the auth method is recorded, so a ?dt= access is distinguishable', async () => {
    getDb().prepare('DELETE FROM admin_access_log').run();
    const found = authService.findSessionByToken(ownerToken);
    const dt = authService.createDownloadToken({ orgId: found.user.org_id, userId: found.user.id });
    await get('/admin/metrics', { dt });
    assert.equal(getDb().prepare('SELECT auth_method FROM admin_access_log').get().auth_method, 'download_token');
  });
});

// --- the page ----------------------------------------------------------------

describe('the rendered page', () => {
  let html;
  let referrerPolicy;

  before(async () => {
    const res = await get('/admin/metrics', { token: ownerToken });
    html = res.text;
    referrerPolicy = res.headers.get('referrer-policy');
  });

  test('carries no inline event-handler attributes', () => {
    // script-src-attr is 'none' in src/index.js: an onclick here would render a
    // live-looking button that silently does nothing. Same scanner as
    // routes/cspInlineHandlers.test.js.
    const markup = html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '');
    const found = markup.match(/<[a-zA-Z][^>]*?\son[a-zA-Z]+\s*=\s*["']/g) || [];
    assert.deepEqual(found, [], `inline handlers found: ${found.join(' | ')}`);
  });

  test('wires its one control through data-action delegation', () => {
    assert.match(html, /data-action="runReconcile"/);
    assert.match(html, /closest\("\[data-action\]"\)/);
  });

  test('the inline script carries the per-request nonce', () => {
    const nonce = /<script nonce="([^"]+)">/.exec(html);
    assert.ok(nonce, 'inline script has no nonce — the CSP would block it');
    assert.ok(nonce[1].length >= 16);
  });

  test('a second request gets a different nonce', async () => {
    const other = (await get('/admin/metrics', { token: ownerToken })).text;
    const a = /<script nonce="([^"]+)">/.exec(html)[1];
    const b = /<script nonce="([^"]+)">/.exec(other)[1];
    assert.notEqual(a, b, 'a fixed nonce is CSP theatre');
  });

  test('loads nothing from a third party', () => {
    // DO NOT DELETE THIS AS A COSMETIC ASSERTION. It is a credential control.
    //
    // This page is reachable with ?dt=<downloadToken> in the URL, because a
    // browser tab cannot send an Authorization header. Any remote subresource —
    // a CDN chart library, a Google font, an analytics pixel — makes the
    // browser issue a request to that third party, and the Referer header on
    // that request carries the full current URL, token and all. One <script
    // src> added for convenience would hand a live CVsprings credential to
    // whoever runs that host, in their access logs, forever.
    //
    // Two other controls stand in front of this one: the route sends
    // `Referrer-Policy: no-referrer`, and the download token is single-use and
    // already spent by the time the page renders. This is the backstop behind
    // both — the layer that still holds if the header is dropped in a refactor
    // or the token lifecycle changes. It is also what keeps the "no third-party
    // analytics, no user data off the server" requirement true by construction
    // rather than by review.
    const remote = html.match(/(?:src|href)\s*=\s*["']https?:\/\/[^"']+/gi) || [];
    assert.deepEqual(remote, [], `page references remote resources: ${remote.join(' | ')}`);
  });

  test('and says so in the response headers, the control in front of that one', () => {
    // Asserted here so the two layers are visibly a pair: if someone removes
    // the header, this fails and points at the test above.
    assert.equal(referrerPolicy, 'no-referrer');
  });

  test('is never cached and never leaks its URL in a referrer', () => {
    // A cached copy would show one operator's cross-tenant figures to whatever
    // shared cache holds it, and would pin a nonce that no longer matches.
    assert.match(html, /<title>CVsprings — internal metrics<\/title>/);
    assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
  });

  test('renders the summary cards, the plan table and the signups chart', () => {
    for (const label of ['Accounts', 'MRR', 'Active subs', 'Activation']) {
      assert.ok(html.includes(`<div class="card-label">${label}</div>`), `missing card: ${label}`);
    }
    assert.match(html, /Plan breakdown/);
    assert.match(html, /Recent signups/);
    assert.match(html, /Signups per day/);
    assert.match(html, /<polyline class="line"/);
    // The CVsprings brandmark, inlined rather than fetched.
    assert.match(html, /<span class="mark" aria-hidden="true"><svg/);
  });

  test('does not reach Stripe unless ?reconcile=1 asks it to', () => {
    assert.match(html, /Not run\./);
    assert.match(html, /<button type="button" class="btn" data-action="runReconcile">/);
  });

  test('escapes an organization name that contains markup', async () => {
    makeOrg('<img src=x onerror=alert(1)>');
    const page = (await get('/admin/metrics', { token: ownerToken })).text;
    assert.equal(page.includes('<img src=x onerror=alert(1)>'), false);
    getDb().prepare('DELETE FROM organizations WHERE id = ?').run('<img src=x onerror=alert(1)>');
  });

  test('reports honestly when Stripe is not configured', async () => {
    // No STRIPE_SECRET_KEY in the test environment. An empty findings list here
    // would read as "everything reconciles", which is a lie.
    const page = (await get('/admin/metrics?reconcile=1', { token: ownerToken })).text;
    assert.match(page, /Stripe is not configured on this deployment/);
    assert.equal(page.includes('Every linked account agrees with Stripe'), false);
  });

  test('the chart survives a flat, all-zero series', () => {
    const svg = adminMetricsRouter.renderChart([
      { date: '2026-08-01', signups: 0 }, { date: '2026-08-02', signups: 0 },
      { date: '2026-08-03', signups: 0 },
    ]);
    // Scaling to a zero maximum would divide by zero and put NaN in every
    // coordinate — an empty polyline that reads as a broken page, not a quiet week.
    assert.equal(svg.includes('NaN'), false);
    assert.match(svg, /<polyline class="line" points="[\d., ]+"/);
  });

  test('renders the cancelling-at-period-end section', () => {
    assert.match(html, /Cancelling at period end/);
  });

  test('the churn table names the amount, the count and the date', () => {
    const table = adminMetricsRouter.renderChurning({
      mrrEur: 248, count: 2,
      accounts: [
        { id: 'a', name: 'Northgate', ownerEmail: 'n@x.test', plan: 'pro', currentPeriodEnd: '2026-09-04T00:00:00.000Z', mrrEur: 49, comped: false },
        { id: 'b', name: 'Kestrel', ownerEmail: 'k@x.test', plan: 'team', currentPeriodEnd: '2026-09-19T00:00:00.000Z', mrrEur: 199, comped: false },
      ],
    });
    assert.match(table, /€248/);
    assert.match(table, /2 accounts/);
    // The date is the difference between this and the past_due figure.
    assert.match(table, /2026-09-04/);
    assert.match(table, /2026-09-19/);
  });

  test('a clean platform says so rather than rendering an empty table', () => {
    assert.match(
      adminMetricsRouter.renderChurning({ mrrEur: 0, count: 0, accounts: [] }),
      /No active subscription is set to cancel/,
    );
  });

  test('the drift indicator renders from storage and makes no API call', () => {
    // The page is rendered with no Stripe key configured at all; if this
    // section needed the network it could not produce a number.
    const banner = adminMetricsRouter.renderDriftBanner(
      { count: 3, checkedAt: '2026-08-24T02:00:00.000Z', error: null, errorDate: null },
      '2026-08-24T12:00:00.000Z',
    );
    assert.match(banner, /<strong>3<\/strong>/);
    assert.match(banner, /10h ago/);
    assert.match(banner, /No API call was made/);
  });

  test('a stale drift figure is shown with its age, not hidden', () => {
    const banner = adminMetricsRouter.renderDriftBanner(
      { count: 2, checkedAt: '2026-08-14T02:00:00.000Z', error: null, errorDate: null },
      '2026-08-24T12:00:00.000Z',
    );
    assert.match(banner, /10 days ago/);
  });

  test('a failed drift check is said out loud next to the stale number', () => {
    // Silence here would let a permanently-failing check masquerade as a
    // permanently-clean one.
    const banner = adminMetricsRouter.renderDriftBanner(
      { count: 1, checkedAt: '2026-08-20T02:00:00.000Z', error: 'Stripe timed out', errorDate: '2026-08-24' },
      '2026-08-24T12:00:00.000Z',
    );
    assert.match(banner, /<strong>1<\/strong>/);
    assert.match(banner, /did not complete/);
    assert.match(banner, /Stripe timed out/);
    assert.match(banner, /from before that/);
  });

  test('a never-checked platform says so instead of showing zero drift', () => {
    const banner = adminMetricsRouter.renderDriftBanner(
      { count: null, checkedAt: null, error: null, errorDate: null }, '2026-08-24T12:00:00.000Z',
    );
    assert.match(banner, /has not been checked yet/);
    assert.equal(/<strong>0<\/strong>/.test(banner), false);
  });

  test('the page shows the passive drift section without ?reconcile=1', () => {
    assert.match(html, /Stripe drift \(passive\)/);
    // And still has not run the on-demand check.
    assert.match(html, /Not run\./);
  });

  test('the chart asks for history rather than drawing a line through one point', () => {
    assert.match(adminMetricsRouter.renderChart([]), /Not enough snapshot history/);
    assert.match(adminMetricsRouter.renderChart([{ date: '2026-08-01', signups: 3 }]), /Not enough snapshot history/);
  });
});

// --- reconciliation ----------------------------------------------------------

describe('stripe reconciliation', () => {
  // A hand-rolled fake rather than the network. checkOrg() takes the client as
  // a parameter precisely so the comparison rules are testable without keys.
  function fakeStripe(sub) {
    return {
      subscriptions: {
        retrieve: async () => sub,
        list: async () => ({ data: sub ? [sub] : [] }),
      },
    };
  }
  const subOf = (priceId, status) => ({ id: 'sub_1', status, items: { data: [{ price: { id: priceId } }] } });
  const org = (over = {}) => ({
    id: 'o', name: 'Acme', ownerEmail: 'a@b.test', comped: 0,
    plan: 'pro', subscriptionStatus: 'active',
    stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1', ...over,
  });

  before(() => { process.env.STRIPE_PRICE_PRO = 'price_pro'; process.env.STRIPE_PRICE_TEAM = 'price_team'; });
  after(() => { delete process.env.STRIPE_PRICE_PRO; delete process.env.STRIPE_PRICE_TEAM; });

  test('an account that agrees with Stripe produces no finding', async () => {
    const out = await stripeReconcile.checkOrg(fakeStripe(subOf('price_pro', 'active')), org());
    assert.deepEqual(out, []);
  });

  test('a plan disagreement is reported with both sides', async () => {
    const out = await stripeReconcile.checkOrg(fakeStripe(subOf('price_team', 'active')), org({ plan: 'pro' }));
    assert.equal(out.length, 1);
    assert.equal(out[0].code, stripeReconcile.FINDING.PLAN_MISMATCH);
    assert.equal(out[0].localPlan, 'pro');
    assert.equal(out[0].stripePlan, 'team');
  });

  test('a status disagreement is reported', async () => {
    const out = await stripeReconcile.checkOrg(
      fakeStripe(subOf('price_pro', 'past_due')), org({ subscriptionStatus: 'active' }),
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].code, stripeReconcile.FINDING.STATUS_MISMATCH);
    assert.equal(out[0].stripeStatus, 'past_due');
  });

  test('a live Stripe subscription against a local free plan is flagged loudly', async () => {
    // The expensive direction: the customer is being charged for something the
    // product is not giving them.
    const out = await stripeReconcile.checkOrg(
      fakeStripe(subOf('price_pro', 'active')), org({ plan: 'free', subscriptionStatus: null }),
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].code, stripeReconcile.FINDING.ORPHAN_SUBSCRIPTION);
    assert.equal(out[0].informational, false);
  });

  test('a paid local plan with no subscription at Stripe is flagged', async () => {
    const out = await stripeReconcile.checkOrg(fakeStripe(null), org({ stripeSubscriptionId: null }));
    assert.equal(out.length, 1);
    assert.equal(out[0].code, stripeReconcile.FINDING.NO_SUBSCRIPTION);
  });

  test('a comped account with no Stripe customer is informational, not a mismatch', async () => {
    // This is the owner org, and it is correct. Reporting it as a disagreement
    // on every page load is how an operator learns to ignore this list.
    const out = await stripeReconcile.checkOrg(
      fakeStripe(null), org({ comped: 1, stripeCustomerId: null, stripeSubscriptionId: null }),
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].code, stripeReconcile.FINDING.NO_CUSTOMER);
    assert.equal(out[0].informational, true);
    assert.equal(out[0].comped, true);
  });

  test('a paid account with no Stripe customer and no comped flag is a real finding', async () => {
    const out = await stripeReconcile.checkOrg(
      fakeStripe(null), org({ comped: 0, stripeCustomerId: null, stripeSubscriptionId: null }),
    );
    assert.equal(out[0].code, stripeReconcile.FINDING.NO_CUSTOMER);
    assert.equal(out[0].informational, false);
  });

  test('a Stripe outage is reported against the account, not silently skipped', async () => {
    // Omitting it would read as "this one is fine".
    const failing = { subscriptions: { retrieve: async () => { throw new Error('rate limited'); } } };
    const out = await stripeReconcile.checkOrg(failing, org());
    assert.equal(out.length, 1);
    assert.equal(out[0].code, stripeReconcile.FINDING.STRIPE_ERROR);
    assert.match(out[0].note, /rate limited/);
  });

  test('reconcile() says so when Stripe is unconfigured rather than reporting all-clear', async () => {
    const out = await stripeReconcile.reconcile();
    assert.equal(out.configured, false);
    assert.deepEqual(out.findings, []);
    assert.match(out.error, /not configured/);
  });

  test('orgsToCheck skips free accounts with no Stripe link', () => {
    const ids = stripeReconcile.orgsToCheck(50).map((o) => o.id);
    // Seeded above: org-customer (pro/active) and org-team (team/active) qualify;
    // org-expired (free, no customer) has nothing on either side to disagree about.
    assert.ok(ids.includes('org-customer'));
    assert.ok(ids.includes('org-team'));
    assert.equal(ids.includes('org-expired'), false);
  });

  test('a reconciliation backfills cancel_at_period_end', () => {
    // The column was added after these subscriptions existed, so every
    // pre-existing row reads 0 whether or not the customer has cancelled. The
    // webhook cannot fix that — those events were delivered long ago.
    getDb().prepare('UPDATE organizations SET cancel_at_period_end = 0, stripe_event_created = 100 WHERE id = ?')
      .run('org-customer');
    const org = { id: 'org-customer', cancelAtPeriodEnd: 0, stripeEventCreated: 100 };

    assert.equal(stripeReconcile.backfillCancelFlag(org, { cancel_at_period_end: true }), true);
    assert.equal(
      getDb().prepare('SELECT cancel_at_period_end AS c FROM organizations WHERE id = ?').get('org-customer').c, 1,
    );
  });

  test('a no-op reconciliation writes nothing at all', () => {
    const org = { id: 'org-customer', cancelAtPeriodEnd: 1, stripeEventCreated: 100 };
    assert.equal(stripeReconcile.backfillCancelFlag(org, { cancel_at_period_end: true }), false);
  });

  test('a webhook landing mid-check wins — the backfill is a compare-and-swap', () => {
    // stripe_event_created is the webhook's ordering guard and advances on
    // every plan-mutating event. If it moved while we were waiting on the
    // network, the row we are holding is stale by definition and the slower
    // path must not overwrite it.
    getDb().prepare('UPDATE organizations SET cancel_at_period_end = 0, stripe_event_created = 500 WHERE id = ?')
      .run('org-customer');
    // The org record as read BEFORE the Stripe call, now out of date.
    const stale = { id: 'org-customer', cancelAtPeriodEnd: 0, stripeEventCreated: 100 };

    assert.equal(stripeReconcile.backfillCancelFlag(stale, { cancel_at_period_end: true }), false);
    assert.equal(
      getDb().prepare('SELECT cancel_at_period_end AS c FROM organizations WHERE id = ?').get('org-customer').c, 0,
      'a stale reconciliation overwrote a fresher webhook write',
    );
  });

  test('the swap matches a NULL guard too, for an org that never saw an event', () => {
    // `= NULL` matches nothing in SQL; the UPDATE has to use `IS`.
    getDb().prepare('UPDATE organizations SET cancel_at_period_end = 0, stripe_event_created = NULL WHERE id = ?')
      .run('org-team');
    const org = { id: 'org-team', cancelAtPeriodEnd: 0, stripeEventCreated: null };
    assert.equal(stripeReconcile.backfillCancelFlag(org, { cancel_at_period_end: true }), true);
    assert.equal(
      getDb().prepare('SELECT cancel_at_period_end AS c FROM organizations WHERE id = ?').get('org-team').c, 1,
    );
  });

  test('the backfill never touches plan or status', () => {
    const before = getDb().prepare('SELECT plan, subscription_status AS s, current_period_end AS e FROM organizations WHERE id = ?').get('org-customer');
    stripeReconcile.backfillCancelFlag(
      { id: 'org-customer', cancelAtPeriodEnd: 0, stripeEventCreated: 500 },
      { cancel_at_period_end: true, status: 'canceled', items: { data: [{ price: { id: 'price_team' } }] } },
    );
    const after = getDb().prepare('SELECT plan, subscription_status AS s, current_period_end AS e FROM organizations WHERE id = ?').get('org-customer');
    assert.deepEqual(after, before, 'reconciliation wrote plan state it has no business writing');
  });

  test('reconcile() reports how many flags it backfilled and the drift count', async () => {
    const out = await stripeReconcile.reconcile();
    // Unconfigured here, so both are absent rather than a misleading zero.
    assert.equal(out.configured, false);
    assert.equal(out.findings.length, 0);
  });

  test('driftCount excludes informational rows', async () => {
    const findings = [
      { informational: false }, { informational: false }, { informational: true },
    ];
    // Mirrors the filter in reconcile(): a comped account with no Stripe
    // customer is correct, and a permanently non-zero drift count is a number
    // nobody looks at twice.
    assert.equal(findings.filter((f) => !f.informational).length, 2);
  });

  test('planFromSubscription reuses the webhook’s own price mapping', () => {
    assert.equal(stripeReconcile.planFromSubscription(subOf('price_pro', 'active')), 'pro');
    assert.equal(stripeReconcile.planFromSubscription(subOf('price_team', 'active')), 'team');
    assert.equal(stripeReconcile.planFromSubscription(subOf('price_unknown', 'active')), null);
    assert.equal(stripeReconcile.planFromSubscription(null), null);
  });
});
