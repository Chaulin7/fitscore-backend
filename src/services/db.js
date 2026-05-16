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
  try { getDb().exec("ALTER TABLE audit_log ADD COLUMN role TEXT DEFAULT ''"); } catch(_) {}
  try { getDb().exec("ALTER TABLE audit_log ADD COLUMN anonymized INTEGER DEFAULT 0"); } catch(_) {}
  try { getDb().exec("ALTER TABLE audit_log ADD COLUMN updated_at TEXT"); } catch(_) {}

  // Backfill updated_at for existing rows
  try { getDb().exec("UPDATE audit_log SET updated_at = created_at WHERE updated_at IS NULL OR updated_at = ''"); } catch(_) {}

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
  } catch(_) {}

  getDb().exec('CREATE INDEX IF NOT EXISTS idx_audit_changes_audit_id ON audit_changes(audit_id)');
  getDb().exec('CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at)');
  getDb().exec('CREATE INDEX IF NOT EXISTS idx_audit_log_role ON audit_log(role)');
  getDb().exec('CREATE INDEX IF NOT EXISTS idx_audit_log_decision ON audit_log(decision)');
}

// Insert an audit record
function insertAudit(data) {
  const id = uuidv4();
  const now = nowIso();
  const stmt = getDb().prepare(`
    INSERT INTO audit_log
      (id, candidate_name, file_name, overall, keywords_score, skills_score,
       experience_score, education_score, weights, verdict, decision, note, jd_snippet, role, anonymized, created_at, updated_at)
    VALUES
      (@id, @candidateName, @fileName, @overall, @keywords, @skills,
       @experience, @education, @weights, @verdict, @decision, @note, @jdSnippet, @role, @anonymized, @createdAt, @updatedAt)
  `);
  stmt.run({
    id,
    candidateName: data.candidateName,
    fileName: data.fileName || '',
    overall: data.overall || 0,
    keywords: data.scores?.keywords || 0,
    skills: data.scores?.skills || 0,
    experience: data.scores?.experience || 0,
    education: data.scores?.education || 0,
    weights: data.weights ? JSON.stringify(data.weights) : null,
    verdict: data.verdict || '',
    decision: data.decision || '',
    note: data.note || '',
    jdSnippet: data.jdSnippet || '',
    role: data.role || '',
    anonymized: data.anonymized ? 1 : 0,
    createdAt: now,
    updatedAt: now
  });

  return getAuditById(id);
}

// Get all audit records (legacy signature kept for backward compat)
function getAllAudits({ decision, limit, role } = {}) {
  let sql = 'SELECT * FROM audit_log WHERE 1=1';
  const params = [];

  if (decision) { sql += ' AND decision = ?'; params.push(decision); }
  if (role) { sql += ' AND role = ?'; params.push(role); }

  sql += ' ORDER BY created_at DESC';

  if (limit) { sql += ' LIMIT ?'; params.push(Number(limit)); }

  const rows = getDb().prepare(sql).all(...params);
  return rows.map(formatRow);
}

// Get single audit by ID
function getAuditById(id) {
  const row = getDb().prepare('SELECT * FROM audit_log WHERE id = ?').get(id);
  return row ? formatRow(row) : null;
}

// PATCH-style update: only mutates allowed fields, returns updated record + array of changes
// Returns { record, changes } or null if not found.
const PATCHABLE_FIELDS = ['decision', 'note', 'role', 'candidateName'];
const DB_FIELD_MAP = { decision: 'decision', note: 'note', role: 'role', candidateName: 'candidate_name' };

function updateAudit(id, patch, changedBy) {
  const existing = getDb().prepare('SELECT * FROM audit_log WHERE id = ?').get(id);
  if (!existing) return null;

  const changes = [];
  const sets = [];
  const params = {};
  const changedAt = nowIso();

  for (const field of PATCHABLE_FIELDS) {
    if (!(field in patch)) continue;
    const dbField = DB_FIELD_MAP[field];
    const newVal = patch[field] == null ? '' : String(patch[field]);
    const oldVal = existing[dbField] == null ? '' : String(existing[dbField]);
    if (newVal === oldVal) continue;
    sets.push(`${dbField} = @${field}`);
    params[field] = newVal;
    changes.push({ field, oldValue: oldVal, newValue: newVal });
  }

  if (sets.length === 0) {
    return { record: formatRow(existing), changes: [] };
  }

  sets.push('updated_at = @updatedAt');
  params.updatedAt = changedAt;
  params.id = id;

  const sql = `UPDATE audit_log SET ${sets.join(', ')} WHERE id = @id`;
  getDb().prepare(sql).run(params);

  // Write append-only change log entries
  const insertChange = getDb().prepare(`
    INSERT INTO audit_changes (id, audit_id, field, old_value, new_value, changed_at, changed_by)
    VALUES (@id, @auditId, @field, @oldValue, @newValue, @changedAt, @changedBy)
  `);
  const tx = getDb().transaction((entries) => {
    for (const c of entries) {
      insertChange.run({
        id: uuidv4(),
        auditId: id,
        field: c.field,
        oldValue: c.oldValue,
        newValue: c.newValue,
        changedAt,
        changedBy: changedBy || null
      });
    }
  });
  tx(changes);

  return { record: getAuditById(id), changes };
}

