'use strict';

/**
 * src/services/stripeReconcile.js — local subscription state vs Stripe.
 *
 * Deliberately NOT part of services/metrics.js. Everything in that module is a
 * local SELECT that always answers instantly; this one makes paid network calls
 * to a third party and can fail, rate-limit or hang. Keeping them apart is what
 * lets GET /admin/metrics render the whole dashboard without touching Stripe,
 * and reconcile only when ?reconcile=1 explicitly asks for it.
 *
 * IT DOES NOT REPAIR PLAN STATE. The webhook (routes/billing.js) is the single
 * writer of plan, subscription_status and current_period_end; it carries an
 * ordering guard in organizations.stripe_event_created, and a second writer
 * racing it from a page load is how you get a downgrade applied twice or an
 * upgrade undone. If one of those is wrong, the fix is to find out why the
 * webhook missed it — never to patch the row from here.
 *
 * The ONE exception is cancel_at_period_end, and it is deliberately narrow.
 * That column was added after these subscriptions existed, so every row that
 * predates it reads 0 whether or not the customer has cancelled — a backfill is
 * the only way it can ever become true, and the webhook cannot do it because
 * the events that would have carried the flag have already been delivered. The
 * write is guarded by a compare-and-swap on stripe_event_created (see
 * backfillCancelFlag), so a webhook landing mid-check always wins.
 *
 * NOTHING LEAVES THE SERVER. Stripe is asked about identifiers WE already
 * store (a subscription id, a customer id) and answers about our own account.
 * No email, no candidate data and no org name is ever sent.
 */

const billing = require('./billing');
const { getDb } = require('./db');

// A page load must not turn into hundreds of serial Stripe round-trips. Orgs
// are examined newest-first, so the cap keeps the most recently-changed
// accounts — the ones a reconciliation is usually chasing.
const MAX_ORGS_TO_CHECK = 200;

const FINDING = Object.freeze({
  PLAN_MISMATCH: 'PLAN_MISMATCH',
  STATUS_MISMATCH: 'STATUS_MISMATCH',
  NO_SUBSCRIPTION: 'NO_SUBSCRIPTION',
  NO_CUSTOMER: 'NO_CUSTOMER',
  ORPHAN_SUBSCRIPTION: 'ORPHAN_SUBSCRIPTION',
  STRIPE_ERROR: 'STRIPE_ERROR',
});

const PAID_PLANS = ['pro', 'team'];

function isComped(org) {
  return org.comped === 1 || org.comped === true;
}

/**
 * Candidate rows for reconciliation: anything with a Stripe link, plus anything
 * on a paid plan. A free org with no customer id has nothing on either side to
 * disagree about and is skipped rather than costing an API call to confirm.
 */
function orgsToCheck(limit = MAX_ORGS_TO_CHECK) {
  return getDb().prepare(`
    SELECT o.id, o.name, o.plan, o.subscription_status AS subscriptionStatus,
           o.current_period_end AS currentPeriodEnd, o.comped,
           o.stripe_customer_id AS stripeCustomerId,
           o.stripe_subscription_id AS stripeSubscriptionId,
           o.cancel_at_period_end AS cancelAtPeriodEnd,
           o.stripe_event_created AS stripeEventCreated,
           (SELECT u.email FROM users u WHERE u.org_id = o.id AND u.role = 'owner'
             ORDER BY u.created_at ASC LIMIT 1) AS ownerEmail
    FROM organizations o
    WHERE o.stripe_customer_id IS NOT NULL
       OR o.stripe_subscription_id IS NOT NULL
       OR o.plan IN ('pro', 'team')
    ORDER BY o.created_at DESC
    LIMIT ?
  `).all(limit);
}

/**
 * The plan a Stripe subscription represents, from its first price.
 *
 * Uses billing.planForPriceId so the mapping is the SAME env-driven one the
 * webhook writes with. Re-deriving it here from tier names would mean a
 * reconciliation that disagrees with the code it is auditing.
 */
function planFromSubscription(sub) {
  const item = sub && sub.items && Array.isArray(sub.items.data) ? sub.items.data[0] : null;
  const priceId = item && item.price ? item.price.id : null;
  return billing.planForPriceId(priceId);
}

