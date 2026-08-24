'use strict';

/**
 * src/services/narrativeGenerator.js — deterministic narrative for the
 * candidate assessment PDF.
 *
 * This module RENDERS the stored audit record. It does not judge it. Every
 * sentence it returns is a restatement of a number or a list that is already in
 * the record, phrased through a template catalogue. There is no model, no
 * network call, no inference and no scoring: given the same record it returns
 * the same bytes, on any machine, in any timezone, forever.
 *
 * PURITY, enforced by narrativeGenerator.test.js:
 *   - no Date, Date.now(), Math.random(), process.env, require-time I/O
 *   - no Intl / toLocaleString / toLocaleDateString — locale-dependent output
 *     would make the same record render differently on two machines
 *   - no reliance on Object.keys(), Map or Set iteration order anywhere the
 *     result reaches output; every collection is sorted explicitly, with a
 *     fixed tiebreak, before it is read
 *   - every number formatted with toFixed()
 *
 * WHAT IT READS, and what it deliberately does not:
 *   Scores and weights come from the record. Weights in particular come from
 *   the row's own immutable snapshot (weightsJson, or the retained legacy
 *   weights column) — NEVER from src/config. A report regenerated in 2027 for a
 *   2026 analysis must state the arithmetic that actually ran in 2026, so
 *   reading live config here would silently rewrite history on an EU AI Act
 *   Art. 12 record-keeping artifact. If neither column yields usable weights
 *   this throws; there is no default weight set, because a plausible-looking
 *   default is exactly the failure that would never be noticed.
 *
 * SHAPE OF THE RECORD (from db.formatRow, via getAuditById):
 *   scores:            { keywords, skills, experience, education }  0..100
 *   weightsJson:       { kw, sk, ex, ed }  server-authoritative snapshot
 *   weights:           { kw, sk, ex, ed }  LEGACY, rows 2026-04-18..2026-07-29
 *   analysisDetail.matches:  [{ requirement, matched, evidence, ... }]  SKILLS
 *   analysisDetail.found:    [string]  keywords present in the CV
 *   analysisDetail.missing:  [string]  keywords absent from the CV
 *
 * Note that analysisDetail.matches is the SKILL list (services/scorer.js builds
 * it from skillResults), while found/missing are KEYWORDS. The renderer's
 * normaliseMatches() folds keywords into matches for legacy rows; this module
 * deliberately does not reuse that fallback, because labelling a keyword as a
 * skill in prose asserts something the record does not say.
 */

const { bandFor, bandsVersion } = require('../config/narrativeBands');
const { catalogueFor } = require('../i18n/narrative');
const { SKILLS_DB } = require('../data/skills');

/**
 * Matching key -> surface form, built once at load from the vocabulary.
 *
 * A Map only to make the lookup O(1); nothing iterates it, so its insertion
 * order never reaches output. Entries without a `display` are omitted, so a
 * miss and an absent form are the same thing: print the key unchanged.
 *
 * NOTE ON PURITY. This is the one input the narrative reads from outside the
 * audit record, and it is a deliberate, bounded exception. It affects SPELLING
 * only — never a score, a weight, a band or an ordering, all of which still
 * come from the row's own frozen snapshot. The cost is that re-rendering an old
 * record after a vocabulary edit can change how a skill is spelled, so
 * SKILLS_VOCABULARY_VERSION is stamped into the provenance footer beside the
 * other three versions: a reader comparing two reports can see that the
 * vocabulary moved, exactly as they can see that the templates did.
 */
const DISPLAY_BY_KEY = new Map(
  SKILLS_DB.filter((s) => typeof s.display === 'string' && s.display.trim() !== '')
    .map((s) => [s.name, s.display.trim()]),
);

/** Bump when the STRUCTURE or the derivation rules below change. */
const narrativeVersion = 'n-1';

/**
 * Canonical dimension order.
 *
 * Two jobs. It is the iteration order everywhere, so no Object.keys() ordering
 * can reach the output; and it is the tiebreak when two dimensions contribute
 * an identical number of points, so equal contributions can never flip between
 * runs. Both are why this is a frozen array and not an object.
 */
