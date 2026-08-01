'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

// DATABASE_PATH points production at the Render persistent disk (e.g.
// /opt/render/project/data/fitscore.db); DB_PATH is the legacy alias used by
// existing scripts/docs. The repo-local fallback keeps dev and tests working
// with no env set. Keep in sync with the same constant in routes/templates.js.
const DB_PATH = process.env.DATABASE_PATH || process.env.DB_PATH
  || path.join(__dirname, '..', '..', 'data', 'audit.db');

let db;
let checkpointTimer = null;
let retentionTimer = null;
let dbClosed = false;

const WAL_CHECKPOINT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// --- Retention policy --------------------------------------------------------
// EU AI Act Art. 19 sets a six-month floor for automatically generated logs;
// GDPR storage limitation pushes the other way. Default conservative; never
// below the floor. The floor is enforced at BOTH the API validation layer and
// inside the purge job (the job re-checks because a value could reach the
// column by a path other than the API).
const RETENTION_FLOOR_DAYS = 180;
const RETENTION_DEFAULT_DAYS = 730; // 24 months
const RETENTION_MAX_DAYS = 3650;    // 10 years — generous upper guard
const PURGE_BATCH_SIZE = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// Scheduler: check a few times a day, but only actually purge if the last run
// was long enough ago — so frequent restarts (Render deploys) neither skip nor
// storm the daily job.
const RETENTION_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const RETENTION_MIN_GAP_MS = 20 * 60 * 60 * 1000;       // ~daily cadence

// --- Feature requests ("Suggest an improvement", Pro/Team only) -------------
// The route validates against this list; the table's CHECK constraint below
// repeats the same three values as literal SQL, because SQLite stores DDL as
// text and cannot take a bound parameter there. The route is the gate — the
// CHECK is only a backstop against non-route writers. Widening the set means
// editing BOTH, and see the note above the table for why the DDL edit alone
// does nothing to an existing database.
const FEATURE_REQUEST_CATEGORIES = ['product', 'website', 'other'];
// Business quota, not an abuse guard: 5 submissions per org per ROLLING 24h.
// Deliberately counted from stored rows rather than express-rate-limit, whose
// store is in-memory (lost on every Render deploy), whose window is fixed
// rather than rolling, and which cannot be made atomic with the INSERT.
const FEATURE_REQUEST_MAX_PER_WINDOW = Number.parseInt(process.env.FEATURE_REQUEST_DAILY_MAX, 10) > 0
  ? Number.parseInt(process.env.FEATURE_REQUEST_DAILY_MAX, 10)
  : 5;
const FEATURE_REQUEST_WINDOW_MS = 24 * 60 * 60 * 1000;

function getDb() {
  if (!db) {
    const fs = require('fs');
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    // WAL best practice: keep synchronous at least NORMAL so an OS/power crash
    // can't corrupt the database. SQLite's default is FULL; only raise it if
    // something (e.g. an env-tuned deployment) dropped it below NORMAL. Values:
    // 0=OFF, 1=NORMAL, 2=FULL, 3=EXTRA.
    const syncLevel = db.pragma('synchronous', { simple: true });
    if (typeof syncLevel === 'number' && syncLevel < 1) db.pragma('synchronous = NORMAL');
    initSchema();
    // Boot verification: confirms in Render logs that the app is using the
    // mounted persistent disk, not the ephemeral repo directory.
    console.log('[db] sqlite database opened', { dbPath: DB_PATH, synchronous: db.pragma('synchronous', { simple: true }) });
  }
  return db;
}

// --- WAL checkpointing & graceful shutdown ---------------------------------
// The production DB runs in WAL mode. Without periodic checkpoints the -wal
// sidecar grows without bound and the whole dataset lives in that one file
// until a clean close folds it back into the main .db. We defend both ends:
// a periodic TRUNCATE checkpoint keeps the WAL small, and a signal handler
// closes the DB cleanly on deploy (Render sends SIGTERM) so nothing is stranded
// in the WAL.

// Fold the WAL back into the main database file and reset it to zero length.
// A checkpoint can legitimately fail / partially complete when readers are
// active (SQLITE_BUSY), so failures are logged, never thrown.
function checkpointWal() {
  if (!db || !db.open) return;
  try {
    // Returns [{ busy, log, checkpointed }]; busy > 0 means active readers
    // blocked a full truncate — harmless, the next run catches up.
    const [row] = db.pragma('wal_checkpoint(TRUNCATE)');
    console.log('[db] wal checkpoint', row);
  } catch (err) {
    console.error('[db] wal checkpoint failed (readers active?):', err.message);
  }
}

// Start the periodic WAL checkpoint. .unref() so the timer never keeps the
// process alive on its own. Idempotent — safe to call more than once.
function startWalCheckpointing() {
  if (checkpointTimer) return;
  getDb(); // ensure the handle is open
  checkpointTimer = setInterval(checkpointWal, WAL_CHECKPOINT_INTERVAL_MS);
  checkpointTimer.unref();
}

// Idempotent clean close: stop the checkpoint timer, fold the WAL back into the
// main file one last time, then close the handle. Safe to call twice (double
// signals, or a signal plus a test teardown).
function closeDb() {
  if (dbClosed) return;
  dbClosed = true;
  if (checkpointTimer) { clearInterval(checkpointTimer); checkpointTimer = null; }
  if (retentionTimer) { clearInterval(retentionTimer); retentionTimer = null; }
  if (db && db.open) {
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
    } catch (err) {
      console.error('[db] final checkpoint failed:', err.message);
    }
    db.close(); // better-sqlite3 also checkpoints on close in WAL mode
  }
}

