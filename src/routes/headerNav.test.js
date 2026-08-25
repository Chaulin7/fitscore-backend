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

describe('primary nav holds the five inline destinations', () => {
  // WAS "exactly the three destinations". The restructure that moved Bias
  // monitoring and Suggest out treated the overflow as an item-count problem;
  // it was one overlong label. "How bias monitoring works" (25 chars) and
  // "Suggest an improvement" (22) cost ~180px between them. Shortened, both fit
  // inline — and the row collapses at 1100px, where it measurably fits.
  test('the nav exists and contains the three tab buttons', () => {
    assert.ok(NAV, 'topbar-nav must exist');
    const tabs = [...NAV[1].matchAll(/data-tab="([a-z]+)"/g)].map((m) => m[1]);
    assert.deepEqual(tabs, ['analyzer', 'audit', 'history']);
  });

  test('the nav holds five items in the target order', () => {
    const items = [...NAV[1].matchAll(/<(?:button|a)\b[^>]*>([^<]+)</g)].map((m) => m[1].trim());
    assert.deepEqual(items, ['Analyzer', 'Audit Log', 'Role History', 'Bias monitoring', 'Suggest']);
  });

  test('the bias link is relabelled but keeps its destination', () => {
    assert.match(NAV[1], /<a class="nav-btn" href="\/bias-report\.html">Bias monitoring<\/a>/);
    // The label is what overflowed; the route was never the problem.
    assert.doesNotMatch(NAV[1], /How bias monitoring works/);
  });

  test('Suggest is inline and keeps the id that plan-gates it', () => {
    assert.match(NAV[1], /id="featureRequestNavBtn"/);
    assert.match(NAV[1], /data-action="openFeatureRequest"/);
    // syncFeatureRequestNav() shows/hides it by plan and addresses it by id.
    assert.match(APP_HTML, /function syncFeatureRequestNav\(\)[\s\S]{0,200}getElementById\('featureRequestNavBtn'\)/);
  });

  test('the long labels that caused the overflow are gone from the bar', () => {
    assert.doesNotMatch(TOPBAR[1], /Suggest an improvement<\/button>/);
    assert.doesNotMatch(TOPBAR[1], /How bias monitoring works/);
  });

  test('Settings stays out of the nav — it is in the account menu', () => {
    assert.doesNotMatch(NAV[1], /toggleSettings/);
  });

  test('the standalone settings gear button is still gone from the bar', () => {
    assert.ok(TOPBAR, 'topbar must exist');
    assert.doesNotMatch(TOPBAR[1], /class="settings-btn"/);
  });

  test('the plan chip and status pill are back as direct bar children', () => {
    // They moved into the dropdown when the row was over budget. The avatar
    // freed the width the email chip took, so they no longer need to hide.
    assert.ok(DROPDOWN, 'account dropdown must exist');
    assert.match(TOPBAR[1], /id="navStatusPill"/);
    assert.match(TOPBAR[1], /id="planChip"/);
    assert.doesNotMatch(DROPDOWN[1], /id="planChip"/);
    assert.doesNotMatch(DROPDOWN[1], /id="navStatusPill"/);
  });

  test('the bar order is logo, nav, Connected, search, Pro, avatar', () => {
    const order = [...TOPBAR[1].matchAll(/id="(topbarNav|navStatusPill|navSearchBtn|planChip|accountAvatarBtn)"/g)].map((m) => m[1]);
    assert.deepEqual(order, ['topbarNav', 'navStatusPill', 'navSearchBtn', 'planChip', 'accountAvatarBtn']);
  });
});