const DIMENSIONS = Object.freeze(['keywords', 'skills', 'experience', 'education']);
const DIMENSION_RANK = Object.freeze(
  DIMENSIONS.reduce((acc, d, i) => Object.assign(acc, { [d]: i }), {}),
);

/**
 * Weight key aliases. The scorer writes the short shape ({kw,sk,ex,ed} — see
 * services/scorer.js), which is what both the current weights_json column and
 * the retained legacy weights column contain. The long spelling is accepted
 * too, so a hand-written fixture or a future writer that spells the dimensions
 * out is not silently unreadable.
 */
const WEIGHT_ALIASES = Object.freeze({
  keywords: Object.freeze(['kw', 'keywords']),
  skills: Object.freeze(['sk', 'skills']),
  experience: Object.freeze(['ex', 'experience']),
  education: Object.freeze(['ed', 'education']),
});

/** Named lists are capped here and never grow an "and N others" tail. */
const ENUMERATION_CAP = 3;

/** Thrown when a record carries no bound weights in either column. */
const NO_BOUND_WEIGHTS = 'NARRATIVE_NO_BOUND_WEIGHTS';

/** Dimensions whose gap has an interview question. Education has none. */
const QUESTION_FOR_DIMENSION = Object.freeze({
  skills: 'question.skill',
  experience: 'question.leadership',
  keywords: 'question.keyword',
});

// ── template resolution ────────────────────────────────────────────────────

function resolveTemplate(catalogue, keyPath) {
  const parts = String(keyPath).split('.');
  let node = catalogue.TEMPLATES;
  for (const part of parts) {
    if (node == null || typeof node !== 'object' || !Object.prototype.hasOwnProperty.call(node, part)) {
      throw new Error(`narrative: template key "${keyPath}" is not defined in locale "${catalogue.locale}"`);
    }
    node = node[part];
  }
  if (typeof node !== 'string') {
    throw new Error(`narrative: template key "${keyPath}" in locale "${catalogue.locale}" is not a string`);
  }
  return node;
}

/**
 * Fill {placeholders}. Throws on an unfilled slot rather than leaving one in
 * the text — a candidate's PDF must never contain a brace or a template id.
 */
function fill(template, vars, keyPath, locale) {
  const supplied = vars || {};
  const out = template.replace(/\{(\w+)\}/g, (_match, name) => {
    if (!Object.prototype.hasOwnProperty.call(supplied, name)) {
      throw new Error(`narrative: template "${keyPath}" (${locale}) needs {${name}}, which was not supplied`);
    }
    return String(supplied[name]);
  });
  if (/[{}]/.test(out)) {
    throw new Error(`narrative: template "${keyPath}" (${locale}) still contains a brace after filling`);
  }
  return out;
}

function t(catalogue, keyPath, vars) {
  return fill(resolveTemplate(catalogue, keyPath), vars, keyPath, catalogue.locale);
}

// ── record reading ─────────────────────────────────────────────────────────

/**
 * Coerce a subscore to a finite 0..100 integer.
 *
 * A null subscore becomes 0, matching what the surrounding renderer already
 * does with `audit.overall ?? 0`. It is a coercion, not a claim: the requirement
 * table and the score composition block print the same underlying values, so a
 * reader is never shown a narrative figure that contradicts the table above it.
 */
function subscore(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, Math.round(n)));
}

function normaliseWeights(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  for (const dim of DIMENSIONS) {
    let value = null;
    for (const alias of WEIGHT_ALIASES[dim]) {
      if (Object.prototype.hasOwnProperty.call(raw, alias)) {
        const n = Number(raw[alias]);
        if (Number.isFinite(n) && n >= 0) { value = n; break; }
      }
    }
    if (value == null) return null;
    out[dim] = value;
  }
  const total = DIMENSIONS.reduce((sum, d) => sum + out[d], 0);
  // An all-zero weight set cannot produce a contribution ordering, and dividing
  // by it would yield NaN in every sentence.
  if (!(total > 0)) return null;
  return Object.freeze({ weights: Object.freeze(out), total });
}

