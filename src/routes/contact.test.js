'use strict';

/**
 * src/routes/contact.test.js — POST /api/contact, the general contact form.
 *
 * Covers: delivery to CONTACT_EMAIL with the sender as Reply-To; validation
 * (each field, trimming, the strict email rule; no consent field, and an old
 * page's `consent` accepted and ignored);
 * the honeypot (normal success body, nothing sent, nothing logged); the
 * 5-an-hour per-IP limit (honeypot hits count; other addresses unaffected);
 * a failed delivery surfacing as 503 rather than a quiet 200; and — the
 * property this route exists to keep — that nothing is persisted: the module
 * does not load the database, and against the real server a submitted
 * message appears in no table, no database file and no log line.
 */

const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const express = require('express');
const contactRouter = require('./contact');
const { buildContactEmail, configWarning, NAME_MAX, MESSAGE_MAX } = require('./contact');
const { CONTACT_EMAIL } = require('../config/legal');

const REPO_ROOT = path.join(__dirname, '..', '..');
const realDeliver = contactRouter.deliver;

let sent;
let deliveryMode;
let ipCounter = 0;
let server;
let BASE;

// Each test writes from its own address, so the limiter's count from one test
// never leaks into the next. 'loopback' trusts X-Forwarded-For from the test
// client only, which is how production's `trust proxy 1` sees Render's proxy.
const freshIp = () => `203.0.113.${++ipCounter}`;

before(async () => {
  const app = express();
  app.set('trust proxy', 'loopback');
  app.use(express.json());
  app.use('/api/contact', contactRouter);
  contactRouter.deliver = async (mail) => {
    if (deliveryMode === 'throw') throw new Error('resend exploded');
    sent.push(mail);
  };
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  BASE = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  contactRouter.deliver = realDeliver;
  if (server) server.close();
});

beforeEach(() => { sent = []; deliveryMode = 'ok'; });

async function post(payload, ip = freshIp()) {
  const res = await fetch(BASE + '/api/contact', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body: JSON.stringify(payload),
  });
  let body = null;
  try { body = await res.json(); } catch (_) { /* no body */ }
  return { status: res.status, body, headers: res.headers };
}

/** Run `fn` with console.log/warn/error captured; returns [result, lines]. */
async function captureConsole(fn) {
  const lines = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(saved)) console[k] = (...args) => lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  try { return [await fn(), lines]; } finally { Object.assign(console, saved); }
}

const VALID = Object.freeze({
  name: 'Sanne de Vries',
  email: 'sanne@agency.example',
  message: 'Do you support Dutch-language job descriptions?',
  lang: 'nl',
});

describe('a valid message', () => {
  test('is delivered to the Impressum address, with the sender as Reply-To', async () => {
    const r = await post(VALID);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true });
    assert.equal(sent.length, 1);
    const mail = sent[0];
    assert.equal(mail.to, CONTACT_EMAIL);
    assert.equal(mail.to, 'jasper@cvsprings.com');
    assert.deepEqual(mail.replyTo, ['sanne@agency.example']);
    assert.match(mail.from, /@cvsprings\.com$/);
    assert.equal(mail.subject, '[Contact] Sanne de Vries');
    assert.ok(mail.text.includes(VALID.message));
    assert.match(mail.text, /^Language: nl$/m);
    assert.equal(mail.html, undefined, 'plain text only');
  });

  test('fields are trimmed before they are checked and sent', async () => {
    const r = await post({ ...VALID, name: '  Sanne  ', email: '  sanne@agency.example ', message: '\n  Hello there  \n' });
    assert.equal(r.status, 200);
    assert.deepEqual(sent[0].replyTo, ['sanne@agency.example']);
    assert.match(sent[0].text, /^Name:     Sanne$/m);
    assert.match(sent[0].text, /^Message:\nHello there\n/m);
  });

  test('an unknown language is dropped, not echoed into the email', async () => {
    await post({ ...VALID, lang: 'xx\r\nBcc: a@b.c' });
    assert.match(sent[0].text, /^Language: —$/m);
  });
});

