'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', '..', 'data', 'audit.db');

let db;

function getDb() {
  if (!db) {
    const fs = require('fs');
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    initSchema();
  }
  return db;
}

function nowIso() {
  return new Date().toISOString();
}

function initSchema() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT 'legacy',
      candidate_name TEXT NOT NULL,
      file_name TEXT,
      overall INTEGER,
      keywords_score INTEGER,
      skills_score INTEGER,
      experience_score INTEGER,
      education_score INTEGER,
      weights TEXT,
      verdict TEXT,
      decision TEXT,
      note TEXT,
      jd_snippet TEXT,
      role TEXT DEFAULT '',
      anonymized INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT
    )
  `);

  // Backward-compatible column additions
  try { getDb().exec("ALTER TABLE audit_log ADD COLUMN role TEXT DEFAULT ''"); } catch (_) {}
  try { getDb().exec("ALTER TABLE audit_log ADD COLUMN anonymized INTEGER DEFAULT 0"); } catch (_) {}
  try { getDb().exec("ALTER TABLE audit_log ADD COLUMN updated_at TEXT"); } catch (_) {}
  try { getDb().exec("ALTER TABLE audit_log ADD COLUMN user_id TEXT NOT NULL DEFAULT 'legacy'"); } catch (_) {}
  try { getDb().exec('ALTER TABLE audit_log ADD COLUMN org_id TEXT'); } catch (_) {}
  // Provenance fields (EU AI Act Art. 12 record-keeping)
  try { getDb().exec('ALTER TABLE audit_log ADD COLUMN app_version TEXT'); } catch (_) {}
  try { getDb().exec('ALTER TABLE audit_log ADD COLUMN model_id TEXT'); } catch (_) {}
  try { getDb().exec('ALTER TABLE audit_log ADD COLUMN analysis_timestamp TEXT'); } catch (_) {}
  try { getDb().exec('ALTER TABLE audit_log ADD COLUMN reviewed_by TEXT'); } catch (_) {}
  // Structured analysis detail (keywords found/missing, skills, recommendations)
  // captured at save time so the branded report can match the on-screen result.
  try { getDb().exec('ALTER TABLE audit_log ADD COLUMN analysis_detail TEXT'); } catch (_) {}

  // Backfill updated_at for existing rows
  try { getDb().exec("UPDATE audit_log SET updated_at = created_at WHERE updated_at IS NULL OR updated_at = ''"); } catch (_) {}

  // Append-only change log for audit_log
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS audit_changes (
      id TEXT PRIMARY KEY,
      audit_id TEXT NOT NULL,
      field TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      changed_at TEXT NOT NULL,
      changed_by TEXT
    )
  `);
  try { getDb().exec('ALTER TABLE audit_changes ADD COLUMN org_id TEXT'); } catch (_) {}

  // Enforce append-only at DB level: block UPDATE/DELETE via triggers
  try {
    getDb().exec(`
      CREATE TRIGGER IF NOT EXISTS audit_changes_no_update
      BEFORE UPDATE ON audit_changes
      BEGIN SELECT RAISE(ABORT, 'audit_changes is append-only'); END;
    `);
    getDb().exec(`
      CREATE TRIGGER IF NOT EXISTS audit_changes_no_delete
      BEFORE DELETE ON audit_changes
      BEGIN SELECT RAISE(ABORT, 'audit_changes is append-only'); END;
    `);
  } catch (_) {}

  getDb().exec('CREATE INDEX IF NOT EXISTS idx_audit_changes_audit_id ON audit_changes(audit_id)');
  getDb().exec('CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at)');
  getDb().exec('CREATE INDEX IF NOT EXISTS idx_audit_log_role ON audit_log(role)');
  getDb().exec('CREATE INDEX IF NOT EXISTS idx_audit_log_decision ON audit_log(decision)');
  getDb().exec('CREATE INDEX IF NOT EXISTS idx_audit_log_user_id ON audit_log(user_id)');
  getDb().exec('CREATE INDEX IF NOT EXISTS idx_audit_log_org_id ON audit_log(org_id)');

  // --- Auth / multi-tenancy tables -----------------------------------------
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS organizations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  // Org-wide audit retention in days; 0 = keep until manually deleted.
  try { getDb().exec('ALTER TABLE organizations ADD COLUMN retention_days INTEGER NOT NULL DEFAULT 365'); } catch (_) {}
  // Per-org report branding (nullable; falls back to env defaults)
  try { getDb().exec('ALTER TABLE organizations ADD COLUMN brand_display_name TEXT'); } catch (_) {}
  try { getDb().exec('ALTER TABLE organizations ADD COLUMN brand_logo_url TEXT'); } catch (_) {}
  try { getDb().exec('ALTER TABLE organizations ADD COLUMN brand_color TEXT'); } catch (_) {}
  // Billing (Stripe subscriptions, attached to the organization)
  try { getDb().exec('ALTER TABLE organizations ADD COLUMN stripe_customer_id TEXT'); } catch (_) {}
  try { getDb().exec("ALTER TABLE organizations ADD COLUMN plan TEXT NOT NULL DEFAULT 'free'"); } catch (_) {}
  try { getDb().exec('ALTER TABLE organizations ADD COLUMN subscription_status TEXT'); } catch (_) {}
  try { getDb().exec('ALTER TABLE organizations ADD COLUMN current_period_end TEXT'); } catch (_) {}
  try { getDb().exec('ALTER TABLE organizations ADD COLUMN plan_updated_at TEXT'); } catch (_) {}
  // Webhook ordering guard: unix seconds (Stripe event.created) of the last
  // event applied to this org, so stale/out-of-order events can be skipped.
  try { getDb().exec('ALTER TABLE organizations ADD COLUMN stripe_event_created INTEGER'); } catch (_) {}
  // Stripe subscription id — storage only (reconciliation/support), never exposed via API.
  try { getDb().exec('ALTER TABLE organizations ADD COLUMN stripe_subscription_id TEXT'); } catch (_) {}
  getDb().exec('CREATE INDEX IF NOT EXISTS idx_org_stripe_customer ON organizations(stripe_customer_id)');

  // Per-org monthly usage counters (analyses run; periodKey = YYYY-MM)
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS usage_counters (
      org_id TEXT NOT NULL,
      period_key TEXT NOT NULL,
      analysis_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (org_id, period_key)
    )
  `);
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      org_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      created_at TEXT NOT NULL,
      last_login_at TEXT,
      failed_logins INTEGER NOT NULL DEFAULT 0,
      locked_until TEXT
    )
  `);
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS password_resets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL
    )
  `);
  getDb().exec('CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)');
  getDb().exec('CREATE INDEX IF NOT EXISTS idx_password_resets_user_id ON password_resets(user_id)');

  // Team invitations (member invites; accepted to create a 'member' user)
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS invites (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      email TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      token_hash TEXT NOT NULL,
      invited_by TEXT,
      expires_at TEXT NOT NULL,
      accepted_at TEXT,
      revoked_at TEXT,
      created_at TEXT NOT NULL
    )
  `);
  getDb().exec('CREATE INDEX IF NOT EXISTS idx_invites_org_id ON invites(org_id)');
  getDb().exec('CREATE INDEX IF NOT EXISTS idx_invites_token_hash ON invites(token_hash)');

  // templates is also created by routes/templates.js; ensure it exists here so
  // the org_id migration can run regardless of module load order.
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT,
      job_description TEXT,
      weights TEXT,
      owner_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  try { getDb().exec('ALTER TABLE templates ADD COLUMN org_id TEXT'); } catch (_) {}
  getDb().exec('CREATE INDEX IF NOT EXISTS idx_templates_org_id ON templates(org_id)');
}

