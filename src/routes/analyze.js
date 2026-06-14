'use strict';

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { extractText } = require('../services/parser');
const { scoreCV, anonymizeText } = require('../services/scorer');
const { getOrgBilling, getUsageCount, incrementUsage } = require('../services/db');
const { checkQuota } = require('../services/billing');

const router = express.Router();

// Plan gate: may this org run `requested` more analyses this period?
// Returns the quota result; on block, writes a 402 and returns null.
function enforceQuota(req, res, requested) {
  const billing = getOrgBilling(req.orgId);
  const used = getUsageCount(req.orgId);
  const q = checkQuota(billing, used, requested);
  if (!q.allowed) {
    res.status(402).json({
      error: 'Monthly analysis limit reached. Upgrade to continue.',
      code: 'QUOTA_EXCEEDED',
      limit: q.limit,
      used: q.used,
      plan: q.plan,
    });
    return null;
  }
  return q;
}

// Identifies the scoring engine version for provenance records (Art. 12).
// The scorer is a deterministic lexical matcher, not an LLM; its behaviour
// changes only with releases, so it is versioned with the package.
const MODEL_ID = 'cvsprings-lexical-scorer@' + require('../../package.json').version;

function sendError(res, status, code, message, field) {
  const body = { error: message, code };
  if (field) body.field = field;
  return res.status(status).json(body);
}

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
  const allowedExt = ['.pdf', '.docx'];
  const ext = path.extname(file.originalname).toLowerCase();
  if (!allowedExt.includes(ext)) {
    return cb(Object.assign(new Error('Only .pdf and .docx files are accepted.'),
      { statusCode: 415, code: 'UNSUPPORTED_TYPE', field: 'cv' }));
  }
  const okMimes = [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/octet-stream'
  ]
  if (file.mimetype && !okMimes.includes(file.mimetype) && !/pdf|word|octet/i.test(file.mimetype)) {
    return cb(Object.assign(new Error('File mimetype does not match accepted types.'),
      { statusCode: 415, code: 'UNSUPPORTED_TYPE', field: 'cv' }));
  }
  cb(null, true);
};

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_BATCH =200;
const upload = multer({ storage, fileFilter, limits: { fileSize: MAX_FILE_BYTES, files: MAX_BATCH } });

function sniffOk(filePath, ext) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(8);
    fs.readSync(fd, buf, 0, 8, 0);
    fs.closeSync(fd);
    if (ext === '.pdf') return buf.slice(0, 4).toString('utf8') === '%PDF';
    if (ext === '.docx') return buf[0] === 0x50 && buf[1] === 0x4B && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07);
    return false;
  } catch (_) { return false; }
}

function parseWeights(input) {
  if (!input) return null;
  let parsed;
  if (typeof input === 'string') {
    try { parsed = JSON.parse(input); }
    catch (_) { throw Object.assign(new Error('weights must be valid JSON.'), { code: 'VALIDATION_ERROR', field: 'weights' }); }
  } else { parsed = input; }
  const kw = Number(parsed.kw) || 0;
  const sk = Number(parsed.sk) || 0;
  const ex = Number(parsed.ex) || 0;
  const ed = Number(parsed.ed) || 0;
  const total = kw + sk + ex + ed;
  if (Math.abs(total - 100) > 0.5) {
    throw Object.assign(new Error('weights must sum to 100 (±0.5). Got: ' + total),
      { code: 'VALIDATION_ERROR', field: 'weights' });
  }
  return { kw, sk, ex, ed };
}

function validateJobDescription(jd) {
  if (!jd || typeof jd !== 'string') {
    throw Object.assign(new Error('jobDescription is required.'),
      { code: 'VALIDATION_ERROR', field: 'jobDescription' });
  }
  const trimmed = jd.trim();
  if (trimmed.length < 50) {
    throw Object.assign(new Error('jobDescription must be at least 50 characters.'),
      { code: 'VALIDATION_ERROR', field: 'jobDescription' });
  }
  return trimmed;
}

function recordUsage(req, event, cvCount) {
  try {
    if (req.app && req.app.locals && typeof req.app.locals.recordUsage === 'function') {
      req.app.locals.recordUsage(req, event, cvCount);
    }
  } catch (_) {}
}