describe('validation', () => {
  const rejects = async (payload, field, reason) => {
    const r = await post(payload);
    assert.equal(r.status, 400, JSON.stringify(payload));
    assert.equal(r.body.code, 'VALIDATION_ERROR');
    assert.equal(r.body.field, field);
    assert.equal(r.body.reason, reason);
    assert.equal(sent.length, 0, 'a rejected message must not be sent');
    return r.body;
  };

  test('name: required, and not only whitespace', async () => {
    await rejects({ ...VALID, name: undefined }, 'name', 'NAME_REQUIRED');
    await rejects({ ...VALID, name: '   ' }, 'name', 'NAME_REQUIRED');
    await rejects({ ...VALID, name: 42 }, 'name', 'NAME_REQUIRED');
  });

  test(`name: at most ${NAME_MAX} characters`, async () => {
    const body = await rejects({ ...VALID, name: 'x'.repeat(NAME_MAX + 1) }, 'name', 'NAME_TOO_LONG');
    assert.deepEqual(body.params, { max: NAME_MAX });
    assert.equal((await post({ ...VALID, name: 'x'.repeat(NAME_MAX) })).status, 200);
  });

  test('email: required, and strict enough to be a safe Reply-To', async () => {
    for (const email of [undefined, '', 'not-an-email', 'a@b', 'a,victim@partner.example', 'Name<attacker@evil.example>', 'a b@c.example']) {
      await rejects({ ...VALID, email }, 'email', undefined);
    }
  });

  test(`message: required, at most ${MESSAGE_MAX} characters`, async () => {
    await rejects({ ...VALID, message: '' }, 'message', 'REQUIRED');
    await rejects({ ...VALID, message: ' \n\t ' }, 'message', 'REQUIRED');
    const body = await rejects({ ...VALID, message: 'y'.repeat(MESSAGE_MAX + 1) }, 'message', 'TOO_LONG');
    assert.deepEqual(body.params, { max: MESSAGE_MAX });
  });

  test('consent is not required, and an old page that still sends it gets through', async () => {
    assert.equal((await post(VALID)).status, 200, 'no consent field');
    for (const consent of [true, false, 'on', null]) {
      const r = await post({ ...VALID, consent });
      assert.equal(r.status, 200, `consent: ${JSON.stringify(consent)}`);
    }
    assert.equal(sent.length, 5);
    assert.ok(sent.every((m) => !/consent/i.test(m.text)), 'the field is ignored, not forwarded');
  });

  test('the page has no consent checkbox, and its notice line links the Privacy Policy', () => {
    const page = fs.readFileSync(path.join(REPO_ROOT, 'public', 'contact.html'), 'utf8');
    assert.doesNotMatch(page, /type="checkbox"|c-consent|consent_html/);
    assert.match(page, /<p class="form-fine" data-i18n-html="contact\.form\.notice_html">We use your details only to answer your enquiry\. See our <a href="\/privacy\.html"[^>]*>privacy policy<\/a>\.<\/p>/);
    for (const lang of ['en', 'nl', 'de']) {
      const dict = require(`../../locales/${lang}.json`);
      assert.equal(dict['errors.VALIDATION_ERROR.consent.REQUIRED'], undefined, `${lang}: stale consent error`);
      assert.equal(dict['contact.form.consent_html'], undefined, `${lang}: stale checkbox label`);
    }
  });

  test('every error the form can receive has words in en, nl and de', () => {
    for (const lang of ['en', 'nl', 'de']) {
      const dict = require(`../../locales/${lang}.json`);
      for (const key of [
        'errors.VALIDATION_ERROR.NAME_REQUIRED', 'errors.VALIDATION_ERROR.NAME_TOO_LONG',
        'errors.VALIDATION_ERROR.email', 'errors.VALIDATION_ERROR.message.REQUIRED',
        'errors.VALIDATION_ERROR.message.TOO_LONG',
        'errors.RATE_LIMITED.CONTACT_LIMIT', 'errors.CONTACT_UNAVAILABLE',
      ]) assert.ok(dict[key], `${lang}: ${key}`);
    }
  });
});

describe('the honeypot', () => {
  test('a filled `website` field gets the normal success body and nothing else', async () => {
    const [r, lines] = await captureConsole(() => post({ ...VALID, website: 'https://spam.example' }));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true }, 'indistinguishable from a real success');
    assert.equal(sent.length, 0, 'nothing sent');
    assert.deepEqual(lines, [], 'nothing logged');
  });

  test('it short-circuits even an otherwise invalid submission', async () => {
    const r = await post({ website: 'x' });
    assert.equal(r.status, 200);
    assert.equal(sent.length, 0);
  });

  test('a whitespace-only value is a human leaving it empty', async () => {
    const r = await post({ ...VALID, website: '   ' });
    assert.equal(r.status, 200);
    assert.equal(sent.length, 1);
  });
});

