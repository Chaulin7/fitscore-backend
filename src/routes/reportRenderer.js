'use strict';

/**
 * CVsprings — Candidate Assessment Report renderer
 *
 * Deterministic, template-driven PDF generation. No LLM, no inference.
 * Every line in the output traces directly to a field in the audit record,
 * which in turn traces to a rule that fired in the matcher.
 *
 * Input: a CVsprings audit record (see schema in buildReportDoc docstring).
 * Output: a pdfmake document definition object -> streamed as PDF by the caller.
 */

// pdfmake 0.2.x: the package main export IS the server-side PdfPrinter constructor.
// createPdfKitDocument() returns a synchronous, streamable PDFKit document.
const PdfPrinter = require('pdfmake');
const path = require('path');

// pdfmake 0.2.x ships fonts only as base64 in build/vfs_fonts.js (no raw TTFs).
// Decode them into Buffers so the printer has no filesystem/system-font dependency.
function robotoFonts() {
  const vfs = require('pdfmake/build/vfs_fonts.js');
  const table = vfs.pdfMake ? vfs.pdfMake.vfs : (vfs.vfs || vfs);
  const buf = (name) => Buffer.from(table[name], 'base64');
  return {
    Roboto: {
      normal: buf('Roboto-Regular.ttf'),
      bold: buf('Roboto-Medium.ttf'),
      italics: buf('Roboto-Italic.ttf'),
      bolditalics: buf('Roboto-MediumItalic.ttf'),
    },
  };
}

function makePrinter() {
  return new PdfPrinter(robotoFonts());
}

// ---- palette (kept in sync with CVsprings brand, muted/print-safe) ----
const COLOR = {
  ink: '#1A1A2E',
  muted: '#6B6B7B',
  hair: '#E0E0E6',
  band: '#F4F4F7',
  matched: '#1D7A4D',
  matchedBg: '#EAF5EE',
  gap: '#A32D2D',
  gapBg: '#FBEDED',
  accent: '#3A5BC7',
};

// Resolve org branding for the report, with safe fallbacks. Only a valid
// 6-digit #hex colour is accepted; anything else falls back to the default
// accent. Name falls back to "CVsprings". (Name is rendered as a pdfmake text
// node, which is not HTML — no injection risk from the string.)
const DEFAULT_BRAND = { name: 'CVsprings', color: COLOR.accent };
function resolveReportBranding(branding) {
  const b = branding || {};
  const color = (typeof b.color === 'string' && /^#[0-9A-Fa-f]{6}$/.test(b.color))
    ? b.color : DEFAULT_BRAND.color;
  const name = (typeof b.name === 'string' && b.name.trim())
    ? b.name.trim() : DEFAULT_BRAND.name;
  return { name, color };
}

function band(score) {
  if (score >= 75) return { label: 'Strong match', color: COLOR.matched };
  if (score >= 55) return { label: 'Partial match', color: COLOR.accent };
  return { label: 'Weak match', color: COLOR.gap };
}

function fmtDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-GB', {
      year: 'numeric', month: 'short', day: '2-digit',
      hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
    }) + ' UTC';
  } catch { return String(iso); }
}

/**
 * Normalise the matches array. Accepts either the new evidence-bearing shape
 *   { requirement, matched, evidence, cvLineRef, weight }
 * or falls back to building rows from legacy found/missing string arrays so
 * old audit records still render.
 */
function normaliseMatches(detail) {
  if (Array.isArray(detail.matches) && detail.matches.length) {
    return detail.matches.map((m) => ({
      requirement: String(m.requirement ?? ''),
      matched: !!m.matched,
      evidence: m.evidence ? String(m.evidence) : null,
      cvLineRef: Number.isFinite(m.cvLineRef) ? m.cvLineRef : null,
      weight: Number.isFinite(m.weight) ? m.weight : null,
    }));
  }
  const found = (detail.found || []).map((r) => ({
    requirement: String(r), matched: true, evidence: null, cvLineRef: null, weight: null,
  }));
  const missing = (detail.missing || []).map((r) => ({
    requirement: String(r), matched: false, evidence: null, cvLineRef: null, weight: null,
  }));
  return [...found, ...missing];
}

