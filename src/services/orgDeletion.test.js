'use strict';

/**
 * src/services/orgDeletion.test.js — account deletion on request
 * (services/orgDeletion.js, scripts/delete-org.js).
 *
 * A target organization and a neighbour are seeded with a row in EVERY table
 * the deletion handles. Then: the dry run shows counts and deletes nothing;
 * the real run asks for the organization's name and does nothing on a wrong
 * one; it refuses while a Stripe subscription has not ended; a confirmed run
 * removes every linked row in one go and leaves the neighbour whole; and the
 * schema is read back to prove no table that references an organization or a
 * user is missing from the list.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cvs-org-delete-'));
const DB_PATH = path.join(TMP_DIR, 'org-delete.db');
process.env.DATABASE_PATH = DB_PATH;

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const db = require('./db');
require('../routes/templates'); // creates the templates table, as the server does
const { planOrgDeletion, deleteOrgCompletely, TABLES, UNRELATED } = require('./orgDeletion');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'delete-org.js');
const conn = () => db.getDb();

before(() => { db.getDb(); });
after(() => { try { db.closeDb(); } catch (_) {} try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {} });

// audit_log.candidate_fk is set, as on every real row: a NULL one would be
// adopted by the legacy-candidate backfill the next time a process opens the
// database, and the script's process would count one more row than the test.
const VALUES = { feature_requests: { category: 'product' }, audit_log: { candidate_fk: 'seeded-candidate' } };
let seq = 0;
/** Insert one row into `table`, filling NOT NULL columns from the schema. */
function insert(table, values) {
  const cols = conn().prepare(`PRAGMA table_info("${table}")`).all();
  const row = {};
  for (const c of cols) {
    if (values[c.name] !== undefined) row[c.name] = values[c.name];
    else if ((VALUES[table] || {})[c.name] !== undefined) row[c.name] = VALUES[table][c.name];
    else if (c.pk || c.notnull) row[c.name] = /INT/i.test(c.type) ? 1 : `${table}-${c.name}-${++seq}`;
  }
  const names = Object.keys(row);
  conn().prepare(`INSERT INTO "${table}" (${names.map((n) => `"${n}"`).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`).run(...names.map((n) => row[n]));
}

/** An organization with one row in every handled table. */
function seedOrg(name, { subscriptionStatus = null, subscriptionId = null } = {}) {
  const orgId = `org-${name.replace(/\W/g, '').toLowerCase()}-${++seq}`;
  const email = `owner${seq}@${name.replace(/\W/g, '').toLowerCase()}.example`;
  const userId = `user-${seq}`;
  conn().prepare('INSERT INTO organizations (id, name, created_at) VALUES (?, ?, ?)').run(orgId, name, new Date().toISOString());
  conn().prepare('UPDATE organizations SET stripe_customer_id = ?, stripe_subscription_id = ?, subscription_status = ?, brand_logo_data = ? WHERE id = ?')
    .run(`cus_${seq}`, subscriptionId, subscriptionStatus, 'data:image/png;base64,AAAA', orgId);
  insert('users', { id: userId, email, org_id: orgId });
  for (const [table, how] of TABLES) {
    if (table === 'users' || table === 'organizations') continue;
    if (how === 'org' || how === 'org+emails') insert(table, { org_id: orgId });
    if (how === 'users') insert(table, { user_id: userId });
    if (how === 'emails' || how === 'org+emails') insert(table, { email: `  ${email.toUpperCase()} ` });
  }
  return { orgId, email, name };
}

function runScript(args, input) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    env: { ...process.env, DATABASE_PATH: DB_PATH, NODE_TEST_CONTEXT: '' }, input: input === undefined ? '' : input, encoding: 'utf8', timeout: 30000,
  });
  return { code: r.status, out: r.stdout + r.stderr };
}

const total = (orgId) => (planOrgDeletion(orgId) || { total: 0 }).total;

beforeEach(() => {
  for (const { name } of conn().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()) {
    if (name === 'audit_changes') { conn().exec('DROP TRIGGER IF EXISTS audit_changes_no_delete'); conn().prepare('DELETE FROM audit_changes').run(); conn().exec(db.AUDIT_CHANGES_NO_DELETE_TRIGGER); continue; }
    conn().prepare(`DELETE FROM "${name}"`).run();
  }
});

describe('the plan (dry run)', () => {
  test('counts every linked row, names the org, and changes nothing', () => {
    const a = seedOrg('Acme Recruitment');
    seedOrg('Neighbour BV');
    const plan = planOrgDeletion(a.orgId);
    assert.equal(plan.name, 'Acme Recruitment');
    for (const [table] of TABLES) assert.ok(plan.counts[table] >= 1, `${table}: ${plan.counts[table]}`);
    assert.equal(plan.counts.trial_invites, 2, 'the org\'s offer and an offer to its user\'s address');
    const r = runScript([a.orgId, '--dry-run']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Organization: Acme Recruitment/);
    assert.match(r.out, /Stripe subscription: none on record/);
    assert.match(r.out, /audit_log\s+1/);
    assert.match(r.out, new RegExp(`total\\s+${plan.total}`));
    assert.match(r.out, /Dry run: nothing deleted\./);
    assert.equal(total(a.orgId), plan.total, 'nothing deleted');
    assert.doesNotMatch(r.out, /@/, 'no email address is printed');
  });
});

