'use strict';

/**
 * src/routes/headerNav.test.js
 *
 * The app header after the overflow restructure.
 *
 * The bar used to hold six items plus three chips in one non-wrapping row, and
 * the settings gear was the element pushed off-screen as the viewport narrowed.
 * Three primary links stay in the bar; everything else moved into an account
 * dropdown behind an avatar trigger.
 *
 * Covers the structure and wiring that can be asserted from source: what is in
 * the bar, what is in the dropdown, the ARIA contract on the trigger, that the
 * dropdown behaviours are registered rather than inline (Helmet sets
 * script-src-attr 'none'), and that the ids the existing render functions drive
 * still exist. Visual overflow itself is not assertable here.
 */

const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const APP_HTML = fs.readFileSync(
  path.join(__dirname, '..', '..', 'public', 'app.html'), 'utf8',
);

// Comments are stripped before structural assertions: this file's own prose
// explains what carries role="menuitem" and what the removed .nav-btn-fr rules
// did, and a comment must not read as the markup it describes.
function stripComments(s) { return s.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, ''); }

const MARKUP = stripComments(APP_HTML);
const TOPBAR = /<div class="topbar">([\s\S]*?)\n<\/div>/.exec(MARKUP);
const NAV = /<nav class="topbar-nav"[^>]*>([\s\S]*?)<\/nav>/.exec(MARKUP);
const DROPDOWN = /<div class="account-dropdown"[^>]*>([\s\S]*?)\n {4}<\/div>/.exec(MARKUP);

// Pull a named top-level function out of app.html by brace matching and run it
// in a sandbox, so these exercise shipped source rather than a copy.
function extractFunction(name) {
  const start = APP_HTML.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, `expected app.html to declare function ${name}()`);
  let depth = 0;
  let i = APP_HTML.indexOf('{', start);
  for (; i < APP_HTML.length; i++) {
    if (APP_HTML[i] === '{') depth++;
    else if (APP_HTML[i] === '}') { depth--; if (depth === 0) break; }
  }
  return APP_HTML.slice(start, i + 1);
}

describe('primary nav holds exactly the three destinations', () => {
  test('the nav exists and contains three tab buttons', () => {
    assert.ok(NAV, 'topbar-nav must exist');
    const tabs = [...NAV[1].matchAll(/data-tab="([a-z]+)"/g)].map((m) => m[1]);
    assert.deepEqual(tabs, ['analyzer', 'audit', 'history']);
  });

  test('nothing else lives in the bar nav', () => {
    const buttons = NAV[1].match(/<button|<a\b/g) || [];
    assert.equal(buttons.length, 3, `expected 3 nav items, found ${buttons.length}`);
  });

  test('Suggest and Settings are gone from the nav', () => {
    assert.doesNotMatch(NAV[1], /openFeatureRequest/);
    assert.doesNotMatch(NAV[1], /toggleSettings/);
  });

  test('the standalone settings gear button is gone from the bar', () => {
    assert.ok(TOPBAR, 'topbar must exist');
    assert.doesNotMatch(TOPBAR[1], /class="settings-btn"/);
  });

  test('the plan chip and status pill are no longer direct bar children', () => {
    // They still exist — they moved into the dropdown's status row.
    assert.match(APP_HTML, /id="planChip"/);
    assert.match(APP_HTML, /id="navStatusPill"/);
    assert.ok(DROPDOWN, 'account dropdown must exist');
    assert.match(DROPDOWN[1], /id="planChip"/);
    assert.match(DROPDOWN[1], /id="navStatusPill"/);
  });
});

