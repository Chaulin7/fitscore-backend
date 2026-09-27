'use strict';

/**
 * src/services/dbPathDocs.test.js — the database path and the backup method.
 *
 * This is the second time a wrong production path in prose has cost something.
 * The README claimed `/var/data/audit.db`, a directory that does not exist on
 * Render; `docs/extraction-determinism.md` records a third path again. The
 * consequence was not a broken build — it was a backup taken with `cp` against a
 * WAL database, producing a 4 KB file beside an 800 KB `-wal` that would have
 * restored as very nearly empty.
 *
 * Prose cannot be type-checked, so these assert the two things that actually
 * went wrong: that no document hands out a stale absolute path as instruction,
 * and that the backup method is documented and is `.backup` rather than `cp`.
 */

const fs = require('node:fs');
const path = require('node:path');

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Every markdown file that could tell somebody where the database is. */
function docFiles() {
  const out = ['README.md'];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (entry.name.endsWith('.md')) out.push(rel);
    }
  };
  walk('docs');
  return out;
}

describe('no document hands out a stale production database path', () => {
  test('/var/data appears nowhere as an instruction', () => {
    for (const file of docFiles()) {
      const body = read(file);
      const offending = body.split('\n')
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => line.includes('/var/data'))
        // The README's own explanation of the mistake is allowed to name it.
        .filter(({ line }) => !/earlier revision|claimed/.test(line));
      assert.deepEqual(offending, [],
        `${file} names /var/data, which does not exist on Render: `
        + offending.map((o) => `line ${o.n}`).join(', '));
    }
  });

  test('the historical invocation is marked as not-to-be-copied', () => {
    // docs/extraction-determinism.md deliberately preserves a July 2026 command
    // with an old path. Rewriting it would falsify the record, so it carries a
    // warning instead — and that warning is what this pins.
    const body = read('docs/extraction-determinism.md');
    assert.match(body, /Do not copy\s*\n?>?\s*it\.|\*\*Do not copy/,
      'the stale path in this file must stay labelled as a record, not an instruction');
    assert.match(body, /DB_PATH="\$DATABASE_PATH"/,
      'and must offer the environment-driven form to actually use');
  });

  test('the README tells the reader to read the path from the environment', () => {
    const body = read('README.md');
    assert.match(body, /Read it from the environment/i);
    assert.match(body, /echo "\$DATABASE_PATH"/,
      'with the command to do it');
  });
});

describe('the backup method is documented, and it is not cp', () => {
  const body = () => read('README.md');

  test('the .backup command is present and complete', () => {
    assert.match(body(), /sqlite3 "\$DATABASE_PATH" "\.backup/,
      'the README must carry the runnable .backup command');
  });

  test('it explains why cp is wrong for a WAL database', () => {
    const b = body();
    assert.match(b, /WAL/, 'names WAL mode');
    assert.match(b, /-wal/, 'names the sidecar');
    assert.match(b, /\bcp\b/, 'and contrasts it with cp');
  });

  test('it cites the broken backup that already exists', () => {
    // A concrete, checkable instance beats an abstract warning: this is the one
    // that would have lost data.
    const b = body();
    assert.match(b, /pre-deploy\.db/);
    assert.match(b, /4 ?KB/i);
    assert.match(b, /800 ?KB/i);
  });

  test('it says a cp-style backup needs all three files kept together', () => {
    const b = body();
    assert.match(b, /-shm/, 'names the third file');
    assert.match(b, /together/i);
  });

  test('the billing deploy doc points at it rather than restating it', () => {
    const billing = read('docs/billing/README.md');
    assert.match(billing, /backing-up-the-production-database/,
      'the going-live section must link to the one canonical copy');
    assert.equal(/sqlite3 "\$DATABASE_PATH"/.test(billing), false,
      'and must NOT carry its own copy of the command, which would drift');
  });
});
