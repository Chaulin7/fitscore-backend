// Old-vs-new extraction diff: pdf-parse 1.1.4 (devDependency, the engine
// being replaced) against the pdfjs-dist extractor, over the full validation
// dataset. Writes EXTRACTION_DIFF.md at the repo root.
//
// To re-run after pdf-parse is dropped from devDependencies:
//   npm install --save-dev --save-exact pdf-parse@1.1.4 && node scripts/extraction-diff.mjs
//
// The old engine is given 3 attempts per file (matching the retry loop the
// production code used to carry) because it fails non-deterministically.

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const { extractPdfText } = require('../src/services/pdfExtractor.js');
const pdfParse = require('pdf-parse');
const { scoreCV } = require('../src/services/scorer.js');
const { SAMPLE_JD } = require('../src/data/sample.js');

const DATASET_DIR = process.env.CV_DATASET_DIR
  || "/Users/jasperjoy/Desktop/claude folder/test cv's";
const OUT = fileURLToPath(new URL('../EXTRACTION_DIFF.md', import.meta.url));
const WEIGHTS = { kw: 40, sk: 30, ex: 20, ed: 10 }; // production defaults
const OLD_ATTEMPTS = 3;

// Files from the known rotating-failure set under pdf-parse (recon +
// empirical probes): cv_01 failed transiently (recovered on retry); cv_11 and
// cv_24 failed every attempt in production logs; cv_15 fails every attempt in
// a FRESH process but "succeeds" mid-batch with another file's text (see the
// cross-file leakage check below).
const KNOWN_FLAKY = ['cv_01.pdf', 'cv_11.pdf', 'cv_15.pdf', 'cv_24.pdf'];