router.post('/', upload.single('cv'), async (req, res) => {
  let filePath = null;
  try {
    if (!req.file) {
      return sendError(res, 400, 'NO_FILE', 'No CV file uploaded. Include a file with field name "cv".', 'cv');
    }
    filePath = req.file.path;
    const ext = path.extname(req.file.originalname).toLowerCase();
    if (!sniffOk(filePath, ext)) {
      return sendError(res, 415, 'UNSUPPORTED_TYPE', 'File content does not match a valid PDF or DOCX.', 'cv');
    }

    let jobDescription;
    try { jobDescription = validateJobDescription(req.body.jobDescription); }
    catch (e) { return sendError(res, 400, e.code || 'VALIDATION_ERROR', e.message, e.field); }

    let weights = { kw: 40, sk: 30, ex: 20, ed: 10 };
    if (req.body.weights) {
      try { weights = parseWeights(req.body.weights); }
      catch (e) { return sendError(res, 400, e.code || 'VALIDATION_ERROR', e.message, e.field); }
    }

    const anonymize = req.body.anonymize === 'true' || req.body.anonymize === true;

    // Plan gate (server-side): single CV = 1 analysis.
    if (!enforceQuota(req, res, 1)) return;

    let cvText = await extractText(filePath, req.file.mimetype);
    if (anonymize) cvText = anonymizeText(cvText);

    const results = scoreCV(cvText, jobDescription, weights);
    const candidateName = anonymize
      ? 'Candidate ' + path.basename(req.file.originalname, path.extname(req.file.originalname)).slice(0, 4).toUpperCase()
      : path.basename(req.file.originalname, path.extname(req.file.originalname));

    // Meter only after a successful analysis, so failures don't burn quota.
    incrementUsage(req.orgId, 1);
    recordUsage(req, 'analyze_single', 1);
    res.json({ candidateName, anonymized: anonymize, modelId: MODEL_ID, analysisTimestamp: new Date().toISOString(), ...results });
  } catch (err) {
    const status = err.statusCode || 500;
    const code = err.code || (status === 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST');
    sendError(res, status, code, err.message || 'Internal server error', err.field);
  } finally {
    if (filePath) fs.unlink(filePath, () => {});
  }
});

router.post('/batch', upload.array('cvs', MAX_BATCH), async (req, res) => {
  const filePaths = [];
  try {
    if (!req.files || req.files.length === 0) {
      return sendError(res, 400, 'NO_FILES', 'No CV files uploaded. Use field name "cvs" for multiple files.', 'cvs');
    }
    if (req.files.length > MAX_BATCH) {
      return sendError(res, 400, 'BATCH_TOO_LARGE', `Maximum ${MAX_BATCH} files per batch.`, 'cvs');
    }

    let jobDescription;
    try { jobDescription = validateJobDescription(req.body.jobDescription); }
    catch (e) { return sendError(res, 400, e.code || 'VALIDATION_ERROR', e.message, e.field); }

    let weights = { kw: 40, sk: 30, ex: 20, ed: 10 };
    if (req.body.weights) {
      try { weights = parseWeights(req.body.weights); }
      catch (e) { return sendError(res, 400, e.code || 'VALIDATION_ERROR', e.message, e.field); }
    }

    const anonymize = req.body.anonymize === 'true' || req.body.anonymize === true;

    // Plan gate (server-side): a batch that would exceed the cap is rejected
    // whole — we never analyze a partial batch.
    if (!enforceQuota(req, res, req.files.length)) return;

    const results = [];

    for (const file of req.files) {
      filePaths.push(file.path);
      try {
        const ext = path.extname(file.originalname).toLowerCase();
        if (!sniffOk(file.path, ext)) {
          results.push({
            candidateName: path.basename(file.originalname, path.extname(file.originalname)),
            fileName: file.originalname,
            error: 'File content does not match a valid PDF or DOCX.',
            code: 'UNSUPPORTED_TYPE'
          });
          continue;
        }
        let cvText = await extractText(file.path, file.mimetype);
        if (anonymize) cvText = anonymizeText(cvText);
        const scored = scoreCV(cvText, jobDescription, weights);
        const candidateName = anonymize
          ? 'Candidate #' + (results.length + 1)
          : path.basename(file.originalname, path.extname(file.originalname));
        results.push({ candidateName, fileName: file.originalname, anonymized: anonymize, modelId: MODEL_ID, analysisTimestamp: new Date().toISOString(), ...scored });
      } catch (fileErr) {
        results.push({
          candidateName: path.basename(file.originalname, path.extname(file.originalname)),
          fileName: file.originalname,
          error: fileErr.message
        });
      }
    }

    results.sort((a, b) => (b.overall || 0) - (a.overall || 0));
    // Meter only CVs that were actually scored (errored files don't burn quota).
    const scoredCount = results.filter((r) => !r.error).length;
    if (scoredCount > 0) incrementUsage(req.orgId, scoredCount);
    recordUsage(req, 'analyze_batch', scoredCount);
    res.json({ count: results.length, modelId: MODEL_ID, results });
  } catch (err) {
    const status = err.statusCode || 500;
    const code = err.code || (status === 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST');
    sendError(res, status, code, err.message || 'Internal server error', err.field);
  } finally {
    for (const fp of filePaths) fs.unlink(fp, () => {});
  }
});

router.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return sendError(res, 413, 'FILE_TOO_LARGE',
      `File exceeds maximum size of ${MAX_FILE_BYTES} bytes (10MB).`, 'cv');
  }
  if (err && (err.code === 'LIMIT_UNEXPECTED_FILE' || err.code === 'LIMIT_FILE_COUNT')) {
    return sendError(res, 400, 'UPLOAD_LIMIT', err.message, 'cv');
  }
  if (err) {
    const status = err.statusCode || 500;
    const code = err.code || (status === 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST');
    return sendError(res, status, code, err.message || 'Upload error', err.field);
  }
  next();
});

module.exports = router;
