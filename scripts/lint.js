#!/usr/bin/env node
'use strict';

/**
 * scripts/lint.js — `npm run lint`: the CI syntax gate, runnable locally.
 *
 * `node --check` parses each file without executing it (see the comment on
 * the Lint step in .github/workflows/ci.yml for why that matters here: no
 * app.listen, no database). Covers src/, scripts/, test/ and the one browser
 * script that is also required by the server (public/i18n.js), and parses the
 * locale dictionaries as JSON.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIRS = ['src', 'scripts', 'test'];
const EXTRA = ['public/i18n.js'];

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'output') continue;
      walk(full, out);
    } else if (/\.(c|m)?js$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const files = DIRS.flatMap((d) => (fs.existsSync(path.join(ROOT, d)) ? walk(path.join(ROOT, d), []) : []))
  .concat(EXTRA.map((f) => path.join(ROOT, f)));

let failed = 0;
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    failed += 1;
    process.stderr.write(`${path.relative(ROOT, file)}\n${String(err.stderr || err.message)}\n`);
  }
}

const locales = fs.readdirSync(path.join(ROOT, 'locales')).filter((f) => f.endsWith('.json'));
for (const f of locales) {
  try { JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', f), 'utf8')); }
  catch (err) { failed += 1; process.stderr.write(`locales/${f}: ${err.message}\n`); }
}

if (failed) {
  console.error(`lint: ${failed} file(s) failed`);
  process.exit(1);
}
console.log(`syntax OK — ${files.length} files, ${locales.length} locale dictionaries`);
