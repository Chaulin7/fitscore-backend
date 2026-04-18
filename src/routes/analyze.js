'use strict';

const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const { extractText } = require('../services/parser');
const { scoreCV }    = require('../services/scorer');

const router = express.Router();

// ── Multer setup ─────────────────────────────────────────────────────────
const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename:    (req, file, cb) => {
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

// ── POST /api/analyze ────────────────────────────────────────────────────
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

    // Parse weights
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
        return res.status(400).json({ error: 'weights must be valid JSON. Example: {"kw":40,"sk":30,"ex":20,"ed":10}' });
      }
    }

    // Extract text from CV
    const cvText = await extractText(filePath, req.file.mimetype);

    // Score
    const results = scoreCV(cvText, jobDescription, weights);

    // Candidate name from original filename (without extension)
    const candidateName = path.basename(req.file.originalname, path.extname(req.file.originalname));

    res.json({ candidateName, ...results });

  } catch (err) {
    const status = err.statusCode || 500;
    res.status(status).json({ error: err.message || 'Internal server error' });
  } finally {
    // Always clean up temp file
    if (filePath) {
      fs.unlink(filePath, () => {});
    }
  }
});

module.exports = router;
