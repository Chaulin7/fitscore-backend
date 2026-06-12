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

module.exports = router;