describe('account dropdown contents', () => {
  test('it carries the four moved entries', () => {
    assert.ok(DROPDOWN, 'account dropdown must exist');
    for (const re of [
      /data-action="toggleSettings"/,
      /data-action="openFeatureRequest"/,
      /href="\/bias-report\.html"/,
      /data-action="doLogout"/,
    ]) assert.match(DROPDOWN[1], re);
  });

  test('every actionable entry is a menuitem', () => {
    const items = DROPDOWN[1].match(/role="menuitem"/g) || [];
    assert.equal(items.length, 4, 'Settings, Suggest, explainer, Log out');
  });

  test('the email header row is NOT a menuitem — it is not actionable', () => {
    const head = /<div class="acct-dd-head">([\s\S]*?)<\/div>\s*<div class="acct-dd-sep"/.exec(DROPDOWN[1]);
    assert.ok(head, 'the head row must exist');
    assert.doesNotMatch(head[1], /role="menuitem"/);
    assert.match(head[1], /id="accountEmail"/);
  });

  test('status rows keep their colour semantics (green dot when connected)', () => {
    assert.match(APP_HTML, /\.nav-status-pill \.dot\.ok\{background:#22c55e\}/);
    assert.match(APP_HTML, /\.plan-chip \.plan-dot\{[^}]*background:#4ade80/);
  });

  test('the route is unchanged — still /bias-report.html', () => {
    assert.match(DROPDOWN[1], /href="\/bias-report\.html"/);
  });
});

describe('avatar trigger', () => {
  const trigger = /<button[^>]*id="accountAvatarBtn"[\s\S]*?>/.exec(APP_HTML);

  test('it exists and replaces the email as the trigger', () => {
    assert.ok(trigger, 'avatar trigger must exist');
    assert.doesNotMatch(APP_HTML, /class="account-chip"/);
    assert.doesNotMatch(APP_HTML, /class="acct-email"/);
  });

  test('it carries the required ARIA', () => {
    assert.match(trigger[0], /aria-haspopup="menu"/);
    assert.match(trigger[0], /aria-expanded="false"/);
    assert.match(trigger[0], /aria-controls="accountDropdown"/);
  });

  test('it is wired through the delegated map, not an inline handler', () => {
    assert.match(trigger[0], /data-action="toggleAccountMenu"/);
    assert.doesNotMatch(trigger[0], /onclick/);
    assert.match(APP_HTML, /toggleSettings, toggleAccountMenu,/);
  });

  test('the dropdown starts hidden', () => {
    assert.match(APP_HTML, /<div class="account-dropdown"[^>]*hidden>/);
  });
});

describe('accountInitial()', () => {
  const ctx = { };
  vm.createContext(ctx);
  vm.runInContext(extractFunction('accountInitial'), ctx);

  test('takes the first letter, uppercased', () => {
    assert.equal(ctx.accountInitial('jasper@example.com'), 'J');
    assert.equal(ctx.accountInitial('Zoe@example.com'), 'Z');
  });

  test('skips leading punctuation rather than rendering it', () => {
    assert.equal(ctx.accountInitial('_admin@example.com'), 'A');
    assert.equal(ctx.accountInitial('.hidden@example.com'), 'H');
  });

  test('handles a leading digit', () => {
    assert.equal(ctx.accountInitial('7up@example.com'), '7');
  });

  test('falls back to a glyph rather than an empty circle', () => {
    for (const v of ['', null, undefined, '???']) {
      assert.equal(ctx.accountInitial(v), '?', `input ${JSON.stringify(v)}`);
    }
  });
});

describe('keyboard and dismissal behaviour is registered', () => {
  test('Escape closes and restores focus to the trigger', () => {
    const src = extractFunction('closeAccountMenu');
    assert.match(src, /if \(restoreFocus\) btn\.focus\(\)/);
    assert.match(APP_HTML, /e\.key === 'Escape'[\s\S]{0,80}closeAccountMenu\(true\)/);
  });

  test('outside click closes without stealing focus', () => {
    assert.match(APP_HTML, /!menu\.contains\(e\.target\)\) closeAccountMenu\(false\)/);
  });

  test('activating an item closes the menu', () => {
    assert.match(APP_HTML, /closest\('\[role="menuitem"\]'\)[\s\S]{0,60}closeAccountMenu\(false\)/);
  });

  test('arrow keys move between items', () => {
    assert.match(APP_HTML, /e\.key === 'ArrowDown'/);
    assert.match(APP_HTML, /e\.key === 'ArrowUp'/);
  });

  test('keyboard activation moves focus into the menu, mouse click does not', () => {
    // e.detail === 0 distinguishes an Enter/Space-synthesised click.
    assert.match(extractFunction('toggleAccountMenu'), /e\.detail === 0/);
  });

  test('hidden items are skipped when moving focus', () => {
    // The Suggest entry is hidden by plan; it must not swallow an arrow press.
    assert.match(extractFunction('accountMenuItems'), /offsetParent !== null/);
  });
});

describe('mobile breakpoint', () => {
  test('primary links collapse below 900px', () => {
    assert.match(APP_HTML, /@media \(max-width: 900px\)\{[\s\S]*?\.topbar-nav\{display:none\}/);
  });

  test('the hamburger appears at the same breakpoint', () => {
    const block = /@media \(max-width: 900px\)\{([\s\S]*?)\n {4}\}/.exec(APP_HTML);
    assert.ok(block, 'the 900px block must exist');
    assert.match(block[1], /\.mobile-menu-button\{display:flex\}/);
  });

  test('the account menu is NOT hidden at that breakpoint', () => {
    const block = /@media \(max-width: 900px\)\{([\s\S]*?)\n {4}\}/.exec(APP_HTML);
    assert.doesNotMatch(block[1], /\.account-menu\{display:none\}/);
    assert.doesNotMatch(block[1], /\.account-avatar\{display:none\}/);
  });

  test('the hamburger controls the nav it toggles', () => {
    const btn = /<button class="mobile-menu-button"[^>]*>/.exec(APP_HTML);
    assert.ok(btn);
    assert.match(btn[0], /aria-controls="topbarNav"/);
    assert.match(APP_HTML, /<nav class="topbar-nav" id="topbarNav">/);
  });

  test('the superseded 640px label-swap workaround is gone', () => {
    // The rules, not the comment explaining why they were removed.
    assert.doesNotMatch(MARKUP, /\.nav-btn-fr\s*[{.]/);
    assert.doesNotMatch(MARKUP, /class="[^"]*\bfr-(short|long)\b/);
  });
});

describe('ids the existing render functions drive still exist', () => {
  // renderPlanChip, ping and syncFeatureRequestNav address these by id. Moving
  // the markup must not silently strand them.
  for (const id of [
    'planChip', 'planChipLabel', 'navStatusPill', 'navStatusDot',
    'navStatusLabel', 'featureRequestNavBtn', 'logoutBtn', 'accountEmail',
  ]) {
    test(`#${id} is present`, () => {
      assert.match(APP_HTML, new RegExp('id="' + id + '"'));
    });
  }
});
