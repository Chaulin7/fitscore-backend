'use strict';

/**
 * src/services/provenanceCache.test.js
 *
 * The provenance binding store, now backed by SQLite instead of an in-memory
 * Map.
 *
 * Covers (TESTS): that the extractor's and the scorer's engine versions are
 * distinct facts which both survive a round trip — the bug this replaces
 * silently overwrote the first with the second; that a binding made before a
 * restart still resolves afterwards, which the Map could never do; that expiry
 * is honoured on read and by the sweep; and that the key-set guard rejects a
 * payload carrying an unexpected key rather than storing a plausible-looking
 * record.
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

// Isolate on a throwaway sqlite file. Must be set BEFORE ./db is first required.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fitscore-provenance-test-'));
process.env.DATABASE_PATH = path.join(TMP_DIR, 'provenance-test.db');

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');

const provenance = require('./provenanceCache');
// Resolved on every call, never captured: the restart test drops ./db from the
// require cache, so a binding taken at import time would point at a closed handle.
const db = () => require('./db').getDb();
const closeDb = () => require('./db').closeDb();

const ORG = 'org-prov';
let seq = 0;
const nextId = () => `an-${++seq}`;

// A complete record, exactly as routes/analyze.provenanceRecord() builds one.
function record(analysisId, over = {}) {
  return {
    analysisId,
    extractorEngine: 'pdfjs',
    extractorVersion: '4.2.67',
    assemblerVersion: '1.0.0',
    textSha256: 'sha-' + analysisId,
    pageCount: 2,
    charCount: 4096,
    scorerEngine: 'cvsprings-lexical-scorer',
    scorerVersion: '1.3.0',
    scoringWeights: { kw: 40, sk: 30, ex: 20, ed: 10 },
    // Scoring OUTPUTS and analysis context. The record is the sole source for
    // the audit row now, so it has to carry everything the row records as fact.
    bindingVersion: provenance.PAYLOAD_VERSION,
    overall: 72,
    scores: { keywords: 70, skills: 80, experience: 65, education: 75 },
    verdict: 'Good Match',
    analysisDetail: { found: [], missing: [], skills: [], matches: [], recommendations: [] },
    anonymized: false,
    candidateName: 'Candidate',
    fileName: 'cv.pdf',
    jdSnippet: 'a job description',
    modelId: 'cvsprings-lexical-scorer@1.3.0',
    analysisTimestamp: '2026-08-12T09:00:00.000Z',
    appVersion: '1.3.0',
    ...over,
  };
}

// Write a row with an explicit expiry, to test expiry without waiting 24h.
function rememberExpiringAt(orgId, rec, expiresAt) {
  provenance.remember(orgId, rec);
  db().prepare('UPDATE analysis_provenance SET expires_at = ? WHERE org_id = ? AND analysis_id = ?')
    .run(expiresAt, orgId, rec.analysisId);
}

after(() => { provenance.stopProvenanceSweep(); closeDb(); });

describe('the two engine versions are separate facts', () => {
  test('both survive a remember() -> lookup() round trip, independently', () => {
    const id = nextId();
    provenance.remember(ORG, record(id));
    const got = provenance.lookup(ORG, id);
    assert.equal(got.extractorEngine, 'pdfjs');
    assert.equal(got.extractorVersion, '4.2.67', 'the extractor version used to be destroyed');
    assert.equal(got.scorerEngine, 'cvsprings-lexical-scorer');
    assert.equal(got.scorerVersion, '1.3.0');
  });

  test('neither can be mistaken for the other', () => {
    const id = nextId();
    provenance.remember(ORG, record(id));
    const got = provenance.lookup(ORG, id);
    assert.notEqual(got.extractorVersion, got.scorerVersion);
    // The old shape: one `engineVersion` key, whichever fact won the assignment.
    assert.equal(got.engineVersion, undefined, 'the colliding key must be gone entirely');
  });

  test('the whole record round-trips, not just the versions', () => {
    const id = nextId();
    const rec = record(id);
    provenance.remember(ORG, rec);
    assert.deepEqual(provenance.lookup(ORG, id), rec);
  });

  test('a payload carrying an unexpected key is refused, not silently stored', () => {
    const id = nextId();
    const errors = [];
    const orig = console.error;
    console.error = (...a) => errors.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
    try {
      // The exact regression: the old colliding key sneaking back in.
      provenance.remember(ORG, { ...record(id), engineVersion: 'cvsprings-lexical-scorer@1.3.0' });
    } finally { console.error = orig; }
    assert.equal(provenance.lookup(ORG, id), null, 'must not store a record it cannot vouch for');
    assert.ok(errors.some((e) => /unexpected keys/.test(e) && /engineVersion/.test(e)));
  });

  test('the allowed key set is exactly what analyze builds', () => {
    assert.deepEqual([...provenance.ALLOWED_KEYS].sort(), Object.keys(record('x')).sort());
  });

  test('the key set carries scoring OUTPUTS, not just inputs', () => {
    // The gap this closed: the record held the weights the engine used but not
    // what it produced, so the audit row took overall/scores/verdict/anonymized
    // from the client and the bias report computed over client-asserted numbers.
    for (const k of ['overall', 'scores', 'verdict', 'anonymized']) {
      assert.ok(provenance.ALLOWED_KEYS.includes(k), `${k} must be server-held`);
    }
  });
});

describe('inspect() — why a binding is unusable, not just that it is', () => {
  test('reports a live record with its age', () => {
    const id = nextId();
    provenance.remember(ORG, record(id));
    const got = provenance.inspect(ORG, id);
    assert.equal(got.found, true);
    assert.equal(got.expired, false);
    assert.equal(got.stale, false);
    assert.ok(got.record);
    assert.ok(got.ageMs >= 0 && got.ageMs < 60000);
  });

  test('an id the server never issued is a plain miss with no age to report', () => {
    const got = provenance.inspect(ORG, 'never-issued');
    assert.equal(got.found, false);
    assert.equal(got.ageMs, null, 'no analysis time exists to measure a gap from');
  });

  test('an expired record is found, flagged expired, and still reports its age', () => {
    // The age is the whole point: it is what tells us whether a real user's
    // analyse->save gap is approaching the TTL, and it is unreconstructable
    // once the sweep removes the row.
    const id = nextId();
    rememberExpiringAt(ORG, record(id), Date.now() - 1000);
    const got = provenance.inspect(ORG, id);
    assert.equal(got.found, true);
    assert.equal(got.expired, true);
    assert.ok(typeof got.ageMs === 'number');
  });

  test('inspect does NOT delete an expired row, so the age survives the log line', () => {
    const id = nextId();
    rememberExpiringAt(ORG, record(id), Date.now() - 1000);
    provenance.inspect(ORG, id);
    assert.equal(provenance.inspect(ORG, id).found, true, 'the sweep removes it, not the read');
  });

  test('a payload from before field binding is stale, not expired', () => {
    // This is the deploy-window case. It must be distinguishable from ordinary
    // expiry so a customer hitting it can be told what actually happened.
    const id = nextId();
    const old = record(id);
    delete old.bindingVersion;
    // Written straight to the table: remember() would reject the shape, which
    // is itself the point — only rows predating this release look like this.
    db().prepare(
      'INSERT INTO analysis_provenance (org_id, analysis_id, payload, created_at, expires_at) VALUES (?,?,?,?,?)',
    ).run(ORG, id, JSON.stringify(old), Date.now(), Date.now() + 3600000);
    const got = provenance.inspect(ORG, id);
    assert.equal(got.found, true);
    assert.equal(got.expired, false);
    assert.equal(got.stale, true, 'must not be reported as an ordinary miss');
  });

  test('org scoping holds — another org cannot inspect this binding', () => {
    const id = nextId();
    provenance.remember(ORG, record(id));
    assert.equal(provenance.inspect('other-org', id).found, false);
  });
});

describe('bindings survive a restart', () => {
  test('a binding written before a simulated restart still resolves after it', () => {
    const id = nextId();
    provenance.remember(ORG, record(id));

    // Simulate the process going away: close the handle and drop every module
    // in the require cache, so the next lookup goes through a brand-new
    // provenanceCache against a brand-new connection — exactly what a deploy or
    // an idle spin-down does. The in-memory Map could never pass this.
    closeDb();
    for (const k of Object.keys(require.cache)) {
      if (/services[\\/](db|provenanceCache)\.js$/.test(k)) delete require.cache[k];
    }
    const afterRestart = require('./provenanceCache');

    const got = afterRestart.lookup(ORG, id);
    assert.ok(got, 'the binding must outlive the process');
    assert.equal(got.scorerVersion, '1.3.0');
    assert.deepEqual(got.scoringWeights, { kw: 40, sk: 30, ex: 20, ed: 10 });
  });
});

describe('expiry', () => {
  test('an entry past its TTL does not resolve', () => {
    const id = nextId();
    rememberExpiringAt(ORG, record(id), Date.now() - 1000);
    assert.equal(provenance.lookup(ORG, id), null);
  });

  test('an entry inside its TTL does resolve', () => {
    const id = nextId();
    rememberExpiringAt(ORG, record(id), Date.now() + 60_000);
    assert.ok(provenance.lookup(ORG, id));
  });

  test('an expired entry is deleted on read, not left behind', () => {
    const id = nextId();
    rememberExpiringAt(ORG, record(id), Date.now() - 1000);
    const before = provenance._count();
    provenance.lookup(ORG, id);
    assert.equal(provenance._count(), before - 1, 'delete-on-read, as the Map did');
  });

  test('the sweep removes expired entries and leaves live ones', () => {
    const dead = [nextId(), nextId(), nextId()];
    const live = nextId();
    for (const id of dead) rememberExpiringAt(ORG, record(id), Date.now() - 1000);
    rememberExpiringAt(ORG, record(live), Date.now() + 60_000);

    const removed = provenance.sweepExpired();
    assert.ok(removed >= 3, `expected at least the 3 dead rows, swept ${removed}`);
    for (const id of dead) assert.equal(provenance.lookup(ORG, id), null);
    assert.ok(provenance.lookup(ORG, live), 'a live binding must not be swept');
  });

  test('the sweep reaches entries that were never looked up', () => {
    // Delete-on-read alone leaks: an analysis that is never saved is never read.
    const id = nextId();
    rememberExpiringAt(ORG, record(id), Date.now() - 1000);
    const before = provenance._count();
    provenance.sweepExpired();
    assert.ok(provenance._count() < before);
  });

  // Was 24h. The TTL stopped being a cache bound and became a deadline: the
  // record is the only source for the audit row, so expiry now REJECTS the save
  // instead of degrading it to client values. It therefore has to cover the
  // slowest legitimate analyse->save gap, not the median one.
  test('the TTL is 30 days', () => {
    assert.equal(provenance.TTL_MS, 30 * 24 * 60 * 60 * 1000);
  });

  test('the TTL comfortably exceeds a weekend and a hiring-manager round trip', () => {
    const days = provenance.TTL_MS / (24 * 60 * 60 * 1000);
    assert.ok(days >= 14, `a fail-closed TTL of ${days}d is too tight to review a batch`);
  });
});

describe('lookup semantics are unchanged', () => {
  test('an id the server never issued resolves to null', () => {
    assert.equal(provenance.lookup(ORG, 'an-never-issued'), null);
  });

  test('another org cannot resolve this org\'s analysisId', () => {
    const id = nextId();
    provenance.remember(ORG, record(id));
    assert.equal(provenance.lookup('org-other', id), null, 'bindings are org-scoped');
    assert.ok(provenance.lookup(ORG, id));
  });

  test('a missing orgId or a non-string analysisId resolves to null, not a throw', () => {
    assert.equal(provenance.lookup(null, 'x'), null);
    assert.equal(provenance.lookup(ORG, undefined), null);
    assert.equal(provenance.lookup(ORG, 42), null);
  });

  test('remember() ignores a record with no string analysisId', () => {
    const before = provenance._count();
    provenance.remember(ORG, { scorerEngine: 'x' });
    provenance.remember(ORG, null);
    provenance.remember(null, record('an-no-org'));
    assert.equal(provenance._count(), before, 'nothing written');
  });

  test('re-issuing the same analysisId replaces rather than duplicating', () => {
    const id = nextId();
    provenance.remember(ORG, record(id, { scoringWeights: { kw: 100, sk: 0, ex: 0, ed: 0 } }));
    const before = provenance._count();
    provenance.remember(ORG, record(id, { scoringWeights: { kw: 25, sk: 25, ex: 25, ed: 25 } }));
    assert.equal(provenance._count(), before, 'primary key holds — one row per (org, analysis)');
    assert.deepEqual(provenance.lookup(ORG, id).scoringWeights, { kw: 25, sk: 25, ex: 25, ed: 25 });
  });

  test('a corrupt payload is reported and fails closed, not thrown', () => {
    const id = nextId();
    provenance.remember(ORG, record(id));
    db().prepare('UPDATE analysis_provenance SET payload = ? WHERE org_id = ? AND analysis_id = ?')
      .run('{not json', ORG, id);
    const errors = [];
    const orig = console.error;
    console.error = (...a) => errors.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
    try { assert.equal(provenance.lookup(ORG, id), null); }
    finally { console.error = orig; }
    assert.ok(errors.some((e) => /not valid JSON/.test(e)));
  });
});

describe('no entry cap', () => {
  test('well past the old 5000-entry limit, the oldest bindings still resolve', () => {
    // The cap was a memory bound and evicted oldest-first. remember() runs once
    // per candidate, so a 200-CV batch wrote 200 entries — and a busy org would
    // evict exactly the bindings a recruiter saves first, working top-down
    // through a ranked list. On disk the TTL is the bound.
    const first = nextId();
    provenance.remember(ORG, record(first));
    const insert = db().transaction(() => {
      for (let i = 0; i < 5200; i++) provenance.remember(ORG, record(`an-bulk-${i}`));
    });
    insert();
    assert.ok(provenance.lookup(ORG, first), 'the earliest binding must not have been evicted');
    assert.ok(provenance.lookup(ORG, 'an-bulk-0'));
    assert.ok(provenance.lookup(ORG, 'an-bulk-5199'));
    assert.ok(provenance._count() > 5000);
  });
});

describe('a batch binds all or nothing', () => {
  // remember() runs once per candidate, so a 200-CV batch used to do 200
  // individual writes. A batch interrupted midway — deploy, crash, spin-down —
  // left an arbitrary prefix bound and the rest not: the saves that followed
  // would be vouched for some candidates and silently client-asserted for the
  // others, with nothing on the record to say which were which.
  const batch = (n, over = () => ({})) =>
    Array.from({ length: n }, (_, i) => record(nextId(), over(i)));

  test('a completed batch binds every candidate', () => {
    const recs = batch(200);
    const written = provenance.rememberMany(ORG, recs);
    assert.equal(written, 200);
    for (const r of recs) {
      const got = provenance.lookup(ORG, r.analysisId);
      assert.ok(got, `${r.analysisId} must be bound`);
      assert.equal(got.textSha256, r.textSha256, 'each candidate keeps its own record');
    }
  });

  test('each candidate keeps its own weights, not the last writer\'s', () => {
    const recs = batch(25, (i) => ({ scoringWeights: { kw: i, sk: 25 - i, ex: 0, ed: 75 } }));
    provenance.rememberMany(ORG, recs);
    recs.forEach((r, i) => {
      assert.deepEqual(provenance.lookup(ORG, r.analysisId).scoringWeights,
        { kw: i, sk: 25 - i, ex: 0, ed: 75 });
    });
  });

  test('a batch that throws partway binds NONE — no partial prefix', () => {
    const recs = batch(50);
    // Poison one in the middle with a value JSON.stringify refuses. Serialising
    // happens inside the transaction, so this fails after 29 rows have been
    // written — exactly the partial-prefix shape being defended against.
    recs[30].scoringWeights = { kw: 1n };
    const before = provenance._count();
    assert.throws(() => provenance.rememberMany(ORG, recs));
    assert.equal(provenance._count(), before, 'the transaction must have rolled back');
    for (const r of recs) {
      assert.equal(provenance.lookup(ORG, r.analysisId), null,
        `${r.analysisId} must NOT be bound — not even the ones before the failure`);
    }
  });

  test('a malformed record aborts the batch before anything is written', () => {
    const recs = batch(10);
    recs[7].engineVersion = 'the colliding key, back again';
    const before = provenance._count();
    assert.throws(() => provenance.rememberMany(ORG, recs), /unexpected keys/);
    assert.equal(provenance._count(), before);
    assert.equal(provenance.lookup(ORG, recs[0].analysisId), null,
      'validation runs over the whole set before the transaction opens');
  });

  test('a record with no analysisId aborts the batch', () => {
    const recs = batch(5);
    delete recs[2].analysisId;
    assert.throws(() => provenance.rememberMany(ORG, recs), /no analysisId/);
    assert.equal(provenance.lookup(ORG, recs[0].analysisId), null);
  });

  test('an empty batch is a no-op, not an error', () => {
    const before = provenance._count();
    assert.equal(provenance.rememberMany(ORG, []), 0);
    assert.equal(provenance.rememberMany(ORG, null), 0);
    assert.equal(provenance.rememberMany(null, batch(2)), 0);
    assert.equal(provenance._count(), before);
  });

  test('batched writes are readable exactly as single ones are', () => {
    // lookup() is untouched by this change; prove it treats both identically.
    const viaSingle = record(nextId());
    const viaBatch = record(nextId());
    provenance.remember(ORG, viaSingle);
    provenance.rememberMany(ORG, [viaBatch]);
    assert.deepEqual(provenance.lookup(ORG, viaSingle.analysisId), viaSingle);
    assert.deepEqual(provenance.lookup(ORG, viaBatch.analysisId), viaBatch);
  });

  test('the single-analysis path still drops one bad record without throwing', () => {
    // remember() is deliberately NOT all-or-nothing: it binds one analysis, and
    // failing it must not 500 the request the user is waiting on.
    const id = nextId();
    const orig = console.error; console.error = () => {};
    try {
      assert.doesNotThrow(() => provenance.remember(ORG, { ...record(id), engineVersion: 'x' }));
    } finally { console.error = orig; }
    assert.equal(provenance.lookup(ORG, id), null);
  });

  test('a better-sqlite3 transaction cannot span an await — why callers collect first', () => {
    // Pins the constraint that shapes the route: wrapping the batch loop where
    // it stands is not merely awkward, it throws AND still writes the rows
    // outside any transaction.
    const tx = db().transaction(async () => { await Promise.resolve(); });
    assert.throws(() => tx(), /cannot return a promise/i);
  });
});
