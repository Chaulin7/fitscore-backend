'use strict';

/**
 * src/i18n/ui.js — UI languages on the server.
 *
 * Two jobs: hold the dictionaries (locales/*.json), and decide which language
 * a request is answered in. It never touches the candidate pipeline: scoring,
 * extraction, provenance binding and audit rows are language-free by
 * construction, and src/i18n/determinism.test.js fails the build if any of
 * those modules starts reading a language input.
 *
 * DICTIONARIES are required statically, as in ./narrative/index.js: the set of
 * supported languages is readable from this file, and no request value ever
 * becomes a filesystem path. English is the source of truth. A key missing
 * from nl/de is served in English (and listed, so the dev build can warn when
 * it is used); a key present in nl/de but absent from English is dropped.
 * `npm run i18n:check` fails CI on either, so both are development-only states.
 *
 * RESOLUTION ORDER for a page request:
 *   1. a language prefix in the URL (/nl/, /de/) — marketing pages only
 *   2. the `lang` cookie (set by the switcher; mirrors a signed-in user's saved
 *      preference once the app has loaded it)
 *   3. Accept-Language, best supported match by q-value
 *   4. English
 * The signed-in user's preferred_language outranks all of these, but the
 * server cannot apply it at page-render time: the session token lives in
 * localStorage, not a cookie. The app adopts it from /api/auth/me behind the
 * splash screen and refreshes the cookie, so from the next load on the server
 * renders it directly.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const core = require('../../public/i18n.js');

const { SUPPORTED, DEFAULT_LANG, COOKIE_NAME, normalizeLang } = core;

const RAW = Object.freeze({
  en: require('../../locales/en.json'),
  nl: require('../../locales/nl.json'),
  de: require('../../locales/de.json'),
});

const EN_KEYS = Object.keys(RAW.en);

function isFilled(v) { return typeof v === 'string' && v.length > 0; }

function buildLanguage(lang) {
  const raw = RAW[lang];
  const messages = {};
  const fallback = [];
  for (const key of EN_KEYS) {
    if (lang !== DEFAULT_LANG && isFilled(raw[key])) messages[key] = raw[key];
    else {
      messages[key] = RAW.en[key];
      if (lang !== DEFAULT_LANG) fallback.push(key);
    }
  }
  const extra = Object.keys(raw).filter((k) => !Object.prototype.hasOwnProperty.call(RAW.en, k));
  return Object.freeze({ messages: Object.freeze(messages), fallback: Object.freeze(fallback), extra });
}

const LANGS = Object.freeze(Object.fromEntries(SUPPORTED.map((l) => [l, buildLanguage(l)])));

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

/**
 * One content hash for the dictionaries and the client runtime together. It is
 * appended as ?v= to /i18n.js, /i18n.css and /locales/*.json, so a deploy that
 * changes any of them is a new URL to every cache on the path.
 */
const VERSION = crypto.createHash('sha256')
  .update(JSON.stringify(LANGS))
  .update(fs.readFileSync(path.join(PUBLIC_DIR, 'i18n.js')))
  .update(fs.readFileSync(path.join(PUBLIC_DIR, 'i18n.css')))
  .digest('hex')
  .slice(0, 10);

function hasKey(key) { return Object.prototype.hasOwnProperty.call(RAW.en, key); }

/** The merged dictionary for a language (English-filled). */
function messagesFor(lang) {
  return LANGS[normalizeLang(lang) || DEFAULT_LANG].messages;
}

/**
 * The subset of a language's messages under the given namespaces (the first
 * dot-segment of a key), for embedding in a page. Each page only carries the
 * strings its scripts can ask for.
 */
function messagesForNamespaces(lang, namespaces) {
  const all = messagesFor(lang);
  const wanted = new Set(namespaces);
  const out = {};
  for (const key of Object.keys(all)) {
    if (wanted.has(key.split('.')[0])) out[key] = all[key];
  }
  return out;
}

function fallbackFor(lang) { return LANGS[normalizeLang(lang) || DEFAULT_LANG].fallback; }

