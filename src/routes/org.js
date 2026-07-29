'use strict';

/**
 * src/routes/org.js — organization-level data controls (GDPR support).
 *
 * PATCH  /api/org             { retentionDays }  owner-only retention setting
 * GET    /api/org/export      full org data export (JSON download; Art. 20 /
 *                             offboarding). Accepts ?dt= download token so the
 *                             browser can download without an Authorization
 *                             header.
 * DELETE /api/org/audit-data  { confirm: "<org name>" }  owner-only org-wide
 *                             hard delete of audit records + change history.
 */

const express = require('express');
const { requireSession } = require('../middleware/auth');
const auth = require('../services/authService');
const branding = require('../services/branding');
const { getAllAudits, getAuditChanges, deleteAllOrgAuditData, getDb, validateRetentionDays, getRetentionStats, countPurgeableRows, listPurgeRuns } = require('../services/db');

const router = express.Router();

function sendError(res, status, code, message, field) {
  const body = { error: message, code };
  if (field) body.field = field;
  return res.status(status).json(body);
}

// GET /export may authenticate via single-use download token (browser link).
function sessionOrDownloadToken(req, res, next) {
  if (req.query && req.query.dt && req.method === 'GET') {
    const grant = auth.consumeDownloadToken(String(req.query.dt));
    if (!grant) return res.status(401).json({ error: 'Unauthorized', code: 'AUTH_REQUIRED' });
    req.userId = grant.userId;
    req.orgId = grant.orgId;
    return next();
  }
  return requireSession(req, res, next);
}

// Data controls are restricted to org owners.
function requireOwner(req, res, next) {
  const user = auth.findUserById(req.userId);
  if (!user || user.org_id !== req.orgId || user.role !== 'owner') {
    return sendError(res, 403, 'OWNER_REQUIRED', 'Only the organization owner can do this.');
  }
  return next();
}

// PATCH /api/org — update retention setting (server-side, org-wide). The floor
// is enforced here (validateRetentionDays) and re-checked inside the purge job.
router.patch('/', requireSession, requireOwner, (req, res) => {
  try {
    const check = validateRetentionDays((req.body || {}).retentionDays);
    if (!check.ok) return sendError(res, 400, check.code, check.message, 'retentionDays');
    auth.setOrganizationRetention(req.orgId, check.days);
    res.json({ retentionDays: check.days });
  } catch (err) {
    sendError(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// GET /api/org/retention — retention stats (row count, oldest event, cutoff,
// last run) + the last 10 purge runs as executional evidence. Owner only.
router.get('/retention', requireSession, requireOwner, (req, res) => {
  try {
    const stats = getRetentionStats(req.orgId);
    stats.purgeRuns = listPurgeRuns(req.orgId, 10);
    res.json(stats);
  } catch (err) {
    sendError(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// GET /api/org/retention/preview?days=NNN — exact number of rows a purge at
// `days` retention would delete right now. Drives the lowering-retention
// confirmation so the admin sees the precise, irreversible impact. Owner only.
router.get('/retention/preview', requireSession, requireOwner, (req, res) => {
  try {
    const check = validateRetentionDays(req.query.days);
    if (!check.ok) return sendError(res, 400, check.code, check.message, 'days');
    res.json(countPurgeableRows(req.orgId, check.days));
  } catch (err) {
    sendError(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// PATCH /api/org/branding — per-org report branding (owner only)
router.patch('/branding', requireSession, requireOwner, (req, res) => {
  try {
    const body = req.body || {};
    const name = body.brandDisplayName == null ? null : String(body.brandDisplayName).trim();
    const logo = body.brandLogoUrl == null ? null : String(body.brandLogoUrl).trim();
    const color = body.brandColor == null ? null : String(body.brandColor).trim();

    if (name && name.length > 80) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Display name too long (max 80 characters).', 'brandDisplayName');
    }
    if (logo && !branding.isSafeHttpUrl(logo)) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Logo URL must be an http(s) URL.', 'brandLogoUrl');
    }
    if (color && !branding.isValidColor(color)) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Colour must be a hex value like #0f2847.', 'brandColor');
    }
    auth.setOrganizationBranding(req.orgId, {
      brandDisplayName: name || null,
      brandLogoUrl: logo || null,
      brandColor: color || null,
    });
    res.json(auth.getOrganizationBranding(req.orgId));
  } catch (err) {
    sendError(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// GET /api/org/export — full JSON export of the org's audit data + templates
router.get('/export', sessionOrDownloadToken, requireOwner, (req, res) => {
  try {
    const org = auth.getOrganizationById(req.orgId);
    const records = getAllAudits({ orgId: req.orgId });
    const auditRecords = records.map((r) => ({ ...r, changeHistory: getAuditChanges(r.id, req.orgId) }));
    const templates = getDb().prepare('SELECT * FROM templates WHERE org_id = ? ORDER BY updated_at DESC').all(req.orgId)
      .map((t) => ({
        id: t.id, name: t.name, role: t.role || '', jobDescription: t.job_description || '',
        weights: t.weights ? JSON.parse(t.weights) : null, createdAt: t.created_at, updatedAt: t.updated_at,
      }));
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="cvsprings-org-export.json"');
    res.send(JSON.stringify({
      exportedAt: new Date().toISOString(),
      organization: { id: org.id, name: org.name, retentionDays: org.retentionDays, createdAt: org.createdAt },
      auditRecords,
      templates,
    }, null, 2));
  } catch (err) {
    sendError(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// DELETE /api/org/audit-data — org-wide hard delete, typed-name confirmation
router.delete('/audit-data', requireSession, requireOwner, (req, res) => {
  try {
    const org = auth.getOrganizationById(req.orgId);
    const confirm = String((req.body || {}).confirm || '');
    if (!org || confirm !== org.name) {
      return sendError(res, 400, 'CONFIRMATION_MISMATCH', 'Type your organization name exactly to confirm deletion.', 'confirm');
    }
    const { recordsDeleted, changesDeleted } = deleteAllOrgAuditData(req.orgId);
    res.json({ ok: true, recordsDeleted, changesDeleted });
  } catch (err) {
    sendError(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

module.exports = router;
