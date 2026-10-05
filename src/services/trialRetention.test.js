'use strict';

/**
 * src/services/trialRetention.test.js — trial offers nobody took up are deleted
 * 12 months after they expired; offers that were taken up are kept (Privacy
 * Policy, section F).
 *
 * Both kinds of untaken offer are covered: one never clicked (no trial org, so
 * the existing abandoned-trial sweep never saw it), and one clicked but
 * abandoned before checkout (the sweep's case, now run 12 months late).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cvs-trial-retention-'));
process.env.DATABASE_PATH = path.join(TMP_DIR, 'trial-retention.db');

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const db = require('./db');
const auth = require('./authService');

const NOW = Date.parse('2026-10-03T12:00:00.000Z');
const CUTOFF = Date.parse('2025-10-03T12:00:00.000Z'); // 12 calendar months earlier
const iso = (ms) => new Date(ms).toISOString();

before(() => { db.getDb(); });
after(() => { try { db.closeDb(); } catch (_) {} try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {} });
beforeEach(() => {
  const d = db.getDb();
  d.prepare('DELETE FROM trial_emails').run();
  d.prepare('DELETE FROM trial_invites').run();
});

let seq = 0;
function offer({ expiresAt, started = false, redeemed = false, consumed = false, subscription = false } = {}) {
  seq += 1;
  const token = `bbbbbbbb-0000-4000-8000-${String(seq).padStart(12, '0')}`;
  db.createTrialInvite({ token, email: `prospect${seq}@agency.example`, companyName: `Agency ${seq}`, campaign: 'q4', expiresAt });
  let orgId = null;
  if (started) {
    orgId = auth.createOrganization(`Trial ${seq}`).id;
    db.getDb().prepare('UPDATE trial_invites SET org_id = ?, stripe_customer_id = ? WHERE token = ?').run(orgId, `cus_${seq}`, token);
    db.logTrialEmail({ orgId, subscriptionId: `s${seq}`, kind: 'trial_welcome', toEmail: `prospect${seq}@agency.example` });
    if (subscription) db.getDb().prepare("UPDATE organizations SET stripe_subscription_id = ?, subscription_status = 'trialing' WHERE id = ?").run(`sub_${seq}`, orgId);
  }
  if (redeemed) db.getDb().prepare('UPDATE trial_invites SET redeemed_at = ? WHERE token = ?').run(iso(NOW), token);
  if (consumed) db.getDb().prepare('UPDATE trial_invites SET consumed_at = ? WHERE token = ?').run(iso(NOW), token);
  return { token, orgId };
}
const exists = (token) => !!db.findTrialInviteByToken(token);
const orgExists = (id) => !!db.getDb().prepare('SELECT 1 FROM organizations WHERE id = ?').get(id);

function run(mode = 'live') {
  const lines = [];
  const saved = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try { return { r: db.purgeExpiredTrialOffers({ now: NOW, mode }), lines }; } finally { console.log = saved; }
}

describe('offers nobody took up', () => {
  test('never started: deleted once it expired 12 months ago, not a millisecond sooner', () => {
    const due = offer({ expiresAt: iso(CUTOFF) });
    const older = offer({ expiresAt: '2024-01-01T00:00:00.000Z' });
    const notYet = offer({ expiresAt: iso(CUTOFF + 1) });
    const recent = offer({ expiresAt: iso(NOW - 30 * 86400000) });
    const { r } = run();
    assert.equal(r.neverStarted, 2);
    assert.equal(exists(due.token), false);
    assert.equal(exists(older.token), false);
    assert.equal(exists(notYet.token), true);
    assert.equal(exists(recent.token), true);
  });

  test('started, then abandoned before checkout: the offer, its email log and the empty org go — after 12 months', () => {
    const old = offer({ expiresAt: '2024-06-01T00:00:00.000Z', started: true });
    const young = offer({ expiresAt: iso(NOW - 60 * 86400000), started: true });
    const { r } = run();
    assert.equal(r.abandoned, 1);
    assert.equal(exists(old.token), false);
    assert.equal(orgExists(old.orgId), false);
    assert.equal(db.listTrialEmails(old.orgId).length, 0);
    assert.equal(exists(young.token), true, 'expired only 2 months ago: the admin sweep may take it by hand, the daily purge does not');
    assert.equal(orgExists(young.orgId), true);
  });
});

describe('offers that were taken up stay (customer relationship)', () => {
  test('redeemed (checkout completed), consumed (account created) or with a subscription', () => {
    const redeemed = offer({ expiresAt: '2024-01-01T00:00:00.000Z', redeemed: true });
    const consumed = offer({ expiresAt: '2024-01-01T00:00:00.000Z', consumed: true });
    const subscribed = offer({ expiresAt: '2024-01-01T00:00:00.000Z', started: true, subscription: true });
    const { r } = run();
    assert.equal(r.rowsDeleted, 0);
    for (const o of [redeemed, consumed, subscribed]) assert.equal(exists(o.token), true);
    assert.equal(db.listTrialEmails(subscribed.orgId).length, 1);
    assert.equal(r.kept, 1, 'the subscribed one is reported as kept by the sweep');
  });
});

describe('mode and logging', () => {
  test('dry run counts and deletes nothing', () => {
    const a = offer({ expiresAt: '2024-01-01T00:00:00.000Z' });
    const b = offer({ expiresAt: '2024-01-01T00:00:00.000Z', started: true });
    const { r, lines } = run('dryrun');
    assert.equal(r.rowsDeleted, 0);
    assert.equal(r.neverStarted + r.abandoned, 2);
    assert.ok(exists(a.token) && exists(b.token) && orgExists(b.orgId));
    assert.match(lines.join('\n'), /would be deleted/);
  });

  test('the log carries counts only', () => {
    offer({ expiresAt: '2024-01-01T00:00:00.000Z' });
    const { lines } = run();
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^\[retention\] trial offers \(mode=live\): 1 never started and 0 abandoned, expired over 12 months ago, deleted; 0 kept \(taken up\)$/);
    assert.doesNotMatch(lines[0], /agency\.example|Agency \d/);
  });
});
