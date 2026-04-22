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
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  // Add columns if upgrading from older schema
  try { getDb().exec("ALTER TABLE audit_log ADD COLUMN role TEXT DEFAULT ''"); } catch(_) {}
  try { getDb().exec("ALTER TABLE audit_log ADD COLUMN anonymized INTEGER DEFAULT 0"); } catch(_) {}
}

// Insert an audit record
function insertAudit(data) {
  const id = uuidv4();
  const stmt = getDb().prepare(`
    INSERT INTO audit_log
      (id, candidate_name, file_name, overall, keywords_score, skills_score,
       experience_score, education_score, weights, verdict, decision, note, jd_snippet, role, anonymized)
    VALUES
      (@id, @candidate_name, @file_name, @overall, @keywords_score, @skills_score,
       @experience_score, @education_score, @weights, @verdict, @decision, @note, @jd_snippet, @role, @anonymized)
  `);

  stmt.run({
    id,
    candidate_name: data.candidateName || 'Unknown',
    file_name: data.fileName || '',
    overall: data.overall || 0,
    keywords_score: data.scores?.keywords || 0,
    skills_score: data.scores?.skills || 0,
    experience_score: data.scores?.experience || 0,
    education_score: data.scores?.education || 0,
    weights: data.weights ? JSON.stringify(data.weights) : null,
    verdict: data.verdict || '',
    decision: data.decision || '',
    note: data.note || '',
    jd_snippet: data.jdSnippet || '',
    role: data.role || '',
    anonymized: data.anonymized ? 1 : 0
  });

  return getAuditById(id);
}

// Get all audit records
function getAllAudits({ decision, limit, role } = {}) {
  let sql = 'SELECT * FROM audit_log WHERE 1=1';
  const params = [];

  if (decision) {
    sql += ' AND decision = ?';
    params.push(decision);
  }

  if (role) {
    sql += ' AND role = ?';
    params.push(role);
  }

  sql += ' ORDER BY created_at DESC';

  if (limit) {
    sql += ' LIMIT ?';
    params.push(Number(limit));
  }

  const rows = getDb().prepare(sql).all(...params);
  return rows.map(formatRow);
}

// Get single audit by ID
function getAuditById(id) {
  const row = getDb().prepare('SELECT * FROM audit_log WHERE id = ?').get(id);
  return row ? formatRow(row) : null;
}

// Delete an audit record
function deleteAudit(id) {
  const result = getDb().prepare('DELETE FROM audit_log WHERE id = ?').run(id);
  return result.changes > 0;
}

// Get list of distinct roles
function getRoles() {
  const rows = getDb().prepare("SELECT DISTINCT role, COUNT(*) as count FROM audit_log WHERE role != '' GROUP BY role ORDER BY role").all();
  return rows;
}

// Get score history for a role
function getRoleHistory(role) {
  const rows = getDb().prepare(
    "SELECT candidate_name, overall, keywords_score, skills_score, experience_score, education_score, decision, created_at FROM audit_log WHERE role = ? ORDER BY overall DESC"
  ).all(role);
  return rows.map(r => ({
    candidateName: r.candidate_name,
    overall: r.overall,
    scores: { keywords: r.keywords_score, skills: r.skills_score, experience: r.experience_score, education: r.education_score },
    decision: r.decision,
    createdAt: r.created_at
  }));
}

// Export all as CSV
function exportCsv() {
  const rows = getDb().prepare('SELECT * FROM audit_log ORDER BY created_at DESC').all();
  const headers = [
    'id', 'candidateName', 'fileName', 'overall',
    'keywordsScore', 'skillsScore', 'experienceScore', 'educationScore',
    'weights', 'verdict', 'decision', 'note', 'jdSnippet', 'role', 'anonymized', 'createdAt'
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
      esc(formatted.createdAt)
    ].join(','));
  }

  return csvRows.join('\n');
}

function esc(v) {
  if (v == null) return '""';
  return '"' + String(v).replace(/"/g, '""') + '"';
}

function formatRow(row) {
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
    createdAt: row.created_at
  };
}

module.exports = { insertAudit, getAllAudits, getAuditById, deleteAudit, exportCsv, getRoles, getRoleHistory };
