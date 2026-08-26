'use strict';

/**
 * src/routes/planPanel.test.js
 *
 * The topbar plan control: its markup contract and the HTML its renderers
 * produce for each tenant state.
 *
 * The control replaced a static <span> that carried a mouse-only
 * `chip.onclick = openBillingPortal` shortcut for the past_due case. Two things
 * are therefore worth holding to source:
 *
 *   1. It is a real <button> with the popup ARIA contract, on EVERY tier —
 *      including Free, where the old chip did nothing at all.
 *   2. Removing that shortcut added a step to the one journey where the user is
 *      actively losing access. So the past_due state must be unmissable in the
 *      panel and the portal must still be two clicks away (chip → panel →
 *      Manage billing). There is a test for exactly that below.
 *
 * The renderers are lifted out of the shipped page and executed, so these are
 * assertions about the real code rather than about a copy of it.
 */

const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { extractFunction } = require('../../test/helpers/pageSandbox');

const APP_HTML = fs.readFileSync(
  path.join(__dirname, '..', '..', 'public', 'app.html'), 'utf8',
);

// This file's own prose names attributes and code it describes; a comment must
// not read as the markup or the source it is talking about.
function stripComments(s) {
  return s.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}
const MARKUP = stripComments(APP_HTML);

// For assertions about SOURCE rather than markup. Line comments are stripped
// only when they occupy the whole line, so a "//" inside a URL cannot swallow
// real code and hide an offender — same rule as pricingCheckout.test.js. This
// file's own explanation of the removed shortcut quotes it verbatim, and the
// prose must not read as the code it describes.
const SOURCE = stripComments(APP_HTML).replace(/^[ \t]*\/\/.*$/gm, '');

// --- the shipped renderers, in a sandbox ------------------------------------
const { extractLine } = require('../../test/helpers/pageSandbox');
const { planPanelState, planActions } = require('../routes/billing');

const sandbox = vm.createContext({});
vm.runInContext([
  extractFunction(APP_HTML, 'escHtml'),
  extractLine(APP_HTML, 'const MEMBER_PLAN_NOTE ='),
  extractFunction(APP_HTML, 'planActionBtn'),
  extractFunction(APP_HTML, 'planActionsAt'),
  extractFunction(APP_HTML, 'planMeter'),
  extractFunction(APP_HTML, 'planRenewalLine'),
  extractFunction(APP_HTML, 'planBlockNote'),
  extractFunction(APP_HTML, 'renderPaidPanel'),
].join('\n'), sandbox);

// Builds the actions the SERVER would send for this org, so the panel tests
// render the real mapping instead of a fixture that can drift from it.
function withRealActions(summary, orgBilling, opts) {
  const o = Object.assign({ isOwner: true, canCheckout: true, canPortal: true }, opts || {});
  const state = planPanelState(orgBilling);
  return Object.assign({}, summary, {
    state,
    actions: planActions(state, { ...o, plan: orgBilling.plan || 'free' }),
    isOwner: o.isOwner,
  });
}

