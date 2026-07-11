'use strict';

/**
 * src/services/pdfExtractor.js
 *
 * Deterministic PDF text extraction: exact-pinned pdfjs-dist plus a text
 * assembly layer we own. Contract:
 *
 *   extractPdfText(buffer) -> Promise<{ text, sha256, meta }>
 *     - pure function of the input bytes (plus the pinned engine): same
 *       buffer always produces the same canonical text and the same SHA-256
 *     - throws Error with { statusCode, code } on failure (repo convention;
 *       original engine error preserved on .cause)
 *
 * Determinism rules for this file: no Math.random, no Date/time, no locale
 * APIs; every sort has an explicit total order ending in a tie-breaker on
 * the original item index; every threshold is a named constant below.
 *
 * Reading-order handling: pages are assembled top-to-bottom (PDF y-axis
 * points UP, so descending y). If a page has a clear vertical gutter, it is
 * treated as two columns (max two) and the left column is emitted in full
 * before the right — this keeps sentence-anchored evidence snippets from
 * interleaving across a skills sidebar and a main experience column.
 */

const crypto = require('crypto');
const path = require('path');
const fileSec = require('./fileSecurity');

// --- Constants: every threshold lives here -----------------------------------
const EXTRACTOR_VERSION     = '1.0.0'; // bump on ANY assembly-algorithm change
const MAX_PDF_BYTES         = 15 * 1024 * 1024; // bytes; pre-parse guard
const MAX_PAGES             = 30;     // pages; post-load guard
const MIN_TEXT_CHARS        = 100;    // chars; below this => image-only/scanned PDF
const LINE_TOLERANCE_MIN    = 2.0;    // pt; floor for same-line y tolerance
const LINE_TOLERANCE_FACTOR = 0.4;    // x median item height on the page
const CHAR_JOIN_GAP         = 1.0;    // pt; horizontal gaps <= this join without a space
const GUTTER_MIN_WIDTH      = 18;     // pt; minimum two-column gutter width
const GUTTER_SEARCH_MIN     = 0.25;   // gutter must sit between 25% and 75% of page width
const GUTTER_SEARCH_MAX     = 0.75;
const COLUMN_MIN_COVERAGE   = 0.6;    // gutter clear over >= this fraction of text height
const COLUMN_MIN_SIDE_SHARE = 0.2;    // each column must hold >= 20% of the page's items
const MIN_ITEMS_FOR_COLUMNS = 8;      // fewer items than this: never split columns
const SAFETY_TIMEOUT_MS     = 60000;  // ms; DoS circuit breaker, not flow control

// pdfjs-dist v4+ is ESM-only; this backend is CommonJS. Load the legacy Node
// build via a dynamic import, memoized so the cost is paid once per process.
let _pdfjsPromise = null;
function loadPdfjs() {
  if (!_pdfjsPromise) _pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  return _pdfjsPromise;
}

// Filesystem paths into the pinned package for CJK cmaps and the standard 14
// fonts, so extraction never depends on system fonts (macOS dev vs Render).
const PDFJS_DIR = path.dirname(require.resolve('pdfjs-dist/package.json'));
const CMAP_DIR = path.join(PDFJS_DIR, 'cmaps') + path.sep;
const STANDARD_FONT_DIR = path.join(PDFJS_DIR, 'standard_fonts') + path.sep;
const PDFJS_VERSION = require('pdfjs-dist/package.json').version;

// Repo error convention: plain Error carrying { statusCode, code }, original
// engine error on .cause. Codes reuse the existing taxonomy (INVALID_FILE,
// UNPROCESSABLE_FILE, IMAGE_ONLY_PDF, PROCESSING_TIMEOUT); PDF_ENCRYPTED is
// the only genuinely new code.
function extractionError(message, code, statusCode, cause) {
  const e = Object.assign(new Error(message), { statusCode, code });
  if (cause !== undefined) e.cause = cause;
  return e;
}

// --- Assembly helpers (pure functions of item geometry) ----------------------

// Total length covered by a set of [start, end] spans (union of intervals).
function unionLength(spans) {
  if (!spans.length) return 0;
  spans.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  let total = 0;
  let [curStart, curEnd] = spans[0];
  for (let i = 1; i < spans.length; i++) {
    const [s, e] = spans[i];
    if (s > curEnd) { total += curEnd - curStart; curStart = s; curEnd = e; }
    else if (e > curEnd) { curEnd = e; }
  }
  total += curEnd - curStart;
  return total;
}