// Insert an audit record (org-scoped)
function insertAudit(data, orgId, userId) {
  const id = uuidv4();
  const now = nowIso();
  const stmt = getDb().prepare(`
    INSERT INTO audit_log
    (id, user_id, org_id, candidate_name, file_name, overall, keywords_score, skills_score,
     experience_score, education_score, weights, verdict, decision, note, jd_snippet, role, anonymized,
     app_version, model_id, analysis_timestamp, reviewed_by, analysis_detail, created_at, updated_at)
    VALUES
    (@id, @userId, @orgId, @candidateName, @fileName, @overall, @keywords, @skills,
     @experience, @education, @weights, @verdict, @decision, @note, @jdSnippet, @role, @anonymized,
     @appVersion, @modelId, @analysisTimestamp, @reviewedBy, @analysisDetail, @createdAt, @updatedAt)
  `);
  stmt.run({
    id,
    userId: userId || 'legacy',
    orgId: orgId || null,
    appVersion: data.appVersion || null,
    modelId: data.modelId || null,
    analysisTimestamp: data.analysisTimestamp || null,
    reviewedBy: data.reviewedBy || null,
    analysisDetail: data.analysisDetail ? JSON.stringify(data.analysisDetail) : null,
    candidateName: data.candidateName,
    fileName: data.fileName,
    overall: data.overall,
    keywords: data.scores && data.scores.keywords,
    skills: data.scores && data.scores.skills,
    experience: data.scores && data.scores.experience,
    education: data.scores && data.scores.education,
    weights: data.weights ? JSON.stringify(data.weights) : null,
    verdict: data.verdict,
    decision: data.decision,
    note: data.note,
    jdSnippet: data.jdSnippet,
    role: data.role,
    anonymized: data.anonymized ? 1 : 0,
    createdAt: now,
    updatedAt: now,
  });
  return getAuditById(id, orgId);
}