/**
 * Backfill organizations.cancel_at_period_end from a live subscription.
 *
 * COMPARE-AND-SWAP on stripe_event_created. That column is the webhook's
 * ordering guard, and it advances on every plan-mutating event. The UPDATE
 * below only lands if it still holds the value read before the Stripe call, so
 * a webhook that arrived while we were waiting on the network — carrying, by
 * definition, fresher truth than the object we fetched — is never overwritten
 * by this slower path. `IS` rather than `=` because the column is NULL on every
 * org that has never received an event, and `= NULL` matches nothing.
 *
 * The status columns are untouched. This writes one boolean and only when it
 * actually differs, so a no-op reconciliation writes nothing at all.
 *
 * @returns {boolean} whether a row was updated
 */
function backfillCancelFlag(org, sub) {
  const desired = sub && sub.cancel_at_period_end ? 1 : 0;
  const current = org.cancelAtPeriodEnd === 1 || org.cancelAtPeriodEnd === true ? 1 : 0;
  if (desired === current) return false;

  const res = getDb().prepare(
    'UPDATE organizations SET cancel_at_period_end = ? WHERE id = ? AND stripe_event_created IS ?',
  ).run(desired, org.id, org.stripeEventCreated == null ? null : org.stripeEventCreated);
  return res.changes > 0;
}

function finding(org, code, detail) {
  return {
    orgId: org.id,
    orgName: org.name,
    ownerEmail: org.ownerEmail || null,
    comped: isComped(org),
    localPlan: org.plan || null,
    localStatus: org.subscriptionStatus || null,
    code,
    ...detail,
  };
}

/**
 * Compare one org against Stripe. Returns an array of findings (usually empty).
 *
 * Split out from reconcile() so the comparison rules are testable without a
 * network: pass a stub `stripe` and the comparison is a function of two records.
 *
 * `stats` accumulates side effects (currently only cancel_at_period_end
 * backfills) so reconcile() can report them without this returning two things.
 */