/**
 * The row's OWN weights, and which column they came from.
 *
 * weightsJson first: it is the server-authoritative snapshot. The legacy column
 * is the sole weight record for rows written between 2026-04-18 and 2026-07-29
 * (see db.js) and is therefore a valid source, not a fallback to be warned
 * about — but it was client-asserted, so which one was used is stamped into the
 * NarrativeBlock rather than smoothed over.
 */
function readBoundWeights(record) {
  const fromJson = normaliseWeights(record.weightsJson);
  if (fromJson) return { ...fromJson, source: 'weights_json' };
  const fromLegacy = normaliseWeights(record.weights);
  if (fromLegacy) return { ...fromLegacy, source: 'legacy_weights' };
  const err = new Error(
    `narrative: audit record ${record && record.id ? record.id : '(no id)'} has no usable bound weights `
    + '(weightsJson and the legacy weights column are both absent or unreadable). '
    + 'Refusing to fall back to current config, which would restate this report under arithmetic that never ran.',
  );
  // Coded so a renderer can tell "this record cannot support a narrative" from
  // "the narrative layer is broken". The first is a property of old data and
  // must not take the whole PDF down with it; the second must be fatal.
  err.code = NO_BOUND_WEIGHTS;
  throw err;
}

/**
 * The form of a criterion to PRINT, as stored on the record.
 *
 * Three sources, in strict order of authority:
 *   1. a display form stored ON THE RECORD (displayName / display / label) —
 *      a frozen per-analysis fact; nothing writes one yet, and the three
 *      spellings are accepted because the field name is not settled
 *   2. the skills vocabulary (src/data/skills.js), versioned and stamped
 *   3. the matching key EXACTLY as stored
 *
 * So prose reads "PostgreSQL" and "gRPC" rather than "postgresql" and "grpc".
 *
 * Deliberately no programmatic capitalisation. Title-casing this vocabulary
 * produces "Aws", "Grpc", "Nodejs" and "C#" becomes "C#" only by luck — a
 * transform that is wrong more often than it is right, on a document whose
 * whole claim is that every line traces to a stored fact. If the record does
 * not carry a display form, the key is printed unchanged and the report is
 * merely lowercase rather than confidently wrong.
 */
function displayForm(row, fallback) {
  // The RECORD wins. If a future scorer stores the surface form it actually
  // matched, that is a frozen per-analysis fact and outranks the vocabulary.
  for (const field of ['displayName', 'display', 'label']) {
    if (row && typeof row[field] === 'string' && row[field].trim() !== '') return row[field].trim();
  }
  const fromVocabulary = DISPLAY_BY_KEY.get(fallback);
  return fromVocabulary === undefined ? fallback : fromVocabulary;
}

/** Skills, in job-criteria definition order. analysisDetail.matches only. */
function readSkills(detail) {
  const rows = Array.isArray(detail.matches) ? detail.matches : [];
  return rows.map((m, index) => {
    const key = String(m && m.requirement != null ? m.requirement : '');
    return { index, name: displayForm(m, key), matched: !!(m && m.matched) };
  }).filter((s) => s.name !== '');
}

/**
 * Keywords, in the order the engine extracted them.
 *
 * These are plain strings in analysisDetail, with nowhere to carry a display
 * form — and none could exist anyway: services/scorer.js extracts them from
 * `jobDescription.toLowerCase()` with a regex that matches `[a-z]` only, so the
 * recruiter's original casing is destroyed before the keyword list is built.
 * Recovering it is a change to the scoring engine, not to this layer.
 */
function readKeywords(detail) {
  const asList = (v) => (Array.isArray(v) ? v.map((x) => String(x)).filter((x) => x !== '') : []);
  return { found: asList(detail.found), missing: asList(detail.missing) };
}

// ── enumeration ────────────────────────────────────────────────────────────

/**
 * "A", "A and B", "A, B and C". Capped at ENUMERATION_CAP with no trailing
 * "and others": a list that admits it is truncated invites the reader to wonder
 * what was withheld, and the requirement table above already shows every row.
 *
 * `items` must arrive already sorted by job-criteria index — this function does
 * not sort, so a caller cannot accidentally get score order.
 */
