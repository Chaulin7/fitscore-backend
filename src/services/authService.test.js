'use strict';

/**
 * src/services/authService.test.js
 *
 * Account-lockout behaviour: the login handler ordering (verify password, then
 * check the lock) and the service-level lock accounting. Uses the Node.js
 * built-in test runner (node --test).
 *
 * Covers:
 *  - an already-locked account does not have locked_until extended by more attempts
 *  - a lock expires on its own after LOCKOUT_MS
 *  - a correct password against a locked account returns ACCOUNT_LOCKED (423)
 *  - a wrong password against a locked account returns INVALID_CREDENTIALS (401)
 *  - a successful login clears both failed_logins and locked_until
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

// Isolate this suite on its own throwaway sqlite file. DB_PATH is resolved when
// ./db is first required, so this must be set BEFORE that require below. node
// --test runs each test file in its own process, so this never touches the real
// dev database.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fitscore-auth-test-'));
process.env.DATABASE_PATH = path.join(TMP_DIR, 'auth-test.db');

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const auth = require('./authService');
const { getDb, closeDb } = require('./db');

const LOCKOUT_MS = 15 * 60 * 1000; // mirrors LOCKOUT_MS in authService.js
const PASSWORD = 'correct-horse-battery'; // >= 10 chars, not a COMMON_PASSWORD

let uniq = 0;
async function makeUser(password = PASSWORD) {
  const email = `user${++uniq}-${Date.now()}@example.com`;
  const org = auth.createOrganization('Test Org');
  const passwordHash = await auth.hashPassword(password);
  auth.createUser({ email, passwordHash, orgId: org.id, role: 'owner' });
  return email;
}

// Force an account into the locked state directly, mirroring what
// recordLoginFailure would produce at the threshold. Returns the unlock time.
function lockAccount(email) {
  const lockedUntil = new Date(Date.now() + LOCKOUT_MS).toISOString();
  getDb().prepare('UPDATE users SET failed_logins = ?, locked_until = ? WHERE email = ?')
    .run(auth.MAX_FAILED_LOGINS, lockedUntil, auth.normalizeEmail(email));
  return lockedUntil;
}

// --- Service-level lock accounting ------------------------------------------

describe('recordLoginFailure / lock lifecycle', () => {
  test('further attempts against an already-locked account do not extend locked_until', async () => {
    const email = await makeUser();
    for (let i = 0; i < auth.MAX_FAILED_LOGINS; i++) {
      auth.recordLoginFailure(auth.findUserByEmail(email));
    }
    const locked = auth.findUserByEmail(email);
    assert.ok(auth.isLocked(locked), 'account is locked once the threshold is crossed');
    const originalUntil = locked.locked_until;
    assert.ok(originalUntil, 'locked_until is set');

    // Keep hammering the locked account.
    for (let i = 0; i < 4; i++) {
      auth.recordLoginFailure(auth.findUserByEmail(email));
    }
    const after = auth.findUserByEmail(email);
    assert.equal(after.locked_until, originalUntil, 'locked_until is NOT pushed further out');
    assert.equal(after.failed_logins, auth.MAX_FAILED_LOGINS + 4, 'the attempt counter still increments');
  });

  test('a lock expires on its own after LOCKOUT_MS', async (t) => {
    const email = await makeUser();
    // Freeze time before racking up failures so we control the unlock instant.
    t.mock.timers.enable({ apis: ['Date'] });
    for (let i = 0; i < auth.MAX_FAILED_LOGINS; i++) {
      auth.recordLoginFailure(auth.findUserByEmail(email));
    }
    assert.ok(auth.isLocked(auth.findUserByEmail(email)), 'locked right after the threshold');

    t.mock.timers.tick(LOCKOUT_MS + 1);
    assert.equal(auth.isLocked(auth.findUserByEmail(email)), false, 'the lock lifts on its own after LOCKOUT_MS');
  });
});

// --- Login handler responses (ordering: verify password, then check lock) ----

describe('POST /api/auth/login — locked-account responses', () => {
  let server;
  let baseUrl;

  before(async () => {
    const app = express();
    app.use(express.json());
    // The handler's 500 branch calls req.log.error; supply a no-op so an
    // unexpected error surfaces as a clean 500 instead of throwing.
    app.use((req, res, next) => { req.log = { error() {} }; next(); });
    app.use('/api/auth', require('../routes/auth'));
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => { if (server) server.close(); });

  async function login(email, password) {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  }

  test('a correct password against a locked account returns ACCOUNT_LOCKED (423)', async () => {
    const email = await makeUser();
    const lockedUntil = lockAccount(email);
    const { status, body } = await login(email, PASSWORD);
    assert.equal(status, 423);
    assert.equal(body.code, 'ACCOUNT_LOCKED');
    assert.equal(body.lockedUntil, lockedUntil, 'the unlock time is returned to the legitimate owner');
  });

  test('a wrong password against a locked account returns INVALID_CREDENTIALS (401)', async () => {
    const email = await makeUser();
    lockAccount(email);
    const { status, body } = await login(email, 'definitely-the-wrong-password');
    assert.equal(status, 401);
    assert.equal(body.code, 'INVALID_CREDENTIALS');
    assert.equal(body.lockedUntil, undefined, 'a wrong password must not leak that the account exists/is locked');
  });

  test('an expired lock resets the failure counter — one wrong password does not re-lock', async () => {
    const email = await makeUser();
    // Reproduce the production state: counter pinned above the cap, lock expired.
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    getDb().prepare('UPDATE users SET failed_logins = ?, locked_until = ? WHERE email = ?')
      .run(8, oneHourAgo, auth.normalizeEmail(email));

    const { status, body } = await login(email, 'the-wrong-password');
    assert.equal(status, 401);
    assert.equal(body.code, 'INVALID_CREDENTIALS');

    const user = auth.findUserByEmail(email);
    assert.equal(auth.isLocked(user), false, 'account is NOT re-locked by a single failure');
    assert.equal(user.failed_logins, 1, 'counter restarts from this single failure, not from 8');
  });

  test('a successful login clears failed_logins and locked_until', async () => {
    const email = await makeUser();
    // A couple of below-threshold failures first.
    auth.recordLoginFailure(auth.findUserByEmail(email));
    auth.recordLoginFailure(auth.findUserByEmail(email));
    assert.equal(auth.findUserByEmail(email).failed_logins, 2);

    const { status } = await login(email, PASSWORD);
    assert.equal(status, 200);

    const user = auth.findUserByEmail(email);
    assert.equal(user.failed_logins, 0, 'failed_logins reset to 0');
    assert.equal(user.locked_until, null, 'locked_until cleared');
  });
});

// --- Teardown ----------------------------------------------------------------

after(() => {
  closeDb();
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) { /* best effort */ }
});
