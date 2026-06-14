'use strict';

/**
 * src/services/fileSecurity.js
 *
 * Authoritative, server-side upload validation. The client's filename
 * extension and the client-sent MIME type are both forgeable, so we decide
 * the real type from file CONTENT (magic bytes + DOCX zip structure), enforce
 * size/batch/aggregate caps, and optionally run an AV scan.
 *
 * All limits/flags come from env so the later domain switch needs no code
 * change.
 */

const fs = require('fs');

const intEnv = (name, def) => {
  const v = Number.parseInt(process.env[name], 10);
  return Number.isFinite(v) && v > 0 ? v : def;
};

const MAX_FILE_BYTES = intEnv('MAX_FILE_BYTES', 10 * 1024 * 1024);   // 10 MB / file
const MAX_BATCH_FILES = intEnv('MAX_BATCH_FILES', 200);             // files / batch
const MAX_TOTAL_BYTES = intEnv('MAX_TOTAL_BYTES', 200 * 1024 * 1024); // aggregate / request
const PROCESS_TIMEOUT_MS = intEnv('PROCESS_TIMEOUT_MS', 30 * 1000);  // per-file processing cap

function err(message, field) {
  return Object.assign(new Error(message), { statusCode: 400, code: 'INVALID_FILE', field });
}

// Detect the real type from content. Returns 'pdf' | 'docx' | null.
// PDF: starts with "%PDF". DOCX: a ZIP (PK\x03\x04) whose directory contains
// the OOXML members [Content_Types].xml and word/document.xml. Zip entry
// NAMES are stored uncompressed, so they appear verbatim in the bytes —
// this distinguishes a real Word doc from an arbitrary .zip renamed .docx.
function sniffType(buffer) {
  if (!buffer || buffer.length < 4) return null;
  if (buffer.slice(0, 4).toString('latin1') === '%PDF') return 'pdf';
  const isZip = buffer[0] === 0x50 && buffer[1] === 0x4b &&
    (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07);
  if (isZip) {
    const haystack = buffer.toString('latin1');
    if (haystack.includes('word/document.xml') && haystack.includes('[Content_Types].xml')) {
      return 'docx';
    }
  }
  return null;
}

// Validate a single uploaded file (already written to disk by multer).
// `field` is 'cv' or 'cvs'. Throws an INVALID_FILE error on any violation.
function validateUploadedFile(file, field) {
  if (file.size > MAX_FILE_BYTES) {
    throw err(`"${file.originalname}" exceeds the ${Math.round(MAX_FILE_BYTES / (1024 * 1024))} MB per-file limit.`, field);
  }
  let buffer;
  try {
    const fd = fs.openSync(file.path, 'r');
    // Reading the whole (size-capped) file is fine and lets us find the zip
    // central directory regardless of where it sits.
    buffer = fs.readFileSync(fd);
    fs.closeSync(fd);
  } catch (_) {
    throw err(`Could not read "${file.originalname}".`, field);
  }
  const type = sniffType(buffer);
  if (type !== 'pdf' && type !== 'docx') {
    throw err(`"${file.originalname}" is not a valid PDF or DOCX file.`, field);
  }
  return type;
}

// Validate the whole batch request (count + aggregate size).
function validateBatch(files, field) {
  if (files.length > MAX_BATCH_FILES) {
    throw err(`Too many files: maximum ${MAX_BATCH_FILES} per batch.`, field);
  }
  const total = files.reduce((sum, f) => sum + (f.size || 0), 0);
  if (total > MAX_TOTAL_BYTES) {
    throw err(`Upload too large: the batch exceeds the ${Math.round(MAX_TOTAL_BYTES / (1024 * 1024))} MB total limit.`, field);
  }
}

// Bound an async operation so a malformed file cannot hang the request.
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      reject(Object.assign(new Error(`${label || 'Processing'} timed out.`), { statusCode: 422, code: 'PROCESSING_TIMEOUT' }));
    }, ms);
    Promise.resolve(promise).then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

// --- Optional AV scan (feature-flagged) ------------------------------------
// When ENABLE_AV_SCAN is true, scan a file before processing. Supports an
// HTTP scanning API (AV_SCAN_URL) out of the box; a clamd integration can be
// dropped in here. Returns { clean: boolean }. When disabled or unconfigured,
// returns { clean: true, skipped: true } — uploads are never blocked silently.
function avEnabled() {
  return String(process.env.ENABLE_AV_SCAN || '').toLowerCase() === 'true';
}

async function scanFile(filePath) {
  if (!avEnabled()) return { clean: true, skipped: true };
  const url = process.env.AV_SCAN_URL;
  if (!url) return { clean: true, skipped: true }; // flag on but no scanner wired
  const buffer = fs.readFileSync(filePath);
  const resp = await withTimeout(
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: buffer }),
    PROCESS_TIMEOUT_MS,
    'Malware scan'
  );
  if (!resp.ok) throw Object.assign(new Error('Malware scan unavailable.'), { statusCode: 503, code: 'AV_UNAVAILABLE' });
  const data = await resp.json().catch(() => ({}));
  // Convention: scanner returns { clean: true } or { infected: true }.
  return { clean: data.clean === true || (data.infected === false), skipped: false };
}

module.exports = {
  MAX_FILE_BYTES,
  MAX_BATCH_FILES,
  MAX_TOTAL_BYTES,
  PROCESS_TIMEOUT_MS,
  sniffType,
  validateUploadedFile,
  validateBatch,
  withTimeout,
  avEnabled,
  scanFile,
};