function scoreRows(scores) {
  if (!scores || typeof scores !== 'object') return [];
  const labels = {
    keywords: 'Keyword coverage',
    skills: 'Skills match',
    experience: 'Experience',
    education: 'Education',
  };
  return Object.entries(scores).map(([k, v]) => [
    { text: labels[k] || k, style: 'cellLabel' },
    { text: `${Math.round(Number(v))}`, style: 'cellNum', alignment: 'right' },
  ]);
}

/**
 * Build the pdfmake document definition from a CVsprings audit record.
 *
 * Expected audit record shape (canonical input — NOT the raw /api/analyze response):
 * {
 *   id, candidateName, anonymized, overall, scores:{...}, role, decision, note,
 *   appVersion, modelId, analysisTimestamp, weights, jdSnippet, fileName,
 *   analysisDetail: { matches:[...], found:[...], missing:[...], skills:[...], recommendations:[...] }
 * }
 */
function buildReportDoc(audit, branding) {
  const detail = audit.analysisDetail || {};
  const brand = resolveReportBranding(branding);
  const matches = normaliseMatches(detail);
  const overall = Math.round(Number(audit.overall ?? 0));
  const b = band(overall);

  const name = audit.anonymized
    ? (audit.candidateName ? `Candidate ${String(audit.id || '').slice(-6) || '—'}` : 'Anonymised candidate')
    : (audit.candidateName || 'Unnamed candidate');

  const matchedRows = matches.filter((m) => m.matched);
  const gapRows = matches.filter((m) => !m.matched);

  // ---- requirement breakdown table ----
  const reqTableBody = [
    [
      { text: 'Requirement', style: 'th' },
      { text: 'Result', style: 'th' },
      { text: 'Evidence from CV', style: 'th' },
      { text: 'Weight', style: 'th', alignment: 'right' },
    ],
    ...matches.map((m) => ([
      { text: m.requirement, style: 'cell' },
      {
        text: m.matched ? 'Matched' : 'Not found',
        style: 'cell',
        color: m.matched ? COLOR.matched : COLOR.gap,
      },
      m.evidence
        ? {
            stack: [
              { text: m.evidence, style: 'evidence' },
              m.cvLineRef != null ? { text: `CV line ${m.cvLineRef}`, style: 'lineRef' } : null,
            ].filter(Boolean),
          }
        : { text: m.matched ? '—' : 'No matching text in CV', style: 'evidenceMuted' },
      { text: m.weight != null ? m.weight.toFixed(2) : '—', style: 'cell', alignment: 'right' },
    ])),
  ];

  // ---- strengths / gaps (mechanically derived, sorted by weight desc) ----
  const byWeight = (a, c) => (c.weight ?? 0) - (a.weight ?? 0);
  const strengths = matchedRows.slice().sort(byWeight).slice(0, 5);
  const gaps = gapRows.slice().sort(byWeight).slice(0, 5);

  const bulletList = (rows, empty) =>
    rows.length
      ? { ul: rows.map((r) => r.requirement), style: 'bullets' }
      : { text: empty, style: 'evidenceMuted', margin: [0, 2, 0, 0] };

  const doc = {
    pageSize: 'A4',
    pageMargins: [48, 64, 48, 64],
    defaultStyle: { font: 'Roboto', fontSize: 9.5, color: COLOR.ink, lineHeight: 1.25 },

    header: (currentPage) => currentPage === 1 ? null : ({
      margin: [48, 24, 48, 0],
      columns: [
        { text: 'CVsprings — Candidate Assessment Report', style: 'runHead' },
        { text: name, style: 'runHead', alignment: 'right' },
      ],
    }),

    footer: (currentPage, pageCount) => ({
      margin: [48, 0, 48, 24],
      columns: [
        { text: `Report ID: ${audit.id || '—'}`, style: 'foot' },
        { text: `Page ${currentPage} of ${pageCount}`, style: 'foot', alignment: 'right' },
      ],
    }),

    content: [
      // ---- title block ----
      {
        columns: [
          {
            width: '*',
            stack: [
              { text: `${brand.name} — Candidate Assessment Report`, style: 'h1' },
              { text: name, style: 'subject', color: brand.color },
              {
                text: [
                  { text: 'Role: ', style: 'metaKey' },
                  { text: audit.role || '—', style: 'metaVal' },
                ],
              },
            ],
          },
          {
            width: 'auto',
            stack: [
              { text: `${overall}`, style: 'bigScore', color: b.color },
              { text: '/ 100', style: 'scoreDenom' },
              { text: b.label, style: 'bandLabel', color: b.color },
            ],
            alignment: 'right',
          },
        ],
      },
      { canvas: [{ type: 'line', x1: 0, y1: 6, x2: 499, y2: 6, lineWidth: 0.7, lineColor: COLOR.hair }], margin: [0, 8, 0, 12] },

      // ---- advisory framing (compliance-critical wording) ----
      {
        table: {
          widths: ['*'],
          body: [[{
            text: 'This report is a requirement-matching aid for human reviewers. It does not constitute an automated decision. All hiring decisions remain with the human reviewer.',
            style: 'advisory',
            fillColor: COLOR.band,
            margin: [10, 8, 10, 8],
          }]],
        },
        layout: 'noBorders',
        margin: [0, 0, 0, 14],
      },

      // ---- score composition ----
      { text: 'Score composition', style: 'h2' },
      {
        columns: [
          {
            width: '60%',
            table: { widths: ['*', 'auto'], body: scoreRows(audit.scores) },
            layout: lightRowLayout(),
          },
          {
            width: '*',
            stack: [
              { text: 'Overall', style: 'metaKey', margin: [12, 2, 0, 0] },
              { text: `${overall} / 100`, style: 'metaVal', margin: [12, 0, 0, 0] },
            ],
          },
        ],
        margin: [0, 4, 0, 14],
      },

      // ---- requirement-by-requirement breakdown ----
      { text: 'Requirement breakdown', style: 'h2' },
      {
        text: `${matchedRows.length} of ${matches.length} requirements matched.`,
        style: 'metaVal', margin: [0, 0, 0, 6],
      },
      {
        table: { headerRows: 1, widths: ['28%', 'auto', '*', 'auto'], body: reqTableBody },
        layout: reqTableLayout(),
        margin: [0, 0, 0, 14],
      },

      // ---- strengths & gaps ----
      {
        columns: [
          {
            width: '50%',
            stack: [
              { text: 'Strengths', style: 'h3', color: COLOR.matched },
              bulletList(strengths, 'No matched requirements.'),
            ],
          },
          {
            width: '50%',
            stack: [
              { text: 'Gaps', style: 'h3', color: COLOR.gap },
              bulletList(gaps, 'No unmet requirements.'),
            ],
          },
        ],
        columnGap: 18,
        margin: [0, 0, 0, 16],
      },

      // ---- methodology / compliance footer block ----
      { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 499, y2: 0, lineWidth: 0.7, lineColor: COLOR.hair }], margin: [0, 4, 0, 8] },
      { text: 'Methodology & compliance', style: 'h3' },
      {
        ul: [
          'Scoring performed by a deterministic, rule-based matching engine — not a machine-learning model.',
          'No CV content is sent to any third-party AI service. No AI subprocessor is involved.',
          'Output is advisory and supports human review; CVsprings does not make automated decisions.',
          'Results are fully reproducible: the same CV and job description always produce the same report.',
          'Bias auditing follows the documented CVsprings methodology (conservative statistical testing, observational language).',
        ],
        style: 'methodology',
      },
      {
        text: [
          { text: 'Engine: ', style: 'metaKey' }, { text: `${audit.modelId || 'cvsprings-matcher'}`, style: 'foot' },
          { text: '   ·   App: ', style: 'metaKey' }, { text: `${audit.appVersion || '—'}`, style: 'foot' },
          { text: '   ·   Assessed: ', style: 'metaKey' }, { text: fmtDate(audit.analysisTimestamp), style: 'foot' },
        ],
        margin: [0, 8, 0, 0],
      },
    ].filter(Boolean),

    styles: {
      h1: { fontSize: 18, bold: true, color: COLOR.ink },
      h2: { fontSize: 12, bold: true, color: COLOR.ink, margin: [0, 4, 0, 4] },
      h3: { fontSize: 10.5, bold: true, color: COLOR.ink, margin: [0, 0, 0, 4] },
      subject: { fontSize: 12, color: COLOR.accent, margin: [0, 2, 0, 2] },
      bigScore: { fontSize: 34, bold: true },
      scoreDenom: { fontSize: 9, color: COLOR.muted, alignment: 'right' },
      bandLabel: { fontSize: 10, bold: true, alignment: 'right', margin: [0, 2, 0, 0] },
      advisory: { fontSize: 9, italics: true, color: COLOR.muted },
      metaKey: { fontSize: 9, color: COLOR.muted, bold: true },
      metaVal: { fontSize: 9.5, color: COLOR.ink },
      th: { fontSize: 8.5, bold: true, color: '#FFFFFF', fillColor: COLOR.ink, margin: [0, 3, 0, 3] },
      cell: { fontSize: 9, margin: [0, 2, 0, 2] },
      cellLabel: { fontSize: 9.5, color: COLOR.ink, margin: [0, 3, 0, 3] },
      cellNum: { fontSize: 9.5, bold: true, margin: [0, 3, 0, 3] },
      evidence: { fontSize: 8.5, italics: true, color: COLOR.ink },
      evidenceMuted: { fontSize: 8.5, italics: true, color: COLOR.muted },
      lineRef: { fontSize: 7.5, color: COLOR.muted, margin: [0, 1, 0, 0] },
      bullets: { fontSize: 9.5, margin: [0, 2, 0, 0] },
      methodology: { fontSize: 8.5, color: COLOR.muted, lineHeight: 1.3 },
      runHead: { fontSize: 7.5, color: COLOR.muted },
      foot: { fontSize: 7.5, color: COLOR.muted },
    },
  };

  return doc;
}

