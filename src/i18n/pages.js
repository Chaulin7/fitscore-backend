'use strict';

/**
 * src/i18n/pages.js — the served HTML pages, one pre-rendered variant per
 * language, and the routes that choose between them.
 *
 * Every variant is built ONCE, at startup, from the templates src/index.js has
 * already substituted (pricing JSON-LD, legal footer, media URLs). A request
 * only picks a variant and stamps its CSP nonce, exactly as before — the
 * translation cost is paid at boot, and the first paint is already in the
 * visitor's language (no flash of English, and no JS needed to read the page).
 *
 * PAGE KINDS
 *   marketing     Public pages with SEO variants: English at the plain URL,
 *                 Dutch and German under /nl/ and /de/. A prefixed URL always
 *                 wins; the plain URL is negotiated (cookie, then
 *                 Accept-Language). Each variant carries a self-referencing
 *                 canonical and hreflang alternates for en/nl/de/x-default,
 *                 and its same-site links point at same-language variants.
 *                 The switcher is a set of real links to those variants.
 *   app           The product. One URL per screen, language negotiated; the
 *                 switcher re-renders in place and the account remembers it.
 *   english-only  Terms and Privacy Policy. Legal text is not machine-
 *                 translated: these stay English (lang="en") on every request
 *                 until a reviewed translation exists. See the PR's legal list.
 *
 * CACHING. The same URL now answers in three languages, so no HTML response
 * may be stored by a shared cache: every page goes out with
 * `Cache-Control: private, no-store` and `Vary: Cookie, Accept-Language`
 * (Vary alone is not enough — Cloudflare, for one, ignores Vary on HTML).
 * The per-request nonce already made these responses uncacheable in practice;
 * this makes it explicit. src/i18n/pages.test.js pins the headers.
 */

const express = require('express');
const ui = require('./ui');
const { localizeMarkup, setDocumentLang, rewriteLinks } = require('./prerender');
const { configuredBaseUrl } = require('../config/appUrl');

const { SUPPORTED, DEFAULT_LANG, VERSION, core } = ui;
const IS_PROD = process.env.NODE_ENV === 'production';

const PAGE_CONFIG = Object.freeze({
  'index.html': { kind: 'marketing', path: '/', aliases: ['/index.html'], namespaces: ['common', 'lang', 'landing', 'pricing'] },
  'bias-report.html': { kind: 'marketing', path: '/bias-report.html', namespaces: ['common', 'lang', 'bias'] },
  'integrations.html': { kind: 'marketing', path: '/integrations.html', namespaces: ['common', 'lang', 'integrations'] },
  'demo-transcript.html': { kind: 'marketing', path: '/demo-transcript', aliases: ['/demo-transcript.html'], namespaces: ['common', 'lang', 'transcript'] },
  // Shell only (top bar, footer, title, copy buttons). The body is
  // regulatory prose and stays English, marked lang="en" in the markup.
  'compliance.html': { kind: 'marketing', path: '/compliance.html', namespaces: ['common', 'lang', 'compliance'] },
  // `errors` because the form shows the API's error codes translated.
  'contact.html': { kind: 'marketing', path: '/contact', aliases: ['/contact.html'], namespaces: ['common', 'lang', 'contact', 'errors'] },
  'app.html': { kind: 'app', namespaces: ['common', 'lang', 'auth', 'errors', 'settings', 'app'] },
  'terms.html': { kind: 'english-only' },
  'privacy.html': { kind: 'english-only' },
});

const MARKETING_PAGES = Object.keys(PAGE_CONFIG).filter((p) => PAGE_CONFIG[p].kind === 'marketing');
const SWITCHER_TOKEN = /__LANG_SWITCHER(?:_([A-Z]+))?__/g;

/** The URL of a marketing page's variant in `lang`. */
function variantPath(page, lang) {
  const base = PAGE_CONFIG[page].path;
  if (lang === DEFAULT_LANG) return base;
  return '/' + lang + (base === '/' ? '/' : base);
}

/** unprefixed path -> same page in `lang`, for every marketing URL. */
function routesFor(lang) {
  const routes = {};
  for (const page of MARKETING_PAGES) {
    const target = variantPath(page, lang);
    for (const p of [PAGE_CONFIG[page].path, ...(PAGE_CONFIG[page].aliases || [])]) routes[p] = target;
  }
  return routes;
}

function absolute(p) {
  const origin = configuredBaseUrl();
  return origin ? new URL(p, origin).toString() : p;
}

function esc(s) { return core.escapeHtml(s); }

