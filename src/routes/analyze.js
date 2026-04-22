'use strict';

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { extractText } = require('../services/parser');
const { scoreCV, anonymizeText } = require('../services/scorer');

const router = express.Router();

// ── Multer setup ─────────────────────────────────────────────────────────
const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, unique + path.extname(file.originalname));
  }
});

const fileFilter = (req, file, cb) => {
  const allowed = ['.pdf', '.docx'];
  const ext = path.extname(file.originalname).toLowerCase();
  if (allowed.includes(ext)) {
    cb(null, true);
  } else {
    cb(Object.assign(new Error('Only .pdf and .docx files are accepted.'), { statusCode: 415 }));
  }
};

const upload = multer({ storage, fileFilter, limits: { fileSize: 10 * 1024 * 1024 } });

// ── POST /api/analyze ──────────────────────────────────────────────────────
router.post('/', upload.single('cv'), async (req, res) => {
  let filePath = null;
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No CV file uploaded. Include a file with field name \'cv\'.' });
    }
    filePath = req.file.path;

    const jobDescription = (req.body.jobDescription || '').trim();
    if (!jobDescription) {
      return res.status(400).json({ error: 'jobDescription is required.' });
    }

    let weights = { kw: 40, sk: 30, ex: 20, ed: 10 };
    if (req.body.weights) {
      try {
        const parsed = typeof req.body.weights === 'string'
          ? JSON.parse(req.body.weights)
          : req.body.weights;
        const total = (parsed.kw || 0) + (parsed.sk || 0) + (parsed.ex || 0) + (parsed.ed || 0);
        if (Math.abs(total - 100) > 0.01) {
          return res.status(400).json({ error: 'weights must sum to 100. Got: ' + total });
        }
        weights = parsed;
      } catch {
        return res.status(400).json({ error: 'weights must be valid JSON.' });
      }
    }

    const anonymize = req.body.anonymize === 'true' || req.body.anonymize === true;

    let cvText = await extractText(filePath, req.file.mimetype);
    if (anonymize) cvText = anonymizeText(cvText);

    const results = scoreCV(cvText, jobDescription, weights);
    const candidateName = anonymize
      ? 'Candidate ' + path.basename(req.file.originalname, path.extname(req.file.originalname)).slice(0, 4).toUpperCase()
      : path.basename(req.file.originalname, path.extname(req.file.originalname));

    res.json({ candidateName, anonymized: anonymize, ...results });

  } catch (err) {
    const status = err.statusCode || 500;
    res.status(status).json({ error: err.message || 'Internal server error' });
  } finally {
    if (filePath) fs.unlink(filePath, () => {});
  }
});

// ── POST /api/analyze/batch ────────────────────────────────────────────────
// Accepts: multiple CV files (field name "cvs"), jobDescription, weights, anonymize, role
router.post('/batch', upload.array('cvs', 50), async (req, res) => {
  const filePaths = [];
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No CV files uploaded. Use field name \'cvs\' for multiple files.' });
    }

    const jobDescription = (req.body.jobDescription || '').trim();
    if (!jobDescription) {
      return res.status(400).json({ error: 'jobDescription is required.' });
    }

    let weights = { kw: 40, sk: 30, ex: 20, ed: 10 };
    if (req.body.weights) {
      try {
        const parsed = typeof req.body.weights === 'string'
          ? JSON.parse(req.body.weights)
          : req.body.weights;
        const total = (parsed.kw || 0) + (parsed.sk || 0) + (parsed.ex || 0) + (parsed.ed || 0);
        if (Math.abs(total - 100) > 0.01) {
          return res.status(400).json({ error: 'weights must sum to 100. Got: ' + total });
        }
        weights = parsed;
      } catch {
        return res.status(400).json({ error: 'weights must be valid JSON.' });
      }
    }

    const anonymize = req.body.anonymize === 'true' || req.body.anonymize === true;

    const results = [];
    for (const file of req.files) {
      filePaths.push(file.path);
      try {
        let cvText = await extractText(file.path, file.mimetype);
        if (anonymize) cvText = anonymizeText(cvText);

        const scored = scoreCV(cvText, jobDescription, weights);
        const candidateName = anonymize
          ? 'Candidate #' + (results.length + 1)
          : path.basename(file.originalname, path.extname(file.originalname));

        results.push({
          candidateName,
          fileName: file.originalname,
          anonymized: anonymize,
          ...scored
        });
      } catch (fileErr) {
        results.push({
          candidateName: path.basename(file.originalname, path.extname(file.originalname)),
          fileName: file.originalname,
          error: fileErr.message
        });
      }
    }

    // Sort by overall score descending (errors go to bottom)
    results.sort((a, b) => (b.overall || 0) - (a.overall || 0));

    res.json({ count: results.length, results });

  } catch (err) {
    const status = err.statusCode || 500;
    res.status(status).json({ error: err.message || 'Internal server error' });
  } finally {
    for (const fp of filePaths) fs.unlink(fp, () => {});
  }
});

module.exports = router;