// Detect a two-column layout. Returns the gutter center x, or null for a
// single flow. Threshold-driven scan over integer x positions: a position is
// "clear" when items crossing it cover <= (1 - COLUMN_MIN_COVERAGE) of the
// page's text height (so a full-width header doesn't defeat detection). The
// widest clear run >= GUTTER_MIN_WIDTH wins; ties go to the leftmost run.
function detectGutterCenter(items, pageWidth) {
  if (items.length < MIN_ITEMS_FOR_COLUMNS) return null;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const it of items) {
    if (it.y < minY) minY = it.y;
    if (it.y + it.h > maxY) maxY = it.y + it.h;
  }
  const textHeight = maxY - minY;
  if (!(textHeight > 0)) return null;

  const lo = Math.ceil(pageWidth * GUTTER_SEARCH_MIN);
  const hi = Math.floor(pageWidth * GUTTER_SEARCH_MAX);
  const maxCoveredFraction = 1 - COLUMN_MIN_COVERAGE;

  let bestStart = -1;
  let bestLen = 0;
  let runStart = -1;
  let runLen = 0;
  for (let x = lo; x <= hi + 1; x++) {
    let clear = false;
    if (x <= hi) {
      const spans = [];
      for (const it of items) {
        if (it.x < x && it.x + it.w > x) spans.push([it.y, it.y + it.h]);
      }
      clear = unionLength(spans) / textHeight <= maxCoveredFraction;
    }
    if (clear) {
      if (runLen === 0) runStart = x;
      runLen++;
    } else {
      if (runLen > bestLen) { bestLen = runLen; bestStart = runStart; } // strict >: leftmost wins ties
      runLen = 0;
    }
  }
  if (bestLen < GUTTER_MIN_WIDTH) return null;

  const center = bestStart + Math.floor(bestLen / 2);
  let left = 0;
  for (const it of items) {
    if (it.x + it.w / 2 < center) left++;
  }
  const right = items.length - left;
  const minSide = items.length * COLUMN_MIN_SIDE_SHARE;
  if (left < minSide || right < minSide) return null;
  return center;
}

// Group one flow's items into lines. Same line: y within tolerance of the
// line's first (representative) item. Lines ordered by descending y (top to
// bottom); items within a line by ascending x. All comparators end with the
// original item index so ordering never relies on sort stability.
function bandIntoLines(flowItems, tolerance) {
  const items = flowItems.slice().sort((a, b) => (b.y - a.y) || (a.x - b.x) || (a.idx - b.idx));
  const lines = [];
  let current = null;
  let repY = 0;
  for (const it of items) {
    if (!current || repY - it.y > tolerance) {
      current = [it];
      repY = it.y;
      lines.push(current);
    } else {
      current.push(it);
    }
  }
  return lines.map((line) => line.slice().sort((a, b) => (a.x - b.x) || (a.idx - b.idx)));
}

// Join one line's items. pdf.js frequently splits items mid-word; gluing
// wrongly with spaces breaks Dutch/German compound keywords, so gaps <=
// CHAR_JOIN_GAP (or a zero-width previous item) concatenate directly.
function joinLineItems(line) {
  let out = '';
  let prev = null;
  for (const it of line) {
    if (prev === null) {
      out = it.str;
    } else {
      const gap = it.x - (prev.x + prev.w);
      out += (gap <= CHAR_JOIN_GAP || prev.w === 0) ? it.str : ' ' + it.str;
    }
    prev = it;
  }
  return out;
}

// Assemble one page's items into text. Pure function of coordinates.
function assemblePage(items, pageWidth) {
  if (!items.length) return '';

  // Line tolerance from the page's median item height (lower-middle for even
  // counts — a defined, deterministic choice).
  const heights = items.map((it) => it.h).filter((h) => h > 0).sort((a, b) => a - b);
  const median = heights.length ? heights[Math.floor((heights.length - 1) / 2)] : 0;
  const tolerance = Math.max(LINE_TOLERANCE_MIN, LINE_TOLERANCE_FACTOR * median);

  const gutter = detectGutterCenter(items, pageWidth);
  let flows;
  if (gutter === null) {
    flows = [items];
  } else {
    const left = [];
    const right = [];
    for (const it of items) {
      (it.x + it.w / 2 < gutter ? left : right).push(it);
    }
    flows = [left, right]; // left column in full, then right
  }

  const lineTexts = [];
  for (const flow of flows) {
    for (const line of bandIntoLines(flow, tolerance)) {
      lineTexts.push(joinLineItems(line));
    }
  }
  return lineTexts.join('\n');
}

// Canonical normalization. Applied per page so per-page char counts are
// meaningful; pages join with a blank line. Case is preserved — lowercasing
// belongs to the matcher, not the extractor.
function normalizePage(pageText) {
  return pageText
    .split('\n')
    .map((line) => line
      .replace(/\t/g, ' ')
      .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, ' ') // Unicode space variants -> U+0020
      .replace(/\u00AD/g, '')                            // soft hyphens
      .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '') // control chars except newline (already split)
      .replace(/ {2,}/g, ' ')
      .trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// --- Main ---------------------------------------------------------------------