async function checkOrg(stripe, org, stats = { cancelFlagsWritten: 0 }) {
  const out = [];

  // Comped orgs are entitled with no Stripe subscription behind them — that is
  // what the flag is FOR (services/branding.isCompedOrg). Reporting one as a
  // mismatch every single page load would train the operator to ignore this
  // list, so it is surfaced as informational and never as a disagreement.
  if (isComped(org) && !org.stripeCustomerId && !org.stripeSubscriptionId) {
    return [finding(org, FINDING.NO_CUSTOMER, {
      informational: true,
      stripePlan: null,
      stripeStatus: null,
      note: 'Comped account — entitled locally with no Stripe customer. Expected.',
    })];
  }

  if (!org.stripeCustomerId && !org.stripeSubscriptionId) {
    return [finding(org, FINDING.NO_CUSTOMER, {
      informational: false,
      stripePlan: null,
      stripeStatus: null,
      note: 'On a paid plan with no Stripe customer id and no comped flag.',
    })];
  }

  let sub = null;
  try {
    if (org.stripeSubscriptionId) {
      sub = await stripe.subscriptions.retrieve(org.stripeSubscriptionId);
    } else {
      // No subscription id stored: ask the customer what they have. `status:
      // 'all'` so a canceled subscription is still visible — its absence is
      // otherwise indistinguishable from never having subscribed.
      const list = await stripe.subscriptions.list({
        customer: org.stripeCustomerId, status: 'all', limit: 10,
      });
      const subs = (list && list.data) || [];
      sub = subs.find((s) => s.status === 'active' || s.status === 'trialing' || s.status === 'past_due')
        || subs[0] || null;
    }
  } catch (err) {
    // A Stripe outage or a deleted object must not blank the row. Reporting the
    // error against the org is the finding: "we could not verify this one" is
    // useful, and silently omitting it would read as "this one is fine".
    return [finding(org, FINDING.STRIPE_ERROR, {
      informational: false,
      stripePlan: null,
      stripeStatus: null,
      note: `Stripe lookup failed: ${err && err.message ? err.message : 'unknown error'}`,
    })];
  }

  if (!sub) {
    if (PAID_PLANS.includes(org.plan) && !isComped(org)) {
      out.push(finding(org, FINDING.NO_SUBSCRIPTION, {
        informational: false,
        stripePlan: null,
        stripeStatus: null,
        note: 'Local record says a paid plan; Stripe has no subscription for this customer.',
      }));
    }
    return out;
  }

  // Bring the pending-cancellation flag up to date before comparing anything
  // else. It is not part of the disagreement report — a stale flag on a column
  // that only just exists is expected, not a finding — it is the repair.
  if (backfillCancelFlag(org, sub)) stats.cancelFlagsWritten += 1;

  const stripePlan = planFromSubscription(sub);
  const stripeStatus = sub.status || null;

  // A live Stripe subscription against a local free plan is the expensive
  // direction of this bug: the customer is being charged for something the
  // product is not giving them.
  if (!PAID_PLANS.includes(org.plan)
      && (stripeStatus === 'active' || stripeStatus === 'trialing' || stripeStatus === 'past_due')) {
    out.push(finding(org, FINDING.ORPHAN_SUBSCRIPTION, {
      informational: false, stripePlan, stripeStatus,
      note: 'Stripe has a live subscription but the local plan is not paid — customer may be billed without entitlement.',
    }));
    return out;
  }

  if (stripePlan && stripePlan !== org.plan) {
    out.push(finding(org, FINDING.PLAN_MISMATCH, {
      informational: false, stripePlan, stripeStatus,
      note: `Local plan "${org.plan}" but Stripe price maps to "${stripePlan}".`,
    }));
  }

  if (stripeStatus && stripeStatus !== org.subscriptionStatus) {
    out.push(finding(org, FINDING.STATUS_MISMATCH, {
      informational: false, stripePlan, stripeStatus,
      note: `Local status "${org.subscriptionStatus || 'none'}" but Stripe says "${stripeStatus}".`,
    }));
  }

  return out;
}

/**
 * Reconcile every candidate org against Stripe.
 *
 * @returns {Promise<{configured: boolean, checked: number, capped: boolean,
 *                    findings: Array, error: string|null}>}
 *
 * `configured: false` (no STRIPE_SECRET_KEY) is reported, never thrown: on a
 * dev box or a deploy where billing is not wired up, an empty findings list
 * would falsely read as "everything reconciles".
 */
async function reconcile({ limit = MAX_ORGS_TO_CHECK } = {}) {
  const stripe = billing.getStripe();
  if (!stripe) {
    return {
      configured: false, checked: 0, capped: false, findings: [],
      error: 'Stripe is not configured on this deployment (STRIPE_SECRET_KEY unset).',
    };
  }

  const orgs = orgsToCheck(limit + 1);
  const capped = orgs.length > limit;
  const examined = capped ? orgs.slice(0, limit) : orgs;

  const findings = [];
  const stats = { cancelFlagsWritten: 0 };
  for (const org of examined) {
    // Serial on purpose. Reconciliation is an operator action on an internal
    // page, not a hot path, and firing a few hundred concurrent requests at
    // Stripe is the reliable way to get rate-limited mid-run and produce a
    // partial answer that looks complete.
    findings.push(...await checkOrg(stripe, org, stats));
  }

  // Real disagreements first; the comped/informational rows sink to the bottom.
  findings.sort((a, b) => Number(a.informational) - Number(b.informational));

  return {
    configured: true, checked: examined.length, capped, findings, error: null,
    cancelFlagsWritten: stats.cancelFlagsWritten,
    // The number the passive drift indicator stores. Informational rows (a
    // comped account with no Stripe customer, which is correct) are excluded:
    // a permanent non-zero drift count is a number nobody looks at twice.
    driftCount: findings.filter((f) => !f.informational).length,
  };
}

module.exports = {
  FINDING, MAX_ORGS_TO_CHECK, PAID_PLANS,
  orgsToCheck, planFromSubscription, backfillCancelFlag, checkOrg, reconcile,
};
