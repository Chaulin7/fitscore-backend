'use strict';

const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const path = require('path');

/**
 * Extract text from a PDF or DOCX file.
 * @param {string} filePath - Absolute path to the uploaded file
 * @param {string} mimetype - MIME type of the file
 * @returns {Promise<string>} Extracted plain text
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

// pdf-parse is intermittently flaky (the same file can throw "bad XRef entry"
// then parse on a retry), so the THROW path is retried a bounded number of
// times. The EMPTY-text path (scanned/image PDF) is NOT retried — re-parsing
// an image won't produce text. Both exhaustion cases return 422 (unprocessable
// client input), not 500. The original pdf-parse error is preserved on .cause
// for server-side logging.
const PDF_PARSE_RETRIES = 2; // total attempts = 1 + PDF_PARSE_RETRIES
const PDF_RETRY_DELAY_MS = 150;

async function extractFromPdf(filePath) {
  const fs = require('fs');
  const buffer = fs.readFileSync(filePath);
  const maxAttempts = PDF_PARSE_RETRIES + 1;
  let lastParseError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let data;
    try {
      data = await pdfParse(buffer);
    } catch (err) {
      lastParseError = err;
      console.warn('[parser] pdf-parse attempt ' + attempt + '/' + maxAttempts +
        ' failed: ' + (err && err.name ? err.name + ': ' : '') + (err && err.message));
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, PDF_RETRY_DELAY_MS));
        continue;
      }
      const e = Object.assign(
        new Error('This PDF could not be read — the file may be corrupted or malformed. Try re-saving or re-exporting it, then upload again.'),
        { statusCode: 422, code: 'UNPROCESSABLE_FILE' }
      );
      e.cause = lastParseError;
      throw e;
    }
    // Parsed successfully — check for empty text (scanned/image PDF). No retry.
    const text = (data.text || '').trim();
    if (!text) {
      throw Object.assign(
        new Error('No text could be extracted — this PDF appears to be a scanned image. Upload a text-based PDF or an OCR-processed version.'),
        { statusCode: 422, code: 'IMAGE_ONLY_PDF' }
      );
    }
    return text;
  }
}

async function extractFromDocx(filePath) {
  let result;
  try {
    result = await mammoth.extractRawText({ path: filePath });
  } catch (err) {
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
  return text;
}

module.exports = { extractText };
