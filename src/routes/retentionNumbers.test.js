'use strict';

/**
 * src/routes/retentionNumbers.test.js — every document that states the
 * audit-log retention limits states the ones the code enforces.
 *
 * The Privacy Policy, the DPA, the records of processing and the retention
 * policy all said "default 365 days, 30–1095 or keep until deleted" long after
 * the code moved to a 180-day floor (EU AI Act Art. 19), a 730-day default and
 * a 3,650-day ceiling, and stopped accepting 0. The limits are read from
 * src/services/db.js here, so the next change to them fails until the
 * documents follow.
 */

const fs = require('node:fs');
const path = require('node:path');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const DB_SRC = read('src/services/db.js');
const limit = (name) => Number(new RegExp(`const ${name} = (\\d+);`).exec(DB_SRC)[1]);
const FLOOR = limit('RETENTION_FLOOR_DAYS');
const DEFAULT = limit('RETENTION_DEFAULT_DAYS');
const MAX = limit('RETENTION_MAX_DAYS');

const num = (s) => Number(String(s).replace(/[,.  ]/g, ''));
const flat = (s) => s.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>|\*\*/g, '').replace(/&ndash;/g, '–').replace(/\s+/g, ' ');

// Where each document states the audit-log limits.
const DOCUMENTS = {
  'public/privacy.html': (s) => /Retention — defaults and controls([\s\S]*?)Per-candidate erasure/.exec(flat(s).replace(/&mdash;/g, '—'))[1],
  'docs/privacy/dpa-template.md': (s) => /Retention controls:([\s\S]*?)enforced by a daily/.exec(flat(s))[1],
  'docs/privacy/records-of-processing.md': (s) => /\| Retention \| Org-configurable:([^|]*)/.exec(flat(s))[1],
  'docs/privacy/retention-policy.md': (s) => /Audit records \+ change history:([\s\S]*?)Templates, accounts/.exec(flat(s))[1],
};

test('the limits the code enforces', () => {
  assert.deepEqual({ FLOOR, DEFAULT, MAX }, { FLOOR: 180, DEFAULT: 730, MAX: 3650 });
});

describe('each document states exactly the code\'s minimum, default and maximum', () => {
  for (const [file, locate] of Object.entries(DOCUMENTS)) {
    test(file, () => {
      const text = locate(read(file));
      assert.ok(text, `${file}: could not find the retention statement`);
      const def = /default:?\s*([\d,]+)\s*days/i.exec(text);
      assert.ok(def, `${file}: no default stated in "${text.trim()}"`);
      assert.equal(num(def[1]), DEFAULT, `${file}: default`);
      const range = /between\s*([\d,]+)\s*and\s*([\d,]+)\s*days/i.exec(text);
      assert.ok(range, `${file}: no "between … and … days" range in "${text.trim()}"`);
      assert.deepEqual([num(range[1]), num(range[2])], [FLOOR, MAX], `${file}: range`);
      // Every number of days in the statement is one of the three.
      const all = [...text.matchAll(/([\d][\d,]*)\s*(?:days|–|and)/gi)].map((m) => num(m[1]));
      for (const n of all) assert.ok([FLOOR, DEFAULT, MAX].includes(n), `${file}: stray number ${n}`);
      assert.doesNotMatch(text, /keep.until|\b0\b/i, `${file}: the "0 = keep until deleted" option no longer exists`);
    });
  }
});

test('the detector rejects the old numbers (guards a vacuous pass)', () => {
  const old = 'Default: 365 days. Org owners can set retention between 30 and 1095 days, or 0 to keep records until manually deleted';
  assert.notEqual(num(/default:?\s*([\d,]+)\s*days/i.exec(old)[1]), DEFAULT);
  assert.notDeepEqual((/between\s*([\d,]+)\s*and\s*([\d,]+)\s*days/i.exec(old)).slice(1).map(num), [FLOOR, MAX]);
});
