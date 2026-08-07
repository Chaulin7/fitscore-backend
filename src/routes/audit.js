'use strict';

const express = require('express');
const { insertAudit, deleteAudit, getRoles, getRoleHistory, getAuditById, updateAudit, getAuditChanges, getAuditsByTenant, queryAuditLog, getFilteredAuditRows, getAuditFilterValues, isLegacyCandidateFilter, getOrgTimezone, getOrgBilling } = require('../services/db');
const { startOfZonedDayUtc, endOfZonedDayUtc, formatInTimeZone } = require('../services/timezone');
const { analyzeBias } = require('../services/biasAudit');
const { getOrganizationBranding } = require('../services/authService');
const { resolveBranding } = require('../services/branding');
const { buildProvenance } = require('../services/provenance');
const { streamReport } = require('./reportRenderer');

const router = express.Router();

// Standardised error envelope { error, code, field }
function sendError(res, status, code, message, field) {
  const body = { error: message };
  if (code) body.code = code;
  if (field) body.field = field;
  return res.status(status).json(body);
}

// The audit log stays chronological: the only sort control is direction. This
// two-value whitelist is the sole thing the caller can influence about ORDER BY.
const ORDER_VALUES = new Set(['asc', 'desc']);

// Strict YYYY-MM-DD validator. Rejects both non-matching shapes and calendar-
// impossible dates (e.g. 2026-02-31, which Date would silently roll into March).
function isValidIsoDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00.000Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function strOrUndef(v) {
  return (v == null || v === '') ? undefined : String(v);
}

// Parse + validate the shared audit filter query params (used by both the JSON
// list endpoint and the CSV export so their filtering is byte-for-byte
// identical). Returns { filters, order, raw, timezone } or { error }. from/to
// are inclusive calendar days IN THE ORG TIMEZONE, converted to UTC instants
// (DST-correct per date) for the query; created_at stays stored as UTC ISO. A
// malformed date is a hard 400 — never a silently-dropped filter.
function parseAuditFilters(q, timeZone) {
  const raw = {
    from: strOrUndef(q.from), to: strOrUndef(q.to),
    candidateId: strOrUndef(q.candidateId), runId: strOrUndef(q.runId),
    actor: strOrUndef(q.actor), action: strOrUndef(q.action),
    order: strOrUndef(q.order),
  };
  const filters = {};

  if (raw.from != null) {
    if (!isValidIsoDate(raw.from)) return { error: { status: 400, field: 'from', message: 'from must be a valid date (YYYY-MM-DD).' } };
    filters.from = startOfZonedDayUtc(raw.from, timeZone).toISOString();
  }
  if (raw.to != null) {
    if (!isValidIsoDate(raw.to)) return { error: { status: 400, field: 'to', message: 'to must be a valid date (YYYY-MM-DD).' } };
    filters.to = endOfZonedDayUtc(raw.to, timeZone).toISOString();
  }

  let order = 'desc';
  if (raw.order != null) {
    order = raw.order.toLowerCase();
    if (!ORDER_VALUES.has(order)) return { error: { status: 400, field: 'order', message: "order must be 'asc' or 'desc'." } };
  }

  filters.candidateId = raw.candidateId;
  filters.runId = raw.runId;
  filters.actor = raw.actor;
  filters.action = raw.action; // maps to the record's decision (shortlist/hold/reject)

  return { filters, order, raw, timezone: timeZone };
}

// Provenance is SERVER-BOUND, never trusted from the client. The save echoes an
// analysisId (the lookup key) + the extraction object; the stored value is the
// server-held record /api/analyze issued for this org (see provenanceCache.js).
// Keyed by analysisId so two analyses of the same CV under different weights
// never collide. Defense: the bound record's textSha256 must match the echoed
// one — a mismatch means the binding is wrong about which analysis this is, so
// its weights can't be trusted; treat it as a miss (null), never falling back
// to client weights. Missing/expired ids are misses too. A miss stores null
// provenance rather than a client-controlled echo.
const provenance = require('../services/provenanceCache');
/**
 * Resolve an echoed analysisId to the server-held record for this org.
 *
 * Returns { bound, state }:
 *   bound — the server's record, or null when it cannot be vouched for
 *   state — why, so the caller can log it and tell the client
 *
 * Every failure path used to return a bare null and only the mismatch logged,
 * which meant the COMMON failure — a save after the in-memory cache was lost to
 * a restart — was completely invisible in production and indistinguishable, to
 * the client, from a fully vouched save.
 */
const BIND_STATE = Object.freeze({
  VOUCHED: 'vouched',
  NO_ANALYSIS_ID: 'no_analysis_id',
  UNBOUND: 'unbound',       // never issued, or issued and since lost/expired
  SHA_MISMATCH: 'sha_mismatch',
});