// Graceful shutdown: on SIGTERM/SIGINT (Render sends SIGTERM on every deploy),
// stop accepting new connections, then close the DB cleanly so the WAL is
// folded back into fitscore.db. Idempotent against double signals via the
// shuttingDown guard; a 10s fallback forces exit if a connection won't drain.
function registerGracefulShutdown(server) {
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[db] received ${signal}, shutting down gracefully`);
    const finish = () => { closeDb(); process.exit(0); };
    if (server) {
      server.close(finish);
      setTimeout(finish, 10 * 1000).unref();
    } else {
      finish();
    }
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
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
  // Retained LEGACY column: candidate_id was a per-org hash of the normalized
  // candidate name. It is NO LONGER written for new rows — a name hash conflates
  // distinct same-named applicants and splits one person formatted two ways.
  // Kept (not dropped) only so old shared filter links (candidateId=<hash>)
  // still resolve against historical rows.
  try { getDb().exec('ALTER TABLE audit_log ADD COLUMN candidate_id TEXT'); } catch (_) {}
  // Surrogate candidate identity: opaque per-CV-per-run FK into `candidates`.
  try { getDb().exec('ALTER TABLE audit_log ADD COLUMN candidate_fk TEXT'); } catch (_) {}
  // Scoring inputs (discrimination evidence): an IMMUTABLE snapshot of the exact
  // weights the engine applied for THIS assessment (never a preset reference),
  // plus the scoring-engine version. Captured server-side; NULL when unknown
  // (e.g. legacy rows) — displayed as "not recorded", never as a default.
  try { getDb().exec('ALTER TABLE audit_log ADD COLUMN weights_json TEXT'); } catch (_) {}
  try { getDb().exec('ALTER TABLE audit_log ADD COLUMN engine_version TEXT'); } catch (_) {}

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
  // Composite indexes backing the filtered audit-log query. All are org-scoped
  // first (every query ANDs org_id) and lead into created_at DESC to match the
  // default chronological ordering + pagination.
  getDb().exec('CREATE INDEX IF NOT EXISTS idx_audit_log_org_created ON audit_log(org_id, created_at DESC)');
  getDb().exec('CREATE INDEX IF NOT EXISTS idx_audit_log_org_candidate_created ON audit_log(org_id, candidate_id, created_at DESC)');
  getDb().exec('CREATE INDEX IF NOT EXISTS idx_audit_log_org_candidate_fk_created ON audit_log(org_id, candidate_fk, created_at DESC)');
  // runId filters match the primary key (id), so this mainly serves org-scoped
  // run lookups; id being unique means it collapses to at most one row.
  getDb().exec('CREATE INDEX IF NOT EXISTS idx_audit_log_org_run_created ON audit_log(org_id, id, created_at DESC)');

  // --- Candidate identity --------------------------------------------------
  // A candidate record is ONE uploaded CV within ONE screening run, keyed by an
  // opaque surrogate id NEVER derived from a candidate attribute. screening_runs
  // groups the CVs of one screening pass. run_nonces maps a short-lived, org+user
  // scoped batch nonce (a grouping hint from the client) to a SERVER-minted run
  // id, so a batch's saves join one run without the client ever controlling the
  // run identifier. Every table carries org_id; every query scopes to it.
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS screening_runs (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      role_title TEXT,
      created_at TEXT NOT NULL
    )
  `);
  getDb().exec('CREATE INDEX IF NOT EXISTS idx_screening_runs_org ON screening_runs(org_id, created_at DESC)');
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS candidates (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      run_id TEXT,
      display_name TEXT,
      source_filename TEXT,
      created_at TEXT NOT NULL,
      provenance TEXT
    )
  `);
  getDb().exec('CREATE INDEX IF NOT EXISTS idx_candidates_org_run ON candidates(org_id, run_id)');
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS run_nonces (
      org_id TEXT NOT NULL,
      nonce TEXT NOT NULL,
      run_id TEXT NOT NULL,
      user_id TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (org_id, nonce)
    )
  `);

  // One-time backfill: point every pre-existing audit row at a legacy candidate
  // (one per distinct hash per org). Cheap no-op once every row has a fk.
  try { backfillLegacyCandidates(); } catch (_) {}

  // --- Auth / multi-tenancy tables -----------------------------------------
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS organizations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  // Org-wide audit retention in days. Conservative default of 730 (24 months);
  // hard floor of RETENTION_FLOOR_DAYS enforced at the API and in the purge job.
  // (Existing databases keep their column; the reconciliation UPDATE below
  // raises any pre-existing sub-floor value up to the default.)
  try { getDb().exec('ALTER TABLE organizations ADD COLUMN retention_days INTEGER NOT NULL DEFAULT 730'); } catch (_) {}
  // IANA timezone: audit-log day filters and displayed timestamps are in this
  // zone (created_at itself stays UTC ISO). Default Europe/Amsterdam (CET/CEST).
  try { getDb().exec("ALTER TABLE organizations ADD COLUMN timezone TEXT NOT NULL DEFAULT 'Europe/Amsterdam'"); } catch (_) {}
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

  // Reconcile retention values below the current regulatory floor. Historically
  // the column defaulted to 365 and allowed 0 ("keep forever") plus values as
  // low as 30. Raise any sub-floor value (including 0) up to the conservative
  // default rather than silently start deleting previously-kept data at the
  // floor. Cheap no-op once done (validated writes are already >= floor).
  try {
    getDb().prepare('UPDATE organizations SET retention_days = ? WHERE retention_days < ?')
      .run(RETENTION_DEFAULT_DAYS, RETENTION_FLOOR_DAYS);
  } catch (_) {}

  // Per-org, per-run record of the retention purge. Exactly one row is written
  // per org per run (including zero-row and failed runs), so a MISSING row
  // unambiguously means the job did not run for that org.
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS purge_runs (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      ran_at TEXT NOT NULL,
      cutoff_date TEXT NOT NULL,
      rows_deleted INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER,
      status TEXT NOT NULL,
      error_text TEXT
    )
  `);
  getDb().exec('CREATE INDEX IF NOT EXISTS idx_purge_runs_org_ran ON purge_runs(org_id, ran_at DESC)');

  // Demo requests from the marketing landing page. No raw IPs are stored:
  // ip_hash = sha256(IP_HASH_SALT | client ip), computed in routes/demo.js.
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS demo_requests (
      id TEXT PRIMARY KEY,
      name TEXT,
      email TEXT NOT NULL,
      agency TEXT,
      note TEXT,
      created_at TEXT NOT NULL,
      ip_hash TEXT
    )
  `);

  // In-product feature requests ("Suggest an improvement"), Pro/Team only.
  // The ROW is the source of truth: the notification email to the product inbox
  // is a side effect, and a delivery failure never discards a submission.
  //
  // plan_tier is a SNAPSHOT of the org's plan at submission time — a request
  // sent while on Pro stays a Pro-era request after a downgrade. Never
  // re-derive it from the org's current plan on read.
  //
  // created_at is written explicitly as an ISO-8601 UTC string via nowIso(),
  // deliberately with NO `DEFAULT (datetime('now'))` like audit_log has. The
  // rolling-24h quota compares created_at against a JS toISOString() cutoff,
  // and SQLite's datetime('now') renders "2026-07-31 10:22:33" — a space where
  // ISO has a 'T'. Since ' ' (0x20) sorts before 'T' (0x54), a DEFAULT-stamped
  // row would compare as older than every ISO row and silently escape the
  // quota. screening_runs, candidates and demo_requests already do it this way.
  //
  // status values: new | reviewing | planned | done | declined. Intentionally
  // NOT a CHECK constraint — status is the field a triage workflow grows, it is
  // written by ops rather than by user input, and SQLite cannot ALTER a CHECK.
  //
  // The CHECK on category IS worth its cost (closed set, mirrors the frontend
  // dropdown, guards non-route writers). To widen it later, note that
  // CREATE TABLE IF NOT EXISTS is a silent no-op on an existing database:
  // editing the text below changes FRESH databases only. Widening in production
  // needs a drift-detected 12-step rebuild (create new table, copy, drop,
  // rename, recreate index) inside one db.transaction().
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS feature_requests (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      user_email TEXT,
      category TEXT NOT NULL CHECK (category IN ('product','website','other')),
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      plan_tier TEXT,
      status TEXT NOT NULL DEFAULT 'new',
      created_at TEXT NOT NULL
    )
  `);
  // Backs the rolling-24h quota (org_id equality + created_at range) as a
  // covering index, and the newest-first triage listing. Same shape as
  // idx_audit_log_org_created.
  getDb().exec('CREATE INDEX IF NOT EXISTS idx_feature_requests_org_created ON feature_requests(org_id, created_at DESC)');

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

// Insert an audit record (org-scoped). Mints the surrogate candidate identity
// here (at save time): the batch nonce resolves to a server-minted screening
// run, then a fresh opaque candidate record is created for THIS CV within that
// run, and its id is carried onto the audit_log row as candidate_fk. Two saves
// with the same candidate_name get two distinct candidates — that is the fix.
// The legacy candidate_id hash is intentionally left NULL for new rows.
function insertAudit(data, orgId, userId) {
  const id = uuidv4();
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const runId = resolveRunForNonce(orgId, userId, data.runNonce, data.role, nowMs);
  const candidateFk = createCandidate(orgId, runId, data.candidateName, data.fileName, null, now);
  const stmt = getDb().prepare(`
    INSERT INTO audit_log
    (id, user_id, org_id, candidate_fk, candidate_name, file_name, overall, keywords_score, skills_score,
     experience_score, education_score, weights, weights_json, engine_version, verdict, decision, note, jd_snippet, role, anonymized,
     app_version, model_id, analysis_timestamp, reviewed_by, analysis_detail, created_at, updated_at)
    VALUES
    (@id, @userId, @orgId, @candidateFk, @candidateName, @fileName, @overall, @keywords, @skills,
     @experience, @education, @weights, @weightsJson, @engineVersion, @verdict, @decision, @note, @jdSnippet, @role, @anonymized,
     @appVersion, @modelId, @analysisTimestamp, @reviewedBy, @analysisDetail, @createdAt, @updatedAt)
  `);
  stmt.run({
    id,
    userId: userId || 'legacy',
    orgId: orgId || null,
    candidateFk,
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
    // Server-authoritative, immutable snapshot of the weights the engine used
    // and the engine version. Left NULL when the server can't vouch for them.
    weightsJson: data.weightsJson ? JSON.stringify(data.weightsJson) : null,
    engineVersion: data.engineVersion ? String(data.engineVersion).slice(0, 100) : null,
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

// --- Candidate identity (surrogate) ----------------------------------------

// LEGACY only. The old per-org name hash. Retained so the backfill and old
// shared filter links can still be reasoned about; NEVER used to mint identity
// for new rows (that name-based derivation is exactly the bug being removed).
function normalizeCandidateName(name) {
  return String(name == null ? '' : name).trim().toLowerCase().replace(/\s+/g, ' ');
}
function candidateIdFor(orgId, name) {
  return crypto.createHash('sha256')
    .update(String(orgId || '') + '|' + normalizeCandidateName(name))
    .digest('hex')
    .slice(0, 16);
}

// A batch nonce mapping older than this can no longer append to its run — a
// replayed nonce starts a fresh run instead.
const RUN_NONCE_TTL_MS = 24 * 60 * 60 * 1000;

// Mint a server-controlled screening run.
function createScreeningRun(orgId, roleTitle, createdAtIso) {
  const id = uuidv4();
  getDb().prepare('INSERT INTO screening_runs (id, org_id, role_title, created_at) VALUES (?, ?, ?, ?)')
    .run(id, orgId == null ? 'legacy' : orgId, roleTitle ? String(roleTitle).slice(0, 200) : null, createdAtIso || nowIso());
  return id;
}

// Resolve the screening run for a save. The client-supplied nonce is only a
// grouping HINT: the stored run id is always server-minted. Resolution is scoped
// to (org_id, nonce) AND the same user, and ignores mappings older than the TTL,
// so a nonce can never resolve to another org's run or be replayed to append to
// an old one. Absent/blank nonce -> a fresh standalone run.
function resolveRunForNonce(orgId, userId, nonce, roleTitle, now = Date.now()) {
  const db = getDb();
  const nowIsoStr = new Date(now).toISOString();
  const n = (nonce == null ? '' : String(nonce)).trim().slice(0, 100);
  if (!n) return createScreeningRun(orgId, roleTitle, nowIsoStr);

  const orgKey = orgId == null ? 'legacy' : orgId;
  const cutoff = new Date(now - RUN_NONCE_TTL_MS).toISOString();
  // Opportunistic prune keeps the mapping table bounded and replay-safe.
  try { db.prepare('DELETE FROM run_nonces WHERE created_at < ?').run(cutoff); } catch (_) {}

  const row = db.prepare('SELECT run_id AS runId, user_id AS userId, created_at AS createdAt FROM run_nonces WHERE org_id = ? AND nonce = ?').get(orgKey, n);
  const sameUser = row && (row.userId || null) === (userId || null);
  if (row && sameUser && row.createdAt >= cutoff) return row.runId; // join the existing run

  // Fresh run; (re)map the nonce to it, scoped to this org + user.
  const runId = createScreeningRun(orgId, roleTitle, nowIsoStr);
  db.prepare(`
    INSERT INTO run_nonces (org_id, nonce, run_id, user_id, created_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(org_id, nonce) DO UPDATE SET run_id = excluded.run_id, user_id = excluded.user_id, created_at = excluded.created_at
  `).run(orgKey, n, runId, userId || null, nowIsoStr);
  return runId;
}

// Create one candidate record (one uploaded CV within one run). display_name and
// source_filename are for display only and must never be used to derive, match,
// or look up identity anywhere.
function createCandidate(orgId, runId, displayName, sourceFilename, provenance, createdAtIso) {
  const id = uuidv4();
  getDb().prepare('INSERT INTO candidates (id, org_id, run_id, display_name, source_filename, created_at, provenance) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(
      id, orgId == null ? 'legacy' : orgId, runId || null,
      displayName != null ? String(displayName).slice(0, 300) : null,
      sourceFilename != null ? String(sourceFilename).slice(0, 300) : null,
      createdAtIso || nowIso(), provenance || null
    );
  return id;
}

// One-time backfill: every pre-existing audit row (candidate_fk NULL) is pointed
// at a legacy candidate. Existing rows CANNOT be accurately resolved — a hash
// collision is indistinguishable from a genuine repeat — so we do NOT guess: one
// legacy candidate per distinct (org, hash), marked provenance='legacy_hash'.
// Rows with no hash bucket to one per-org unknown legacy candidate. No row is
// left orphaned. Returns counts only.
function backfillLegacyCandidates() {
  const db = getDb();
  const rows = db.prepare('SELECT id, org_id AS orgId, candidate_id AS hash, candidate_name AS name FROM audit_log WHERE candidate_fk IS NULL').all();
  if (!rows.length) return { candidatesCreated: 0, rowsLinked: 0 };
  const link = db.prepare('UPDATE audit_log SET candidate_fk = ? WHERE id = ?');
  const byKey = new Map();
  let created = 0;
  let linked = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      const orgKey = r.orgId == null ? ' null' : r.orgId;
      const hashKey = (r.hash == null || r.hash === '') ? ' nohash' : r.hash;
      const key = orgKey + '|' + hashKey;
      let cid = byKey.get(key);
      if (!cid) {
        cid = createCandidate(r.orgId, null, r.name || '(unknown — pre-migration)', null, 'legacy_hash');
        byKey.set(key, cid);
        created++;
      }
      link.run(cid, r.id);
      linked++;
    }
  });
  tx();
  return { candidatesCreated: created, rowsLinked: linked };
}

// Whether a candidateId filter value resolves to a legacy candidate (surrogate
// that is a legacy_hash candidate, or an old hash matching this org's rows).
// Used only for the self-describing CSV metadata header.
function isLegacyCandidateFilter(orgId, candidateId) {
  if (!candidateId) return false;
  const db = getDb();
  const c = db.prepare('SELECT provenance AS p FROM candidates WHERE id = ? AND org_id = ?').get(candidateId, orgId);
  if (c) return c.p === 'legacy_hash';
  const legacyRow = db.prepare('SELECT 1 FROM audit_log WHERE org_id = ? AND candidate_id = ? LIMIT 1').get(orgId, candidateId);
  return !!legacyRow;
}

// Whitelisted ORDER BY directions. The only thing the caller influences about
// ordering is which of these two constants is used — the column is hardcoded.
const AUDIT_ORDER_DIR = { asc: 'ASC', desc: 'DESC' };

// Build the org-scoped WHERE clause + bound named params for the audit query.
// SECURITY: org_id is always the first predicate and comes from the caller's
// server-derived orgId, never from request input. Every value is a bound named
// param; only fixed column-name literals are ever concatenated into SQL. Any
// filter whose value is undefined is omitted entirely (callers must reject —
// not silently drop — a malformed filter before calling).
// Columns are prefixed `al.` because the read queries join `candidates` (which
// shares column names like id/org_id/created_at). A candidateId filter matches
// the surrogate FK OR the retained legacy hash column, so both new filters and
// old shared links (candidateId=<hash>) resolve.
function buildAuditWhere({ orgId, from, to, candidateId, runId, actor, action }) {
  const where = ['al.org_id = @orgId'];
  const params = { orgId };
  if (from != null) { where.push('al.created_at >= @from'); params.from = from; }
  if (to != null) { where.push('al.created_at <= @to'); params.to = to; }
  if (candidateId != null) { where.push('(al.candidate_fk = @candidateId OR al.candidate_id = @candidateId)'); params.candidateId = candidateId; }
  if (runId != null) { where.push('al.id = @runId'); params.runId = runId; }
  if (actor != null) { where.push('al.user_id = @actor'); params.actor = actor; }
  if (action != null) { where.push('al.decision = @action'); params.action = action; }
  return { whereSql: where.join(' AND '), params };
}

// Filtered, paginated, org-scoped query over the audit log. Returns
// { rows, total, limit, offset } where total counts every row matching the
// filters, independent of limit/offset. ORDER BY is hardcoded to created_at;
// only the direction varies (two-value whitelist). A secondary sort on the
// primary key gives a total order so pagination can't drop or duplicate rows
// when created_at values collide.
// LEFT JOIN candidates so each row can carry the candidate's provenance (to flag
// legacy identity in the UI). The join is by unique surrogate id; the query is
// already org-scoped by the WHERE, and candidate ids are unguessable UUIDs.
const AUDIT_SELECT_JOIN = 'FROM audit_log al LEFT JOIN candidates c ON c.id = al.candidate_fk';
const AUDIT_SELECT_COLS = 'al.*, c.provenance AS candidate_provenance, c.display_name AS candidate_display_name';

function queryAuditLog(opts = {}) {
  const dir = AUDIT_ORDER_DIR[opts.order] || AUDIT_ORDER_DIR.desc;
  const lim = Math.min(Math.max(parseInt(opts.limit, 10) || 50, 1), 200);
  const off = Math.max(parseInt(opts.offset, 10) || 0, 0);
  const { whereSql, params } = buildAuditWhere(opts);
  const db = getDb();
  const total = db.prepare(`SELECT COUNT(*) AS n FROM audit_log al WHERE ${whereSql}`).get(params).n;
  const rows = db.prepare(
    `SELECT ${AUDIT_SELECT_COLS} ${AUDIT_SELECT_JOIN} WHERE ${whereSql} ORDER BY al.created_at ${dir}, al.id ${dir} LIMIT @limit OFFSET @offset`
  ).all({ ...params, limit: lim, offset: off });
  return { rows: rows.map(formatRow), total, limit: lim, offset: off };
}

// All rows matching the filters, in the requested chronological direction, with
// no pagination — used by the CSV export so the file reflects the whole
// filtered set, not just the current page.
function getFilteredAuditRows(opts = {}) {
  const dir = AUDIT_ORDER_DIR[opts.order] || AUDIT_ORDER_DIR.desc;
  const { whereSql, params } = buildAuditWhere(opts);
  const rows = getDb().prepare(
    `SELECT ${AUDIT_SELECT_COLS} ${AUDIT_SELECT_JOIN} WHERE ${whereSql} ORDER BY al.created_at ${dir}, al.id ${dir}`
  ).all(params);
  return rows.map(formatRow);
}

// Distinct values for the audit-log filter dropdowns, org-scoped. actors are
// { id: user_id, label: a representative reviewed_by email or the id }; actions
// are the decisions present on this org's records.
function getAuditFilterValues(orgId) {
  const db = getDb();
  const actors = db.prepare(`
    SELECT user_id AS id, COALESCE(MAX(NULLIF(reviewed_by, '')), user_id) AS label
    FROM audit_log
    WHERE org_id = ? AND user_id IS NOT NULL AND user_id != ''
    GROUP BY user_id
    ORDER BY label
  `).all(orgId);
  const actions = db.prepare(`
    SELECT DISTINCT decision AS v FROM audit_log
    WHERE org_id = ? AND decision IS NOT NULL AND decision != ''
    ORDER BY decision
  `).all(orgId).map((r) => r.v);
  return { actors, actions };
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

// --- Retention purge --------------------------------------------------------

function dbFileSizeBytes() {
  try { return require('fs').statSync(DB_PATH).size; } catch (_) { return null; }
}

// Effective retention never drops below the floor, even if an out-of-range
// value reached the column by some path other than the validated API. A value
// of 90 purges at 180 days, not 90 — the job independently enforces the floor.
function effectiveRetentionDays(rawDays) {
  const n = Number(rawDays);
  if (!Number.isFinite(n)) return RETENTION_DEFAULT_DAYS;
  return Math.max(Math.floor(n), RETENTION_FLOOR_DAYS);
}

// Purge mode. Live deletion must be an explicit opt-in: only the exact value
// 'live' enables it. Anything else — unset, empty, a typo — resolves to the
// safe default 'dryrun', which computes but never deletes.
function retentionPurgeMode() {
  return String(process.env.RETENTION_PURGE_MODE || '').trim().toLowerCase() === 'live' ? 'live' : 'dryrun';
}

// Shared retention validation — the API layer's enforcement point. Returns
// { ok, days } or { ok:false, code, message }. Rejects below-floor values with
// a message explaining the six-month regulatory floor.
function validateRetentionDays(raw) {
  const days = Number(raw);
  if (!Number.isInteger(days)) {
    return { ok: false, code: 'VALIDATION_ERROR', message: 'retentionDays must be a whole number of days.' };
  }
  if (days < RETENTION_FLOOR_DAYS) {
    return { ok: false, code: 'RETENTION_BELOW_FLOOR', message: `Retention must be at least ${RETENTION_FLOOR_DAYS} days. The EU AI Act (Art. 19) requires automatically generated logs to be kept for at least six months, so retention cannot drop below that regulatory floor.` };
  }
  if (days > RETENTION_MAX_DAYS) {
    return { ok: false, code: 'VALIDATION_ERROR', message: `Retention cannot exceed ${RETENTION_MAX_DAYS} days.` };
  }
  return { ok: true, days };
}

// Delete one org's audit rows older than cutoffIso, PURGE_BATCH_SIZE at a time.
// Each batch is a single atomic DELETE (its own implicit transaction in
// better-sqlite3), so a large first run never holds ONE long write lock that
// would block live screening requests, and an interruption between batches
// leaves no partial transaction. onBatch(runningTotal) runs after each batch.
// Returns rows deleted.
function purgeOrgBatched(db, orgId, cutoffIso, onBatch) {
  const del = db.prepare(
    'DELETE FROM audit_log WHERE id IN (SELECT id FROM audit_log WHERE org_id = ? AND created_at < ? ORDER BY created_at LIMIT ?)'
  );
  let deleted = 0;
  let changed;
  do {
    changed = del.run(orgId, cutoffIso, PURGE_BATCH_SIZE).changes;
    deleted += changed;
    if (changed && typeof onBatch === 'function') onBatch(deleted);
  } while (changed === PURGE_BATCH_SIZE);
  return deleted;
}

// The durable "audit event" recording a purge. Written to the append-only
// audit_changes trail — INSERT is allowed; UPDATE/DELETE are trigger-blocked —
// and NEVER removed by the retention job (which only ever deletes from
// audit_log), so the proof that removal was policy-driven outlives the rows it
// removed. Written only when rows were actually deleted (there is real removal
// to justify); zero-row runs are still fully evidenced by purge_runs.
function writePurgeAuditEvent(db, { runId, orgId, ranAt, cutoffIso, rowsDeleted }) {
  db.prepare(`
    INSERT INTO audit_changes (id, audit_id, org_id, field, old_value, new_value, changed_at, changed_by)
    VALUES (?, ?, ?, '__retention_purge__', NULL, ?, ?, 'system:retention')
  `).run(
    uuidv4(), runId, orgId,
    JSON.stringify({ cutoffDate: cutoffIso, rowsDeleted, retentionFloorDays: RETENTION_FLOOR_DAYS }),
    ranAt
  );
}

// Daily retention purge. Per org: delete audit rows older than
// max(retention_days, floor); write EXACTLY ONE purge_runs row per org per run
// (including zero-row and error runs — a missing row unambiguously means the
// job did not run for that org); write the append-only purge audit event when
// rows were removed; and keep going if one org fails (each org has its own
// try/catch). Checkpoints the WAL once at the end (reusing the existing helper)
// and logs DB file size before/after. Returns counts only — never contents.
//
// Mode: 'live' deletes; 'dryrun' (the default) runs the identical query path,
// records the exact would-delete count with status='dryrun', and deletes
// nothing. rows_deleted in a dryrun record holds the would-delete count.
//
// Options (test seams): now (ms clock), mode ('live'|'dryrun', default from env),
// batchHook(orgId, runningTotal) — runs after each batch (live only) and may
// throw to simulate a mid-batch interruption.
function runRetentionPurge({ now = Date.now(), mode = retentionPurgeMode(), batchHook = null } = {}) {
  const db = getDb();
  const isLive = mode === 'live';
  const sizeBefore = dbFileSizeBytes();
  const orgs = db.prepare('SELECT id, retention_days AS retentionDays FROM organizations').all();
  const insertRun = db.prepare(`
    INSERT INTO purge_runs (id, org_id, ran_at, cutoff_date, rows_deleted, duration_ms, status, error_text)
    VALUES (@id, @orgId, @ranAt, @cutoffDate, @rowsDeleted, @durationMs, @status, @errorText)
  `);
  // Identical predicate to the batched DELETE — used by dryrun to count the
  // exact rows that WOULD be deleted without touching them.
  const countEligible = db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE org_id = ? AND created_at < ?');

  let totalAffected = 0; // rows deleted (live) or would-be-deleted (dryrun)
  let orgsFailed = 0;
  for (const org of orgs) {
    const startedAt = Date.now();
    const ranAt = new Date(now).toISOString();
    const days = effectiveRetentionDays(org.retentionDays);
    const cutoffIso = new Date(now - days * DAY_MS).toISOString();
    const runId = uuidv4();
    try {
      let rows;
      if (isLive) {
        rows = purgeOrgBatched(db, org.id, cutoffIso, batchHook ? (n) => batchHook(org.id, n) : null);
        if (rows > 0) writePurgeAuditEvent(db, { runId, orgId: org.id, ranAt, cutoffIso, rowsDeleted: rows });
      } else {
        rows = countEligible.get(org.id, cutoffIso).n; // compute only; delete nothing
      }
      insertRun.run({ id: runId, orgId: org.id, ranAt, cutoffDate: cutoffIso, rowsDeleted: rows, durationMs: Date.now() - startedAt, status: isLive ? 'success' : 'dryrun', errorText: null });
      totalAffected += rows;
    } catch (err) {
      orgsFailed++;
      // Still record the run so a failure is evidenced, never silent.
      try {
        insertRun.run({ id: runId, orgId: org.id, ranAt, cutoffDate: cutoffIso, rowsDeleted: 0, durationMs: Date.now() - startedAt, status: 'error', errorText: String((err && err.message) || err).slice(0, 500) });
      } catch (_) {}
      console.error(`[retention] purge failed for org ${org.id}:`, err && err.message);
    }
  }

  // Fold deletions back into the main DB file (reuse the existing WAL helper),
  // then log before/after size so the shrink is observable in ops logs.
  checkpointWal();
  const sizeAfter = dbFileSizeBytes();
  console.log(`[retention] purge complete (mode=${mode}): ${totalAffected} row(s) ${isLive ? 'deleted' : 'would be deleted'} across ${orgs.length} org(s), ${orgsFailed} failed; db file ${sizeBefore} -> ${sizeAfter} bytes`);
  return { mode, orgsChecked: orgs.length, rowsDeleted: isLive ? totalAffected : 0, rowsAffected: totalAffected, orgsFailed, sizeBefore, sizeAfter };
}

// True if the purge is due — no run yet, or the last run was long enough ago.
function retentionPurgeDue(now = Date.now()) {
  const row = getDb().prepare('SELECT MAX(ran_at) AS last FROM purge_runs').get();
  if (!row || !row.last) return true;
  return (now - Date.parse(row.last)) >= RETENTION_MIN_GAP_MS;
}

// Start the daily retention schedule. Idempotent; the timer is .unref()'d so it
// never keeps the process alive, and it is cleared by closeDb() on shutdown
// (reusing the existing graceful-shutdown path). The due-check gates actual
// work to ~daily regardless of how often the process restarts.
function startRetentionSchedule() {
  if (retentionTimer) return;
  getDb();
  const mode = retentionPurgeMode();
  console.log(`[retention] schedule started — mode=${mode}` +
    (mode === 'live' ? ' (LIVE deletions enabled)' : ' (dry run: no deletions; set RETENTION_PURGE_MODE=live to enable)'));
  const tick = () => {
    try { if (retentionPurgeDue()) runRetentionPurge(); }
    catch (err) { console.error('[retention] schedule tick failed:', err && err.message); }
  };
  retentionTimer = setInterval(tick, RETENTION_CHECK_INTERVAL_MS);
  retentionTimer.unref();
  tick(); // initial check on boot; runs only if due
}

// How many rows a purge at `days` retention would remove right now (for the UI's
// lowering-retention confirmation). Floor-clamped like the real job.
function countPurgeableRows(orgId, days, now = Date.now()) {
  const eff = effectiveRetentionDays(days);
  const cutoffIso = new Date(now - eff * DAY_MS).toISOString();
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM audit_log WHERE org_id = ? AND created_at < ?').get(orgId, cutoffIso);
  return { days: eff, cutoffDate: cutoffIso, wouldDelete: row.n };
}

// Retention stats for the settings UI: current row count, oldest retained event,
// effective retention + the cutoff/next-purge picture.
function getRetentionStats(orgId, now = Date.now()) {
  const db = getDb();
  const org = db.prepare('SELECT retention_days AS retentionDays FROM organizations WHERE id = ?').get(orgId);
  const retentionDays = org ? org.retentionDays : RETENTION_DEFAULT_DAYS;
  const eff = effectiveRetentionDays(retentionDays);
  const agg = db.prepare('SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM audit_log WHERE org_id = ?').get(orgId);
  const cutoffIso = new Date(now - eff * DAY_MS).toISOString();
  const wouldDeleteNow = db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE org_id = ? AND created_at < ?').get(orgId, cutoffIso).n;
  const last = db.prepare('SELECT MAX(ran_at) AS last FROM purge_runs').get();
  return {
    retentionDays,
    effectiveRetentionDays: eff,
    floorDays: RETENTION_FLOOR_DAYS,
    defaultDays: RETENTION_DEFAULT_DAYS,
    maxDays: RETENTION_MAX_DAYS,
    purgeMode: retentionPurgeMode(),
    rowCount: agg.n,
    oldestCreatedAt: agg.oldest || null,
    cutoffDate: cutoffIso,
    wouldDeleteNow,
    lastPurgeAt: last ? last.last : null,
  };
}

function listPurgeRuns(orgId, limit = 10) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 50);
  return getDb().prepare(`
    SELECT id, ran_at AS ranAt, cutoff_date AS cutoffDate, rows_deleted AS rowsDeleted,
           duration_ms AS durationMs, status, error_text AS errorText
    FROM purge_runs WHERE org_id = ? ORDER BY ran_at DESC, id DESC LIMIT ?
  `).all(orgId, lim);
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
    // Prefer the surrogate FK; fall back to the retained legacy hash for rows
    // not yet backfilled. candidateLegacy flags identity that may merge
    // same-named applicants (from the pre-migration hash).
    candidateId: row.candidate_fk || row.candidate_id || null,
    candidateLegacy: row.candidate_provenance === 'legacy_hash',
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
    // Server-authoritative scoring inputs. null = genuinely not recorded (must
    // never be rendered as a default or empty weight set by any consumer).
    weightsJson: row.weights_json ? (() => { try { return JSON.parse(row.weights_json); } catch { return null; } })() : null,
    engineVersion: row.engine_version || null,
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

// Org IANA timezone for audit-log day filters + displayed timestamps. Falls
// back to the conservative default if unset or invalid.
function getOrgTimezone(orgId) {
  try {
    const row = getDb().prepare('SELECT timezone FROM organizations WHERE id = ?').get(orgId);
    const tz = row && row.timezone;
    return (tz && require('./timezone').isValidTimeZone(tz)) ? tz : 'Europe/Amsterdam';
  } catch (_) { return 'Europe/Amsterdam'; }
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

// --- Demo requests (marketing landing page) ---------------------------------

function insertDemoRequest({ name, email, agency, note, ipHash }) {
  const id = uuidv4();
  const createdAt = nowIso();
  getDb().prepare(`
    INSERT INTO demo_requests (id, name, email, agency, note, created_at, ip_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, name || null, email, agency || null, note || null, createdAt, ipHash || null);
  return { id, createdAt };
}

