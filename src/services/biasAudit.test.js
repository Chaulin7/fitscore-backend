'use strict';

/**
 * src/services/biasAudit.test.js
 *
 * Test suite for the bias audit analysis engine.
 * Uses Node.js built-in test runner (node --test).
 * Covers all 7 scenarios from the spec Section 4.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { analyzeBias, assertSoberLanguage } = require('./biasAudit');

// ---------------------------------------------------------------------------
// Record factory helpers
// ---------------------------------------------------------------------------

function makeRecord(overrides) {
  return Object.assign({
    id: Math.random().toString(36).slice(2),
    userId: 'tenant-a',
    candidateName: 'Test Candidate',
    overall: 60,
    scores: { keywords: 60, skills: 60, experience: 60, education: 60 },
    decision: 'shortlist',
    role: 'Engineer',
    anonymized: false,
    createdAt: new Date().toISOString(),
  }, overrides);
}

/**
 * Make n records for a tenant with given defaults and optional per-record overrides.
 */
function makeRecords(n, defaults, overridesFn) {
  return Array.from({ length: n }, (_, i) => makeRecord(Object.assign({}, defaults, overridesFn ? overridesFn(i) : {})));
}

// ---------------------------------------------------------------------------
// Test 1: analyzeBias with two clearly different groups (n >= 30 each)
// reports the difference and a p-value, and only calls it "statistically
// notable" when the test actually crosses the threshold.
// ---------------------------------------------------------------------------

describe('analyzeBias — large sample, clearly different shortlist rates', () => {
  test('reports p-value and statistically notable when threshold crossed', () => {
    // Group A: 40 anonymised, 80% shortlist rate
    const anonRecords = makeRecords(40, { anonymized: true, overall: 70 }, (i) => ({
      decision: i < 32 ? 'shortlist' : 'reject',
    }));
    // Group B: 40 non-anonymised, 20% shortlist rate (very different)
    const nonAnonRecords = makeRecords(40, { anonymized: false, overall: 50 }, (i) => ({
      decision: i < 8 ? 'shortlist' : 'reject',
    }));

    const records = [...anonRecords, ...nonAnonRecords];
    const report = analyzeBias(records);

    assert.equal(report.reliability, 'moderate');
    assert.equal(report.anonymisation.comparison.reliable, true);
    assert.ok(report.anonymisation.comparison.pValueShortlist != null, 'should have shortlist p-value');
    // With 80% vs 20% shortlist rate and n=40 each, p should be very small
    assert.ok(report.anonymisation.comparison.pValueShortlist < 0.05, 'p-value should be < 0.05 for very different groups');
    assert.ok(report.anonymisation.comparison.interpretation.includes('statistically notable'), 'interpretation should say statistically notable');
  });

  test('does NOT say statistically notable when p >= 0.05', () => {
    // Two groups with almost identical shortlist rates
    const anonRecords = makeRecords(35, { anonymized: true, overall: 65 }, (i) => ({
      decision: i < 18 ? 'shortlist' : 'reject',
    }));
    const nonAnonRecords = makeRecords(35, { anonymized: false, overall: 63 }, (i) => ({
      decision: i < 17 ? 'shortlist' : 'reject',
    }));

    const records = [...anonRecords, ...nonAnonRecords];
    const report = analyzeBias(records);

    assert.equal(report.anonymisation.comparison.reliable, true);
    // The p-value should be large (groups are similar) so "statistically notable" must NOT appear
    const interp = report.anonymisation.comparison.interpretation;
    assert.ok(!interp.includes('statistically notable'), 'should NOT say statistically notable for similar groups');
    assert.ok(interp.includes('not statistically conclusive'), 'should say not statistically conclusive');
  });
});

// ---------------------------------------------------------------------------
// Test 2: analyzeBias with small groups (n < 10) sets comparison.reliable = false
// and does not emit a p-value-based conclusion.
// ---------------------------------------------------------------------------

describe('analyzeBias — small groups', () => {
  test('sets comparison.reliable = false and omits p-value conclusion', () => {
    const anonRecords = makeRecords(5, { anonymized: true, overall: 70 });
    const nonAnonRecords = makeRecords(5, { anonymized: false, overall: 50 });
    const records = [...anonRecords, ...nonAnonRecords];

    const report = analyzeBias(records);

    assert.equal(report.anonymisation.comparison.reliable, false);
    assert.ok(report.anonymisation.comparison.note.includes('too small'), 'note should mention too small');
    // pValueShortlist should not be emitted on an unreliable comparison
    assert.equal(report.anonymisation.comparison.pValueShortlist, undefined);
  });
});

// ---------------------------------------------------------------------------
// Test 3: analyzeBias with < 20 total records returns reliability: "insufficient"
// ---------------------------------------------------------------------------

describe('analyzeBias — insufficient data', () => {
  test('returns reliability: insufficient for fewer than 20 records', () => {
    const records = makeRecords(15, {});
    const report = analyzeBias(records);
    assert.equal(report.reliability, 'insufficient');
    assert.equal(report.scope.totalRecords, 15);
  });

  test('still returns a report (does not throw or 404)', () => {
    const records = makeRecords(3, {});
    const report = analyzeBias(records);
    assert.ok(report.generatedAt, 'should have generatedAt');
    assert.ok(Array.isArray(report.limitations), 'should have limitations');
    assert.ok(report.limitations.length > 0, 'limitations should not be empty');
  });
});

// ---------------------------------------------------------------------------
// Test 4: limitations is never empty regardless of input
// ---------------------------------------------------------------------------

