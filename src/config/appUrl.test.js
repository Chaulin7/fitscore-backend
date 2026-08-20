'use strict';

/**
 * src/config/appUrl.test.js — one public origin, three variable names.
 *
 * The consolidation this covers fixed a real split: reset links read
 * PUBLIC_APP_URL -> FRONTEND_URL -> APP_BASE_URL, while Stripe redirects and
 * invite emails read APP_BASE_URL alone. A deployment setting only
 * PUBLIC_APP_URL therefore got correct reset links and silently wrong Stripe
 * return URLs — wrong, not broken, which is why nothing surfaced it.
 *
 * Two things must hold from here on: every caller resolves identically, and the
 * deprecated names keep working, because an existing deployment is configured
 * with one of them right now and renaming a Render variable is a deploy, not a
 * code change.
 */

const path = require('node:path');
const fs = require('node:fs');

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const appUrl = require('./appUrl');

const VARS = ['PUBLIC_APP_URL', 'FRONTEND_URL', 'APP_BASE_URL'];
const saved = {};

beforeEach(() => {
  for (const v of VARS) { saved[v] = process.env[v]; delete process.env[v]; }
});
afterEach(() => {
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
});

const fakeReq = { protocol: 'http', get: () => 'localhost:3000' };

describe('resolution order', () => {
  test('nothing set: no configured origin, request host as fallback', () => {
    assert.equal(appUrl.configuredBaseUrl(), null);
    assert.equal(appUrl.configuredVia(), null);
    assert.equal(appUrl.baseUrlFor(fakeReq), 'http://localhost:3000');
  });

  test('the canonical variable wins', () => {
    process.env.PUBLIC_APP_URL = 'https://cvsprings.com';
    process.env.FRONTEND_URL = 'https://old.example.com';
    process.env.APP_BASE_URL = 'https://older.example.com';
    assert.equal(appUrl.configuredBaseUrl(), 'https://cvsprings.com');
    assert.equal(appUrl.configuredVia(), 'PUBLIC_APP_URL');
  });

  test('each deprecated alias still works on its own', () => {
    for (const alias of ['FRONTEND_URL', 'APP_BASE_URL']) {
      for (const v of VARS) delete process.env[v];
      process.env[alias] = 'https://alias.example.com';
      assert.equal(appUrl.configuredBaseUrl(), 'https://alias.example.com', alias);
      assert.equal(appUrl.configuredVia(), alias);
      assert.equal(appUrl.baseUrlFor(fakeReq), 'https://alias.example.com', alias);
    }
  });

  test('FRONTEND_URL outranks APP_BASE_URL', () => {
    process.env.FRONTEND_URL = 'https://second.example.com';
    process.env.APP_BASE_URL = 'https://third.example.com';
    assert.equal(appUrl.configuredBaseUrl(), 'https://second.example.com');
  });

  test('trailing slashes and stray whitespace are trimmed', () => {
    process.env.PUBLIC_APP_URL = '  https://cvsprings.com///  ';
    assert.equal(appUrl.configuredBaseUrl(), 'https://cvsprings.com');
  });

  test('an empty or whitespace-only value is treated as unset', () => {
    process.env.PUBLIC_APP_URL = '   ';
    process.env.APP_BASE_URL = 'https://fallback.example.com';
    assert.equal(appUrl.configuredBaseUrl(), 'https://fallback.example.com');
  });
});

describe('the boot warning tells an operator what is happening', () => {
  const collect = () => { const out = []; return { out, log: { warn: (m) => out.push(m) } }; };

  test('canonical only: silent', () => {
    process.env.PUBLIC_APP_URL = 'https://cvsprings.com';
    const { out, log } = collect();
    appUrl.warnDeprecatedAliases(log);
    assert.deepEqual(out, []);
  });

  test('alias only: names it and says it still works', () => {
    process.env.APP_BASE_URL = 'https://cvsprings7.onrender.com';
    const { out, log } = collect();
    appUrl.warnDeprecatedAliases(log);
    assert.equal(out.length, 1);
    assert.match(out[0], /APP_BASE_URL is a deprecated alias for PUBLIC_APP_URL/);
    assert.match(out[0], /still works/);
  });

  test('several set: says which one won and which are ignored', () => {
    process.env.PUBLIC_APP_URL = 'https://cvsprings.com';
    process.env.APP_BASE_URL = 'https://cvsprings7.onrender.com';
    const { out, log } = collect();
    appUrl.warnDeprecatedAliases(log);
    assert.equal(out.length, 1);
    assert.match(out[0], /APP_BASE_URL also set and IGNORED/);
    assert.match(out[0], /https:\/\/cvsprings\.com/);
  });

  test('none set: warns that links will use the request host', () => {
    const { out, log } = collect();
    appUrl.warnDeprecatedAliases(log);
    assert.equal(out.length, 1);
    assert.match(out[0], /no public origin set/);
    assert.match(out[0], /omit offer URLs/);
    assert.match(out[0], /Set PUBLIC_APP_URL/);
  });
});

describe('every caller goes through the one resolver', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

  test('no route reads a URL variable out of process.env directly', () => {
    for (const file of ['routes/auth.js', 'routes/billing.js', 'routes/team.js', 'index.js']) {
      const src = read(file);
      for (const v of VARS) {
        assert.doesNotMatch(src, new RegExp('process\\.env\\.' + v),
          `${file} reads ${v} directly — it must use src/config/appUrl.js`);
      }
    }
  });

  test('the four former read sites now call the shared helper', () => {
    assert.match(read('routes/auth.js'), /const base = baseUrlFor\(req\);/);
    assert.match(read('routes/billing.js'), /const appBaseUrl = baseUrlFor;/);
    assert.match(read('routes/team.js'), /const appBaseUrl = baseUrlFor;/);
    assert.match(read('index.js'), /productJsonLd\(configuredBaseUrl\(\)\)/);
  });

  test('.env.example documents the canonical name and both aliases', () => {
    const env = fs.readFileSync(path.join(__dirname, '..', '..', '.env.example'), 'utf8');
    assert.match(env, /PUBLIC_APP_URL=/);
    assert.match(env, /FRONTEND_URL=.*# deprecated alias/);
    assert.match(env, /APP_BASE_URL=.*# deprecated alias/);
  });
});
