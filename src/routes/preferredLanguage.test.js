'use strict';

/**
 * src/routes/preferredLanguage.test.js — PATCH /api/auth/me and the saved
 * UI language.
 *
 * The preference is what makes the nav switcher and the Settings select agree
 * across devices, so: it is validated on the server (not just the client), it
 * comes back on every path the app learns who the user is (login, signup,
 * /me), every role may set it, and a PAUSED account — read-only everywhere
 * else — may still set it, because reading your own data in your own language
 * is not a write the entitlement gate should stop.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cvs-preflang-'));
process.env.DATABASE_PATH = path.join(TMP_DIR, 'test.db');

const express = require('express');
const db = require('../services/db');
const auth = require('../services/authService');
const { requireSession } = require('../middleware/auth');
const { requireWriteAccess } = require('../middleware/requireWriteAccess');
const authRouter = require('./auth');
const templatesRouter = require('./templates');

const PASSWORD = 'CorrectHorseBattery1!';
let server; let base;
let ownerToken; let memberToken; let orgId; let ownerId;

before(async () => {
  db.getDb();
  const org = auth.createOrganization('Taal BV');
  orgId = org.id;
  const hash = await auth.hashPassword(PASSWORD);
  const owner = auth.createUser({ email: 'owner@taal.test', passwordHash: hash, orgId, role: 'owner' });
  const member = auth.createUser({ email: 'member@taal.test', passwordHash: hash, orgId, role: 'member' });
  ownerId = owner.id;
  ownerToken = auth.createSession(owner.id).rawToken;
  memberToken = auth.createSession(member.id).rawToken;
  // Team, so the member's session is valid at all.
  db.setOrgPlan(orgId, { plan: 'team', subscriptionStatus: 'active', currentPeriodEnd: null });

  const app = express();
  app.use(express.json());
  // Mounted as src/index.js mounts them: /api/auth WITHOUT requireWriteAccess,
  // /api/templates WITH it (the control for the paused-account case).
  app.use('/api/auth', authRouter);
  app.use('/api/templates', requireSession, requireWriteAccess, templatesRouter);
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  try { server.close(); } catch (_) {}
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}
});

async function call(method, url, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch (_) { /* empty */ }
  return { status: res.status, body: json };
}
const patch = (token, body) => call('PATCH', '/api/auth/me', { token, body });
const stored = (id) => db.getDb().prepare('SELECT preferred_language FROM users WHERE id = ?').get(id).preferred_language;

describe('the migration', () => {
  test('existing users start with no preference (NULL), not English', () => {
    assert.equal(stored(ownerId), null);
  });

  test('the database itself refuses a value outside en | nl | de', () => {
    assert.throws(() => db.getDb().prepare('UPDATE users SET preferred_language = ? WHERE id = ?').run('fr', ownerId), /CHECK constraint/);
    assert.equal(stored(ownerId), null);
  });
});

describe('PATCH /api/auth/me { preferredLanguage }', () => {
  test('requires a session', async () => {
    const res = await patch(null, { preferredLanguage: 'nl' });
    assert.equal(res.status, 401);
  });

  test('saves en, nl and de, and null clears it', async () => {
    for (const v of ['nl', 'de', 'en', null]) {
      const res = await patch(ownerToken, { preferredLanguage: v });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(res.body, { preferredLanguage: v });
      assert.equal(stored(ownerId), v);
    }
  });

  test('rejects anything else with a 400 and leaves the saved value alone', async () => {
    await patch(ownerToken, { preferredLanguage: 'de' });
    const bad = [
      { preferredLanguage: 'fr' }, { preferredLanguage: 'EN' }, { preferredLanguage: 'nl-NL' },
      { preferredLanguage: '' }, { preferredLanguage: 1 }, { preferredLanguage: ['nl'] },
      {}, { preferredLanguage: 'nl', role: 'owner' }, { lang: 'nl' },
    ];
    for (const body of bad) {
      const res = await patch(ownerToken, body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(res.body.code, 'VALIDATION_ERROR');
      assert.equal(res.body.field, 'preferredLanguage');
    }
    assert.equal(stored(ownerId), 'de');
  });

  test('cannot be used to change anything else about the account', async () => {
    const res = await patch(ownerToken, { preferredLanguage: 'nl', email: 'evil@x.test', role: 'owner' });
    assert.equal(res.status, 400);
    assert.equal(db.getDb().prepare('SELECT email FROM users WHERE id = ?').get(ownerId).email, 'owner@taal.test');
  });

  test('a member may set their own (any role)', async () => {
    const res = await patch(memberToken, { preferredLanguage: 'nl' });
    assert.equal(res.status, 200);
  });
});

describe('the saved language comes back wherever the app learns who you are', () => {
  test('GET /api/auth/me', async () => {
    await patch(ownerToken, { preferredLanguage: 'nl' });
    const res = await call('GET', '/api/auth/me', { token: ownerToken });
    assert.equal(res.body.user.preferredLanguage, 'nl');
  });

  test('POST /api/auth/login', async () => {
    const res = await call('POST', '/api/auth/login', { body: { email: 'owner@taal.test', password: PASSWORD } });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.preferredLanguage, 'nl');
  });

  test('POST /api/auth/signup (a new account has none yet)', async () => {
    const res = await call('POST', '/api/auth/signup', { body: { email: 'new@taal.test', password: PASSWORD } });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.user.preferredLanguage, null);
  });
});

describe('a paused (read-only) account can still change its language', () => {
  before(() => db.setOrgPlan(orgId, { plan: 'pro', subscriptionStatus: 'paused', currentPeriodEnd: null }));
  after(() => db.setOrgPlan(orgId, { plan: 'team', subscriptionStatus: 'active', currentPeriodEnd: null }));

  test('the account really is read-only (control)', async () => {
    const res = await call('POST', '/api/templates', { token: ownerToken, body: { name: 'x', role: 'y' } });
    assert.equal(res.status, 402, 'writes elsewhere must be refused for a paused account');
  });

  test('…and the language still saves', async () => {
    const res = await patch(ownerToken, { preferredLanguage: 'de' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(stored(ownerId), 'de');
  });
});

describe('password errors carry a stable reason code for translation', () => {
  test('too short', async () => {
    const res = await call('POST', '/api/auth/signup', { body: { email: 'short@taal.test', password: 'abc' } });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'VALIDATION_ERROR');
    assert.equal(res.body.reason, 'PASSWORD_TOO_SHORT');
    assert.match(res.body.error, /at least 10 characters/, 'the English message is unchanged');
  });

  test('too common', async () => {
    // 'password123' is on authService's COMMON_PASSWORDS list.
    const res = await call('POST', '/api/auth/signup', { body: { email: 'common@taal.test', password: 'password123' } });
    assert.equal(res.status, 400);
    assert.equal(res.body.reason, 'PASSWORD_TOO_COMMON');
  });

  test('the codes exist in every dictionary', () => {
    for (const lang of ['en', 'nl', 'de']) {
      const d = require(`../../locales/${lang}.json`);
      assert.ok(d['errors.VALIDATION_ERROR.PASSWORD_TOO_SHORT'], lang);
      assert.ok(d['errors.VALIDATION_ERROR.PASSWORD_TOO_COMMON'], lang);
    }
  });
});
