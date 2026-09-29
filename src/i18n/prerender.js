'use strict';

/**
 * src/i18n/prerender.js — translate a page's markup on the server.
 *
 * Runs once per page per language at startup (see ./pages.js), never per
 * request. The markup contract, shared with public/i18n.js:
 *
 *   <h1 data-i18n="landing.hero.title">English text</h1>
 *       Text content replaced by the translation, HTML-escaped. The element
 *       must contain text only — no child elements.
 *
 *   <p data-i18n-html="landing.statement.p2_html">… <strong>…</strong> …</p>
 *       Rich content. The key's name must end in `_html` and its value may use
 *       only the inline tags in public/i18n.js RICH_TAGS, plus <a0>…<a9> for
 *       links. <aN> is the N-th <a …> in this element's own markup: the link's
 *       attributes (href, class, target, rel) come from the page, never from a
 *       dictionary.
 *
 *   <input data-i18n-attr="placeholder:auth.email;aria-label:auth.emailLabel">
 *       Attribute values, `attr:key` pairs separated by `;`. Allowed
 *       attributes: placeholder, title, aria-label, alt, content.
 *
 *   data-i18n-vars='{"n":3}' supplies interpolation values to any of the
 *   above. Values are inserted as escaped text.
 *
 * The English text left in the markup is the source a translator reads and
 * what a template without this pass would show; src/i18n/prerender.test.js
 * asserts it matches en.json, so the two cannot drift.
 *
 * <script>, <style> and comments are masked before scanning, so prose that
 * quotes the attribute names (like this file's own examples, were they in a
 * page) is never mistaken for markup.
 */

const core = require('../../public/i18n.js');

const ATTR_ALLOWLIST = new Set(['placeholder', 'title', 'aria-label', 'alt', 'content']);
const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
// Linear: attribute text is any run of non-quote, non-'>' characters or a
// quoted string (which may itself contain '>').
const START_TAG = /<([a-zA-Z][a-zA-Z0-9-]*)((?:\s(?:[^>"']|"[^"]*"|'[^']*')*)?)>/g;
const ATTR = /([^\s=>/"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g;

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', rsquo: '\u2019', lsquo: '\u2018',
  rdquo: '\u201d', ldquo: '\u201c', mdash: '\u2014', ndash: '\u2013', hellip: '\u2026', middot: '\u00b7',
  times: '\u00d7', rarr: '\u2192', larr: '\u2190', uarr: '\u2191', darr: '\u2193', ge: '\u2265', le: '\u2264',
  copy: '\u00a9', euro: '\u20ac', deg: '\u00b0', trade: '\u2122', reg: '\u00ae', bull: '\u2022', shy: '\u00ad',
};

/** Decode the entities these pages use. An unknown named entity throws. */
function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, body) => {
    if (body[0] === '#') {
      const cp = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return String.fromCodePoint(cp);
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    if (named === undefined) throw new Error(`prerender: unknown entity ${whole}`);
    return named;
  });
}

/** Replace <script>/<style>/comments with inert tokens; returns an unmasker. */
function mask(html) {
  const stash = [];
  const masked = html.replace(/<!--[\s\S]*?-->|<script\b[^>]*>[\s\S]*?<\/script>|<style\b[^>]*>[\s\S]*?<\/style>/gi, (m) => {
    stash.push(m);
    return '\u0000' + (stash.length - 1) + '\u0000';
  });
  return { masked, unmask: (s) => s.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[Number(i)]) };
}

function parseAttrs(attrString) {
  const attrs = {};
  ATTR.lastIndex = 0;
  let m;
  while ((m = ATTR.exec(attrString || ''))) {
    const value = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : ''));
    attrs[m[1].toLowerCase()] = value;
  }
  return attrs;
}

/** Index of the `</name` that closes the element whose content starts at `from`. */
function findClose(html, name, from) {
  const re = new RegExp('<(/?)' + name + '(?=[\\s>/])', 'gi');
  re.lastIndex = from;
  let depth = 1;
  let m;
  while ((m = re.exec(html))) {
    if (m[1] === '/') { depth -= 1; if (depth === 0) return m.index; }
    else depth += 1;
  }
  return -1;
}