// Get all audit records, scoped to an organization
function getAllAudits({ decision, limit, role, orgId } = {}) {
  let sql = 'SELECT * FROM audit_log WHERE 1=1';
  const params = [];
  if (orgId) { sql += ' AND org_id = ?'; params.push(orgId); }
  if (decision) { sql += ' AND decision = ?'; params.push(decision); }
  if (role) { sql += ' AND role = ?'; params.push(role); }
  sql += ' ORDER BY created_at DESC';
  if (limit) { sql += ' LIMIT ?'; params.push(Number(limit)); }
  const rows = getDb().prepare(sql).all(...params);
  return rows.map(formatRow);
}

// Get all audit records scoped to a specific organization.
// Supports optional role and date-range filters.
// Returns formatted records sorted newest-first.
function getAuditsByTenant(orgId, { role, from, to } = {}) {
  let sql = 'SELECT * FROM audit_log WHERE org_id = ?';
  const params = [orgId];
  if (role) { sql += ' AND role = ?'; params.push(role); }
  if (from) { sql += ' AND created_at >= ?'; params.push(from); }
  if (to) { sql += ' AND created_at <= ?'; params.push(to); }
  sql += ' ORDER BY created_at DESC';
  const rows = getDb().prepare(sql).all(...params);
  return rows.map(formatRow);
}

// Get single audit by ID. When orgId is given, a record belonging to another
// org is treated as not found (no existence leak across tenants).
function getAuditById(id, orgId) {
  const row = orgId
    ? getDb().prepare('SELECT * FROM audit_log WHERE id = ? AND org_id = ?').get(id, orgId)
    : getDb().prepare('SELECT * FROM audit_log WHERE id = ?').get(id);
  return row ? formatRow(row) : null;
}

// PATCH-style update: only mutates allowed fields, returns updated record + array of changes
// Returns { record, changes } or null if not found.
// Audit records are append-only for scoring data (EU AI Act Art. 12): only the
// recruiter's decision and note may change after creation.
const PATCHABLE_FIELDS = ['decision', 'note'];
const DB_FIELD_MAP = {
  decision: 'decision',
  note: 'note',
};

