'use strict';

/**
 * src/services/biasAudit.js
 *
 * Pure analysis engine for the bias monitoring report.
 * No DB calls - receives records, returns a structured analysis object.
 *
 * FRAMING (non-negotiable):
 *   - This is a monitoring aid, not a compliance certification.
 *   - Never emits language like "no bias detected", "compliant", "cleared".
 *   - Uses observational language throughout.
 *   - Never infers protected characteristics from names, photos, or any proxy.
 *   - The only legitimate grouping dimension is anonymized vs non-anonymized.
 *   - All statistics carry their sample size.
 *   - Confidence degrades visibly with small samples.
 */

const crypto = require('crypto');

// This report's own engine identity. Built the same way MODEL_ID is in
// routes/analyze.js, but it is NOT that value: the engine that produced a bias
// report is analyzeBias(), not the lexical scorer. Stamping the scorer's
// version here would be actively misleading, since a single report aggregates
// records that may have been scored by several different versions — which is
// what scoringEngines below reports separately.
const BIAS_ENGINE_ID = 'cvsprings-bias-audit@' + require('../../package.json').version;
const RULESET_VERSION = require('../../package.json').version;

// Bumping this changes every fingerprint. Do it only when the input set below
// changes meaning — not for unrelated edits to this file.
const FINGERPRINT_VERSION = 1;

/**
 * A deterministic fingerprint of a bias report's inputs.
 *
 * NOT a persistent handle. Bias reports are generated on demand and never
 * stored, so there is no row to look up — the value identifies the QUERY and
 * its result set, not a record. The same inputs reproduce the same
 * fingerprint; a changed one means the underlying records changed, including
 * by retention purge. The report says so in as many words, because an
 * identifier that looks like a lookup key but is not is worse than none.
 *
 * FROZEN INPUT SET — do not change without bumping FINGERPRINT_VERSION:
 *   1. FINGERPRINT_VERSION
 *   2. org id
 *   3. role filter        (null when unfiltered)
 *   4. from / to bounds   (null when unbounded)
 *   5. the sorted set of record ids in scope
 *
 * Record ids are audit_log.id — opaque uuidv4 surrogate keys minted server-side
 * (services/db.insertAudit). No candidate name, file name, or any other
 * identifying value is hashed, so the fingerprint cannot leak who was in the
 * set even under a known-input attack.
 */
function reportFingerprint({ orgId, role, from, to, recordIds }) {
  const payload = JSON.stringify({
    v: FINGERPRINT_VERSION,
    orgId: orgId || null,
    role: role || null,
    from: from || null,
    to: to || null,
    records: [...(recordIds || [])].map(String).sort(),
  });
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 32);
}

/**
 * The distinct scoring-engine versions represented in the aggregated records.
 *
 * A report spanning more than one is aggregating output from more than one
 * engine, and its distributions and rates are comparing values that were not
 * necessarily produced on the same basis. That is a validity caveat about
 * whether the statistics mean what they appear to mean — so it is surfaced
 * where the reader meets it before the numbers, not in a footnote.
 */
function scoringEngineSpan(records) {
  const seen = new Set();
  let unrecorded = 0;
  for (const r of records) {
    if (r.modelId) seen.add(String(r.modelId));
    else unrecorded += 1;
  }
  const versions = [...seen].sort();
  const distinct = versions.length + (unrecorded > 0 ? 1 : 0);
  const mixed = distinct > 1;
  let caveat = null;
  if (mixed) {
    const listed = versions.length ? versions.join(', ') : null;
    caveat =
      'These records were scored by more than one version of the scoring engine'
      + (listed ? ' (' + listed + ')' : '')
      + (unrecorded > 0
        ? ', and ' + unrecorded + ' record' + (unrecorded !== 1 ? 's have' : ' has')
          + ' no engine version recorded'
        : '')
      + '. Scores produced by different versions were not necessarily calculated on the '
      + 'same basis, so the distributions and rates below compare values that may not be '
      + 'directly comparable. Read every figure in this report with that in mind, and '
      + 'narrow the date range to a single engine version if you need a like-for-like view.';
  }
  return { versions, unrecorded, distinct, mixed, caveat };
}

// ---------------------------------------------------------------------------
// Statistical helpers (pure JS, no dependencies)
// ---------------------------------------------------------------------------

