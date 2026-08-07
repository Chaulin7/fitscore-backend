'use strict';

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { extractText } = require('../services/parser');
const provenance = require('../services/provenanceCache');
const { scoreCV, anonymizeText } = require('../services/scorer');
const { getOrgBilling, reserveUsage, refundUsage } = require('../services/db');
const { limitFor } = require('../services/billing');
const fileSec = require('../services/fileSecurity');
const { enforceAnalyzeRate, sampleLimiter } = require('../middleware/rateLimits');
const { SAMPLE_VERSION, SAMPLE_ROLE, SAMPLE_WEIGHTS, SAMPLE_CV, SAMPLE_JD } = require('../data/sample');

const router = express.Router();

// Cached sample analysis (onboarding). Computed once through the real scoring
// pipeline and reused; recomputed only if the sample or model version changes.
// Never counts against quota.
let _sampleCache = null;
let _sampleCacheKey = null;

// Authoritative server-side checks: content-sniff the type, run the optional
// AV scan, then deterministic text extraction. Returns { text, sha256, meta }.
// Throws INVALID_FILE / FILE_REJECTED / UNPROCESSABLE_FILE / IMAGE_ONLY_PDF /
// PDF_ENCRYPTED / PROCESSING_TIMEOUT. The old 30s wrapper here is gone: the
// extractor carries its own 60s DoS circuit breaker internally, and with a
// deterministic engine a timeout is a property of the file, not of the run.
async function validateAndExtract(file, field) {
  fileSec.validateUploadedFile(file, field);            // magic bytes + size
  const scan = await fileSec.scanFile(file.path);       // no-op unless ENABLE_AV_SCAN
  if (!scan.clean) {
    throw Object.assign(new Error('This file was rejected by a security scan.'),
      { statusCode: 400, code: 'FILE_REJECTED', field });
  }
  return extractText(file.path, file.mimetype);
}

// Identifies the scoring engine version for provenance records (Art. 12). The
// scorer is a deterministic lexical matcher, not an LLM; its behaviour changes
// only with releases, so it is versioned with the package.
//
// Kept as two parts, joined into MODEL_ID for the wire and for
// audit_log.engine_version (whose value must not change). The provenance record
// carries them separately — see provenanceRecord() below for why.
const SCORER_ENGINE = 'cvsprings-lexical-scorer';
const SCORER_VERSION = require('../../package.json').version;
const MODEL_ID = `${SCORER_ENGINE}@${SCORER_VERSION}`;

// Extraction provenance for the audit block: engine + versions + the SHA-256
// of the canonical extracted text (computed BEFORE any anonymization).
function extractionSummary(extracted) {
  return {
    engine: extracted.meta.engine,
    engineVersion: extracted.meta.engineVersion,
    assemblerVersion: extracted.meta.assemblerVersion,
    textSha256: extracted.sha256,
    pageCount: extracted.meta.pages,
    charCount: extracted.meta.chars,
  };
}

/**
 * The provenance record bound to one analysis.
 *
 * Built key-by-key ON PURPOSE. This payload used to be
 *   { analysisId, ...extraction, scoringWeights, engineVersion: MODEL_ID }
 * where the spread's `engineVersion` (the EXTRACTOR's — pdfjs 4.2.67) was
 * silently overwritten by the literal (the SCORER's). The extractor version was
 * lost outright, and every stored blob paired `engine: 'pdfjs'` with a scorer
 * version. Never let a spread and a literal share a key here again: name each
 * field, and let provenanceCache reject anything unexpected.
 */
function provenanceRecord(analysisId, extraction, weights) {
  return {
    analysisId,
    // Extraction facts — which reader turned the file into text.
    extractorEngine: extraction.engine,
    extractorVersion: extraction.engineVersion,
    assemblerVersion: extraction.assemblerVersion,
    textSha256: extraction.textSha256,
    pageCount: extraction.pageCount,
    charCount: extraction.charCount,
    // Scoring facts — which engine turned that text into a score, under which
    // weights. Kept split; audit_log.engine_version rejoins them.
    scorerEngine: SCORER_ENGINE,
    scorerVersion: SCORER_VERSION,
    scoringWeights: weights,
  };
}

// Atomic plan gate: reserve `requested` analyses against the org's monthly
// counter in a single DB transaction (race-free), so two concurrent requests
// can't both pass the check and exceed the limit. On block, writes the same
// 402 QUOTA_EXCEEDED body as before and returns null. Callers refund the
// reservation if processing later fails (see the routes below).
function reserveQuota(req, res, requested) {
  const b = getOrgBilling(req.orgId);
  const limit = limitFor(b);            // null = unlimited (still reserves + counts)
  const plan = b ? b.plan : 'free';
  const r = reserveUsage(req.orgId, requested, limit);
  if (!r.ok) {
    res.status(402).json({
      error: 'Monthly analysis limit reached. Upgrade to continue.',
      code: 'QUOTA_EXCEEDED',
      limit,
      used: r.used,
      plan,
    });
    return null;
  }
  return { reserved: requested, limit, used: r.used, plan };
}

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