function updateAudit({ id, ...patch }, changedBy, orgId) {
  const existing = orgId
    ? getDb().prepare('SELECT * FROM audit_log WHERE id = ? AND org_id = ?').get(id, orgId)
    : getDb().prepare('SELECT * FROM audit_log WHERE id = ?').get(id);
  if (!existing) return null;

  const changes = [];
  const sets = [];
  const params = {};
  const changedAt = nowIso();

  for (const field of PATCHABLE_FIELDS) {
    if (!(field in patch)) continue;
    const dbField = DB_FIELD_MAP[field];
    const newVal = patch[field] == null ? null : String(patch[field]);
    const oldVal = existing[dbField] == null ? null : String(existing[dbField]);
    if (newVal === oldVal) continue;
    sets.push(`${dbField} = @${field}`);
    params[field] = newVal;
    changes.push({ field, oldValue: oldVal, newValue: newVal });
  }

  if (sets.length === 0) {
    return { record: formatRow(existing), changes };
  }

  sets.push('updated_at = @updatedAt');
  params.updatedAt = changedAt;
  params.id = id;

  const sql = `UPDATE audit_log SET ${sets.join(', ')} WHERE id = @id`;
  getDb().prepare(sql).run(params);

  // Write append-only change log entries
  const insertChange = getDb().prepare(`
    INSERT INTO audit_changes (id, audit_id, org_id, field, old_value, new_value, changed_at, changed_by)
    VALUES (@id, @auditId, @orgId, @field, @oldValue, @newValue, @changedAt, @changedBy)
  `);

  const writeChanges = getDb().transaction((entries) => {
    for (const c of entries) {
      insertChange.run({ id: uuidv4(), auditId: id, orgId: existing.org_id || orgId || null, field: c.field, oldValue: c.oldValue, newValue: c.newValue, changedAt, changedBy: changedBy || null });
    }
  });
  writeChanges(changes);

  return { record: getAuditById(id, orgId), changes };
}

// Delete an audit record and log the deletion in audit_changes
function deleteAudit({ id }, changedBy, orgId) {
  const existing = orgId
    ? getDb().prepare('SELECT * FROM audit_log WHERE id = ? AND org_id = ?').get(id, orgId)
    : getDb().prepare('SELECT * FROM audit_log WHERE id = ?').get(id);
  if (!existing) return false;

  const changedAt = nowIso();
  const doDelete = getDb().transaction(() => {
    getDb().prepare(`
      INSERT INTO audit_changes (id, audit_id, org_id, field, old_value, new_value, changed_at, changed_by)
      VALUES (?, ?, ?, '__deleted__', ?, NULL, ?, ?)
    `).run(uuidv4(), id, existing.org_id || orgId || null, JSON.stringify(formatRow(existing)), changedAt, changedBy || null);
    getDb().prepare('DELETE FROM audit_log WHERE id = ?').run(id);
  });
  doDelete();
  return true;
}

// Get change history for an audit record (newest first, org-scoped)
function getAuditChanges(auditId, orgId) {
  let sql = `
    SELECT id, audit_id as auditId, field, old_value as oldValue, new_value as newValue,
           changed_at as changedAt, changed_by as changedBy
    FROM audit_changes
    WHERE audit_id = ?`;
  const params = [auditId];
  if (orgId) { sql += ' AND org_id = ?'; params.push(orgId); }
  sql += ' ORDER BY changed_at DESC, id DESC';
  return getDb().prepare(sql).all(...params);
}

// Get list of distinct roles (org-scoped)
function getRoles(orgId) {
  const sql = orgId
    ? "SELECT DISTINCT role, COUNT(*) as count FROM audit_log WHERE org_id = ? AND role != '' GROUP BY role ORDER BY role ASC"
    : "SELECT DISTINCT role, COUNT(*) as count FROM audit_log WHERE role != '' GROUP BY role ORDER BY role ASC";
  const rows = orgId
    ? getDb().prepare(sql).all(orgId)
    : getDb().prepare(sql).all();
  return rows;
}

