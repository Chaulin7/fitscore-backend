'use strict';

/**
 * src/routes/orgExport.test.js
 *
 * GET /api/org/export — the Art. 20 portability / offboarding export.
 *
 * Covers: feature_requests appears in the export with the agreed field shape
 * (including user_email, the field that makes the table personal data), rows are
 * org-scoped, the pre-existing sections are unaffected, and an org with no
 * feature requests still gets the key as an empty array rather than an omission.
 *
 * Uses the real router with real session auth — /export sits behind
 * sessionOrDownloadToken + requireOwner, and requireOwner reads the user row
 * from the DB, so stubbing the middleware would test nothing.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Must be set before ./db is first required.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cvs-org-export-'));
process.env.DATABASE_PATH = path.join(TMP_DIR, 'export-test.db');

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const express = require('express');
const { getDb, closeDb } = require('../services/db');
const auth = require('../services/authService');
const orgRouter = require('../routes/org');

let app;
let server;
let port;

function makeOrgWithOwner(name) {
  const org = auth.createOrganization(name);
  const user = auth.createUser({ email: `owner-${org.id}@example.com`, passwordHash: 'x', orgId: org.id, role: 'owner' });
  const token = auth.createSession(user.id);
  return { orgId: org.id, userId: user.id, token: typeof token === 'string' ? token : token.rawToken || token.token };
}

function seedFeatureRequest(orgId, { category = 'product', title = 'Bulk export', body = 'Please add it.', ageDays = 1 } = {}) {
  const id = `fr-${Math.random().toString(36).slice(2, 10)}`;
  getDb().prepare(`
    INSERT INTO feature_requests (id, org_id, user_email, category, title, body, plan_tier, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pro', 'new', ?)
  `).run(id, orgId, `submitter-${id}@example.com`, category, title, body,
    new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000).toISOString());
  return id;
}

async function fetchExport(token) {
  const res = await fetch(`http://127.0.0.1:${port}/api/org/export`, {
    headers: { Authorization: 'Bearer ' + token },
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { status: res.status, body: json, raw: text };
}

before(async () => {
  getDb();
  app = express();
  app.use(express.json());
  app.use('/api/org', orgRouter);
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); });
  });
});

after(() => {
  try { server.close(); } catch (_) {}
  try { closeDb(); } catch (_) {}
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}
});

describe('org export includes feature requests', () => {
  test('the agreed fields are present, in the same shape as the other sections', async () => {
    const { orgId, token } = makeOrgWithOwner('Acme Recruitment');
    const id = seedFeatureRequest(orgId, { category: 'website', title: 'Dark mode', body: 'Painful at night.' });

    const { status, body } = await fetchExport(token);
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.featureRequests), 'featureRequests must be an array');
    assert.equal(body.featureRequests.length, 1);

    const fr = body.featureRequests[0];
    assert.deepEqual(Object.keys(fr).sort(),
      ['body', 'category', 'createdAt', 'id', 'planTier', 'status', 'title', 'userEmail'].sort());
    assert.equal(fr.id, id);
    assert.equal(fr.category, 'website');
    assert.equal(fr.title, 'Dark mode');
    assert.equal(fr.body, 'Painful at night.');
    assert.equal(fr.planTier, 'pro');
    assert.equal(fr.status, 'new');
    assert.match(fr.createdAt, /^\d{4}-\d{2}-\d{2}T/);
    // The whole reason this table is in the export.
    assert.ok(fr.userEmail && fr.userEmail.includes('@'), 'user_email must be exported');
  });

  test('rows are org-scoped', async () => {
    const a = makeOrgWithOwner('Org A');
    const b = makeOrgWithOwner('Org B');
    seedFeatureRequest(a.orgId, { title: 'A idea' });
    seedFeatureRequest(b.orgId, { title: 'B idea' });
    seedFeatureRequest(b.orgId, { title: 'B second' });

    const exportA = (await fetchExport(a.token)).body;
    const exportB = (await fetchExport(b.token)).body;

    assert.deepEqual(exportA.featureRequests.map((f) => f.title), ['A idea']);
    assert.equal(exportB.featureRequests.length, 2);
    assert.ok(!exportB.featureRequests.some((f) => f.title === 'A idea'));
  });

  test('newest first, matching the other exported sections', async () => {
    const { orgId, token } = makeOrgWithOwner('Ordered Org');
    seedFeatureRequest(orgId, { title: 'oldest', ageDays: 30 });
    seedFeatureRequest(orgId, { title: 'newest', ageDays: 1 });
    seedFeatureRequest(orgId, { title: 'middle', ageDays: 10 });

    const { body } = await fetchExport(token);
    assert.deepEqual(body.featureRequests.map((f) => f.title), ['newest', 'middle', 'oldest']);
  });

  test('an org with no feature requests still gets the key, as an empty array', async () => {
    const { token } = makeOrgWithOwner('Quiet Org');
    const { body } = await fetchExport(token);
    assert.ok('featureRequests' in body, 'the key must exist so consumers need no special case');
    assert.deepEqual(body.featureRequests, []);
  });

  test('the pre-existing export sections are unaffected', async () => {
    const { token } = makeOrgWithOwner('Shape Org');
    const { body } = await fetchExport(token);
    assert.ok(body.exportedAt);
    assert.ok(body.organization && body.organization.id);
    assert.ok(Array.isArray(body.auditRecords));
    assert.ok(Array.isArray(body.templates));
  });
});