// --- Feature requests ("Suggest an improvement") -----------------------------

// How many requests this org has filed inside the rolling window ending now.
// Exported mainly so tests and any future usage display can read it without
// attempting a write.
function countRecentFeatureRequests(orgId, now = Date.now()) {
  const since = new Date(now - FEATURE_REQUEST_WINDOW_MS).toISOString();
  return getDb()
    .prepare('SELECT COUNT(*) AS n FROM feature_requests WHERE org_id = ? AND created_at >= ?')
    .get(orgId, since).n;
}

// Atomically check the rolling-24h quota and insert, in one synchronous
// better-sqlite3 transaction — the same check-then-act problem reserveUsage
// solves for the monthly analysis quota, and for the same reason: two
// concurrent submissions must not both observe "4 used" and both write.
//
// .immediate() matters here and does NOT in reserveUsage: that one opens with
// an INSERT OR IGNORE, which takes the write lock straight away. This
// transaction opens with a SELECT, so a default deferred BEGIN would have to
// upgrade to a write lock mid-transaction and can fail with SQLITE_BUSY_SNAPSHOT
// under WAL. BEGIN IMMEDIATE takes the write lock up front instead.
//
// Returns { ok, used, limit, retryAfterSec, row }. On refusal nothing is
// written and retryAfterSec says when the oldest in-window row falls out.
function createFeatureRequestIfUnderQuota({ orgId, userEmail, category, title, body, planTier }, now = Date.now()) {
  const db = getDb();
  const since = new Date(now - FEATURE_REQUEST_WINDOW_MS).toISOString();
  const limit = FEATURE_REQUEST_MAX_PER_WINDOW;

  const tx = db.transaction(() => {
    const used = db
      .prepare('SELECT COUNT(*) AS n FROM feature_requests WHERE org_id = ? AND created_at >= ?')
      .get(orgId, since).n;

    if (used >= limit) {
      // Oldest row still inside the window: once it ages out, a slot frees up.
      const oldest = db
        .prepare('SELECT created_at AS createdAt FROM feature_requests WHERE org_id = ? AND created_at >= ? ORDER BY created_at ASC LIMIT 1')
        .get(orgId, since);
      let retryAfterSec = Math.ceil(FEATURE_REQUEST_WINDOW_MS / 1000);
      if (oldest) {
        const freesAt = Date.parse(oldest.createdAt) + FEATURE_REQUEST_WINDOW_MS;
        retryAfterSec = Math.max(1, Math.ceil((freesAt - now) / 1000));
      }
      return { ok: false, used, limit, retryAfterSec, row: null };
    }

    const id = uuidv4();
    const createdAt = new Date(now).toISOString();
    db.prepare(`
      INSERT INTO feature_requests (id, org_id, user_email, category, title, body, plan_tier, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'new', ?)
    `).run(id, orgId, userEmail || null, category, title, body, planTier || null, createdAt);

    return { ok: true, used: used + 1, limit, retryAfterSec: 0, row: { id, createdAt } };
  });

  return tx.immediate();
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
  closeDb,
  startWalCheckpointing,
  registerGracefulShutdown,
  nowIso,
  currentPeriodKey,
  getUsageCount,
  incrementUsage,
  reserveUsage,
  refundUsage,
  insertDemoRequest,
  countRecentFeatureRequests,
  createFeatureRequestIfUnderQuota,
  FEATURE_REQUEST_CATEGORIES,
  FEATURE_REQUEST_MAX_PER_WINDOW,
  FEATURE_REQUEST_WINDOW_MS,
  getOrgBilling,
  setOrgStripeCustomerId,
  findOrgByStripeCustomerId,
  setOrgPlan,
  runRetentionPurge,
  startRetentionSchedule,
  validateRetentionDays,
  getRetentionStats,
  countPurgeableRows,
  listPurgeRuns,
  RETENTION_FLOOR_DAYS,
  RETENTION_DEFAULT_DAYS,
  RETENTION_MAX_DAYS,
  deleteAllOrgAuditData,
  insertAudit,
  getAllAudits,
  getAuditsByTenant,
  queryAuditLog,
  getFilteredAuditRows,
  getAuditFilterValues,
  candidateIdFor,
  backfillLegacyCandidates,
  isLegacyCandidateFilter,
  getOrgTimezone,
  getAuditById,
  updateAudit,
  deleteAudit,
  getAuditChanges,
  exportCsv,
  getRoles,
  getRoleHistory,
};