// Get score history for a specific role (org-scoped)
function getRoleHistory(role, orgId) {
  const sql = orgId
    ? 'SELECT id, candidate_name, overall, decision, created_at FROM audit_log WHERE role = ? AND org_id = ? ORDER BY created_at DESC LIMIT 100'
    : 'SELECT id, candidate_name, overall, decision, created_at FROM audit_log WHERE role = ? ORDER BY created_at DESC LIMIT 100';
  const rows = orgId
    ? getDb().prepare(sql).all(role, orgId)
    : getDb().prepare(sql).all(role);
  return rows.map((r) => ({
    id: r.id,
    candidateName: r.candidate_name,
    overall: r.overall,
    decision: r.decision,
    createdAt: r.created_at,
  }));
}

// Export as CSV (org-scoped)
function exportCsv(filters = {}) {
  const rows = getAllAudits(filters);
  const headers = ['id','candidateName','fileName','overall','keywords','skills','experience','education','weights','verdict','decision','note','jdSnippet','role','anonymized','appVersion','modelId','analysisTimestamp','reviewedBy','createdAt','updatedAt'];
  const csvRows = [headers.join(',')];
  for (const row of rows) {
    const formatted = formatRow(row);
    csvRows.push([
      esc(formatted.id),
      esc(formatted.candidateName),
      esc(formatted.fileName),
      formatted.overall,
      formatted.scores.keywords,
      formatted.scores.skills,
      formatted.scores.experience,
      formatted.scores.education,
      esc(JSON.stringify(formatted.weights)),
      esc(formatted.verdict),
      esc(formatted.decision),
      esc(formatted.note),
      esc(formatted.jdSnippet),
      esc(formatted.role),
      formatted.anonymized ? 1 : 0,
      esc(formatted.appVersion),
      esc(formatted.modelId),
      esc(formatted.analysisTimestamp),
      esc(formatted.reviewedBy),
      esc(formatted.createdAt),
      esc(formatted.updatedAt),
    ].join(','));
  }
  return csvRows.join('\n');
}

