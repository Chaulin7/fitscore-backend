'use strict';

/**
 * src/config/privacyContact.test.js — the Privacy Policy's address for privacy
 * requests is decided on the server, so every visitor reads the same one.
 *
 * Unit: PRIVACY_CONTACT_EMAIL when it is a plain address, else the Imprint's
 * (with a boot warning that does not echo the rejected value). Then over HTTP,
 * against the real server, in both configurations: the HTML a visitor without
 * JavaScript receives already carries the address, the page has no script that
 * could swap it, and /api/meta reports the same address.
 */

const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { resolvePrivacyContact } = require('./privacyContact');
const { CONTACT_EMAIL } = require('./legal');

const REPO_ROOT = path.join(__dirname, '..', '..');

describe('resolvePrivacyContact', () => {
  test('unset or blank: the Imprint\'s address, no warning', () => {
    for (const env of [{}, { PRIVACY_CONTACT_EMAIL: '' }, { PRIVACY_CONTACT_EMAIL: '   ' }]) {
      assert.deepEqual(resolvePrivacyContact(env), { email: CONTACT_EMAIL, source: 'default', warning: null });
    }
    assert.equal(CONTACT_EMAIL, 'jasper@cvsprings.com');
  });

  test('a plain address is used as given (trimmed)', () => {
    assert.deepEqual(resolvePrivacyContact({ PRIVACY_CONTACT_EMAIL: ' privacy@cvsprings.com ' }),
      { email: 'privacy@cvsprings.com', source: 'env', warning: null });
  });

  test('anything that is not a plain address falls back, with a warning that does not repeat it', () => {
    for (const bad of ['not-an-email', 'a@b', 'x@y.com, victim@z.com', 'p@x.com"><script>alert(1)</script>', 'Name <p@x.com>']) {
      const r = resolvePrivacyContact({ PRIVACY_CONTACT_EMAIL: bad });
      assert.equal(r.email, CONTACT_EMAIL, bad);
      assert.equal(r.source, 'default');
      assert.match(r.warning, /^\[privacy\] PRIVACY_CONTACT_EMAIL is not a plain email address/);
      assert.ok(!r.warning.includes(bad), 'the rejected value is not echoed');
    }
  });
});

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  });
}

/** Boot the real server with `extraEnv`, run `fn(base, log)`, always shut it down. */
async function withServer(extraEnv, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cvs-privacy-contact-'));
  const port = await freePort();
  const base = 'http://127.0.0.1:' + port;
  const env = { ...process.env, PORT: String(port), DATABASE_PATH: path.join(tmp, 'p.db'), RETENTION_PURGE_MODE: 'dryrun', LOG_LEVEL: 'warn' };
  delete env.PRIVACY_CONTACT_EMAIL;
  Object.assign(env, extraEnv);
  const child = spawn(process.execPath, ['src/index.js'], { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  try {
    for (let i = 0; i < 80; i++) {
      if (child.exitCode !== null) throw new Error('server exited early:\n' + log);
      try { if ((await fetch(base + '/health')).ok) break; } catch (_) { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 100));
      if (i === 79) throw new Error('server did not start:\n' + log);
    }
    return await fn(base, () => log);
  } finally {
    child.kill('SIGKILL');
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
}

async function served(base) {
  const html = await (await fetch(base + '/privacy.html')).text();
  const meta = await (await fetch(base + '/api/meta')).json();
  const line = /<p id="privacyContactLine">[\s\S]*?<\/p>/.exec(html)[0];
  return { html, meta, line };
}

describe('the served Privacy Policy, without JavaScript', () => {
  test('PRIVACY_CONTACT_EMAIL unset: the page and /api/meta both say jasper@cvsprings.com', async () => {
    await withServer({}, async (base) => {
      const { html, meta, line } = await served(base);
      assert.match(line, /<span id="privacyContact"><a href="mailto:jasper@cvsprings\.com">jasper@cvsprings\.com<\/a><\/span>/);
      assert.equal(meta.privacyContact, 'jasper@cvsprings.com');
      assert.doesNotMatch(html, /<script\b/i, 'no script left to swap the address');
      assert.doesNotMatch(html, /__PRIVACY_CONTACT_EMAIL__/);
    });
  });

  test('PRIVACY_CONTACT_EMAIL set: the page and /api/meta both say that address', async () => {
    await withServer({ PRIVACY_CONTACT_EMAIL: 'privacy@cvsprings.com' }, async (base) => {
      const { html, meta, line } = await served(base);
      assert.match(line, /<span id="privacyContact"><a href="mailto:privacy@cvsprings\.com">privacy@cvsprings\.com<\/a><\/span>/);
      assert.ok(!line.includes('jasper@'), line);
      assert.equal(meta.privacyContact, 'privacy@cvsprings.com');
      assert.doesNotMatch(html, /<script\b/i);
    });
  });

  test('PRIVACY_CONTACT_EMAIL malformed: the default is shown and the boot log warns once', async () => {
    await withServer({ PRIVACY_CONTACT_EMAIL: 'p@x.com"><b>' }, async (base, log) => {
      const { html, line } = await served(base);
      assert.match(line, /mailto:jasper@cvsprings\.com/);
      assert.doesNotMatch(html, /p@x\.com"><b>/);
      assert.equal((log().match(/PRIVACY_CONTACT_EMAIL is not a plain email address/g) || []).length, 1, log());
    });
  });
});
