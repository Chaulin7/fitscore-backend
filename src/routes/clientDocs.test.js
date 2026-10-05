'use strict';

/**
 * src/routes/clientDocs.test.js — the docs/ files clients receive agree with
 * the site.
 *
 *   - Which docs are shipped is pinned against the compliance pack cover's own
 *     list, so the two cannot drift.
 *   - The legal name is spelled as LEGAL_NAME everywhere in docs/.
 *   - The DPA template stays a draft, its §1 describes the tool as the site
 *     does, and its Annex I lists only the subprocessors that process client
 *     personal data (Render, Resend), each row word for word the Privacy
 *     Policy's row and International transfers entry for it.
 */

const fs = require('node:fs');
const path = require('node:path');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { SHIPPED, OPEN_ITEMS_VISIBLE } = require('../../test/helpers/clientDocs');
const { LEGAL_NAME } = require('../config/legal');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function docsFiles(dir = 'docs') {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = `${dir}/${e.name}`;
    return e.isDirectory() ? docsFiles(rel) : (/\.(md|html)$/.test(e.name) ? [rel] : []);
  });
}

describe('which docs are shipped', () => {
  test('the compliance pack is exactly what its cover lists, plus the cover and the DPA', () => {
    const cover = read('docs/compliance/compliance-pack-cover.md');
    const listed = [...(/## Documents in this pack([\s\S]*?)\n## /.exec(cover)[1]).matchAll(/`([\w-]+\.md)`/g)]
      .map((m) => `docs/compliance/${m[1]}`);
    assert.deepEqual(
      [...listed, 'docs/compliance/compliance-pack-cover.md', 'docs/privacy/dpa-template.md'].sort(),
      [...SHIPPED].sort(),
    );
  });

  test('every declared draft is a shipped doc', () => {
    for (const f of Object.keys(OPEN_ITEMS_VISIBLE)) assert.ok(SHIPPED.includes(f), f);
  });
});

describe('legal name', () => {
  for (const file of docsFiles()) {
    test(file, () => {
      const spellings = [...read(file).matchAll(/\bJoyaco\b(?:\s*B\.?\s*V\.?)?/gi)].map((m) => m[0]);
      for (const s of spellings) assert.equal(s, LEGAL_NAME, `${file} spells the entity "${s}"`);
    });
  }
});

describe('the DPA template', () => {
  const dpa = read('docs/privacy/dpa-template.md');

  test('is still a draft for legal review', () => {
    assert.match(dpa, /\*\*DRAFT — for legal review before signature\.\*\*/);
    assert.match(dpa, /Square-bracketed items and TODO markers must be\s*>?\s*completed before use\./);
  });

  test('the placeholders left are exactly the two still open', () => {
    const placeholders = [...dpa.replace(/<!--[\s\S]*?-->/g, '').matchAll(/\[[^\]]*\](?!\()/g)]
      .map((m) => m[0].replace(/\s+/g, ' '));
    assert.deepEqual(placeholders, [
      '[Client legal name]',
      '[TODO: legal review — liability allocation, term/termination alignment with the main service agreement, governing law and jurisdiction.]',
    ]);
  });

  test('the filled-in facts: address, §5, encryption at rest, organisational measures', () => {
    const flat = dpa.replace(/\s+/g, ' ');
    assert.ok(flat.includes('**Joyaco B.V. (KvK 42135911, BTW NL005523705B04), Leidsegracht 34, 1016 CM Amsterdam, Netherlands**'));
    assert.match(dpa, /## 5\. International transfers\n\nPersonal data is processed in the hosting region listed in Annex I\.\n\n## 6\./);
    assert.ok(flat.includes('Data at rest, including backups, is stored on encrypted disks provided by Render; data in transit is protected with TLS.'));
    assert.ok(dpa.includes('<!-- Source: https://render.com/docs/disks — "All disks are encrypted at rest, and so are their automatic daily snapshots." -->'));
    assert.ok(flat.includes('Access to production systems is limited to the founder; two-factor authentication is enforced on all service accounts (hosting, email, billing, DNS, code repository); credentials are stored in a password manager; work devices use full-disk encryption. Personal data breaches are notified to the client without undue delay after we become aware of them. No other personnel currently have access to personal data; any future personnel or contractors will be bound by confidentiality obligations before being given access.'));
  });

  test('backups: Render snapshots kept at least seven days, manual backups deleted within 30 days', () => {
    const SENTENCES = 'Production data is backed up through automatic daily snapshots of the encrypted disk, managed by Render and retained for at least seven days. Manual backups taken before maintenance are stored on the same encrypted disk and deleted within 30 days.';
    const flat = (s) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ');
    assert.ok(flat(dpa).includes(SENTENCES), 'DPA §4.8');
    assert.ok(flat(read('public/privacy.html')).includes(`<strong>Backups:</strong> ${SENTENCES}`), 'Privacy Policy');
    assert.ok(flat(read('docs/privacy/retention-policy.md')).includes(SENTENCES), 'retention policy');
    assert.doesNotMatch(read('docs/privacy/retention-policy.md'), /TODO \(operator\)/);
    for (const f of ['README.md', 'docs/billing/README.md']) {
      const s = flat(read(f));
      assert.match(s, /Delete (every manual backup|that backup) within 30 days/, f);
      assert.ok(s.includes('node scripts/list-backups.js'), f);
      assert.match(s, /rm -- "\$DATABASE_PATH\.backup-/, f);
    }
  });

  test('§1 describes the service the way the site does', () => {
    const s1 = /## 1\. Subject matter and duration([\s\S]*?)\n## /.exec(dpa)[1].replace(/\s+/g, ' ');
    assert.match(s1, /advisory candidate-fit scoring of CVs against job descriptions by an automated, rules-based screening tool/);
  });

  test('Annex I: Render and Resend only, each word for word the Privacy Policy\'s row and transfers entry', () => {
    const html = read('public/privacy.html').replace(/<!--[\s\S]*?-->/g, '');
    const ent = { rsquo: '’', Uuml: 'Ü', amp: '&', mdash: '—', ndash: '–', nbsp: ' ' };
    const text = (s) => s.replace(/<[^>]+>/g, '').replace(/&([a-z]+);/gi, (m, n) => ent[n] ?? m).replace(/\s+/g, ' ').trim();
    const tbody = /<h4>Subprocessors and third parties<\/h4>[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/.exec(html)[1];
    const policyRows = [...tbody.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) => [...m[1].matchAll(/<td>([\s\S]*?)<\/td>/g)].map((c) => c[1]));
    const transfers = Object.fromEntries([...(/<h4>International transfers<\/h4>\s*<ul>([\s\S]*?)<\/ul>/.exec(html)[1])
      .matchAll(/<li><strong>([^<]+):<\/strong>([\s\S]*?)<\/li>/g)].map((m) => [m[1], text(m[2])]));
    // The subprocessors that process the Client's personal data. Plausible stays
    // in the Privacy Policy only: it handles no client personal data.
    const DPA_SUBPROCESSORS = ['Render', 'Resend'];
    const TRANSFER_FOR = { Render: 'Hosting', Resend: 'Email' };

    const annex = /## Annex I — Authorised subprocessors([\s\S]*?)\n## Annex II/.exec(dpa)[1];
    const dpaRows = annex.split('\n').filter((l) => /^\| (?!Subprocessor |---)/.test(l))
      .map((l) => l.slice(2, -2).split(' | '));

    const policyNames = policyRows.map((r) => text(r[0]));
    const dpaNames = dpaRows.map((r) => r[0]);
    for (const n of dpaNames) assert.ok(policyNames.includes(n), `the DPA lists ${n}, which the Privacy Policy does not`);
    assert.deepEqual(dpaNames, DPA_SUBPROCESSORS, 'Annex I lists exactly the subprocessors of client personal data');
    // Stripe processes our customers' billing data as OUR processor — not
    // candidate or client personal data on the client's behalf — so it is in
    // the policy and deliberately not in Annex I.
    assert.ok(policyNames.includes('Stripe'), 'the policy lists Stripe');
    assert.ok(!dpaNames.includes('Stripe'), 'Annex I must not list Stripe');
    dpaRows.forEach(([dName, dPurpose, dLoc, dTerms, dTransfer]) => {
      const [name, purpose, loc, terms] = policyRows[policyNames.indexOf(dName)];
      assert.equal(dPurpose, text(purpose), `${dName}: purpose`);
      assert.equal(dLoc, text(loc), `${dName}: location / region`);
      assert.equal(dTerms, `[${text(terms)}](${/href="([^"]+)"/.exec(terms)[1]})`, `${dName}: terms`);
      assert.equal(dTransfer, transfers[TRANSFER_FOR[text(name)]], `${dName}: international transfers`);
    });
    // The two facts that were open before: where, and under what.
    assert.match(annex, /Service region: Frankfurt, Germany \(EU\)/);
    assert.match(annex, /Emails are sent from Resend’s EU region \(Ireland\)/);
    assert.equal((annex.match(/Standard Contractual Clauses/g) || []).length, 3, 'Render (twice) and Resend');
    assert.equal((annex.match(/covered by Render’s certification under the EU-US Data Privacy Framework, with the European Commission’s Standard Contractual Clauses in Render’s Data Processing Agreement as a fallback\./g) || []).length, 2, 'Render: DPF first, SCCs as fallback, in both cells');
    assert.match(annex, /covered by the European Commission’s Standard Contractual Clauses included in Resend’s Data Processing Agreement\./, 'Resend unchanged');
  });
});
