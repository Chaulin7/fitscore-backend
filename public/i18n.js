/*
 * public/i18n.js — the CVsprings UI translation runtime.
 *
 * One file, two hosts. In the browser it defines window.I18N; under Node
 * (require('../../public/i18n.js')) it exports the pure core, which the server
 * uses to pre-render every page in every language at startup. Interpolation,
 * plural selection and the rich-text parser therefore exist exactly once: a
 * page the server rendered and the same page re-rendered by a live language
 * switch cannot disagree about what a key says.
 *
 * DICTIONARY. The server embeds the active language's messages in
 *   <script type="application/json" id="i18n-dict">…</script>
 * — a data block, parsed here, never executed. Missing nl/de keys have already
 * been filled from English by the server; in development it also lists which
 * keys fell back, and t() warns the first time one is used.
 *
 * SAFETY. t() returns plain text. Nothing in this file assigns innerHTML:
 * text goes in through textContent, attributes through setAttribute, and the
 * few keys that need inline markup (names ending in `_html`) are built node by
 * node from a closed tag allowlist. Interpolated values — candidate names,
 * org names, file names — are inserted as text nodes AFTER the markup has been
 * parsed, so a value can never become markup. Links inside rich text are
 * referenced by index (<a0>…</a0>); their attributes come from the page's own
 * markup or from the calling code, never from a dictionary.
 *
 * Wired through the page's data-action delegation (Helmet sets
 * script-src-attr 'none'); this file registers its own delegated listeners for
 * the language switcher and adds no inline handlers.
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module && module.exports) module.exports = api.core;
  else if (root) root.I18N = api.browser;
})(typeof window !== 'undefined' ? window : null, function (root) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Core (pure; shared with the server)
  // ---------------------------------------------------------------------------

  var SUPPORTED = ['en', 'nl', 'de'];
  var DEFAULT_LANG = 'en';
  var INTL_LOCALES = { en: 'en-GB', nl: 'nl-NL', de: 'de-DE' };
  // Native names, deliberately NOT translated: a reader looking for their own
  // language must recognise it whatever language the page is currently in.
  var NATIVE_NAMES = { en: 'English', nl: 'Nederlands', de: 'Deutsch' };
  var FLAG_FILES = { en: 'gb', nl: 'nl', de: 'de' };
  var COOKIE_NAME = 'lang';
  var COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

  // Inline tags a `_html` key may use. Anything else that looks like a tag is
  // treated as text (and rejected by `npm run i18n:check`). a0…a9 are links
  // whose attributes the caller supplies.
  var RICH_TAGS = ['strong', 'em', 'b', 'i', 'code', 'kbd', 'sup', 'sub'];
  var RICH_VOID = ['br'];
  var RICH_TOKEN = /<(\/?)(strong|em|b|i|code|kbd|sup|sub|br|a[0-9])\s*\/?>/g;
  var PLACEHOLDER = /\{([A-Za-z0-9_]+)\}/g;

  var hasOwn = function (o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); };

  /** 'nl', 'nl-BE', 'NL_nl' -> 'nl'; anything unsupported -> null. */
  function normalizeLang(value) {
    if (typeof value !== 'string') return null;
    var primary = value.trim().toLowerCase().split(/[-_]/)[0];
    return SUPPORTED.indexOf(primary) >= 0 ? primary : null;
  }

  function isRichKey(key) { return /_html$/.test(key); }

  function pluralCategory(lang, n) {
    try { return new Intl.PluralRules(INTL_LOCALES[lang] || INTL_LOCALES.en).select(n); }
    catch (_) { return n === 1 ? 'one' : 'other'; }
  }

  /**
   * The template for a key, honouring plurals. With a numeric `count` var the
   * lookup tries `key.zero` (count 0 only), then `key.<CLDR category>`, then
   * `key.other`, before the bare key. Returns null when nothing matches.
   */
  function pick(messages, key, vars, lang) {
    if (vars && typeof vars.count === 'number') {
      if (vars.count === 0 && hasOwn(messages, key + '.zero')) return messages[key + '.zero'];
      var cat = pluralCategory(lang, vars.count);
      if (hasOwn(messages, key + '.' + cat)) return messages[key + '.' + cat];
      if (hasOwn(messages, key + '.other')) return messages[key + '.other'];
    }
    return hasOwn(messages, key) ? messages[key] : null;
  }

  function formatNumber(lang, n, opts) {
    try { return new Intl.NumberFormat(INTL_LOCALES[lang] || INTL_LOCALES.en, opts).format(n); }
    catch (_) { return String(n); }
  }

  function toDate(d) { return d instanceof Date ? d : new Date(d); }

  function formatDate(lang, d, opts) {
    var date = toDate(d);
    if (isNaN(date.getTime())) return '';
    try {
      return new Intl.DateTimeFormat(INTL_LOCALES[lang] || INTL_LOCALES.en,
        opts || { day: 'numeric', month: 'short', year: 'numeric' }).format(date);
    } catch (_) { return date.toISOString().slice(0, 10); }
  }

  function formatDateTime(lang, d, opts) {
    return formatDate(lang, d, opts || {
      day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  }

  function formatTime(lang, d, opts) {
    return formatDate(lang, d, opts || { hour: '2-digit', minute: '2-digit' });
  }

  /**
   * Fill {name} placeholders. Numbers are formatted for the language (1.234 in
   * German, 1,234 in English); everything else is String()ed. A placeholder
   * with no value is left as written, so a missing var is visible in QA rather
   * than silently deleted from a sentence. The result is PLAIN TEXT.
   */
  function interpolate(template, vars, lang) {
    return String(template).replace(PLACEHOLDER, function (whole, name) {
      if (!hasOwn(vars, name)) return whole;
      var v = vars[name];
      if (typeof v === 'number') return formatNumber(lang, v);
      return v == null ? '' : String(v);
    });
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /**
   * Split a rich template into text / open / close / void tokens. Only the
   * allowlisted tags are recognised; any other angle-bracket text stays text.
   * Throws on unbalanced tags — a dictionary entry that would produce broken
   * nesting is a build error, not something to guess at.
   */
  function tokenizeRich(template) {
    var src = String(template);
    var tokens = [];
    var stack = [];
    var last = 0;
    var m;
    RICH_TOKEN.lastIndex = 0;
    while ((m = RICH_TOKEN.exec(src))) {
      if (m.index > last) tokens.push({ type: 'text', value: src.slice(last, m.index) });
      var closing = m[1] === '/';
      var tag = m[2];
      if (RICH_VOID.indexOf(tag) >= 0) {
        tokens.push({ type: 'void', tag: tag });
      } else if (closing) {
        if (stack.pop() !== tag) throw new Error('i18n: unbalanced </' + tag + '> in "' + src + '"');
        tokens.push({ type: 'close', tag: tag });
      } else {
        stack.push(tag);
        tokens.push({ type: 'open', tag: tag });
      }
      last = RICH_TOKEN.lastIndex;
    }
    if (last < src.length) tokens.push({ type: 'text', value: src.slice(last) });
    if (stack.length) throw new Error('i18n: unclosed <' + stack[stack.length - 1] + '> in "' + src + '"');
    return tokens;
  }

  /** The tags a rich template uses, as a sorted list — for parity checks. */
  function richTagsOf(template) {
    return tokenizeRich(template)
      .filter(function (tk) { return tk.type !== 'text'; })
      .map(function (tk) { return (tk.type === 'close' ? '/' : '') + tk.tag; })
      .sort();
  }

  /**
   * Server-side rendering of a rich template to an HTML string. `links[n]` is
   * the literal start tag of the n-th link, taken from the page's own markup.
   * Text is interpolated and escaped token by token, after tag parsing.
   */
  function renderRichHtml(template, vars, lang, links) {
    return tokenizeRich(template).map(function (tk) {
      if (tk.type === 'text') return escapeHtml(interpolate(tk.value, vars, lang));
      if (tk.type === 'void') return '<' + tk.tag + '>';
      if (/^a[0-9]$/.test(tk.tag)) {
        if (tk.type === 'close') return '</a>';
        var n = Number(tk.tag.slice(1));
        if (!links || !links[n]) throw new Error('i18n: <' + tk.tag + '> has no matching link in the markup');
        return links[n];
      }
      return tk.type === 'close' ? '</' + tk.tag + '>' : '<' + tk.tag + '>';
    }).join('');
  }

  var core = {
    SUPPORTED: SUPPORTED,
    DEFAULT_LANG: DEFAULT_LANG,
    INTL_LOCALES: INTL_LOCALES,
    NATIVE_NAMES: NATIVE_NAMES,
    FLAG_FILES: FLAG_FILES,
    COOKIE_NAME: COOKIE_NAME,
    COOKIE_MAX_AGE: COOKIE_MAX_AGE,
    RICH_TAGS: RICH_TAGS,
    RICH_VOID: RICH_VOID,
    normalizeLang: normalizeLang,
    isRichKey: isRichKey,
    pluralCategory: pluralCategory,
    pick: pick,
    interpolate: interpolate,
    escapeHtml: escapeHtml,
    tokenizeRich: tokenizeRich,
    richTagsOf: richTagsOf,
    renderRichHtml: renderRichHtml,
    formatNumber: formatNumber,
    formatDate: formatDate,
    formatDateTime: formatDateTime,
    formatTime: formatTime,
  };

  if (!root || typeof root.document === 'undefined') return { core: core, browser: null };

  // ---------------------------------------------------------------------------
  // Browser runtime
  // ---------------------------------------------------------------------------

  var doc = root.document;
  var ATTR_ALLOWLIST = ['placeholder', 'title', 'aria-label', 'alt', 'content'];
  var LINK_ATTR_ALLOWLIST = ['href', 'class', 'target', 'rel', 'id', 'hreflang'];
  var listeners = [];
  var warned = {};

  function readEmbedded() {
    var el = doc.getElementById('i18n-dict');
    if (!el) return null;
    try { return JSON.parse(el.textContent); } catch (_) { return null; }
  }

  var embedded = readEmbedded() || {};
  var state = {
    lang: normalizeLang(embedded.lang) || DEFAULT_LANG,
    // 'prefixed': a marketing page with /nl/ and /de/ variants — switching
    //   navigates to the variant URL. 'negotiated': the app — switching
    //   re-renders in place.
    mode: embedded.mode === 'prefixed' ? 'prefixed' : 'negotiated',
    dev: !!embedded.dev,
    version: embedded.version || '',
    alternates: embedded.alternates || {},
    messages: embedded.messages || {},
    fallback: toSet(embedded.fallback),
  };
  var cache = {};
  cache[state.lang] = { messages: state.messages, fallback: state.fallback };

  function toSet(list) {
    var s = {};
    (list || []).forEach(function (k) { s[k] = true; });
    return s;
  }

  function devWarn(kind, key) {
    if (!state.dev || warned[kind + key]) return;
    warned[kind + key] = true;
    try { root.console.warn('[i18n] ' + kind + ': ' + key + ' (' + state.lang + ')'); } catch (_) {}
  }

  /** Plain-text translation. Unknown keys come back as the key itself. */
  function t(key, vars) {
    var template = pick(state.messages, key, vars, state.lang);
    if (template == null) { devWarn('missing key', key); return key; }
    if (state.fallback[key]) devWarn('not translated, using English', key);
    return interpolate(template, vars, state.lang);
  }

  function has(key) { return hasOwn(state.messages, key); }

  function safeLinkAttrs(spec) {
    var out = {};
    Object.keys(spec || {}).forEach(function (name) {
      if (LINK_ATTR_ALLOWLIST.indexOf(name) < 0) return;
      var v = String(spec[name]);
      if (name === 'href' && !/^(#|\/(?!\/)|https:\/\/|mailto:)/i.test(v)) return;
      out[name] = v;
    });
    return out;
  }

  /**
   * A DocumentFragment for a rich (`_html`) key. `links` is an array of either
   * existing elements to clone (attributes only) or {href, class, …} specs.
   */
  function rich(key, vars, links) {
    var template = pick(state.messages, key, vars, state.lang);
    if (template == null) { devWarn('missing key', key); template = key; }
    var frag = doc.createDocumentFragment();
    var stack = [frag];
    tokenizeRich(template).forEach(function (tk) {
      var parent = stack[stack.length - 1];
      if (tk.type === 'text') {
        parent.appendChild(doc.createTextNode(interpolate(tk.value, vars, state.lang)));
      } else if (tk.type === 'void') {
        parent.appendChild(doc.createElement(tk.tag));
      } else if (tk.type === 'close') {
        stack.pop();
      } else {
        var el;
        if (/^a[0-9]$/.test(tk.tag)) {
          var src = links && links[Number(tk.tag.slice(1))];
          if (src && typeof src.cloneNode === 'function') {
            el = src.cloneNode(false);
          } else {
            el = doc.createElement('a');
            var attrs = safeLinkAttrs(src);
            Object.keys(attrs).forEach(function (n) { el.setAttribute(n, attrs[n]); });
          }
        } else {
          el = doc.createElement(tk.tag);
        }
        parent.appendChild(el);
        stack.push(el);
      }
    });
    return frag;
  }

  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

  function setText(el, key, vars) { if (el) el.textContent = t(key, vars); }

  function setRich(el, key, vars, links) {
    if (!el) return;
    clear(el);
    el.appendChild(rich(key, vars, links));
  }

  function varsOf(el) {
    var raw = el.getAttribute('data-i18n-vars');
    if (!raw) return undefined;
    try { return JSON.parse(raw); } catch (_) { return undefined; }
  }

  function attrPairs(el) {
    return String(el.getAttribute('data-i18n-attr') || '').split(';').map(function (pair) {
      var i = pair.indexOf(':');
      return i < 0 ? null : [pair.slice(0, i).trim(), pair.slice(i + 1).trim()];
    }).filter(function (p) { return p && ATTR_ALLOWLIST.indexOf(p[0]) >= 0 && p[1]; });
  }

  function each(rootEl, selector, fn) {
    Array.prototype.forEach.call((rootEl || doc).querySelectorAll(selector), fn);
  }

  /** Re-render every marked element under `rootEl` in the active language. */
  function apply(rootEl) {
    each(rootEl, '[data-i18n]', function (el) { setText(el, el.getAttribute('data-i18n'), varsOf(el)); });
    each(rootEl, '[data-i18n-html]', function (el) {
      // The link templates are the page's own <a> elements, captured before
      // the first re-render replaces them with clones.
      if (!el.__i18nLinks) {
        el.__i18nLinks = Array.prototype.map.call(el.querySelectorAll('a'), function (a) { return a.cloneNode(false); });
      }
      setRich(el, el.getAttribute('data-i18n-html'), varsOf(el), el.__i18nLinks);
    });
    each(rootEl, '[data-i18n-attr]', function (el) {
      attrPairs(el).forEach(function (p) { el.setAttribute(p[0], t(p[1], varsOf(el))); });
    });
  }

  // --- persistence -------------------------------------------------------------

  function writeCookie(lang) {
    try {
      var secure = root.location && root.location.protocol === 'https:' ? '; Secure' : '';
      doc.cookie = COOKIE_NAME + '=' + lang + '; Path=/; Max-Age=' + COOKIE_MAX_AGE + '; SameSite=Lax' + secure;
    } catch (_) { /* cookies disabled: the choice lasts for this page only */ }
  }

  function loadMessages(lang) {
    if (cache[lang]) return Promise.resolve(cache[lang]);
    var url = '/locales/' + lang + '.json' + (state.version ? '?v=' + encodeURIComponent(state.version) : '');
    return root.fetch(url, { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) {
        cache[lang] = { messages: d.messages || {}, fallback: toSet(d.fallback) };
        return cache[lang];
      });
  }

  // --- controls ---------------------------------------------------------------

  function flagSrc(lang) { return '/assets/flags/' + FLAG_FILES[lang] + '.svg'; }

  /** Bring every switcher and Settings select into line with state.lang. */
  function syncControls() {
    var label = t('lang.switcher.label', { language: NATIVE_NAMES[state.lang] });
    each(doc, '[data-lang-switch]', function (sw) {
      var btn = sw.querySelector('.lang-switch-btn');
      if (btn) {
        btn.setAttribute('aria-label', label);
        btn.setAttribute('title', label);
        var img = btn.querySelector('.lang-flag');
        if (img) img.setAttribute('src', flagSrc(state.lang));
        var name = btn.querySelector('.lang-switch-label');
        if (name) name.textContent = NATIVE_NAMES[state.lang];
      }
      each(sw, '[data-lang]', function (item) {
        item.setAttribute('aria-checked', item.getAttribute('data-lang') === state.lang ? 'true' : 'false');
      });
    });
    each(doc, '[data-lang-select]', function (sel) { sel.value = state.lang; });
  }

  function notify(lang, source) {
    listeners.forEach(function (fn) { try { fn(lang, source); } catch (e) { try { root.console.error(e); } catch (_) {} } });
  }

  /**
   * Switch language. Always stores the choice in the `lang` cookie. On a
   * marketing page this navigates to the variant URL; in the app it re-renders
   * in place and tells onChange() listeners, which is where the app persists
   * the choice to the account. `opts.source`: 'user' (a control was used) or
   * 'account' (adopting the saved preference — listeners must not write it
   * back).
   */
  function setLanguage(next, opts) {
    var lang = normalizeLang(next);
    var source = (opts && opts.source) || 'user';
    if (!lang) return Promise.resolve(state.lang);
    writeCookie(lang);
    if (state.mode === 'prefixed') {
      var href = state.alternates[lang];
      if (lang !== state.lang && href) root.location.assign(href);
      return Promise.resolve(lang);
    }
    if (lang === state.lang) { syncControls(); return Promise.resolve(lang); }
    return loadMessages(lang).then(function (loaded) {
      state.lang = lang;
      state.messages = loaded.messages;
      state.fallback = loaded.fallback;
      doc.documentElement.setAttribute('lang', lang);
      apply(doc);
      syncControls();
      notify(lang, source);
      return lang;
    });
  }

  function onChange(fn) { if (typeof fn === 'function') listeners.push(fn); }

  /**
   * The message to show for an API error: a translated one for a known code
   * (most specific first: code.reason, code.field, code), else the server's
   * own English message, else the translated fallback.
   */
  // Codes that say only "the request failed": the caller's own sentence
  // (translated) is more useful than the server's generic English.
  var GENERIC_CODES = { INTERNAL_ERROR: true, BAD_REQUEST: true, NOT_FOUND: true };

  function errorMessage(err, fallbackKey, vars) {
    var code = err && err.code;
    if (code && !GENERIC_CODES[code]) {
      var candidates = [];
      if (err.reason) candidates.push('errors.' + code + '.' + err.reason);
      if (err.field) candidates.push('errors.' + code + '.' + err.field);
      candidates.push('errors.' + code);
      for (var i = 0; i < candidates.length; i++) {
        if (has(candidates[i])) return t(candidates[i], vars);
      }
      if (err.message) return err.message;
    }
    return t(fallbackKey || 'errors.generic', vars);
  }

  // --- the switcher: open/close, keyboard, selection ---------------------------

  function menuOf(sw) { return sw && sw.querySelector('.lang-menu'); }
  function buttonOf(sw) { return sw && sw.querySelector('.lang-switch-btn'); }
  function itemsOf(sw) { return Array.prototype.slice.call(sw.querySelectorAll('[data-lang]')); }
  function isOpen(sw) { var m = menuOf(sw); return !!m && !m.hidden; }

  function openMenu(sw, focus) {
    each(doc, '[data-lang-switch]', function (other) { if (other !== sw) closeMenu(other, false); });
    var m = menuOf(sw);
    var b = buttonOf(sw);
    if (!m || !b) return;
    m.hidden = false;
    b.setAttribute('aria-expanded', 'true');
    // The menu hangs from the button's right edge; where the button sits near
    // the left of a narrow screen (the landing nav at 375px) that would put it
    // off-screen, so it flips to hang from the left edge instead.
    m.style.left = '';
    m.style.right = '';
    if (m.getBoundingClientRect && m.getBoundingClientRect().left < 8) {
      m.style.left = '0';
      m.style.right = 'auto';
    }
    if (focus) {
      var items = itemsOf(sw);
      var current = items.filter(function (el) { return el.getAttribute('aria-checked') === 'true'; })[0];
      var target = focus === 'last' ? items[items.length - 1] : (current || items[0]);
      if (target) target.focus();
    }
  }

  function closeMenu(sw, restoreFocus) {
    var m = menuOf(sw);
    var b = buttonOf(sw);
    if (!m || !b || m.hidden) return;
    m.hidden = true;
    b.setAttribute('aria-expanded', 'false');
    if (restoreFocus) b.focus();
  }

  function onSelect(item, e) {
    var sw = item.closest('[data-lang-switch]');
    var lang = normalizeLang(item.getAttribute('data-lang'));
    if (!lang) return;
    if (state.mode === 'prefixed' && item.tagName === 'A') {
      // A real link to the variant URL: let the browser follow it, after the
      // cookie records the choice for the unprefixed pages and the app.
      writeCookie(lang);
      if (lang === state.lang) { e.preventDefault(); closeMenu(sw, true); }
      return;
    }
    e.preventDefault();
    closeMenu(sw, true);
    setLanguage(lang, { source: 'user' });
  }

  doc.addEventListener('click', function (e) {
    var target = e.target;
    each(doc, '[data-lang-switch]', function (sw) { if (isOpen(sw) && !sw.contains(target)) closeMenu(sw, false); });
    var el = target && target.closest ? target.closest('[data-action]') : null;
    if (!el) return;
    var action = el.getAttribute('data-action');
    if (action === 'toggleLangMenu') {
      var sw = el.closest('[data-lang-switch]');
      if (isOpen(sw)) closeMenu(sw, true);
      // e.detail is 0 for a click synthesised from Enter/Space, so the keyboard
      // path lands focus in the menu while a mouse click just opens it.
      else openMenu(sw, e.detail === 0 ? 'current' : null);
    } else if (action === 'selectLang') {
      onSelect(el, e);
    }
  });

  doc.addEventListener('change', function (e) {
    var el = e.target;
    if (el && el.getAttribute && el.getAttribute('data-action') === 'setLanguage') {
      setLanguage(el.value, { source: 'user' });
    }
  });

  doc.addEventListener('keydown', function (e) {
    var target = e.target;
    var sw = target && target.closest ? target.closest('[data-lang-switch]') : null;
    if (!sw) return;
    var onButton = target === buttonOf(sw);
    if (onButton) {
      if (e.key === 'ArrowDown') { e.preventDefault(); openMenu(sw, 'current'); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); openMenu(sw, 'last'); }
      else if (e.key === 'Escape' && isOpen(sw)) { e.preventDefault(); closeMenu(sw, true); }
      return;
    }
    if (!isOpen(sw)) return;
    var items = itemsOf(sw);
    var i = items.indexOf(target);
    if (e.key === 'Escape') { e.preventDefault(); closeMenu(sw, true); return; }
    if (e.key === 'Tab') { closeMenu(sw, false); return; }
    if ((e.key === ' ' || e.key === 'Spacebar') && target.tagName === 'A') { e.preventDefault(); target.click(); return; }
    var next = null;
    if (e.key === 'ArrowDown') next = (i + 1) % items.length;
    else if (e.key === 'ArrowUp') next = (i - 1 + items.length) % items.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    if (next !== null && items[next]) { e.preventDefault(); items[next].focus(); }
  });

  // Focus leaving a switcher closes it, so opening another popup from the
  // keyboard never leaves two menus open at once.
  doc.addEventListener('focusout', function (e) {
    var sw = e.target && e.target.closest ? e.target.closest('[data-lang-switch]') : null;
    if (sw && isOpen(sw) && !(e.relatedTarget && sw.contains(e.relatedTarget))) {
      if (e.relatedTarget) closeMenu(sw, false);
    }
  });

  // Settings selects and switchers rendered after this script (it runs in
  // <head>) are brought into line once the document has parsed.
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', syncControls);
  else syncControls();

  var browser = {
    SUPPORTED: SUPPORTED,
    NATIVE_NAMES: NATIVE_NAMES,
    get lang() { return state.lang; },
    get locale() { return INTL_LOCALES[state.lang]; },
    t: t,
    has: has,
    rich: rich,
    setText: setText,
    setRich: setRich,
    apply: apply,
    setLanguage: setLanguage,
    onChange: onChange,
    errorMessage: errorMessage,
    formatNumber: function (n, opts) { return formatNumber(state.lang, n, opts); },
    formatDate: function (d, opts) { return formatDate(state.lang, d, opts); },
    formatDateTime: function (d, opts) { return formatDateTime(state.lang, d, opts); },
    formatTime: function (d, opts) { return formatTime(state.lang, d, opts); },
    escapeHtml: escapeHtml,
  };
  return { core: core, browser: browser };
});
