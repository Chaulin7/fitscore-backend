'use strict';

/**
 * src/services/dbIsolation.test.js — no test may open the real database.
 *
 * Every suite in this repo sets DATABASE_PATH to a throwaway file before
 * requiring services/db. That was a convention held up by nothing: a suite that
 * forgot would silently open data/audit.db — the developer's own dev database —
 * migrate its schema, write rows into it, and leave WAL sidecars behind. The
 * failure is invisible, because opening it SUCCEEDS.
 *
 * That is not hypothetical. It happened while building the checkout flow tests:
 * a harness process required services/db without setting DATABASE_PATH and
 * opened data/audit.db.
 *
 * services/db.assertNotTheRealDatabase() now makes the convention a
 * precondition, enforced at connection time whenever NODE_TEST_CONTEXT is set
 * (which `node --test` sets in every test child, and which is inherited by
 * servers those tests spawn). These tests confirm it fires, and confirm it
 * stays out of the way in production, where the same fallback path is correct.
 *
 * The child processes below deliberately do NOT set DATABASE_PATH. They must
 * therefore never reach a real connection — which is exactly what is asserted.
 */

process.env.DATABASE_PATH = require('node:path').join(
  require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'cvsprings-dbguard-')),
  'guard-test.db',
);

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const REPO_ROOT = path.join(__dirname, '..', '..');
const DEFAULT_DB = path.join(REPO_ROOT, 'data', 'audit.db');

/**
 * Run a snippet in a fresh node process with a controlled environment.
 *
 * The three variables this guard reads are stripped unless the case supplies
 * them, so each test states its own situation rather than inheriting one. That
 * matters most for NODE_TEST_CONTEXT: this parent process is itself running
 * under `node --test`, so without the strip every child would look like a test
 * run and the production-fallback case could never be expressed.
 */
function runChild(code, env = {}) {
  const childEnv = { ...process.env, ...env };
  for (const key of ['DATABASE_PATH', 'DB_PATH', 'NODE_TEST_CONTEXT']) {
    if (!(key in env)) delete childEnv[key];
  }
  const r = spawnSync(process.execPath, ['-e', code], {
    cwd: REPO_ROOT, env: childEnv, encoding: 'utf8',
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

const OPEN_DEFAULT_DB = "require('./src/services/db').getDb(); console.log('OPENED');";

describe('a test that forgets DATABASE_PATH cannot reach the real database', () => {
  test('services/db refuses the default path under the test runner', () => {
    const r = runChild(OPEN_DEFAULT_DB, { NODE_TEST_CONTEXT: 'child-v8' });

    assert.notEqual(r.status, 0, 'the child must fail, not open the database');
    assert.doesNotMatch(r.stdout, /OPENED/);
    // The message has to be actionable: what it refused, and what to do.
    assert.match(r.stderr, /refusing to open the default database from a test run/);
    assert.match(r.stderr, /data\/audit\.db/);
    assert.match(r.stderr, /Set process\.env\.DATABASE_PATH to a throwaway file/);
  });

  test('routes/templates — the second connection to the same file — refuses too', () => {
    // This router holds its OWN better-sqlite3 handle on the same file, so
    // guarding services/db alone would leave a back door. Driven through a real
    // request, because the router's connection is lazy and module-private.
    const r = runChild([
      "const express=require('express');",
      "const app=express();",
      // stand in for requireSession, which this router expects upstream
      "app.use('/api/templates',function(req,_res,next){req.orgId='org-x';req.userId='user-x';next();},require('./src/routes/templates'));",
      'const srv=app.listen(0,async function(){',
      "  const r=await fetch('http://127.0.0.1:'+srv.address().port+'/api/templates');",
      "  console.log('STATUS:'+r.status);",
      '  srv.close();',
      '});',
    ].join('\n'), { NODE_TEST_CONTEXT: 'child-v8' });

    // The request must fail rather than serve rows out of the real database.
    assert.match(r.stdout, /STATUS:5\d\d/, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout, /STATUS:200/);
  });

  test('an explicit throwaway path is accepted', () => {
    const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'cvsprings-guard-ok-'));
    const dbFile = path.join(tmp, 'explicit.db');
    const r = runChild(OPEN_DEFAULT_DB, { NODE_TEST_CONTEXT: 'child-v8', DATABASE_PATH: dbFile });

    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /OPENED/);
    assert.ok(fs.existsSync(dbFile), 'it should have opened the file it was given');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('DB_PATH, the legacy alias, is also explicit enough', () => {
    const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'cvsprings-guard-legacy-'));
    const dbFile = path.join(tmp, 'legacy.db');
    const r = runChild(OPEN_DEFAULT_DB, { NODE_TEST_CONTEXT: 'child-v8', DB_PATH: dbFile });

    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(dbFile));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('outside a test run the default path is still the correct fallback', () => {
    // Production and `npm run dev` rely on it. Asserted by checking the guard
    // function directly rather than by opening anything: this test must not be
    // the thing that touches data/audit.db.
    const r = runChild(
      "const db=require('./src/services/db'); db.assertNotTheRealDatabase(); console.log('ALLOWED:'+db.DEFAULT_DB_PATH);",
    );
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /ALLOWED:.*data[/\\]audit\.db/);
  });
});

describe('the guard leaves no trace on the real database', () => {
  test('no WAL sidecar was created beside data/audit.db', () => {
    // A blocked open must not have gotten far enough to create -wal/-shm.
    // (If the dev database does not exist on this machine, there is nothing to
    // check and nothing that could have been damaged.)
    if (!fs.existsSync(DEFAULT_DB)) return;
    for (const sidecar of [DEFAULT_DB + '-wal', DEFAULT_DB + '-shm']) {
      assert.equal(fs.existsSync(sidecar), false,
        `${path.basename(sidecar)} exists — something opened the real database`);
    }
  });
});