async function extractPdfTextInner(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw extractionError('Expected a PDF file buffer.', 'INVALID_FILE', 400);
  }
  // Pre-parse guard: rejects the same file the same way on every run.
  if (buffer.length > MAX_PDF_BYTES) {
    throw extractionError(
      `PDF is too large to process (max ${Math.round(MAX_PDF_BYTES / (1024 * 1024))} MB).`,
      'INVALID_FILE', 400
    );
  }

  const pdfjs = await loadPdfjs();
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buffer),     // copy — pdf.js may transfer/detach its input
    isEvalSupported: false,           // no eval in font code paths
    useSystemFonts: false,            // environment-independence (macOS dev vs Render)
    disableFontFace: true,
    verbosity: pdfjs.VerbosityLevel.ERRORS,
    cMapUrl: CMAP_DIR,
    cMapPacked: true,
    standardFontDataUrl: STANDARD_FONT_DIR,
  });

  try {
    let doc;
    try {
      doc = await loadingTask.promise;
    } catch (err) {
      // v5 does not export PasswordException; instances still carry .name.
      if (err && err.name === 'PasswordException') {
        throw extractionError(
          'This PDF is password-protected. Remove the password and upload it again.',
          'PDF_ENCRYPTED', 422, err
        );
      }
      throw extractionError(
        'This PDF could not be read — the file may be corrupted or malformed. Try re-saving or re-exporting it, then upload again.',
        'UNPROCESSABLE_FILE', 422, err
      );
    }

    if (doc.numPages > MAX_PAGES) {
      throw extractionError(
        `PDF has too many pages to process (max ${MAX_PAGES}).`,
        'INVALID_FILE', 400
      );
    }

    // Strictly serial page processing: deterministic and memory-friendly for
    // batches on a small instance.
    const pageTexts = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent({
        includeMarkedContent: false,
        // Explicit: pdf.js normalization ON (expands ligatures like fi -> f+i,
        // which helps keyword matching). Either setting is deterministic.
        disableNormalization: false,
      });
      const items = [];
      let idx = 0;
      for (const raw of content.items) {
        if (typeof raw.str !== 'string' || raw.str.length === 0) { idx++; continue; }
        items.push({
          str: raw.str,
          x: raw.transform[4],
          y: raw.transform[5],
          w: raw.width,
          h: raw.height,
          idx: idx++,
        });
      }
      const viewport = page.getViewport({ scale: 1 });
      pageTexts.push(normalizePage(assemblePage(items, viewport.width)));
      if (typeof page.cleanup === 'function') page.cleanup();
    }

    // Final canonical text: pages joined by a blank line, NFC-normalized so
    // composed vs decomposed diacritics (coördinatie, Müller) compare equal.
    const text = pageTexts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim().normalize('NFC');

    if (text.length < MIN_TEXT_CHARS) {
      // Scanned/image PDF: same code and semantics as the previous engine, so
      // existing error routing and frontend copy keep working unchanged.
      throw extractionError(
        'No text could be extracted — this PDF appears to be a scanned image. Upload a text-based PDF or an OCR-processed version.',
        'IMAGE_ONLY_PDF', 422
      );
    }

    let producer = null;
    let creator = null;
    try {
      const md = await doc.getMetadata();
      producer = (md && md.info && md.info.Producer) || null;
      creator = (md && md.info && md.info.Creator) || null;
    } catch (_) { /* metadata is optional */ }

    // Hash covers the canonical text bytes only — never timestamps.
    const sha256 = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
    return {
      text,
      sha256,
      meta: {
        engine: 'pdfjs-dist',
        engineVersion: PDFJS_VERSION,
        assemblerVersion: EXTRACTOR_VERSION,
        pages: doc.numPages,
        chars: text.length,
        perPageChars: pageTexts.map((t) => t.length),
        producer,
        creator,
      },
    };
  } finally {
    // Memory hygiene: always tear down worker/document state.
    try { await loadingTask.destroy(); } catch (_) { /* already destroyed */ }
  }
}

// Circuit breaker: a LIVENESS backstop against pathological/crafted PDFs, not
// flow control. The size/page guards make reaching it effectively impossible
// for real input (measured: 25-CV validation set mean 22.5ms / max 409ms incl.
// first-call engine warmup; a dense 30-page synthetic PDF extracts in ~300ms —
// >100x headroom under the 60s limit). The determinism guarantee holds
// conditional on this never firing for legitimate input: a file that trips it
// is pathological and will trip it every run. Reuses the repo's withTimeout,
// so exhaustion surfaces as the existing PROCESSING_TIMEOUT/422 — and logs
// loudly, because a firing breaker means either an attack or a broken
// environment, never normal operation.
function extractPdfText(buffer) {
  return fileSec.withTimeout(extractPdfTextInner(buffer), SAFETY_TIMEOUT_MS, 'PDF extraction')
    .catch((err) => {
      if (err && err.code === 'PROCESSING_TIMEOUT') {
        console.warn(
          `[pdfExtractor] liveness breaker fired after ${SAFETY_TIMEOUT_MS}ms — pathological input or broken environment`,
          { bytes: Buffer.isBuffer(buffer) ? buffer.length : null }
        );
      }
      throw err;
    });
}

module.exports = {
  extractPdfText,
  EXTRACTOR_VERSION,
  SAFETY_TIMEOUT_MS,
  // exported for tests only
  _internal: { assemblePage, bandIntoLines, joinLineItems, detectGutterCenter, unionLength, normalizePage },
};
