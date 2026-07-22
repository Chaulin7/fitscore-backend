'use strict';

const fs = require('fs');
const path = require('path');
const mammoth = require('mammoth');
const fileSec = require('./fileSecurity');
const { extractPdfText, SAFETY_TIMEOUT_MS } = require('./pdfExtractor');

const MAMMOTH_VERSION = require('mammoth/package.json').version;

/**
 * Extract text from a PDF or DOCX file.
 *
 * PDF extraction is fully deterministic (pinned pdfjs-dist + owned assembly,
 * see pdfExtractor.js): same input bytes -> same canonical text -> same
 * SHA-256. The hash and engine/assembler versions are returned in meta so
 * they can be recorded in the assessment's audit block.
 *
 * @param {string} filePath - Absolute path to the uploaded file
 * @param {string} mimetype - MIME type of the file
 * @returns {Promise<{ text: string, sha256: string, meta: object }>}
 *   Throws Error with { statusCode, code } on failure (original engine
 *   error preserved on .cause).
 */
async function extractText(filePath, mimetype) {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.pdf' || mimetype === 'application/pdf') {
    return extractFromPdf(filePath);
  }

  if (
    ext === '.docx' ||
    mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    return extractFromDocx(filePath);
  }

  throw Object.assign(
    new Error('Unsupported file type. Only PDF and DOCX files are accepted.'),
    { statusCode: 415 }
  );
}

// Deterministic engine — no retries needed: the same file succeeds or fails
// the same typed way on every run. (The old pdf-parse retry loop existed only
// because that engine failed non-deterministically on identical inputs.)
async function extractFromPdf(filePath) {
  const buffer = fs.readFileSync(filePath);
  return extractPdfText(buffer); // { text, sha256, meta }; typed errors inside
}

async function extractFromDocx(filePath) {
  let result;
  try {
    // Same 60s DoS backstop as the PDF path (surfaces as PROCESSING_TIMEOUT).
    result = await fileSec.withTimeout(
      mammoth.extractRawText({ path: filePath }),
      SAFETY_TIMEOUT_MS,
      'DOCX processing'
    );
  } catch (err) {
    if (err && err.code === 'PROCESSING_TIMEOUT') throw err;
    const e = Object.assign(
      new Error('This DOCX file could not be read — it may be corrupted. Try re-saving it, then upload again.'),
      { statusCode: 422, code: 'UNPROCESSABLE_FILE' }
    );
    e.cause = err;
    throw e;
  }
  const text = (result.value || '').trim();
  if (!text) {
    throw Object.assign(
      new Error('No text could be extracted from this DOCX file — it appears to be empty.'),
      { statusCode: 422, code: 'EMPTY_FILE' }
    );
  }
  const crypto = require('crypto');
  return {
    text,
    sha256: crypto.createHash('sha256').update(text, 'utf8').digest('hex'),
    meta: {
      engine: 'mammoth',
      engineVersion: MAMMOTH_VERSION,
      assemblerVersion: null, // text assembly is mammoth's, not ours
      pages: null,
      chars: text.length,
    },
  };
}

module.exports = { extractText };