function mean(arr) {
  if (!arr.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function median(arr) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function stdDev(arr) {
  if (arr.length < 2) return null;
  const m = mean(arr);
  const variance = arr.reduce((sum, v) => sum + (v - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

/**
 * Welch's t-test (two-sample, unequal variance).
 * Returns two-tailed p-value. Returns null if either group < 2 members.
 */
function welchTTest(a, b) {
  if (a.length < 2 || b.length < 2) return null;
  const meanA = mean(a);
  const meanB = mean(b);
  const varA = a.reduce((s, v) => s + (v - meanA) ** 2, 0) / (a.length - 1);
  const varB = b.reduce((s, v) => s + (v - meanB) ** 2, 0) / (b.length - 1);
  const seA = varA / a.length;
  const seB = varB / b.length;
  const se = Math.sqrt(seA + seB);
  if (se === 0) return 1;
  const t = (meanA - meanB) / se;
  const df = (seA + seB) ** 2 / (seA ** 2 / (a.length - 1) + seB ** 2 / (b.length - 1));
  return twoTailedPValue(Math.abs(t), df);
}

/**
 * Two-proportion z-test.
 * Returns two-tailed p-value, or null if either n is 0.
 */
function twoPropZTest(r1, n1, r2, n2) {
  if (!n1 || !n2) return null;
  const p1 = r1 / n1;
  const p2 = r2 / n2;
  const pooled = (r1 + r2) / (n1 + n2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  if (se === 0) return 1;
  const z = Math.abs((p1 - p2) / se);
  return 2 * (1 - normalCdf(z));
}

/** Normal CDF approximation (Abramowitz & Stegun 26.2.17). */
function normalCdf(z) {
  const t = 1 / (1 + 0.2316419 * z);
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return 1 - (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-0.5 * z * z) * poly;
}

/** Two-tailed p-value from t-distribution. */
function twoTailedPValue(t, df) {
  if (df >= 30) return 2 * (1 - normalCdf(t));
  const x = df / (df + t * t);
  return incompleteBeta(df / 2, 0.5, x);
}

function incompleteBeta(a, b, x) {
  if (x === 0) return 1;
  if (x === 1) return 0;
  const lbeta = logGamma(a + b) - logGamma(a) - logGamma(b);
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lbeta) / a;
  return front * betaCf(a, b, x);
}

function betaCf(a, b, x) {
  const MAXIT = 200;
  const EPS = 3e-7;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - qab * x / qap;
  if (Math.abs(d) < 1e-30) d = 1e-30;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + aa / c; if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d; h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + aa / c; if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d;
    const del = d * c; h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

function logGamma(z) {
  const g = 7;
  const c = [0.99999999999980993,676.5203681218851,-1259.1392167224028,771.32342877765313,
    -176.61502916214059,12.507343278686905,-0.13857109526572012,9.9843695780195716e-6,1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  z -= 1;
  let x = c[0];
  for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

// ---------------------------------------------------------------------------
// Score-band helpers
// ---------------------------------------------------------------------------

const BANDS = ['0-9','10-19','20-29','30-39','40-49','50-59','60-69','70-79','80-89','90-100'];

function bandOf(score) {
  if (score == null || isNaN(score)) return null;
  const s = Math.max(0, Math.min(100, Math.round(score)));
  if (s === 100) return '90-100';
  return BANDS[Math.floor(s / 10)];
}

// ---------------------------------------------------------------------------
// Group stats helper
// ---------------------------------------------------------------------------

function groupStats(records) {
  const scores = records.map((r) => r.overall).filter((v) => v != null && !isNaN(v));
  const withDecision = records.filter((r) => r.decision && r.decision !== '');
  const shortlisted = withDecision.filter((r) => r.decision === 'shortlist').length;
  const rejected = withDecision.filter((r) => r.decision === 'reject').length;
  return {
    count: records.length,
    meanScore: scores.length ? round1(mean(scores)) : null,
    medianScore: scores.length ? round1(median(scores)) : null,
    shortlistRate: withDecision.length ? roundPct(shortlisted / withDecision.length) : null,
    rejectRate: withDecision.length ? roundPct(rejected / withDecision.length) : null,
    _scores: scores,
    _shortlisted: shortlisted,
    _withDecision: withDecision.length,
  };
}

function round1(v) { return v == null ? null : Math.round(v * 10) / 10; }
function round4(v) { return v == null ? null : Math.round(v * 10000) / 10000; }
function roundPct(v) { return v == null ? null : Math.round(v * 100); }

// ---------------------------------------------------------------------------
// Reliability level
// ---------------------------------------------------------------------------

function reliabilityLevel(n) {
  if (n < 20) return 'insufficient';
  if (n < 50) return 'low';
  if (n < 150) return 'moderate';
  return 'high';
}

// ---------------------------------------------------------------------------
// Standard limitations (always emitted)
// ---------------------------------------------------------------------------

const STANDARD_LIMITATIONS = [
  'Sample size affects statistical reliability. Small samples can show apparent differences that are due to chance rather than systematic patterns. Treat results from samples below 50 records with particular caution.',
  'CVsprings does not hold and cannot analyse protected characteristics such as gender, ethnicity, age, or disability status. The only grouping dimension available is whether a CV was submitted anonymously (the anonymized flag set by the recruiter). This report cannot detect bias on any other dimension.',
  'This report is a monitoring aid to support human review of AI-assisted screening. It does not certify legal compliance, does not detect all forms of bias, and does not replace a formal equality impact assessment. Decisions about hiring remain the responsibility of the human recruiter.',
  'Score differences between groups may reflect legitimate factors (e.g., different role requirements, different candidate pools) as well as potential calibration issues. A difference alone does not establish bias.',
  'Decision inconsistency within a score band may reflect legitimate factors (additional information available to the recruiter, soft criteria, role-specific judgements) and is not itself evidence of bias.',
];

// ---------------------------------------------------------------------------
// Main export: analyzeBias
// ---------------------------------------------------------------------------

/**
 * analyzeBias(records, options)
 *
 * @param {object[]} records - Array of already-tenant-scoped audit records
 * @param {object}   options - { role?: string, from?: string, to?: string }
 * @returns {object} Structured analysis per spec Section 1.4
 */
function analyzeBias(records, options) {
  options = options || {};
  const role = options.role || null;
  const from = options.from || null;
  const to = options.to || null;
  const totalRecords = records.length;
  const reliability = reliabilityLevel(totalRecords);

  // --- Grouping A: Anonymised vs non-anonymised ---
  const anon = records.filter((r) => r.anonymized === true || r.anonymized === 1);
  const nonAnon = records.filter((r) => r.anonymized === false || r.anonymized === 0);

  const anonStats = groupStats(anon);
  const nonAnonStats = groupStats(nonAnon);

  const MIN_PER_GROUP = 10;
  let comparison;
  if (anonStats.count < MIN_PER_GROUP || nonAnonStats.count < MIN_PER_GROUP) {
    comparison = {
      reliable: false,
      note: 'Sample too small to draw conclusions (need ' + MIN_PER_GROUP + ' or more in each group; have ' + anonStats.count + ' anonymised and ' + nonAnonStats.count + ' non-anonymised).',
    };
  } else {
    const pValueScore = anonStats._scores.length >= 2 && nonAnonStats._scores.length >= 2
      ? welchTTest(anonStats._scores, nonAnonStats._scores) : null;
    const pValueShortlist = twoPropZTest(anonStats._shortlisted, anonStats._withDecision, nonAnonStats._shortlisted, nonAnonStats._withDecision);
    const meanDiff = anonStats.meanScore != null && nonAnonStats.meanScore != null ? round1(anonStats.meanScore - nonAnonStats.meanScore) : null;
    const shortlistDiff = anonStats.shortlistRate != null && nonAnonStats.shortlistRate != null ? anonStats.shortlistRate - nonAnonStats.shortlistRate : null;
    const bothLargeEnough = anonStats.count >= 30 && nonAnonStats.count >= 30;
    const shortlistNotable = bothLargeEnough && pValueShortlist != null && pValueShortlist < 0.05;

    let interpretation = '';
    if (shortlistDiff != null) {
      const absDiff = Math.abs(shortlistDiff);
      const dirLabel = shortlistDiff > 0 ? 'anonymised' : 'non-anonymised';
      if (shortlistNotable) {
        interpretation = 'A ' + absDiff + '-percentage-point difference in shortlist rate was observed between anonymised and non-anonymised CVs (' + dirLabel + ' higher). At this sample size and with p = ' + round4(pValueShortlist) + ', this difference is statistically notable and warrants closer review. This observation does not establish a cause or constitute evidence of intentional bias.';
      } else {
        interpretation = 'A ' + absDiff + '-percentage-point difference in shortlist rate was observed between anonymised (' + anonStats.shortlistRate + '%) and non-anonymised (' + nonAnonStats.shortlistRate + '%) CVs. At this sample size this difference is observed but not statistically conclusive' + (pValueShortlist != null ? ' (p = ' + round4(pValueShortlist) + ')' : '') + '.';
      }
    } else {
      interpretation = 'Insufficient decision data to compare shortlist rates between the two groups.';
    }

    comparison = {
      reliable: true,
      meanScoreDiff: meanDiff,
      shortlistRateDiff: shortlistDiff,
      pValueShortlist: pValueShortlist != null ? round4(pValueShortlist) : null,
      pValueScore: pValueScore != null ? round4(pValueScore) : null,
      interpretation,
    };
  }

  const anonymisation = {
    anonymised: stripInternal(anonStats),
    nonAnonymised: stripInternal(nonAnonStats),
    comparison,
  };

  // --- Grouping B: Score distribution ---
  const allScores = records.map((r) => r.overall).filter((v) => v != null && !isNaN(v));
  const bandCounts = {};
  for (const b of BANDS) bandCounts[b] = 0;
  for (const s of allScores) { const b = bandOf(s); if (b) bandCounts[b]++; }

  const scoreDistribution = {
    sampleSize: allScores.length,
    bands: BANDS.map((label) => ({ band: label, count: bandCounts[label] })),
    mean: allScores.length ? round1(mean(allScores)) : null,
    median: allScores.length ? round1(median(allScores)) : null,
    stdDev: allScores.length >= 2 ? round1(stdDev(allScores)) : null,
  };

  // --- Grouping C: Decision consistency per score band ---
  const DECISIONS = ['shortlist', 'hold', 'reject'];
  const bandDecision = {};
  for (const b of BANDS) bandDecision[b] = { band: b, count: 0, shortlist: 0, hold: 0, reject: 0, other: 0 };
  for (const r of records) {
    const b = bandOf(r.overall);
    if (!b) continue;
    bandDecision[b].count++;
    if (DECISIONS.includes(r.decision)) { bandDecision[b][r.decision]++; }
    else if (r.decision) { bandDecision[b].other++; }
  }
  const decisionConsistency = { bands: BANDS.map((b) => bandDecision[b]) };

  // --- Grouping D: Per-role comparison (omitted when filtering by single role) ---
  let roleComparison = null;
  if (!role) {
    const roleMap = {};
    for (const r of records) {
      const roleKey = r.role || '(no role)';
      if (!roleMap[roleKey]) roleMap[roleKey] = [];
      roleMap[roleKey].push(r);
    }
    roleComparison = Object.entries(roleMap).map(([roleName, recs]) => {
      const s = groupStats(recs);
      return { role: roleName, count: s.count, meanScore: s.meanScore, medianScore: s.medianScore, shortlistRate: s.shortlistRate, rejectRate: s.rejectRate };
    }).sort((a, b) => b.count - a.count);
  }

  const scoringEngines = scoringEngineSpan(records);

  // Build limitations list (always populated)
  const limitations = [...STANDARD_LIMITATIONS];
  if (reliability === 'insufficient' || reliability === 'low') {
    limitations.unshift('This report covers only ' + totalRecords + ' record' + (totalRecords !== 1 ? 's' : '') + '. Results at this scale are highly sensitive to individual data points and should not be used to draw conclusions about patterns.');
  }
  // Also listed here so the caveat survives into any consumer that reads only
  // the limitations — it is rendered prominently above the statistics as well.
  if (scoringEngines.mixed) limitations.unshift(scoringEngines.caveat);

  return {
    generatedAt: new Date().toISOString(),
    reportFingerprint: reportFingerprint({
      orgId: options.orgId || null,
      role, from, to,
      recordIds: records.map((r) => r.id),
    }),
    engine: BIAS_ENGINE_ID,
    ruleset: RULESET_VERSION,
    scoringEngines,
    scope: { role, from, to, totalRecords },
    reliability,
    anonymisation,
    scoreDistribution,
    decisionConsistency,
    roleComparison,
    limitations,
  };
}

function stripInternal(stats) {
  const out = Object.assign({}, stats);
  delete out._scores;
  delete out._shortlisted;
  delete out._withDecision;
  return out;
}

// ---------------------------------------------------------------------------
// assertSoberLanguage - test tripwire (Section 3)
// ---------------------------------------------------------------------------

const FORBIDDEN_TERMS = ['compliant','compliance certified','no bias','bias-free','passed','cleared','guaranteed','certified'];

/**
 * Recursively scan all string values in obj for forbidden terms.
 * Throws if any are found. Used in tests only, NOT on the request path.
 */
function assertSoberLanguage(obj, path) {
  path = path || 'root';
  if (typeof obj === 'string') {
    const lower = obj.toLowerCase();
    for (const term of FORBIDDEN_TERMS) {
      if (lower.includes(term)) {
        throw new Error('assertSoberLanguage: forbidden term "' + term + '" found at ' + path + ': "' + obj.substring(0, 120) + '"');
      }
    }
  } else if (Array.isArray(obj)) {
    obj.forEach(function(item, i) { assertSoberLanguage(item, path + '[' + i + ']'); });
  } else if (obj && typeof obj === 'object') {
    Object.keys(obj).forEach(function(k) { assertSoberLanguage(obj[k], path + '.' + k); });
  }
}

module.exports = {
  analyzeBias, assertSoberLanguage, STANDARD_LIMITATIONS,
  reportFingerprint, scoringEngineSpan,
  BIAS_ENGINE_ID, RULESET_VERSION, FINGERPRINT_VERSION,
};
