'use strict';

// Gate A: isolated repro of the suspected pdf-parse cross-document leak.
// Uses the devDependency pdf-parse@1.1.4 (the engine being replaced).
//
// Run each mode in a FRESH process:
//   node scripts/repro-leak.js alone            # cv_15 only — expect throw
//   node scripts/repro-leak.js sequence         # cv_14 then cv_15, one attempt each
//   node scripts/repro-leak.js sequence-retry   # cv_14 then cv_15 with 3x150ms retry
//
// The production path this mirrors: a batch for...of loop parsing files
// sequentially in one process, with (historically) a 3-attempt retry.

const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');

// pdf-parse's bundled pdf.js (v1.10, 2017) can throw from internal timer
// callbacks, escaping try/catch entirely. Record those so the repro can
// distinguish "rejected promise" from "process-killing uncaught throw".
process.on('uncaughtException', (e) => {
  console.log(`UNCAUGHT EXCEPTION (escaped try/catch): "${e && e.message}"`);
  process.exit(3);
});
process.on('unhandledRejection', (e) => {
  console.log(`UNHANDLED REJECTION (escaped await): "${e && e.message}"`);
  process.exit(4);
});

const DATASET_DIR = process.env.CV_DATASET_DIR
  || "/Users/jasperjoy/Desktop/claude folder/test cv's";
const CV14 = path.join(DATASET_DIR, 'cv_14.pdf');
const CV15 = path.join(DATASET_DIR, 'cv_15.pdf');

const head = (t) => JSON.stringify(t.trim().slice(0, 60));

async function parseOnce(file) {
  const d = await pdfParse(fs.readFileSync(file));
  return (d.text || '').trim();
}

async function parseWithRetry(file, attempts) {
  let lastErr;
  for (let a = 1; a <= attempts; a++) {
    try {
      return await parseOnce(file);
    } catch (e) {
      lastErr = e;
      console.log(`  cv_15 attempt ${a}/${attempts} threw: ${e.message}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  throw lastErr;
}

(async () => {
  const mode = process.argv[2];
  if (mode === 'alone') {
    console.log('MODE alone: parsing cv_15 in a fresh process, no prior parse');
    try {
      const t = await parseOnce(CV15);
      console.log(`cv_15: OK chars=${t.length} head=${head(t)}`);
    } catch (e) {
      console.log(`cv_15: THREW "${e.message}"`);
    }
    return;
  }

  if (mode === 'sequence' || mode === 'sequence-retry') {
    console.log(`MODE ${mode}: cv_14 first, then cv_15, same process`);
    const t14 = await parseOnce(CV14);
    console.log(`cv_14: OK chars=${t14.length} head=${head(t14)}`);
    try {
      const t15 = mode === 'sequence-retry'
        ? await parseWithRetry(CV15, 3)
        : await parseOnce(CV15);
      console.log(`cv_15: OK chars=${t15.length} head=${head(t15)}`);
      console.log(`cv_15 head === cv_14 head: ${t15.slice(0, 60) === t14.slice(0, 60)}`);
      console.log(`cv_15 full text === cv_14 full text: ${t15 === t14}`);
    } catch (e) {
      console.log(`cv_15: THREW "${e.message}" (no leak in this mode)`);
    }
    return;
  }

  if (mode === 'chain') {
    // Generic sequence: parse the listed files in order with the OLD engine
    // (one attempt each), then print the NEW engine's ground-truth head for
    // every file so leaked text can be attributed.
    const names = process.argv.slice(3);
    console.log('MODE chain:', names.join(' -> '));
    const oldHeads = {};
    for (const name of names) {
      try {
        const t = await parseOnce(path.join(DATASET_DIR, name));
        oldHeads[name] = t.slice(0, 60);
        console.log(`old ${name}: OK chars=${t.length} head=${head(t)}`);
      } catch (e) {
        console.log(`old ${name}: THREW "${e.message}"`);
      }
    }
    const { extractPdfText } = require('../src/services/pdfExtractor.js');
    console.log('--- ground truth (new engine) ---');
    for (const name of names) {
      const r = await extractPdfText(fs.readFileSync(path.join(DATASET_DIR, name)));
      console.log(`new ${name}: chars=${r.meta.chars} head=${JSON.stringify(r.text.slice(0, 60))}`);
    }
    return;
  }

  if (mode === 'full-sequence') {
    // Replicates the extraction-diff.mjs call pattern that produced the leak:
    // for cv_01..cv_15 in sorted order, a 3-attempt extract plus 5 single
    // stability parses per file. Prints cv_15's old-engine output head against
    // the new engine's ground truth for cv_14 and cv_15.
    const files = fs.readdirSync(DATASET_DIR).filter((f) => f.endsWith('.pdf')).sort()
      .filter((f) => f <= 'cv_15.pdf');
    let last = null;
    for (const name of files) {
      const file = path.join(DATASET_DIR, name);
      let out = null;
      for (let a = 1; a <= 3; a++) {
        try { out = await parseOnce(file); break; }
        catch (e) { await new Promise((r) => setTimeout(r, 150)); }
      }
      for (let i = 0; i < 5; i++) {
        try { await parseOnce(file); } catch (_) { /* stability probe */ }
      }
      last = { name, out };
      console.log(`old ${name}: ${out === null ? 'THREW all attempts' : 'OK chars=' + out.length}`);
    }
    const { extractPdfText } = require('../src/services/pdfExtractor.js');
    const truth14 = await extractPdfText(fs.readFileSync(path.join(DATASET_DIR, 'cv_14.pdf')));
    const truth15 = await extractPdfText(fs.readFileSync(path.join(DATASET_DIR, 'cv_15.pdf')));
    console.log('--- verdict ---');
    if (last && last.out !== null) {
      console.log(`old cv_15 head: ${head(last.out)}`);
      console.log(`matches cv_14 ground truth: ${last.out.slice(0, 60) === truth14.text.slice(0, 60)}`);
      console.log(`matches cv_15 ground truth: ${last.out.slice(0, 60) === truth15.text.slice(0, 60)}`);
    } else {
      console.log('old cv_15 threw in this run (outcome varies run to run).');
    }
    return;
  }

  console.error('Usage: node scripts/repro-leak.js alone|sequence|sequence-retry|chain <files...>|full-sequence');
  process.exit(2);
})().catch((e) => { console.error('HARNESS ERROR:', e && e.message); process.exit(1); });