function bindAnalysis(orgId, analysisId, echoedExtraction) {
  if (!analysisId) {
    // Pre-provenance clients, and any save that never went through /api/analyze.
    console.info('[provenance] save carried no analysisId — storing client-asserted', { orgId });
    return { bound: null, state: BIND_STATE.NO_ANALYSIS_ID };
  }
  const rec = provenance.lookup(orgId, String(analysisId));
  if (!rec) {
    // Expected after a restart while the cache is in-memory; should become rare
    // once it is persisted. Logged at info because today it is normal, not a
    // fault — but it must be countable, which it previously was not.
    console.info('[provenance] analysisId not held (unissued, expired, or lost to a restart)'
      + ' — storing client-asserted', { orgId, analysisId });
    return { bound: null, state: BIND_STATE.UNBOUND };
  }
  const echoedSha = echoedExtraction && typeof echoedExtraction === 'object' ? echoedExtraction.textSha256 : undefined;
  if (rec.textSha256 !== echoedSha) {
    // Distinct from the above on purpose: the server DID issue this id, and the
    // text it was issued for is not the text being saved against it. That is a
    // different kind of event and warrants a louder level.
    console.warn('[provenance] analysisId/textSha256 mismatch — not binding weights', { orgId, analysisId });
    return { bound: null, state: BIND_STATE.SHA_MISMATCH };
  }
  return { bound: rec, state: BIND_STATE.VOUCHED };
}

