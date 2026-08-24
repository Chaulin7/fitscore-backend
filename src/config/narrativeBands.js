'use strict';

/**
 * src/config/narrativeBands.js — score bands for the narrative layer.
 *
 * THRESHOLDS ONLY. No prose lives here: the label a reader sees is a template
 * in src/i18n/narrative/<locale>.js, because a band's name is language, and
 * language is translated. This file answers "which band is 72?" and nothing
 * else, so a locale can never move a boundary and a threshold change can never
 * silently reword a report.
 *
 * Bands are evaluated against the ROUNDED total, with an INCLUSIVE lower bound.
 * They are declared in descending order and matched first-wins, so the ranges
 * cannot develop a gap the way four independent if-statements can.
 *
 * bandsVersion is stamped into every NarrativeBlock and into the PDF provenance
 * footer. Moving any boundary below changes which sentence a past report
 * produces, so it MUST be bumped in the same commit — that is the whole point
 * of the stamp: a reader holding two reports can tell whether they were banded
 * under the same rules.
 */

/** Bump when any threshold below changes. */
const bandsVersion = 'b-1';

const BANDS = Object.freeze([
  Object.freeze({ key: 'strong', minScore: 80, maxScore: 100 }),
  Object.freeze({ key: 'partial', minScore: 60, maxScore: 79 }),
  Object.freeze({ key: 'limited', minScore: 40, maxScore: 59 }),
  Object.freeze({ key: 'minimal', minScore: 0, maxScore: 39 }),
]);

/**
 * The band a score falls in.
 *
 * Input is clamped to 0..100 rather than rejected. A score outside that range
 * is an engine bug, not a rendering decision, and a report that throws is worse
 * for the reader than one banded at the boundary — the numeric score is printed
 * beside the band anyway, so a clamp is visible rather than hidden.
 *
 * @param {number} score rounded total
 * @returns {{key: string, minScore: number, maxScore: number}} frozen band
 */
function bandFor(score) {
  if (!Number.isFinite(score)) {
    throw new TypeError(`narrativeBands: score must be a finite number, got ${String(score)}`);
  }
  const clamped = Math.min(100, Math.max(0, Math.round(score)));
  const hit = BANDS.find((b) => clamped >= b.minScore);
  // Unreachable while the lowest band starts at 0; kept so a future edit that
  // lifts that floor fails loudly instead of returning undefined into a PDF.
  if (!hit) throw new RangeError(`narrativeBands: no band covers score ${clamped}`);
  return hit;
}

module.exports = Object.freeze({ BANDS, bandsVersion, bandFor });
