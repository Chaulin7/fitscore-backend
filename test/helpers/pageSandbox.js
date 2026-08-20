'use strict';

/**
 * test/helpers/pageSandbox.js — run shipped browser code inside a test.
 *
 * The landing page and the app are single HTML files with inline <script>
 * blocks; there is no build step and no module boundary to import across. To
 * test that code rather than a transcription of it, these helpers lift a named
 * function (or a whole script block) straight out of the HTML and run it in a
 * vm against a deliberately small DOM.
 *
 * The DOM is a shim, not a browser: it implements exactly the surface our code
 * touches (delegated listeners, getElementById, one selector form, navigation
 * by assignment). It is not trying to be jsdom. Anything it does not implement
 * throws, which is the correct outcome — a silent no-op would let a test pass
 * on behaviour that never happened.
 */

const assert = require('node:assert/strict');

/**
 * Pull a top-level function declaration out of source by brace matching.
 * Handles `async function`, and steps over the parameter list first so a
 * default value like `opts = {}` is not mistaken for the function body.
 */
function extractFunction(src, name) {
  const m = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(').exec(src);
  assert.ok(m, `expected a declaration of ${name}()`);
  let parens = 0;
  let j = src.indexOf('(', m.index);
  for (; j < src.length; j++) {
    if (src[j] === '(') parens++;
    else if (src[j] === ')') { parens--; if (parens === 0) break; }
  }
  let depth = 0;
  let i = src.indexOf('{', j);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(m.index, i + 1);
}

/** A single-line declaration, e.g. extractLine(html, 'var DEMO_HREF='). */
function extractLine(src, declaration) {
  const m = new RegExp('^\\s*(' + declaration + '[^\\n]*)$', 'm').exec(src);
  assert.ok(m, `expected a declaration matching ${declaration}`);
  return m[1];
}

/** The body of the <script> block containing `marker`. */
function scriptBlockContaining(html, marker) {
  const at = html.indexOf(marker);
  assert.notEqual(at, -1, 'marker not found in page: ' + marker);
  const open = html.lastIndexOf('<script', at);
  const bodyStart = html.indexOf('>', open) + 1;
  const close = html.indexOf('</script>', at);
  assert.ok(close > bodyStart, 'unterminated script block around: ' + marker);
  return html.slice(bodyStart, close);
}

/**
 * Minimal DOM.
 *
 * `nav.to` records `window.location = x` — the only navigation our pages do.
 * It stays null until something navigates, so a test can assert that nothing
 * did. `store` is the backing object for localStorage, so a test can inspect
 * whether the session token survived (the 401 path drops it, others do not).
 */
function makeDom(startUrl, store = {}) {
  const listeners = {};
  const els = {};
  const nav = { to: null };
  const url = new URL(startUrl);

  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };

  const location = { pathname: url.pathname, search: url.search };
  Object.defineProperty(location, 'href', { get: () => startUrl, configurable: true });
  const windowObj = {
    get location() { return location; },
    set location(v) { nav.to = String(v); },
  };

  class CustomEvent {
    constructor(type, init) { this.type = type; this.detail = init && init.detail; }
  }

  const document = {
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    dispatchEvent: (ev) => { for (const fn of listeners[ev.type] || []) fn(ev); return true; },
    getElementById: (id) => els[id] || null,
    querySelectorAll: (sel) => Object.values(els).filter((el) => el._selectors.includes(sel)),
  };

  /**
   * @param {string} id
   * @param {{selectors?: string[], attrs?: object}} opts `selectors` are the
   *   querySelectorAll strings this element should answer to — the shim does no
   *   real selector parsing, so a test states the match explicitly.
   */
  function mkEl(id, opts = {}) {
    const el = {
      id,
      textContent: '',
      innerHTML: '',
      className: '',
      style: {},
      disabled: false,
      dataset: {},
      _attrs: { ...(opts.attrs || {}) },
      _selectors: opts.selectors || [],
    };
    el.getAttribute = (k) => (k in el._attrs ? el._attrs[k] : null);
    el.setAttribute = (k, v) => { el._attrs[k] = String(v); };
    el.closest = () => el;
    els[id] = el;
    return el;
  }

  /** Dispatch a click the way a real one reaches a delegated listener. */
  function click(el) {
    if (el.disabled) return false; // browsers do not fire click on a disabled button
    for (const fn of listeners.click || []) fn({ target: el, preventDefault() {} });
    return true;
  }

  return { document, window: windowObj, localStorage, nav, mkEl, click, els, store, CustomEvent };
}

/**
 * fetch wrapper that resolves same-origin paths against `base` and records
 * every call as {method, path, status}. The recording is what lets a test say
 * WHICH branch of the client code ran, rather than inferring it from where the
 * browser ended up.
 */
function recordingFetch(base) {
  const calls = [];
  const fn = async (input, init) => {
    const raw = String(input);
    const path = raw.startsWith('http') ? raw.slice(base.length) : raw;
    const method = ((init && init.method) || 'GET').toUpperCase();
    const res = await fetch(raw.startsWith('http') ? raw : base + raw, init);
    calls.push({ method, path, status: res.status });
    return res;
  };
  fn.calls = calls;
  fn.find = (method, path) => calls.find((c) => c.method === method && c.path === path);
  return fn;
}

module.exports = {
  extractFunction, extractLine, scriptBlockContaining, makeDom, recordingFetch,
};