function lightRowLayout() {
  return {
    hLineWidth: (i, node) => (i === 0 || i === node.table.body.length ? 0 : 0.5),
    vLineWidth: () => 0,
    hLineColor: () => COLOR.hair,
    paddingLeft: () => 0,
    paddingRight: () => 8,
    paddingTop: () => 2,
    paddingBottom: () => 2,
  };
}

function reqTableLayout() {
  return {
    hLineWidth: (i) => (i === 1 ? 0 : 0.5),
    vLineWidth: () => 0,
    hLineColor: () => COLOR.hair,
    fillColor: (rowIndex) => (rowIndex === 0 ? COLOR.ink : (rowIndex % 2 === 0 ? '#FAFAFC' : null)),
    paddingLeft: () => 6,
    paddingRight: () => 6,
    paddingTop: () => 4,
    paddingBottom: () => 4,
  };
}

/**
 * Render a PDF Buffer from an audit record. Returns a Promise<Buffer>.
 * For Express: pipe printer.createPdfKitDocument(...) to res instead, to stream.
 */
function renderReportBuffer(audit, branding) {
  const printer = makePrinter();
  const docDef = buildReportDoc(audit, branding);
  const pdfDoc = printer.createPdfKitDocument(docDef);
  return new Promise((resolve, reject) => {
    const chunks = [];
    pdfDoc.on('data', (c) => chunks.push(c));
    pdfDoc.on('end', () => resolve(Buffer.concat(chunks)));
    pdfDoc.on('error', reject);
    pdfDoc.end();
  });
}

/**
 * Stream a PDF straight to an Express response.
 */
function streamReport(audit, res, filename, branding) {
  const printer = makePrinter();
  const docDef = buildReportDoc(audit, branding);
  const pdfDoc = printer.createPdfKitDocument(docDef);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename || 'cvsprings-report.pdf'}"`);
  pdfDoc.pipe(res);
  pdfDoc.end();
}

module.exports = { buildReportDoc, renderReportBuffer, streamReport, normaliseMatches, band };