describe('account dropdown contents', () => {
  test('it carries Settings, Metrics and Log out', () => {
    // WAS "the four moved entries". Bias monitoring and Suggest went back to
    // the bar; the plan and connection chips went with them. What remains is
    // the conventional account-menu payload, plus the operator-only Metrics
    // entry — which ships `hidden` and is revealed by updateAccountChip only
    // when the server says the session is the platform owner.
    assert.ok(DROPDOWN, 'account dropdown must exist');
    assert.match(DROPDOWN[1], /data-action="toggleSettings"/);
    assert.match(DROPDOWN[1], /data-action="doLogout"/);
    assert.match(DROPDOWN[1], /data-action="openAdminMetrics"/);
  });

  test('the Metrics entry ships hidden — it is never visible by default', () => {
    // The one that matters: if this attribute is ever dropped, the item shows
    // for every signed-in customer. It grants them nothing (the route 404s),
    // but it advertises a page that is meant to stay unadvertised.
    const item = /<button[^>]*id="adminMetricsItem"[\s\S]*?>/.exec(DROPDOWN[1]);
    assert.ok(item, 'the Metrics entry must exist');
    assert.match(item[0], /\shidden\b/);
  });

  test('the entries that returned to the bar are not duplicated here', () => {
    assert.doesNotMatch(DROPDOWN[1], /openFeatureRequest/);
    assert.doesNotMatch(DROPDOWN[1], /bias-report\.html/);
  });

  test('every actionable entry is a menuitem', () => {
    // Asserted structurally rather than as a count. A hardcoded number says
    // nothing about WHICH entry lost its role, and it fails every time the menu
    // legitimately grows — which is how it gets "fixed" by bumping the number
    // without checking. Every actionable row is an .acct-dd-item button; each
    // one must carry role="menuitem" or it drops out of arrow-key navigation.
    const buttons = DROPDOWN[1].match(/<button[^>]*class="acct-dd-item[^"]*"[^>]*>/g) || [];
    assert.ok(buttons.length >= 3, `expected at least Settings, Metrics and Log out, got ${buttons.length}`);
    for (const b of buttons) {
      assert.match(b, /role="menuitem"/, `actionable entry is not a menuitem: ${b}`);
    }
    // And nothing that is NOT an item claims to be one.
    const roles = DROPDOWN[1].match(/role="menuitem"/g) || [];
    assert.equal(roles.length, buttons.length, 'a non-button element claims role="menuitem"');
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

  test('the route is unchanged — still /bias-report.html, now from the bar', () => {
    assert.match(NAV[1], /href="\/bias-report\.html"/);
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

describe('bar alignment: nav hard left, cluster hard right', () => {
  // The regression: .topbar-brand carried margin-right:auto. It predates the
  // restructure and was invisible for as long as the bar overflowed, because an
  // auto margin can only absorb free space and there was none. Once the row fit
  // again it absorbed ALL of it right after the logo, floating the nav into the
  // middle of the bar. Not justify-content, not flex-grow — neither is present.
  test('the brand does not carry an auto margin', () => {
    const brand = /\.topbar-brand\{([^}]*)\}/.exec(APP_HTML);
    assert.ok(brand, '.topbar-brand must exist');
    assert.doesNotMatch(brand[1], /margin-right:\s*auto/);
    assert.doesNotMatch(brand[1], /margin:\s*[^;]*auto/);
  });

  test('the topbar uses no justify-content and the brand does not grow', () => {
    const bar = /\.topbar\{([\s\S]*?)\}/.exec(APP_HTML);
    assert.doesNotMatch(bar[1], /justify-content/);
    const brand = /\.topbar-brand\{([^}]*)\}/.exec(APP_HTML);
    assert.doesNotMatch(brand[1], /flex-grow|flex:\s*[1-9]/);
  });

  test('exactly one auto margin holds the free space, and it is on the pill', () => {
    // One gap in the bar, between the nav and the right-hand cluster.
    const autos = [...APP_HTML.matchAll(/^\s*(\.(?:topbar|nav|plan|account)[\w-]*)\{[^}]*margin[^;}]*auto/gm)]
      .map((m) => m[1]);
    assert.deepEqual([...new Set(autos)], ['.nav-status-pill']);
  });

  test('the pill keeps its auto margin at narrow widths too', () => {
    // The nav is display:none below 1100px and a hidden element's margins do
    // not apply, which is why the auto margin cannot live on .topbar-nav.
    const narrow = /@media\(max-width:640px\)\{[\s\S]*?\.nav-status-pill\{([^}]*)\}/.exec(APP_HTML);
    assert.ok(narrow, 'the 640px pill rule must exist');
    assert.match(narrow[1], /auto/, 'the right cluster would collapse leftward without it');
  });
});

describe('the bias link is visually identical to the tab buttons', () => {
  test('nav-btn cancels the UA underline on the class, not inline', () => {
    // It was cancelled by style="text-decoration:none" on that one element,
    // which was dropped when the link was restored. Base state, not hover.
    const btn = /\.nav-btn\{([\s\S]*?)\n\}/.exec(APP_HTML);
    assert.ok(btn, '.nav-btn must exist');
    assert.match(btn[1], /text-decoration:none/);
  });

  test('the link carries no inline style of its own', () => {
    const link = /<a class="nav-btn" href="\/bias-report\.html"[^>]*>/.exec(APP_HTML);
    assert.ok(link, 'the bias link must exist');
    assert.doesNotMatch(link[0], /style=/);
  });

  test('hover and focus cannot reintroduce an underline', () => {
    assert.match(APP_HTML, /\.nav-btn:hover,\.nav-btn:focus\{text-decoration:none\}/);
  });

  test('it shares the same class as the tab buttons, so hover/active match', () => {
    const items = [...NAV[1].matchAll(/<(?:button|a)\s+class="([^"]*)"/g)].map((m) => m[1]);
    for (const cls of items) assert.match(cls, /\bnav-btn\b/);
  });
});

describe('collapse breakpoint', () => {
  // RAISED from 900px to 1100px when the inline items came back. Measured, the
  // five-item row plus Connected, search, Pro and the avatar needs ~997-1028px
  // of content width; a 901px viewport offers 837px. 900px would have put the
  // row ~180px over budget and reproduced the original off-screen bug in a
  // narrower band, so the breakpoint moved to where the row actually fits.
  test('primary links collapse below 1100px', () => {
    assert.match(APP_HTML, /@media \(max-width: 1100px\)\{[\s\S]*?\.topbar-nav\{display:none\}/);
  });

  test('the old 900px collapse is gone', () => {
    assert.doesNotMatch(APP_HTML, /@media \(max-width: 900px\)\{[\s\S]{0,200}\.topbar-nav\{display:none\}/);
  });

  test('the hamburger appears at the same breakpoint', () => {
    const block = /@media \(max-width: 1100px\)\{([\s\S]*?)\n {4}\}/.exec(APP_HTML);
    assert.ok(block, 'the 1100px block must exist');
    assert.match(block[1], /\.mobile-menu-button\{display:flex\}/);
  });

  test('the account menu is NOT hidden at that breakpoint', () => {
    const block = /@media \(max-width: 1100px\)\{([\s\S]*?)\n {4}\}/.exec(APP_HTML);
    assert.doesNotMatch(block[1], /\.account-menu\{display:none\}/);
    assert.doesNotMatch(block[1], /\.account-avatar\{display:none\}/);
  });

  test('the hamburger controls the nav it toggles', () => {
    const btn = /<button class="mobile-menu-button"[^>]*>/.exec(APP_HTML);
    assert.ok(btn);
    assert.match(btn[0], /aria-controls="topbarNav"/);
    assert.match(APP_HTML, /<nav class="topbar-nav" id="topbarNav">/);
  });

  test('the superseded label-swap workaround stays gone', () => {
    assert.doesNotMatch(MARKUP, /\.nav-btn-fr\s*[{.]/);
    assert.doesNotMatch(MARKUP, /class="[^"]*\bfr-(short|long)\b/);
  });

  test('below 640px the Connected label drops to the dot alone', () => {
    // Measured: brand, hamburger, Connected, search, Pro and the avatar come to
    // ~419px against ~359px available on a 375px phone. The label is the
    // cheapest ~65px to reclaim; the dot still carries the state and the title
    // attribute still names it.
    assert.match(APP_HTML, /@media\(max-width:640px\)\{[\s\S]{0,200}\.nav-status-pill \.conn-label\{display:none\}/);
    assert.match(APP_HTML, /<span class="conn-label" id="navStatusLabel">/);
  });

  test('the Pro label is NOT dropped at narrow widths', () => {
    // Three characters, and the one a recruiter looks for. Only the Connected
    // label is sacrificed, and only because its dot already carries the state.
    assert.doesNotMatch(APP_HTML, /#planChipLabel\s*\{[^}]*display:\s*none/);
    assert.doesNotMatch(APP_HTML, /\.plan-chip\s+span\s*\{[^}]*display:\s*none/);
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