function setAttr(tag, name, value) {
  const escaped = core.escapeHtml(value);
  const re = new RegExp('(\\s' + name + '\\s*=\\s*)("[^"]*"|\'[^\']*\'|[^\\s>"\']+)', 'i');
  if (re.test(tag)) return tag.replace(re, (_, lead) => lead + '"' + escaped + '"');
  return tag.replace(/\s*\/?>$/, (end) => ' ' + name + '="' + escaped + '"' + end);
}

function attrPairs(spec) {
  return String(spec || '').split(';').map((pair) => {
    const i = pair.indexOf(':');
    return i < 0 ? null : [pair.slice(0, i).trim().toLowerCase(), pair.slice(i + 1).trim()];
  }).filter(Boolean);
}

function parseVars(attrs) {
  if (!attrs['data-i18n-vars']) return undefined;
  return JSON.parse(decodeEntities(attrs['data-i18n-vars']));
}

/**
 * Every translatable element in a page, in document order — the same scan the
 * renderer does, exposed for tests and for i18n:check.
 * @returns {Array<{kind:'text'|'rich'|'attr', key:string, attr?:string, tag:string, inner?:string, vars?:object}>}
 */
function scan(html) {
  const { masked } = mask(html);
  const found = [];
  START_TAG.lastIndex = 0;
  let m;
  while ((m = START_TAG.exec(masked))) {
    if (!/\sdata-i18n/.test(m[0])) continue;
    const name = m[1].toLowerCase();
    const attrs = parseAttrs(m[2]);
    const vars = parseVars(attrs);
    for (const [attr, key] of attrPairs(attrs['data-i18n-attr'])) {
      found.push({ kind: 'attr', key, attr, tag: name, vars });
    }
    const key = attrs['data-i18n'] || attrs['data-i18n-html'];
    if (!key) continue;
    const contentStart = m.index + m[0].length;
    const close = VOID_ELEMENTS.has(name) ? -1 : findClose(masked, name, contentStart);
    found.push({
      kind: attrs['data-i18n'] ? 'text' : 'rich',
      key,
      tag: name,
      vars,
      inner: close < 0 ? null : masked.slice(contentStart, close),
    });
  }
  return found;
}

/**
 * Translate every marked element. `lookup(key)` returns the template for a
 * key or null. A key it does not know leaves that element's markup exactly as
 * written — English, since the markup is English — and is reported through
 * `onProblem`; tests make that list empty, so production never takes the path.
 */
function localizeMarkup(html, { lang, lookup, onProblem = () => {} }) {
  const { masked, unmask } = mask(html);
  let out = '';
  let pos = 0;
  START_TAG.lastIndex = 0;
  let m;
  while ((m = START_TAG.exec(masked))) {
    const tag = m[0];
    if (!/\sdata-i18n/.test(tag)) continue;
    const name = m[1].toLowerCase();
    const attrs = parseAttrs(m[2]);
    let vars;
    try { vars = parseVars(attrs); } catch (err) { onProblem(`bad data-i18n-vars on <${name}>: ${err.message}`); continue; }

    let newTag = tag;
    for (const [attr, key] of attrPairs(attrs['data-i18n-attr'])) {
      if (!ATTR_ALLOWLIST.has(attr)) { onProblem(`attribute "${attr}" is not translatable (key ${key})`); continue; }
      const template = lookup(key, vars);
      if (template == null) { onProblem(`unknown key ${key}`); continue; }
      newTag = setAttr(newTag, attr, core.interpolate(template, vars, lang));
    }

    const textKey = attrs['data-i18n'];
    const richKey = attrs['data-i18n-html'];
    const key = textKey || richKey;
    if (!key) {
      out += masked.slice(pos, m.index) + newTag;
      pos = m.index + tag.length;
      continue;
    }
    if (VOID_ELEMENTS.has(name)) { onProblem(`<${name}> cannot carry data-i18n content (key ${key})`); continue; }
    const contentStart = m.index + tag.length;
    const close = findClose(masked, name, contentStart);
    if (close < 0) { onProblem(`no closing </${name}> for key ${key}`); continue; }
    const closeEnd = masked.indexOf('>', close) + 1;
    const inner = masked.slice(contentStart, close);

    let content = null;
    const template = lookup(key, vars);
    if (template == null) onProblem(`unknown key ${key}`);
    else if (textKey) {
      if (/<[a-zA-Z]/.test(inner)) onProblem(`data-i18n="${key}" wraps child elements; use data-i18n-html`);
      else content = core.escapeHtml(core.interpolate(template, vars, lang));
    } else {
      if (!core.isRichKey(key)) onProblem(`data-i18n-html="${key}": rich keys must end in _html`);
      else {
        const links = inner.match(/<a\b[^>]*>/gi) || [];
        try { content = core.renderRichHtml(template, vars, lang, links); }
        catch (err) { onProblem(`${key}: ${err.message}`); }
      }
    }

    if (content == null) {
      out += masked.slice(pos, m.index) + newTag;
      pos = m.index + tag.length;
      continue;
    }
    out += masked.slice(pos, m.index) + newTag + content + masked.slice(close, closeEnd);
    pos = closeEnd;
    START_TAG.lastIndex = closeEnd;
  }
  out += masked.slice(pos);
  return unmask(out);
}

