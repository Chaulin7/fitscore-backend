'use strict';

/**
 * src/routes/enterShortcut.test.js — "Press Enter to analyze", and nowhere else.
 *
 * The global shortcut used to fire for Enter on ANY focused element except a
 * form field or the language switcher: Enter on "Log out", on the account
 * menu, on a sort button or a template chip started an analysis instead of
 * doing what the control does. It now fires only with focus on the page itself
 * or in one of the analyzer's own single-line fields, and never under an open
 * dialog, menu or panel.
 *
 * The decision is the real shouldAnalyzeOnEnter() out of app.html, run against
 * a small fake document whose selector answers each test states explicitly.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { extractFunction } = require('../../test/helpers/pageSandbox');

const APP_HTML = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'app.html'), 'utf8');

function block(name) {
  const m = new RegExp('var ' + name + ' = \\[[\\s\\S]*?\\];').exec(APP_HTML);
  assert.ok(m, 'expected var ' + name);
  return m[0];
}
const ctx = vm.createContext({});
vm.runInContext([block('ANALYZE_ENTER_BLOCKERS'), block('ANALYZE_ENTER_FIELD_TYPES'), extractFunction(APP_HTML, 'shouldAnalyzeOnEnter')].join('\n'), ctx);
const shouldAnalyze = (e, doc) => vm.runInContext('shouldAnalyzeOnEnter', ctx)(e, doc);

/** An element: which ancestor selectors it sits inside, by name. */
function el(tag, { type, inside = [] } = {}) {
  return {
    tagName: tag.toUpperCase(),
    type,
    closest(sel) { return sel.split(',').map((s) => s.trim()).some((s) => inside.includes(s)) ? {} : null; },
  };
}
const ANALYZER = ['#analyzer-tool'];

/**
 * A document. `open` lists the blocker selectors that currently match;
 * `tab` is the active tab; `shown` the ids whose inline display is set.
 */
function doc({ active, open = [], tab = 'analyzer', shown = {} } = {}) {
  const body = { tagName: 'BODY' };
  return {
    body,
    documentElement: { tagName: 'HTML' },
    activeElement: active === undefined ? body : active,
    querySelector: (sel) => (sel === '#tab-analyzer.active' ? (tab === 'analyzer' ? {} : null) : (open.includes(sel) ? {} : null)),
    getElementById: (id) => ({ style: { display: shown[id] || '' } }),
  };
}
const ENTER = { key: 'Enter' };

describe('fires where Enter has no job of its own', () => {
  test('focus on the page itself', () => {
    assert.equal(shouldAnalyze(ENTER, doc()), true);
  });
  test('in the role field, and in a weight field', () => {
    assert.equal(shouldAnalyze(ENTER, doc({ active: el('input', { type: 'text', inside: ANALYZER }) })), true);
    assert.equal(shouldAnalyze(ENTER, doc({ active: el('input', { type: 'number', inside: ANALYZER }) })), true);
  });
});

describe('never on a control that Enter already operates', () => {
  for (const [what, active] of [
    ['a button (Log out, sort, Save …)', el('button', { inside: ANALYZER })],
    ['a link', el('a')],
    ['a select (the decision dropdown)', el('select', { inside: ANALYZER })],
    ['a textarea (the job description: Enter is a newline)', el('textarea', { inside: ANALYZER })],
    ['a checkbox (Anonymize)', el('input', { type: 'checkbox', inside: ANALYZER })],
    ['the file input', el('input', { type: 'file', inside: ANALYZER })],
    ['a text field outside the analyzer (audit search, a note)', el('input', { type: 'text' })],
    ['the language switcher', el('button', { inside: ['[data-lang-switch]'] })],
    ['a menu item in the account menu', el('button', { inside: ['[role="menu"]'] })],
    ['a field inside a dialog', el('input', { type: 'text', inside: ['[role="dialog"]', ...ANALYZER] })],
    ['a field inside a modal', el('input', { type: 'text', inside: ['.modal-backdrop'] })],
  ]) {
    test(what, () => { assert.equal(shouldAnalyze(ENTER, doc({ active })), false); });
  }
});

describe('never with something open over the analyzer', () => {
  for (const sel of ['.modal-backdrop.open', '#_dlgBackdrop', '#pausedScreen', '#history-overlay.open', '#settingsPanel.open',
    '#planPanel:not([hidden])', '#accountDropdown:not([hidden])', '.lang-menu:not([hidden])', '#tplPanel.open']) {
    test(sel, () => { assert.equal(shouldAnalyze(ENTER, doc({ open: [sel] })), false); });
  }
  test('the sign-in screen, or an analysis already running', () => {
    assert.equal(shouldAnalyze(ENTER, doc({ shown: { authScreen: 'flex' } })), false);
    assert.equal(shouldAnalyze(ENTER, doc({ shown: { loadingOverlay: 'flex' } })), false);
  });
  test('another tab on screen', () => {
    assert.equal(shouldAnalyze(ENTER, doc({ tab: 'audit' })), false);
  });
});

describe('only plain Enter', () => {
  for (const mod of ['shiftKey', 'ctrlKey', 'metaKey', 'altKey', 'isComposing']) {
    test(mod, () => { assert.equal(shouldAnalyze({ key: 'Enter', [mod]: true }, doc()), false); });
  }
  test('other keys', () => { assert.equal(shouldAnalyze({ key: ' ' }, doc()), false); });
});

describe('wiring', () => {
  test('the keydown handler asks shouldAnalyzeOnEnter and nothing else', () => {
    const m = /document\.addEventListener\('keydown', function\(e\)\{\n  if \(!shouldAnalyzeOnEnter\(e, document\)\) return;/.exec(APP_HTML);
    assert.ok(m, 'the shortcut must go through the tested guard');
    assert.equal((APP_HTML.match(/btn\.click\(\)/g) || []).length, 1, 'one Enter shortcut, not two');
  });
});