function esc(v) {
  if (v == null) return '""';
  return '"' + String(v).replace(/"/g, '""') + '"';
}

// --- Retention (GDPR storage limitation) -----------------------------------
// audit_changes is guarded by append-only triggers; retention/erasure jobs are
// the two legitimate hard-delete paths, so they lift the DELETE trigger for
// the duration of the transaction and restore it afterwards.

const AUDIT_CHANGES_NO_DELETE_TRIGGER = `
  CREATE TRIGGER IF NOT EXISTS audit_changes_no_delete
  BEFORE DELETE ON audit_changes
  BEGIN SELECT RAISE(ABORT, 'audit_changes is append-only'); END;
`;

// Hard-deletes audit records older than each org's retention_days (0 = keep
// forever), including their change-history rows and any change rows older
// than the cutoff (e.g. deletion snapshots of already-removed records).
// Returns counts only — never record contents.
function purgeExpiredAudits() {
  const db = getDb();
  const orgs = db.prepare('SELECT id, retention_days FROM organizations WHERE retention_days > 0').all();
  let recordsDeleted = 0;
  let changesDeleted = 0;
  if (!orgs.length) return { recordsDeleted, changesDeleted, orgsChecked: 0 };

  db.exec('DROP TRIGGER IF EXISTS audit_changes_no_delete');
  try {
    const purgeOrg = db.transaction((orgId, cutoffIso) => {
      const ids = db.prepare('SELECT id FROM audit_log WHERE org_id = ? AND created_at < ?').all(orgId, cutoffIso).map((r) => r.id);
      for (const id of ids) {
        changesDeleted += db.prepare('DELETE FROM audit_changes WHERE audit_id = ?').run(id).changes;
      }
      recordsDeleted += db.prepare('DELETE FROM audit_log WHERE org_id = ? AND created_at < ?').run(orgId, cutoffIso).changes;
      // Orphaned change rows (e.g. __deleted__ snapshots) age out on the same clock
      changesDeleted += db.prepare('DELETE FROM audit_changes WHERE org_id = ? AND changed_at < ?').run(orgId, cutoffIso).changes;
    });
    for (const org of orgs) {
      const cutoffIso = new Date(Date.now() - org.retention_days * 24 * 60 * 60 * 1000).toISOString();
      purgeOrg(org.id, cutoffIso);
    }
  } finally {
    db.exec(AUDIT_CHANGES_NO_DELETE_TRIGGER);
  }
  return { recordsDeleted, changesDeleted, orgsChecked: orgs.length };
}

// Org-wide erasure: hard-deletes ALL audit records and change history for an
// organization (owner-confirmed). Returns counts only.
function deleteAllOrgAuditData(orgId) {
  const db = getDb();
  let recordsDeleted = 0;
  let changesDeleted = 0;
  db.exec('DROP TRIGGER IF EXISTS audit_changes_no_delete');
  try {
    const wipe = db.transaction(() => {
      changesDeleted = db.prepare('DELETE FROM audit_changes WHERE org_id = ?').run(orgId).changes;
      recordsDeleted = db.prepare('DELETE FROM audit_log WHERE org_id = ?').run(orgId).changes;
    });
    wipe();
  } finally {
    db.exec(AUDIT_CHANGES_NO_DELETE_TRIGGER);
  }
  return { recordsDeleted, changesDeleted };
}

function formatRow(row) {
  // Tolerant: accepts both DB rows and already-formatted records
  if (!row) return row;
  if (row.scores) return row;
  return {
    id: row.id,
    userId: row.user_id,
    candidateName: row.candidate_name,
    fileName: row.file_name,
    overall: row.overall,
    scores: {
      keywords: row.keywords_score,
      skills: row.skills_score,
      experience: row.experience_score,
      education: row.education_score,
    },
    weights: row.weights ? (() => { try { return JSON.parse(row.weights); } catch { return null; } })() : null,
    verdict: row.verdict,
    decision: row.decision,
    note: row.note,
    jdSnippet: row.jd_snippet,
    role: row.role,
    anonymized: row.anonymized === 1,
    appVersion: row.app_version || null,
    modelId: row.model_id || null,
    analysisTimestamp: row.analysis_timestamp || null,
    reviewedBy: row.reviewed_by || null,
    analysisDetail: row.analysis_detail ? (() => { try { return JSON.parse(row.analysis_detail); } catch { return null; } })() : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
  };
}

// --- Usage metering (per org, per calendar month) --------------------------

// Current period key in UTC, YYYY-MM.
function currentPeriodKey(date = new Date()) {
  return date.toISOString().slice(0, 7);
}

// Analyses used by an org in a given period (defaults to current month).
function getUsageCount(orgId, periodKey = currentPeriodKey()) {
  const row = getDb().prepare('SELECT analysis_count AS c FROM usage_counters WHERE org_id = ? AND period_key = ?').get(orgId, periodKey);
  return row ? row.c : 0;
}

// Atomically add `n` to an org's counter for the current period; returns the new total.
function incrementUsage(orgId, n, periodKey = currentPeriodKey()) {
  getDb().prepare(`
    INSERT INTO usage_counters (org_id, period_key, analysis_count) VALUES (?, ?, ?)
    ON CONFLICT(org_id, period_key) DO UPDATE SET analysis_count = analysis_count + excluded.analysis_count
  `).run(orgId, periodKey, n);
  return getUsageCount(orgId, periodKey);
}

// Atomically reserve `n` analyses against the org's monthly counter, inside a
// synchronous better-sqlite3 transaction so check+increment cannot race two
// concurrent requests past the limit. limit == null (unlimited) always
// reserves — the counter still increments, so usage stats stay intact.
// Returns { ok, used }: used is the post-reservation count on success, or the
// current count on refusal (nothing written).
function reserveUsage(orgId, n, limit, periodKey = currentPeriodKey()) {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO usage_counters (org_id, period_key, analysis_count) VALUES (?, ?, 0)').run(orgId, periodKey);
    const count = db.prepare('SELECT analysis_count AS c FROM usage_counters WHERE org_id = ? AND period_key = ?').get(orgId, periodKey).c;
    if (limit != null && count + n > limit) return { ok: false, used: count };
    db.prepare('UPDATE usage_counters SET analysis_count = analysis_count + ? WHERE org_id = ? AND period_key = ?').run(n, orgId, periodKey);
    return { ok: true, used: count + n };
  });
  return tx();
}

