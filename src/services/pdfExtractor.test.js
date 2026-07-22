'use strict';

// Smoke test for the deterministic PDF extractor. Uses one known-good CV from
// the local validation dataset; skips (does not fail) when the dataset is not
// present so `npm test` stays green in environments without the fixtures.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { extractPdfText } = require('./pdfExtractor');

const DATASET_DIR = process.env.CV_DATASET_DIR
  || "/Users/jasperjoy/Desktop/claude folder/test cv's";
const SAMPLE = path.join(DATASET_DIR, 'cv_02.pdf');

test('extractPdfText: non-empty text and stable hash across two calls', async (t) => {
  if (!fs.existsSync(SAMPLE)) {
    t.skip('CV dataset not available (set CV_DATASET_DIR)');
    return;
  }
  const buffer = fs.readFileSync(SAMPLE);
  const a = await extractPdfText(buffer);
  const b = await extractPdfText(buffer);

  assert.ok(a.text.length > 100, 'extracted text should be non-trivial');
  assert.strictEqual(a.sha256, b.sha256, 'same bytes must produce the same hash');
  assert.strictEqual(a.text, b.text, 'same bytes must produce the same text');
  assert.match(a.sha256, /^[a-f0-9]{64}$/);
  assert.strictEqual(a.meta.engine, 'pdfjs-dist');
  assert.ok(a.meta.engineVersion, 'engine version recorded');
  assert.ok(a.meta.assemblerVersion, 'assembler version recorded');
  assert.strictEqual(a.meta.perPageChars.length, a.meta.pages);
});
