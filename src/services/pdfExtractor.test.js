'use strict';

// Smoke + determinism tests for the deterministic PDF extractor, run against
// the committed synthetic fixtures in test/fixtures/ (entirely fictional data).
// The fixtures are frozen binaries checked into the repo, so a missing or empty
// directory is a hard failure — not a skip. CV_DATASET_DIR overrides the
// directory (e.g. a larger private CV set) for local runs.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { extractPdfText } = require('./pdfExtractor');

const FIXTURES_DIR = process.env.CV_DATASET_DIR
  || path.join(__dirname, '..', '..', 'test', 'fixtures');
const files = fs.existsSync(FIXTURES_DIR)
  ? fs.readdirSync(FIXTURES_DIR).filter((f) => f.toLowerCase().endsWith('.pdf')).sort()
  : [];

test('fixtures directory exists and contains at least one PDF', () => {
  assert.ok(fs.existsSync(FIXTURES_DIR), `fixtures directory is missing: ${FIXTURES_DIR}`);
  assert.ok(files.length > 0, `no PDF fixtures found in ${FIXTURES_DIR}`);
});

for (const name of files) {
  test(`extractPdfText(${name}): non-empty, deterministic, well-formed meta`, async () => {
    const buffer = fs.readFileSync(path.join(FIXTURES_DIR, name));
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
}

// Structural check that the assembly layer actually reorders a two-column page.
// cv_two_column.pdf emits its text operators OUT of reading order (right column
// before the left), so a passthrough concatenator would surface the right
// column first. Read by fixed path so a CV_DATASET_DIR override can't retarget
// (or remove) this assertion.
test('two-column layout: left (sidebar) column is assembled before the right (main) column', async () => {
  const twoCol = path.join(__dirname, '..', '..', 'test', 'fixtures', 'cv_two_column.pdf');
  assert.ok(fs.existsSync(twoCol), `missing fixture: ${twoCol}`);
  const { text } = await extractPdfText(fs.readFileSync(twoCol));
  const left = text.indexOf('TECHNICAL SKILLS');
  const right = text.indexOf('PROFESSIONAL EXPERIENCE');
  assert.ok(left !== -1 && right !== -1, 'both column headings should be present');
  assert.ok(left < right, 'the left column must be emitted before the right column');
});
