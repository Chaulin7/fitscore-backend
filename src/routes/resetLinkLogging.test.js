'use strict';

/**
 * src/routes/resetLinkLogging.test.js — a password-reset link is a working
 * credential. Without an email provider the server used to print it (with the
 * account's address) to the console whatever NODE_ENV was, so a production
 * deploy missing RESEND_API_KEY would have written live reset links into its
 * logs. It now prints only when NODE_ENV is 'development'.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cvs-reset-log-'));
process.env.DATABASE_PATH = path.join(TMP_DIR, 'reset.db');

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const { deliverResetLink } = require('./auth');

const EMAIL = 'recruiter@agency.example';
const LINK = 'https://cvsprings.test/?reset_token=SECRET-TOKEN-123';

after(() => { try { require('../services/db').closeDb(); } catch (_) {} try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {} });

async function logsUnder(nodeEnv) {
  const saved = { env: process.env.NODE_ENV, key: process.env.RESEND_API_KEY };
  const lines = [];
  const out = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const k of Object.keys(out)) console[k] = (...a) => lines.push(a.map(String).join(' '));
  delete process.env.RESEND_API_KEY;
  if (nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = nodeEnv;
  try {
    await deliverResetLink(EMAIL, LINK);
    return lines.join('\n');
  } finally {
    Object.assign(console, out);
    if (saved.env === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = saved.env;
    if (saved.key !== undefined) process.env.RESEND_API_KEY = saved.key;
  }
}

test('never in production: no link, no address — just a warning', async () => {
  const log = await logsUnder('production');
  assert.doesNotMatch(log, /SECRET-TOKEN-123|reset_token/);
  assert.ok(!log.includes(EMAIL));
  assert.match(log, /RESEND_API_KEY unset — password reset email not sent/);
});

test('not under test, staging or an unset NODE_ENV either', async () => {
  for (const env of ['test', 'staging', '', undefined]) {
    const log = await logsUnder(env);
    assert.doesNotMatch(log, /SECRET-TOKEN-123/, `NODE_ENV=${env}`);
    assert.ok(!log.includes(EMAIL), `NODE_ENV=${env}`);
  }
});

test('only on a development machine is the link printed', async () => {
  const log = await logsUnder('development');
  assert.match(log, /\[auth\] Password reset link for recruiter@agency\.example: https:\/\/cvsprings\.test\/\?reset_token=SECRET-TOKEN-123/);
});

test('the only statement that prints the link sits behind the development check', () => {
  const src = fs.readFileSync(path.join(__dirname, 'auth.js'), 'utf8');
  const prints = [...src.matchAll(/console\.\w+\([^;]*resetLink[^;]*\);/g)];
  assert.equal(prints.length, 1);
  const before = src.slice(0, prints[0].index);
  assert.match(before.slice(before.lastIndexOf('if (')), /^if \(process\.env\.NODE_ENV === 'development'\) \{\s*$/);
});
