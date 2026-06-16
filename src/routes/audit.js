'use strict';

const express = require('express');
const { insertAudit, getAllAudits, deleteAudit, exportCsv, getRoles, getRoleHistory, getAuditById, updateAudit, getAuditChanges, getAuditsByTenant } = require('../services/db');
const { analyzeBias } = require('../services/biasAudit');
const { getOrganizationBranding } = require('../services/authService');
const { resolveBranding } = require('../services/branding');

const router = express.Router();

// Standardised error envelope { error, code, field }
function sendError(res, status, code, message, field) {
  const body = { error: message };
  if (code) body.code = code;
  if (field) body.field = field;
  return res.status(status).json(body);
}

// POST /api/audit - save an audit record
router.post('/', async (req, res) => {
  try {
    const { candidateName, fileName, overall, scores, weights, verdict, decision, note, jdSnippet, role, anonymized, appVersion, modelId, analysisTimestamp, analysisDetail } = req.body;
    if (!candidateName) return sendError(res, 400, 'VALIDATION_ERROR', 'candidateName is required.', 'candidateName');
    // Provenance (Art. 12): reviewedBy comes from the authenticated session,
    // never from the client payload.
    const reviewedBy = (req.user && req.user.email) || null;
    // Structured detail (keywords/skills/recommendations) for the branded report.
    // Keep only the expected shape; cap sizes so a payload can't bloat the row.
    let detail = null;
    if (analysisDetail && typeof analysisDetail === 'object') {
      const arr = (v) => Array.isArray(v) ? v.slice(0, 200) : [];
      detail = {
        found: arr(analysisDetail.found).map((k) => String(k).slice(0, 80)),
        missing: arr(analysisDetail.missing).map((k) => String(k).slice(0, 80)),
        skills: arr(analysisDetail.skills).map((s) => ({ name: String((s && s.name) || '').slice(0, 80), found: !!(s && s.found) })),
        recommendations: arr(analysisDetail.recommendations).map((r) => ({ icon: String((r && r.icon) || '').slice(0, 12), text: String((r && r.text) || '').slice(0, 500) })),
      };
    }
    const record = insertAudit({
      candidateName, fileName, overall, scores, weights, verdict, decision, note, jdSnippet, role, anonymized,
      appVersion: appVersion ? String(appVersion).slice(0, 50) : null,
      modelId: modelId ? String(modelId).slice(0, 100) : null,
      analysisTimestamp: analysisTimestamp ? String(analysisTimestamp).slice(0, 40) : null,
      reviewedBy,
      analysisDetail: detail,
    }, req.orgId, req.userId || null);
    res.status(201).json(record);
  } catch (err) {
    sendError(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// GET /api/audit - list audit records
// Backward-compatible:
// - no query params -> returns array of records (legacy)
// - any of role,decision,search,from,to,limit,offset present -> returns { records, total, limit, offset }
router.get('/', async (req, res) => {
  try {
    const { decision, role, search, from, to, limit, offset } = req.query;
    const usingFilters = search != null || from != null || to != null || limit != null || offset != null;

    // Legacy path: no advanced filters
    if (!usingFilters && !decision && !role) {
      const records = getAllAudits({ limit: undefined, orgId: req.orgId });
      return res.json(records);
    }

    // Advanced path: in-memory filter on top of getAllAudits
    let records = getAllAudits({ decision, role, orgId: req.orgId });

    if (search) {
      const s = String(search).toLowerCase();
      records = records.filter((r) =>
        (r.candidateName || '').toLowerCase().includes(s) ||
        (r.fileName || '').toLowerCase().includes(s) ||
        (r.role || '').toLowerCase().includes(s) ||
        (r.note || '').toLowerCase().includes(s)
      );
    }
    if (from) {
      const fromTs = Date.parse(from);
      if (!Number.isNaN(fromTs)) records = records.filter((r) => Date.parse(r.createdAt) >= fromTs);
    }
    if (to) {
      const toTs = Date.parse(to);
      if (!Number.isNaN(toTs)) records = records.filter((r) => Date.parse(r.createdAt) <= toTs);
    }

    const total = records.length;
    const lim = Math.min(Math.max(parseInt(limit) || 50, 1), 500);
    const off = Math.max(parseInt(offset) || 0, 0);
    const page = records.slice(off, off + lim);
    return res.json({ records: page, total, limit: lim, offset: off });
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

// GET /api/audit/export/csv - download CSV
router.get('/export/csv', async (req, res) => {
  try {
    const csv = exportCsv({ orgId: req.orgId });
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

    const report = analyzeBias(records, { role: role || null, from: from || null, to: to || null });
    const html = renderBiasReportHtml(report);

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

function renderBiasReportHtml(report) {
  const { scope, reliability, anonymisation, scoreDistribution, decisionConsistency, roleComparison, limitations, generatedAt } = report;

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
    '.disclaimer { background: #fffbeb; border: 2px solid #f59e0b; border-radius: 6px; padding: 16px 18px; margin-bottom: 24px; font-size: 13px; line-height: 1.5; color: #78350f; }' +
    '.disclaimer strong { display: block; margin-bottom: 6px; font-size: 12px; letter-spacing: .06em; text-transform: uppercase; }' +
    '.body { padding: 28px 36px; }' +
    '.section { margin-bottom: 32px; }' +
    'table { width: 100%; border-collapse: collapse; }' +
    '.footer { padding: 16px 36px; border-top: 1px solid #e5e7eb; font-size: 11px; color: #9ca3af; display: flex; justify-content: space-between; border-radius: 0 0 8px 8px; }' +
    '.lim-list { margin: 0; padding-left: 18px; }' +
    '.lim-list li { margin-bottom: 8px; font-size: 13px; line-height: 1.5; color: #374151; }' +
    '@media print { body { background: #fff; } .page { box-shadow: none; border: none; margin: 0; border-radius: 0; } .footer { position: fixed; bottom: 0; width: 100%; } }' +
    '</style></head><body><div class="page">' +

    // Header
    '<div class="header"><h1>CVsprings Bias Monitoring Report</h1>' +
    '<div class="meta">' + scopeLabel + ' &nbsp;|&nbsp; ' + dateRange + ' &nbsp;|&nbsp; ' + report.scope.totalRecords + ' records analysed &nbsp;|&nbsp; Generated ' + new Date(generatedAt).toUTCString() + '</div></div>' +

    '<div class="body">' +

    // Disclaimer box (prominent, not buried)
    '<div class="disclaimer"><strong>Important — Please Read</strong>' +
    'This report is a monitoring aid to help recruiters review their use of AI-assisted screening. ' +
    'It does not certify legal compliance, does not detect all forms of bias, and cannot analyse characteristics not present in the data. ' +
    'CVsprings does not hold and cannot analyse protected characteristics (gender, ethnicity, age, disability status). ' +
    'All hiring decisions remain the responsibility of the human recruiter. ' +
    'This document should be read alongside professional legal and HR guidance.</div>' +

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

  // Footer
  html += '<div class="footer"><span>CVsprings Bias Monitoring Report</span><span>This is a decision-support artifact, not a legal compliance certification.</span></div>';

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

    const changedBy = req.userId || null;
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
    const branding = resolveBranding(getOrganizationBranding(req.orgId));
    const supportEmail = process.env.SUPPORT_EMAIL || null;
    const html = renderCandidateReport(record, branding, supportEmail);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    sendError(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// Score band colour — matches the app's default threshold (70) and pill logic:
// >=70 strong (green), 50-69 partial (amber), <50 weak (red).
function bandColor(v) {
  return v >= 70 ? '#059669' : v >= 50 ? '#d97706' : '#dc2626';
}

// Server-side equivalent of the app's buildWhyHTML(), from the stored scores
// + recommendations, so the report's reasoning matches the on-screen analysis.
function buildWhyReportHtml(record) {
  const scores = record.scores || {};
  const overall = record.overall || 0;
  let html = '<strong>Overall: ' + overall + '/100</strong><br>';
  if (scores.keywords != null) html += '<div style="margin-top:4px">&#128273; <strong>Keywords ' + scores.keywords + '</strong> &mdash; match between the job title, required terms and CV content.</div>';
  if (scores.skills != null) html += '<div style="margin-top:4px">&#9889; <strong>Skills ' + scores.skills + '</strong> &mdash; technical and soft skills alignment with the role requirements.</div>';
  if (scores.experience != null) html += '<div style="margin-top:4px">&#128197; <strong>Experience ' + scores.experience + '</strong> &mdash; years of relevant experience and seniority match.</div>';
  if (scores.education != null) html += '<div style="margin-top:4px">&#127891; <strong>Education ' + scores.education + '</strong> &mdash; academic qualifications and certifications match.</div>';
  const recs = (record.analysisDetail && record.analysisDetail.recommendations) || [];
  if (recs.length) {
    html += '<div style="margin-top:8px"><strong>Key notes:</strong> ' + esc(recs.map((r) => r.text || r).slice(0, 2).join(' ')) + '</div>';
  }
  return html;
}

function renderCandidateReport(record, branding, supportEmail) {
  const brand = esc(branding.name);
  const accent = branding.color; // validated hex by resolveBranding
  const detail = record.analysisDetail || null;

  // Respect the anonymized flag exactly as the app does — never reveal the name.
  const displayName = record.anonymized ? 'Anonymous Candidate' : esc(record.candidateName || 'Candidate');

  const logoHtml = branding.logoUrl
    ? '<img src="' + esc(branding.logoUrl) + '" alt="" style="height:38px;width:auto;border-radius:6px;background:#fff;padding:3px">'
    : '';

  const scoreBox = (label, val, color, big) => {
    const v = val != null ? val : '–';
    const pct = typeof val === 'number' ? val : 0;
    return '<div class="sbox' + (big ? ' sbox-overall' : '') + '">' +
      '<div class="sbox-label">' + label + '</div>' +
      '<div class="sbox-val" style="color:' + (big ? '#fff' : color) + '">' + v + (big ? '<span class="sbox-out">/100</span>' : '') + '</div>' +
      '<div class="bar"><div class="bar-fill" style="width:' + pct + '%;background:' + color + '"></div></div>' +
      '</div>';
  };

  const scores = record.scores || {};
  const overall = record.overall;

  // Decision badge (Shortlist / Hold / Reject), matching app colours.
  const decBadge = record.decision
    ? '<span class="dec-badge ' + (record.decision === 'shortlist' ? 'd-green' : record.decision === 'reject' ? 'd-red' : 'd-amber') + '">' + esc(record.decision.charAt(0).toUpperCase() + record.decision.slice(1)) + '</span>'
    : '<span style="color:#9ca3af;font-size:13px">No decision recorded</span>';

  // Keyword chips (only when detail was captured at save time).
  let keywordsSection = '';
  if (detail && (Array.isArray(detail.found) || Array.isArray(detail.missing))) {
    const found = detail.found || [], missing = detail.missing || [];
    keywordsSection = '<div class="section avoid-break"><div class="section-title">Keywords</div>' +
      '<div class="sub">Found</div><div class="chips">' +
      (found.length ? found.map((k) => '<span class="chip chip-found">' + esc(k) + '</span>').join('') : '<span class="muted">None found</span>') +
      '</div><div class="sub" style="margin-top:10px">Missing</div><div class="chips">' +
      (missing.length ? missing.map((k) => '<span class="chip chip-miss">' + esc(k) + '</span>').join('') : '<span class="muted" style="color:#059669">None missing</span>') +
      '</div></div>';
  }

  // Skills table (only when detail captured).
  let skillsSection = '';
  if (detail && Array.isArray(detail.skills) && detail.skills.length) {
    skillsSection = '<div class="section avoid-break"><div class="section-title">Skills</div><table class="tbl"><thead><tr><th>Skill</th><th>Status</th></tr></thead><tbody>' +
      detail.skills.map((s) => '<tr><td>' + esc(s.name) + '</td><td><span class="badge ' + (s.found ? 'badge-green' : 'badge-red') + '">' + (s.found ? '✓ Found' : '✗ Missing') + '</span></td></tr>').join('') +
      '</tbody></table></div>';
  }

  // Recommendations (structured if captured, else the stored verdict text).
  let recsSection = '';
  if (detail && Array.isArray(detail.recommendations) && detail.recommendations.length) {
    recsSection = '<div class="section avoid-break"><div class="section-title">Recommendations</div><table class="tbl"><tbody>' +
      detail.recommendations.map((r) => '<tr><td style="white-space:nowrap">' + esc(r.icon || '') + '</td><td>' + esc(r.text || '') + '</td></tr>').join('') +
      '</tbody></table></div>';
  } else if (record.verdict) {
    recsSection = '<div class="section avoid-break"><div class="section-title">Assessment</div><div class="box">' + esc(record.verdict) + '</div></div>';
  }

  const generated = new Date().toUTCString();
  const analyzed = record.createdAt ? new Date(record.createdAt).toUTCString() : '—';

  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Candidate Fit Report' + (record.anonymized ? '' : ' — ' + displayName) + '</title>' +
    '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">' +
    '<style>' +
    '*{box-sizing:border-box;margin:0;padding:0}' +
    'body{font-family:"Inter",Arial,sans-serif;background:#f0f2f5;color:#1a202c;font-size:14px}' +
    '.dl-btn{position:fixed;top:16px;right:16px;z-index:50;background:' + accent + ';color:#fff;border:none;border-radius:8px;padding:10px 16px;font:600 13px "Inter",sans-serif;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.2)}' +
    '.page{max-width:820px;margin:24px auto;background:#fff;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden}' +
    '.header{background:' + accent + ';color:#fff;padding:24px 32px;display:flex;align-items:center;gap:16px}' +
    '.header .brand{display:flex;align-items:center;gap:12px;flex:1}' +
    '.header .brand-name{font-size:16px;font-weight:800;letter-spacing:-.3px}' +
    '.header .rtitle{font-size:12px;text-transform:uppercase;letter-spacing:.1em;opacity:.8;text-align:right}' +
    '.header .rtitle b{display:block;font-size:15px;letter-spacing:0;text-transform:none;font-weight:700;margin-top:2px}' +
    '.body{padding:26px 32px}' +
    '.section{margin-bottom:24px}' +
    '.section-title{font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#6b7280;margin-bottom:10px;border-bottom:1px solid #eef0f4;padding-bottom:5px}' +
    '.cand-name{font-size:24px;font-weight:800;color:#0a1f3d}' +
    '.cand-meta{font-size:13px;color:#6b7280;margin-top:3px}' +
    '.jd{background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:10px 12px;font-size:12px;color:#4b5563;margin-top:10px;line-height:1.5}' +
    '.scores{display:grid;grid-template-columns:repeat(5,1fr);gap:10px}' +
    '.sbox{border:1px solid #e5e7eb;border-radius:8px;padding:12px;text-align:center}' +
    '.sbox-overall{background:' + accent + ';border-color:transparent;grid-column:span 1}' +
    '.sbox-label{font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#9ca3af;margin-bottom:6px}' +
    '.sbox-overall .sbox-label{color:rgba(255,255,255,.7)}' +
    '.sbox-val{font-size:26px;font-weight:800}.sbox-out{font-size:11px;font-weight:600;opacity:.7;margin-left:1px}' +
    '.bar{background:#eef0f4;border-radius:4px;height:6px;margin-top:8px;overflow:hidden}.sbox-overall .bar{background:rgba(255,255,255,.18)}' +
    '.bar-fill{height:6px;border-radius:4px}' +
    '.sub{font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#9ca3af;margin-bottom:6px}' +
    '.chips{display:flex;flex-wrap:wrap;gap:6px}.chip{padding:3px 10px;border-radius:14px;font-size:12px;font-weight:600}' +
    '.chip-found{background:#dcfce7;color:#166534;border:1px solid #bbf7d0}.chip-miss{background:#fee2e2;color:#991b1b;border:1px solid #fecaca}' +
    '.muted{color:#9ca3af;font-size:13px}' +
    '.tbl{width:100%;border-collapse:collapse;font-size:13px}.tbl th{text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:#9ca3af;padding:7px 10px;background:#f9fafb;border-bottom:1px solid #eef0f4}.tbl td{padding:8px 10px;border-bottom:1px solid #f3f4f6;color:#374151}.tbl tr:last-child td{border-bottom:none}' +
    '.badge{display:inline-flex;padding:2px 9px;border-radius:12px;font-size:11px;font-weight:600}.badge-green{background:#dcfce7;color:#15803d}.badge-red{background:#fee2e2;color:#b91c1c}' +
    '.dec-badge{display:inline-block;padding:5px 14px;border-radius:14px;font-size:13px;font-weight:700}.d-green{background:#dcfce7;color:#15803d}.d-amber{background:#fef9c3;color:#a16207}.d-red{background:#fee2e2;color:#b91c1c}' +
    '.box{background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:12px 14px;font-size:13px;line-height:1.6;color:#374151}' +
    '.note-box{background:#fffbeb;border:1px solid #fde68a;border-radius:6px;padding:12px 14px;font-size:13px;line-height:1.6;color:#78350f}' +
    '.disclaimer{background:#fffbeb;border:1px solid #fde68a;border-radius:6px;padding:12px 14px;font-size:12px;line-height:1.55;color:#78350f;margin-top:6px}' +
    '.prov{font-size:11px;color:#6b7280;line-height:1.7}.prov b{color:#374151}' +
    '.footer{padding:14px 32px;border-top:1px solid #e5e7eb;font-size:11px;color:#9ca3af;display:flex;justify-content:space-between;align-items:center}' +
    '.avoid-break{break-inside:avoid;page-break-inside:avoid}' +
    '@media print{body{background:#fff}.page{border:none;border-radius:0;margin:0;max-width:none}.dl-btn{display:none}@page{margin:14mm}}' +
    '</style></head><body>' +
    '<button class="dl-btn" onclick="window.print()">Download PDF</button>' +
    '<div class="page">' +
    // Header
    '<div class="header"><div class="brand">' + logoHtml + '<span class="brand-name">' + brand + '</span></div>' +
    '<div class="rtitle">Candidate Fit Report<b>' + generated + '</b></div></div>' +
    '<div class="body">' +
    // Candidate block
    '<div class="section avoid-break"><div class="cand-name">' + displayName + (record.anonymized ? ' <span class="badge" style="background:#e0e7ff;color:#3730a3;vertical-align:middle">Anonymised</span>' : '') + '</div>' +
    '<div class="cand-meta">' + (record.role ? 'Role: ' + esc(record.role) + ' &nbsp;·&nbsp; ' : '') + 'Analysed: ' + analyzed + '</div>' +
    (record.jdSnippet ? '<div class="jd"><strong>Job description (excerpt):</strong> ' + esc(record.jdSnippet) + '</div>' : '') +
    '</div>' +
    // Scores
    '<div class="section avoid-break"><div class="section-title">Fit Scores</div><div class="scores">' +
    scoreBox('Overall', overall, bandColor(overall || 0), true) +
    scoreBox('Keywords', scores.keywords, '#2563eb') +
    scoreBox('Skills', scores.skills, '#7c3aed') +
    scoreBox('Experience', scores.experience, '#d97706') +
    scoreBox('Education', scores.education, '#059669') +
    '</div></div>' +
    keywordsSection +
    skillsSection +
    // Why this score
    '<div class="section avoid-break"><div class="section-title">Why this score</div><div class="box">' + buildWhyReportHtml(record) + '</div></div>' +
    recsSection +
    // Recruiter decision (human)
    '<div class="section avoid-break"><div class="section-title">Recruiter Decision (made by a human)</div>' + decBadge +
    (record.note ? '<div class="note-box" style="margin-top:10px"><strong>Recruiter notes:</strong> ' + esc(record.note) + '</div>' : '') +
    '</div>' +
    // Provenance / compliance footer
    '<div class="section avoid-break"><div class="section-title">Provenance &amp; Compliance</div>' +
    '<div class="prov">' +
    '<b>Reviewed by:</b> ' + esc(record.reviewedBy || '—') + '<br>' +
    '<b>Model version:</b> ' + esc(record.modelId || '—') + '<br>' +
    '<b>App version:</b> ' + esc(record.appVersion || '—') + '<br>' +
    '<b>Analysis timestamp:</b> ' + esc(record.analysisTimestamp || record.createdAt || '—') +
    '</div>' +
    '<div class="disclaimer">This assessment is AI-generated and advisory only. Hiring decisions are made by the recruiter, not by CVsprings.</div>' +
    '</div>' +
    '</div>' + // end body
    // Confidentiality footer
    '<div class="footer"><span>Confidential &mdash; ' + brand + '</span><span>' + (supportEmail ? esc(supportEmail) + ' &nbsp;·&nbsp; ' : '') + 'Report ID: ' + esc(record.id) + '</span></div>' +
    '</div>' +
    '<script>window.onload=function(){if(window.location.search.includes("print=1")){window.print();}}</script>' +
    '</body></html>';
}

// DELETE /api/audit/:id - remove a record
router.delete('/:id', async (req, res) => {
  try {
    const changedBy = req.userId || null;
    const deleted = deleteAudit({ id: req.params.id }, changedBy, req.orgId);
    if (!deleted) return sendError(res, 404, 'NOT_FOUND', 'Record not found.', 'id');
    res.json({ success: true, id: req.params.id });
  } catch (err) {
    sendError(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

module.exports = router;
