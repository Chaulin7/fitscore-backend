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
    assert.ok(section('D').includes('Demo requests are deleted 12 months after we receive them, unless the requester becomes a customer, in which case the data becomes part of the customer relationship. The same 12-month period applies to the notification email in our inbox.'));
  });

  test('E · feature requests: FEATURE_REQUEST_RETENTION_DAYS', () => {
    const days = constant('FEATURE_REQUEST_RETENTION_DAYS');
    assert.ok(section('E').includes(`Feature requests are deleted from our database ${days} days after you send them, or earlier if your organization deletes all its data. The same ${days}-day period applies to the notification email in our inbox.`));
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

test('account deletion on request is described the same in the policy, the DPA and the records of processing', () => {
  const flatten = (s) => s.replace(/<!--[\s\S]*?-->/g, ' ').replace(/&rsquo;/g, "'").replace(/\s+/g, ' ');
  const policy = flatten(fs.readFileSync(path.join(ROOT, 'public/privacy.html'), 'utf8'));
  assert.ok(policy.includes('<strong>Deleting your account:</strong> you can ask us to delete your account by emailing <a href="mailto:__CONTACT_EMAIL__">__CONTACT_EMAIL__</a>. We delete the account and all associated data within 30 days, after your subscription has ended. Invoices and payment records remain with Stripe, and __LEGAL_NAME__ keeps its own accounting records for 7 years as required by Dutch tax law.'));
  const dpa = flatten(fs.readFileSync(path.join(ROOT, 'docs/privacy/dpa-template.md'), 'utf8'));
  assert.ok(dpa.includes("On the Client's request, by email to jasper@cvsprings.com, the Processor deletes the Client's account and all associated data within 30 days, after the Client's subscription has ended. Invoices and payment records remain with Stripe, and Joyaco B.V. keeps its own accounting records for 7 years as required by Dutch tax law."));
  const ropa = flatten(fs.readFileSync(path.join(ROOT, 'docs/privacy/records-of-processing.md'), 'utf8'));
  for (const phrase of ['## Account deletion on request', 'emailing jasper@cvsprings.com', 'within 30 days, after the subscription has ended',
    'node scripts/delete-org.js <orgId>', 'refuses while the subscription has not ended', 'Stripe is not touched',
    'keeps its own accounting records for 7 years as required by Dutch tax law']) assert.ok(ropa.includes(phrase), phrase);
  assert.doesNotMatch(ropa, /no account-deletion path|no deletion rule applies yet/);
});

test('the records of processing include Stripe, as the Privacy Policy describes it', () => {
  const ropa = fs.readFileSync(path.join(ROOT, 'docs/privacy/records-of-processing.md'), 'utf8');
  const flat = ropa.replace(/<!--[\s\S]*?-->/g, ' ').replace(/\s+/g, ' ');
  const activity = /## Processing activity 4 — Billing through Stripe([\s\S]*?)## Categories of recipients/.exec(ropa);
  assert.ok(activity, 'no Stripe processing activity');
  const a = activity[1].replace(/\s+/g, ' ');
  for (const phrase of ['| Purpose | Billing and invoicing', 'Billing name, email address, company, address, VAT ID, payment details',
    'Stripe customer and subscription references', 'Art. 6(1)(b) GDPR', 'Art. 6(1)(c) GDPR',
    'Stripe Payments Europe, Limited (Ireland)', 'for as long as the account exists']) assert.ok(a.includes(phrase), phrase);
  assert.ok(a.includes('deletes them with the account'), 'activity 4 retention follows the deletion process');
  // Same safeguard, word for word, as the policy's Stripe row (apostrophes aside).
  const policySafeguard = 'Stripe may transfer data to Stripe, LLC in the US; any such transfer is covered by Stripe, LLC\'s certification under the EU-US Data Privacy Framework, with the European Commission\'s Standard Contractual Clauses in Stripe\'s Data Transfers Addendum as a fallback';
  const policy = fs.readFileSync(path.join(ROOT, 'public/privacy.html'), 'utf8').replace(/&rsquo;/g, "'");
  assert.ok(policy.includes(policySafeguard), 'the policy still states the safeguard this mirrors');
  assert.ok(a.includes(policySafeguard), 'activity 4 transfers');
  assert.ok(flat.includes(policySafeguard.replace(/\s+/g, ' ')), 'transfers section');
  assert.match(flat, /- Stripe Payments Europe, Limited \(Ireland\) — billing and payments/, 'categories of recipients');
});
