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

// Detect the real type from content. Returns 'pdf' | 'docx' | 'png' | 'jpeg' | null.
// PDF: starts with "%PDF". DOCX: a ZIP (PK\x03\x04) whose directory contains
// the OOXML members [Content_Types].xml and word/document.xml. Zip entry
// NAMES are stored uncompressed, so they appear verbatim in the bytes —
// this distinguishes a real Word doc from an arbitrary .zip renamed .docx.
// PNG: the 8-byte signature. JPEG: SOI followed by any marker (FF D8 FF).
//
// SVG is deliberately absent and must never be added: an org-supplied logo is
// embedded in a server-side renderer, and SVG is a scripting-capable document
// format, not an image format.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function sniffType(buffer) {
  if (!buffer || buffer.length < 4) return null;
  if (buffer.slice(0, 4).toString('latin1') === '%PDF') return 'pdf';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return 'png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
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

// --- Raster image validation (org logo uploads) -----------------------------
// Logos are stored as a base64 data URI and handed to pdfmake's { image: … }
// node. Bounds are enforced on BYTES (at the edge, by multer) and on PIXEL
// DIMENSIONS here, because a small file can still decode to an enormous bitmap.

const MAX_LOGO_BYTES = intEnv('MAX_LOGO_BYTES', 384 * 1024);  // raw; ~512KB once base64'd
const MAX_LOGO_DIMENSION = intEnv('MAX_LOGO_DIMENSION', 2000); // px, either side

// Width/height from a PNG's IHDR, which the spec requires to be the first
// chunk: 8-byte signature, 4-byte length, 4-byte type, then two BE uint32s.
function pngDimensions(buffer) {
  if (buffer.length < 24) return null;
  if (buffer.subarray(12, 16).toString('latin1') !== 'IHDR') return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

// Width/height from a JPEG's first SOFn frame header. Walks the marker chain
// rather than guessing an offset, because the segments before it (APPn, DQT,
// EXIF…) vary in number and size. 0xC4/0xC8/0xCC sit in the 0xCn range but are
// DHT/DAC/DNL, not frame headers.
function jpegDimensions(buffer) {
  let i = 2;
  while (i + 9 < buffer.length) {
    if (buffer[i] !== 0xff) { i += 1; continue; }
    const marker = buffer[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    if (marker === 0xda) break; // start of scan — no frame header found
    const segmentLength = buffer.readUInt16BE(i + 2);
    const isFrameHeader = marker >= 0xc0 && marker <= 0xcf
      && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrameHeader) {
      return { height: buffer.readUInt16BE(i + 5), width: buffer.readUInt16BE(i + 7) };
    }
    if (segmentLength < 2) break; // malformed: would not advance
    i += 2 + segmentLength;
  }
  return null;
}

function imageDimensions(buffer, type) {
  if (type === 'png') return pngDimensions(buffer);
  if (type === 'jpeg') return jpegDimensions(buffer);
  return null;
}

/**
 * Validate an in-memory logo upload. Returns { type, width, height, dataUri }.
 *
 * Throws INVALID_FILE on anything it cannot fully vouch for. Fails CLOSED on
 * unreadable dimensions: a buffer that sniffs as PNG or JPEG but whose header
 * will not parse is truncated or malformed, and an image whose bounds cannot be
 * checked must not reach the renderer.
 *
 * Never touches the filesystem — the buffer arrives in memory from multer and
 * leaves as a data URI.
 */
function validateLogoUpload(buffer, field = 'logo') {
  if (!buffer || !buffer.length) throw err('No image was uploaded.', field);
  if (buffer.length > MAX_LOGO_BYTES) {
    throw err(`Logo is larger than the ${Math.round(MAX_LOGO_BYTES / 1024)} KB limit.`, field);
  }
  const type = sniffType(buffer);
  if (type !== 'png' && type !== 'jpeg') {
    // Named rather than generic: "I uploaded a PNG" is usually an SVG or a
    // renamed file, and saying so saves a support round trip.
    throw err('Logo must be a PNG or JPEG image. SVG and other formats are not accepted.', field);
  }
  const dims = imageDimensions(buffer, type);
  if (!dims || !dims.width || !dims.height) {
    throw err('Logo could not be read — the image file appears to be incomplete or corrupt.', field);
  }
  if (dims.width > MAX_LOGO_DIMENSION || dims.height > MAX_LOGO_DIMENSION) {
    throw err(
      `Logo is ${dims.width}×${dims.height} pixels; the maximum is `
      + `${MAX_LOGO_DIMENSION}×${MAX_LOGO_DIMENSION}.`, field,
    );
  }
  const mime = type === 'png' ? 'image/png' : 'image/jpeg';
  return { type, width: dims.width, height: dims.height, dataUri: `data:${mime};base64,${buffer.toString('base64')}` };
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
  MAX_LOGO_BYTES,
  MAX_LOGO_DIMENSION,
  sniffType,
  imageDimensions,
  validateLogoUpload,
  validateUploadedFile,
  validateBatch,
  withTimeout,
  avEnabled,
  scanFile,
};
