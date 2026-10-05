'use strict';

/**
 * src/routes/privacyStripe.test.js — the Privacy Policy describes Stripe as
 * Stripe's own documents do, and claims to store only the billing fields the
 * code actually stores.
 *
 *   - Subprocessor row, transfers bullet and section G name the contracting
 *     entity (Stripe Payments Europe, Limited) and the safeguard Stripe's Data
 *     Transfers Addendum states (DPF first, SCCs as fallback, importer Stripe,
 *     LLC). The sources are quoted in a hidden comment.
 *   - Section G's "We store only …" list covers every billing column on the
 *     organization record, and the schema stores no billing name, address,
 *     VAT ID or payment detail of our own.
 */

const fs = require('node:fs');
const path = require('node:path');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..', '..');
const privacy = fs.readFileSync(path.join(ROOT, 'public/privacy.html'), 'utf8');
const visible = privacy.replace(/<!--[\s\S]*?-->/g, '');
const DB_SRC = fs.readFileSync(path.join(ROOT, 'src/services/db.js'), 'utf8');
const sectionG = (/<!-- =+ SECTION G — BILLING =+ -->([\s\S]*?)<\/div>\s*<\/div>/.exec(privacy) || [])[1] || '';
const TRANSFER = 'Stripe may transfer data to Stripe, LLC in the US; any such transfer is covered by Stripe, LLC&rsquo;s certification under the EU-US Data Privacy Framework, with the European Commission&rsquo;s Standard Contractual Clauses in Stripe&rsquo;s Data Transfers Addendum as a fallback.';

describe('Stripe in the Privacy Policy', () => {
  test('subprocessor row: purpose, contracting entity, safeguard, DPA link', () => {
    const row = /<td>Stripe<\/td>[\s\S]*?<\/tr>/.exec(visible)[0];
    assert.match(row, /Payment processing, billing and invoicing for paid plans and trials/);
    assert.match(row, /we do not receive or store payment details/);
    assert.ok(row.includes(`<td>Stripe Payments Europe, Limited (Ireland). ${TRANSFER}</td>`), row);
    assert.match(row, /href="https:\/\/stripe\.com\/legal\/dpa"/);
  });

  test('International transfers names the same entity and safeguard', () => {
    const bullet = /<li><strong>Payments:<\/strong>([\s\S]*?)<\/li>/.exec(visible)[1];
    assert.equal(bullet.trim(), `billing data is processed by Stripe Payments Europe, Limited (Ireland). ${TRANSFER}`);
  });

  test('the sources are cited in a hidden comment, with what they say', () => {
    for (const s of ['https://stripe.com/legal/ssa', 'https://stripe.com/legal/dpa', 'https://stripe.com/legal/dta',
      '"Stripe Payments Europe, Limited"', 'transfers Personal Data to Stripe, LLC in the United States',
      '(a) the Data Privacy Framework; (b) the EEA SCCs', '"Stripe, LLC is self-certified under the Data Privacy Framework."']) {
      assert.ok(privacy.includes(s), s);
    }
    assert.doesNotMatch(visible, /stripe\.com\/legal\/dta/, 'the citation stays out of the visible text');
  });

  test('section G: purpose, legal basis, Stripe, 7-year retention, rights', () => {
    const g = sectionG.replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ');
    for (const phrase of [
      'only for billing and invoicing your plan',
      'Stripe collects your billing name, email address, company, address, VAT ID and payment details',
      'Payment details are handled by Stripe and are not stored by us',
      'Performance of our contract with you (Art. 6(1)(b) GDPR), and our legal obligation to keep tax records (Art. 6(1)(c) GDPR)',
      'Stripe Payments Europe, Limited (Ireland)',
      'Invoices and billing records are kept for 7 years, as required by Dutch tax law.',
      'href="#privacyContactLine"',
    ]) assert.ok(g.includes(phrase), phrase);
  });
});

describe('"We store only …" matches the code', () => {
  // Each billing column on the organization record, and the words section G
  // uses for it. A new billing column fails here until the policy names it.
  const COLUMN_PHRASES = {
    stripe_customer_id: 'the references Stripe gives your customer account',
    stripe_subscription_id: 'and your subscription',
    plan: 'your plan',
    comped: 'whether it is complimentary',
    subscription_status: 'the status of your subscription',
    plan_updated_at: 'when your plan last changed',
    current_period_end: 'when your current billing period ends',
    cancel_at_period_end: 'whether your subscription is set to end then',
    free_tier_since: 'when you moved to the free plan',
    stripe_event_created: 'the time of the last billing event we applied',
    provisional_until: 'the end of a checkout that has not been completed',
    resume_error: 'the reason a paused subscription could not be resumed',
  };
  const BILLING_COLUMN = /stripe|plan|subscription|period|comped|provisional|resume_error\b|free_tier/;

  test('every billing column on organizations is named in section G', () => {
    const cols = [...DB_SRC.matchAll(/ALTER TABLE organizations ADD COLUMN (\w+)/g)].map((m) => m[1]).filter((c) => BILLING_COLUMN.test(c) && !/^trial_/.test(c));
    assert.deepEqual([...cols].sort(), Object.keys(COLUMN_PHRASES).sort(), 'billing columns changed: update section G and this map');
    for (const [col, phrase] of Object.entries(COLUMN_PHRASES)) assert.ok(sectionG.includes(phrase), `${col}: "${phrase}"`);
  });

  test('we store no billing name, address, VAT ID or payment detail ourselves', () => {
    const allColumns = [...DB_SRC.matchAll(/ADD COLUMN (\w+)|^\s+(\w+) (?:TEXT|INTEGER)/gm)].map((m) => m[1] || m[2]);
    const offenders = allColumns.filter((c) => /address|vat|tax_id|iban|card|billing_name|billing_email|postal|country/i.test(c));
    assert.deepEqual(offenders, []);
  });
});