function enumerate(items, catalogue) {
  const sep = resolveTemplate(catalogue, 'list.separator');
  const conj = resolveTemplate(catalogue, 'list.conjunction');
  const capped = items.slice(0, ENUMERATION_CAP);
  if (capped.length === 0) return '';
  if (capped.length === 1) return capped[0];
  return capped.slice(0, -1).join(sep) + conj + capped[capped.length - 1];
}

/** Sort by descending numeric key, tiebroken on canonical dimension order. */
function byImpactThenDimension(a, b) {
  if (b.value !== a.value) return b.value - a.value;
  return DIMENSION_RANK[a.dimension] - DIMENSION_RANK[b.dimension];
}

/** One decimal, as a number — stable under JSON.stringify across engines. */
function points(value) {
  return Number(value.toFixed(1));
}

// ── the generator ──────────────────────────────────────────────────────────

/**
 * Build the narrative block for an audit record.
 *
 * @param {object} auditRecord  a record as returned by db.getAuditById()
 * @param {object} [options]
 * @param {string} [options.locale='en']
 * @returns {object} frozen NarrativeBlock
 * @throws on an unknown locale, an undefined template key, an unfilled
 *   placeholder, or a record with no usable bound weights
 */
function generateNarrative(auditRecord, options) {
  const record = auditRecord || {};
  const opts = options || {};
  const locale = opts.locale === undefined ? 'en' : opts.locale;
  const catalogue = catalogueFor(locale);

  const { weights, total: totalWeight, source: weightsSource } = readBoundWeights(record);
  const detail = record.analysisDetail || {};
  const scores = record.scores || {};

  const overall = subscore(record.overall);
  const bandRange = bandFor(overall);
  const bandKey = bandRange.key;

  const skills = readSkills(detail);
  const keywords = readKeywords(detail);

  const dimScore = Object.freeze({
    keywords: subscore(scores.keywords),
    skills: subscore(scores.skills),
    experience: subscore(scores.experience),
    education: subscore(scores.education),
  });

  // Points this dimension actually contributed to the total, and points it did
  // not. Both use the row's own weights and the same arithmetic the scorer ran
  // (services/scorer.js: sum(score * weight) / sum(weight)).
  const contributed = {};
  const unrealised = {};
  for (const dim of DIMENSIONS) {
    contributed[dim] = (dimScore[dim] * weights[dim]) / totalWeight;
    unrealised[dim] = ((100 - dimScore[dim]) * weights[dim]) / totalWeight;
  }

  // ---- assessment ---------------------------------------------------------
  // Band sentence first, then one sentence per dimension ordered by absolute
  // point contribution, descending, tiebroken on DIMENSIONS order.
  const matchedSkills = skills.filter((s) => s.matched);
  const unmatchedSkills = skills.filter((s) => !s.matched);
  const keywordTotal = keywords.found.length + keywords.missing.length;

  function dimensionSentence(dim) {
    if (dim === 'skills') {
      if (skills.length === 0) return null;
      if (matchedSkills.length === skills.length) {
        return t(catalogue, 'skills.matchedAll', { total: skills.length.toFixed(0) });
      }
      if (matchedSkills.length === 0) {
        return t(catalogue, 'skills.matchedNone', { total: skills.length.toFixed(0) });
      }
      return t(catalogue, 'skills.matched', {
        count: matchedSkills.length.toFixed(0),
        total: skills.length.toFixed(0),
        items: enumerate(matchedSkills.map((s) => s.name), catalogue),
      });
    }
    if (dim === 'keywords') {
      if (keywordTotal === 0) return null;
      return t(catalogue, 'keywords.matched', {
        count: keywords.found.length.toFixed(0),
        total: keywordTotal.toFixed(0),
        score: dimScore.keywords.toFixed(0),
      });
    }
    if (dim === 'experience') {
      // Reuses the band table rather than inventing a second threshold: a
      // dimension "aligns" when its own subscore bands strong or partial.
      const key = ['strong', 'partial'].indexOf(bandFor(dimScore.experience).key) >= 0
        ? 'experience.meets' : 'experience.below';
      return t(catalogue, key, { score: dimScore.experience.toFixed(0) });
    }
    // education is presence/absence of a documented qualification, not a
    // degree of match, so it is banded at "documented at all" rather than by
    // the score table.
    return t(catalogue, dimScore.education > 0 ? 'education.met' : 'education.notEvidenced', {});
  }

  const orderedDimensions = DIMENSIONS
    .map((dimension) => ({ dimension, value: contributed[dimension] }))
    .sort(byImpactThenDimension);

  const assessment = [t(catalogue, `band.${bandKey}.sentence`, { score: overall.toFixed(0) })];
  for (const { dimension } of orderedDimensions) {
    const sentence = dimensionSentence(dimension);
    if (sentence) assessment.push(sentence);
  }

  // ---- gaps ---------------------------------------------------------------
  // One entry per dimension that has undocumented content, each enumerating at
  // most ENUMERATION_CAP named items in job-criteria order. Per-dimension
  // rather than per-item so the section stays readable on a CV missing thirty
  // keywords, and so impact is a real number of points rather than a share.
  const gapCandidates = [];

  if (unmatchedSkills.length > 0) {
    gapCandidates.push({
      dimension: 'skills',
      value: unrealised.skills,
      items: unmatchedSkills.map((s) => s.name),
      key: 'gap.skill',
      vars: () => ({ items: enumerate(unmatchedSkills.map((s) => s.name), catalogue) }),
    });
  }
  if (keywords.missing.length > 0) {
    gapCandidates.push({
      dimension: 'keywords',
      value: unrealised.keywords,
      items: keywords.missing,
      key: 'gap.keywords',
      vars: () => ({ items: enumerate(keywords.missing, catalogue) }),
    });
  }
  if (['strong', 'partial'].indexOf(bandFor(dimScore.experience).key) < 0) {
    gapCandidates.push({
      dimension: 'experience', value: unrealised.experience, items: [], key: 'gap.experience', vars: () => ({}),
    });
  }
  if (dimScore.education === 0) {
    gapCandidates.push({
      dimension: 'education', value: unrealised.education, items: [], key: 'gap.education', vars: () => ({}),
    });
  }

  const orderedGaps = gapCandidates.slice().sort(byImpactThenDimension);
  const gaps = orderedGaps.map((g) => Object.freeze({
    text: t(catalogue, g.key, g.vars()),
    dimension: g.dimension,
    impact: points(g.value),
  }));

  // ---- interview questions ------------------------------------------------
  // Mechanically derived from the top gaps by point impact. Education has no
  // question template, so a top-3 that includes it yields fewer questions
  // rather than a padded one.
  const interviewQuestions = [];
  for (const g of orderedGaps.slice(0, ENUMERATION_CAP)) {
    const key = QUESTION_FOR_DIMENSION[g.dimension];
    if (!key) continue;
    const named = g.items.slice(0, ENUMERATION_CAP);
    interviewQuestions.push(
      named.length > 0 ? t(catalogue, key, { item: named[0] }) : t(catalogue, key, {}),
    );
  }

  return Object.freeze({
    narrativeVersion,
    bandsVersion,
    templateVersion: catalogue.templateVersion,
    locale: catalogue.locale,
    // Which column the arithmetic came from. Never smoothed over: a legacy row's
    // weights were client-asserted, and a reader comparing two reports is
    // entitled to know that.
    weightsSource,
    band: Object.freeze({
      key: bandKey,
      label: resolveTemplate(catalogue, `band.${bandKey}.label`),
      minScore: bandRange.minScore,
      maxScore: bandRange.maxScore,
    }),
    assessment: Object.freeze(assessment),
    gaps: Object.freeze(gaps),
    gapsDisclaimer: resolveTemplate(catalogue, 'gaps.disclaimer'),
    interviewQuestions: Object.freeze(interviewQuestions),
  });
}

module.exports = { generateNarrative, narrativeVersion, DIMENSIONS, ENUMERATION_CAP, NO_BOUND_WEIGHTS };
