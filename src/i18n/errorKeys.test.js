'use strict';

/**
 * src/i18n/errorKeys.test.js — every error the app can show has words.
 *
 * The app shows an API error translated by its code (and reason / field),
 * falling back to the server's English. That fallback is a safety net, not a
 * plan: a new code added on the server without an errors.* key would reach a
 * Dutch or German reader in English. This scans the server for every code it
 * sends, and every `reason` it attaches, and requires a translation for each —
 * except the codes that only ever reach an operator, a webhook or the
 * generic-failure path (where the app shows its own sentence instead).
 */

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..', '..');
const EN = require('../../locales/en.json');

// Never shown to a customer as-is.
const NOT_SHOWN = new Set([
  'INTERNAL_ERROR', 'BAD_REQUEST', 'NOT_FOUND', // the caller's own sentence is shown
  'BAD_SIGNATURE', 'WEBHOOK_HANDLER_ERROR', // Stripe webhooks
  'CORS_DENIED', // a misconfigured origin, not a user
  'ACCOUNT_LOCKED', // the sign-in screen words it itself (auth.login.locked*)
]);
// Admin-only routes (the operator console), not the app.
const ADMIN_FILES = /adminTrialInvites|adminMetrics|adminAuth|trialStart/;

function sources() {
  const out = [];
  for (const dir of ['src/routes', 'src/services', 'src/middleware']) {
    for (const f of fs.readdirSync(path.join(ROOT, dir))) {
      if (!f.endsWith('.js') || f.endsWith('.test.js') || ADMIN_FILES.test(f)) continue;
      out.push([dir + '/' + f, fs.readFileSync(path.join(ROOT, dir, f), 'utf8')]);
    }
  }
  return out;
}

const has = (key) => Object.prototype.hasOwnProperty.call(EN, key)
  || Object.keys(EN).some((k) => k.startsWith(key + '.'));

test('every error code the app can receive has an errors.* translation', () => {
  const missing = [];
  for (const [file, src] of sources()) {
    const codes = new Set([
      ...[...src.matchAll(/sendError\(res,\s*\d+,\s*'([A-Z_]+)'/g)].map((m) => m[1]),
      ...[...src.matchAll(/\bcode:\s*'([A-Z_]{4,})'/g)].map((m) => m[1]),
      ...[...src.matchAll(/extractionError\([^;]*?'([A-Z_]{6,})',\s*4\d\d/g)].map((m) => m[1]),
    ]);
    for (const code of codes) {
      if (NOT_SHOWN.has(code)) continue;
      if (!has('errors.' + code)) missing.push(`${code} (${file})`);
    }
  }
  assert.deepEqual(missing, [], 'add errors.<CODE> to locales/*.json for: ' + missing.join(', '));
});

test('every reason the server attaches has a translation under its code', () => {
  const missing = [];
  for (const [file, src] of sources()) {
    // reason: 'X' next to a code: 'Y' in the same object, or err(…, field, 'X') in fileSecurity.
    for (const m of src.matchAll(/code:\s*'([A-Z_]+)'[^}]*?reason:\s*'([A-Z_]+)'|reason:\s*'([A-Z_]+)'[^}]*?code:\s*'([A-Z_]+)'/g)) {
      const code = m[1] || m[4]; const reason = m[2] || m[3];
      if (!Object.keys(EN).some((k) => k.startsWith('errors.' + code + '.') && k.endsWith('.' + reason))) missing.push(`${code}.${reason} (${file})`);
    }
    const pairs = [
      // sendError(res, 400, 'CODE', …, { reason: 'X' … }) — within the one statement
      ...[...src.matchAll(/sendError\(res,\s*\d+,\s*'([A-Z_]+)'(?:(?!sendError\(|;)[\s\S])*?\{\s*reason:\s*'([A-Z_]+)'/g)].map((m) => [m[1], m[2]]),
      // team.js: sendError(res, 403, 'CODE', message, field, 'REASON', params)
      ...[...src.matchAll(/sendError\(res,\s*\d+,\s*'([A-Z_]+)',(?:(?!sendError\(|;)[\s\S])*?,\s*null,\s*'([A-Z_]+)'/g)].map((m) => [m[1], m[2]]),
      // pdfExtractor: extractionError(message, 'CODE', 4xx, cause, { reason: 'X' })
      ...[...src.matchAll(/'([A-Z_]{6,})',\s*4\d\d,[^;]*?reason:\s*'([A-Z_]+)'/g)].map((m) => [m[1], m[2]]),
    ];
    for (const [code, reason] of pairs) {
      if (!Object.keys(EN).some((k) => k.startsWith('errors.' + code + '.') && k.endsWith('.' + reason))) missing.push(`${code}.${reason} (${file})`);
    }
    if (/fileSecurity/.test(file)) {
      for (const m of src.matchAll(/throw err\([\s\S]*?,\s*field,\s*'([A-Z_]+)'/g)) {
        if (!has('errors.INVALID_FILE.' + m[1])) missing.push(`INVALID_FILE.${m[1]} (${file})`);
      }
    }
  }
  assert.deepEqual(missing, [], 'add errors.<CODE>.<REASON> for: ' + missing.join(', '));
});

test('the scan finds the codes it is meant to (guards a vacuous pass)', () => {
  const all = sources().map(([, s]) => s).join('\n');
  for (const code of ['QUOTA_EXCEEDED', 'SEAT_LIMIT', 'IMAGE_ONLY_PDF', 'SUBSCRIPTION_PAUSED', 'RETENTION_BELOW_FLOOR']) {
    assert.match(all, new RegExp("'" + code + "'"), code);
  }
  assert.match(all, /'LOGO_TYPE'/);
});

test('the reason scan sees each way a reason is attached (guards a vacuous pass)', () => {
  const planted = [
    "sendError(res, 409, 'SUBSCRIPTION_PAUSED', 'x' + 'y', { reason: 'PLANTED_A' });",
    "sendError(res, 403, 'SEAT_LIMIT', `x`, null,\n 'PLANTED_B', { max: 1 });",
    "extractionError('x', 'INVALID_FILE', 400, undefined, { reason: 'PLANTED_C' })",
  ].join('\n');
  const found = [
    ...planted.matchAll(/sendError\(res,\s*\d+,\s*'([A-Z_]+)'(?:(?!sendError\(|;)[\s\S])*?\{\s*reason:\s*'([A-Z_]+)'/g),
    ...planted.matchAll(/sendError\(res,\s*\d+,\s*'([A-Z_]+)',(?:(?!sendError\(|;)[\s\S])*?,\s*null,\s*'([A-Z_]+)'/g),
    ...planted.matchAll(/'([A-Z_]{6,})',\s*4\d\d,[^;]*?reason:\s*'([A-Z_]+)'/g),
  ].map((m) => m[2]);
  assert.deepEqual(found.sort(), ['PLANTED_A', 'PLANTED_B', 'PLANTED_C']);
});
