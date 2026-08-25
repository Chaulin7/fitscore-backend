'use strict';

/**
 * src/services/metrics.test.js — the operator metrics functions.
 *
 * Every case runs against a real SQLite database on a throwaway path (the
 * convention services/db.assertNotTheRealDatabase() enforces), seeded row by
 * row so each assertion states exactly which rows produce it.
 *
 * The edge cases are the point. In order of how much money they can misreport:
 *
 *   comped accounts        entitled to a paid plan with no Stripe subscription
 *                          behind them. The owner org is one. Counting a
 *                          comped Pro as €49 invents revenue that will never
 *                          arrive, and it does so on the FIRST row the operator
 *                          looks at.
 *   past_due               entitled through the grace window billing.js allows,
 *                          but the invoice has not cleared — not revenue.
 *   trialing               entitled, has never paid.
 *   canceled-in-period     canceled and STILL entitled until current_period_end.
 *                          Not churned, not revenue.
 *   unrecognised plan      counted, named, and worth nothing — never silently
 *                          folded into free.
 *   zero accounts          every rate is 0/0. Asserted to be null, not NaN.
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

// Must be set BEFORE services/db is first required.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cvsprings-metrics-test-'));
process.env.DATABASE_PATH = path.join(TMP_DIR, 'metrics-test.db');

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { getDb, closeDb } = require('./db');
const metrics = require('./metrics');

const DAY_MS = 24 * 60 * 60 * 1000;
// A fixed "now" so windows are deterministic. Every seeded timestamp below is
// expressed as a number of days before this instant.
const NOW = Date.parse('2026-08-24T12:00:00.000Z');

const iso = (daysAgo) => new Date(NOW - daysAgo * DAY_MS).toISOString();

let seq = 0;

function seedOrg({
  plan = 'free', status = null, comped = 0, createdDaysAgo = 1,
  periodEnd = null, customerId = null, subscriptionId = null, name,
  cancelAtPeriodEnd = 0,
} = {}) {
  const id = `org-${String(++seq).padStart(3, '0')}`;
  getDb().prepare(`
    INSERT INTO organizations
      (id, name, created_at, plan, subscription_status, comped,
       current_period_end, stripe_customer_id, stripe_subscription_id, cancel_at_period_end)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name || id, iso(createdDaysAgo), plan, status, comped,
    periodEnd, customerId, subscriptionId, cancelAtPeriodEnd);
  return id;
}

function seedUser(orgId, { email, role = 'owner', createdDaysAgo = 1, lastLoginDaysAgo = null } = {}) {
  const id = `user-${String(++seq).padStart(3, '0')}`;
  getDb().prepare(`
    INSERT INTO users (id, email, password_hash, org_id, role, created_at, last_login_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, email || `${id}@example.test`, 'x', orgId, role, iso(createdDaysAgo),
    lastLoginDaysAgo == null ? null : iso(lastLoginDaysAgo));
  return id;
}

function seedRun(orgId, daysAgo = 0) {
  const id = `run-${String(++seq).padStart(3, '0')}`;
  getDb().prepare('INSERT INTO screening_runs (id, org_id, role_title, created_at) VALUES (?, ?, ?, ?)')
    .run(id, orgId, 'Engineer', iso(daysAgo));
  return id;
}

function wipe() {
  const db = getDb();
  for (const t of ['screening_runs', 'users', 'organizations', 'metrics_daily']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
}

after(() => { closeDb(); fs.rmSync(TMP_DIR, { recursive: true, force: true }); });

// --- pure helpers (no database) ---------------------------------------------

describe('plan and status normalisation', () => {
  test('a null plan is unknown, never free', () => {
    // Worth €0 either way, but "39 free and one we cannot identify" is a
    // different — and true — statement from "40 free".
    assert.equal(metrics.normalisePlan(null), 'unknown');
    assert.equal(metrics.normalisePlan(undefined), 'unknown');
    assert.equal(metrics.normalisePlan(''), 'unknown');
    assert.equal(metrics.normalisePlan('enterprise'), 'unknown');
  });

  test('the three configured plans pass through', () => {
    for (const p of ['free', 'pro', 'team']) assert.equal(metrics.normalisePlan(p), p);
  });

  test('a null subscription status is `none`, not `canceled`', () => {
    // Every free signup has a NULL status. Bucketing those as canceled would
    // report the entire free tier as churn.
    assert.equal(metrics.normaliseStatus(null), 'none');
    assert.equal(metrics.normaliseStatus(''), 'none');
    assert.equal(metrics.normaliseStatus('incomplete_expired'), 'other');
    assert.equal(metrics.normaliseStatus('active'), 'active');
  });

  test('prices come from config/plans.js, and an unknown plan is worth nothing', () => {
    assert.equal(metrics.monthlyPriceFor('free'), 0);
    assert.equal(metrics.monthlyPriceFor('pro'), 49);
    assert.equal(metrics.monthlyPriceFor('team'), 199);
    assert.equal(metrics.monthlyPriceFor('enterprise'), 0);
    assert.equal(metrics.monthlyPriceFor(null), 0);
  });

  test('only an active, non-comped paid plan is revenue', () => {
    const c = (plan, subscription_status, comped = 0) =>
      metrics.mrrContribution({ plan, subscription_status, comped });

    assert.deepEqual(c('pro', 'active'), { mrr: 49, atRisk: 0 });
    assert.deepEqual(c('team', 'active'), { mrr: 199, atRisk: 0 });
    // Entitled, not paid.
    assert.deepEqual(c('pro', 'trialing'), { mrr: 0, atRisk: 0 });
    // Entitled through the grace window; invoice has not cleared.
    assert.deepEqual(c('pro', 'past_due'), { mrr: 0, atRisk: 49 });
    assert.deepEqual(c('pro', 'canceled'), { mrr: 0, atRisk: 0 });
    // Comped short-circuits everything — this is the owner org.
    assert.deepEqual(c('pro', 'active', 1), { mrr: 0, atRisk: 0 });
    assert.deepEqual(c('team', 'active', 1), { mrr: 0, atRisk: 0 });
    assert.deepEqual(c('free', 'active'), { mrr: 0, atRisk: 0 });
  });
});

// --- empty database ----------------------------------------------------------

describe('zero accounts', () => {
  before(() => { getDb(); wipe(); });

  test('every count is zero and no rate is NaN', () => {
    assert.equal(metrics.totalAccounts(), 0);
    assert.equal(metrics.totalUsers(), 0);
    assert.equal(metrics.signupsInPeriod(7, NOW), 0);
    assert.equal(metrics.signupsInPeriod(30, NOW), 0);
    assert.equal(metrics.signupsInPeriod(90, NOW), 0);
    assert.deepEqual(metrics.dormantAccounts(30, NOW), []);
    assert.deepEqual(metrics.recentSignups(10), []);
    assert.equal(metrics.canceledButInPeriod(NOW), 0);
  });

  test('planBreakdown returns zeroed buckets and zero MRR', () => {
    const p = metrics.planBreakdown();
    assert.deepEqual(p.counts, { free: 0, pro: 0, team: 0, unknown: 0 });
    assert.deepEqual(p.mrrByPlan, { free: 0, pro: 0, team: 0, unknown: 0 });
    assert.equal(p.mrrEur, 0);
    assert.equal(p.atRiskMrrEur, 0);
    assert.equal(p.currency, 'EUR');
  });

  test('subscriptionStatusBreakdown returns all buckets at zero', () => {
    assert.deepEqual(metrics.subscriptionStatusBreakdown(), {
      trialing: 0, active: 0, past_due: 0, canceled: 0, none: 0, other: 0,
    });
  });

  test('activationRate is null, not NaN — 0/0 has no answer', () => {
    const a = metrics.activationStats();
    assert.deepEqual(a, { total: 0, activated: 0, neverScreened: 0, activationRate: null });
    // The distinction that matters: NaN would render as "NaN%" on the page.
    assert.equal(a.activationRate === null, true);
  });

  test('collectMetrics does not throw on an empty platform', () => {
    const d = metrics.collectMetrics(NOW);
    assert.equal(d.totalAccounts, 0);
    assert.equal(d.activation.activationRate, null);
    assert.deepEqual(d.series, []);
  });
});

// --- seeded platform ---------------------------------------------------------

describe('seeded platform', () => {
  let orgActivePro, orgTeamActive, orgCompedPro, orgTrialing, orgPastDue,
    orgCanceledInPeriod, orgCanceledExpired, orgUnknownPlan, orgDormant, orgFresh;

  before(() => {
    getDb();
    wipe();

    // Paying: €49 + €199 = €248 MRR.
    orgActivePro = seedOrg({ plan: 'pro', status: 'active', createdDaysAgo: 5, customerId: 'cus_pro' });
    orgTeamActive = seedOrg({ plan: 'team', status: 'active', createdDaysAgo: 40, customerId: 'cus_team' });

    // Entitled, not revenue.
    orgCompedPro = seedOrg({ plan: 'pro', status: null, comped: 1, createdDaysAgo: 200 });
    orgTrialing = seedOrg({ plan: 'pro', status: 'trialing', createdDaysAgo: 3, customerId: 'cus_trial' });
    orgPastDue = seedOrg({ plan: 'team', status: 'past_due', createdDaysAgo: 60, customerId: 'cus_pd' });

    // Canceled but still inside the period the customer paid for.
    orgCanceledInPeriod = seedOrg({
      plan: 'pro', status: 'canceled', createdDaysAgo: 120,
      periodEnd: new Date(NOW + 10 * DAY_MS).toISOString(), customerId: 'cus_cip',
    });
    // Canceled and the period has lapsed — genuinely gone.
    orgCanceledExpired = seedOrg({
      plan: 'pro', status: 'canceled', createdDaysAgo: 300,
      periodEnd: new Date(NOW - 10 * DAY_MS).toISOString(), customerId: 'cus_cex',
    });

    // An unrecognised plan value. NULL is unreachable (see the schema test
    // below), but a renamed or retired tier leaves exactly this behind.
    orgUnknownPlan = seedOrg({ plan: 'legacy-unlimited', status: 'active', createdDaysAgo: 400 });

    // Free tier: one long-dormant, one signed up today.
    orgDormant = seedOrg({ plan: 'free', createdDaysAgo: 250 });
    orgFresh = seedOrg({ plan: 'free', createdDaysAgo: 0 });

    seedUser(orgActivePro, { email: 'pro@example.test', lastLoginDaysAgo: 1, createdDaysAgo: 5 });
    seedUser(orgTeamActive, { email: 'team@example.test', lastLoginDaysAgo: 2, createdDaysAgo: 40 });
    seedUser(orgTeamActive, { email: 'member@example.test', role: 'member', createdDaysAgo: 39 });
    seedUser(orgCompedPro, { email: 'owner@example.test', lastLoginDaysAgo: 0, createdDaysAgo: 200 });
    seedUser(orgTrialing, { email: 'trial@example.test', lastLoginDaysAgo: 3, createdDaysAgo: 3 });
    seedUser(orgPastDue, { email: 'pastdue@example.test', lastLoginDaysAgo: 5, createdDaysAgo: 60 });
    seedUser(orgCanceledInPeriod, { email: 'cip@example.test', lastLoginDaysAgo: 100, createdDaysAgo: 120 });
    seedUser(orgCanceledExpired, { email: 'cex@example.test', lastLoginDaysAgo: 200, createdDaysAgo: 300 });
    seedUser(orgUnknownPlan, { email: 'legacy@example.test', lastLoginDaysAgo: 400, createdDaysAgo: 400 });
    seedUser(orgDormant, { email: 'dormant@example.test', lastLoginDaysAgo: 240, createdDaysAgo: 250 });
    seedUser(orgFresh, { email: 'fresh@example.test', createdDaysAgo: 0 });
    // orgFresh deliberately has NO last_login_at — it must not be dormant on
    // the day it signed up, and its created_at is the fallback that says so.

    // Screening activity. Four orgs have screened; six never have.
    seedRun(orgActivePro, 1); seedRun(orgActivePro, 2); seedRun(orgActivePro, 40);
    seedRun(orgTeamActive, 0);
    seedRun(orgCompedPro, 3);
    seedRun(orgDormant, 240);
  });

  test('the schema makes a NULL plan unreachable — unknown arrives as a value', () => {
    // organizations.plan is `NOT NULL DEFAULT 'free'`, so an org whose plan is
    // literally NULL cannot exist. This asserts that, so the day someone
    // rebuilds the table without the constraint the test says so rather than
    // the dashboard quietly reporting an inflated free tier.
    assert.throws(
      () => getDb().prepare('INSERT INTO organizations (id,name,created_at,plan) VALUES (?,?,?,?)')
        .run('org-null-plan', 'null plan', iso(1), null),
      /NOT NULL constraint failed: organizations\.plan/,
    );
  });

  test('totalAccounts counts organizations; totalUsers counts seats', () => {
    assert.equal(metrics.totalAccounts(), 10);
    // 11 users across 10 orgs — the Team org has a second member. If seats were
    // counted as accounts, MRR per account would be wrong.
    assert.equal(metrics.totalUsers(), 11);
  });

  test('signupsInPeriod windows are cumulative and bounded', () => {
    // 0, 3, 5 days ago.
    assert.equal(metrics.signupsInPeriod(7, NOW), 3);
    // + 40 days ago, + 60 days ago.
    assert.equal(metrics.signupsInPeriod(30, NOW), 3);
    assert.equal(metrics.signupsInPeriod(90, NOW), 5);
    assert.equal(metrics.signupsInPeriod(365, NOW), 9);
    assert.equal(metrics.signupsInPeriod(1000, NOW), 10);
  });

  test('signupsInPeriod refuses a nonsensical window rather than guessing', () => {
    assert.equal(metrics.signupsInPeriod(0, NOW), 0);
    assert.equal(metrics.signupsInPeriod(-5, NOW), 0);
    assert.equal(metrics.signupsInPeriod('abc', NOW), 0);
  });

  test('planBreakdown counts every account and bills only the active ones', () => {
    const p = metrics.planBreakdown();
    assert.deepEqual(p.counts, { free: 2, pro: 5, team: 2, unknown: 1 });
    // Sums to totalAccounts — nothing is dropped on the floor.
    assert.equal(Object.values(p.counts).reduce((a, b) => a + b, 0), metrics.totalAccounts());

    // €49 (active pro) + €199 (active team). The comped pro, the trialing pro,
    // the past_due team and both canceled pros contribute nothing.
    assert.equal(p.mrrEur, 248);
    assert.deepEqual(p.mrrByPlan, { free: 0, pro: 49, team: 199, unknown: 0 });
    assert.equal(p.payingAccounts, 2);

    // past_due is reported separately so it is visible without being counted.
    assert.equal(p.atRiskMrrEur, 199);
    // The comped Pro is surfaced so it is explainable, not just missing.
    assert.equal(p.compedPaidPlans, 1);
  });

  test('an unrecognised plan is worth nothing even when its status is active', () => {
    const p = metrics.planBreakdown();
    assert.equal(p.counts.unknown, 1);
    assert.equal(p.mrrByPlan.unknown, 0);
  });

  test('subscriptionStatusBreakdown separates never-subscribed from canceled', () => {
    const s = metrics.subscriptionStatusBreakdown();
    assert.deepEqual(s, {
      trialing: 1, active: 3, past_due: 1, canceled: 2,
      none: 3, other: 0,
    });
    assert.equal(Object.values(s).reduce((a, b) => a + b, 0), metrics.totalAccounts());
  });

  test('canceled-but-still-in-period is counted, and an expired one is not', () => {
    // orgCanceledInPeriod has current_period_end 10 days in the future;
    // orgCanceledExpired has one 10 days in the past. Both are `canceled`.
    assert.equal(metrics.canceledButInPeriod(NOW), 1);
    // Move the clock past the remaining period and it stops counting.
    assert.equal(metrics.canceledButInPeriod(NOW + 20 * DAY_MS), 0);
  });

  test('activationStats splits screened from never-screened', () => {
    const a = metrics.activationStats();
    assert.equal(a.total, 10);
    assert.equal(a.activated, 4);
    assert.equal(a.neverScreened, 6);
    assert.equal(a.activationRate, 40);
    assert.equal(a.activated + a.neverScreened, a.total);
  });

  test('dormantAccounts uses the latest of screening and login', () => {
    const dormant = metrics.dormantAccounts(30, NOW).map((r) => r.id);

    // Active within 30 days by login and/or screening.
    assert.equal(dormant.includes(orgActivePro), false);
    assert.equal(dormant.includes(orgTeamActive), false);
    assert.equal(dormant.includes(orgCompedPro), false);
    assert.equal(dormant.includes(orgTrialing), false);
    assert.equal(dormant.includes(orgPastDue), false);

    // Last touched 100+ days ago.
    assert.equal(dormant.includes(orgCanceledInPeriod), true);
    assert.equal(dormant.includes(orgCanceledExpired), true);
    assert.equal(dormant.includes(orgUnknownPlan), true);
    assert.equal(dormant.includes(orgDormant), true);
  });

  test('an account that signed up today is not dormant', () => {
    // orgFresh has no login and no screening. Falling back to created_at is
    // what keeps every new signup off the churn list on day one.
    const dormant = metrics.dormantAccounts(30, NOW).map((r) => r.id);
    assert.equal(dormant.includes(orgFresh), false);
    // Ninety days later, with still no activity, it IS dormant.
    assert.equal(metrics.dormantAccounts(30, NOW + 90 * DAY_MS).map((r) => r.id).includes(orgFresh), true);
  });

  test('dormantAccounts carries the owner email and orders oldest first', () => {
    const rows = metrics.dormantAccounts(30, NOW);
    assert.equal(rows.length, 4);
    assert.equal(rows[0].id, orgUnknownPlan); // last login 400 days ago
    assert.equal(rows[0].ownerEmail, 'legacy@example.test');
    for (const r of rows) assert.ok('lastActivityAt' in r);
  });

  test('recentSignups is newest-first with owner email, plan and screening count', () => {
    const rows = metrics.recentSignups(5);
    assert.equal(rows.length, 5);
    assert.equal(rows[0].id, orgFresh);
    assert.equal(rows[0].ownerEmail, 'fresh@example.test');
    assert.equal(rows[0].screeningCount, 0);

    const pro = rows.find((r) => r.id === orgActivePro);
    assert.equal(pro.plan, 'pro');
    assert.equal(pro.screeningCount, 3);

    for (let i = 1; i < rows.length; i++) {
      assert.ok(rows[i - 1].createdAt >= rows[i].createdAt, 'not ordered newest-first');
    }
  });

  test('recentSignups caps the limit and survives a junk one', () => {
    assert.equal(metrics.recentSignups(1000).length, 10); // capped at 200, only 10 exist
    assert.equal(metrics.recentSignups(0).length, 10);    // falls back to the default 20
    assert.equal(metrics.recentSignups('x').length, 10);
  });

  test('an organization with no owner user still appears in recentSignups', () => {
    // The legacy migration org has no owner when OWNER_EMAIL was never set. An
    // inner join would delete it from the signup list rather than show it.
    const orphan = seedOrg({ plan: 'free', createdDaysAgo: 0, name: 'orphan' });
    const row = metrics.recentSignups(20).find((r) => r.id === orphan);
    assert.ok(row, 'org with no owner user vanished from recentSignups');
    assert.equal(row.ownerEmail, null);
    getDb().prepare('DELETE FROM organizations WHERE id = ?').run(orphan);
  });
});

// --- daily snapshot ----------------------------------------------------------

describe('daily snapshot', () => {
  let orgOld;

  before(() => {
    getDb();
    wipe();
    orgOld = seedOrg({ plan: 'pro', status: 'active', createdDaysAgo: 10 });
    seedOrg({ plan: 'free', createdDaysAgo: 5 });
    seedOrg({ plan: 'free', createdDaysAgo: 5 });
    seedOrg({ plan: 'free', createdDaysAgo: 0 });
    seedRun(orgOld, 0);
    seedRun(orgOld, 0);
    seedRun(orgOld, 3);
  });

  test('writeSnapshot is idempotent — ten runs leave one row', () => {
    for (let i = 0; i < 10; i++) metrics.writeSnapshot('2026-08-24', NOW);
    const rows = getDb().prepare("SELECT * FROM metrics_daily WHERE date = '2026-08-24'").all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].total_accounts, 4);
    assert.equal(rows[0].screenings_run, 2);
    assert.equal(rows[0].mrr_eur, 49);
    assert.equal(rows[0].pro_count, 1);
    assert.equal(rows[0].free_count, 3);
    assert.equal(rows[0].active_subs, 1);
  });

  test('a rerun after state changes overwrites rather than appends', () => {
    seedOrg({ plan: 'team', status: 'active', createdDaysAgo: 0 });
    metrics.writeSnapshot('2026-08-24', NOW);
    const rows = getDb().prepare("SELECT * FROM metrics_daily WHERE date = '2026-08-24'").all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].total_accounts, 5);
    assert.equal(rows[0].mrr_eur, 248);
    getDb().prepare("DELETE FROM organizations WHERE plan = 'team'").run();
    metrics.writeSnapshot('2026-08-24', NOW);
  });

  test('backfill reconstructs missed days and never overwrites an observed one', () => {
    const observed = getDb().prepare("SELECT * FROM metrics_daily WHERE date = '2026-08-24'").get();
    metrics.backfillSnapshots(91, NOW);

    const rows = getDb().prepare('SELECT * FROM metrics_daily ORDER BY date ASC').all();
    assert.equal(rows.length, 91, 'expected one row per day in the window');

    // Today's real observation survived the backfill with its plan columns.
    const today = rows[rows.length - 1];
    assert.equal(today.date, '2026-08-24');
    assert.equal(today.mrr_eur, observed.mrr_eur);
    assert.equal(today.free_count, observed.free_count);

    // A reconstructed day says "not observed" rather than carrying today's mix.
    // The oldest seeded org signed up 10 days before NOW (2026-08-14), so on
    // 2026-08-15 exactly one account existed.
    const reconstructed = rows.find((r) => r.date === '2026-08-15');
    assert.equal(reconstructed.mrr_eur, null);
    assert.equal(reconstructed.free_count, null);
    assert.equal(reconstructed.active_subs, null);
    // Its reconstructible column is exact, not a guess.
    assert.equal(reconstructed.total_accounts, 1);
    // And before anyone had signed up, the reconstruction says zero rather
    // than back-projecting today's population across the whole window.
    assert.equal(rows.find((r) => r.date === '2026-08-01').total_accounts, 0);
  });

  test('total_accounts in the reconstruction is monotonic and ends at the truth', () => {
    const rows = getDb().prepare('SELECT date, total_accounts FROM metrics_daily ORDER BY date ASC').all();
    for (let i = 1; i < rows.length; i++) {
      assert.ok(rows[i].total_accounts >= rows[i - 1].total_accounts,
        `total_accounts went backwards at ${rows[i].date}`);
    }
    assert.equal(rows[rows.length - 1].total_accounts, metrics.totalAccounts());
  });

  test('runDailySnapshot is safe to call repeatedly (boot + every 24h)', () => {
    const before = getDb().prepare('SELECT COUNT(*) AS n FROM metrics_daily').get().n;
    metrics.runDailySnapshot(NOW);
    metrics.runDailySnapshot(NOW);
    metrics.runDailySnapshot(NOW);
    assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM metrics_daily').get().n, before);
  });

  test('signupSeries differences the cumulative total into per-day signups', () => {
    const series = metrics.signupSeries(90, NOW);
    assert.equal(series.length, 90);

    const byDate = new Map(series.map((p) => [p.date, p]));
    // Two free orgs signed up 5 days ago; one 10 days ago; one today.
    assert.equal(byDate.get(new Date(NOW - 5 * DAY_MS).toISOString().slice(0, 10)).signups, 2);
    assert.equal(byDate.get(new Date(NOW - 10 * DAY_MS).toISOString().slice(0, 10)).signups, 1);
    assert.equal(byDate.get('2026-08-24').signups, 1);
    // Every other day is quiet, and quiet is 0 rather than a gap.
    assert.equal(series.filter((p) => p.signups === 0).length, 87);
  });

  test('signupSeries never emits a negative bar when an account is deleted', () => {
    getDb().prepare('DELETE FROM metrics_daily').run();
    getDb().prepare("INSERT INTO metrics_daily (date, total_accounts, screenings_run) VALUES ('2026-08-22', 10, 0)").run();
    getDb().prepare("INSERT INTO metrics_daily (date, total_accounts, screenings_run) VALUES ('2026-08-23', 4, 0)").run();
    const series = metrics.signupSeries(90, NOW);
    const drop = series.find((p) => p.date === '2026-08-23');
    // 4 - 10 = -6 signups is a rendering of a deletion, not of a signup.
    assert.equal(drop.signups, 0);
  });
});

// --- cancelling at period end -----------------------------------------------

describe('churningMrr', () => {
  before(() => { getDb(); wipe(); });

  test('an empty platform is not churning', () => {
    assert.deepEqual(metrics.churningMrr(), { mrrEur: 0, count: 0, accounts: [] });
  });

  test('counts active subscriptions flagged to stop, and nothing else', () => {
    wipe();
    const ends = new Date(NOW + 12 * DAY_MS).toISOString();
    // Cancelling: still active, still billing, set to stop.
    const goingPro = seedOrg({ plan: 'pro', status: 'active', cancelAtPeriodEnd: 1, periodEnd: ends, name: 'Going Pro' });
    const goingTeam = seedOrg({ plan: 'team', status: 'active', cancelAtPeriodEnd: 1, periodEnd: ends, name: 'Going Team' });
    seedUser(goingPro, { email: 'going@example.test' });
    seedUser(goingTeam, { email: 'team-going@example.test' });

    // Staying.
    seedOrg({ plan: 'pro', status: 'active', cancelAtPeriodEnd: 0 });
    // Already gone — status is canceled, not active. Counting it here would
    // double-count a loss that has already been taken.
    seedOrg({ plan: 'pro', status: 'canceled', cancelAtPeriodEnd: 1 });
    // past_due is the OTHER kind of at-risk and belongs in its own figure.
    seedOrg({ plan: 'team', status: 'past_due', cancelAtPeriodEnd: 1 });

    const c = metrics.churningMrr();
    assert.equal(c.count, 2);
    assert.equal(c.mrrEur, 49 + 199);
    assert.deepEqual(c.accounts.map((a) => a.id).sort(), [goingPro, goingTeam].sort());
  });

  test('each account carries the date it ends and its owner', () => {
    const [first] = metrics.churningMrr().accounts;
    assert.ok(first.currentPeriodEnd, 'the WHEN is the point of this table');
    assert.ok(first.ownerEmail);
    assert.equal(typeof first.mrrEur, 'number');
  });

  test('accounts are ordered by how soon they end', () => {
    wipe();
    const soon = seedOrg({ plan: 'pro', status: 'active', cancelAtPeriodEnd: 1, periodEnd: new Date(NOW + 2 * DAY_MS).toISOString() });
    const later = seedOrg({ plan: 'pro', status: 'active', cancelAtPeriodEnd: 1, periodEnd: new Date(NOW + 20 * DAY_MS).toISOString() });
    assert.deepEqual(metrics.churningMrr().accounts.map((a) => a.id), [soon, later]);
  });

  test('a cancelling comped account is reported and worth nothing', () => {
    wipe();
    seedOrg({ plan: 'pro', status: 'active', comped: 1, cancelAtPeriodEnd: 1 });
    const c = metrics.churningMrr();
    // Real, worth reporting, and €0 — there is no revenue to lose.
    assert.equal(c.count, 1);
    assert.equal(c.mrrEur, 0);
    assert.equal(c.accounts[0].comped, true);
  });

  test('the flag defaults to 0, so an untouched org never appears', () => {
    wipe();
    getDb().prepare('INSERT INTO organizations (id, name, created_at, plan, subscription_status) VALUES (?,?,?,?,?)')
      .run('no-flag', 'No Flag', iso(1), 'pro', 'active');
    assert.equal(getDb().prepare('SELECT cancel_at_period_end AS c FROM organizations WHERE id = ?').get('no-flag').c, 0);
    assert.equal(metrics.churningMrr().count, 0);
  });
});

// --- stored signup counts ----------------------------------------------------

describe('signups_count is a recorded fact, not a derived one', () => {
  before(() => {
    getDb();
    wipe();
    seedOrg({ createdDaysAgo: 3 });
    seedOrg({ createdDaysAgo: 3 });
    seedOrg({ createdDaysAgo: 1 });
    seedOrg({ createdDaysAgo: 0 });
    metrics.runDailySnapshot(NOW);
  });

  test('the snapshot stores the count for the day, not a delta', () => {
    const rows = getDb().prepare('SELECT date, signups_count FROM metrics_daily WHERE signups_count > 0 ORDER BY date').all();
    const byDate = new Map(rows.map((r) => [r.date, r.signups_count]));
    assert.equal(byDate.get(new Date(NOW - 3 * DAY_MS).toISOString().slice(0, 10)), 2);
    assert.equal(byDate.get(new Date(NOW - 1 * DAY_MS).toISOString().slice(0, 10)), 1);
    assert.equal(byDate.get('2026-08-24'), 1);
  });

  test('deleting an organization does not change any historical signups_count', () => {
    // THE reason this column exists. Under the old delta approach, removing an
    // account silently rewrote the bar for the day it signed up AND the day
    // before it — history moved because the present did.
    const before = getDb().prepare('SELECT date, signups_count FROM metrics_daily ORDER BY date').all();
    const seriesBefore = metrics.signupSeries(90, NOW).map((p) => [p.date, p.signups]);

    const victim = getDb().prepare("SELECT id FROM organizations ORDER BY created_at ASC LIMIT 1").get().id;
    getDb().prepare('DELETE FROM organizations WHERE id = ?').run(victim);
    // A later run of the job must not rewrite the past either.
    metrics.runDailySnapshot(NOW);

    const after = getDb().prepare('SELECT date, signups_count FROM metrics_daily ORDER BY date').all();
    const historical = (rows) => rows.filter((r) => r.date !== '2026-08-24');
    assert.deepEqual(historical(after), historical(before),
      'a deletion rewrote a stored signup count');

    const seriesAfter = metrics.signupSeries(90, NOW).map((p) => [p.date, p.signups]);
    assert.deepEqual(
      seriesAfter.filter(([d]) => d !== '2026-08-24'),
      seriesBefore.filter(([d]) => d !== '2026-08-24'),
      'a deletion moved the chart',
    );
  });

  test('the series reports stored values as recorded, not derived', () => {
    for (const point of metrics.signupSeries(90, NOW)) {
      assert.equal(point.derived, false, `${point.date} fell back to a delta unnecessarily`);
    }
  });

  test('a legacy row with no stored count still renders, via the delta', () => {
    // Rows written before signups_count existed. The fallback is a migration
    // path for exactly these and nothing else.
    getDb().prepare('DELETE FROM metrics_daily').run();
    const ins = getDb().prepare('INSERT INTO metrics_daily (date, total_accounts, screenings_run) VALUES (?, ?, 0)');
    ins.run('2026-08-20', 5); ins.run('2026-08-21', 8); ins.run('2026-08-22', 8);
    const series = metrics.signupSeries(90, NOW);
    const byDate = new Map(series.map((p) => [p.date, p]));
    assert.equal(byDate.get('2026-08-21').signups, 3);
    assert.equal(byDate.get('2026-08-21').derived, true);
    assert.equal(byDate.get('2026-08-22').signups, 0);
  });
});

// --- self-healing backfill ---------------------------------------------------

describe('self-healing backfill', () => {
  before(() => { getDb(); wipe(); });

  test('a process down for three days recovers all three on the next start', () => {
    wipe();
    seedOrg({ createdDaysAgo: 10 });
    seedOrg({ createdDaysAgo: 3 });  // signed up while the process was down
    seedOrg({ createdDaysAgo: 2 });  // and again
    seedOrg({ createdDaysAgo: 0 });

    // The job last ran three days ago and then the process stopped.
    const lastRan = new Date(NOW - 3 * DAY_MS).toISOString().slice(0, 10);
    metrics.writeSnapshot(lastRan, NOW - 3 * DAY_MS);
    const gap = getDb().prepare('SELECT COUNT(*) AS n FROM metrics_daily WHERE date > ?').get(lastRan).n;
    assert.equal(gap, 0, 'precondition: nothing after the last run');

    metrics.runDailySnapshot(NOW);

    const dates = getDb().prepare('SELECT date FROM metrics_daily WHERE date > ? ORDER BY date').all(lastRan)
      .map((r) => r.date);
    assert.deepEqual(dates, [
      new Date(NOW - 2 * DAY_MS).toISOString().slice(0, 10),
      new Date(NOW - 1 * DAY_MS).toISOString().slice(0, 10),
      '2026-08-24',
    ], 'the three missing days were not recovered');

    // And they carry the right figures, not placeholders.
    const twoDaysAgo = getDb().prepare('SELECT * FROM metrics_daily WHERE date = ?')
      .get(new Date(NOW - 2 * DAY_MS).toISOString().slice(0, 10));
    assert.equal(twoDaysAgo.signups_count, 1);
    assert.equal(twoDaysAgo.total_accounts, 3);
  });

  test('the catch-up is idempotent — a second start changes nothing', () => {
    const before = getDb().prepare('SELECT * FROM metrics_daily ORDER BY date').all();
    metrics.runDailySnapshot(NOW);
    metrics.runDailySnapshot(NOW);
    assert.deepEqual(getDb().prepare('SELECT * FROM metrics_daily ORDER BY date').all(), before);
  });

  test('an interior gap is repaired, not just the trailing one', () => {
    // A day the job crashed on, with later days written since. Anchoring only
    // on MAX(date) would leave this hole in the middle of the chart forever.
    const hole = new Date(NOW - 1 * DAY_MS).toISOString().slice(0, 10);
    getDb().prepare('DELETE FROM metrics_daily WHERE date = ?').run(hole);
    metrics.runDailySnapshot(NOW);
    assert.ok(getDb().prepare('SELECT 1 FROM metrics_daily WHERE date = ?').get(hole), 'interior gap left open');
  });

  test('an empty table falls back to the routine 91-day window', () => {
    getDb().prepare('DELETE FROM metrics_daily').run();
    metrics.backfillMissingDays(NOW);
    assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM metrics_daily').get().n, 91);
  });

  test('a very old last run is capped rather than writing years of rows', () => {
    // A restore from an ancient backup must not turn the boot path into a
    // thousand-row write while the server is trying to accept traffic.
    getDb().prepare('DELETE FROM metrics_daily').run();
    getDb().prepare('INSERT INTO metrics_daily (date, total_accounts, screenings_run) VALUES (?, 0, 0)')
      .run('2019-01-01');
    metrics.backfillMissingDays(NOW);
    const n = getDb().prepare('SELECT COUNT(*) AS n FROM metrics_daily').get().n;
    assert.ok(n <= metrics.MAX_SELF_HEAL_DAYS + 2, `wrote ${n} rows`);
    assert.ok(n > 91, 'the cap should still be more generous than the routine window');
  });
});

// --- passive drift storage ---------------------------------------------------

describe('passive drift storage', () => {
  before(() => { getDb(); wipe(); });

  test('a successful check stores the count and the time', () => {
    metrics.recordDriftCheck(4, '2026-08-24', '2026-08-24T02:00:00.000Z');
    const d = metrics.latestDriftCheck();
    assert.equal(d.count, 4);
    assert.equal(d.checkedAt, '2026-08-24T02:00:00.000Z');
    assert.equal(d.error, null);
  });

  test('a failure records the error and leaves the last real count intact', () => {
    // The whole point: a zero here would say "we checked and everything
    // agrees" about a check that never completed.
    metrics.recordDriftFailure('Stripe timed out', '2026-08-24');
    const d = metrics.latestDriftCheck();
    assert.equal(d.count, 4, 'a failed check overwrote a real count');
    assert.equal(d.checkedAt, '2026-08-24T02:00:00.000Z', 'a failed check moved the timestamp');
    assert.match(d.error, /Stripe timed out/);
  });

  test('the stored count is never blanked to zero by a failure', () => {
    const row = getDb().prepare("SELECT * FROM metrics_daily WHERE date = '2026-08-24'").get();
    assert.equal(row.drift_count, 4);
    assert.notEqual(row.drift_count, 0);
    assert.ok(row.drift_error);
  });

  test('a later success clears the error', () => {
    metrics.recordDriftCheck(0, '2026-08-24', '2026-08-24T06:00:00.000Z');
    const d = metrics.latestDriftCheck();
    assert.equal(d.count, 0);
    assert.equal(d.error, null, 'a recovered check still reports the old failure');
  });

  test('a snapshot on boot does not erase a drift result', () => {
    // writeSnapshot runs on every boot and must not cost a reconciliation that
    // took hundreds of API calls to obtain.
    metrics.writeSnapshot('2026-08-24', NOW);
    metrics.runDailySnapshot(NOW);
    const d = metrics.latestDriftCheck();
    assert.equal(d.count, 0);
    assert.equal(d.checkedAt, '2026-08-24T06:00:00.000Z');
  });

  test('the check self-gates so a deploy-heavy afternoon is not a dozen sweeps', () => {
    const checkedAt = Date.parse('2026-08-24T06:00:00.000Z');
    assert.equal(metrics.driftCheckDue(checkedAt + 60 * 1000), false);
    assert.equal(metrics.driftCheckDue(checkedAt + metrics.DRIFT_MIN_GAP_MS + 1000), true);
  });

  test('a platform that has never checked is due', () => {
    getDb().prepare('DELETE FROM metrics_daily').run();
    assert.equal(metrics.driftCheckDue(NOW), true);
    assert.deepEqual(metrics.latestDriftCheck(), { count: null, checkedAt: null, error: null, errorDate: null });
  });
});
