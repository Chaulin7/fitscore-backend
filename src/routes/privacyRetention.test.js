'use strict';

/**
 * src/routes/privacyRetention.test.js — the retention periods the Privacy Policy
 * promises are the ones the code enforces.
 *
 * Each section names a number; each number lives in one constant in
 * services/db.js and drives a daily job. If one changes without the other, a
 * visitor is told something the system does not do.
 */

const fs = require('node:fs');
const path = require('node:path');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..', '..');
const DB_SRC = fs.readFileSync(path.join(ROOT, 'src/services/db.js'), 'utf8');
const constant = (name) => Number(new RegExp(`const ${name} = (\\d+);`).exec(DB_SRC)[1]);
const privacy = fs.readFileSync(path.join(ROOT, 'public/privacy.html'), 'utf8');
const section = (letter) => {
  const m = new RegExp(`<!-- =+ SECTION ${letter} — [^=]+=+ -->([\\s\\S]*?)<\\/div>\\s*<\\/div>`).exec(privacy);
  assert.ok(m, `privacy.html has no section ${letter}`);
  return m[1].replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ');
};

describe('the numbers match the code', () => {
  test('D · demo requests: DEMO_REQUEST_RETENTION_MONTHS', () => {
    assert.equal(constant('DEMO_REQUEST_RETENTION_MONTHS'), 12);
    assert.ok(section('D').includes('Demo requests are deleted 12 months after we receive them, unless the requester becomes a customer, in which case the data becomes part of the customer relationship.'));
  });

  test('E · feature requests: FEATURE_REQUEST_RETENTION_DAYS', () => {
    const days = constant('FEATURE_REQUEST_RETENTION_DAYS');
    assert.ok(section('E').includes(`Feature requests are deleted from our database ${days} days after you send them, or earlier if your organization deletes all its data.`));
  });

  test('F · trial offers: TRIAL_OFFER_RETENTION_MONTHS', () => {
    assert.equal(constant('TRIAL_OFFER_RETENTION_MONTHS'), 12);
    assert.ok(section('F').includes('If you do not take up the trial, the offer and the record of emails we sent about it are deleted 12 months after the offer expired. If you take it up, they become part of the customer relationship.'));
  });
});

describe('sections E and F say what is collected and why', () => {
  test('E · feature requests', () => {
    const e = section('E');
    for (const phrase of ['Pro and Team plans', 'only to consider your suggestion and to reply to you',
      'The category, title and description you write, your account email address, your organization and its plan, and the time you sent it',
      'delivered to our inbox as an email via Resend', 'href="#privacyContactLine"']) assert.ok(e.includes(phrase), phrase);
  });

  test('F · trial offers', () => {
    const f = section('F');
    for (const phrase of ['The email address we sent the offer to and your company name',
      'the customer reference our payment provider (Stripe) gives your billing account',
      'a record of each trial email we sent (address, type, time and whether it was delivered)',
      'the trial emails are sent via Resend', 'href="#privacyContactLine"']) assert.ok(f.includes(phrase), phrase);
  });
});

test('the internal records of processing: Resend sends every email, not just resets', () => {
  const ropa = fs.readFileSync(path.join(ROOT, 'docs/privacy/records-of-processing.md'), 'utf8');
  assert.doesNotMatch(ropa, /reset emails only|for reset emails|Resend \(if enabled\)|Resend is enabled/);
  for (const phrase of ['password resets, team', 'invitations and trial emails', 'confirmations to demo requesters',
    'contact-form messages, demo requests', 'and feature requests to our own inbox', "Resend's EU region (Ireland)"]) {
    assert.ok(ropa.includes(phrase), phrase);
  }
  assert.doesNotMatch(ropa, /Google Fonts/, 'fonts are self-hosted');
});
