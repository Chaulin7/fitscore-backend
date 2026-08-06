#!/usr/bin/env node
'use strict';

/**
 * scripts/stamp-checklist.js — ONE-OFF, THROWAWAY. Delete after use.
 *
 * Stamps the CVsprings brandmark onto page 1 of the EU AI Act checklist PDF.
 *
 * WHY THIS EXISTS, AND ITS ONE FLAW
 * The checklist is a pre-built binary (Producer: ReportLab) whose generating
 * Python script is not in this repo. Stamping the binary is therefore the only
 * way to add the mark today — but it is NOT durable: whoever still holds that
 * ReportLab source will silently overwrite this the next time they regenerate.
 * If you find that script, add the mark there instead and delete this file.
 *
 * pdf-lib IS NOT A DEPENDENCY OF THIS PROJECT and must not become one.
 * It embeds PNG/JPEG only — it does not consume SVG and does not rasterise
 * anything. So the mark must be handed to it as a PNG. Produce one from the
 * canonical public/brandmark.svg (which is #000) like this:
 *
 *   python3 - <<'EOF'
 *   svg = open('public/brandmark.svg').read().replace('#000', '#2440B3')
 *   open('/tmp/mark.html','w').write(
 *     '<html><head><style>html,body{margin:0;background:transparent}'
 *     'svg{display:block;width:512px;height:512px}</style></head><body>'+svg+'</body></html>')
 *   EOF
 *   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless \
 *     --default-background-color=00000000 --window-size=512,512 \
 *     --screenshot=/tmp/brandmark-navy.png file:///tmp/mark.html
 *
 * #2440B3 is the document's own accent (the --stamp token; the "COMPLIANCE
 * CHECKLIST" eyebrow samples as #2a3fac once anti-aliased).
 *
 * RUN — installs pdf-lib transiently, outside this repo, touching neither
 * package.json nor ./node_modules:
 *
 *   mkdir -p /tmp/pdftools && (cd /tmp/pdftools && npm init -y >/dev/null && npm i pdf-lib)
 *   PDF_LIB_PATH=/tmp/pdftools/node_modules/pdf-lib \
 *     node scripts/stamp-checklist.js --mark /tmp/brandmark-navy.png --out /tmp/preview.pdf
 *
 * Omit --out to overwrite assets/CVsprings-EU-AI-Act-checklist.pdf in place.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CHECKLIST = path.join(ROOT, 'assets', 'CVsprings-EU-AI-Act-checklist.pdf');
const DEFAULT_MARK = path.join(ROOT, 'public', 'assets', 'cvsprings-brandmark-navy.png');

// Geometry, in PDF points. Measured off a 1131px-wide render of page 1
// (1.900 px/pt on A4): the header rule and the "2026 EDITION · JULY" line both
// end at x=549pt, and the rule sits 47.4pt from the top. A 28pt mark with its
// right edge on that same 549pt margin and its top at 60pt clears the rule by
// 12.6pt and sits opposite the "COMPLIANCE CHECKLIST" eyebrow. Verified empty:
// zero inked pixels in that box plus 8px of padding.
const MARK_SIZE = 28;
const RIGHT_MARGIN_PT = 549.0;
const TOP_PT = 60.0;

function loadPdfLib() {
  const override = process.env.PDF_LIB_PATH;
  for (const id of [override, 'pdf-lib'].filter(Boolean)) {
    try { return require(id); } catch (_) { /* try next */ }
  }
  console.error(
    'pdf-lib not found. It is deliberately NOT a project dependency.\n' +
    'Install it transiently and point PDF_LIB_PATH at it:\n\n' +
    '  mkdir -p /tmp/pdftools && (cd /tmp/pdftools && npm init -y >/dev/null && npm i pdf-lib)\n' +
    '  PDF_LIB_PATH=/tmp/pdftools/node_modules/pdf-lib node scripts/stamp-checklist.js ...\n'
  );
  process.exit(1);
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : null;
}

(async () => {
  const { PDFDocument } = loadPdfLib();

  const markPath = arg('--mark') || DEFAULT_MARK;
  const outPath = arg('--out') || CHECKLIST;
  const inPlace = outPath === CHECKLIST;

  if (!fs.existsSync(CHECKLIST)) { console.error(`Checklist not found: ${CHECKLIST}`); process.exit(1); }
  if (!fs.existsSync(markPath)) {
    console.error(`Mark PNG not found: ${markPath}\nPass --mark <file.png> (see the header of this script for how to make one).`);
    process.exit(1);
  }

  const srcBytes = fs.readFileSync(CHECKLIST);
  const pdf = await PDFDocument.load(srcBytes);
  const png = await pdf.embedPng(fs.readFileSync(markPath));

  const pages = pdf.getPages();
  const page = pages[0]; // page 1 only, per spec
  const { width, height } = page.getSize();

  const x = RIGHT_MARGIN_PT - MARK_SIZE;
  const y = height - TOP_PT - MARK_SIZE; // pdf-lib origin is bottom-left

  page.drawImage(png, { x, y, width: MARK_SIZE, height: MARK_SIZE });

  const outBytes = await pdf.save();
  fs.writeFileSync(outPath, outBytes);

  console.log(`page size    : ${width.toFixed(2)} x ${height.toFixed(2)} pt (${pages.length} page${pages.length > 1 ? 's' : ''})`);
  console.log(`mark         : ${path.relative(ROOT, markPath)} -> ${png.width}x${png.height} px, drawn at ${MARK_SIZE}pt`);
  console.log(`placed at    : x=${x.toFixed(1)} y=${y.toFixed(1)} (top ${TOP_PT}pt, right edge ${RIGHT_MARGIN_PT}pt)`);
  console.log(`bytes        : ${srcBytes.length} -> ${outBytes.length}`);
  console.log(`${inPlace ? 'OVERWROTE   ' : 'wrote       '}: ${outPath}`);
  if (!inPlace) console.log('\n(preview only — the served file is untouched; omit --out to write in place)');
})().catch((e) => { console.error('stamp failed:', e.message); process.exit(1); });
