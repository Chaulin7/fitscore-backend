'use strict';

const express = require('express');
const { insertAudit, getAllAudits, deleteAudit, exportCsv } = require('../services/db');

const router = express.Router();

// POST /api/audit — save an audit record
router.post('/', (req, res) => {
  try {
    const {
      candidateName, fileName, overall, scores, weights,
      verdict, decision, note, jdSnippet
    } = req.body;

    if (!candidateName) {
      return res.status(400).json({ error: 'candidateName is required.' });
    }

    const record = insertAudit({
      candidateName, fileName, overall, scores, weights,
      verdict, decision, note, jdSnippet
    });

    res.status(201).json(record);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/audit — list all audit records
router.get('/', (req, res) => {
  try {
    const { decision, limit } = req.query;
    const records = getAllAudits({ decision, limit });
    res.json(records);
  } catch (err) {
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/audit/:id — remove a record
router.delete('/:id', (req, res) => {
  try {
    const deleted = deleteAudit(req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: 'Record not found.' });
    }
    res.json({ success: true, id: req.params.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
