'use strict';

/**
 * src/services/provenance.js
 *
 * The provenance block shared by every document CVsprings emits.
 *
 * Provenance answers "which document is this, what produced it, and when" for
 * a reader who has only the artifact in front of them. It is deliberately NOT
 * branding: branding answers "whose mark is on this" and is plan-dependent,
 * while provenance is identical at every tier and reachable by no org setting.
 * The two live in separate modules so that boundary stays honest.
 *
 * This module owns the FIELD SET and the normalisation rules. It does not
 * render: the candidate report emits pdfmake nodes and the bias report emits
 * an HTML string, so the two documents format these values for their own
 * medium. What they cannot do is disagree about what provenance means, or
 * about how a timestamp is written.
 */

const { PROVENANCE_PLATFORM } = require('./branding');

// Rendered in place of a value that is genuinely absent. Never a default, and
// never an empty string — a reader must be able to tell "not recorded" from
// "recorded as blank".
const ABSENT = '—';

/**
 * ISO 8601 in UTC, or null when the input is not a usable date.
 *
 * The single implementation. The bias report previously downgraded its own
 * ISO 8601 timestamp to RFC 1123 via toUTCString() at render time, so the two
 * documents disagreed about the format of the same kind of fact.
 */
function isoUtc(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function text(value) {
  if (value == null) return ABSENT;
  const s = String(value).trim();
  return s === '' ? ABSENT : s;
}

/**
 * Normalise a document's provenance into the shared shape.
 *
 * @param {object} input
 * @param {string} input.id        document identifier (candidate report: the
 *                                 persisted audit id; bias report: a derived
 *                                 fingerprint — see biasAudit.reportFingerprint)
 * @param {string} input.engine    the engine that produced THIS document
 * @param {string} input.ruleset   the ruleset/app version it ran under
 * @param {string} [input.assessed] when the underlying analysis ran, if the
 *                                 document has a meaningful one distinct from
 *                                 its generation time
 * @param {string} [input.generated] generation time; defaults to now
 * @returns {{id,engine,ruleset,assessed,generated,platform}} frozen
 *
 * Frozen on the way out: the returned object is what a renderer prints, and
 * nothing downstream — including anything an org can influence — gets to
 * blank a field on the way to the page.
 */
function buildProvenance(input) {
  const i = input || {};
  return Object.freeze({
    id: text(i.id),
    engine: text(i.engine),
    ruleset: text(i.ruleset),
    assessed: isoUtc(i.assessed) || ABSENT,
    generated: isoUtc(i.generated) || new Date().toISOString(),
    platform: PROVENANCE_PLATFORM,
  });
}

module.exports = { buildProvenance, isoUtc, ABSENT, PROVENANCE_PLATFORM };
