'use strict';

/**
 * src/routes/demo.test.js — POST /api/demo-request when email fails.
 *
 * The lead is stored before any email is attempted, so it is never lost. But a
 * failed send is a failure: logged, and answered with 502 DEMO_EMAIL_FAILED,
 * which the landing page words as "we saved your request, but you may not
 * receive a confirmation". Resend's SDK resolves { error } instead of
 * throwing, so a resolved error must count too — that was the bug.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cvs-demo-'));
process.env.DATABASE_PATH = path.join(TMP_DIR, 'demo.db');

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const db = require('../services/db');
const demoRouter = require('./demo');

const realClient = demoRouter.resendClient;
let server;
let BASE;
let ip = 0;
let calls;
let behaviour; // { notification: 'ok'|'resolved-error'|'throw', confirmation: … }

function fakeClient() {
  return {
    emails: {
      send: async (mail) => {
        const kind = /^Demo request —/.test(mail.subject) ? 'notification' : 'confirmation';
        calls.push(kind);
        const b = behaviour[kind] || 'ok';
        if (b === 'throw') throw new Error(`${kind} network down`);
        if (b === 'resolved-error') return { data: null, error: { name: 'validation_error', message: `${kind} rejected` } };
        return { data: { id: `re_${kind}` }, error: null };
      },
    },
  };
}

before(async () => {
  db.getDb();
  const app = express();
  app.set('trust proxy', 'loopback');
  app.use(express.json());
  app.use('/api/demo-request', demoRouter);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  BASE = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  demoRouter.resendClient = realClient;
  if (server) server.close();
  try { db.closeDb(); } catch (_) {}
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}
});
beforeEach(() => {
  calls = [];
  behaviour = {};
  demoRouter.resendClient = fakeClient;
  process.env.DEMO_NOTIFY_EMAIL = 'jasper@cvsprings.com';
  db.getDb().prepare('DELETE FROM demo_requests').run();
});

const LEAD = { name: 'Sanne de Vries', email: 'sanne@agency.example', agency: 'Agency BV', note: 'finance roles' };
async function post(body = LEAD) {
  const res = await fetch(BASE + '/api/demo-request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `198.51.100.${++ip}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}
const stored = () => db.getDb().prepare('SELECT email FROM demo_requests').all().map((r) => r.email);

async function capture(fn) {
  const lines = [];
  const saved = { log: console.log, error: console.error, warn: console.warn };
  for (const k of Object.keys(saved)) console[k] = (...a) => lines.push(a.map(String).join(' '));
  try { return [await fn(), lines]; } finally { Object.assign(console, saved); }
}

describe('both emails delivered', () => {
  test('200, the lead is stored, both emails went out', async () => {
    const r = await post();
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true });
    assert.deepEqual(stored(), ['sanne@agency.example']);
    assert.deepEqual(calls.sort(), ['confirmation', 'notification']);
  });
});

describe('a failed send is a failure — and the lead is still saved', () => {
  for (const [kind, how] of [['confirmation', 'resolved-error'], ['confirmation', 'throw'], ['notification', 'resolved-error'], ['notification', 'throw']]) {
    test(`${kind} ${how === 'throw' ? 'throws' : 'resolves { error }'}: 502 DEMO_EMAIL_FAILED, lead stored, logged, the other email still tried`, async () => {
      behaviour[kind] = how;
      const [r, lines] = await capture(() => post());
      assert.equal(r.status, 502);
      assert.equal(r.body.code, 'DEMO_EMAIL_FAILED');
      assert.deepEqual(stored(), ['sanne@agency.example'], 'the lead is not lost');
      assert.deepEqual(calls.sort(), ['confirmation', 'notification'], 'both sends were attempted');
      const log = lines.join('\n');
      assert.match(log, new RegExp(`\\[demo\\] email delivery failed \\(lead stored\\): ${kind}: `));
      assert.doesNotMatch(log, /sanne@agency\.example|Sanne de Vries|finance roles/, 'the log names no one');
    });
  }

  test('no provider in production: 502, lead stored', async () => {
    demoRouter.resendClient = () => null;
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const [r] = await capture(() => post());
      assert.equal(r.status, 502);
      assert.equal(r.body.code, 'DEMO_EMAIL_FAILED');
      assert.deepEqual(stored(), ['sanne@agency.example']);
    } finally {
      if (saved === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = saved;
    }
  });

  test('no provider in development: 200, and the log carries metadata only', async () => {
    demoRouter.resendClient = () => null;
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      const [r, lines] = await capture(() => post());
      assert.equal(r.status, 200);
      assert.doesNotMatch(lines.join('\n'), /sanne@agency\.example|Sanne de Vries|Agency BV|finance roles/);
    } finally {
      if (saved === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = saved;
    }
  });
});

test('the honeypot is unchanged: success body, nothing stored, nothing sent', async () => {
  const r = await post({ ...LEAD, website: 'https://spam.example' });
  assert.equal(r.status, 200);
  assert.deepEqual(stored(), []);
  assert.deepEqual(calls, []);
});

describe('the landing page words the failure in every language', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf8');

  test('it recognises the code and shows landing.demo.form.emailFailed', () => {
    assert.match(page, /body\.code==='DEMO_EMAIL_FAILED'\)\{ showFormError\(I18N\.t\('landing\.demo\.form\.emailFailed'\)\)/);
  });

  test('en, nl and de all have the sentence, and it says the request was saved', () => {
    const saved = { en: /We saved your request/, nl: /We hebben je aanvraag opgeslagen/, de: /Wir haben Ihre Anfrage gespeichert/ };
    for (const lang of ['en', 'nl', 'de']) {
      const dict = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'locales', `${lang}.json`), 'utf8'));
      assert.match(dict['landing.demo.form.emailFailed'], saved[lang], lang);
    }
  });
});
