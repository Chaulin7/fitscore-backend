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

async function extractFromPdf(filePath) {
  const fs = require('fs');
  const buffer = fs.readFileSync(filePath);

  let data;
  try {
    data = await pdfParse(buffer);
  } catch (err) {
    throw Object.assign(
      new Error('File may be image-based — text could not be extracted from PDF.'),
      { statusCode: 500 }
    );
  }

  const text = (data.text || '').trim();
  if (!text) {
    throw Object.assign(
      new Error('File may be image-based — text could not be extracted from PDF.'),
      { statusCode: 500 }
    );
  }

  return text;
}

async function extractFromDocx(filePath) {
  let result;
  try {
    result = await mammoth.extractRawText({ path: filePath });
  } catch (err) {
    throw Object.assign(
      new Error('Could not parse DOCX file. The file may be corrupt or unsupported.'),
      { statusCode: 500 }
    );
  }

  const text = (result.value || '').trim();
  if (!text) {
    throw Object.assign(
      new Error('No text could be extracted from the DOCX file.'),
      { statusCode: 500 }
    );
  }

  return text;
}

module.exports = { extractText };
