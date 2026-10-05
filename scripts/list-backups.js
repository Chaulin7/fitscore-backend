#!/usr/bin/env node
'use strict';

/**
 * scripts/list-backups.js — which manual database backups are sitting on the
 * data disk, and which are past the 30-day limit.
 *
 * Manual backups (taken before a deploy, a migration or go-live; see the
 * README's "Backing up the production database") must be deleted within 30
 * days — the Privacy Policy and the DPA say so. This is how to find them.
 *
 * READ-ONLY. It lists names, sizes and modification dates. It never opens,
 * reads, moves or deletes a file; deleting is a deliberate step you take
 * yourself with the command in the README.
 *
 *   node scripts/list-backups.js            # the disk DATABASE_PATH lives on
 *   node scripts/list-backups.js --json
 *   node scripts/list-backups.js --dir /opt/render/project/data
 *
 * Listed: every *.db, *.sqlite, *.sqlite3 file (with its -wal / -shm /
 * -journal sidecars) and anything with ".backup" in its name, anywhere under
 * the directory — except the live database and its own sidecars.
 */

const fs = require('fs');
const path = require('path');

const MAX_AGE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const BACKUP_NAME = /\.(?:db|sqlite3?)(?:-wal|-shm|-journal)?$|\.backup/i;

// Same resolution as src/services/db.js, without loading it (that module opens
// nothing on require, but it refuses to run outside a test without a path).
function liveDatabasePath(env = process.env) {
  return path.resolve(env.DATABASE_PATH || env.DB_PATH || path.join(__dirname, '..', 'data', 'audit.db'));
}

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(full, out); }
    else if (e.isFile()) out.push(full); // symlinks are not followed
  }
  return out;
}

/** @returns {{dir: string, live: string, files: Array<{path, size, modified, ageDays, overLimit}>}} */
function listBackups({ dir, live = liveDatabasePath(), now = Date.now() } = {}) {
  const liveAbs = path.resolve(live);
  const base = path.resolve(dir || path.dirname(liveAbs));
  const liveFamily = new Set(['', '-wal', '-shm', '-journal'].map((s) => liveAbs + s));
  const files = walk(base)
    .filter((f) => BACKUP_NAME.test(path.basename(f)) && !liveFamily.has(path.resolve(f)))
    .map((f) => {
      const st = fs.lstatSync(f);
      const ageDays = Math.floor((now - st.mtimeMs) / DAY_MS);
      return { path: path.relative(base, f), size: st.size, modified: new Date(st.mtimeMs).toISOString(), ageDays, overLimit: ageDays > MAX_AGE_DAYS };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
  return { dir: base, live: liveAbs, files };
}

function main(argv = process.argv.slice(2)) {
  const dirArg = argv.indexOf('--dir');
  const result = listBackups({ dir: dirArg >= 0 ? argv[dirArg + 1] : undefined });
  const over = result.files.filter((f) => f.overLimit);
  if (argv.includes('--json')) {
    console.log(JSON.stringify({ ...result, count: result.files.length, overLimit: over.length, maxAgeDays: MAX_AGE_DAYS }, null, 2));
    return;
  }
  console.log(`Data directory: ${result.dir}`);
  console.log(`Live database (not listed): ${path.relative(result.dir, result.live) || result.live}`);
  for (const f of result.files) {
    console.log(`${f.overLimit ? 'OVER 30 DAYS ' : '             '}${f.modified.slice(0, 10)}  ${String(f.size).padStart(12)} B  ${f.path}`);
  }
  const total = result.files.reduce((n, f) => n + f.size, 0);
  console.log(`${result.files.length} backup file(s), ${total} bytes; ${over.length} older than ${MAX_AGE_DAYS} days.`);
}

module.exports = { listBackups, liveDatabasePath, MAX_AGE_DAYS };

if (require.main === module) main();
