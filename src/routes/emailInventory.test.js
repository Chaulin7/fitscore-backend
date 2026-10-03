'use strict';

/**
 * src/routes/emailInventory.test.js — every email the app sends, and the
 * Privacy Policy that has to describe them.
 *
 * The policy's Resend row went stale twice: it said "recruiter email addresses
 * only" while the app also mailed team invites, trial notices, demo requesters
 * and the operator's inbox. Nothing connected the two. This file does:
 *
 *   1. INVENTORY. Every place the server hands a message to Resend (the SDK's
 *      emails.send, or a raw POST to api.resend.com) is listed below with its
 *      recipient and contents. A new send site fails the test until it is added
 *      here — which is the moment to check the policy still covers it.
 *   2. POLICY. The Resend row names every recipient category in the inventory,
 *      says "never candidate data", and the demo-request section exists.
 *   3. NO CANDIDATE DATA. None of the modules that build these emails reads
 *      candidate or audit data: they never load the scoring, extraction or
 *      audit code, and their email bodies use none of the audit-record fields.
 */

const fs = require('node:fs');
const path = require('node:path');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// file -> [{ what, to, contains }]. Order inside a file follows the source.
const INVENTORY = {
  'src/routes/auth.js': [
    { what: 'password reset', to: 'recruiter account (the requesting user)', contains: 'reset link (30 min)' },
  ],
  'src/routes/team.js': [
    { what: 'team invitation', to: 'invited team member', contains: 'organization name, invite link (7 days)' },
  ],
  'src/services/trialEmail.js': [
    { what: 'trial ending soon', to: 'trial offer address / org owner / Stripe customer email', contains: 'company name, plan, end date, billing-portal link' },
    { what: 'trial welcome', to: 'checkout email and/or trial offer address', contains: 'company name, plan, end date, signup link' },
    { what: 'trial ended (paused)', to: 'trial offer address / org owner / Stripe customer email', contains: 'company name, plan, portal and app links' },
  ],
  // Both demo emails go through one sendOne() helper: one send site, two emails.
  'src/routes/demo.js': [
    { what: 'demo request notification', to: 'our inbox (DEMO_NOTIFY_EMAIL)', contains: 'name, email, agency, note, time' },
    { what: 'demo request confirmation', to: 'demo requester', contains: 'fixed text, EU AI Act checklist PDF' },
  ],
  'src/routes/featureRequests.js': [
    { what: 'feature request notification', to: 'our inbox (FEATURE_REQUEST_NOTIFY_EMAIL)', contains: 'category, title, description, org name/id, user email, plan, time' },
  ],
  'src/routes/contact.js': [
    { what: 'contact-form message', to: 'our inbox (CONTACT_EMAIL)', contains: 'name, email, message, page language, time' },
  ],
};

const SEND_SITE = /\.emails\.send\(|https:\/\/api\.resend\.com\/emails/g;

function sourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(rel));
    else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) out.push(rel);
  }
  return out;
}

describe('inventory: every Resend send site is accounted for', () => {
  const found = {};
  for (const rel of [...sourceFiles('src'), ...sourceFiles('scripts')]) {
    const n = (read(rel).match(SEND_SITE) || []).length;
    if (n) found[rel.split(path.sep).join('/')] = n;
  }

  test('no file sends email that the inventory does not list', () => {
    assert.deepEqual(Object.keys(found).sort(), Object.keys(INVENTORY).sort(),
      'a module started (or stopped) sending email: update INVENTORY and check the Privacy Policy\'s Resend row');
  });

  test('each file sends exactly the emails listed for it', () => {
    // trialEmail.js has one send site per message kind; demo.js routes its two
    // emails through a single helper.
    const SITES = { 'src/routes/demo.js': 1 };
    for (const [file, emails] of Object.entries(INVENTORY)) {
      const expected = SITES[file] || emails.length;
      assert.equal(found[file], expected, `${file}: ${found[file]} send site(s), expected ${expected}`);
    }
  });
});

describe('the Privacy Policy describes every recipient', () => {
  const privacy = read('public/privacy.html');
  const visible = privacy.replace(/<!--[\s\S]*?-->/g, '');
  const resendRow = /<td>Resend<\/td>\s*<td>([\s\S]*?)<\/td>/.exec(visible)[1];

  test('the Resend row names each recipient category and each kind of email', () => {
    for (const phrase of [
      'password resets', 'trial notices', 'recruiter accounts', 'organization&rsquo;s owner',
      'invitations to invited team members', 'confirmations to demo requesters',
      'contact-form messages, demo requests and feature requests to our own inbox',
      'never candidate data',
    ]) assert.ok(resendRow.includes(phrase), `Resend row lacks: ${phrase}`);
  });

  test('the transfers bullet points at the same recipients', () => {
    const bullet = /<li><strong>Email:<\/strong>([\s\S]*?)<\/li>/.exec(visible)[1];
    for (const phrase of ['recruiter accounts', 'invited team members', 'demo requesters', 'contact-form messages, demo requests and feature requests']) {
      assert.ok(bullet.includes(phrase), phrase);
    }
  });

  test('demo requests have their own section: purpose, data, legal basis, storage, retention, rights', () => {
    const section = (/<!-- =+ SECTION D — DEMO REQUESTS =+ -->([\s\S]*?)<\/div>\s*<\/div>/.exec(privacy) || [])[1] || '';
    assert.ok(section, 'privacy.html has no demo-request section');
    for (const phrase of [
      'only to schedule and run the demo you asked for',
      'Your work email address and, if you give them, your name, your agency and your note',
      'one-way hash of your IP address (never the IP address itself)',
      'Art. 6(1)(f) GDPR', 'Art. 6(1)(b) GDPR',
      'stored in our database', 'confirmation email via Resend',
      'Demo requests are deleted 12 months after we receive them, unless the requester becomes a customer, in which case the data becomes part of the customer relationship.',
      'The same 12-month period applies to the notification email in our inbox.',
      'href="#privacyContactLine"',
    ]) assert.ok(section.includes(phrase), `missing: ${phrase}`);
  });
});

describe('no email is built from candidate data', () => {
  // The modules that compose emails must not load the code that holds
  // candidate data (scoring, extraction, audit records)…
  const CANDIDATE_MODULES = /require\(['"][./]*(?:services\/|\.\/)?(?:scorer|parser|pdfExtractor|scoredRecord|provenance|biasAudit|narrativeGenerator|reportRenderer|audit|analyze)['"]\)/;
  // …and their email text must not interpolate audit-record fields.
  const CANDIDATE_FIELDS = /\$\{[^}]*\b(?:candidateName|candidate_name|cvText|cv_text|overall|scores?|audit|fileName|file_name|jobDescription)\b[^}]*\}/;

  for (const file of Object.keys(INVENTORY)) {
    test(file, () => {
      const src = read(file);
      assert.doesNotMatch(src, CANDIDATE_MODULES, `${file} loads a module that handles candidate data`);
      assert.doesNotMatch(src, CANDIDATE_FIELDS, `${file} interpolates a candidate/audit field into text`);
    });
  }

  test('the detector would notice (guards a vacuous pass)', () => {
    assert.match("const s = require('../services/scorer');", CANDIDATE_MODULES);
    assert.match('text: `Candidate: ${record.candidateName}`', CANDIDATE_FIELDS);
  });
});