function flagImg(lang) {
  return `<img class="lang-flag" src="/assets/flags/${core.FLAG_FILES[lang]}.svg" alt="" width="20" height="15">`;
}

/**
 * The switcher. `variant` picks the styling (DARK on the navy bars, LIGHT on
 * the paper-coloured landing nav, DRAWER inside the app's mobile menu). Ids are
 * numbered per page so several switchers can coexist.
 */
function switcherHtml(page, lang, variant, n) {
  const cfg = PAGE_CONFIG[page];
  const mod = (variant || 'DARK').toLowerCase();
  const label = ui.t(lang, 'lang.switcher.label', { language: core.NATIVE_NAMES[lang] });
  const btnId = `langBtn-${n}`;
  const menuId = `langMenu-${n}`;
  const items = SUPPORTED.map((l) => {
    const common = `class="lang-item" role="menuitemradio" aria-checked="${l === lang}" lang="${l}" data-action="selectLang" data-lang="${l}" tabindex="-1"`;
    const body = `${flagImg(l)}<span class="lang-name">${esc(core.NATIVE_NAMES[l])}</span>`;
    return cfg.kind === 'marketing'
      ? `<li role="none"><a ${common} href="${esc(variantPath(page, l))}" hreflang="${l}">${body}</a></li>`
      : `<li role="none"><button type="button" ${common}>${body}</button></li>`;
  }).join('');
  return `<div class="lang-switch lang-switch--${mod}" data-lang-switch>`
    + `<button type="button" class="lang-switch-btn" id="${btnId}" data-action="toggleLangMenu" aria-haspopup="menu" aria-expanded="false" aria-controls="${menuId}" aria-label="${esc(label)}" title="${esc(label)}">`
    + flagImg(lang)
    + (mod === 'drawer' ? `<span class="lang-switch-label">${esc(core.NATIVE_NAMES[lang])}</span>` : '')
    + '<svg class="lang-caret" viewBox="0 0 10 6" width="10" height="6" aria-hidden="true" focusable="false"><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    + '</button>'
    + `<ul class="lang-menu" id="${menuId}" role="menu" aria-labelledby="${btnId}" hidden>${items}</ul>`
    + '</div>';
}

/** Page-level data for the client runtime, as a JSON data block. */
function dictBlock(page, lang) {
  const cfg = PAGE_CONFIG[page];
  const namespaces = new Set(cfg.namespaces);
  const payload = {
    lang,
    mode: cfg.kind === 'marketing' ? 'prefixed' : 'negotiated',
    dev: !IS_PROD,
    version: VERSION,
    alternates: cfg.kind === 'marketing'
      ? Object.fromEntries(SUPPORTED.map((l) => [l, variantPath(page, l)]))
      : {},
    messages: ui.messagesForNamespaces(lang, cfg.namespaces),
    fallback: IS_PROD ? [] : ui.fallbackFor(lang).filter((k) => namespaces.has(k.split('.')[0])),
  };
  // `<` escaped so no string in the payload can close the element. The block
  // is type="application/json": parsed by i18n.js, never executed.
  const json = JSON.stringify(payload).replace(/</g, '\\u003c');
  return `<script type="application/json" id="i18n-dict" nonce="__CSP_NONCE__">${json}</script>`;
}

function headHtml(page, lang) {
  const cfg = PAGE_CONFIG[page];
  const parts = [`<link rel="stylesheet" href="/i18n.css?v=${VERSION}">`];
  if (cfg.kind === 'marketing') {
    parts.push(`<link rel="canonical" href="${esc(absolute(variantPath(page, lang)))}">`);
    for (const l of SUPPORTED) {
      parts.push(`<link rel="alternate" hreflang="${l}" href="${esc(absolute(variantPath(page, l)))}">`);
    }
    parts.push(`<link rel="alternate" hreflang="x-default" href="${esc(absolute(variantPath(page, DEFAULT_LANG)))}">`);
  }
  parts.push(dictBlock(page, lang));
  parts.push(`<script src="/i18n.js?v=${VERSION}" nonce="__CSP_NONCE__"></script>`);
  return parts.join('\n');
}

function englishOnlyNotice(lang) {
  if (lang === DEFAULT_LANG) return '';
  return `<div class="i18n-english-only" role="note" lang="${lang}">${esc(ui.t(lang, 'common.englishOnly'))}</div>`;
}

/**
 * Build every variant of every page.
 * @param {Record<string,string>} templates page file name -> startup-substituted HTML
 * @returns {{variants: Record<string, Record<string,string>>, problems: string[]}}
 */
