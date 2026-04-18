'use strict';

const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', '..', 'audit.db');

let db;

function getDb() {
  if (!db) {
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
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
}

// Insert an audit record
function insertAudit(data) {
  const db = getDb();
  const id = uuidv4();
  const stmt = db.prepare(`
    INSERT INTO audit_log
      (id, candidate_name, file_name, overall, keywords_score, skills_score,
       experience_score, education_score, weights, verdict, decision, note, jd_snippet)
    VALUES
      (@id, @candidate_name, @file_name, @overall, @keywords_score, @skills_score,
       @experience_score, @education_score, @weights, @verdict, @decision, @note, @jd_snippet)
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
    jd_snippet: data.jdSnippet || ''
  });

  return getAuditById(id);
}

// Get all audit records
function getAllAudits({ decision, limit } = {}) {
  const db = getDb();
  let query = 'SELECT * FROM audit_log';
  const params = [];

  if (decision) {
    query += ' WHERE decision = ?';
    params.push(decision);
  }

  query += ' ORDER BY created_at DESC';

  if (limit) {
    query += ` LIMIT ?`;
    params.push(Number(limit));
  }

  const rows = db.prepare(query).all(...params);
  return rows.map(formatRow);
}

// Get single audit by ID
function getAuditById(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM audit_log WHERE id = ?').get(id);
  return row ? formatRow(row) : null;
}

// Delete an audit record
function deleteAudit(id) {
  const db = getDb();
  const result = db.prepare('DELETE FROM audit_log WHERE id = ?').run(id);
  return result.changes > 0;
}

// Export all as CSV
function exportCsv() {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM audit_log ORDER BY created_at DESC').all();

  const headers = [
    'id', 'candidateName', 'fileName', 'overall',
    'keywordsScore', 'skillsScore', 'experienceScore', 'educationScore',
    'weights', 'verdict', 'decision', 'note', 'jdSnippet', 'createdAt'
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
      esc(formatted.createdAt)
    ].join(','));
  }

  return csvRows.join('\n');
}

function esc(v) {
  if (v == null) return '';
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
    createdAt: row.created_at
  };
}

module.exports = { insertAudit, getAllAudits, getAuditById, deleteAudit, exportCsv };
