'use strict';

/**
 * src/services/orgDeletion.js — delete an organization and everything linked to
 * it, on the customer's request (Privacy Policy: "Deleting your account").
 *
 * There is no in-product button for this yet; the operator runs
 * scripts/delete-org.js in the Render shell. This module is what it calls, so
 * the rules live in code and are tested, not in a runbook.
 *
 *   planOrgDeletion(orgId)     what would be deleted: counts per table, the org
 *                              name, and the Stripe subscription on record.
 *   deleteOrgCompletely(orgId) delete it all in ONE transaction, or nothing.
 *
 * Refuses while a Stripe subscription has not ended: the account is deleted
 * only after the subscription has ended (canceled / incomplete_expired), so
 * Stripe never bills an organization that no longer exists. Stripe itself is
 * never called — the customer and its invoices stay at Stripe.
 *
 * TABLES is an explicit list, on purpose. src/services/orgDeletion.test.js
 * reads the real schema and fails when a table that references an organization
 * or a user is not listed here (or in UNRELATED), so a new table cannot be
 * forgotten by an erasure.
 *
 * Returns and logs counts only; never a name, an email or a note — apart from
 * the organization's own name, which the operator types to confirm.
 */

const db = require('./db');

// Ended means Stripe will never bill this subscription again.
const ENDED_SUBSCRIPTION_STATUSES = new Set(['canceled', 'incomplete_expired']);

// How each table is reached. Order matters: children before parents, and the
// organization row (which carries the billing references and the logo) last.
//   org    — rows WHERE org_id = :org
//   users  — rows whose user_id is one of the org's users
//   emails — rows sent from one of the org's users' email addresses (demo
//            requests; trial offers that never reached an org)
const TABLES = [
  ['audit_changes', 'org'],        // change history (append-only trigger lifted for this)
  ['audit_log', 'org'],            // audit records
  ['analysis_provenance', 'org'],  // provenance bindings
  ['candidates', 'org'],
  ['screening_runs', 'org'],
  ['run_nonces', 'org'],
  ['usage_counters', 'org'],
  ['purge_runs', 'org'],           // retention-job evidence for this org
  ['feature_requests', 'org'],
  ['templates', 'org'],
  ['invites', 'org'],              // pending team invitations
  ['trial_emails', 'org'],
  ['trial_invites', 'org+emails'], // trial data: the org's offer, and offers to its users' addresses
  ['admin_access_log', 'org'],
  ['demo_requests', 'emails'],
  ['sessions', 'users'],
  ['password_resets', 'users'],
  ['users', 'org'],
  ['organizations', 'self'],       // billing references, branding and the logo (stored as data in this row)
];

// Tables that hold nothing about any one organization.
const UNRELATED = {
  metrics_daily: 'daily aggregate counts across all organizations; no per-organization row',
};

function subscriptionState(org) {
  const status = org.subscriptionStatus || null;
  const hasSubscription = !!(org.subscriptionId || status);
  const active = hasSubscription && !ENDED_SUBSCRIPTION_STATUSES.has(status);
  return { hasSubscription, status, active };
}

function scopes(conn, orgId) {
  const userIds = conn.prepare('SELECT id FROM users WHERE org_id = ?').all(orgId).map((r) => r.id);
  const emails = conn.prepare('SELECT lower(email) AS e FROM users WHERE org_id = ?').all(orgId).map((r) => r.e);
  return { userIds, emails };
}

function whereFor(table, how, orgId, { userIds, emails }) {
  const list = (vals) => (vals.length ? vals.map(() => '?').join(', ') : 'NULL');
  switch (how) {
    case 'self': return { sql: 'id = ?', args: [orgId] };
    case 'org': return { sql: 'org_id = ?', args: [orgId] };
    case 'users': return { sql: `user_id IN (${list(userIds)})`, args: userIds };
    case 'emails': return { sql: `lower(trim(email)) IN (${list(emails)})`, args: emails };
    case 'org+emails': return { sql: `org_id = ? OR lower(trim(email)) IN (${list(emails)})`, args: [orgId, ...emails] };
    default: throw new Error(`orgDeletion: unknown scope ${how} for ${table}`);
  }
}

/** @returns {null | {orgId, name, subscription, counts: Record<string, number>, total}} */
function planOrgDeletion(orgId) {
  const conn = db.getDb();
  const org = conn.prepare(`
    SELECT id, name, stripe_subscription_id AS subscriptionId, subscription_status AS subscriptionStatus
      FROM organizations WHERE id = ?
  `).get(orgId);
  if (!org) return null;
  const s = scopes(conn, orgId);
  const counts = {};
  for (const [table, how] of TABLES) {
    const w = whereFor(table, how, orgId, s);
    counts[table] = conn.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${w.sql}`).get(...w.args).n;
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return { orgId, name: org.name, subscription: subscriptionState(org), counts, total };
}

/**
 * Delete the organization and everything linked to it, in one transaction.
 * Throws (deleting nothing) if the organization does not exist or its Stripe
 * subscription has not ended.
 * @returns {{counts: Record<string, number>, total: number}}
 */
function deleteOrgCompletely(orgId) {
  const plan = planOrgDeletion(orgId);
  if (!plan) throw new Error('No such organization.');
  if (plan.subscription.active) {
    throw new Error(`Refusing: the Stripe subscription has not ended (status: ${plan.subscription.status || 'unknown'}).`);
  }
  const conn = db.getDb();
  const s = scopes(conn, orgId);
  const counts = {};
  conn.exec('DROP TRIGGER IF EXISTS audit_changes_no_delete');
  try {
    conn.transaction(() => {
      for (const [table, how] of TABLES) {
        const w = whereFor(table, how, orgId, s);
        counts[table] = conn.prepare(`DELETE FROM ${table} WHERE ${w.sql}`).run(...w.args).changes;
      }
      if (counts.organizations !== 1) throw new Error('organization row did not delete');
    }).immediate();
  } finally {
    conn.exec(db.AUDIT_CHANGES_NO_DELETE_TRIGGER);
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return { counts, total };
}

module.exports = { planOrgDeletion, deleteOrgCompletely, TABLES, UNRELATED, ENDED_SUBSCRIPTION_STATUSES };