describe('rate limiting: 5 an hour per IP', () => {
  test('the 6th request from one address is refused with RATE_LIMITED / CONTACT_LIMIT', async () => {
    const ip = freshIp();
    for (let i = 0; i < 5; i++) assert.equal((await post(VALID, ip)).status, 200, `request ${i + 1}`);
    assert.equal(sent.length, 5);
    const r = await post(VALID, ip);
    assert.equal(r.status, 429);
    assert.equal(r.body.code, 'RATE_LIMITED');
    assert.equal(r.body.reason, 'CONTACT_LIMIT');
    assert.ok(r.headers.get('ratelimit-reset') || r.headers.get('retry-after'), 'tells the client when to retry');
    assert.equal(sent.length, 5, 'the refused message is not sent');
  });

  test('honeypot hits and invalid submissions count too', async () => {
    const ip = freshIp();
    for (let i = 0; i < 3; i++) await post({ ...VALID, website: 'bot' }, ip);
    for (let i = 0; i < 2; i++) await post({ ...VALID, email: 'nope' }, ip);
    assert.equal((await post(VALID, ip)).status, 429);
    assert.equal(sent.length, 0);
  });

  test('another address is unaffected', async () => {
    const busy = freshIp();
    for (let i = 0; i < 6; i++) await post(VALID, busy);
    assert.equal((await post(VALID)).status, 200);
  });
});