function primaryCount(html) {
  return (html.match(/class="btn btn-primary/g) || []).length;
}

function paidPanel(summary) {
  sandbox.__s = summary;
  return vm.runInContext('renderPaidPanel(__s)', sandbox);
}

// A summary shaped exactly like GET /api/billing/plan-summary returns.
function summaryFor(over) {
  return Object.assign({
    plan: 'pro',
    planName: 'Pro',
    priceLabel: '€49',
    per: '/month',
    taxNote: 'excl. VAT',
    subscriptionStatus: 'active',
    currentPeriodEnd: '2026-09-30T00:00:00.000Z',
    cancelAtPeriodEnd: false,
    comped: false,
    isOwner: true,
    billingConfigured: true,
    canManageBilling: true,
    billingBlockReason: null,
    canUpgrade: true,
    usage: {
      periodKey: '2026-08',
      analyses: { used: 12, limit: null },
      seats: { used: 1, limit: 1 },
    },
    entitlements: [
      { axis: 'analysesPerMonth', value: null, label: 'Unlimited CV analyses' },
      { axis: 'seats', value: 1, label: 'Single user' },
      { axis: 'customBranding', value: true, label: 'White-label reports — replace the CVsprings mark with your own logo' },
    ],
    upgrades: [],
  }, over || {});
}

describe('the chip is a real button with the popup contract', () => {
  const CHIP = /<button[^>]*id="planChip"[\s\S]*?>/.exec(MARKUP);

  test('it is a <button>, not a <span>', () => {
    assert.ok(CHIP, 'planChip must be a <button> element');
    assert.match(CHIP[0], /type="button"/);
  });

  test('it carries aria-haspopup="dialog", aria-expanded and aria-controls', () => {
    assert.match(CHIP[0], /aria-haspopup="dialog"/,
      'the panel is a status-and-actions surface, not a role="menu"');
    assert.match(CHIP[0], /aria-expanded="false"/, 'must start collapsed');
    assert.match(CHIP[0], /aria-controls="planPanel"/);
  });

  test('it is wired through the delegated action map, not an inline handler', () => {
    assert.match(CHIP[0], /data-action="togglePlanPanel"/);
    assert.doesNotMatch(CHIP[0], /\son[a-z]+=/i);
  });

  test('the panel it controls exists, is a dialog, and starts hidden', () => {
    const panel = /<div[^>]*id="planPanel"[^>]*>/.exec(MARKUP);
    assert.ok(panel, 'planPanel must exist');
    assert.match(panel[0], /role="dialog"/);
    assert.match(panel[0], /\bhidden\b/, 'a panel that starts open would flash on load');
    assert.match(panel[0], /aria-label="[^"]+"/, 'a dialog needs an accessible name');
  });

  test('the mouse-only onclick shortcut is gone', () => {
    assert.doesNotMatch(SOURCE, /chip\.onclick\s*=/,
      'the past_due shortcut was invisible to keyboard and assistive tech');
  });

  test('the scanner would catch a reinstated shortcut (guards a vacuous pass)', () => {
    const sample = 'function f(){\n  chip.onclick=openBillingPortal;\n}';
    assert.match(sample.replace(/^[ \t]*\/\/.*$/gm, ''), /chip\.onclick\s*=/);
  });

  test('every panel action is registered in the delegated map', () => {
    const map = /const delegatedHandlers = \{[\s\S]*?\n\};/.exec(APP_HTML);
    assert.ok(map, 'delegated handler map not found');
    assert.match(map[0], /\btogglePlanPanel\b/);
    assert.match(map[0], /\bstartPlanCheckout\b/);
    assert.match(map[0], /\bretryPlanPanel\b/, 'the retry button would be inert without this');
  });
});

describe('paid panel: what a Pro tenant sees', () => {
  test('tier name, price and billing interval all render', () => {
    const html = paidPanel(summaryFor());
    assert.match(html, /Pro/);
    assert.match(html, /€49/);
    assert.match(html, /\/month/);
    assert.match(html, /excl\. VAT/);
  });

  test('the renewal date is shown', () => {
    const html = paidPanel(summaryFor());
    assert.match(html, /Renews/);
  });

  test('an incomplete subscription does not claim it will renew', () => {
    // Its first payment never cleared, so there is no period and nothing to
    // renew. Same class of claim as "Renews" beside "Payment failed".
    const html = paidPanel(withRealActions(summaryFor({ subscriptionStatus: 'incomplete' }),
      { plan: 'pro', subscriptionStatus: 'incomplete' }));
    assert.doesNotMatch(html, /Renews/);
    assert.match(html, /Payment not completed/);
    assert.match(html, /Complete payment/, 'the only useful control is the one that fixes it');
  });

  test('a scheduled cancellation says "Ends", not "Renews"', () => {
    const html = paidPanel(summaryFor({ cancelAtPeriodEnd: true }));
    assert.match(html, /Ends/);
    assert.match(html, /cancellation scheduled/);
    assert.doesNotMatch(html, /Renews/);
  });

  test('usage renders against the tracked limits', () => {
    const html = paidPanel(summaryFor());
    assert.match(html, /CV analyses/);
    assert.match(html, /unlimited/, 'a null limit reads as unlimited, not as 0');
    assert.match(html, /Members/);
  });

  test('a capped tier draws a real meter with a bounded width', () => {
    const html = paidPanel(summaryFor({
      usage: { periodKey: '2026-08', analyses: { used: 30, limit: 25 }, seats: { used: 1, limit: 1 } },
    }));
    const w = /style="width:(\d+)%"/.exec(html);
    assert.ok(w, 'expected a meter');
    assert.ok(Number(w[1]) <= 100, 'over-quota must clamp, not overflow the bar');
  });

  test('entitlements come from the payload, not from a hardcoded list', () => {
    const html = paidPanel(summaryFor({
      entitlements: [{ axis: 'analysesPerMonth', value: null, label: 'A COMPLETELY MADE UP ENTITLEMENT' }],
    }));
    assert.match(html, /A COMPLETELY MADE UP ENTITLEMENT/,
      'the template must render whatever the server said');
    assert.doesNotMatch(html, /White-label/, 'nothing may be baked into the template');
  });

  test('Manage billing appears for an owner who can use it', () => {
    const html = paidPanel(withRealActions(summaryFor(),
      { plan: 'pro', subscriptionStatus: 'active' }));
    assert.match(html, /data-action="openBillingPortal"/);
    assert.match(html, /Manage billing/);
  });

  test('on Pro, Manage billing is the primary and the upsell is not', () => {
    // Pro customers mostly open this for invoices, so billing outranks the
    // upsell — and there is exactly one primary in the panel.
    const html = paidPanel(withRealActions(summaryFor(),
      { plan: 'pro', subscriptionStatus: 'active' }));
    assert.match(html, /class="btn btn-primary btn-sm" data-action="openBillingPortal"/);
    assert.match(html, /class="btn btn-ghost btn-sm" data-action="startPlanCheckout"/);
    assert.equal(primaryCount(html), 1, 'one primary action maximum');
  });
});

describe('paid panel: upgrade section', () => {
  const teamUpgrade = {
    id: 'team', plan: 'team', name: 'Team', priceLabel: '€199', per: '/month',
    taxNote: 'excl. VAT', tagline: 'For agencies with a screening team.',
    gains: [{ axis: 'seats', from: 1, to: null, label: 'Multiple team members' }],
  };

  test('Pro sees a Team upgrade carrying its price, beside the seat limit', () => {
    const html = paidPanel(withRealActions(summaryFor({ upgrades: [teamUpgrade] }),
      { plan: 'pro', subscriptionStatus: 'active' }));
    assert.match(html, /Upgrade to Team/);
    assert.match(html, /€199/, 'a control that spends money must say how much');
    assert.match(html, /data-action="startPlanCheckout"[^>]*data-plan="team"/);
    // Anchored to the limit it unlocks: the button follows the Members row.
    assert.ok(html.indexOf('Members') < html.indexOf('data-plan="team"'),
      'the seat upgrade belongs next to the seat limit, not in the footer');
  });

  test('no secondary upsell copy survives beside the action', () => {
    const html = paidPanel(withRealActions(summaryFor({ upgrades: [teamUpgrade] }),
      { plan: 'pro', subscriptionStatus: 'active' }));
    assert.doesNotMatch(html, /class="pp-up"/, 'the upsell block is gone');
    assert.doesNotMatch(html, /For agencies with a screening team/, 'no tagline copy');
  });

  test('Team sees no upgrade section at all — the empty list is what hides it', () => {
    const html = paidPanel(summaryFor({ plan: 'team', planName: 'Team', upgrades: [] }));
    assert.doesNotMatch(html, /Upgrade to/);
    assert.doesNotMatch(html, /startPlanCheckout/);
  });

  test('a member gets the owner note instead of a CTA that would 403', () => {
    const html = paidPanel(summaryFor({
      isOwner: false, canUpgrade: false, canManageBilling: false,
      billingBlockReason: 'NOT_OWNER', upgrades: [teamUpgrade],
    }));
    assert.doesNotMatch(html, /startPlanCheckout/, 'no upgrade button for a non-owner');
    assert.match(html, /Contact your organization owner to change the plan/);
  });
});

describe('paid panel: why an action is unavailable is always stated', () => {
  test('a member is told who can manage billing, not shown an empty area', () => {
    const html = paidPanel(summaryFor({
      isOwner: false, canManageBilling: false, billingBlockReason: 'NOT_OWNER',
    }));
    assert.doesNotMatch(html, /data-action="openBillingPortal"/);
    assert.match(html, /Contact your organization owner to change the plan/);
  });

  test('a comped org is told there is no subscription to manage', () => {
    const html = paidPanel(summaryFor({
      comped: true, canManageBilling: false, billingBlockReason: 'COMPED', canUpgrade: false,
    }));
    assert.doesNotMatch(html, /data-action="openBillingPortal"/);
    assert.match(html, /Your organization is on a complimentary plan — no billing to manage\./,
      'a comped design partner should read this as an explanation of their state, not a refusal');
    assert.doesNotMatch(html, /cannot|not allowed|unavailable|denied/i,
      'nothing here is being withheld from them');
  });

  test('an unconfigured deployment blames the server, not the user', () => {
    const html = paidPanel(summaryFor({
      billingConfigured: false, canManageBilling: false, billingBlockReason: 'BILLING_NOT_CONFIGURED',
    }));
    assert.match(html, /not configured/);
  });

  test('every block reason produces some explanation (no silent empty state)', () => {
    for (const reason of ['NOT_OWNER', 'BILLING_NOT_CONFIGURED', 'COMPED', 'NO_CUSTOMER']) {
      const html = paidPanel(summaryFor({ canManageBilling: false, billingBlockReason: reason }));
      assert.doesNotMatch(html, /data-action="openBillingPortal"/, `${reason} must not offer the portal`);
      assert.match(html, /class="pp-note"/, `${reason} produced no explanation`);
    }
  });
});

describe('past_due: the recovery path stays short and loud', () => {
  const pastDue = summaryFor({ subscriptionStatus: 'past_due' });

  test('the panel leads with a payment-failed alert', () => {
    const html = paidPanel(pastDue);
    assert.match(html, /class="pp-alert"/);
    assert.match(html, /Payment failed/);
    // Prominence is structural: the alert is emitted before the tier line, so
    // it is the first thing in the panel rather than a footnote under it.
    assert.ok(html.indexOf('pp-alert') < html.indexOf('pp-tier'),
      'the alert must come first in the panel, not below the plan details');
  });

  test('it does not promise a renewal while the invoice is failing', () => {
    const html = paidPanel(pastDue);
    assert.doesNotMatch(html, /Renews/,
      '"Renews" next to "Payment failed" asserts something that may not happen');
    assert.match(html, /Current period ends/, 'the date itself is still useful');
  });

  test('the portal is still reachable, and the label names the fix', () => {
    const html = paidPanel(withRealActions(pastDue,
      { plan: 'pro', subscriptionStatus: 'past_due' }));
    assert.match(html, /data-action="openBillingPortal"/,
      'removing the chip shortcut must not remove the recovery path');
    assert.match(html, /Update payment method/, '"Manage billing" understates it here');
    assert.doesNotMatch(html, /startPlanCheckout/, 'no upsell while a payment is failing');
    assert.equal(primaryCount(html), 1);
  });

  test('a healthy subscription shows no alert (guards a vacuous pass)', () => {
    assert.doesNotMatch(paidPanel(summaryFor()), /class="pp-alert"/);
  });

  test('a past_due MEMBER is still told where to go', () => {
    const html = paidPanel(summaryFor({
      subscriptionStatus: 'past_due', isOwner: false,
      canManageBilling: false, billingBlockReason: 'NOT_OWNER',
    }));
    assert.match(html, /Payment failed/);
    assert.match(html, /Contact your organization owner to change the plan/);
  });
});

describe('the free state is a modal, and never offers billing management', () => {
  test('openFreePlanModal exists and the loader routes free tenants to it', () => {
    assert.ok(/function openFreePlanModal\s*\(/.test(APP_HTML));
    // The branch lives in loadPlanPanel, which both the first open and Retry
    // go through — putting it in togglePlanPanel would skip it on retry.
    const load = extractFunction(APP_HTML, 'loadPlanPanel');
    assert.match(load, /plan\s*===\s*'free'/, 'the free branch must be driven by the server tier');
    assert.match(load, /openFreePlanModal/);
  });

  test('the free modal never renders a portal button', () => {
    const src = extractFunction(APP_HTML, 'openFreePlanModal');
    assert.doesNotMatch(src, /openBillingPortal/,
      'a free tenant has no Stripe customer, so that path must be absent, not merely disabled');
  });

  test('the free modal renders both paid tiers from the payload', () => {
    const src = extractFunction(APP_HTML, 'openFreePlanModal');
    assert.match(src, /sum\.upgrades/, 'the tiers come from the server, not the template');
    assert.match(src, /startPlanCheckout/);
    assert.doesNotMatch(src, /€49|€199/, 'prices must never be typed into the frontend');
  });

  test('no price or tier name is hardcoded in either renderer', () => {
    const paid = extractFunction(APP_HTML, 'renderPaidPanel');
    assert.doesNotMatch(paid, /€\s*\d/, 'prices come from the server payload only');
  });
});

describe('the panel closes the way the account menu does', () => {
  test('Escape closes it and outside clicks dismiss it', () => {
    assert.ok(/function closePlanPanel\s*\(/.test(APP_HTML));
    const src = APP_HTML.slice(APP_HTML.indexOf('function closePlanPanel'));
    assert.match(src, /Escape/, 'Esc must close the panel');
    assert.match(src, /menu\.contains\(e\.target\)/, 'outside clicks must dismiss it');
  });

  test('closing restores focus to the trigger', () => {
    const src = extractFunction(APP_HTML, 'closePlanPanel');
    assert.match(src, /restoreFocus/);
    assert.match(src, /btn\.focus\(\)/);
  });

  test('opening the panel closes the account menu, and vice versa', () => {
    assert.match(extractFunction(APP_HTML, 'togglePlanPanel'), /closeAccountMenu/);
    assert.match(extractFunction(APP_HTML, 'openAccountMenu'), /closePlanPanel/);
  });

  test('aria-expanded tracks the open state on both paths', () => {
    assert.match(extractFunction(APP_HTML, 'openPlanPanel'), /aria-expanded['"],\s*['"]true/);
    assert.match(extractFunction(APP_HTML, 'closePlanPanel'), /aria-expanded['"],\s*['"]false/);
  });
});

describe('the panel fails visibly, not silently', () => {
  const errCtx = vm.createContext({});
  vm.runInContext(extractFunction(APP_HTML, 'renderPlanPanelError'), errCtx);
  const errorHtml = vm.runInContext('renderPlanPanelError()', errCtx);

  test('the error state says something short and offers a retry', () => {
    assert.match(errorHtml, /Could not load your plan/);
    assert.match(errorHtml, /data-action="retryPlanPanel"/,
      'an error with no way forward is a dead end');
    assert.match(errorHtml, /Retry/);
  });

  test('the retry is a real button, wired through delegation', () => {
    assert.match(errorHtml, /<button[^>]*type="button"/);
    assert.doesNotMatch(errorHtml, /\son[a-z]+=/i, "script-src-attr 'none' blocks inline handlers");
  });

  test('a failed load renders the error state rather than leaving the panel empty', () => {
    const src = extractFunction(APP_HTML, 'loadPlanPanel');
    assert.match(src, /catch/, 'the fetch must be guarded');
    assert.match(src, /renderPlanPanelError/);
    assert.match(src, /openPlanPanel/, 'the panel must still open so the user sees the failure');
  });

  test('a hung request is bounded, so the panel cannot spin forever', () => {
    const src = extractFunction(APP_HTML, 'fetchPlanSummary');
    assert.match(src, /Promise\.race/, 'a request that never settles produces no rejection to catch');
    assert.match(src, /setTimeout/);
    assert.match(APP_HTML, /PLAN_SUMMARY_TIMEOUT_MS\s*=\s*\d+/);
    assert.match(src, /clearTimeout/, 'the timer must not outlive a successful load');
  });

  test('retry reuses the same loader, so the paths cannot drift apart', () => {
    const retry = extractFunction(APP_HTML, 'retryPlanPanel');
    assert.match(retry, /loadPlanPanel/);
    const toggle = extractFunction(APP_HTML, 'togglePlanPanel');
    assert.match(toggle, /loadPlanPanel/);
  });
});