describe('confirmation', () => {
  test('a wrong or missing name deletes nothing', () => {
    const a = seedOrg('Acme Recruitment');
    const before = total(a.orgId);
    for (const input of ['Acme', 'acme recruitment', '']) {
      const r = runScript([a.orgId], input + '\n');
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /The name does not match\. Nothing deleted\./);
      assert.equal(total(a.orgId), before);
    }
  });

  test('the exact name deletes the organization and everything linked to it — and nothing else', () => {
    const a = seedOrg('Acme Recruitment', { subscriptionId: 'sub_1', subscriptionStatus: 'canceled' });
    const b = seedOrg('Neighbour BV');
    const neighbour = planOrgDeletion(b.orgId).counts;
    const r = runScript([a.orgId], 'Acme Recruitment\n');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Deleted:/);
    assert.equal(planOrgDeletion(a.orgId), null, 'the organization is gone');
    for (const [table] of TABLES) {
      if (table === 'organizations') continue;
      const linked = conn().prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n;
      assert.equal(linked, neighbour[table], `${table}: only the neighbour's rows remain`);
    }
    assert.deepEqual(planOrgDeletion(b.orgId).counts, neighbour, 'the neighbour is untouched');
    assert.doesNotMatch(r.out, /@/);
  });

  test('the append-only guard on the change history is back afterwards', () => {
    const a = seedOrg('Acme Recruitment');
    deleteOrgCompletely(a.orgId);
    const trig = conn().prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'audit_changes_no_delete'").get();
    assert.ok(trig);
    insert('audit_changes', { org_id: 'other' });
    assert.throws(() => conn().prepare('DELETE FROM audit_changes').run(), /append-only/);
  });
});

describe('refuses while a Stripe subscription has not ended', () => {
  for (const status of ['active', 'trialing', 'past_due', 'paused', 'unpaid']) {
    test(status, () => {
      const a = seedOrg('Acme Recruitment', { subscriptionId: 'sub_1', subscriptionStatus: status });
      const before = total(a.orgId);
      const r = runScript([a.orgId], 'Acme Recruitment\n');
      assert.equal(r.code, 2, r.out);
      assert.match(r.out, /Refusing: the Stripe subscription has not ended/);
      assert.equal(total(a.orgId), before, 'nothing deleted, even with the right name');
      assert.throws(() => deleteOrgCompletely(a.orgId), /has not ended/);
    });
  }

  test('a subscription id with no status is treated as not ended', () => {
    const a = seedOrg('Acme Recruitment', { subscriptionId: 'sub_1' });
    assert.equal(planOrgDeletion(a.orgId).subscription.active, true);
  });

  test('ended (canceled, incomplete_expired) or none at all is allowed', () => {
    for (const s of [{ subscriptionId: 'sub_1', subscriptionStatus: 'canceled' }, { subscriptionId: 'sub_2', subscriptionStatus: 'incomplete_expired' }, {}]) {
      const a = seedOrg('Acme Recruitment', s);
      assert.equal(planOrgDeletion(a.orgId).subscription.active, false, JSON.stringify(s));
    }
  });
});

describe('every table is accounted for', () => {
  test('each table in the schema is either deleted from or declared unrelated', () => {
    const tables = conn().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
    const handled = new Set(TABLES.map(([t]) => t));
    const unclassified = tables.filter((t) => !handled.has(t) && !UNRELATED[t]);
    assert.deepEqual(unclassified, [], 'add each new table to TABLES (or UNRELATED, with a reason) in src/services/orgDeletion.js');
  });

  test('every table that references an organization or a user is deleted from, never "unrelated"', () => {
    const tables = conn().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
    const handled = new Set(TABLES.map(([t]) => t));
    const linked = tables.filter((t) => conn().prepare(`PRAGMA table_info("${t}")`).all()
      .some((c) => /^(org_id|user_id|owner_id|consumed_by_user_id|organization_id)$/.test(c.name) || /_org_id$|_user_id$/.test(c.name)));
    assert.ok(linked.length >= 15, linked.join(', '));
    for (const t of linked) assert.ok(handled.has(t), `${t} references an organization or user but is not deleted by orgDeletion`);
    assert.deepEqual(Object.keys(UNRELATED), ['metrics_daily']);
  });

  test('the script never talks to Stripe', () => {
    for (const f of [SCRIPT, path.join(__dirname, 'orgDeletion.js')]) {
      const src = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      assert.doesNotMatch(src, /require\(['"]stripe['"]\)|services\/billing|api\.stripe\.com/);
    }
  });
});
