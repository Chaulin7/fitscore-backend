'use strict';

/**
 * src/services/metrics.js — internal operator metrics for GET /admin/metrics.
 *
 * READ-ONLY, with exactly one exception that is not a metric: the daily
 * snapshot writer at the bottom of this file, which is the only thing here that
 * touches the database with anything but SELECT.
 *
 * WHAT AN "ACCOUNT" IS HERE
 * ------------------------
 * There is no accounts table in this schema. Signup creates a pair — one
 * `organizations` row and one `users` row with role 'owner' — and the two carry
 * different halves of what an operator means by "account":
 *
 *   organizations : plan, subscription_status, current_period_end, comped,
 *                   stripe_customer_id, stripe_subscription_id  (the tenant,
 *                   and the ONLY place billing state lives — there is no
 *                   subscriptions table)
 *   users         : email, role, created_at, last_login_at        (the login)
 *
 * Money attaches to the organization, so an account IS an organization
 * throughout this module and every count below is a count of organizations.
 * Seats are reported separately (`totalUsers`) because a Team org with six
 * members is one account paying once, and adding those six to an account count
 * would inflate it and break the per-account MRR.
 *
 * TIME
 * ----
 * All windows are UTC. created_at is an ISO-8601 UTC string everywhere this
 * module reads, so lexicographic string comparison IS chronological comparison
 * and every range below is a plain BETWEEN on an indexed column. Note this is
 * deliberately NOT the org-timezone treatment services/timezone.js gives
 * customer-facing audit filters: those answer "what did MY team do on Tuesday"
 * for one tenant in one zone, and there is no single zone that question could
 * be asked in across all tenants at once.
 *
 * audit_log is deliberately absent from every windowed query. Its created_at
 * has a `DEFAULT (datetime('now'))`, which renders "2026-07-31 10:22:33" — a
 * space where ISO has a 'T'. Since ' ' sorts before 'T', a default-stamped row
 * compares as older than every ISO row, and a date range over that column
 * silently drops or mis-buckets the pre-2026-07 rows. screening_runs stamps
 * created_at explicitly and has no such default, so it is the honest table for
 * "how much screening happened, and when".
 */

const { getDb } = require('./db');
const { tierById, CURRENCY } = require('../config/plans');

const DAY_MS = 24 * 60 * 60 * 1000;

// The plan ids config/plans.js actually defines. An org whose plan column holds
// anything else — NULL on a row that predates the column's default, or a value
// left behind by a renamed tier — is counted under `unknown` rather than folded
// into free. Both are worth zero, but "we have 40 free accounts" and "we have
// 39 free accounts and one we cannot identify" are different statements and the
// second one is the true one.
const KNOWN_PLANS = ['free', 'pro', 'team'];

// The subscription_status values Stripe sends that we report under their own
// name. Anything else Stripe invents lands in `other`.
const KNOWN_STATUSES = ['trialing', 'active', 'past_due'];

/**
 * Reporting buckets.
 *
 * The database now preserves the exact terminal status, so the grouping is done
 * here — where it can be changed by editing this file rather than by replaying
 * Stripe. Two deliberate groupings:
 *
 *   churned  canceled (voluntary) + unpaid (dunning exhausted, involuntary).
 *            One top-line churn number, because that is the question the
 *            dashboard is answering. They stay separable in `raw` below, and in
 *            the reconcile report, because the recovery motion differs: an
 *            unpaid account may come back on a card-update email, a canceled
 *            one will not.
 *
 *   none     never subscribed + incomplete_expired. An account whose first
 *            payment never cleared was never a customer, so counting it as
 *            churn inflates churn with failed signups.
 */
const CHURNED_STATUSES = ['canceled', 'unpaid'];
const NEVER_SUBSCRIBED_STATUSES = ['incomplete_expired'];
// Display order for the status table.
const REPORTED_STATUSES = ['trialing', 'active', 'past_due', 'churned', 'none', 'other'];

function normalisePlan(plan) {
  return KNOWN_PLANS.includes(plan) ? plan : 'unknown';
}

function normaliseStatus(status) {
  if (status == null || status === '') return 'none';
  if (NEVER_SUBSCRIBED_STATUSES.includes(status)) return 'none';
  if (CHURNED_STATUSES.includes(status)) return 'churned';
  return KNOWN_STATUSES.includes(status) ? status : 'other';
}