async function oldExtract(buffer) {
  let lastErr = null;
  for (let a = 1; a <= OLD_ATTEMPTS; a++) {
    try {
      const d = await pdfParse(buffer);
      const text = (d.text || '').trim();
      if (!text) return { error: 'IMAGE_ONLY_PDF' };
      return { text };
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  return { error: 'UNPROCESSABLE_FILE', detail: String(lastErr && lastErr.message) };
}

async function newExtract(buffer) {
  try {
    const r = await extractPdfText(buffer);
    return { text: r.text, sha256: r.sha256 };
  } catch (e) {
    return { error: e.code || 'UNKNOWN' };
  }
}

// Empirical instability probe for the OLD engine: run pdf-parse N times on
// the same bytes (no retries) and count distinct outcomes. >1 distinct
// outcome on identical input is the rotating-failure bug, observed directly.
const STABILITY_RUNS = 5;
async function oldStability(buffer) {
  const crypto = require('crypto');
  const outcomes = new Set();
  for (let i = 0; i < STABILITY_RUNS; i++) {
    try {
      const d = await pdfParse(buffer);
      outcomes.add('sha:' + crypto.createHash('sha256').update((d.text || '').trim(), 'utf8').digest('hex').slice(0, 12));
    } catch (e) {
      outcomes.add('error:' + String(e && e.message).slice(0, 40));
    }
  }
  return [...outcomes].sort();
}

const tokenize = (t) => new Set((t.toLowerCase().match(/[a-z0-9]+/g)) || []);
function jaccard(a, b) {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}
function firstDivergence(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  if (i === n && a.length === b.length) return null;
  const ctx = (s) => JSON.stringify(s.slice(Math.max(0, i - 60), i + 60));
  return { index: i, old: ctx(a), new: ctx(b) };
}

const files = fs.readdirSync(DATASET_DIR).filter((f) => f.toLowerCase().endsWith('.pdf')).sort();
const rows = [];
for (const f of files) {
  const buffer = fs.readFileSync(path.join(DATASET_DIR, f));
  const oldR = await oldExtract(buffer);
  const newR = await newExtract(buffer);
  const row = { file: f, old: oldR, new: newR, oldOutcomes: await oldStability(buffer) };
  if (oldR.text && newR.text) {
    row.jaccard = jaccard(tokenize(oldR.text), tokenize(newR.text));
    row.divergence = firstDivergence(oldR.text, newR.text);
    const so = scoreCV(oldR.text, SAMPLE_JD, WEIGHTS);
    const sn = scoreCV(newR.text, SAMPLE_JD, WEIGHTS);
    row.scoreOld = so.overall;
    row.scoreNew = sn.overall;
    const setO = new Set(so.skills.filter((s) => s.found).map((s) => s.name));
    const setN = new Set(sn.skills.filter((s) => s.found).map((s) => s.name));
    row.skillsGained = [...setN].filter((s) => !setO.has(s));
    row.skillsLost = [...setO].filter((s) => !setN.has(s));
  }
  rows.push(row);
  process.stdout.write('.');
}
console.log('');

const fmtOutcome = (r) => r.text ? `OK (${r.text.length} chars)` : `ERROR ${r.error}`;
let md = `# EXTRACTION_DIFF — pdf-parse 1.1.4 → pdfjs-dist ${require('pdfjs-dist/package.json').version}\n\n`;
md += `Dataset: ${files.length} PDFs. Old engine given ${OLD_ATTEMPTS} attempts/file (mirrors the removed retry loop). `;
md += `Scores computed with the production scorer against the built-in sample JD, default weights ${JSON.stringify(WEIGHTS)} — a synthetic but stable comparison basis.\n\n`;

md += `## Old-engine instability, observed directly\n\n`;
md += `Each file was run through pdf-parse ${STABILITY_RUNS}x on identical bytes (no retries). `;
md += `More than one distinct outcome = the rotating-failure bug:\n\n`;
const unstableRows = rows.filter((r) => r.oldOutcomes.length > 1);
if (unstableRows.length) {
  for (const r of unstableRows) {
    md += `- **${r.file}**: ${r.oldOutcomes.length} distinct outcomes → ${r.oldOutcomes.join(' · ')}\n`;
  }
} else {
  md += `None observed in this run (instability is probabilistic; see recon history).\n`;
}
md += `\nThe new engine's golden harness (10 shuffled runs) shows one outcome per file, every run.\n`;

md += `\n## Known rotating-failure files (the original bug)\n\n`;
for (const f of KNOWN_FLAKY) {
  const r = rows.find((x) => x.file === f);
  if (r) md += `- **${f}** — old: ${fmtOutcome(r.old)} · new: ${fmtOutcome(r.new)}\n`;
}
md += `\n## Per-file comparison\n\n`;
md += `| file | old outcome | new outcome | Jaccard | score old→new |\n|---|---|---|---|---|\n`;
for (const r of rows) {
  const j = r.jaccard != null ? r.jaccard.toFixed(3) : '—';
  const s = r.scoreOld != null ? `${r.scoreOld} → ${r.scoreNew}${r.scoreOld !== r.scoreNew ? ' ⚠' : ''}` : '—';
  md += `| ${r.file} | ${fmtOutcome(r.old)} | ${fmtOutcome(r.new)} | ${j} | ${s} |\n`;
}

md += `\n## Cross-file leakage check (old engine)\n\n`;
md += `For every heavily-diverging file (Jaccard < 0.5), the OLD engine's output is compared `;
md += `against the NEW engine's output for every OTHER file in the dataset. A near-perfect `;
md += `match means pdf-parse emitted a different document's text — cross-file state leakage:\n\n`;
let anyLeak = false;
for (const r of rows) {
  if (r.jaccard != null && r.jaccard < 0.5 && r.old.text) {
    const oldTokens = tokenize(r.old.text);
    let best = null;
    for (const other of rows) {
      if (other.file === r.file || !other.new.text) continue;
      const j = jaccard(oldTokens, tokenize(other.new.text));
      if (!best || j > best.j) best = { file: other.file, j };
    }
    if (best && best.j > 0.95) {
      anyLeak = true;
      md += `- **${r.file}**: old output matches **${best.file}**'s content (Jaccard ${best.j.toFixed(3)}) — `;
      md += `pdf-parse returned the wrong document's text for this file in this run.\n`;
    } else if (best) {
      md += `- **${r.file}**: old output matches no other file (best: ${best.file} at ${best.j.toFixed(3)}) — divergence is content-level, not leakage.\n`;
    }
  }
}
if (!anyLeak) md += `No leakage detected among diverging files in this run.\n`;

md += `\n## Skill-match set changes (sample JD)\n\n`;
let anySkill = false;
for (const r of rows) {
  if ((r.skillsGained && r.skillsGained.length) || (r.skillsLost && r.skillsLost.length)) {
    anySkill = true;
    md += `- **${r.file}**: gained [${r.skillsGained.join(', ')}] · lost [${r.skillsLost.join(', ')}]\n`;
  }
}
if (!anySkill) md += `None — matched skill sets identical on every comparable file.\n`;

md += `\n## First divergence snippets (assembly-order differences are expected)\n\n`;
for (const r of rows) {
  if (r.divergence) {
    md += `### ${r.file} (char ${r.divergence.index})\n- old: ${r.divergence.old}\n- new: ${r.divergence.new}\n\n`;
  }
}

fs.writeFileSync(OUT, md);
console.log(`written: ${path.relative(process.cwd(), OUT)}`);

// Console summary
const oldOk = rows.filter((r) => r.old.text).length;
const newOk = rows.filter((r) => r.new.text).length;
const scored = rows.filter((r) => r.scoreOld != null);
const same = scored.filter((r) => r.scoreOld === r.scoreNew).length;
console.log(`old engine: ${oldOk}/${files.length} ok · new engine: ${newOk}/${files.length} ok`);
console.log(`scores: ${same}/${scored.length} identical on comparable files`);
