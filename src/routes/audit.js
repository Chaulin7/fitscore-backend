'use strict';

const express = require('express');
const {
  insertAudit,
  getAllAudits,
  deleteAudit,
  exportCsv,
  getRoles,
  getRoleHistory,
  getAuditById,
  updateAudit,
  getAuditChanges
} = require('../services/db');

const router = express.Router();

// Standardised error envelope { error, code, field }
function sendError(res, status, code, message, field) {
  const body = { error: message, code };
  if (field) body.field = field;
  return res.status(status).json(body);
}

// POST /api/audit — save an audit record
router.post('/', (req, res) => {
  try {
    const {
      candidateName, fileName, overall, scores, weights,
      verdict, decision, note, jdSnippet, role, anonymized
    } = req.body;

    if (!candidateName) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'candidateName is required.', 'candidateName');
    }

    const record = insertAudit({
      candidateName, fileName, overall, scores, weights,
      verdict, decision, note, jdSnippet, role, anonymized
    });

    res.status(201).json(record);
  } catch (err) {
    sendError(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// GET /api/audit — list audit records
// Backward-compatible:
//   - no query params      -> returns array of records (legacy)
//   - any of role,decision,search,from,to,limit,offset present -> returns { records, total, limit, offset }
router.get('/', (req, res) => {
  try {
    const { decision, role, search, from, to, limit, offset } = req.query;
    const usingFilters = (search != null) || (from != null) || (to != null) || (limit != null) || (offset != null);

    // Legacy path: no advanced filters
    if (!usingFilters) {
      const records = getAllAudits({ decision, limit: undefined, role });
      return res.json(records);
    }

    // Advanced path: in-memory filter on top of getAllAudits to stay backward-compatible with the db layer.
    let records = getAllAudits({ decision, role });
    if (search) {
      const q = String(search).toLowerCase();
      records = records.filter(r =>
        (r.candidateName || '').toLowerCase().includes(q) ||
        (r.fileName || '').toLowerCase().includes(q) ||
        (r.role || '').toLowerCase().includes(q) ||
        (r.note || '').toLowerCase().includes(q)
      );
    }
    if (from) {
      const fromTs = Date.parse(from);
      if (!Number.isNaN(fromTs)) records = records.filter(r => Date.parse(r.createdAt) >= fromTs);
    }
    if (to) {
      const toTs = Date.parse(to);
      if (!Number.isNaN(toTs)) records = records.filter(r => Date.parse(r.createdAt) <= toTs);
    }
    const total = records.length;
    const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
    const off = Math.max(parseInt(offset, 10) || 0, 0);
    const page = records.slice(off, off + lim);
    return res.json({ records: page, total, limit: lim, offset: off });
  } catch (err) {
    sendError(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// GET /api/audit/roles — list distinct roles with counts
router.get('/roles', (req, res) => {
  try {
    const roles = getRoles();
    res.json(roles);
  } catch (err) {
    sendError(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// GET /api/audit/roles/:role/history — score history for a role
router.get('/roles/:role/history', (req, res) => {
  try {
    const history = getRoleHistory(decodeURIComponent(req.params.role));
    res.json(history);
  } catch (err) {
    sendError(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// GET /api/audit/export/csv — download CSV
router.get('/export/csv', (req, res) => {
  try {
    const csv = exportCsv();
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="audit-log.csv"');
    res.send(csv);
  } catch (err) {
    sendError(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// GET /api/audit/:id/changes — append-only change history for a record (newest first)
router.get('/:id/changes', (req, res) => {
  try {
    const existing = getAuditById(req.params.id);
    if (!existing) {
      return sendError(res, 404, 'NOT_FOUND', 'Record not found.', 'id');
    }
    const changes = getAuditChanges(req.params.id);
    res.json(changes);
  } catch (err) {
    sendError(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// PATCH /api/audit/:id — partial update of an audit record
// Accepts a subset of { decision, note, role, candidateName }. id and createdAt are silently rejected.
// Returns 404 if missing. Writes one row per changed field to audit_changes (append-only).
router.patch('/:id', (req, res) => {
  try {
    const body = req.body || {};
    const allowed = ['decision', 'note', 'role', 'candidateName'];
    const patch = {};
    for (const f of allowed) {
      if (f in body) patch[f] = body[f];
    }

    // Light validation
    if ('decision' in patch) {
      const v = patch.decision == null ? '' : String(patch.decision);
      const validDecisions = ['', 'shortlist', 'hold', 'reject'];
      if (!validDecisions.includes(v)) {
        return sendError(res, 400, 'VALIDATION_ERROR',
          'decision must be one of: shortlist, hold, reject, or empty.', 'decision');
      }
    }
    if ('candidateName' in patch) {
      const v = patch.candidateName == null ? '' : String(patch.candidateName).trim();
      if (v.length === 0) {
        return sendError(res, 400, 'VALIDATION_ERROR',
          'candidateName cannot be empty.', 'candidateName');
      }
      if (v.length > 200) {
        return sendError(res, 400, 'VALIDATION_ERROR',
          'candidateName too long (max 200 chars).', 'candidateName');
      }
      patch.candidateName = v;
    }
    if ('role' in patch) {
      const v = patch.role == null ? '' : String(patch.role).trim();
      if (v.length > 200) {
        return sendError(res, 400, 'VALIDATION_ERROR',
          'role too long (max 200 chars).', 'role');
      }
      patch.role = v;
    }
    if ('note' in patch) {
      const v = patch.note == null ? '' : String(patch.note);
      if (v.length > 10000) {
        return sendError(res, 400, 'VALIDATION_ERROR',
          'note too long (max 10000 chars).', 'note');
      }
      patch.note = v;
    }

    const changedBy = (req.user && req.user.id) || null;
    const result = updateAudit(req.params.id, patch, changedBy);
    if (!result) {
      return sendError(res, 404, 'NOT_FOUND', 'Record not found.', 'id');
    }
    res.json(result.record);
  } catch (err) {
    sendError(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// GET /api/audit/report/:id — HTML candidate report
router.get('/report/:id', (req, res) => {
  try {
    const record = getAuditById(req.params.id);
    if (!record) {
      return sendError(res, 404, 'NOT_FOUND', 'Record not found.', 'id');
    }

    const scoreBar = (val, color) =>
      `<div style="background:#e5e7eb;border-radius:4px;height:8px;margin-top:4px">
        <div style="width:${val}%;background:${color};height:8px;border-radius:4px"></div>
      </div>`;

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Candidate Report - ${record.candidateName}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', Arial, sans-serif; background: #f0f2f5; color: #1a202c; }
  .page { max-width: 800px; margin: 32px auto; background: #fff; border-radius: 8px; border: 1px solid #d1d5db; overflow: hidden; }
  .header { background: #0f2847; color: #fff; padding: 28px 32px; }
  .header h1 { font-size: 22px; font-weight: 700; }
  .header .sub { font-size: 13px; opacity: 0.75; margin-top: 4px; }
  .badge { display: inline-block; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; margin-top: 10px; }
  .badge-green { background: #d1fae5; color: #065f46; }
  .badge-yellow { background: #fef3c7; color: #92400e; }
  .badge-red { background: #fee2e2; color: #991b1b; }
  .body { padding: 28px 32px; }
  .section { margin-bottom: 28px; }
  .section-title { font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: #6b7280; margin-bottom: 12px; }
  .score-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; }
  .score-card { border: 1px solid #e5e7eb; border-radius: 6px; padding: 14px 16px; }
  .score-label { font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: #6b7280; }
  .score-value { font-size: 28px; font-weight: 700; color: #0f2847; }
  .overall-card { background: #0f2847; color: #fff; border-radius: 6px; padding: 18px 20px; text-align: center; margin-bottom: 20px; }
  .overall-value { font-size: 52px; font-weight: 800; }
  .overall-label { font-size: 13px; opacity: 0.7; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: #6b7280; padding: 8px 12px; background: #f9fafb; border-bottom: 1px solid #e5e7eb; }
  td { padding: 9px 12px; border-bottom: 1px solid #f3f4f6; }
  tr:last-child td { border-bottom: none; }
  .verdict-box { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; padding: 14px 16px; font-size: 13px; line-height: 1.6; }
  .note-box { background: #fffbeb; border: 1px solid #fde68a; border-radius: 6px; padding: 14px 16px; font-size: 13px; }
  .meta { font-size: 12px; color: #9ca3af; margin-top: 6px; }
  .footer { padding: 16px 32px; border-top: 1px solid #e5e7eb; font-size: 11px; color: #9ca3af; display: flex; justify-content: space-between; }
  @media print { body { background: #fff; } .page { box-shadow: none; border: none; } }
</style>
</head>
<body>
<div class="page">
  <div class="header">
    <h1>${record.anonymized ? 'Anonymous Candidate' : record.candidateName}</h1>
    ${record.role ? `<div class="sub">Role: ${record.role}</div>` : ''}
    <div class="sub">Analyzed: ${new Date(record.createdAt).toLocaleDateString('en-GB', {day:'2-digit',month:'short',year:'numeric'})}</div>
    ${record.decision ? `<span class="badge ${record.decision === 'shortlist' ? 'badge-green' : record.decision === 'hold' ? 'badge-yellow' : 'badge-red'}">${record.decision.charAt(0).toUpperCase() + record.decision.slice(1)}</span>` : ''}
    ${record.anonymized ? '<span class="badge" style="background:rgba(255,255,255,0.15);color:#fff;margin-left:8px">Anonymized</span>' : ''}
  </div>

  <div class="body">
    <div class="section">
      <div class="overall-card">
        <div class="overall-value">${record.overall}</div>
        <div class="overall-label">Overall Fit Score / 100</div>
        ${scoreBar(record.overall, record.overall >= 70 ? '#10b981' : record.overall >= 50 ? '#f59e0b' : '#ef4444')}
      </div>

      <div class="section-title">Category Scores</div>
      <div class="score-grid">
        <div class="score-card">
          <div class="score-label">Keywords</div>
          <div class="score-value">${record.scores?.keywords ?? '—'}</div>
          ${scoreBar(record.scores?.keywords || 0, '#3b82f6')}
        </div>
        <div class="score-card">
          <div class="score-label">Skills</div>
          <div class="score-value">${record.scores?.skills ?? '—'}</div>
          ${scoreBar(record.scores?.skills || 0, '#8b5cf6')}
        </div>
        <div class="score-card">
          <div class="score-label">Experience</div>
          <div class="score-value">${record.scores?.experience ?? '—'}</div>
          ${scoreBar(record.scores?.experience || 0, '#f59e0b')}
        </div>
        <div class="score-card">
          <div class="score-label">Education</div>
          <div class="score-value">${record.scores?.education ?? '—'}</div>
          ${scoreBar(record.scores?.education || 0, '#10b981')}
        </div>
      </div>
    </div>

    ${record.verdict ? `
    <div class="section">
      <div class="section-title">Assessment</div>
      <div class="verdict-box">${record.verdict}</div>
    </div>` : ''}

    ${record.note ? `
    <div class="section">
      <div class="section-title">Recruiter Notes</div>
      <div class="note-box">${record.note}</div>
    </div>` : ''}

    ${record.weights ? `
    <div class="section">
      <div class="section-title">Scoring Weights Used</div>
      <table>
        <tr><th>Category</th><th>Weight</th></tr>
        <tr><td>Keywords</td><td>${record.weights.kw}%</td></tr>
        <tr><td>Skills</td><td>${record.weights.sk}%</td></tr>
        <tr><td>Experience</td><td>${record.weights.ex}%</td></tr>
        <tr><td>Education</td><td>${record.weights.ed}%</td></tr>
      </table>
    </div>` : ''}
  </div>

  <div class="footer">
    <span>CVsprings · Candidate Fit Analyzer</span>
    <span>Report ID: ${record.id}</span>
  </div>
</div>
<script>window.onload=()=>{if(window.location.search.includes('print=1')){window.print();}}</script>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (err) {
    sendError(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// DELETE /api/audit/:id — remove a record (writes deletion log to audit_changes)
router.delete('/:id', (req, res) => {
  try {
    const changedBy = (req.user && req.user.id) || null;
    const deleted = deleteAudit(req.params.id, changedBy);
    if (!deleted) {
      return sendError(res, 404, 'NOT_FOUND', 'Record not found.', 'id');
    }
    res.json({ success: true, id: req.params.id });
  } catch (err) {
    sendError(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

module.exports = router;
