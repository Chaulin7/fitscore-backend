'use strict';

/**
 * src/services/demoRetention.test.js — demo requests are deleted 12 months after
 * we receive them, unless the requester has become a customer (Privacy Policy,
 * section D).
 *
 * Boundaries on a fixed clock: a request received exactly 12 calendar months ago
 * stays; one received a millisecond earlier goes. A requester with an account
 * (matched case-insensitively) stays and is counted. Dry-run deletes nothing;
 * live clears more than one batch; the log carries counts only; and the daily
 * schedule actually calls the purge.
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cvs-demo-retention-'));
process.env.DATABASE_PATH = path.join(TMP_DIR, 'demo-retention.db');

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const db = require('./db');
const { getDb, closeDb, purgeStaleDemoRequests, demoRequestCutoffIso, DEMO_REQUEST_RETENTION_MONTHS } = db;

const NOW = Date.parse('2026-10-03T12:00:00.000Z');
const CUTOFF = '2025-10-03T12:00:00.000Z';
const iso = (ms) => new Date(ms).toISOString();

before(() => { getDb(); });
after(() => { try { closeDb(); } catch (_) {} try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {} });
beforeEach(() => {
  getDb().prepare('DELETE FROM demo_requests').run();
  getDb().prepare('DELETE FROM users').run();
});

let n = 0;
function demo(createdAt, email = `lead${++n}@agency.example`, extra = {}) {
  const id = `demo-${++n}`;
  getDb().prepare('INSERT INTO demo_requests (id, name, email, agency, note, created_at, ip_hash) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, extra.name || 'Sanne', email, extra.agency || 'Agency', extra.note || null, createdAt, 'h');
  return id;
}
function customer(email) {
  getDb().prepare('INSERT INTO users (id, email, password_hash, org_id, role, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(`u-${++n}`, email, 'x', 'org-1', 'owner', iso(NOW));
}
const ids = () => getDb().prepare('SELECT id FROM demo_requests ORDER BY id').all().map((r) => r.id).sort();

async function quietly(fn) {
  const lines = [];
  const saved = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try { return [fn(), lines]; } finally { console.log = saved; }
}

describe('the 12-month cutoff', () => {
  test('is 12 calendar months before now', () => {
    assert.equal(DEMO_REQUEST_RETENTION_MONTHS, 12);
    assert.equal(demoRequestCutoffIso(NOW), CUTOFF);
    assert.equal(demoRequestCutoffIso(Date.parse('2027-01-15T00:00:00.000Z')), '2026-01-15T00:00:00.000Z');
  });
});

describe('live purge', () => {
  test('boundaries: exactly 12 months old stays, a millisecond older goes', async () => {
    const atCutoff = demo(CUTOFF);
    const justOlder = demo(iso(Date.parse(CUTOFF) - 1));
    const justNewer = demo(iso(Date.parse(CUTOFF) + 1));
    const ancient = demo('2023-01-01T00:00:00.000Z');
    const fresh = demo(iso(NOW - 1000));
    const [r] = await quietly(() => purgeStaleDemoRequests({ now: NOW, mode: 'live' }));
    assert.equal(r.rowsDeleted, 2);
    assert.deepEqual(ids(), [atCutoff, justNewer, fresh].sort());
    assert.ok(!ids().includes(justOlder) && !ids().includes(ancient));
  });

  test('a requester who became a customer is kept (email matched case-insensitively)', async () => {
    customer('sanne@agency.example');
    const old = demo('2024-05-01T00:00:00.000Z', '  Sanne@Agency.Example ');
    const stranger = demo('2024-05-01T00:00:00.000Z', 'someone@else.example');
    const [r] = await quietly(() => purgeStaleDemoRequests({ now: NOW, mode: 'live' }));
    assert.equal(r.rowsDeleted, 1);
    assert.equal(r.keptAsCustomers, 1);
    assert.deepEqual(ids(), [old]);
    assert.ok(!ids().includes(stranger));
  });

  test('clears more than one batch', async () => {
    const insert = getDb().prepare('INSERT INTO demo_requests (id, name, email, agency, note, created_at, ip_hash) VALUES (?, NULL, ?, NULL, NULL, ?, NULL)');
    getDb().transaction(() => { for (let i = 0; i < 2500; i++) insert.run(`bulk-${i}`, `b${i}@x.example`, '2024-01-01T00:00:00.000Z'); })();
    const keep = demo(iso(NOW));
    const [r] = await quietly(() => purgeStaleDemoRequests({ now: NOW, mode: 'live' }));
    assert.equal(r.rowsDeleted, 2500);
    assert.deepEqual(ids(), [keep]);
  });

  test('logs counts only — never a name, address or note', async () => {
    demo('2024-01-01T00:00:00.000Z', 'secret.person@agency.example', { name: 'Secret Person', note: 'private note text' });
    const [, lines] = await quietly(() => purgeStaleDemoRequests({ now: NOW, mode: 'live' }));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^\[retention\] demo requests \(mode=live\): 1 older than 12 months deleted, 0 kept \(requester is a customer\)$/);
    assert.doesNotMatch(lines.join('\n'), /secret|private note|agency\.example/i);
  });
});

describe('dry run (anything but RETENTION_PURGE_MODE=live)', () => {
  test('counts what would go and deletes nothing', async () => {
    demo('2024-01-01T00:00:00.000Z');
    demo('2024-01-01T00:00:00.000Z');
    demo(iso(NOW));
    const before = ids();
    const [r, lines] = await quietly(() => purgeStaleDemoRequests({ now: NOW, mode: 'dryrun' }));
    assert.equal(r.rowsDeleted, 0);
    assert.equal(r.rowsAffected, 2);
    assert.deepEqual(ids(), before);
    assert.match(lines[0], /2 older than 12 months would be deleted/);
  });

  test('the default mode comes from RETENTION_PURGE_MODE, like the audit purge', async () => {
    const saved = process.env.RETENTION_PURGE_MODE;
    try {
      delete process.env.RETENTION_PURGE_MODE;
      demo('2024-01-01T00:00:00.000Z');
      const [r] = await quietly(() => purgeStaleDemoRequests({ now: NOW }));
      assert.equal(r.mode, 'dryrun');
      assert.equal(ids().length, 1);
    } finally {
      if (saved === undefined) delete process.env.RETENTION_PURGE_MODE; else process.env.RETENTION_PURGE_MODE = saved;
    }
  });
});

test('the daily retention schedule runs the demo purge', () => {
  const src = fs.readFileSync(path.join(__dirname, 'db.js'), 'utf8');
  const start = /function startRetentionSchedule\(\) \{([\s\S]*?)\n\}/.exec(src)[1];
  assert.match(start, /if \(retentionPurgeDue\(\)\) \{ runRetentionPurge\(\); purgeStaleDemoRequests\(\); purgeExpiredTrialOffers\(\); \}/);
});
