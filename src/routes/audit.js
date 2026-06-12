'use strict';

const express = require('express');
const { insertAudit, getAllAudits, deleteAudit, exportCsv, getRoles, getRoleHistory, getAuditById, updateAudit, getAuditChanges, getAuditsByTenant } = require('../services/db');
const { analyzeBias } = require('../services/biasAudit');

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
    const { candidateName, fileName, overall, scores, weights, verdict, decision, note, jdSnippet, role, anonymized, appVersion, modelId, analysisTimestamp } = req.body;
    if (!candidateName) return sendError(res, 400, 'VALIDATION_ERROR', 'candidateName is required.', 'candidateName');
    // Provenance (Art. 12): reviewedBy comes from the authenticated session,
    // never from the client payload.
    const reviewedBy = (req.user && req.user.email) || null;
    const record = insertAudit({
      candidateName, fileName, overall, scores, weights, verdict, decision, note, jdSnippet, role, anonymized,
      appVersion: appVersion ? String(appVersion).slice(0, 50) : null,
      modelId: modelId ? String(modelId).slice(0, 100) : null,
      analysisTimestamp: analysisTimestamp ? String(analysisTimestamp).slice(0, 40) : null,
      reviewedBy,
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

// GET /api/audit/report/:id - HTML candidate report
router.get('/report/:id', async (req, res) => {
  try {
    const record = getAuditById(req.params.id, req.orgId);
    if (!record) return sendError(res, 404, 'NOT_FOUND', 'Record not found.', 'id');
    const scoreBar = (val, color) => '<div style="background:#e5e7eb;border-radius:4px;height:8px;margin-top:4px"><div style="width:' + val + '%;background:' + color + ';height:8px;border-radius:4px"></div></div>';
    const badgeClass = record.decision === 'shortlist' ? 'badge-green' : record.decision === 'reject' ? 'badge-red' : 'badge-yellow';
    const html = '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Candidate Report - ' + esc(record.candidateName) + '</title><style>* { box-sizing: border-box; margin: 0; padding: 0; } body { font-family: "Segoe UI", Arial, sans-serif; background: #f0f2f5; color: #1a202c; } .page { max-width: 800px; margin: 32px auto; background: #fff; border-radius: 8px; border: 1px solid #e5e7eb; } .header { background: #0f2847; color: #fff; padding: 28px 32px; } .header h1 { font-size: 22px; font-weight: 700; } .badge { display: inline-block; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 700; } .badge-green { background: #d1fae5; color: #065f46; } .badge-yellow { background: #fef3c7; color: #92400e; } .badge-red { background: #fee2e2; color: #991b1b; } .body { padding: 28px 32px; } .section { margin-bottom: 28px; } .section-title { font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: #6b7280; margin-bottom: 12px; } .score-grid { display: grid; grid-template-columns: repeat(2,1fr); gap: 16px; } .score-card { border: 1px solid #e5e7eb; border-radius: 6px; padding: 14px 16px; } .score-label { font-size: 11px; font-weight: 600; color: #6b7280; } .score-value { font-size: 28px; font-weight: 700; color: #0f2847; } .overall-card { background: #0f2847; color: #fff; border-radius: 6px; padding: 18px 20px; text-align: center; } .overall-value { font-size: 52px; font-weight: 800; } .overall-label { font-size: 13px; opacity: 0.7; } .verdict-box { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; padding: 14px 16px; font-size: 13px; line-height: 1.6; } .footer { padding: 16px 32px; border-top: 1px solid #e5e7eb; font-size: 11px; color: #9ca3af; display: flex; justify-content: space-between; } @media print { body { background: #fff; } .page { box-shadow: none; border: none; } }</style></head><body><div class="page"><div class="header"><h1>' + esc(record.candidateName) + '</h1>' + (record.role ? '<div style="font-size:13px;opacity:.75;margin-top:4px">Role: ' + esc(record.role) + '</div>' : '') + '<div style="font-size:13px;opacity:.75;margin-top:4px">Analyzed: ' + new Date(record.createdAt).toUTCString() + '</div>' + (record.decision ? '<span class="badge ' + badgeClass + '" style="margin-top:8px;display:inline-block">' + esc(record.decision) + '</span>' : '') + (record.anonymized ? '<span class="badge" style="background:rgba(255,255,255,.15);color:#fff;margin-left:8px">Anonymized</span>' : '') + '</div><div class="body"><div class="section"><div class="overall-card"><div class="overall-value">' + (record.overall != null ? record.overall : '–') + '</div><div class="overall-label">Overall Fit Score / 100</div>' + (record.overall != null ? scoreBar(record.overall, record.overall >= 60 ? '#10b981' : record.overall >= 40 ? '#f59e0b' : '#ef4444') : '') + '</div></div>' + (record.scores ? '<div class="section"><div class="section-title">Category Scores</div><div class="score-grid"><div class="score-card"><div class="score-label">Keywords</div><div class="score-value">' + (record.scores.keywords != null ? record.scores.keywords : '–') + '</div>' + (record.scores.keywords != null ? scoreBar(record.scores.keywords, '#3b82f6') : '') + '</div><div class="score-card"><div class="score-label">Skills</div><div class="score-value">' + (record.scores.skills != null ? record.scores.skills : '–') + '</div>' + (record.scores.skills != null ? scoreBar(record.scores.skills, '#8b5cf6') : '') + '</div><div class="score-card"><div class="score-label">Experience</div><div class="score-value">' + (record.scores.experience != null ? record.scores.experience : '–') + '</div>' + (record.scores.experience != null ? scoreBar(record.scores.experience, '#f59e0b') : '') + '</div><div class="score-card"><div class="score-label">Education</div><div class="score-value">' + (record.scores.education != null ? record.scores.education : '–') + '</div>' + (record.scores.education != null ? scoreBar(record.scores.education, '#10b981') : '') + '</div></div></div>' : '') + (record.verdict ? '<div class="section"><div class="section-title">Assessment</div><div class="verdict-box">' + esc(record.verdict) + '</div></div>' : '') + (record.note ? '<div class="section"><div class="section-title">Recruiter Notes</div><div class="verdict-box" style="background:#fffbeb;border-color:#fde68a">' + esc(record.note) + '</div></div>' : '') + '</div><div class="footer"><span>CVsprings</span><span>Report ID: ' + esc(record.id) + '</span></div></div><script>window.onload=function(){if(window.location.search.includes("print=1")){window.print();}}</script></body></html>';
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (err) {
    sendError(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

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
