'use strict';

/**
 * src/services/scoredRecord.js — is this stored record a screening outcome?
 *
 * A record is scored only if it carries a numeric overall score. The ones that
 * do not are CVs that could not be analysed (a failed batch file) which the
 * app, before field binding, saved anyway with no score — NULL in the
 * database, and shown as 0 wherever the UI wrote `overall || 0`. Since binding
 * a save needs a provenance record, and only a scored CV has one, so no new
 * row like that can be written; this predicate is how every surface that
 * aggregates, ranks, reports on or records a decision against a record keeps
 * the old ones out.
 *
 * One definition, so the bias report, the stats, role history and the
 * decision/report guards cannot disagree about what counts.
 */
function isScoredRecord(record) {
  return !!record && typeof record.overall === 'number' && Number.isFinite(record.overall);
}

module.exports = { isScoredRecord };
