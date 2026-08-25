'use strict';

/**
 * src/routes/adminMetricsMenu.test.js — the owner-only "Metrics" menu entry.
 *
 * Two halves, tested where each actually lives:
 *
 *   server  /api/auth/me and the login payload publish `isPlatformOwner`, a
 *           BOOLEAN. The operator's address is never sent to a client, so this
 *           also asserts the address does not appear in anyone else's payload.
 *
 *   client  the shipped functions out of public/app.html, run in a vm against
 *           the small DOM shim (test/helpers/pageSandbox). Extracting the real
 *           bodies rather than transcribing them is the point — a test that
 *           reimplements openWithDownloadToken proves nothing about the code
 *           that ships.
 *
 * The menu entry is a RENDERING HINT and these tests say so: revealing it
 * grants nothing, because routes/adminMetrics re-derives ownership from the
 * session on every request. What is worth testing is that it does not appear
 * for the wrong person (it advertises a page meant to stay unadvertised) and
 * that clicking it never leaves the operator staring at a silent no-op.
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const vm = require('node:vm');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cvsprings-admin-menu-test-'));
process.env.DATABASE_PATH = path.join(TMP_DIR, 'admin-menu-test.db');
process.env.ADMIN_OWNER_EMAIL = 'jasperjoy99@gmail.com';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { getDb, closeDb } = require('../services/db');
const authService = require('../services/authService');
const platformOwner = require('../config/platformOwner');
const authRouter = require('./auth');
const { extractFunction, extractLine } = require('../../test/helpers/pageSandbox');

const APP_HTML = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'app.html'), 'utf8');
const OWNER_EMAIL = 'jasperjoy99@gmail.com';

let server;
let baseUrl;

function makeOrg(id, plan = 'team', status = 'active') {
  getDb().prepare(
    'INSERT INTO organizations (id, name, created_at, plan, subscription_status) VALUES (?,?,?,?,?)',
  ).run(id, id, new Date().toISOString(), plan, status);
  return id;
}

async function login(email, password = 'correct-horse-battery') {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return { status: res.status, body: await res.json() };
}

async function me(token) {
  const res = await fetch(`${baseUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, body: await res.json() };
}

before(async () => {
  getDb();
  const ownerOrg = makeOrg('org-owner');
  const customerOrg = makeOrg('org-customer');

  const hash = await authService.hashPassword('correct-horse-battery');
  authService.createUser({ email: OWNER_EMAIL, passwordHash: hash, orgId: ownerOrg, role: 'owner' });
  authService.createUser({ email: 'member@example.test', passwordHash: hash, orgId: ownerOrg, role: 'member' });
  authService.createUser({ email: 'customer@example.test', passwordHash: hash, orgId: customerOrg, role: 'owner' });

  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  closeDb();
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

// --- the rule ----------------------------------------------------------------

describe('platform owner predicate', () => {
  test('requires the address AND the owner role', () => {
    assert.equal(platformOwner.isPlatformOwner({ email: OWNER_EMAIL, role: 'owner' }), true);
    // Demoted while keeping the address: no longer holds the cross-tenant key.
    assert.equal(platformOwner.isPlatformOwner({ email: OWNER_EMAIL, role: 'member' }), false);
    // An owner — of their own org. Every paying customer is one.
    assert.equal(platformOwner.isPlatformOwner({ email: 'customer@example.test', role: 'owner' }), false);
    assert.equal(platformOwner.isPlatformOwner(null), false);
    assert.equal(platformOwner.isPlatformOwner({ role: 'owner' }), false);
  });

  test('normalises case and whitespace but matches exactly, not by prefix', () => {
    assert.equal(platformOwner.isPlatformOwner({ email: '  JasperJoy99@Gmail.COM ', role: 'owner' }), true);
    assert.equal(platformOwner.isPlatformOwner({ email: 'jasperjoy99+alias@gmail.com', role: 'owner' }), false);
    assert.equal(platformOwner.isPlatformOwner({ email: 'jasperjoy99@gmail.com.evil.test', role: 'owner' }), false);
  });

  test('the guard and the menu flag are the same function, not two copies', () => {
    // If these ever diverge the failure is silent: a menu item that appears for
    // somebody the guard 404s, or vanishes for the one person it is for.
    const guardSrc = fs.readFileSync(path.join(__dirname, 'adminMetrics.js'), 'utf8');
    const authSrc = fs.readFileSync(path.join(__dirname, 'auth.js'), 'utf8');
    assert.match(guardSrc, /require\('\.\.\/config\/platformOwner'\)/);
    assert.match(authSrc, /require\('\.\.\/config\/platformOwner'\)/);
    // And neither re-derives the address for itself.
    assert.doesNotMatch(authSrc, /ADMIN_OWNER_EMAIL/);
    assert.doesNotMatch(guardSrc, /ADMIN_OWNER_EMAIL/);
  });
});

// --- what the API publishes ---------------------------------------------------

describe('isPlatformOwner on the session payload', () => {
  test('the owner is flagged, on login and on /me alike', async () => {
    const res = await login(OWNER_EMAIL);
    assert.equal(res.status, 200);
    assert.equal(res.body.user.isPlatformOwner, true);

    // A reloaded tab must reach the same conclusion as a fresh login, or the
    // menu item disappears until the next sign-in.
    const m = await me(res.body.sessionToken);
    assert.equal(m.body.user.isPlatformOwner, true);
  });

  test('a member of the owner org is not flagged', async () => {
    const res = await login('member@example.test');
    assert.equal(res.body.user.isPlatformOwner, false);
    assert.equal((await me(res.body.sessionToken)).body.user.isPlatformOwner, false);
  });

  test("another organization's owner is not flagged", async () => {
    const res = await login('customer@example.test');
    assert.equal(res.body.user.role, 'owner', 'they really are an owner — of their own org');
    assert.equal(res.body.user.isPlatformOwner, false);
    assert.equal((await me(res.body.sessionToken)).body.user.isPlatformOwner, false);
  });

  test('the flag is a boolean and the owner address is never disclosed', async () => {
    const res = await login('customer@example.test');
    const m = await me(res.body.sessionToken);
    for (const payload of [res.body, m.body]) {
      assert.equal(typeof payload.user.isPlatformOwner, 'boolean');
      // A client that learns the address learns which account to go after.
      assert.equal(JSON.stringify(payload).includes(OWNER_EMAIL), false,
        'the operator address leaked into another user\'s session payload');
    }
  });
});

// --- the shipped client code --------------------------------------------------

/**
 * Run the real updateAccountChip/onAuthed out of app.html against a fake DOM.
 *
 * Everything the two bodies call that is not under test is stubbed, so what is
 * exercised is the shipped source of these two functions and nothing else.
 */