/** Server-side plain-text translation, same rules as the browser's t(). */
function t(lang, key, vars) {
  const l = normalizeLang(lang) || DEFAULT_LANG;
  const template = core.pick(messagesFor(l), key, vars, l);
  if (template == null) return null;
  return core.interpolate(template, vars, l);
}

// --- request language ----------------------------------------------------------

function langFromCookie(cookieHeader) {
  const m = new RegExp('(?:^|;)\\s*' + COOKIE_NAME + '=([^;]*)').exec(String(cookieHeader || ''));
  if (!m) return null;
  let value = m[1].trim();
  try { value = decodeURIComponent(value); } catch (_) { return null; }
  return /^[a-z]{2}$/i.test(value) ? normalizeLang(value) : null;
}

/**
 * Best supported language from an Accept-Language header. q=0 means "not
 * acceptable" and is skipped; ties keep header order. Returns null when
 * nothing listed is supported (the caller then uses English).
 */
function langFromAcceptLanguage(header) {
  if (typeof header !== 'string' || !header.trim()) return null;
  const ranges = header.split(',').map((part, index) => {
    const [tag, ...params] = part.trim().split(';');
    let q = 1;
    for (const p of params) {
      if (!/^\s*q\s*=/i.test(p)) continue;
      // A q we cannot read makes the range unusable rather than preferred.
      const m = /^\s*q\s*=\s*([0-9]+(?:\.[0-9]*)?)\s*$/i.exec(p);
      q = m ? Math.min(Number(m[1]), 1) : 0;
    }
    return { tag: tag.trim(), q: Number.isFinite(q) ? q : 0, index };
  }).filter((r) => r.tag && r.q > 0);
  ranges.sort((a, b) => b.q - a.q || a.index - b.index);
  for (const r of ranges) {
    const lang = normalizeLang(r.tag);
    if (lang) return lang;
  }
  return null;
}

/**
 * @param {import('express').Request} req
 * @param {{fixed?: string}} [opts] `fixed` — the URL already names the
 *   language (a /nl/ or /de/ marketing variant), which always wins.
 * @returns {{lang: string, source: 'url'|'cookie'|'accept-language'|'default'}}
 */
function resolveRequestLanguage(req, opts = {}) {
  const fixed = normalizeLang(opts.fixed);
  if (fixed) return { lang: fixed, source: 'url' };
  const fromCookie = langFromCookie(req.headers && req.headers.cookie);
  if (fromCookie) return { lang: fromCookie, source: 'cookie' };
  const fromHeader = langFromAcceptLanguage(req.headers && req.headers['accept-language']);
  if (fromHeader) return { lang: fromHeader, source: 'accept-language' };
  return { lang: DEFAULT_LANG, source: 'default' };
}

/**
 * Validate a preferred_language value from a client. null clears the
 * preference (fall back to cookie / browser language).
 * @returns {{ok: true, value: string|null} | {ok: false}}
 */
function validatePreferredLanguage(value) {
  if (value === null) return { ok: true, value: null };
  if (typeof value === 'string' && SUPPORTED.includes(value)) return { ok: true, value };
  return { ok: false };
}

/** Say once, at boot, what is still falling back to English. Dev only. */
function logFallbacks(log) {
  if (process.env.NODE_ENV === 'production') return;
  for (const lang of SUPPORTED) {
    if (lang === DEFAULT_LANG) continue;
    const { fallback, extra } = LANGS[lang];
    if (fallback.length) log(`[i18n] ${lang}: ${fallback.length} key(s) not translated, served in English`);
    if (extra.length) log(`[i18n] ${lang}: ${extra.length} key(s) not in en.json, ignored`);
  }
}

module.exports = {
  SUPPORTED,
  DEFAULT_LANG,
  COOKIE_NAME,
  VERSION,
  RAW,
  core,
  normalizeLang,
  hasKey,
  messagesFor,
  messagesForNamespaces,
  fallbackFor,
  t,
  langFromCookie,
  langFromAcceptLanguage,
  resolveRequestLanguage,
  validatePreferredLanguage,
  logFallbacks,
};