/**
 * The dictionary template an element's markup corresponds to: entities
 * decoded, whitespace runs collapsed (as rendering collapses them), and for
 * rich elements the n-th <a …> rewritten to <an>. This is how en.json was
 * seeded from the pages, and how prerender.test.js proves the English left in
 * the markup still says what en.json says.
 */
function markupToTemplate(inner, kind) {
  const collapse = (t) => t.replace(/[ \t\n\r\f]+/g, ' ').replace(/ ?<br> ?/g, '<br>').trim();
  if (kind !== 'rich') return collapse(decodeEntities(inner));
  let n = 0;
  const open = [];
  const tagged = inner.replace(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g, (whole, close, rawName) => {
    const name = rawName.toLowerCase();
    if (name === 'a') {
      if (close) return '</a' + open.pop() + '>';
      open.push(n);
      return '<a' + (n++) + '>';
    }
    if (core.RICH_TAGS.includes(name) || core.RICH_VOID.includes(name)) return close ? `</${name}>` : `<${name}>`;
    throw new Error(`markupToTemplate: <${name}> is not allowed inside rich text`);
  });
  return collapse(tagged.split(/(<[^>]+>)/).map((part, i) => (i % 2 ? part : decodeEntities(part))).join(''));
}

/** Set the root element's lang attribute. */
function setDocumentLang(html, lang) {
  return html.replace(/<html\b([^>]*)>/i, (whole, attrs) => {
    const next = /\slang\s*=/.test(attrs)
      ? attrs.replace(/(\slang\s*=\s*)("[^"]*"|'[^']*'|[^\s>]+)/i, `$1"${lang}"`)
      : `${attrs} lang="${lang}"`;
    return `<html${next}>`;
  });
}

/**
 * Point same-site links at the language variant of the page they lead to.
 * `routes` maps an unprefixed path (e.g. '/bias-report.html') to its variant
 * (e.g. '/nl/bias-report.html'); anything else — the app, the legal pages,
 * assets — is left alone. Only href attributes in markup are touched.
 */
function rewriteLinks(html, routes) {
  const { masked, unmask } = mask(html);
  const rewritten = masked.replace(/(<a\b[^>]*?\shref=")(\/[^"#?]*)([?#][^"]*)?(")/gi,
    (whole, lead, pathPart, rest, end) => {
      if (/\sdata-lang=/.test(whole)) return whole; // the switcher names its own targets
      const target = routes[pathPart];
      return target ? lead + target + (rest || '') + end : whole;
    });
  return unmask(rewritten);
}

module.exports = {
  decodeEntities,
  markupToTemplate,
  mask,
  parseAttrs,
  scan,
  localizeMarkup,
  setDocumentLang,
  rewriteLinks,
  ATTR_ALLOWLIST,
};