function menuSandbox({ sessionToken = 'tok', email = 'someone@example.test' } = {}) {
  const els = {};
  const mk = (id) => (els[id] = { id, hidden: false, textContent: '', title: '', style: {}, setAttribute() {} });
  for (const id of ['accountEmail', 'accountAvatarLetter', 'adminMetricsItem', 'adminMetricsSep', 'planChip']) mk(id);

  const ctx = {
    document: { getElementById: (id) => els[id] || null },
    USER_EMAIL_KEY: 'cvsprings_user_email',
    ORG_NAME_KEY: 'cvsprings_org_name',
    localStorage: {
      getItem: (k) => ({ cvsprings_user_email: email, cvsprings_org_name: 'Acme' }[k] || null),
      setItem() {},
    },
    getSessionToken: () => sessionToken,
    accountMenuEls: () => ({ menu: { classList: { toggle() {} } }, btn: { setAttribute() {} } }),
    closeAccountMenu() {},
    accountInitial: (e) => (e || '?')[0],
    // onAuthed's other collaborators, none of them under test here.
    hideAuthScreen() {}, initApp() {}, resumeCheckoutIntent() {},
    console,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(
    [
      extractLine(APP_HTML, 'let _isPlatformOwner ='),
      extractFunction(APP_HTML, 'updateAccountChip'),
      extractFunction(APP_HTML, 'onAuthed'),
    ].join('\n'),
    ctx,
  );
  return { ctx, els };
}

describe('the Metrics entry in the account menu', () => {
  test('it is hidden before any session is confirmed', () => {
    // Fails closed: a slow /me must not flash the entry, and must not show it
    // to a customer whose response has not arrived yet.
    const { ctx, els } = menuSandbox();
    vm.runInContext('updateAccountChip()', ctx);
    assert.equal(els.adminMetricsItem.hidden, true);
    assert.equal(els.adminMetricsSep.hidden, true);
  });

  test('it renders for the owner', () => {
    const { ctx, els } = menuSandbox({ email: OWNER_EMAIL });
    vm.runInContext('onAuthed({ user: { email: "jasperjoy99@gmail.com", isPlatformOwner: true } })', ctx);
    assert.equal(els.adminMetricsItem.hidden, false);
    assert.equal(els.adminMetricsSep.hidden, false, 'the separator must follow the item it separates');
  });

  test('it is absent for a member', () => {
    const { ctx, els } = menuSandbox({ email: 'member@example.test' });
    vm.runInContext('onAuthed({ user: { email: "member@example.test", isPlatformOwner: false } })', ctx);
    assert.equal(els.adminMetricsItem.hidden, true);
  });

  test("it is absent for another organization's owner", () => {
    const { ctx, els } = menuSandbox({ email: 'customer@example.test' });
    vm.runInContext('onAuthed({ user: { email: "customer@example.test", role: "owner", isPlatformOwner: false } })', ctx);
    assert.equal(els.adminMetricsItem.hidden, true);
  });

  test('a payload with no flag at all is treated as not owner', () => {
    // An older server, or a response shape that changed. Absence must not read
    // as permission.
    const { ctx, els } = menuSandbox({ email: OWNER_EMAIL });
    vm.runInContext('onAuthed({ user: { email: "jasperjoy99@gmail.com" } })', ctx);
    assert.equal(els.adminMetricsItem.hidden, true);
  });

  test('logging out hides it again', () => {
    const { ctx, els } = menuSandbox({ email: OWNER_EMAIL });
    vm.runInContext('onAuthed({ user: { email: "jasperjoy99@gmail.com", isPlatformOwner: true } })', ctx);
    assert.equal(els.adminMetricsItem.hidden, false);
    // Session gone: updateAccountChip clears the in-memory flag with it.
    vm.runInContext('getSessionToken = () => ""; updateAccountChip()', ctx);
    assert.equal(els.adminMetricsItem.hidden, true);
    // And the flag itself is cleared, not merely un-rendered.
    assert.equal(vm.runInContext('_isPlatformOwner', ctx), false);
  });

  test('the flag is never persisted', () => {
    // It is re-established from /api/auth/me on every load, so a stale stored
    // value can never outlive the session it described.
    assert.doesNotMatch(APP_HTML, /setItem\([^)]*[iI]sPlatformOwner/);
    assert.doesNotMatch(APP_HTML, /[iI]sPlatformOwner\s*=\s*[^;]*(?:localStorage|sessionStorage|getItem)/);
    // It is declared as a plain in-memory binding, defaulting to false.
    assert.match(APP_HTML, /let _isPlatformOwner = false;/);
  });

  test('it is wired through data-action delegation, not an inline handler', () => {
    assert.match(APP_HTML, /data-action="openAdminMetrics"/);
    assert.match(APP_HTML, /toggleAccountMenu,\s*openAdminMetrics,/);
    const item = /<button[^>]*id="adminMetricsItem"[\s\S]*?>/.exec(APP_HTML);
    assert.doesNotMatch(item[0], /\son[a-z]+=/i);
  });

  test('it is not in the main nav — the route stays unadvertised', () => {
    const nav = /<nav[\s\S]*?<\/nav>/.exec(APP_HTML);
    assert.ok(nav, 'the app must have a nav');
    assert.doesNotMatch(nav[0], /openAdminMetrics|admin\/metrics/);
  });
});

// --- the click path -----------------------------------------------------------

/**
 * Run the real openAdminMetrics + openWithDownloadToken.
 *
 * `api` is stubbed at the network boundary and records its calls, so a test can
 * assert the token endpoint was hit exactly once — the thing a "does it work"
 * assertion on the final URL would miss.
 */
function clickSandbox({ mint }) {
  const calls = [];
  const opened = [];
  const toasts = [];
  const ctx = {
    API: 'https://api.test',
    api: async (p, opts) => { calls.push({ path: p, method: (opts || {}).method }); return mint(); },
    toast: (msg, kind) => toasts.push({ msg, kind }),
    handleApiError: (err, fallback) => toasts.push({ msg: (err && err.message) || fallback, kind: 'error', fallback }),
    console,
  };
  ctx.window = {
    open: (url) => {
      const w = { closed: false, _url: url, close() { this.closed = true; } };
      Object.defineProperty(w, 'location', {
        get: () => w._url,
        set: (v) => { w._url = String(v); opened.push(String(v)); },
      });
      opened.push(url);
      return w;
    },
  };
  vm.createContext(ctx);
  vm.runInContext(
    [extractFunction(APP_HTML, 'openWithDownloadToken'), extractFunction(APP_HTML, 'openAdminMetrics')].join('\n'),
    ctx,
  );
  return { ctx, calls, opened, toasts };
}

describe('opening the metrics page', () => {
  test('mints exactly one token and opens the expected URL', async () => {
    const { ctx, calls, opened } = clickSandbox({ mint: async () => ({ token: 'dt-abc123' }) });
    await vm.runInContext('openAdminMetrics()', ctx);

    assert.deepEqual(calls, [{ path: '/api/auth/download-token', method: 'POST' }],
      'the token endpoint must be called exactly once');
    // about:blank first (inside the user-gesture popup allowance), then the
    // real URL assigned to that same window.
    assert.equal(opened[0], 'about:blank');
    assert.equal(opened[opened.length - 1], 'https://api.test/admin/metrics?dt=dt-abc123');
  });

  test('the token is URL-encoded rather than concatenated raw', () => {
    const fn = extractFunction(APP_HTML, 'openWithDownloadToken');
    assert.match(fn, /encodeURIComponent\(d\.token\)/);
  });

  test('it reuses the shared helper instead of a second copy of the fetch', () => {
    // The constraint that keeps the token lifecycle in one place. A private
    // fetch here would be a second thing to remember when it changes.
    const fn = extractFunction(APP_HTML, 'openAdminMetrics');
    assert.match(fn, /openWithDownloadToken\(/);
    assert.doesNotMatch(fn, /fetch\(|download-token/);
  });

  test('a failed mint surfaces the error and opens no tokenless URL', async () => {
    // The failure this is really about: navigating to /admin/metrics without a
    // dt would hit the guard and 404 — telling the operator the page does not
    // exist, when what actually happened is that the token could not be minted.
    const err = Object.assign(new Error('Unauthorized'), { status: 401, code: 'AUTH_REQUIRED' });
    const { ctx, opened, toasts } = clickSandbox({ mint: async () => { throw err; } });
    await vm.runInContext('openAdminMetrics()', ctx);

    assert.equal(toasts.length, 1, 'a failure must not be silent');
    assert.equal(toasts[0].kind, 'error');
    assert.equal(toasts[0].fallback, 'Could not open metrics');
    // about:blank was opened and then closed; nothing was ever navigated.
    assert.deepEqual(opened, ['about:blank']);
    assert.equal(opened.some((u) => u.includes('/admin/metrics')), false,
      'a tokenless /admin/metrics URL was opened — it would 404 confusingly');
  });

  test('a network error is surfaced the same way', async () => {
    const { ctx, opened, toasts } = clickSandbox({
      mint: async () => { throw new TypeError('Failed to fetch'); },
    });
    await vm.runInContext('openAdminMetrics()', ctx);
    assert.equal(toasts.length, 1);
    assert.deepEqual(opened, ['about:blank']);
  });

  test('a missing API base toasts rather than doing nothing', async () => {
    const { ctx, opened, toasts } = clickSandbox({ mint: async () => ({ token: 'x' }) });
    await vm.runInContext('API = ""; openAdminMetrics()', ctx);
    // A menu item that does nothing when clicked is indistinguishable from a
    // broken one.
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0].kind, 'error');
    assert.deepEqual(opened, []);
  });

  test('the token is never logged or stored', () => {
    const fn = extractFunction(APP_HTML, 'openWithDownloadToken');
    assert.doesNotMatch(fn, /console\.(log|warn|error|info)/);
    assert.doesNotMatch(fn, /localStorage|sessionStorage|document\.cookie/);
  });
});
