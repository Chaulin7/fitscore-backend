'use strict';

/**
 * test/helpers/miniDom.js — just enough DOM to run the pages' node-building
 * code and read the result back as HTML.
 *
 * The pages build UI with createElement/textContent/setAttribute (never
 * innerHTML, since the translation layer) and the tests want to assert on the
 * markup that produces. This implements that surface — elements, text,
 * fragments, attributes in insertion order, dataset, cloneNode, closest and a
 * few simple selectors — and serializes it back with proper escaping, so a
 * test can hold `outerHTML` to a regex exactly as it used to hold the string
 * the old renderer returned.
 *
 * Not jsdom and not trying to be. Selectors support `tag`, `#id`, `.class`,
 * `[attr]` and `[attr="value"]`, one simple selector at a time.
 */

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

const escText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function matches(el, selector) {
  if (!el || el.nodeType !== 1) return false;
  const sel = selector.trim();
  let m;
  if ((m = /^\[([^\]=]+)(?:="([^"]*)")?\]$/.exec(sel))) {
    return m[2] === undefined ? el.hasAttribute(m[1]) : el.getAttribute(m[1]) === m[2];
  }
  if (sel[0] === '#') return el.id === sel.slice(1);
  if (sel[0] === '.') return el.className.split(/\s+/).includes(sel.slice(1));
  if (/^[a-z][a-z0-9-]*$/i.test(sel)) return el.localName === sel.toLowerCase();
  throw new Error(`miniDom: unsupported selector "${selector}"`);
}

class Node {
  constructor(doc) { this.ownerDocument = doc; this.parentNode = null; this.childNodes = []; }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  appendChild(node) {
    if (node.nodeType === 11) {
      for (const c of node.childNodes.slice()) this.appendChild(c);
      return node;
    }
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }
  removeChild(node) {
    const i = this.childNodes.indexOf(node);
    if (i < 0) throw new Error('miniDom: removeChild of a non-child');
    this.childNodes.splice(i, 1);
    node.parentNode = null;
    return node;
  }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(v) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    const s = v == null ? '' : String(v);
    if (s) this.appendChild(this.ownerDocument.createTextNode(s));
  }
  get innerHTML() { return this.childNodes.map((c) => c.outerHTML).join(''); }
  /** Every descendant element, document order. */
  _descendants(out = []) {
    for (const c of this.childNodes) {
      if (c.nodeType === 1) { out.push(c); c._descendants(out); }
    }
    return out;
  }
  querySelectorAll(sel) { return this._descendants().filter((el) => matches(el, sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}

class Text extends Node {
  constructor(doc, data) { super(doc); this.nodeType = 3; this.data = String(data); }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
  get outerHTML() { return escText(this.data); }
  cloneNode() { return new Text(this.ownerDocument, this.data); }
}

class Fragment extends Node {
  constructor(doc) { super(doc); this.nodeType = 11; }
  get outerHTML() { return this.innerHTML; }
}

class Element extends Node {
  constructor(doc, tag) {
    super(doc);
    this.nodeType = 1;
    this.localName = String(tag).toLowerCase();
    this.tagName = this.localName.toUpperCase();
    this._attrs = new Map();
    this.style = {};
    this.disabled = false;
    this._raw = null;
    const self = this;
    this.dataset = new Proxy({}, {
      get(_, prop) { return typeof prop === 'string' ? (self.getAttribute(toData(prop)) ?? undefined) : undefined; },
      set(_, prop, value) { self.setAttribute(toData(prop), value); return true; },
    });
  }
  setAttribute(name, value) { this._attrs.set(String(name).toLowerCase(), String(value)); }
  getAttribute(name) { const v = this._attrs.get(String(name).toLowerCase()); return v === undefined ? null : v; }
  hasAttribute(name) { return this._attrs.has(String(name).toLowerCase()); }
  removeAttribute(name) { this._attrs.delete(String(name).toLowerCase()); }
  get id() { return this.getAttribute('id') || ''; }
  set id(v) { this.setAttribute('id', v); }
  get className() { return this.getAttribute('class') || ''; }
  set className(v) { this.setAttribute('class', v); }
  get hidden() { return this.hasAttribute('hidden'); }
  set hidden(v) { if (v) this.setAttribute('hidden', ''); else this.removeAttribute('hidden'); }
  get textContent() { return this._raw !== null ? this._raw.replace(/<[^>]*>/g, '') : super.textContent; }
  set textContent(v) { this._raw = null; super.textContent = v; }
  // Legacy code that still assigns markup: kept verbatim so a test can see it.
  get innerHTML() { return this._raw !== null ? this._raw : super.innerHTML; }
  set innerHTML(v) { super.textContent = ''; this._raw = String(v); }
  get outerHTML() {
    const attrs = [...this._attrs].map(([k, v]) => (v === '' && k === 'hidden' ? ` ${k}` : ` ${k}="${escAttr(v)}"`)).join('');
    if (VOID.has(this.localName)) return `<${this.localName}${attrs}>`;
    return `<${this.localName}${attrs}>${this.innerHTML}</${this.localName}>`;
  }
  cloneNode(deep) {
    const copy = new Element(this.ownerDocument, this.localName);
    for (const [k, v] of this._attrs) copy._attrs.set(k, v);
    if (deep) for (const c of this.childNodes) copy.appendChild(c.cloneNode(true));
    return copy;
  }
  closest(sel) {
    for (let el = this; el && el.nodeType === 1; el = el.parentNode) if (matches(el, sel)) return el;
    return null;
  }
  contains(node) {
    for (let n = node; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
  addEventListener() {}
  focus() {}
}

function toData(prop) { return 'data-' + String(prop).replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()); }

function createDocument() {
  const doc = {
    readyState: 'complete',
    createElement: (tag) => new Element(doc, tag),
    createElementNS: (_ns, tag) => new Element(doc, tag),
    createTextNode: (data) => new Text(doc, data),
    createDocumentFragment: () => new Fragment(doc),
    addEventListener() {},
    getElementById: (id) => doc.documentElement._descendants().find((el) => el.id === id) || null,
    querySelectorAll: (sel) => doc.documentElement.querySelectorAll(sel),
  };
  doc.documentElement = new Element(doc, 'html');
  return doc;
}

/** Serialize a node or fragment. */
function toHtml(node) { return node.outerHTML; }

module.exports = { createDocument, toHtml, matches, Element };
