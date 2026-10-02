#!/usr/bin/env node
'use strict';

/**
 * scripts/i18n-check.js — `npm run i18n:check`. Fails (exit 1) when the
 * dictionaries and the pages that use them disagree.
 *
 * English (locales/en.json) is the source of truth. For nl and de:
 *   - every English key must exist, and no key may exist that English lacks
 *   - no value may be empty
 *   - the {placeholders} must be exactly English's
 *   - `_html` keys must use exactly English's inline tags (same tags, same
 *     count), and only the allowlisted ones; plain keys may use none
 * And for the pages:
 *   - every data-i18n / data-i18n-html / data-i18n-attr key exists in English
 *   - every translation key named as a string literal in a page script exists
 *   - rich markup is only ever put on `_html` keys, and vice versa
 *
 * Unused English keys are reported as a warning, not a failure: some are read
 * by prefix (plans.* in src/config/plans.js).
 *
 * Also run by src/i18n/check.test.js, so `npm test` enforces it too.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const core = require(path.join(ROOT, 'public', 'i18n.js'));
const { scan } = require(path.join(ROOT, 'src', 'i18n', 'prerender.js'));
const { PAGE_CONFIG } = require(path.join(ROOT, 'src', 'i18n', 'pages.js'));

const NAMESPACES = ['lang', 'common', 'landing', 'pricing', 'plans', 'bias', 'integrations',
  'transcript', 'compliance', 'contact', 'imprint', 'auth', 'errors', 'settings', 'app'];
const KEY_LITERAL = new RegExp(`['"]((?:${NAMESPACES.join('|')})\\.[A-Za-z0-9_.]+)['"]`, 'g');
const TAG_LIKE = /<\/?[a-zA-Z][^>]*>/;
// 'integrations.html', 'app.html' … are file names, not keys.
const FILE_NAME = /\.(html|js|json|css|svg|png|pdf)$/;

function keyLiterals(src) {
  return [...src.matchAll(KEY_LITERAL)].map((m) => m[1]).filter((k) => !FILE_NAME.test(k));
}

function readLocale(lang) {
  const file = path.join(ROOT, 'locales', lang + '.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function placeholders(s) {
  return [...String(s).matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]).sort().join(',');
}

function scripts(html) {
  return [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
    .filter((m) => !/type="application\/(ld\+)?json"/i.test(m[0]))
    .map((m) => m[1])
    .join('\n');
}

/** A key exists directly or as a plural family (key.one / key.other). */
function exists(en, key) {
  return Object.prototype.hasOwnProperty.call(en, key)
    || Object.prototype.hasOwnProperty.call(en, key + '.other');
}

/**
 * @param {{readLocale?: (lang: string) => object}} [opts] tests substitute
 *   dictionaries here to prove each rule fires.
 * @returns {{errors: string[], warnings: string[], stats: object}}
 */
function check(opts = {}) {
  const load = opts.readLocale || readLocale;
  const errors = [];
  const warnings = [];
  const en = load('en');
  const enKeys = Object.keys(en);

  // --- English itself ---------------------------------------------------------
  for (const key of enKeys) {
    const v = en[key];
    if (typeof v !== 'string' || !v.length) { errors.push(`en: ${key} is empty`); continue; }
    if (core.isRichKey(key)) {
      try { core.tokenizeRich(v); } catch (err) { errors.push(`en: ${key}: ${err.message}`); }
      const stray = v.replace(/<(\/?)(strong|em|b|i|code|kbd|sup|sub|br|a[0-9])\s*\/?>/g, '');
      if (TAG_LIKE.test(stray)) errors.push(`en: ${key} uses a tag outside the allowlist`);
    } else if (TAG_LIKE.test(v)) {
      errors.push(`en: ${key} contains markup but is not an _html key`);
    }
  }

  // --- nl / de against English ------------------------------------------------
  for (const lang of core.SUPPORTED.filter((l) => l !== 'en')) {
    let dict;
    try { dict = load(lang); } catch (err) { errors.push(`${lang}: cannot parse: ${err.message}`); continue; }
    for (const key of enKeys) {
      if (!Object.prototype.hasOwnProperty.call(dict, key)) { errors.push(`${lang}: missing ${key}`); continue; }
      const v = dict[key];
      if (typeof v !== 'string' || !v.length) { errors.push(`${lang}: ${key} is empty`); continue; }
      if (placeholders(v) !== placeholders(en[key])) {
        errors.push(`${lang}: ${key} placeholders {${placeholders(v)}} differ from English {${placeholders(en[key])}}`);
      }
      if (core.isRichKey(key)) {
        try {
          const mine = core.richTagsOf(v).join(' ');
          const theirs = core.richTagsOf(en[key]).join(' ');
          if (mine !== theirs) errors.push(`${lang}: ${key} tags [${mine}] differ from English [${theirs}]`);
        } catch (err) { errors.push(`${lang}: ${key}: ${err.message}`); }
      } else if (TAG_LIKE.test(v)) {
        errors.push(`${lang}: ${key} contains markup but is not an _html key`);
      }
    }
    for (const key of Object.keys(dict)) {
      if (!Object.prototype.hasOwnProperty.call(en, key)) errors.push(`${lang}: ${key} is not in en.json`);
    }
  }

  // --- the pages ----------------------------------------------------------------
  const used = new Set();
  for (const page of Object.keys(PAGE_CONFIG)) {
    const html = fs.readFileSync(path.join(ROOT, 'public', page), 'utf8');
    if (PAGE_CONFIG[page].kind === 'english-only') {
      if (/\sdata-i18n/.test(html.replace(/<!--[\s\S]*?-->/g, ''))) errors.push(`${page}: english-only page carries data-i18n markup`);
      continue;
    }
    for (const item of scan(html)) {
      used.add(item.key);
      if (!exists(en, item.key)) errors.push(`${page}: <${item.tag}> uses unknown key ${item.key}`);
      if (item.kind === 'rich' && !core.isRichKey(item.key)) errors.push(`${page}: data-i18n-html="${item.key}" must name an _html key`);
      if (item.kind === 'text' && core.isRichKey(item.key)) errors.push(`${page}: data-i18n="${item.key}" names an _html key; use data-i18n-html`);
    }
    for (const key of keyLiterals(scripts(html))) {
      used.add(key);
      if (!exists(en, key)) errors.push(`${page}: script references unknown key ${key}`);
    }
  }
  // Read by the server, not a page.
  for (const src of ['src/i18n/pages.js', 'public/i18n.js']) {
    for (const key of keyLiterals(fs.readFileSync(path.join(ROOT, src), 'utf8'))) {
      used.add(key);
      if (!exists(en, key)) errors.push(`${src}: references unknown key ${key}`);
    }
  }
  const unused = enKeys.filter((k) => {
    const base = k.replace(/\.(zero|one|other)$/, '');
    return !used.has(k) && !used.has(base) && !k.startsWith('plans.') && !k.startsWith('errors.');
  });
  if (unused.length) warnings.push(`en: ${unused.length} key(s) not referenced by any page: ${unused.join(', ')}`);

  return { errors, warnings, stats: { keys: enKeys.length, languages: core.SUPPORTED } };
}

module.exports = { check, readLocale };

if (require.main === module) {
  const { errors, warnings, stats } = check();
  for (const w of warnings) console.warn('warning: ' + w);
  if (errors.length) {
    for (const e of errors) console.error('error: ' + e);
    console.error(`\ni18n:check failed — ${errors.length} problem(s).`);
    process.exit(1);
  }
  console.log(`i18n:check OK — ${stats.keys} keys × ${stats.languages.join('/')}`);
}