function monthlyPriceFor(plan) {
  const tier = tierById(plan);
  return tier && typeof tier.priceAmount === 'number' ? tier.priceAmount : 0;
}

/**
 * Whether this org is paying us this month, and how much.
 *
 * Three ways to be entitled and NOT be revenue, all of them live in production:
 *
 *   comped   — fully entitled with no Stripe subscription behind it (the owner
 *              org is one). Counting its plan price as MRR invents money.
 *   trialing — entitled, has not paid yet.
 *   past_due — entitled through the grace window billing.isUnlimited() allows,
 *              but the invoice has not cleared. Reported by countMrr() as
 *              at-risk rather than as revenue, so the headline MRR figure is
 *              money actually collected.
 *
 * This is deliberately NOT billing.isUnlimited(): that predicate answers
 * "may this org run unlimited analyses", and it says yes to past_due on
 * purpose. Borrowing it here would put unpaid invoices in the revenue number.
 */
function mrrContribution(org) {
  const comped = org.comped === 1 || org.comped === true;
  if (comped) return { mrr: 0, atRisk: 0 };
  const price = monthlyPriceFor(org.plan);
  if (!price) return { mrr: 0, atRisk: 0 };
  if (org.subscription_status === 'active') return { mrr: price, atRisk: 0 };
  if (org.subscription_status === 'past_due') return { mrr: 0, atRisk: price };
  return { mrr: 0, atRisk: 0 };
}

function isoDaysAgo(days, now = Date.now()) {
  return new Date(now - Number(days) * DAY_MS).toISOString();
}

function utcDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// Exclusive upper bound for a UTC calendar day, as a string that sorts
// correctly against an ISO created_at.
function dayStartIso(date) {
  return `${date}T00:00:00.000Z`;
}

function nextDayStartIso(date) {
  return dayStartIso(utcDate(Date.parse(dayStartIso(date)) + DAY_MS));
}

// --- Counts -----------------------------------------------------------------

/** Total accounts (organizations) on the platform. */
function totalAccounts() {
  return getDb().prepare('SELECT COUNT(*) AS n FROM organizations').get().n;
}

