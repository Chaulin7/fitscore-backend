'use strict';

/**
 * src/services/trialInvites.test.js — the four ways a trial token resolves.
 *
 * A token is the only credential on GET /start, which is unauthenticated and
 * hands out subscriptions. So the four outcomes are pinned here directly rather
 * than through the route: valid, expired, already redeemed, unknown.
 *
 * Both layers are exercised. validateInvite() is pure — a row and a clock in, a
 * verdict out — and gets the boundary cases, because "expired" is a comparison
 * that is off by one in one direction or the other. validateToken() goes through
 * the real table, so the lookup and the column names are covered too and a
 * renamed column cannot pass silently.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cvs-trial-token-'));
process.env.DATABASE_PATH = path.join(TMP_DIR, 'test.db');

const db = require('./db');
const trial = require('./trialInvites');

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-01-01T00:00:00.000Z');

before(() => { db.getDb(); });
after(() => { try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {} });

/** A row shaped exactly as db.findTrialInviteByToken returns one. */
function row(overrides = {}) {
  return {
    token: '11111111-1111-4111-8111-111111111111',
    email: 'ops@example.com',
    companyName: 'Example Recruitment',
    campaign: 'q1-agencies',
    createdAt: new Date(T0).toISOString(),
    redeemedAt: null,
    expiresAt: new Date(T0 + 30 * DAY).toISOString(),
    orgId: null,
    stripeCustomerId: null,
    plan: null,
    convertedAt: null,
    ...overrides,
  };
}

describe('validateInvite — the pure verdict', () => {
  test('a fresh, unredeemed, unexpired token is valid', () => {
    const result = trial.validateInvite(row(), T0 + DAY);
    assert.equal(result.ok, true);
    assert.equal(result.reason, null);
    assert.equal(result.invite.email, 'ops@example.com');
  });

  test('an unknown token reports UNKNOWN and carries no invite', () => {
    const result = trial.validateInvite(null, T0);
    assert.equal(result.ok, false);
    assert.equal(result.reason, trial.REASON.UNKNOWN);
    assert.equal(result.invite, null);
  });

  test('a token past its expiry reports EXPIRED', () => {
    const result = trial.validateInvite(row(), T0 + 31 * DAY);
    assert.equal(result.ok, false);
    assert.equal(result.reason, trial.REASON.EXPIRED);
  });

  test('a redeemed token reports ALREADY_REDEEMED', () => {
    const result = trial.validateInvite(row({ redeemedAt: new Date(T0 + DAY).toISOString() }), T0 + 2 * DAY);
    assert.equal(result.ok, false);
    assert.equal(result.reason, trial.REASON.ALREADY_REDEEMED);
  });

  test('redemption is reported ahead of expiry when a token is both', () => {
    // Order is deliberate: a token that was used and has since lapsed was USED,
    // and telling that operator "the link expired" sends them looking for a
    // replacement for a link that worked perfectly well.
    const used = row({ redeemedAt: new Date(T0 + DAY).toISOString() });
    const result = trial.validateInvite(used, T0 + 90 * DAY);
    assert.equal(result.reason, trial.REASON.ALREADY_REDEEMED);
  });

  test('expires_at is the first instant the token no longer works', () => {
    const invite = row();
    const expiry = Date.parse(invite.expiresAt);
    assert.equal(trial.validateInvite(invite, expiry - 1).ok, true, 'one ms before: still valid');
    assert.equal(trial.validateInvite(invite, expiry).ok, false, 'exactly at expiry: spent');
    assert.equal(trial.validateInvite(invite, expiry).reason, trial.REASON.EXPIRED);
  });

  test('an unparseable expiry fails closed rather than never expiring', () => {
    const result = trial.validateInvite(row({ expiresAt: 'not-a-date' }), T0);
    assert.equal(result.ok, false);
    assert.equal(result.reason, trial.REASON.EXPIRED);
  });
});