const MAX_FILE_BYTES = fileSec.MAX_FILE_BYTES;
const MAX_BATCH = fileSec.MAX_BATCH_FILES;
const upload = multer({ storage, fileFilter, limits: { fileSize: MAX_FILE_BYTES, files: MAX_BATCH } });

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

// GET /api/analyze/sample — cached sample analysis for first-run onboarding.
// Auth required (mounted behind requireSession), NOT quota-counted, light
// rate limit as a safety net. Returns the same shape as POST /api/analyze,
// plus the sample JD/role/weights so the frontend can mirror the input.
router.get('/sample', sampleLimiter, (req, res) => {
  try {
    const key = SAMPLE_VERSION + ':' + MODEL_ID;
    if (!_sampleCache || _sampleCacheKey !== key) {
      const results = scoreCV(SAMPLE_CV, SAMPLE_JD, SAMPLE_WEIGHTS);
      _sampleCache = {
        candidateName: 'Alex Morgan (sample)',
        fileName: 'sample-cv.pdf',
        anonymized: false,
        sample: true,
        modelId: MODEL_ID,
        analysisTimestamp: new Date().toISOString(),
        ...results,
        // Echo the input so the frontend can populate the form to match.
        sampleJd: SAMPLE_JD,
        sampleRole: SAMPLE_ROLE,
        sampleWeights: SAMPLE_WEIGHTS,
      };
      _sampleCacheKey = key;
    }
    res.json(_sampleCache);
  } catch (err) {
    sendError(res, 500, 'INTERNAL_ERROR', 'Could not generate the sample.');
  }
});

