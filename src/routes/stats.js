'use strict';

const express = require('express');
const { getAllAudits } = require('../services/db');

const router = express.Router();

function sendError(res, status, code, message, field) {
  const body = { error: message, code };
  if (field) body.field = field;
  return res.status(status).json(body);
}

function startOfDayIso(d) {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x.toISOString().slice(0, 10);
}

// GET /api/stats/overview
// Returns dashboard summary metrics.
router.get('/overview', (req, res) => {
  try {
    const records = getAllAudits({ orgId: req.orgId });

    const totalAnalyses = records.length;
    let totalShortlisted = 0, totalRejected = 0, totalOnHold = 0;
    let scoreSum = 0, scoreCount = 0;
    const roleSet = new Set();

    for (const r of records) {
      if (r.decision === 'shortlist') totalShortlisted++;
      else if (r.decision === 'reject') totalRejected++;
      else if (r.decision === 'hold') totalOnHold++;
      if (typeof r.overall === 'number') { scoreSum += r.overall; scoreCount++; }
      if (r.role) roleSet.add(r.role);
    }

    const avgScore = scoreCount > 0 ? Math.round((scoreSum / scoreCount) * 10) / 10 : 0;

    // last 7 days bucket
    const buckets = {};
    const now = new Date();
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setUTCDate(now.getUTCDate() - i);
      buckets[startOfDayIso(d)] = 0;
    }
    for (const r of records) {
      if (!r.createdAt) continue;
      const key = startOfDayIso(r.createdAt);
      if (key in buckets) buckets[key]++;
    }
    const last7Days = Object.entries(buckets).map(([date, count]) => ({ date, count }));

    res.json({
      totalAnalyses,
      totalShortlisted,
      totalRejected,
      totalOnHold,
      avgScore,
      rolesActive: roleSet.size,
      last7Days
    });
  } catch (err) {
    sendError(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// ---------------------------------------------------------------------------
// GET /api/stats/score-distribution
// Org-scoped scoring-consistency stats for the bias report's monitoring
// section: per role — count, mean, median, a 10-band histogram of overall
// scores, and shortlist rate per score band. This reflects only the org's
// own audit data; CVsprings stores no demographic data, so this is a
// consistency view, not a demographic bias audit.
// ---------------------------------------------------------------------------

const HISTOGRAM_BANDS = ['0-9', '10-19', '20-29', '30-39', '40-49', '50-59', '60-69', '70-79', '80-89', '90-100'];
const RATE_BANDS = [
  { label: '0-49', min: 0, max: 49 },
  { label: '50-69', min: 50, max: 69 },
  { label: '70-84', min: 70, max: 84 },
  { label: '85-100', min: 85, max: 100 },
];

function median(sorted) {
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round(((sorted[mid - 1] + sorted[mid]) / 2) * 10) / 10;
}

function summarizeGroup(records) {
  const scores = records.map((r) => r.overall).filter((v) => typeof v === 'number').sort((a, b) => a - b);
  const histogram = HISTOGRAM_BANDS.map((band) => ({ band, count: 0 }));
  for (const s of scores) {
    const idx = Math.min(9, Math.floor(s / 10));
    histogram[idx].count++;
  }
  const shortlistRateByBand = RATE_BANDS.map(({ label, min, max }) => {
    const inBand = records.filter((r) => typeof r.overall === 'number' && r.overall >= min && r.overall <= max);
    const shortlisted = inBand.filter((r) => r.decision === 'shortlist').length;
    return {
      band: label,
      total: inBand.length,
      shortlisted,
      rate: inBand.length ? Math.round((shortlisted / inBand.length) * 100) : null,
    };
  });
  return {
    count: records.length,
    scored: scores.length,
    mean: scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : null,
    median: median(scores),
    histogram,
    shortlistRateByBand,
  };
}

router.get('/score-distribution', (req, res) => {
  try {
    const records = getAllAudits({ orgId: req.orgId });
    const byRole = new Map();
    for (const r of records) {
      const key = (r.role || '').trim() || '(no role)';
      if (!byRole.has(key)) byRole.set(key, []);
      byRole.get(key).push(r);
    }
    const roles = [...byRole.entries()]
      .map(([role, recs]) => ({ role, ...summarizeGroup(recs) }))
      .sort((a, b) => b.count - a.count);
    res.json({
      generatedAt: new Date().toISOString(),
      totalRecords: records.length,
      overall: summarizeGroup(records),
      roles,
    });
  } catch (err) {
    sendError(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

module.exports = router;
