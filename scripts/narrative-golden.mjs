// Golden determinism harness for the narrative layer.
//
// Mirrors scripts/extraction-golden.mjs. The two gates guard different
// properties, so they are separate scripts rather than one:
//
//   extraction:verify  proves the PDF *reader* is stable across file orderings
//   narrative:verify   proves the report *writer* is a pure function of the
//                      stored record — same audit row in, identical bytes out
//
// Each fixture is generated RUNS times consecutively and the serialised
// NarrativeBlock compared byte-for-byte, which catches anything that reaches
// for wall-clock time, Math.random, an environment variable, or an unsorted
// Object.keys()/Set iteration. It then compares against the committed golden,
// so a template edit or a threshold move cannot land silently: it has to be
// re-baselined in the same commit that bumps templateVersion / bandsVersion.
//
// This deliberately asserts on the NarrativeBlock, NOT on PDF bytes.
// buildProvenance() stamps `generated` with the current time, so two PDFs of
// the same record are never byte-identical by design — that is a property of
// the artifact, not a defect, and asserting on it would produce a gate that
// fails every run.
//
// Usage:
//   node scripts/narrative-golden.mjs --write    # write/update the golden
//   node scripts/narrative-golden.mjs --verify   # compare against the golden
//
// Exit codes: 0 ok; 1 instability or drift; 2 usage/fixture error.

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const { generateNarrative } = require('../src/services/narrativeGenerator.js');

const RUNS = 100;
const FIXTURE_DIR = fileURLToPath(new URL('../test/fixtures/narrative', import.meta.url));
const GOLDEN_PATH = fileURLToPath(new URL('../test/golden/narrative-baseline.json', import.meta.url));

const mode = process.argv[2];
if (mode !== '--write' && mode !== '--verify') {
  console.error('Usage: node scripts/narrative-golden.mjs --write | --verify');
  process.exit(2);
}
if (!fs.existsSync(FIXTURE_DIR)) {
  console.error(`Fixture dir not found: ${FIXTURE_DIR}`);
  process.exit(2);
}

// Sorted, so the manifest key order is stable regardless of readdir order.
const fixtures = fs.readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.json')).sort();
if (fixtures.length === 0) {
  console.error(`No .json fixtures in ${FIXTURE_DIR}`);
  process.exit(2);
}

const manifest = {};
let unstable = 0;

for (const file of fixtures) {
  const record = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8'));

  let first = null;
  let disagreedAt = -1;
  for (let run = 0; run < RUNS; run += 1) {
    let serialised;
    try {
      serialised = JSON.stringify(generateNarrative(record, { locale: 'en' }));
    } catch (err) {
      console.error(`ERROR: ${file} — generateNarrative threw: ${err.message}`);
      process.exit(2);
    }
    if (run === 0) first = serialised;
    else if (serialised !== first && disagreedAt < 0) disagreedAt = run;
  }

  if (disagreedAt >= 0) {
    unstable += 1;
    console.error(`UNSTABLE: ${file} — run 1 differs from run ${disagreedAt + 1}`);
  }
  manifest[file] = JSON.parse(first);
  const block = manifest[file];
  console.log(
    `${file.padEnd(34)} band=${block.band.key.padEnd(8)} `
    + `sentences=${block.assessment.length} gaps=${block.gaps.length} `
    + `questions=${block.interviewQuestions.length} weights=${block.weightsSource}`,
  );
}

console.log(`\nstability: ${fixtures.length - unstable}/${fixtures.length} fixtures identical across all ${RUNS} runs`);
if (unstable > 0) process.exit(1);

if (mode === '--write') {
  fs.mkdirSync(path.dirname(GOLDEN_PATH), { recursive: true });
  fs.writeFileSync(GOLDEN_PATH, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`golden written: ${path.relative(process.cwd(), GOLDEN_PATH)}`);
} else {
  if (!fs.existsSync(GOLDEN_PATH)) {
    console.error(`No golden at ${path.relative(process.cwd(), GOLDEN_PATH)} — run narrative:baseline first.`);
    process.exit(2);
  }
  const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));
  let drift = 0;
  for (const key of [...new Set([...Object.keys(golden), ...fixtures])].sort()) {
    const a = JSON.stringify(golden[key] ?? null);
    const b = JSON.stringify(manifest[key] ?? null);
    if (a !== b) {
      drift += 1;
      console.error(`DRIFT: ${key}\n  golden : ${a}\n  current: ${b}`);
    }
  }
  if (drift > 0) {
    console.error(`\n${drift} fixture(s) drifted from the golden.`);
    console.error('If this was intentional: bump templateVersion / bandsVersion / narrativeVersion and re-run narrative:baseline in the SAME commit.');
    process.exit(1);
  }
  console.log('golden verify: no drift ✓');
}