function buildVariants(templates) {
  const variants = {};
  const problems = [];
  for (const [page, html] of Object.entries(templates)) {
    const cfg = PAGE_CONFIG[page];
    if (!cfg || cfg.kind === 'english-only') {
      variants[page] = { [DEFAULT_LANG]: html };
      continue;
    }
    const heads = html.split('__I18N_HEAD__').length - 1;
    if (heads !== 1) problems.push(`${page}: expected one __I18N_HEAD__ placeholder in <head>, found ${heads}`);
    variants[page] = {};
    for (const lang of SUPPORTED) {
      const messages = ui.messagesFor(lang);
      let out = localizeMarkup(html, {
        lang,
        lookup: (key, vars) => core.pick(messages, key, vars, lang),
        onProblem: (p) => problems.push(`${page} [${lang}]: ${p}`),
      });
      out = setDocumentLang(out, lang);
      if (cfg.kind === 'marketing' && lang !== DEFAULT_LANG) out = rewriteLinks(out, routesFor(lang));
      out = out.replace('__I18N_HEAD__', () => headHtml(page, lang));
      let n = 0;
      out = out.replace(SWITCHER_TOKEN, (_, variant) => switcherHtml(page, lang, variant, ++n));
      out = out.replace(/__I18N_ENGLISH_ONLY__/g, () => englishOnlyNotice(lang));
      variants[page][lang] = out;
    }
  }
  return { variants, problems };
}

function setHtmlHeaders(res, lang) {
  res.set('Content-Type', 'text/html; charset=utf-8');
  // Never a shared cache: the body depends on the cookie and Accept-Language
  // (and carries a per-request CSP nonce besides).
  res.set('Cache-Control', 'private, no-store');
  res.vary('Cookie');
  res.vary('Accept-Language');
  res.set('Content-Language', lang);
}

/**
 * @param {Record<string,string>} templates
 * @param {{log?: (msg: string) => void}} [opts]
 * @returns {{router: import('express').Router, serve: (page: string, fixedLang?: string) => import('express').RequestHandler, variants: object, problems: string[]}}
 */
function createPages(templates, opts = {}) {
  const log = opts.log || ((m) => console.error(m));
  const { variants, problems } = buildVariants(templates);
  // Loud, not fatal: a missing key renders the English markup untouched. The
  // test suite keeps this list empty, so production never takes this path.
  for (const p of problems) log('[i18n] ' + p);
  ui.logFallbacks(log);

  function serve(page, fixedLang) {
    const cfg = PAGE_CONFIG[page];
    return (req, res) => {
      const lang = !cfg || cfg.kind === 'english-only'
        ? DEFAULT_LANG
        : ui.resolveRequestLanguage(req, { fixed: fixedLang }).lang;
      const html = (variants[page] && (variants[page][lang] || variants[page][DEFAULT_LANG])) || '';
      setHtmlHeaders(res, lang);
      res.send(html.replaceAll('__CSP_NONCE__', res.locals.cspNonce));
    };
  }

  // strict: '/nl' (redirect) and '/nl/' (the page) are different routes.
  const router = express.Router({ strict: true });

  for (const lang of SUPPORTED) {
    if (lang === DEFAULT_LANG) continue;
    router.get('/' + lang, (req, res) => {
      const query = req.originalUrl.slice(req.path.length);
      res.redirect(301, '/' + lang + '/' + query);
    });
    for (const page of MARKETING_PAGES) {
      router.get(variantPath(page, lang), serve(page, lang));
      for (const alias of PAGE_CONFIG[page].aliases || []) {
        if (alias !== '/index.html') router.get('/' + lang + alias, serve(page, lang));
      }
    }
  }

  // Dictionaries for a live switch in the app. Computed once; the page asks for
  // them with ?v=<VERSION>, so a deploy is a new URL.
  const LOCALE_BODIES = Object.fromEntries(SUPPORTED.map((l) => [l, JSON.stringify({
    lang: l, version: VERSION, messages: ui.messagesFor(l), fallback: IS_PROD ? [] : ui.fallbackFor(l),
  })]));
  router.get('/locales/:file', (req, res) => {
    const m = /^([a-z]{2})\.json$/.exec(req.params.file);
    if (!m || !SUPPORTED.includes(m[1])) return res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
    res.set('Content-Type', 'application/json; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=300');
    return res.send(LOCALE_BODIES[m[1]]);
  });

  return { router, serve, variants, problems };
}

module.exports = {
  PAGE_CONFIG,
  MARKETING_PAGES,
  variantPath,
  routesFor,
  buildVariants,
  createPages,
  switcherHtml,
};
