// Golden determinism harness for the PDF extractor.
//
// Runs every PDF in the validation dataset through the extractor N times,
// each run processing the files in a DIFFERENT order (seeded, reproducible
// shuffle). Order-shuffling is the point: it proves there is no cross-file
// state leakage, which was the signature of the original rotating-failure
// bug under pdf-parse.
//
// Usage:
//   node scripts/extraction-golden.mjs --write    # write/update the baseline manifest
//   node scripts/extraction-golden.mjs --verify   # compare against the committed manifest
//
// Dataset dir: $CV_DATASET_DIR (defaults to the local validation set).
// Exit codes: 0 ok; 1 instability or baseline drift; 2 usage/dataset error.

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const { extractPdfText } = require('../src/services/pdfExtractor.js');

const RUNS = 10;
const DATASET_DIR = process.env.CV_DATASET_DIR
  || "/Users/jasperjoy/Desktop/claude folder/test cv's";
const BASELINE_PATH = fileURLToPath(new URL('../test/golden/extraction-baseline.json', import.meta.url));

const mode = process.argv[2];
if (mode !== '--write' && mode !== '--verify') {
  console.error('Usage: node scripts/extraction-golden.mjs --write | --verify');
  process.exit(2);
}
if (!fs.existsSync(DATASET_DIR)) {
  console.error(`Dataset dir not found: ${DATASET_DIR} (set CV_DATASET_DIR)`);
  process.exit(2);
}

// Deterministic PRNG (mulberry32) + Fisher-Yates so each run's order is
// different but the test itself is fully reproducible.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffled(list, seed) {
  const arr = list.slice();
  const rand = mulberry32(seed);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

async function outcomeFor(filePath) {
  const buffer = fs.readFileSync(filePath);
  try {
    const r = await extractPdfText(buffer);
    return { sha256: r.sha256, chars: r.meta.chars, pages: r.meta.pages };
  } catch (e) {
    return { errorCode: e.code || 'UNKNOWN' };
  }
}

const files = fs.readdirSync(DATASET_DIR).filter((f) => f.toLowerCase().endsWith('.pdf')).sort();
if (!files.length) {
  console.error(`No PDFs found in ${DATASET_DIR}`);
  process.exit(2);
}
console.log(`${files.length} PDFs, ${RUNS} shuffled runs (${files.length * RUNS} extractions)…`);

const perRun = []; // run -> { filename -> outcome }
for (let run = 0; run < RUNS; run++) {
  const order = shuffled(files, run + 1);
  const outcomes = {};
  for (const f of order) {
    outcomes[f] = await outcomeFor(path.join(DATASET_DIR, f));
  }
  perRun.push(outcomes);
  process.stdout.write(`run ${run + 1}/${RUNS} done\n`);
}

// Stability check: every run must agree per file.
let unstable = 0;
const manifest = {};
for (const f of files) {
  const first = JSON.stringify(perRun[0][f]);
  const disagree = perRun.findIndex((r) => JSON.stringify(r[f]) !== first);
  if (disagree !== -1) {
    unstable++;
    console.error(`UNSTABLE: ${f} — run 1 ${first} vs run ${disagree + 1} ${JSON.stringify(perRun[disagree][f])}`);
  }
  manifest[f] = perRun[0][f];
}
const ok = files.length - unstable;
console.log(`\nstability: ${ok}/${files.length} files identical across all ${RUNS} runs`);
const successes = files.filter((f) => manifest[f].sha256).length;
console.log(`outcomes: ${successes} success, ${files.length - successes} typed error`);
if (unstable > 0) process.exit(1);

if (mode === '--write') {
  fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`baseline written: ${path.relative(process.cwd(), BASELINE_PATH)}`);
} else {
  if (!fs.existsSync(BASELINE_PATH)) {
    console.error('No committed baseline found — run extraction:baseline first.');
    process.exit(2);
  }
  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  let drift = 0;
  for (const f of new Set([...Object.keys(baseline), ...files])) {
    const a = JSON.stringify(baseline[f] || null);
    const b = JSON.stringify(manifest[f] || null);
    if (a !== b) { drift++; console.error(`DRIFT: ${f} — baseline ${a} vs current ${b}`); }
  }
  if (drift > 0) { console.error(`\n${drift} file(s) drifted from baseline`); process.exit(1); }
  console.log('baseline verify: no drift ✓');
}