// Return `n` previously-reserved analyses to the counter (files that failed to
// process). Floors at 0; n <= 0 and missing rows are no-ops.
function refundUsage(orgId, n, periodKey = currentPeriodKey()) {
  if (!(n > 0)) return;
  getDb().prepare('UPDATE usage_counters SET analysis_count = MAX(0, analysis_count - ?) WHERE org_id = ? AND period_key = ?').run(n, orgId, periodKey);
}

// --- Billing state (Stripe; attached to the organization) ------------------

function getOrgBilling(orgId) {
  const row = getDb().prepare(`
    SELECT stripe_customer_id AS stripeCustomerId, plan, subscription_status AS subscriptionStatus,
           current_period_end AS currentPeriodEnd, plan_updated_at AS planUpdatedAt,
           stripe_event_created AS stripeEventCreated, stripe_subscription_id AS stripeSubscriptionId
    FROM organizations WHERE id = ?
  `).get(orgId);
  return row || null;
}

function setOrgStripeCustomerId(orgId, customerId) {
  getDb().prepare('UPDATE organizations SET stripe_customer_id = ? WHERE id = ?').run(customerId, orgId);
}

function findOrgByStripeCustomerId(customerId) {
  return getDb().prepare('SELECT id FROM organizations WHERE stripe_customer_id = ?').get(customerId) || null;
}

// Sets plan state from a webhook event (idempotent — always sets absolute
// state, never toggles). Optional fields are written only when the key is
// present, so a caller can advance the ordering guard / subscription id
// without clobbering the other:
//   eventCreated         -> stripe_event_created  (unix seconds; ordering guard)
//   stripeSubscriptionId -> stripe_subscription_id (pass null to clear on cancel)
function setOrgPlan(orgId, fields) {
  const { plan, subscriptionStatus, currentPeriodEnd, eventCreated } = fields;
  const sets = ['plan = ?', 'subscription_status = ?', 'current_period_end = ?', 'plan_updated_at = ?'];
  const params = [plan, subscriptionStatus || null, currentPeriodEnd || null, nowIso()];
  if ('eventCreated' in fields) {
    sets.push('stripe_event_created = ?');
    params.push(Number.isFinite(eventCreated) ? eventCreated : null);
  }
  if ('stripeSubscriptionId' in fields) {
    sets.push('stripe_subscription_id = ?');
    params.push(fields.stripeSubscriptionId || null);
  }
  params.push(orgId);
  getDb().prepare(`UPDATE organizations SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

module.exports = {
  getDb,
  nowIso,
  currentPeriodKey,
  getUsageCount,
  incrementUsage,
  reserveUsage,
  refundUsage,
  getOrgBilling,
  setOrgStripeCustomerId,
  findOrgByStripeCustomerId,
  setOrgPlan,
  purgeExpiredAudits,
  deleteAllOrgAuditData,
  insertAudit,
  getAllAudits,
  getAuditsByTenant,
  getAuditById,
  updateAudit,
  deleteAudit,
  getAuditChanges,
  exportCsv,
  getRoles,
  getRoleHistory,
};
