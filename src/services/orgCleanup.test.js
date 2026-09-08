'use strict';

/**
 * src/services/orgCleanup.test.js — the DELETE on the organizations table.
 *
 * deleteOrganizationIfEmpty runs on the signup path, for every signup, against
 * the one table the entire product is scoped by. A stranded empty org is a
 * blemish; a deleted populated one is unrecoverable. These tests are written
 * around that asymmetry: most of them assert that it REFUSES.
 *
 * The emptiness check is derived from the schema rather than from a list, and
 * the first block below is why. The hand-maintained list this replaced named
 * eight tables; the schema has fifteen.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cvs-orgcleanup-'));
process.env.DATABASE_PATH = path.join(TMP_DIR, 'test.db');

const db = require('./db');
const auth = require('./authService');

before(() => { db.getDb(); });
after(() => { try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {} });

const provisional = (name) => auth.createOrganization(name, { provisional: true });
const orgExists = (id) => !!db.getDb().prepare('SELECT 1 FROM organizations WHERE id = ?').get(id);

describe('the org-scoped table list is derived from the schema', () => {
  test('it finds every table carrying an org_id column', () => {
    const d = db.getDb();
    const allTables = d.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    ).all().map((r) => r.name);

    const expected = allTables.filter((t) => t !== 'organizations'
      && d.prepare(`PRAGMA table_info(${t})`).all().some((c) => c.name === 'org_id'));

    assert.deepEqual([...db.orgScopedTables()].sort(), expected.sort());
    assert.ok(expected.length >= 15, `expected the schema to have many org-scoped tables, found ${expected.length}`);
  });

  test('it includes the tables the old hand-maintained list forgot', () => {
    // These seven were absent from the list this replaced, so an org holding
    // any of them passed the emptiness check and was deleted.
    const forgotten = [
      'usage_counters', 'purge_runs', 'analysis_provenance', 'run_nonces',
      'audit_changes', 'trial_emails', 'admin_access_log',
    ];
    for (const table of forgotten) {
      assert.ok(db.orgScopedTables().includes(table), `${table} must be checked`);
    }
  });

  test('it does not include organizations itself, nor tables scoped to a user', () => {
    for (const table of ['organizations', 'sessions', 'password_resets', 'metrics_daily', 'demo_requests']) {
      assert.equal(db.orgScopedTables().includes(table), false, `${table} must not be treated as a child`);
    }
  });
});

describe('the throwaway path still works', () => {
  test('a provisional, empty, brand-new org is deleted', () => {
    const org = provisional('Throwaway BV');
    assert.equal(orgExists(org.id), true);
    assert.equal(db.deleteOrganizationIfEmpty(org.id, { createdAt: org.createdAt }), true);
    assert.equal(orgExists(org.id), false);
  });

  test('a second call is a no-op rather than an error', () => {
    const org = provisional('Throwaway Two BV');
    assert.equal(db.deleteOrganizationIfEmpty(org.id, { createdAt: org.createdAt }), true);
    assert.equal(db.deleteOrganizationIfEmpty(org.id, { createdAt: org.createdAt }), false);
  });
});

describe('it refuses an org with ANY child row', () => {
  // One case per org-scoped table, generated from the derived list, so a table
  // added later is covered here the moment it exists.
  const seeded = {
    users: (id) => db.getDb().prepare(
      'INSERT INTO users (id, email, password_hash, org_id, role, created_at) VALUES (?,?,?,?,?,?)',
    ).run(`u-${id}`, `u-${id}@x.test`, 'h', id, 'owner', db.nowIso()),
    usage_counters: (id) => db.getDb().prepare(
      'INSERT INTO usage_counters (org_id, period_key, analysis_count) VALUES (?,?,?)',
    ).run(id, '2026-09', 1),
    templates: (id) => db.getDb().prepare(
      'INSERT INTO templates (id, name, org_id, created_at, updated_at) VALUES (?,?,?,?,?)',
    ).run(`t-${id}`, 'T', id, db.nowIso(), db.nowIso()),
    trial_emails: (id) => db.logTrialEmail({
      orgId: id, subscriptionId: 's', kind: 'trial_welcome', toEmail: 'x@x.test',
    }),
  };

  for (const [table, seed] of Object.entries(seeded)) {
    test(`a row in ${table} blocks the delete`, () => {
      const org = provisional(`Occupied ${table}`);
      seed(org.id);
      assert.equal(db.deleteOrganizationIfEmpty(org.id, { createdAt: org.createdAt }), false);
      assert.equal(orgExists(org.id), true, 'the org survived');
    });
  }

  test('a Stripe customer blocks it, even with no child rows at all', () => {
    const org = provisional('Has Customer BV');
    db.setOrgStripeCustomerId(org.id, 'cus_real');
    assert.equal(db.deleteOrganizationIfEmpty(org.id, { createdAt: org.createdAt }), false);
    assert.equal(orgExists(org.id), true);
  });
});

describe('it cannot reach an org outside the current request', () => {
  test('a NON-provisional org is refused even when completely empty', () => {
    // Every organization that has ever been used has provisional_until NULL.
    // This is the guard that holds even if the emptiness check is wrong.
    const org = auth.createOrganization('Real Company BV');
    assert.equal(db.deleteOrganizationIfEmpty(org.id, { createdAt: org.createdAt }), false);
    assert.equal(orgExists(org.id), true);
  });

  test('an org whose provisional window has passed is refused, though empty', () => {
    const org = provisional('Stale Provisional BV');
    db.getDb().prepare('UPDATE organizations SET provisional_until = ? WHERE id = ?')
      .run(new Date(Date.now() - 1000).toISOString(), org.id);
    assert.equal(db.deleteOrganizationIfEmpty(org.id, { createdAt: org.createdAt }), false);
    assert.equal(orgExists(org.id), true);
  });

  test('the window is a small number of seconds, not hours', () => {
    assert.ok(db.PROVISIONAL_ORG_TTL_MS <= 5 * 60 * 1000,
      `the provisional window must stay short, got ${db.PROVISIONAL_ORG_TTL_MS}ms`);
  });

  test('a mismatched createdAt is refused — it is not the row this request made', () => {
    const org = provisional('Wrong Timestamp BV');
    assert.equal(db.deleteOrganizationIfEmpty(org.id, { createdAt: '2020-01-01T00:00:00.000Z' }), false);
    assert.equal(orgExists(org.id), true);
  });

  test('omitting createdAt entirely is refused rather than treated as a wildcard', () => {
    const org = provisional('No Timestamp BV');
    assert.equal(db.deleteOrganizationIfEmpty(org.id), false);
    assert.equal(db.deleteOrganizationIfEmpty(org.id, {}), false);
    assert.equal(orgExists(org.id), true);
  });

  test('an unknown org id deletes nothing', () => {
    assert.equal(db.deleteOrganizationIfEmpty('no-such-org', { createdAt: db.nowIso() }), false);
    assert.equal(db.deleteOrganizationIfEmpty(null, { createdAt: db.nowIso() }), false);
  });

  test('clearProvisional puts an org permanently out of reach', () => {
    const org = provisional('Kept BV');
    db.clearProvisional(org.id);
    assert.equal(db.deleteOrganizationIfEmpty(org.id, { createdAt: org.createdAt }), false);
    assert.equal(orgExists(org.id), true);
  });

  test('organizations created by every other caller are non-provisional by default', () => {
    const org = auth.createOrganization('Default BV');
    const row = db.getDb().prepare('SELECT provisional_until AS p FROM organizations WHERE id = ?').get(org.id);
    assert.equal(row.p, null, 'the safe value is the default');
  });
});