// POST /api/audit - save an audit record
router.post('/', async (req, res) => {
  try {
    const { candidateName, fileName, overall, scores, weights, verdict, decision, note, jdSnippet, role, anonymized, appVersion, modelId, analysisTimestamp, analysisDetail, analysisId, runNonce } = req.body;
    if (!candidateName) return sendError(res, 400, 'VALIDATION_ERROR', 'candidateName is required.', 'candidateName');
    // Provenance (Art. 12): reviewedBy comes from the authenticated session,
    // never from the client payload.
    const reviewedBy = (req.user && req.user.email) || null;
    // Structured detail (keywords/skills/recommendations) for the branded report.
    // Keep only the expected shape; cap sizes so a payload can't bloat the row.
    // Server-held provenance for THIS analysis, bound by (orgId, analysisId)
    // with a textSha256 defense check. The client echo is only a lookup key.
    const { bound, state: provenanceState } = bindAnalysis(req.orgId, analysisId, analysisDetail && analysisDetail.extraction);
    let detail = null;
    if (analysisDetail && typeof analysisDetail === 'object') {
      const arr = (v) => Array.isArray(v) ? v.slice(0, 200) : [];
      detail = {
        found: arr(analysisDetail.found).map((k) => String(k).slice(0, 80)),
        missing: arr(analysisDetail.missing).map((k) => String(k).slice(0, 80)),
        skills: arr(analysisDetail.skills).map((s) => ({ name: String((s && s.name) || '').slice(0, 80), found: !!(s && s.found) })),
        recommendations: arr(analysisDetail.recommendations).map((r) => ({ icon: String((r && r.icon) || '').slice(0, 12), text: String((r && r.text) || '').slice(0, 500) })),
        matches: arr(analysisDetail.matches).slice(0, 60).map((m) => ({
          requirement: String((m && m.requirement) || '').slice(0, 80),
          matched: !!(m && m.matched),
          evidence: m && m.evidence != null ? String(m.evidence).slice(0, 300) : null,
          cvLineRef: null,
          weight: null,
        })),
        extraction: bound,
      };
    }
    const record = insertAudit({
      candidateName, fileName, overall, scores, weights, verdict, decision, note, jdSnippet, role, anonymized,
      appVersion: appVersion ? String(appVersion).slice(0, 50) : null,
      modelId: modelId ? String(modelId).slice(0, 100) : null,
      analysisTimestamp: analysisTimestamp ? String(analysisTimestamp).slice(0, 40) : null,
      reviewedBy,
      analysisDetail: detail,
      // Scoring inputs captured SERVER-SIDE from the bound record — never the
      // client-supplied `weights` (which could differ from what was scored).
      // NULL when the server can't vouch for them (unknown/expired sha).
      weightsJson: bound && bound.scoringWeights ? bound.scoringWeights : null,
      engineVersion: bound && bound.engineVersion ? bound.engineVersion : null,
      // Opaque per-screening-pass grouping hint; the run id is server-minted.
      runNonce: runNonce ? String(runNonce).slice(0, 100) : null,
    }, req.orgId, req.userId || null);
    // Tell the client whether this save was vouched. Additive: the record is
    // returned exactly as before, with provenance alongside it. Without this a
    // recruiter had no way to know a save stored their own numbers back at them
    // rather than the server's.
    res.status(201).json({
      ...record,
      provenance: { vouched: provenanceState === BIND_STATE.VOUCHED, state: provenanceState },
    });
  } catch (err) {
    sendError(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// GET /api/audit - filtered, paginated, org-scoped audit log.
// Query params: from, to (inclusive YYYY-MM-DD day bounds), candidateId, runId,
// actor (user id), action (-> decision), order (asc|desc on time, default desc),
// limit (default 50, max 200), offset (default 0).
// Returns { rows, total, limit, offset }. total ignores limit/offset. Org scope
// is server-derived (req.orgId) and can never be supplied by the caller.
router.get('/', async (req, res) => {
  try {
    const timeZone = getOrgTimezone(req.orgId);
    const parsed = parseAuditFilters(req.query, timeZone);
    if (parsed.error) return sendError(res, parsed.error.status, 'VALIDATION_ERROR', parsed.error.message, parsed.error.field);

    const result = queryAuditLog({
      ...parsed.filters,
      orgId: req.orgId, // server-derived scope — overrides anything in the query
      order: parsed.order,
      limit: req.query.limit,
      offset: req.query.offset,
    });
    result.timezone = timeZone; // so the client can label + display in org tz
    return res.json(result);
  } catch (err) {
    sendError(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// GET /api/audit/filters - distinct actor/action values for the filter
// dropdowns, org-scoped.
router.get('/filters', async (req, res) => {
  try {
    res.json(getAuditFilterValues(req.orgId));
  } catch (err) {
    sendError(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// GET /api/audit/roles - list distinct roles with counts
router.get('/roles', async (req, res) => {
  try {
    const roles = getRoles(req.orgId);
    res.json(roles);
  } catch (err) {
    sendError(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// GET /api/audit/roles/:role/history - score history for a role
router.get('/roles/:role/history', async (req, res) => {
  try {
    const history = getRoleHistory(decodeURIComponent(req.params.role), req.orgId);
    res.json(history);
  } catch (err) {
    sendError(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// GET /api/audit/export/csv - download CSV of the audit log.
// Respects the SAME filter + order params as GET /api/audit (all rows, no
// pagination). Prepends a self-describing metadata block recording the exact
// filter parameters and export timestamp, so the file stands on its own when it
// turns up in an evidence folder.
function csvCell(v) {
  if (v == null) return '""';
  return '"' + String(v).replace(/"/g, '""') + '"';
}
function csvRow(cells) {
  return cells.map(csvCell).join(',');
}

// Weights as a compact, unambiguous cell — or the literal "not recorded" so a
// NULL is never mistaken for a default or empty weight set.
function weightsCell(w) {
  if (!w || typeof w !== 'object') return 'not recorded';
  const keys = ['kw', 'sk', 'ex', 'ed'];
  const parts = keys.filter((k) => w[k] != null).map((k) => `${k}=${w[k]}`);
  return parts.length ? parts.join(';') : 'not recorded';
}

router.get('/export/csv', async (req, res) => {
  try {
    const timeZone = getOrgTimezone(req.orgId);
    const parsed = parseAuditFilters(req.query, timeZone);
    if (parsed.error) return sendError(res, parsed.error.status, 'VALIDATION_ERROR', parsed.error.message, parsed.error.field);

    const rows = getFilteredAuditRows({ ...parsed.filters, orgId: req.orgId, order: parsed.order });
    const exportedAt = new Date().toISOString();
    const r = parsed.raw;
    // Record which candidate id was filtered on and whether it is legacy (a
    // pre-migration hash identity that may merge same-named applicants).
    const candidateIsLegacy = r.candidateId ? isLegacyCandidateFilter(req.orgId, r.candidateId) : false;

    const meta = [
      csvRow(['CVsprings Audit Log Export']),
      csvRow(['Exported at (UTC)', exportedAt]),
      // Timezone + resolved UTC window make the covered range unambiguous.
      csvRow(['Timezone', timeZone]),
      csvRow(['Resolved window (UTC) from', parsed.filters.from || '(open)']),
      csvRow(['Resolved window (UTC) to', parsed.filters.to || '(open)']),
      csvRow(['Order', parsed.order]),
      csvRow(['Filter: from (local day)', r.from || '(none)']),
      csvRow(['Filter: to (local day)', r.to || '(none)']),
      csvRow(['Filter: candidateId', r.candidateId || '(none)']),
      csvRow(['Filter: candidateIsLegacy', r.candidateId ? (candidateIsLegacy ? 'yes' : 'no') : '(n/a)']),
      csvRow(['Filter: runId', r.runId || '(none)']),
      csvRow(['Filter: actor', r.actor || '(none)']),
      csvRow(['Filter: action', r.action || '(none)']),
      csvRow(['Rows in this export', String(rows.length)]),
      '', // blank separator line before the tabular data
    ];

    const header = ['runId', 'candidateId', 'candidateLegacy', 'candidateName', 'fileName', 'overall', 'keywords', 'skills', 'experience', 'education', 'weightsApplied', 'engineVersion', 'verdict', 'decision', 'note', 'role', 'anonymized', 'actorUserId', 'reviewedBy', `createdAt (${timeZone})`];
    const dataRows = rows.map((rec) => csvRow([
      rec.id, rec.candidateId, rec.candidateLegacy ? 'yes' : 'no', rec.candidateName, rec.fileName,
      rec.overall, rec.scores && rec.scores.keywords, rec.scores && rec.scores.skills,
      rec.scores && rec.scores.experience, rec.scores && rec.scores.education,
      weightsCell(rec.weightsJson), rec.engineVersion || 'not recorded',
      rec.verdict, rec.decision, rec.note, rec.role, rec.anonymized ? 1 : 0,
      rec.userId, rec.reviewedBy, formatInTimeZone(rec.createdAt, timeZone),
    ]));

    const csv = meta.concat([csvRow(header)], dataRows).join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="audit-log.csv"');
    res.send(csv);
  } catch (err) {
    sendError(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// ---------------------------------------------------------------------------
// GET /api/audit/bias-report
// Query params: role (optional), from, to (optional ISO dates)
// Returns the structured bias analysis JSON.
// ---------------------------------------------------------------------------
router.get('/bias-report', async (req, res) => {
  try {
    if (!req.orgId) return sendError(res, 401, 'AUTH_REQUIRED', 'Unauthorized');

    const { role, from, to } = req.query;

    // Fetch org-scoped records with optional filters
    const records = getAuditsByTenant(req.orgId, {
      role: role || undefined,
      from: from || undefined,
      to: to || undefined,
    });

    const report = analyzeBias(records, { role: role || null, from: from || null, to: to || null });
    res.json(report);
  } catch (err) {
    sendError(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// ---------------------------------------------------------------------------
// GET /api/audit/bias-report/pdf
// Same params as /bias-report — returns print-optimised HTML.
// The recruiter prints this from their browser (Ctrl+P / Cmd+P) to produce
// a PDF they can hand to their DPO. No headless browser dependency.
// ---------------------------------------------------------------------------
router.get('/bias-report/pdf', async (req, res) => {
  try {
    if (!req.orgId) return sendError(res, 401, 'AUTH_REQUIRED', 'Unauthorized');

    const { role, from, to } = req.query;

    const records = getAuditsByTenant(req.orgId, {
      role: role || undefined,
      from: from || undefined,
      to: to || undefined,
    });

    const report = analyzeBias(records, {
      role: role || null, from: from || null, to: to || null,
      orgId: req.orgId, // scopes the report fingerprint; never rendered
    });
    // Same entitlement rule and the same resolver as the candidate PDF report:
    // an org that has white-labelled one document must not find the other still
    // wearing the CVsprings mark. `on: 'dark'` because this header band is navy.
    const branding = resolveBranding(
      getOrganizationBranding(req.orgId), getOrgBilling(req.orgId), { on: 'dark' },
    );
    const html = renderBiasReportHtml(report, branding);

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    sendError(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// ---------------------------------------------------------------------------
// HTML renderer for the DPO-facing bias report
// ---------------------------------------------------------------------------
function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function reliabilityBannerHtml(level) {
  const cfg = {
    high:         { bg: '#d1fae5', border: '#10b981', color: '#065f46', label: 'RELIABILITY: HIGH',         msg: 'This report is based on a sufficient number of records for the statistical analyses to be meaningful. Treat findings as indicative, not definitive.' },
    moderate:     { bg: '#fef3c7', border: '#f59e0b', color: '#92400e', label: 'RELIABILITY: MODERATE',     msg: 'This report covers a moderate number of records. Statistical conclusions should be treated with caution and confirmed with larger samples over time.' },
    low:          { bg: '#fee2e2', border: '#ef4444', color: '#991b1b', label: 'RELIABILITY: LOW',           msg: 'This report covers fewer than 50 records. Statistical conclusions at this sample size are unreliable. Use for orientation only and gather more data before drawing conclusions.' },
    insufficient: { bg: '#fee2e2', border: '#dc2626', color: '#7f1d1d', label: 'RELIABILITY: INSUFFICIENT', msg: 'Fewer than 20 records were found for the selected scope. No reliable statistical conclusions can be drawn. This report is provided so you can see that data collection has started; revisit when you have more records.' },
  };
  const c = cfg[level] || cfg.insufficient;
  return '<div style="border: 2px solid ' + c.border + '; background: ' + c.bg + '; color: ' + c.color + '; border-radius: 6px; padding: 14px 18px; margin-bottom: 24px;">' +
    '<div style="font-weight: 700; font-size: 13px; letter-spacing: .06em; margin-bottom: 4px;">' + c.label + '</div>' +
    '<div style="font-size: 13px;">' + c.msg + '</div></div>';
}

function sectionTitle(text) {
  return '<div style="font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: #6b7280; margin-bottom: 10px; border-bottom: 1px solid #e5e7eb; padding-bottom: 6px;">' + esc(text) + '</div>';
}

function tableRow(cells, header) {
  const tag = header ? 'th' : 'td';
  const style = header
    ? 'padding: 8px 12px; text-align: left; font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: #6b7280; border-bottom: 2px solid #e5e7eb;'
    : 'padding: 8px 12px; font-size: 13px; border-bottom: 1px solid #f3f4f6;';
  return '<tr>' + cells.map((c) => '<' + tag + ' style="' + style + '">' + esc(String(c == null ? '' : c)) + '</' + tag + '>').join('') + '</tr>';
}

/**
 * @param {object} report    analyzeBias() output
 * @param {object} [branding] resolveBranding(…, { on: 'dark' }) output. Optional
 *   so a direct call still renders: omitted, it falls back to platform branding
 *   on a dark surface rather than to no mark at all.
 */
function renderBiasReportHtml(report, branding) {
  const { scope, reliability, anonymisation, scoreDistribution, decisionConsistency, roleComparison, limitations, generatedAt, scoringEngines } = report;
  const brand = branding || resolveBranding(null, null, { on: 'dark' });

  // Provenance: same field set, same normalisation and same ISO 8601 UTC as the
  // candidate PDF report, via the shared builder. Built from the report object
  // and a hardcoded platform string — no org setting reaches any of it.
  const prov = buildProvenance({
    id: report.reportFingerprint,
    engine: report.engine,
    ruleset: report.ruleset,
    generated: generatedAt,
  });

  // The mark, in whichever form the resolver handed back. `needsPlate` is true
  // only for a raster logo on this dark band; nothing produces one yet, so the
  // plate itself is deliberately not built here (see services/branding).
  const markHtml = brand.headerLogoType === 'image'
    ? '<img class="mark" src="' + esc(brand.headerLogo) + '" alt="" width="26" height="26">'
    : '<span class="mark" aria-hidden="true">' + brand.headerLogo + '</span>';

  const scopeLabel = scope.role ? 'Role: ' + esc(scope.role) : 'All roles';
  const dateRange = (scope.from || scope.to)
    ? ((scope.from || 'start') + ' to ' + (scope.to || 'present'))
    : 'All dates';

  let html = '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">' +
    '<title>CVsprings Bias Monitoring Report</title>' +
    '<style>' +
    '* { box-sizing: border-box; margin: 0; padding: 0; }' +
    'body { font-family: "Segoe UI", Arial, sans-serif; background: #f0f2f5; color: #1a202c; font-size: 14px; }' +
    '.page { max-width: 860px; margin: 32px auto; background: #fff; border-radius: 8px; border: 1px solid #e5e7eb; box-shadow: 0 2px 8px rgba(0,0,0,.08); }' +
    '.header { background: #0f2847; color: #fff; padding: 28px 36px; border-radius: 8px 8px 0 0; }' +
    '.header h1 { font-size: 22px; font-weight: 700; margin-bottom: 8px; }' +
    '.header .meta { font-size: 12px; opacity: 0.75; }' +
    // CVsprings vendor mark. A plain <img>, deliberately not the CSS-mask
    // technique the static pages use: background-color + mask is dropped by
    // browsers when "Background graphics" is off, which is the default in the
    // print dialog — and this document exists to be printed as the compliance
    // record. An <img> survives that. Uses the white variant because the source
    // brandmark is #000 and this header is navy.
    '.brandrow { display: flex; align-items: center; gap: 9px; margin-bottom: 14px; }' +
    // The mark is inlined SVG now rather than <img src="/brandmark-white.svg">,
    // so it survives printing with "Background graphics" off (the print-dialog
    // default) AND carries whichever mark resolveBranding chose for this org.
    '.brandrow .mark, .brandrow .mark svg, .brandrow img.mark { width: 26px; height: 26px; display: block; }' +
    '.brandrow .wordmark { font-size: 13px; font-weight: 700; letter-spacing: -.2px; }' +
    '.disclaimer { background: #fffbeb; border: 2px solid #f59e0b; border-radius: 6px; padding: 16px 18px; margin-bottom: 24px; font-size: 13px; line-height: 1.5; color: #78350f; }' +
    '.disclaimer strong { display: block; margin-bottom: 6px; font-size: 12px; letter-spacing: .06em; text-transform: uppercase; }' +
    '.body { padding: 28px 36px; }' +
    '.section { margin-bottom: 32px; }' +
    'table { width: 100%; border-collapse: collapse; }' +
    '.footer { padding: 16px 36px; border-top: 1px solid #e5e7eb; font-size: 11px; color: #9ca3af; border-radius: 0 0 8px 8px; }' +
    // Provenance: quiet, monospaced for the fingerprint's sake, and wrapping
    // rather than overflowing on narrow paper. An audit artifact, not marketing.
    '.prov-line { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 9.5px; line-height: 1.6; color: #6b7280; word-break: break-word; }' +
    '.prov-note { font-size: 10px; line-height: 1.5; color: #9ca3af; margin-top: 6px; }' +
    '.caveat { background: #fff7ed; border: 2px solid #ea580c; border-radius: 6px; padding: 16px 18px; margin-bottom: 24px; font-size: 13px; line-height: 1.5; color: #7c2d12; }' +
    '.caveat strong { display: block; margin-bottom: 6px; font-size: 12px; letter-spacing: .06em; text-transform: uppercase; }' +
    '.lim-list { margin: 0; padding-left: 18px; }' +
    '.lim-list li { margin-bottom: 8px; font-size: 13px; line-height: 1.5; color: #374151; }' +
    '@media print { body { background: #fff; } .page { box-shadow: none; border: none; margin: 0; border-radius: 0; } .footer { position: fixed; bottom: 0; width: 100%; } }' +
    '</style></head><body><div class="page">' +

    // Header
    '<div class="header">' +
    '<div class="brandrow">' + markHtml +
    '<span class="wordmark">' + esc(brand.displayName) + '</span></div>' +
    '<h1>Bias Monitoring Report</h1>' +
    '<div class="meta">' + scopeLabel + ' &nbsp;|&nbsp; ' + dateRange + ' &nbsp;|&nbsp; ' + report.scope.totalRecords + ' records analysed &nbsp;|&nbsp; Generated ' + esc(prov.generated) + '</div></div>' +

    '<div class="body">' +

    // Disclaimer box (prominent, not buried)
    '<div class="disclaimer"><strong>Important — Please Read</strong>' +
    'This report is a monitoring aid to help recruiters review their use of AI-assisted screening. ' +
    'It does not certify legal compliance, does not detect all forms of bias, and cannot analyse characteristics not present in the data. ' +
    'CVsprings does not hold and cannot analyse protected characteristics (gender, ethnicity, age, disability status). ' +
    'All hiring decisions remain the responsibility of the human recruiter. ' +
    'This document should be read alongside professional legal and HR guidance.</div>' +

    // Mixed scoring-engine caveat. Sits ABOVE the statistics, at disclaimer
    // weight, because it governs whether the figures below mean what they
    // appear to mean — a reader who meets it after the charts has already
    // drawn conclusions from numbers that may not be comparable.
    ((scoringEngines && scoringEngines.mixed)
      ? '<div class="caveat"><strong>Before you read these figures</strong>'
        + esc(scoringEngines.caveat) + '</div>'
      : '') +

    // Reliability banner
    '<div class="section">' + sectionTitle('Data Reliability') + reliabilityBannerHtml(reliability) + '</div>';

  // Anonymisation comparison
  const anon = anonymisation.anonymised;
  const nonAnon = anonymisation.nonAnonymised;
  const comp = anonymisation.comparison;

  html += '<div class="section">' + sectionTitle('Anonymisation Analysis (Primary Grouping)') +
    '<p style="font-size: 13px; margin-bottom: 14px; color: #374151;">This is the only grouping dimension available because it is the only characteristic the system explicitly records. A difference in scores or shortlist rates between anonymised and non-anonymised CVs may indicate a calibration concern and warrants human review.</p>' +
    '<table style="margin-bottom: 14px;">' +
    tableRow(['Group', 'Count', 'Mean Score', 'Median Score', 'Shortlist Rate', 'Reject Rate'], true) +
    tableRow(['Anonymised', anon.count, anon.meanScore != null ? anon.meanScore + '/100' : 'n/a', anon.medianScore != null ? anon.medianScore + '/100' : 'n/a', anon.shortlistRate != null ? anon.shortlistRate + '%' : 'n/a', anon.rejectRate != null ? anon.rejectRate + '%' : 'n/a']) +
    tableRow(['Non-anonymised', nonAnon.count, nonAnon.meanScore != null ? nonAnon.meanScore + '/100' : 'n/a', nonAnon.medianScore != null ? nonAnon.medianScore + '/100' : 'n/a', nonAnon.shortlistRate != null ? nonAnon.shortlistRate + '%' : 'n/a', nonAnon.rejectRate != null ? nonAnon.rejectRate + '%' : 'n/a']) +
    '</table>';

  if (!comp.reliable) {
    html += '<div style="background: #f3f4f6; border-radius: 6px; padding: 12px 14px; font-size: 13px; color: #6b7280;">' + esc(comp.note) + '</div>';
  } else {
    html += '<div style="background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; padding: 14px 16px; font-size: 13px; line-height: 1.6;">' +
      '<strong>Interpretation: </strong>' + esc(comp.interpretation) +
      (comp.pValueShortlist != null ? '<br><span style="color: #6b7280; font-size: 12px;">Shortlist rate p-value: ' + comp.pValueShortlist + (comp.pValueScore != null ? ' &nbsp;|&nbsp; Mean score p-value: ' + comp.pValueScore : '') + '</span>' : '') +
      '</div>';
  }
  html += '</div>';

  // Score distribution
  html += '<div class="section">' + sectionTitle('Score Distribution') +
    '<p style="font-size: 13px; margin-bottom: 14px; color: #374151;">Across all ' + scoreDistribution.sampleSize + ' scored records — mean: ' + (scoreDistribution.mean != null ? scoreDistribution.mean : 'n/a') + ', median: ' + (scoreDistribution.median != null ? scoreDistribution.median : 'n/a') + ', std dev: ' + (scoreDistribution.stdDev != null ? scoreDistribution.stdDev : 'n/a') + '. Suspicious clustering or a bimodal pattern may indicate model calibration issues for this role.</p>' +
    '<table>' +
    tableRow(['Score Band', 'Count', 'Proportion'], true) +
    scoreDistribution.bands.map((b) => {
      const pct = scoreDistribution.sampleSize > 0 ? Math.round(b.count / scoreDistribution.sampleSize * 100) : 0;
      return tableRow([b.band, b.count, pct + '%']);
    }).join('') +
    '</table></div>';

  // Decision consistency
  html += '<div class="section">' + sectionTitle('Decision Consistency by Score Band') +
    '<p style="font-size: 13px; margin-bottom: 14px; color: #374151;">Candidates with similar scores should generally receive consistent decisions. High variance within a band warrants review — though legitimate factors may explain it.</p>' +
    '<table>' +
    tableRow(['Score Band', 'Total', 'Shortlisted', 'Hold', 'Rejected', 'Other/None'], true) +
    decisionConsistency.bands.map((b) => {
      const none = b.count - b.shortlist - b.hold - b.reject - b.other;
      return tableRow([b.band, b.count, b.shortlist, b.hold, b.reject, b.other + (none > 0 ? '+' + none + ' undecided' : '')]);
    }).join('') +
    '</table></div>';

  // Per-role comparison
  if (roleComparison && roleComparison.length > 1) {
    html += '<div class="section">' + sectionTitle('Per-Role Comparison') +
      '<p style="font-size: 13px; margin-bottom: 14px; color: #374151;">Mean scores or shortlist rates that are significantly higher or lower than other roles may warrant review of the scoring configuration for that role.</p>' +
      '<table>' +
      tableRow(['Role', 'Count', 'Mean Score', 'Shortlist Rate', 'Reject Rate'], true) +
      roleComparison.map((r) => tableRow([r.role, r.count, r.meanScore != null ? r.meanScore + '/100' : 'n/a', r.shortlistRate != null ? r.shortlistRate + '%' : 'n/a', r.rejectRate != null ? r.rejectRate + '%' : 'n/a'])).join('') +
      '</table></div>';
  }

  // Limitations
  html += '<div class="section">' + sectionTitle('Limitations and Important Caveats') +
    '<ul class="lim-list">' +
    limitations.map((l) => '<li>' + esc(l) + '</li>').join('') +
    '</ul></div>';

  html += '</div>'; // end body

  // Footer — provenance on every report at every tier, custom-branded or not.
  // Same fields, same order and same ISO 8601 UTC as the candidate PDF report.
  // "Fingerprint", not "Report ID": this document is generated on demand and
  // never stored, so the value identifies the inputs, not a row anyone can look
  // up. The note below says so, because an identifier that reads like a lookup
  // key but is not is worse than none at all.
  html += '<div class="footer">'
    + '<div class="prov-line">'
    + 'Report fingerprint ' + esc(prov.id)
    + ' &nbsp;·&nbsp; Engine ' + esc(prov.engine)
    + ' &nbsp;·&nbsp; Ruleset ' + esc(prov.ruleset)
    + ' &nbsp;·&nbsp; Generated ' + esc(prov.generated)
    + ' &nbsp;·&nbsp; ' + esc(prov.platform)
    + '</div>'
    + '<div class="prov-note">The fingerprint is derived from this report&rsquo;s inputs — the '
    + 'organisation, the role and date filters, and the exact set of records in scope. Running '
    + 'the same query again reproduces the same fingerprint; a different one means the '
    + 'underlying records have changed, including through retention deletion. It is not a '
    + 'stored reference and cannot be looked up.</div>'
    + '<div class="prov-note">This is a decision-support artifact, not a legal compliance '
    + 'certification.</div>'
    + '</div>';

  html += '</div></body>' +
    '<script>window.onload=function(){if(window.location.search.includes("print=1")){window.print();}}</script>' +
    '</html>';

  return html;
}

// GET /api/audit/:id/changes - append-only change history
router.get('/:id/changes', async (req, res) => {
  try {
    const existing = getAuditById(req.params.id, req.orgId);
    if (!existing) return sendError(res, 404, 'NOT_FOUND', 'Record not found.', 'id');
    const changes = getAuditChanges(req.params.id, req.orgId);
    res.json(changes);
  } catch (err) {
    sendError(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// PATCH /api/audit/:id - partial update
// Append-only rule (EU AI Act Art. 12): only the recruiter's decision and
// note are mutable. Scores, weights, candidate data, and provenance fields
// are immutable after creation — any other field in the body is ignored.
router.patch('/:id', async (req, res) => {
  try {
    const body = req.body;
    const allowed = ['decision', 'note'];
    const patch = {};
    for (const f of allowed) { if (f in body) patch[f] = body[f]; }

    if ('decision' in patch) {
      const d = patch.decision == null ? null : String(patch.decision);
      const validDecisions = ['shortlist', 'hold', 'reject'];
      if (d !== null && !validDecisions.includes(d)) return sendError(res, 400, 'VALIDATION_ERROR', 'decision must be one of: shortlist, hold, reject, or empty.', 'decision');
      patch.decision = d;
    }
    if ('note' in patch) {
      const no = patch.note == null ? null : String(patch.note);
      if (no && no.length > 10000) return sendError(res, 400, 'VALIDATION_ERROR', 'note too long (max 10000 chars).', 'note');
      patch.note = no;
    }

    // Attribution: snapshot the editor's email so the change log survives
    // the user later being removed.
    const changedBy = (req.user && req.user.email) || req.userId || null;
    const result = updateAudit({ id: req.params.id, ...patch }, changedBy, req.orgId);
    if (!result) return sendError(res, 404, 'NOT_FOUND', 'Record not found.', 'id');
    res.json(result);
  } catch (err) {
    sendError(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// GET /api/audit/report/:id - branded, print-optimised HTML candidate report
router.get('/report/:id', async (req, res) => {
  try {
    const record = getAuditById(req.params.id, req.orgId);
    if (!record) return sendError(res, 404, 'NOT_FOUND', 'Record not found.', 'id');
    // Branding entitlement is resolved here, at generation time, from the org's
    // current billing row — so a plan change (including a downgrade) applies to
    // the very next report with nothing to invalidate.
    const branding = resolveBranding(getOrganizationBranding(req.orgId), getOrgBilling(req.orgId));
    return streamReport(record, res, `cvsprings-report-${record.id}.pdf`, branding);
  } catch (err) {
    sendError(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// DELETE /api/audit/:id - remove a record
router.delete('/:id', async (req, res) => {
  try {
    // Attribution: email snapshot (durable), set server-side from the session.
    const changedBy = (req.user && req.user.email) || req.userId || null;
    const deleted = deleteAudit({ id: req.params.id }, changedBy, req.orgId);
    if (!deleted) return sendError(res, 404, 'NOT_FOUND', 'Record not found.', 'id');
    res.json({ success: true, id: req.params.id });
  } catch (err) {
    sendError(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

module.exports = router;
// The bias report's HTML is assembled here rather than in a template, so the
// only way to assert on what a reader actually sees — the resolved mark, the
// provenance footer, the mixed-engine caveat — is to render it. Exported for
// tests only; nothing in the app should reach for this.
module.exports.__test__ = { renderBiasReportHtml };