/** Total user logins across all accounts — seats, not accounts. */
function totalUsers() {
  return getDb().prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

/**
 * Accounts created in the last `days` days.
 * @param {number} days e.g. 7, 30, 90
 */
function signupsInPeriod(days, now = Date.now()) {
  const n = Number(days);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return getDb()
    .prepare('SELECT COUNT(*) AS n FROM organizations WHERE created_at >= ?')
    .get(isoDaysAgo(n, now)).n;
}

/**
 * Accounts per plan, plus monthly recurring revenue.
 *
 * One grouped scan feeds both: the plan mix and the MRR are computed from the
 * same rows in the same pass, so the two cannot disagree about how many pro
 * accounts there are.
 *
 * @returns {{counts: object, mrrByPlan: object, mrrEur: number,
 *            atRiskMrrEur: number, compedPaidPlans: number, currency: string,
 *            payingAccounts: number}}
 */
function planBreakdown() {
  const rows = getDb().prepare(`
    SELECT plan, subscription_status, comped, COUNT(*) AS n
    FROM organizations
    GROUP BY plan, subscription_status, comped
  `).all();

  const counts = { free: 0, pro: 0, team: 0, unknown: 0 };
  // Per-plan revenue, so the breakdown table's rows sum to its own total. A
  // single aggregate would leave the table showing which plans exist and how
  // much money there is, with no way to see which plan the money came from.
  const mrrByPlan = { free: 0, pro: 0, team: 0, unknown: 0 };
  let mrrEur = 0;
  let atRiskMrrEur = 0;
  let compedPaidPlans = 0;
  let payingAccounts = 0;

  for (const row of rows) {
    const bucket = normalisePlan(row.plan);
    counts[bucket] += row.n;
    const { mrr, atRisk } = mrrContribution(row);
    mrrByPlan[bucket] += mrr * row.n;
    mrrEur += mrr * row.n;
    atRiskMrrEur += atRisk * row.n;
    if (mrr) payingAccounts += row.n;
    const comped = row.comped === 1 || row.comped === true;
    if (comped && monthlyPriceFor(row.plan)) compedPaidPlans += row.n;
  }

  return {
    counts, mrrByPlan, mrrEur, atRiskMrrEur, compedPaidPlans, payingAccounts,
    currency: CURRENCY.code,
  };
}

/**
 * Accounts per subscription status, bucketed for display.
 *
 * `raw` carries the un-bucketed per-status counts alongside, so anything that
 * needs voluntary churn separated from involuntary (the reconcile report, any
 * outreach list) can get it without a second query and without the buckets
 * having to be un-picked.
 */
function subscriptionStatusBreakdown() {
  const rows = getDb().prepare(`
    SELECT subscription_status AS status, COUNT(*) AS n
    FROM organizations GROUP BY subscription_status
  `).all();

  const counts = { trialing: 0, active: 0, past_due: 0, churned: 0, none: 0, other: 0 };
  const raw = {};
  for (const row of rows) {
    const key = row.status == null || row.status === '' ? 'none' : row.status;
    raw[key] = (raw[key] || 0) + row.n;
    counts[normaliseStatus(row.status)] += row.n;
  }
  return { ...counts, raw };
}

/**
 * Canceled subscriptions still inside the period the customer paid for.
 *
 * Stripe marks a subscription canceled at the end of a billing period, so an
 * account can be `canceled` and legitimately still entitled until
 * current_period_end. They are not churned yet and they are not revenue either;
 * counting them as one or the other is wrong both ways, so they get their own
 * number.
 */
function canceledButInPeriod(now = Date.now()) {
  const nowIso = new Date(now).toISOString();
  return getDb().prepare(`
    SELECT COUNT(*) AS n FROM organizations
    WHERE subscription_status = 'canceled'
      AND current_period_end IS NOT NULL
      AND current_period_end > ?
  `).get(nowIso).n;
}

/**
 * MRR that is still being collected but has already been cancelled.
 *
 * These accounts are `active`, entitled, and paying this month — and they have
 * asked Stripe to stop at current_period_end. Their money is in the headline
 * MRR figure today and will be gone at a date already known, which is what
 * makes it different from past_due: past_due is revenue that may not arrive,
 * this is revenue that is definitely leaving, on a schedule.
 *
 * Comped accounts are excluded by mrrContribution() for the same reason they
 * are excluded from MRR: there is nothing to lose.
 *
 * @returns {{mrrEur: number, count: number, accounts: Array}} accounts carry
 *   current_period_end so the operator can see WHEN, not just how much.
 */
function churningMrr() {
  const rows = getDb().prepare(`
    SELECT o.id, o.name, o.plan, o.comped,
           o.subscription_status AS subscriptionStatus,
           o.current_period_end AS currentPeriodEnd,
           (SELECT u.email FROM users u WHERE u.org_id = o.id AND u.role = 'owner'
             ORDER BY u.created_at ASC LIMIT 1) AS ownerEmail
    FROM organizations o
    WHERE o.subscription_status = 'active' AND o.cancel_at_period_end = 1
    ORDER BY COALESCE(o.current_period_end, '9999') ASC
  `).all();

  let mrrEur = 0;
  const accounts = rows.map((r) => {
    const { mrr } = mrrContribution({
      plan: r.plan, subscription_status: r.subscriptionStatus, comped: r.comped,
    });
    mrrEur += mrr;
    return {
      id: r.id,
      name: r.name,
      ownerEmail: r.ownerEmail || null,
      plan: r.plan,
      currentPeriodEnd: r.currentPeriodEnd || null,
      mrrEur: mrr,
      comped: r.comped === 1 || r.comped === true,
    };
  });

  // count is every cancelling account; mrrEur is only what they were paying. A
  // cancelling comped or free account is real and worth reporting, and worth €0.
  return { mrrEur, count: rows.length, accounts };
}

/**
 * Accounts that have run at least one screening, versus those that never have.
 *
 * "Screening" means a screening_runs row, which is minted server-side when an
 * assessment is SAVED (see db.insertAudit -> resolveRunForNonce). An org that
 * analysed CVs and never saved one therefore reads as not activated — which is
 * the right answer for an activation metric: the product's output is the audit
 * record, and a run nobody kept is a trial, not an activation.
 */
function activationStats() {
  const row = getDb().prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN EXISTS (SELECT 1 FROM screening_runs sr WHERE sr.org_id = o.id)
                    THEN 1 ELSE 0 END) AS activated
    FROM organizations o
  `).get();
  const total = row.total || 0;
  const activated = row.activated || 0;
  return {
    total,
    activated,
    neverScreened: total - activated,
    // Guarded: a platform with zero accounts has no activation rate, and
    // 0/0 rendering as NaN% on the dashboard is worse than an honest null.
    activationRate: total > 0 ? Math.round((activated / total) * 1000) / 10 : null,
  };
}

/**
 * Accounts with no activity in the last `days` days.
 *
 * Activity is the later of the account's last screening run and its most recent
 * user login. An account that has never done either falls back to its own
 * created_at, so a signup from this morning is not reported as dormant on the
 * day it was created.
 */
function dormantAccounts(days, now = Date.now()) {
  const n = Number(days);
  if (!Number.isFinite(n) || n <= 0) return [];
  const cutoff = isoDaysAgo(n, now);
  // The activity expression is built once in an inner SELECT and filtered in
  // the outer one. SQLite cannot reference a select alias from WHERE, and
  // repeating this two-subquery MAX() in both clauses is how it silently drifts
  // — the list and the filter would stop agreeing on what "activity" means.
  //
  // MAX() with two arguments is the SCALAR max, not the aggregate: the empty
  // strings make it total over the NULLs (an org with logins but no screenings,
  // or the reverse), and NULLIF turns "neither ever happened" back into NULL so
  // COALESCE can fall through to the signup date.
  return getDb().prepare(`
    SELECT * FROM (
      SELECT o.id, o.name, o.plan, o.subscription_status AS subscriptionStatus,
             o.created_at AS createdAt,
             (SELECT u.email FROM users u WHERE u.org_id = o.id AND u.role = 'owner'
               ORDER BY u.created_at ASC LIMIT 1) AS ownerEmail,
             NULLIF(MAX(
               COALESCE((SELECT MAX(sr.created_at) FROM screening_runs sr WHERE sr.org_id = o.id), ''),
               COALESCE((SELECT MAX(u.last_login_at) FROM users u WHERE u.org_id = o.id), '')
             ), '') AS lastActivityAt
      FROM organizations o
    )
    WHERE COALESCE(lastActivityAt, createdAt) < ?
    ORDER BY COALESCE(lastActivityAt, createdAt) ASC
  `).all(cutoff);
}

/**
 * The `limit` most recent signups: owner email, when, plan, screenings run.
 *
 * ownerEmail is LEFT-JOINed by subquery rather than inner-joined, so an
 * organization with no owner user (the legacy migration org, when OWNER_EMAIL
 * was never configured) still appears with a null email instead of vanishing
 * from the signup list entirely.
 */
function recentSignups(limit = 20) {
  const n = Number(limit);
  const capped = Number.isFinite(n) && n > 0 ? Math.min(Math.trunc(n), 200) : 20;
  return getDb().prepare(`
    SELECT o.id, o.name, o.created_at AS createdAt, o.plan,
           o.subscription_status AS subscriptionStatus, o.comped,
           (SELECT u.email FROM users u WHERE u.org_id = o.id AND u.role = 'owner'
             ORDER BY u.created_at ASC LIMIT 1) AS ownerEmail,
           (SELECT COUNT(*) FROM screening_runs sr WHERE sr.org_id = o.id) AS screeningCount
    FROM organizations o
    ORDER BY o.created_at DESC
    LIMIT ?
  `).all(capped);
}

// --- Daily snapshot ---------------------------------------------------------

// How far back a routine backfill reaches. Matches the 90-day chart on the
// page, plus a day so the first bucket has a predecessor.
const SNAPSHOT_BACKFILL_DAYS = 91;

// Hard ceiling on a self-healing catch-up. A process that has been down for a
// week should recover its week; a database restored from a two-year-old backup
// should NOT silently generate seven hundred rows on the boot path while the
// server is trying to accept traffic. Past this, the routine 91-day window
// applies and the older gap stays visibly empty.
const MAX_SELF_HEAL_DAYS = 400;

// A drift check is a few hundred Stripe calls. The snapshot job runs on every
// boot, and a deploy-heavy afternoon is a dozen boots, so the check self-gates
// on how long ago it last succeeded — the same shape as RETENTION_MIN_GAP_MS in
// services/db.js, and for the same reason.
const DRIFT_MIN_GAP_MS = 20 * 60 * 60 * 1000;

/**
 * Write (or rewrite) the snapshot row for `date` from CURRENT state.
 *
 * Idempotent by construction: ON CONFLICT(date) DO UPDATE sets absolute values
 * rather than incrementing, so calling this on every boot and again every 24h
 * converges on one correct row per day no matter how many times it runs or how
 * often the process restarts.
 *
 * Only ever called for TODAY. Calling it for a past date would stamp today's
 * plan mix onto that date — see the metrics_daily comment in services/db.js.
 *
 * The drift columns are deliberately absent from both the INSERT and the DO
 * UPDATE. They are written by recordDriftCheck() alone, so a snapshot on boot
 * cannot erase a reconciliation result that took hundreds of API calls to get.
 */
function writeSnapshot(date, now = Date.now()) {
  const db = getDb();
  const plans = planBreakdown();
  const statuses = subscriptionStatusBreakdown();
  const dayStart = dayStartIso(date);
  const dayEnd = nextDayStartIso(date);

  const totals = db.prepare('SELECT COUNT(*) AS n FROM organizations WHERE created_at < ?')
    .get(dayEnd).n;
  // Counted directly, not differenced. This is the number that must not move
  // when an account is deleted later.
  const signups = db.prepare(
    'SELECT COUNT(*) AS n FROM organizations WHERE created_at >= ? AND created_at < ?',
  ).get(dayStart, dayEnd).n;
  const screenings = db.prepare(
    'SELECT COUNT(*) AS n FROM screening_runs WHERE created_at >= ? AND created_at < ?',
  ).get(dayStart, dayEnd).n;

  db.prepare(`
    INSERT INTO metrics_daily
      (date, total_accounts, free_count, pro_count, team_count, mrr_eur, active_subs,
       screenings_run, signups_count)
    VALUES (@date, @totalAccounts, @free, @pro, @team, @mrr, @activeSubs, @screenings, @signups)
    ON CONFLICT(date) DO UPDATE SET
      total_accounts = excluded.total_accounts,
      free_count     = excluded.free_count,
      pro_count      = excluded.pro_count,
      team_count     = excluded.team_count,
      mrr_eur        = excluded.mrr_eur,
      active_subs    = excluded.active_subs,
      screenings_run = excluded.screenings_run,
      signups_count  = excluded.signups_count
  `).run({
    date,
    totalAccounts: totals,
    free: plans.counts.free,
    pro: plans.counts.pro,
    team: plans.counts.team,
    mrr: plans.mrrEur,
    activeSubs: statuses.active,
    screenings,
    signups,
  });
  return { date, totalAccounts: totals, signups, screenings, mrrEur: plans.mrrEur };
}

/**
 * Fill in days the job never ran for, using only what is reconstructible.
 *
 * total_accounts, signups_count and screenings_run all derive from a created_at
 * still on disk, so a missed day can be recovered exactly. The plan/MRR columns
 * cannot be — organizations.plan has no history — and are left NULL.
 *
 * INSERT ... ON CONFLICT DO NOTHING, never an UPDATE: a row already written by
 * writeSnapshot() is a real observation and must not be overwritten by a
 * reconstruction that would blank its plan columns. It is also what makes a
 * stored signups_count stable — a reconstruction never revisits a day it has
 * already recorded, so deleting an account cannot rewrite history.
 *
 * Two grouped scans cover the whole range rather than two queries per day.
 *
 * @param {string} fromDate inclusive UTC start, 'YYYY-MM-DD'
 */
function backfillRange(fromDate, now = Date.now()) {
  const db = getDb();
  const today = utcDate(now);
  if (fromDate > today) return { filled: 0, from: fromDate, to: today };
  const fromIso = dayStartIso(fromDate);

  // Accounts created BEFORE the range opens — the running total to build on.
  let running = db.prepare('SELECT COUNT(*) AS n FROM organizations WHERE created_at < ?')
    .get(fromIso).n;

  const signupsByDay = new Map();
  for (const row of db.prepare(`
    SELECT substr(created_at, 1, 10) AS d, COUNT(*) AS n
    FROM organizations WHERE created_at >= ? GROUP BY d
  `).all(fromIso)) signupsByDay.set(row.d, row.n);

  const runsByDay = new Map();
  for (const row of db.prepare(`
    SELECT substr(created_at, 1, 10) AS d, COUNT(*) AS n
    FROM screening_runs WHERE created_at >= ? GROUP BY d
  `).all(fromIso)) runsByDay.set(row.d, row.n);

  const insert = db.prepare(`
    INSERT INTO metrics_daily (date, total_accounts, screenings_run, signups_count)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(date) DO NOTHING
  `);

  let filled = 0;
  db.transaction(() => {
    for (let cursor = Date.parse(fromIso); ; cursor += DAY_MS) {
      const date = utcDate(cursor);
      if (date > today) break;
      const signups = signupsByDay.get(date) || 0;
      running += signups;
      filled += insert.run(date, running, runsByDay.get(date) || 0, signups).changes;
    }
  })();
  return { filled, from: fromDate, to: today };
}

/** Backfill the trailing `days`-day window. */
function backfillSnapshots(days = SNAPSHOT_BACKFILL_DAYS, now = Date.now()) {
  return backfillRange(utcDate(now - (days - 1) * DAY_MS), now);
}

/**
 * Self-healing backfill: cover every missing date from the newest stored row
 * through today, however long the process has been down.
 *
 * The start is the EARLIER of the newest stored date and the routine 91-day
 * window. Taking the newest row alone would leave a hole in the middle of the
 * chart un-repaired (a day the job crashed on, with later days written since);
 * taking the fixed window alone would never recover an outage longer than 91
 * days. The earlier of the two does both in one pass.
 *
 * Idempotent: backfillRange only ever inserts missing dates.
 */
function backfillMissingDays(now = Date.now()) {
  const today = utcDate(now);
  const latest = getDb().prepare('SELECT MAX(date) AS d FROM metrics_daily').get().d;
  const routineStart = utcDate(now - (SNAPSHOT_BACKFILL_DAYS - 1) * DAY_MS);
  const floor = utcDate(now - MAX_SELF_HEAL_DAYS * DAY_MS);

  let from = latest && latest < routineStart ? latest : routineStart;
  // A restore from an ancient backup must not turn the boot path into a
  // thousand-row write. Older gaps stay visibly empty rather than silently
  // costing a startup.
  if (from < floor) from = floor;
  if (from > today) from = today;

  return backfillRange(from, now);
}

/**
 * The whole job: heal the gaps, then write today from live state.
 *
 * Order matters. Backfill first so a process that has been down for a week
 * lays down the missing days, then writeSnapshot overwrites today's
 * reconstruction with the real observation including the plan mix.
 */
function runDailySnapshot(now = Date.now()) {
  const healed = backfillMissingDays(now);
  return { ...writeSnapshot(utcDate(now), now), backfilled: healed.filled, backfilledFrom: healed.from };
}

// --- Passive Stripe drift ----------------------------------------------------

/**
 * Store a SUCCESSFUL drift check against `date`.
 *
 * Written by its own statement rather than folded into writeSnapshot, so the
 * boot-time snapshot cannot blank it. Clears drift_error: this result
 * supersedes whatever failure came before it.
 */
function recordDriftCheck(count, date = utcDate(Date.now()), at = new Date().toISOString()) {
  getDb().prepare(`
    INSERT INTO metrics_daily (date, total_accounts, drift_count, drift_checked_at, drift_error)
    VALUES (?, (SELECT COUNT(*) FROM organizations), ?, ?, NULL)
    ON CONFLICT(date) DO UPDATE SET
      drift_count = excluded.drift_count,
      drift_checked_at = excluded.drift_checked_at,
      drift_error = NULL
  `).run(date, Number(count) || 0, at);
  return { count: Number(count) || 0, checkedAt: at };
}

/**
 * Store a FAILED drift check.
 *
 * Writes drift_error and nothing else. drift_count and drift_checked_at keep
 * whatever they held, so the page goes on showing the last real answer with its
 * real timestamp — visibly stale, which is true — instead of a zero that would
 * read as "checked, and everything agrees".
 */
function recordDriftFailure(message, date = utcDate(Date.now())) {
  const text = String(message || 'unknown error').slice(0, 500);
  getDb().prepare(`
    INSERT INTO metrics_daily (date, total_accounts, drift_error)
    VALUES (?, (SELECT COUNT(*) FROM organizations), ?)
    ON CONFLICT(date) DO UPDATE SET drift_error = excluded.drift_error
  `).run(date, text);
  return { error: text };
}

/**
 * The most recent stored drift result, and the most recent failure since it.
 *
 * Two separate lookups on purpose: the newest SUCCESS is what the page reports,
 * and a failure newer than that success is what tells the operator the figure
 * has stopped being refreshed. Collapsing them into one row would hide whichever
 * came second.
 */
function latestDriftCheck() {
  const db = getDb();
  const ok = db.prepare(
    'SELECT date, drift_count AS count, drift_checked_at AS checkedAt FROM metrics_daily '
    + 'WHERE drift_checked_at IS NOT NULL ORDER BY drift_checked_at DESC LIMIT 1',
  ).get() || null;
  const failed = db.prepare(
    'SELECT date, drift_error AS error FROM metrics_daily '
    + 'WHERE drift_error IS NOT NULL ORDER BY date DESC LIMIT 1',
  ).get() || null;

  return {
    count: ok ? ok.count : null,
    checkedAt: ok ? ok.checkedAt : null,
    // Only surfaced when it is NEWER than the last success — an old failure
    // that a later run recovered from is not news.
    error: failed && (!ok || failed.date >= ok.date) ? failed.error : null,
    errorDate: failed && (!ok || failed.date >= ok.date) ? failed.date : null,
  };
}

/** Whether a passive drift check is due (never run, or last success is stale). */
function driftCheckDue(now = Date.now()) {
  const { checkedAt } = latestDriftCheck();
  if (!checkedAt) return true;
  return (now - Date.parse(checkedAt)) >= DRIFT_MIN_GAP_MS;
}

/**
 * The signups-per-day series the chart draws, from metrics_daily.
 *
 * Prefers the STORED signups_count. Falls back to the day-over-day delta of
 * total_accounts only where that column is NULL, which is only ever a row
 * written before signups_count existed — the fallback is a migration path, not
 * a strategy. The delta is what made history move when an account was deleted;
 * it is kept solely so old rows still render, and clamped at zero because a
 * negative bar on a signups chart is a rendering of a deletion.
 *
 * `days + 1` rows are read so a fallback row on the first rendered day still
 * has a predecessor to difference against.
 */
function signupSeries(days = 90, now = Date.now()) {
  const n = Number.isFinite(Number(days)) && Number(days) > 0 ? Math.trunc(Number(days)) : 90;
  const from = utcDate(now - n * DAY_MS);
  const rows = getDb().prepare(
    'SELECT date, total_accounts AS totalAccounts, screenings_run AS screeningsRun, '
    + 'signups_count AS signupsCount FROM metrics_daily WHERE date >= ? ORDER BY date ASC',
  ).all(from);

  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const stored = row.signupsCount;
    out.push({
      date: row.date,
      signups: stored == null
        ? Math.max(0, row.totalAccounts - rows[i - 1].totalAccounts)
        : stored,
      // So a reader of the data (and the tests) can tell a recorded fact from a
      // reconstruction without re-querying.
      derived: stored == null,
      totalAccounts: row.totalAccounts,
      screeningsRun: row.screeningsRun || 0,
    });
  }
  return out;
}

/** Everything the dashboard renders, in one call. */
function collectMetrics(now = Date.now()) {
  const plans = planBreakdown();
  return {
    generatedAt: new Date(now).toISOString(),
    totalAccounts: totalAccounts(),
    totalUsers: totalUsers(),
    signups: { 7: signupsInPeriod(7, now), 30: signupsInPeriod(30, now), 90: signupsInPeriod(90, now) },
    plans,
    statuses: subscriptionStatusBreakdown(),
    canceledButInPeriod: canceledButInPeriod(now),
    churning: churningMrr(),
    // Read from metrics_daily, written by the nightly job. The page makes no
    // Stripe call to render this.
    drift: latestDriftCheck(),
    activation: activationStats(),
    dormant: dormantAccounts(30, now),
    recentSignups: recentSignups(20),
    series: signupSeries(90, now),
  };
}

module.exports = {
  KNOWN_PLANS,
  KNOWN_STATUSES,
  REPORTED_STATUSES,
  CHURNED_STATUSES,
  NEVER_SUBSCRIBED_STATUSES,
  SNAPSHOT_BACKFILL_DAYS,
  normalisePlan,
  normaliseStatus,
  monthlyPriceFor,
  mrrContribution,
  totalAccounts,
  totalUsers,
  signupsInPeriod,
  planBreakdown,
  subscriptionStatusBreakdown,
  canceledButInPeriod,
  churningMrr,
  activationStats,
  dormantAccounts,
  recentSignups,
  writeSnapshot,
  backfillRange,
  backfillSnapshots,
  backfillMissingDays,
  runDailySnapshot,
  recordDriftCheck,
  recordDriftFailure,
  latestDriftCheck,
  driftCheckDue,
  DRIFT_MIN_GAP_MS,
  MAX_SELF_HEAL_DAYS,
  signupSeries,
  collectMetrics,
};