describe('delivery failure', () => {
  test('is a 503 the sender sees, with the address to write to instead', async () => {
    deliveryMode = 'throw';
    const marker = 'unique-' + crypto.randomBytes(6).toString('hex');
    const [r, lines] = await captureConsole(() => post({ ...VALID, message: marker }));
    assert.equal(r.status, 503);
    assert.equal(r.body.code, 'CONTACT_UNAVAILABLE');
    assert.deepEqual(r.body.params, { email: CONTACT_EMAIL });
    assert.ok(lines.some((l) => l.includes('[contact] delivery failed')), 'the operator hears about it');
    assert.ok(!lines.join('\n').includes(marker), 'the log line does not carry the message');
    assert.ok(!lines.join('\n').includes(VALID.email), 'nor the sender\'s address');
  });

  test('without an API key, production refuses rather than dropping the message', async () => {
    const saved = { key: process.env.RESEND_API_KEY, env: process.env.NODE_ENV };
    delete process.env.RESEND_API_KEY;
    try {
      process.env.NODE_ENV = 'production';
      await assert.rejects(realDeliver({ to: CONTACT_EMAIL, text: 'x' }), /RESEND_API_KEY/);
      process.env.NODE_ENV = 'development';
      const [, lines] = await captureConsole(() => realDeliver({ to: CONTACT_EMAIL, text: 'secret message body', replyTo: ['a@b.example'] }));
      assert.equal(lines.length, 1);
      assert.ok(!lines[0].includes('secret message body') && !lines[0].includes('a@b.example'), 'dev log is metadata only: ' + lines[0]);
    } finally {
      if (saved.key === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = saved.key;
      if (saved.env === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = saved.env;
    }
  });
});

describe('the boot-time configuration warning', () => {
  test('silent when both RESEND_API_KEY and CONTACT_FROM_EMAIL are set', () => {
    assert.equal(configWarning({ RESEND_API_KEY: 're_x', CONTACT_FROM_EMAIL: 'contact@cvsprings.com' }), null);
  });

  test('names a missing API key and says what it means, per environment', () => {
    const prod = configWarning({ NODE_ENV: 'production', CONTACT_FROM_EMAIL: 'contact@cvsprings.com' });
    assert.match(prod, /^\[contact\] contact form not fully configured: RESEND_API_KEY not set — every message is refused with 503/);
    assert.match(configWarning({ CONTACT_FROM_EMAIL: 'a@b.example' }), /messages are logged as metadata, not sent/);
  });

  test('names a missing sender and the default it falls back to', () => {
    assert.match(configWarning({ RESEND_API_KEY: 're_x' }), /CONTACT_FROM_EMAIL not set — sending from the default contact@cvsprings\.com, which must be a Resend-verified sender/);
  });

  test('both missing: still one line', () => {
    const w = configWarning({});
    assert.match(w, /RESEND_API_KEY and CONTACT_FROM_EMAIL not set/);
    assert.doesNotMatch(w, /\n/);
  });

  test('never prints a secret', () => {
    const w = configWarning({ RESEND_API_KEY: 're_SECRET_value_123', NODE_ENV: 'production' });
    assert.ok(!w.includes('re_SECRET_value_123'), w);
  });
});

describe('the email cannot be forged from the form', () => {
  test('a name with CRLF or bidi controls stays a one-line subject', () => {
    const { subject, text } = buildContactEmail({
      name: 'Eve\r\nBcc: victim@example.com‮gnp.exe',
      email: 'eve@example.com',
      message: 'hi‮there',
      lang: 'en',
      receivedAt: '2026-10-01T10:00:00.000Z',
    });
    assert.doesNotMatch(subject, /[\r\n‮]/);
    assert.doesNotMatch(text.split('\nMessage:\n')[0], /‮|\nBcc:/);
    assert.doesNotMatch(text, /‮/);
  });
});

describe('nothing is persisted', () => {
  test('the route does not load the database layer', () => {
    // A clean process, so this file's own requires cannot mask a regression.
    const out = execFileSync(process.execPath, ['-e',
      "require('./src/routes/contact'); console.log(JSON.stringify(Object.keys(require.cache).filter((k) => /services[\\\\/]db\\.js$|better-sqlite3/.test(k))))",
    ], { cwd: REPO_ROOT, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(out), []);
  });

  describe('against the real server', () => {
    const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cvs-contact-'));
    const DB_PATH = path.join(TMP_DIR, 'contact.db');
    let child = null;
    let output = '';
    let base = '';

    before(async () => {
      const port = await new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.unref();
        probe.on('error', reject);
        probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolve(p)); });
      });
      base = 'http://127.0.0.1:' + port;
      const env = { ...process.env, PORT: String(port), DATABASE_PATH: DB_PATH, RETENTION_PURGE_MODE: 'dryrun', LOG_LEVEL: 'info', NODE_ENV: 'test' };
      delete env.RESEND_API_KEY; // the dev path: delivery is logged as metadata, not sent
      delete env.CONTACT_FROM_EMAIL;
      child = spawn(process.execPath, ['src/index.js'], { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', (d) => { output += d; });
      child.stderr.on('data', (d) => { output += d; });
      for (let i = 0; i < 80; i++) {
        if (child.exitCode !== null) throw new Error('server exited early:\n' + output);
        try { if ((await fetch(base + '/health')).ok) break; } catch (_) { /* not up yet */ }
        await new Promise((r) => setTimeout(r, 100));
        if (i === 79) throw new Error('server did not start:\n' + output);
      }
    });

    after(() => {
      if (child) child.kill('SIGKILL');
      try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}
    });

    test('boot logs exactly one configuration warning, at warn level, without values', () => {
      const lines = output.split('\n').filter((l) => l.includes('contact form not fully configured'));
      assert.equal(lines.length, 1, output);
      const entry = JSON.parse(lines[0]);
      assert.equal(entry.level, 40, 'pino warn, not error');
      assert.match(entry.msg, /RESEND_API_KEY and CONTACT_FROM_EMAIL not set/);
    });

    test('a delivered message leaves no trace in the database, its files or the logs', async () => {
      const marker = 'zq' + crypto.randomBytes(8).toString('hex');
      const res = await fetch(base + '/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Name ' + marker, email: marker + '@example.com', message: 'Body ' + marker, lang: 'de' }),
      });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });
      await new Promise((r) => setTimeout(r, 300)); // let any async write or log flush

      assert.match(output, /\[contact\] RESEND_API_KEY unset — would deliver/, 'the delivery path really ran');
      assert.ok(!output.includes(marker), 'no log line carries the name, address or message');

      // Every row of every table, read through SQLite (sees WAL content too)…
      const Database = require('better-sqlite3');
      const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
      try {
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name);
        assert.ok(tables.length > 5, 'the schema exists, so the scan means something');
        for (const t of tables) {
          const rows = db.prepare(`SELECT * FROM "${t.replace(/"/g, '""')}"`).all();
          assert.ok(!JSON.stringify(rows).includes(marker), `table ${t} holds the message`);
        }
      } finally { db.close(); }

      // …and the raw bytes of every file the database keeps.
      for (const f of fs.readdirSync(TMP_DIR)) {
        assert.ok(!fs.readFileSync(path.join(TMP_DIR, f)).includes(marker), `${f} contains the message`);
      }
    });
  });
});

