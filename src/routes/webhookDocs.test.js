'use strict';

/**
 * src/routes/webhookDocs.test.js — the documented event list must match the code.
 *
 * docs/billing/README.md is the list an operator configures the live Stripe
 * endpoint FROM. A review caught it missing customer.subscription.paused, which
 * the code has handled since the paused state landed — and a missing event on
 * that endpoint fails silently: no error anywhere, just a feature that does
 * nothing. Nobody notices a doc drifting, so this notices for them.
 */

const fs = require('node:fs');
const path = require('node:path');

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..', '..');

/** The event names the webhook handler actually dispatches on. */
function handledEvents() {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'billing.js'), 'utf8');
  // Comments stripped first: the file discusses event names in prose, and those
  // must not be mistaken for registrations.
  const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const pick = (name) => {
    const m = code.match(new RegExp(`${name}\\s*=\\s*new Set\\(\\[([\\s\\S]*?)\\]\\)`));
    assert.ok(m, `${name} set not found in routes/billing.js`);
    return [...m[1].matchAll(/'([a-z_.]+)'/g)].map((x) => x[1]);
  };
  return [...pick('PLAN_MUTATING'), ...pick('TRIAL_EVENTS')];
}

/** The event names listed under "Events to send" in the billing README. */
function documentedEvents() {
  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'billing', 'README.md'), 'utf8');
  const start = doc.indexOf('**Events to send:**');
  assert.ok(start > -1, 'the README no longer has an "Events to send" list');
  // The list ends at the first line that is not a bullet or blank.
  const lines = doc.slice(start).split('\n').slice(1);
  const out = [];
  for (const line of lines) {
    const m = line.match(/^\s*-\s+`([a-z_.]+)`/);
    if (m) { out.push(m[1]); continue; }
    if (line.trim() === '' || /^\s*-\s/.test(line)) continue;
    break;
  }
  return out;
}

describe('the documented webhook events match the handled ones', () => {
  test('every event the code handles is documented', () => {
    const handled = handledEvents();
    const documented = documentedEvents();
    const missing = handled.filter((e) => !documented.includes(e));
    assert.deepEqual(missing, [],
      `docs/billing/README.md omits: ${missing.join(', ')} — an operator configuring the `
      + 'live endpoint from that list would silently not receive them');
  });

  test('every documented event is actually handled', () => {
    const handled = handledEvents();
    const documented = documentedEvents();
    const extra = documented.filter((e) => !handled.includes(e));
    assert.deepEqual(extra, [],
      `the README asks for events nothing handles: ${extra.join(', ')}`);
  });

  test('and the count the README states is the real count', () => {
    const doc = fs.readFileSync(path.join(ROOT, 'docs', 'billing', 'README.md'), 'utf8');
    const words = { five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11 };
    const m = doc.match(/That is \*\*([a-z]+)\*\* events/);
    assert.ok(m, 'the README no longer states a count');
    assert.equal(words[m[1]], handledEvents().length,
      'the stated count and the handled set disagree');
  });
});
