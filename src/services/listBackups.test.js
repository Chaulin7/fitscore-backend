'use strict';

/**
 * src/services/listBackups.test.js — scripts/list-backups.js finds every manual
 * backup on the data disk (never the live database), flags the ones past the
 * 30-day limit, and only ever looks at names, sizes and dates.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'list-backups.js');
const { listBackups, MAX_AGE_DAYS } = require(SCRIPT);

const NOW = Date.parse('2026-10-05T12:00:00.000Z');
const DAY = 86400000;

function disk() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cvs-backups-'));
  const put = (rel, ageDays, content = 'SECRET-CONTENT') => {
    const f = path.join(dir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, content);
    const t = new Date(NOW - ageDays * DAY);
    fs.utimesSync(f, t, t);
  };
  put('audit.db', 0); put('audit.db-wal', 0); put('audit.db-shm', 0); // live
  put('audit.db.backup-2026-10-01', 4);
  put('audit.db.backup-2026-08-01', 65);
  put('backups/pre-deploy.db', 90); put('backups/pre-deploy.db-wal', 90); put('backups/pre-deploy.db-shm', 90);
  put('backups/old.sqlite', 31);
  put('backups/exactly-30.sqlite3', 30);
  put('uploads/cv.pdf', 1); put('notes.txt', 1);
  return dir;
}

test('lists every backup, never the live database or unrelated files, and flags the ones over 30 days', () => {
  const dir = disk();
  try {
    const r = listBackups({ live: path.join(dir, 'audit.db'), now: NOW });
    assert.equal(MAX_AGE_DAYS, 30);
    assert.deepEqual(r.files.map((f) => f.path), [
      'audit.db.backup-2026-08-01', 'audit.db.backup-2026-10-01',
      path.join('backups', 'exactly-30.sqlite3'), path.join('backups', 'old.sqlite'),
      path.join('backups', 'pre-deploy.db'), path.join('backups', 'pre-deploy.db-shm'), path.join('backups', 'pre-deploy.db-wal'),
    ]);
    const over = Object.fromEntries(r.files.map((f) => [f.path, f.overLimit]));
    assert.equal(over['audit.db.backup-2026-10-01'], false);
    assert.equal(over[path.join('backups', 'exactly-30.sqlite3')], false, '30 days is still within the limit');
    assert.equal(over[path.join('backups', 'old.sqlite')], true);
    assert.equal(over[path.join('backups', 'pre-deploy.db')], true);
    for (const f of r.files) assert.equal(f.size, 'SECRET-CONTENT'.length);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the command prints names, sizes and dates — never contents — and changes nothing', () => {
  const dir = disk();
  try {
    const before = fs.readdirSync(dir, { recursive: true }).sort();
    const out = execFileSync(process.execPath, [SCRIPT], { env: { ...process.env, DATABASE_PATH: path.join(dir, 'audit.db') }, encoding: 'utf8' });
    assert.match(out, /7 backup file\(s\), 98 bytes; \d older than 30 days\./);
    assert.match(out, /OVER 30 DAYS .*pre-deploy\.db/);
    assert.doesNotMatch(out, /SECRET-CONTENT/);
    assert.doesNotMatch(out, /cv\.pdf|notes\.txt/);
    assert.deepEqual(fs.readdirSync(dir, { recursive: true }).sort(), before, 'nothing created, moved or deleted');
    const json = JSON.parse(execFileSync(process.execPath, [SCRIPT, '--json', '--dir', dir], { env: { ...process.env, DATABASE_PATH: path.join(dir, 'audit.db') }, encoding: 'utf8' }));
    assert.equal(json.count, 7);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the script cannot read, write or delete a file', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(src, /readFile|createReadStream|openSync|\.open\(|writeFile|appendFile|unlink|rmSync|rmdir|\brm\(|rename|copyFile|truncate/);
});
