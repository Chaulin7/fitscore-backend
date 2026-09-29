'use strict';

// Read-only scan: does stored data hold CVs that FAILED in a batch but were
// recorded as if scored?
//
// How such a row could exist. A batch file that fails validation or extraction
// comes back from /api/analyze/batch with an `error` and no score. Before field
// binding (beb89a7), the app saved batch rows by sending the result's own
// fields, so "Save all" on a batch with a failed file posted overall/scores as
// undefined — which better-sqlite3 stores as NULL — and the app then showed
// that NULL as a score of 0 (`rec.overall || 0`) in the audit log, the role
// history and its averages. Since binding, a save needs a provenance record,
// which only a scored CV has, so no NEW row can be written this way.
//
// So the signature is a row with no overall score. Rows with overall = 0 AND
// sub-scores present are reported separately: those are real scores of zero.
//
// STRICTLY READ-ONLY: opened with { readonly: true, fileMustExist: true }.
// Prints counts only — no names, file names or ids.
//
// Usage (local):   node scripts/scan-failed-as-zero.js
// Usage (Render):  node scripts/scan-failed-as-zero.js   (reads $DATABASE_PATH)
//                  or DATABASE_PATH=/path/to/copy.db node scripts/scan-failed-as-zero.js

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DATABASE_PATH || process.env.DB_PATH || path.join(__dirname, '..', 'data', 'audit.db');
if (!fs.existsSync(DB_PATH)) {
  console.error(`DB not found: ${DB_PATH}`);
  process.exit(2);
}
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
const cols = (t) => new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name));
const one = (sql, ...args) => db.prepare(sql).get(...args).n;

const report = { database: path.basename(DB_PATH) };

if (!tables.has('audit_log')) {
  report.audit_log = 'table not present';
} else {
  const c = cols('audit_log');
  const legacy = c.has('binding_version') ? 'binding_version IS NULL' : '1=1';
  const noSubs = 'keywords_score IS NULL AND skills_score IS NULL AND experience_score IS NULL AND education_score IS NULL';
  const failed = `overall IS NULL`;
  report.audit_log = {
    rows: one('SELECT COUNT(*) n FROM audit_log'),
    legacyPreBinding: one(`SELECT COUNT(*) n FROM audit_log WHERE ${legacy}`),
    noOverallScore: one(`SELECT COUNT(*) n FROM audit_log WHERE ${failed}`),
    noOverallAndNoSubScores: one(`SELECT COUNT(*) n FROM audit_log WHERE ${failed} AND ${noSubs}`),
    noOverallAmongBoundRows: c.has('binding_version') ? one(`SELECT COUNT(*) n FROM audit_log WHERE ${failed} AND binding_version IS NOT NULL`) : 'n/a',
    noOverallWithDecision: one(`SELECT COUNT(*) n FROM audit_log WHERE ${failed} AND decision IS NOT NULL AND decision != ''`),
    noOverallWithRole: one(`SELECT COUNT(*) n FROM audit_log WHERE ${failed} AND role IS NOT NULL AND role != ''`),
    orgsAffected: c.has('org_id') ? one(`SELECT COUNT(DISTINCT org_id) n FROM audit_log WHERE ${failed}`) : 'n/a',
    // Real zeros, for contrast: scored, and scored 0.
    overallZeroWithSubScores: one(`SELECT COUNT(*) n FROM audit_log WHERE overall = 0 AND NOT (${noSubs})`),
    overallZeroWithoutSubScores: one(`SELECT COUNT(*) n FROM audit_log WHERE overall = 0 AND ${noSubs}`),
  };
  if (tables.has('audit_changes')) {
    report.audit_changes = {
      changesOnRowsWithNoOverall: one(`SELECT COUNT(*) n FROM audit_changes WHERE audit_id IN (SELECT id FROM audit_log WHERE ${failed})`),
    };
  }
}

if (tables.has('analysis_provenance')) {
  // A binding without a numeric overall would let a failed file be saved.
  report.analysis_provenance = {
    rows: one('SELECT COUNT(*) n FROM analysis_provenance'),
    withoutNumericOverall: one("SELECT COUNT(*) n FROM analysis_provenance WHERE json_type(payload, '$.overall') NOT IN ('integer', 'real') OR json_type(payload, '$.overall') IS NULL"),
  };
}

console.log(JSON.stringify(report, null, 2));
db.close();