router.post('/', upload.single('cv'), async (req, res) => {
  let filePath = null;
  let reserved = 0; // analyses reserved against quota; refunded on failure
  try {
    if (!req.file) {
      return sendError(res, 400, 'NO_FILE', 'No CV file uploaded. Include a file with field name "cv".', 'cv');
    }
    filePath = req.file.path;

    let jobDescription;
    try { jobDescription = validateJobDescription(req.body.jobDescription); }
    catch (e) { return sendError(res, 400, e.code || 'VALIDATION_ERROR', e.message, e.field); }

    let weights = { kw: 40, sk: 30, ex: 20, ed: 10 };
    if (req.body.weights) {
      try { weights = parseWeights(req.body.weights); }
      catch (e) { return sendError(res, 400, e.code || 'VALIDATION_ERROR', e.message, e.field); }
    }

    const anonymize = req.body.anonymize === 'true' || req.body.anonymize === true;

    // Abuse/cost rate guard (per org), layered on top of the billing quota.
    if (!enforceAnalyzeRate(req, res, 1)) return;
    // Plan gate (server-side): single CV = 1 analysis. Reserved atomically.
    if (!reserveQuota(req, res, 1)) return;
    reserved = 1;

    // Authoritative content validation + optional AV scan + bounded extraction.
    let extracted;
    try { extracted = await validateAndExtract(req.file, 'cv'); }
    catch (e) {
      refundUsage(req.orgId, reserved); reserved = 0; // extraction failed: return the reservation
      if (e.code === 'FILE_REJECTED') console.warn('[security] upload rejected by AV scan', { org: req.orgId, file: req.file.originalname });
      return sendError(res, e.statusCode || 400, e.code || 'INVALID_FILE', e.message, e.field || 'cv');
    }
    let cvText = extracted.text;
    if (anonymize) cvText = anonymizeText(cvText);

    const results = scoreCV(cvText, jobDescription, weights);
    const candidateName = anonymize
      ? 'Candidate ' + path.basename(req.file.originalname, path.extname(req.file.originalname)).slice(0, 4).toUpperCase()
      : path.basename(req.file.originalname, path.extname(req.file.originalname));

    // Usage was reserved atomically at the gate; a success keeps the reservation.
    recordUsage(req, 'analyze_single', 1);
    const extraction = extractionSummary(extracted);
    const analysisId = uuidv4();
    // Bind THIS analysis's provenance (extraction + the exact weights used +
    // engine version), keyed by analysisId, so the audit save records them
    // authoritatively (never the client's echoed weights). The client echoes
    // analysisId back at save time. See provenanceCache + POST /api/audit.
    provenance.remember(req.orgId, provenanceRecord(analysisId, extraction, weights));
    res.json({ candidateName, anonymized: anonymize, modelId: MODEL_ID, analysisTimestamp: new Date().toISOString(), analysisId, extraction, ...results });
  } catch (err) {
    if (reserved) refundUsage(req.orgId, reserved); // a post-reservation failure returns the reservation
    const status = err.statusCode || 500;
    const code = err.code || (status === 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST');
    // Don't leak internals on a 500; keep specific messages for handled statuses.
    const message = status === 500 ? 'Something went wrong. Please try again.' : (err.message || 'Request failed');
    sendError(res, status, code, message, err.field);
  } finally {
    if (filePath) fs.unlink(filePath, () => {});
  }
});

router.post('/batch', upload.array('cvs', MAX_BATCH), async (req, res) => {
  const filePaths = [];
  let reserved = 0; // analyses reserved against quota; unscored files refunded below
  try {
    if (!req.files || req.files.length === 0) {
      return sendError(res, 400, 'NO_FILES', 'No CV files uploaded. Use field name "cvs" for multiple files.', 'cvs');
    }
    // Authoritative count + aggregate-size caps (server-side).
    try { fileSec.validateBatch(req.files, 'cvs'); }
    catch (e) { return sendError(res, e.statusCode || 400, e.code || 'INVALID_FILE', e.message, e.field || 'cvs'); }

    let jobDescription;
    try { jobDescription = validateJobDescription(req.body.jobDescription); }
    catch (e) { return sendError(res, 400, e.code || 'VALIDATION_ERROR', e.message, e.field); }

    let weights = { kw: 40, sk: 30, ex: 20, ed: 10 };
    if (req.body.weights) {
      try { weights = parseWeights(req.body.weights); }
      catch (e) { return sendError(res, 400, e.code || 'VALIDATION_ERROR', e.message, e.field); }
    }

    const anonymize = req.body.anonymize === 'true' || req.body.anonymize === true;

    // Abuse/cost rate guard (per org): a batch costs its CV count.
    if (!enforceAnalyzeRate(req, res, req.files.length)) return;
    // Plan gate (server-side): a batch that would exceed the cap is rejected
    // whole — we never analyze a partial batch. Reserved atomically.
    if (!reserveQuota(req, res, req.files.length)) return;
    reserved = req.files.length;

    const results = [];

    for (const file of req.files) {
      filePaths.push(file.path);
      try {
        // Per-file authoritative validation + AV scan + bounded extraction.
        let extracted;
        try { extracted = await validateAndExtract(file, 'cvs'); }
        catch (ve) {
          if (ve.code === 'FILE_REJECTED') console.warn('[security] upload rejected by AV scan', { org: req.orgId, file: file.originalname });
          results.push({
            candidateName: path.basename(file.originalname, path.extname(file.originalname)),
            fileName: file.originalname,
            error: ve.message,
            code: ve.code || 'INVALID_FILE'
          });
          continue;
        }
        let cvText = extracted.text;
        if (anonymize) cvText = anonymizeText(cvText);
        const scored = scoreCV(cvText, jobDescription, weights);
        const candidateName = anonymize
          ? 'Candidate #' + (results.length + 1)
          : path.basename(file.originalname, path.extname(file.originalname));
        const extraction = extractionSummary(extracted);
        const analysisId = uuidv4(); // one per candidate, NOT one per batch
        provenance.remember(req.orgId, provenanceRecord(analysisId, extraction, weights));
        results.push({ candidateName, fileName: file.originalname, anonymized: anonymize, modelId: MODEL_ID, analysisTimestamp: new Date().toISOString(), analysisId, extraction, ...scored });
      } catch (fileErr) {
        results.push({
          candidateName: path.basename(file.originalname, path.extname(file.originalname)),
          fileName: file.originalname,
          error: fileErr.message
        });
      }
    }

    results.sort((a, b) => (b.overall || 0) - (a.overall || 0));
    // Whole batch was reserved atomically at the gate; refund the files that
    // failed to score so errored files don't burn quota (unchanged behavior).
    const scoredCount = results.filter((r) => !r.error).length;
    refundUsage(req.orgId, reserved - scoredCount);
    reserved = 0; // settled — the outer catch must not refund again
    recordUsage(req, 'analyze_batch', scoredCount);
    res.json({ count: results.length, modelId: MODEL_ID, results });
  } catch (err) {
    const status = err.statusCode || 500;
    const code = err.code || (status === 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST');
    // Don't leak internals on a 500; keep specific messages for handled statuses.
    const message = status === 500 ? 'Something went wrong. Please try again.' : (err.message || 'Request failed');
    sendError(res, status, code, message, err.field);
  } finally {
    if (reserved) refundUsage(req.orgId, reserved); // catastrophic failure before settling: refund all reserved
    for (const fp of filePaths) fs.unlink(fp, () => {});
  }
});

router.use((err, req, res, next) => {
  // Map multer's hard limits to the unified INVALID_FILE code the frontend
  // already understands (field-aware). These fire before route handlers.
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    const mb = Math.round(MAX_FILE_BYTES / (1024 * 1024));
    return sendError(res, 400, 'INVALID_FILE', `A file exceeds the ${mb} MB per-file limit.`, err.field || 'cv');
  }
  if (err && (err.code === 'LIMIT_UNEXPECTED_FILE' || err.code === 'LIMIT_FILE_COUNT')) {
    return sendError(res, 400, 'INVALID_FILE', `Too many files: maximum ${MAX_BATCH} per batch.`, err.field || 'cvs');
  }
  if (err) {
    const status = err.statusCode || 500;
    const code = err.code || (status === 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST');
    // Never leak internals on a 500.
    const message = status === 500 ? 'Something went wrong processing the upload.' : (err.message || 'Upload error');
    return sendError(res, status, code, message, err.field);
  }
  next();
});

module.exports = router;