describe('the Privacy Policy describes the contact form', () => {
  const privacy = fs.readFileSync(path.join(REPO_ROOT, 'public', 'privacy.html'), 'utf8');
  const section = (/<!-- =+ SECTION C — CONTACT FORM =+ -->([\s\S]*?)<\/div>\s*<\/div>/.exec(privacy) || [])[1] || '';

  test('in its own section: purpose, data, legal basis, delivery, retention, rights', () => {
    assert.ok(section, 'privacy.html has no contact-form section');
    for (const phrase of [
      'only to answer your enquiry',
      'Your name, your email address and your message',
      'With your message we also receive the language of the page you used and the time it was sent.',
      'To prevent abuse, your IP address is held in memory for up to one hour for rate limiting; it is not stored.',
      'Art. 6(1)(f) GDPR', 'Art. 6(1)(b) GDPR',
      'only delivered to us as an email via Resend', 'not stored in our database',
      'within 12 months of your enquiry being resolved',
      'href="#privacyContactLine"',
    ]) assert.ok(section.includes(phrase), `missing: ${phrase}`);
    assert.match(privacy, /id="privacyContactLine"/, 'the rights section it points to exists');
  });

  test('the International transfers bullet: what Resend processes, where, and under which safeguard', () => {
    const bullet = /<li><strong>Email:<\/strong>[\s\S]*?<\/li>/.exec(privacy)[0];
    assert.equal(bullet, '<li><strong>Email:</strong> Resend is US-based and processes the emails described in the Resend row above: to recruiter accounts, invited team members and demo requesters, and the contact-form messages, demo requests and feature requests sent to our inbox. '
      + 'Emails are sent from Resend&rsquo;s EU region (Ireland). Because Resend, Inc. is a US company, any transfer of this data to the US is covered by the '
      + 'European Commission&rsquo;s Standard Contractual Clauses included in Resend&rsquo;s Data Processing Agreement.</li>');
  });

  test('privacy requests have a real address to go to, which PRIVACY_CONTACT_EMAIL still overrides', () => {
    assert.match(privacy, /<span id="privacyContact"><a href="mailto:__CONTACT_EMAIL__">__CONTACT_EMAIL__<\/a><\/span>/);
    assert.match(privacy, /if \(d && d\.privacyContact\)/, 'the script still swaps in the configured address');
  });

  test('the Resend subprocessor row includes contact-form messages', () => {
    // Comments stripped: the TODO beside the row quotes the old wording.
    const row = /<td>Resend<\/td>[\s\S]*?<\/tr>/.exec(privacy)[0].replace(/<!--[\s\S]*?-->/g, '');
    assert.doesNotMatch(row, /recruiter email addresses only/);
    assert.match(row, /contact-form messages/);
  });

  test('Resend is described as in use, not optional', () => {
    const visible = privacy.replace(/<!--[\s\S]*?-->/g, '');
    assert.doesNotMatch(visible, /Resend \(optional\)|Email \(if enabled\)|only if the operator has configured it/);
    assert.doesNotMatch(privacy, /TODO\(operator\): state whether Resend is enabled/);
  });

  test('Render: Frankfurt (EU) and the SCC safeguard, in the row and in the Hosting bullet', () => {
    const row = /<td>Render<\/td>[\s\S]*?<\/tr>/.exec(privacy)[0];
    assert.ok(row.includes('<td>Render, Inc. (US company). Service region: Frankfurt, Germany (EU). Because Render, Inc. is a US company, any transfer of data to the US is covered by the '
      + 'European Commission&rsquo;s Standard Contractual Clauses included in Render&rsquo;s Data Processing Agreement.</td>'), row);
    const hosting = /<li><strong>Hosting:<\/strong>[\s\S]*?<\/li>/.exec(privacy)[0];
    assert.match(hosting, /Render&rsquo;s Frankfurt \(EU Central\) region, so candidate data at rest does not leave the EU\/EEA\./);
    assert.match(hosting, /covered by the European Commission&rsquo;s Standard Contractual Clauses included in Render&rsquo;s Data Processing Agreement\./);
    assert.doesNotMatch(privacy, /TODO\(operator\): confirm (the )?region/);
  });
});
