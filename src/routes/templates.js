'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const Database = require('better-sqlite3');

const router = express.Router();

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', '..', 'data', 'audit.db');
let db;
function getDb() {
  if (!db) {
    const fs = require('fs');
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    initTemplatesSchema();
  }
  return db;
}

function initTemplatesSchema() {
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
  getDb().exec('CREATE INDEX IF NOT EXISTS idx_templates_owner ON templates(owner_id)');
  try { getDb().exec('ALTER TABLE templates ADD COLUMN org_id TEXT'); } catch (_) {}
  getDb().exec('CREATE INDEX IF NOT EXISTS idx_templates_org_id ON templates(org_id)');
}

function nowIso() { return new Date().toISOString(); }

function sendError(res, status, code, message, field) {
  const body = { error: message, code };
  if (field) body.field = field;
  return res.status(status).json(body);
}

function formatTemplate(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    role: row.role || '',
    jobDescription: row.job_description || '',
    weights: row.weights ? JSON.parse(row.weights) : null,
    ownerId: row.owner_id || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

router.get('/', (req, res) => {
  try {
    const rows = getDb().prepare('SELECT * FROM templates WHERE org_id = ? ORDER BY updated_at DESC').all(req.orgId);
    res.json(rows.map(formatTemplate));
  } catch (err) {
    sendError(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.get('/:id', (req, res) => {
  try {
    const row = getDb().prepare('SELECT * FROM templates WHERE id = ? AND org_id = ?').get(req.params.id, req.orgId);
    if (!row) return sendError(res, 404, 'NOT_FOUND', 'Template not found.', 'id');
    res.json(formatTemplate(row));
  } catch (err) {
    sendError(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.post('/', (req, res) => {
  try {
    const { name, role, jobDescription, weights } = req.body || {};
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'name is required.', 'name');
    }
    if (name.length > 200) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'name too long (max 200 chars).', 'name');
    }
    if (jobDescription && typeof jobDescription !== 'string') {
      return sendError(res, 400, 'VALIDATION_ERROR', 'jobDescription must be a string.', 'jobDescription');
    }
    if (jobDescription && jobDescription.length > 50000) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'jobDescription too long (max 50000 chars).', 'jobDescription');
    }

    const id = uuidv4();
    const now = nowIso();
    getDb().prepare(`
      INSERT INTO templates (id, name, role, job_description, weights, owner_id, org_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      name.trim(),
      (role || '').toString().slice(0, 200),
      jobDescription || '',
      weights ? JSON.stringify(weights) : null,
      req.userId || null,
      req.orgId,
      now,
      now
    );

    res.status(201).json(formatTemplate(getDb().prepare('SELECT * FROM templates WHERE id = ?').get(id)));
  } catch (err) {
    sendError(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.patch('/:id', (req, res) => {
  try {
    const existing = getDb().prepare('SELECT * FROM templates WHERE id = ? AND org_id = ?').get(req.params.id, req.orgId);
    if (!existing) return sendError(res, 404, 'NOT_FOUND', 'Template not found.', 'id');

    const allowed = ['name', 'role', 'jobDescription', 'weights'];
    const sets = [];
    const params = {};
    const body = req.body || {};

    for (const f of allowed) {
      if (!(f in body)) continue;
      if (f === 'name') {
        const v = (body.name || '').toString().trim();
        if (!v) return sendError(res, 400, 'VALIDATION_ERROR', 'name cannot be empty.', 'name');
        if (v.length > 200) return sendError(res, 400, 'VALIDATION_ERROR', 'name too long.', 'name');
        sets.push('name = @name'); params.name = v;
      } else if (f === 'role') {
        sets.push('role = @role'); params.role = (body.role || '').toString().slice(0, 200);
      } else if (f === 'jobDescription') {
        const v = (body.jobDescription || '').toString();
        if (v.length > 50000) return sendError(res, 400, 'VALIDATION_ERROR', 'jobDescription too long.', 'jobDescription');
        sets.push('job_description = @jobDescription'); params.jobDescription = v;
      } else if (f === 'weights') {
        sets.push('weights = @weights');
        params.weights = body.weights ? JSON.stringify(body.weights) : null;
      }
    }

    if (sets.length === 0) {
      return res.json(formatTemplate(existing));
    }

    sets.push('updated_at = @updatedAt');
    params.updatedAt = nowIso();
    params.id = req.params.id;
    getDb().prepare(`UPDATE templates SET ${sets.join(', ')} WHERE id = @id`).run(params);
    res.json(formatTemplate(getDb().prepare('SELECT * FROM templates WHERE id = ?').get(req.params.id)));
  } catch (err) {
    sendError(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

router.delete('/:id', (req, res) => {
  try {
    const result = getDb().prepare('DELETE FROM templates WHERE id = ? AND org_id = ?').run(req.params.id, req.orgId);
    if (result.changes === 0) return sendError(res, 404, 'NOT_FOUND', 'Template not found.', 'id');
    res.json({ success: true, id: req.params.id });
  } catch (err) {
    sendError(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

module.exports = router;