describe('validateToken — through the real table', () => {
  const valid = '22222222-2222-4222-8222-222222222222';
  const expired = '33333333-3333-4333-8333-333333333333';
  const redeemed = '44444444-4444-4444-8444-444444444444';

  before(() => {
    db.createTrialInvite({
      token: valid, email: 'valid@example.com', companyName: 'Valid Co', campaign: 'q1',
      expiresAt: new Date(T0 + 30 * DAY).toISOString(), createdAt: new Date(T0).toISOString(),
    });
    db.createTrialInvite({
      token: expired, email: 'expired@example.com', companyName: 'Expired Co', campaign: 'q1',
      expiresAt: new Date(T0 + DAY).toISOString(), createdAt: new Date(T0).toISOString(),
    });
    db.createTrialInvite({
      token: redeemed, email: 'redeemed@example.com', companyName: 'Redeemed Co', campaign: 'q1',
      expiresAt: new Date(T0 + 30 * DAY).toISOString(), createdAt: new Date(T0).toISOString(),
    });
    db.markTrialInviteRedeemed(redeemed, { redeemedAt: new Date(T0 + DAY).toISOString(), orgId: 'org-x' });
  });

  test('valid', () => {
    const result = trial.validateToken(valid, T0 + 2 * DAY);
    assert.equal(result.ok, true);
    assert.equal(result.invite.companyName, 'Valid Co');
    assert.equal(result.invite.campaign, 'q1');
  });

  test('expired', () => {
    const result = trial.validateToken(expired, T0 + 2 * DAY);
    assert.equal(result.ok, false);
    assert.equal(result.reason, trial.REASON.EXPIRED);
  });

  test('already redeemed', () => {
    const result = trial.validateToken(redeemed, T0 + 2 * DAY);
    assert.equal(result.ok, false);
    assert.equal(result.reason, trial.REASON.ALREADY_REDEEMED);
    assert.equal(result.invite.orgId, 'org-x', 'redemption recorded what it was spent on');
  });

  test('unknown', () => {
    const result = trial.validateToken('99999999-9999-4999-8999-999999999999', T0);
    assert.equal(result.ok, false);
    assert.equal(result.reason, trial.REASON.UNKNOWN);
  });

  test('a malformed token never reaches the database', () => {
    for (const bad of [null, undefined, '', '   ', 'not-a-uuid', "' OR 1=1 --", 'x'.repeat(5000)]) {
      const result = trial.validateToken(bad, T0);
      assert.equal(result.ok, false, `rejected: ${String(bad).slice(0, 20)}`);
      assert.equal(result.reason, trial.REASON.MALFORMED);
    }
  });

  test('redemption is single-use even under a concurrent second attempt', () => {
    const token = '55555555-5555-4555-8555-555555555555';
    db.createTrialInvite({
      token, email: 'race@example.com', companyName: 'Race Co', campaign: 'q1',
      expiresAt: new Date(T0 + 30 * DAY).toISOString(), createdAt: new Date(T0).toISOString(),
    });
    const first = db.markTrialInviteRedeemed(token, { orgId: 'org-a' });
    const second = db.markTrialInviteRedeemed(token, { orgId: 'org-b' });
    assert.equal(first, true, 'the first redemption wins');
    assert.equal(second, false, 'the second is refused by the SQL guard, not by a re-read');
    assert.equal(db.findTrialInviteByToken(token).orgId, 'org-a', 'and cannot be reassigned');
  });
});

describe('minting', () => {
  test('a batch produces one uuid token and one full URL per prospect', () => {
    const result = trial.mintInvites(
      [
        { email: 'A@Example.com', company_name: 'Alpha BV', campaign: 'q1-agencies' },
        { email: 'b@example.com', company_name: 'Beta BV', campaign: 'q1-agencies' },
      ],
      { baseUrl: 'https://cvsprings.com/' },
      T0,
    );
    assert.equal(result.ok, true);
    assert.equal(result.invites.length, 2);
    assert.equal(result.invites[0].email, 'a@example.com', 'addresses are normalised');
    assert.match(result.invites[0].url, /^https:\/\/cvsprings\.com\/start\?t=[0-9a-f-]{36}$/);
    assert.equal(trial.isWellFormedToken(result.invites[0].token), true);
    assert.notEqual(result.invites[0].token, result.invites[1].token);
    assert.equal(result.invites[0].trial_period_days, 30);
  });

  test('expiry defaults to 30 days out and is overridable per request', () => {
    const dflt = trial.mintInvites([{ email: 'c@example.com' }], { baseUrl: 'https://x.test' }, T0);
    assert.equal(dflt.invites[0].expires_at, new Date(T0 + 30 * DAY).toISOString());

    const days = trial.mintInvites([{ email: 'd@example.com' }], { baseUrl: 'https://x.test', expiresInDays: 7 }, T0);
    assert.equal(days.invites[0].expires_at, new Date(T0 + 7 * DAY).toISOString());

    const explicit = trial.mintInvites(
      [{ email: 'e@example.com' }],
      { baseUrl: 'https://x.test', expiresAt: '2026-06-01T00:00:00.000Z' },
      T0,
    );
    assert.equal(explicit.invites[0].expires_at, '2026-06-01T00:00:00.000Z');
  });

  test('one bad address rejects the whole batch, writing nothing', () => {
    const before = db.getDb().prepare('SELECT COUNT(*) AS n FROM trial_invites').get().n;
    const result = trial.mintInvites(
      [{ email: 'good@example.com' }, { email: 'not-an-email' }],
      { baseUrl: 'https://x.test' },
      T0,
    );
    assert.equal(result.ok, false);
    assert.equal(result.invites.length, 0);
    assert.match(result.errors[0], /invites\[1\]/);
    const after = db.getDb().prepare('SELECT COUNT(*) AS n FROM trial_invites').get().n;
    assert.equal(after, before, 'the good half was not committed either');
  });

  test('a past or unparseable expiry is refused', () => {
    assert.equal(trial.mintInvites([{ email: 'f@example.com' }], { expiresAt: 'yesterday' }, T0).ok, false);
    assert.equal(trial.mintInvites([{ email: 'f@example.com' }], { expiresAt: new Date(T0 - DAY).toISOString() }, T0).ok, false);
    assert.equal(trial.mintInvites([{ email: 'f@example.com' }], { expiresInDays: 0 }, T0).ok, false);
    assert.equal(trial.mintInvites([{ email: 'f@example.com' }], { expiresInDays: 900 }, T0).ok, false);
  });

  test('an empty batch is refused', () => {
    assert.equal(trial.mintInvites([], {}, T0).ok, false);
    assert.equal(trial.mintInvites(null, {}, T0).ok, false);
  });
});