// Delete an audit record and log the deletion in audit_changes
function deleteAudit(id, changedBy) {
  const existing = getDb().prepare('SELECT * FROM audit_log WHERE id = ?').get(id);
  if (!existing) return false;
  const changedAt = nowIso();
  const tx = getDb().transaction(() => {
    getDb().prepare(`
      INSERT INTO audit_changes (id, audit_id, field, old_value, new_value, changed_at, changed_by)
      VALUES (?, ?, '__deleted__', ?, NULL, ?, ?)
    `).run(uuidv4(), id, JSON.stringify(formatRow(existing)), changedAt, changedBy || null);
    getDb().prepare('DELETE FROM audit_log WHERE id = ?').run(id);
  });
  tx();
  return true;
}

// Get change history for an audit record (newest first)
function getAuditChanges(auditId) {
  const rows = getDb().prepare(`
    SELECT id, audit_id as auditId, field, old_value as oldValue, new_value as newValue,
           changed_at as changedAt, changed_by as changedBy
    FROM audit_changes
    WHERE audit_id = ?
    ORDER BY changed_at DESC, id DESC
  `).all(auditId);
  return rows;
}

// Get list of distinct roles
function getRoles() {
  const rows = getDb().prepare("SELECT DISTINCT role, COUNT(*) as count FROM audit_log WHERE role != '' GROUP BY role ORDER BY role").all();
  return rows;
}

// Get score history for a specific role
function getRoleHistory(role) {
  const rows = getDb().prepare(`
    SELECT id, candidate_name, overall, decision, created_at
    FROM audit_log
    WHERE role = ?
    ORDER BY created_at DESC
    LIMIT 100
  `).all(role);
  return rows.map(r => ({
    id: r.id,
    candidateName: r.candidate_name,
    overall: r.overall,
    decision: r.decision,
    createdAt: r.created_at
  }));
}

// Export as CSV
function exportCsv(filters = {}) {
  const rows = getAllAudits(filters);

  const headers = [
    'id','candidateName','fileName','overall','keywords','skills','experience','education',
    'weights','verdict','decision','note','jdSnippet','role','anonymized','createdAt','updatedAt'
  ];

  const csvRows = [headers.join(',')];
  for (const row of rows) {
    const formatted = formatRow(row);
    csvRows.push([
      esc(formatted.id),
      esc(formatted.candidateName),
      esc(formatted.fileName),
      formatted.overall,
      formatted.scores?.keywords,
      formatted.scores?.skills,
      formatted.scores?.experience,
      formatted.scores?.education,
      esc(JSON.stringify(formatted.weights)),
      esc(formatted.verdict),
      esc(formatted.decision),
      esc(formatted.note),
      esc(formatted.jdSnippet),
      esc(formatted.role || ''),
      formatted.anonymized ? 1 : 0,
      esc(formatted.createdAt),
      esc(formatted.updatedAt || '')
    ].join(','));
  }

  return csvRows.join('\n');
}

function esc(v) {
  if (v == null) return '""';
  return '"' + String(v).replace(/"/g, '""') + '"';
}

function formatRow(row) {
  // Tolerant: accepts both DB rows and already-formatted records
  if (row && row.scores) return row;
  return {
    id: row.id,
    candidateName: row.candidate_name,
    fileName: row.file_name,
    overall: row.overall,
    scores: {
      keywords: row.keywords_score,
      skills: row.skills_score,
      experience: row.experience_score,
      education: row.education_score
    },
    weights: row.weights ? JSON.parse(row.weights) : null,
    verdict: row.verdict,
    decision: row.decision,
    note: row.note,
    jdSnippet: row.jd_snippet,
    role: row.role || '',
    anonymized: row.anonymized === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at
  };
}

module.exports = {
  insertAudit,
  getAllAudits,
  getAuditById,
  updateAudit,
  deleteAudit,
  getAuditChanges,
  exportCsv,
  getRoles,
  getRoleHistory
};