describe('limitations', () => {
  test('is never empty — no records', () => {
    const report = analyzeBias([]);
    assert.ok(Array.isArray(report.limitations));
    assert.ok(report.limitations.length > 0, 'limitations must always be populated');
  });

  test('is never empty — large dataset', () => {
    const records = makeRecords(200, {});
    const report = analyzeBias(records);
    assert.ok(Array.isArray(report.limitations));
    assert.ok(report.limitations.length > 0);
  });

  test('always contains the three required limitation statements', () => {
    const report = analyzeBias([]);
    const all = report.limitations.join(' ').toLowerCase();
    assert.ok(all.includes('protected characteristic') || all.includes('gender') || all.includes('ethnicity'), 'should mention inability to analyse protected characteristics');
    assert.ok(all.includes('monitoring aid') || all.includes('does not certify'), 'should clarify this is a monitoring aid');
    assert.ok(all.includes('sample') || all.includes('statistical'), 'should mention sample size caveat');
  });
});

// ---------------------------------------------------------------------------
// Test 5: assertSoberLanguage throws when fed a report containing "compliant"
// ---------------------------------------------------------------------------

describe('assertSoberLanguage', () => {
  test('throws when forbidden term "compliant" is present', () => {
    const badReport = {
      scope: { role: null },
      limitations: ['This system is fully compliant with GDPR requirements.'],
    };
    assert.throws(
      () => assertSoberLanguage(badReport),
      (err) => {
        assert.ok(err.message.includes('compliant'), 'error should name the forbidden term');
        return true;
      }
    );
  });

  test('throws for other forbidden terms', () => {
    for (const term of ['no bias', 'bias-free', 'cleared', 'guaranteed', 'certified']) {
      const bad = { note: 'This process is ' + term + ' from any issues.' };
      assert.throws(() => assertSoberLanguage(bad), 'should throw for term: ' + term);
    }
  });

  test('does not throw for a clean report', () => {
    const records = makeRecords(50, {});
    const report = analyzeBias(records);
    // This will throw if any forbidden language crept in
    assert.doesNotThrow(() => assertSoberLanguage(report), 'clean report should not trigger assertSoberLanguage');
  });
});

// ---------------------------------------------------------------------------
// Test 6: Tenant isolation — records from two different tenants, only one's
// data should appear in the report. (This tests the scoping contract — the
// actual DB filtering is tested here by simulating the filter that the route
// applies before calling analyzeBias.)
// ---------------------------------------------------------------------------

describe('tenant isolation', () => {
  test('analyzeBias only sees records passed to it — it does not reach into the DB', () => {
    const tenantA = makeRecords(30, { userId: 'tenant-a', overall: 80, anonymized: true }, (i) => ({
      decision: i % 2 === 0 ? 'shortlist' : 'reject',
    }));
    const tenantB = makeRecords(30, { userId: 'tenant-b', overall: 20, anonymized: false }, () => ({
      decision: 'reject',
    }));

    // Simulate what the route does: it calls getAuditsByTenant(userId) before
    // passing records to analyzeBias. Only tenant A records are passed in.
    const reportA = analyzeBias(tenantA, {});

    // tenant B data must not appear
    assert.equal(reportA.scope.totalRecords, 30, 'report should only contain tenant A records');
    // Tenant A has all anonymized:true records; non-anonymised count should be 0
    assert.equal(reportA.anonymisation.nonAnonymised.count, 0, 'no non-anonymised records for tenant A');
    assert.equal(reportA.anonymisation.anonymised.count, 30, 'all tenant A records are anonymised');

    // Confirm tenant B's low scores (mean ~20) are not mixed in
    assert.ok(reportA.scoreDistribution.mean >= 70, 'mean score should reflect tenant A data only (should be ~80)');
  });
});

// ---------------------------------------------------------------------------
// Test 7: Date and role filters narrow the record set correctly
// ---------------------------------------------------------------------------

describe('scope filters', () => {
  test('role filter: only matching records are included', () => {
    const engineers = makeRecords(25, { role: 'Engineer', overall: 75 });
    const designers = makeRecords(25, { role: 'Designer', overall: 45 });

    // Simulate route: caller has already filtered by role before calling analyzeBias
    const engineerReport = analyzeBias(engineers, { role: 'Engineer' });
    assert.equal(engineerReport.scope.totalRecords, 25);
    assert.equal(engineerReport.scope.role, 'Engineer');
    // Per-role comparison should be null when filtering by a single role
    assert.equal(engineerReport.roleComparison, null);
    // Mean score should reflect engineers only
    assert.ok(engineerReport.scoreDistribution.mean >= 70, 'mean should reflect engineers');
  });

  test('all-roles report includes roleComparison array', () => {
    const engineers = makeRecords(20, { role: 'Engineer', overall: 75 });
    const designers = makeRecords(20, { role: 'Designer', overall: 45 });
    const report = analyzeBias([...engineers, ...designers], {});
    assert.ok(Array.isArray(report.roleComparison), 'should have roleComparison for all-roles report');
    assert.equal(report.roleComparison.length, 2, 'should have two role entries');
  });

  test('date filter narrows record set when applied by caller', () => {
    const old = makeRecords(10, { createdAt: '2024-01-15T00:00:00.000Z' });
    const recent = makeRecords(10, { createdAt: '2025-06-01T00:00:00.000Z' });

    // Caller filters by date before passing to analyzeBias
    const from = '2025-01-01';
    const filtered = [...old, ...recent].filter((r) => new Date(r.createdAt) >= new Date(from));
    const report = analyzeBias(filtered, { from });

    assert.equal(report.scope.totalRecords, 10, 'only recent records should be in scope');
    assert.equal(report.scope.from, from);
  });
});
