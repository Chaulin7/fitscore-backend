'use strict';

/**
 * src/routes/featureRequests.test.js
 *
 * Paid-only feature-request submission: the plan gate, validation, the rolling
 * 24h per-org quota, and the email composition that turns a submission into a
 * two-way channel.
 *
 * Covers (TESTS): free/cancelled orgs rejected with 403 and no row written;
 * Pro, Team and past_due (grace) accepted; validation bounds with trimming
 * applied first; the quota refusing the 6th submission while writing nothing,
 * ageing out on a rolling rather than calendar basis, and staying org-scoped;
 * the row surviving an email failure and a missing API key; and the email
 * builder resisting subject injection via control characters, bidi overrides
 * and an unbounded org name, plus dropping a Reply-To that could be reparsed as
 * an address list.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Must be set before services/db is first required — it reads DATABASE_PATH at
// module load. Same approach as the other db-touching tests.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cvs-fr-'));
process.env.DATABASE_PATH = path.join(TMP_DIR, 'test.db');

const express = require('express');
const db = require('../services/db');
const featureRequestsRouter = require('../routes/featureRequests');
const { buildFeatureRequestEmail, safeReplyTo, bodySafe } = require('../routes/featureRequests');

const ORG_A = 'org-aaa';
const ORG_B = 'org-bbb';

// Stand-in session: mirrors exactly what requireSession sets, so the route sees
// the same shape in tests as in production.
let currentSession = { orgId: ORG_A, userId: 'user-1', user: { email: 'sam@acme.example' } };

let app;
let sent;          // captured outbound emails
let mailerBehaviour = 'ok'; // 'ok' | 'throw'

before(() => {
  db.getDb(); // create the schema

  app = express();
  app.use(express.json());
  app.use('/api/feature-requests', (req, res, next) => {
    req.orgId = currentSession.orgId;
    req.userId = currentSession.userId;
    req.user = currentSession.user;
    next();
  }, featureRequestsRouter);

  // Swap the mailer at the seam the route calls through — no network, no key.
  featureRequestsRouter.sendFeatureRequestEmail = async (payload) => {
    sent.push(payload);
    if (mailerBehaviour === 'throw') throw new Error('resend exploded');
  };
});

after(() => {
  try { db.registerGracefulShutdown && null; } catch (_) {}
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}
});

function setPlan(orgId, plan, subscriptionStatus) {
  db.getDb().prepare('INSERT OR IGNORE INTO organizations (id, name, created_at) VALUES (?, ?, ?)')
    .run(orgId, orgId === ORG_A ? 'Acme Recruitment' : 'Beta Talent', new Date().toISOString());
  db.getDb().prepare('UPDATE organizations SET plan = ?, subscription_status = ? WHERE id = ?')
    .run(plan, subscriptionStatus, orgId);
}

function reset() {
  db.getDb().prepare('DELETE FROM feature_requests').run();
  sent = [];
  mailerBehaviour = 'ok';
  currentSession = { orgId: ORG_A, userId: 'user-1', user: { email: 'sam@acme.example' } };
}

function rows(orgId = ORG_A) {
  return db.getDb().prepare('SELECT * FROM feature_requests WHERE org_id = ? ORDER BY created_at').all(orgId);
}

const VALID = { category: 'product', title: 'Bulk export', body: 'Please let me export every shortlist at once.' };

async function post(payload) {
  const res = await fetch(`http://127.0.0.1:${app.__port}/api/feature-requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  let json = null;
  try { json = await res.json(); } catch (_) {}
  return { status: res.status, body: json, headers: res.headers };
}

let server;
before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => { app.__port = server.address().port; resolve(); });
  });
});
after(() => { try { server.close(); } catch (_) {} });

describe('plan gate', () => {
  test('free org is rejected with 403 and writes no row', async () => {
    reset(); setPlan(ORG_A, 'free', null);
    const r = await post(VALID);
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'PAID_PLAN_REQUIRED');
    assert.equal(rows().length, 0, 'a rejected submission must not be stored');
    assert.equal(sent.length, 0);
  });

  test('pro org with a cancelled subscription is treated as free', async () => {
    reset(); setPlan(ORG_A, 'pro', 'canceled');
    assert.equal((await post(VALID)).status, 403);
    assert.equal(rows().length, 0);
  });

  test('pro + active is accepted and records the plan snapshot', async () => {
    reset(); setPlan(ORG_A, 'pro', 'active');
    const r = await post(VALID);
    assert.equal(r.status, 201);
    assert.equal(r.body.ok, true);
    const [row] = rows();
    assert.equal(row.plan_tier, 'pro');
    assert.equal(row.status, 'new');
    assert.equal(row.org_id, ORG_A);
    assert.equal(row.user_email, 'sam@acme.example');
  });

  test('team + active is accepted', async () => {
    reset(); setPlan(ORG_A, 'team', 'active');
    assert.equal((await post(VALID)).status, 201);
    assert.equal(rows()[0].plan_tier, 'team');
  });

  test('past_due keeps access (grace window, matching the analysis quota)', async () => {
    reset(); setPlan(ORG_A, 'pro', 'past_due');
    assert.equal((await post(VALID)).status, 201);
  });

  test('identity comes from the session, not the body', async () => {
    reset(); setPlan(ORG_A, 'pro', 'active');
    await post({ ...VALID, orgId: ORG_B, userEmail: 'attacker@evil.example', planTier: 'team' });
    assert.equal(rows(ORG_B).length, 0, 'must not write into another org');
    const [row] = rows(ORG_A);
    assert.equal(row.user_email, 'sam@acme.example');
    assert.equal(row.plan_tier, 'pro');
  });
});

describe('validation', () => {
  before(() => { setPlan(ORG_A, 'pro', 'active'); });

  test('category must be in the allowed set', async () => {
    reset(); setPlan(ORG_A, 'pro', 'active');
    const r = await post({ ...VALID, category: 'pricing' });
    assert.equal(r.status, 400);
    assert.equal(r.body.field, 'category');
    assert.equal(rows().length, 0);
  });

  test('title bounds are checked after trimming', async () => {
    reset(); setPlan(ORG_A, 'pro', 'active');
    assert.equal((await post({ ...VALID, title: 'ab' })).status, 400);
    assert.equal((await post({ ...VALID, title: '   ab   ' })).status, 400, 'trim must precede the length check');
    assert.equal((await post({ ...VALID, title: 'x'.repeat(121) })).status, 400);
    assert.equal(rows().length, 0);
  });

  test('body bounds are checked after trimming', async () => {
    reset(); setPlan(ORG_A, 'pro', 'active');
    assert.equal((await post({ ...VALID, body: 'too short' })).status, 400);
    assert.equal((await post({ ...VALID, body: 'x'.repeat(4001) })).status, 400);
    assert.equal(rows().length, 0);
  });

  test('control characters and bidi overrides in the title are rejected, not stripped', async () => {
    reset(); setPlan(ORG_A, 'pro', 'active');
    for (const bad of ['Bulk\nexport', 'Bulk\r\nBcc: victim@x.example', 'Bulk\u202Etropxe', 'Bulk\u200Bexport']) {
      const r = await post({ ...VALID, title: bad });
      assert.equal(r.status, 400, `expected rejection for ${JSON.stringify(bad)}`);
      assert.equal(r.body.field, 'title');
    }
    assert.equal(rows().length, 0);
  });

  test('trimmed values are what get stored', async () => {
    reset(); setPlan(ORG_A, 'pro', 'active');
    await post({ category: 'website', title: '  Dark mode  ', body: '  The dashboard is painful at night.  ' });
    const [row] = rows();
    assert.equal(row.title, 'Dark mode');
    assert.equal(row.body, 'The dashboard is painful at night.');
    assert.equal(row.category, 'website');
  });
});

describe('rolling 24h quota', () => {
  test('the 6th submission in the window is refused and writes nothing', async () => {
    reset(); setPlan(ORG_A, 'pro', 'active');
    for (let i = 0; i < 5; i++) {
      assert.equal((await post({ ...VALID, title: `Idea ${i}` })).status, 201);
    }
    const r = await post({ ...VALID, title: 'One too many' });
    assert.equal(r.status, 429);
    assert.equal(r.body.code, 'RATE_LIMITED');
    assert.ok(r.headers.get('retry-after'), 'Retry-After header must be set');
    assert.ok(r.body.retryAfter > 0);
    assert.equal(rows().length, 5, 'a refused submission must not be stored');
  });

  test('the window is rolling, not a calendar day', async () => {
    reset(); setPlan(ORG_A, 'pro', 'active');
    for (let i = 0; i < 5; i++) await post({ ...VALID, title: `Idea ${i}` });
    assert.equal((await post({ ...VALID, title: 'Blocked' })).status, 429);

    // Age the oldest row past the window; exactly one slot should free up.
    const oldest = rows()[0];
    const aged = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    db.getDb().prepare('UPDATE feature_requests SET created_at = ? WHERE id = ?').run(aged, oldest.id);

    assert.equal((await post({ ...VALID, title: 'Now allowed' })).status, 201);
    assert.equal((await post({ ...VALID, title: 'Blocked again' })).status, 429);
  });

  test('the quota is per-org: org B is unaffected by org A hitting its cap', async () => {
    reset(); setPlan(ORG_A, 'pro', 'active'); setPlan(ORG_B, 'pro', 'active');
    for (let i = 0; i < 5; i++) await post({ ...VALID, title: `Idea ${i}` });
    assert.equal((await post({ ...VALID, title: 'Blocked' })).status, 429);

    currentSession = { orgId: ORG_B, userId: 'user-2', user: { email: 'kim@beta.example' } };
    assert.equal((await post({ ...VALID, title: 'Org B first' })).status, 201);
    assert.equal(rows(ORG_B).length, 1);
    assert.equal(rows(ORG_A).length, 5);
  });

  test('countRecentFeatureRequests agrees with what was written', async () => {
    reset(); setPlan(ORG_A, 'pro', 'active');
    await post(VALID); await post({ ...VALID, title: 'Second idea' });
    assert.equal(db.countRecentFeatureRequests(ORG_A), 2);
    assert.equal(db.countRecentFeatureRequests(ORG_B), 0);
  });
});

describe('the row is the source of truth', () => {
  test('an email failure still returns 201 and keeps the row', async () => {
    reset(); setPlan(ORG_A, 'pro', 'active');
    mailerBehaviour = 'throw';
    const r = await post(VALID);
    assert.equal(r.status, 201, 'a mail outage must not lose the submission');
    assert.equal(rows().length, 1);
  });

  test('the notification carries the submitter identity for the reply channel', async () => {
    reset(); setPlan(ORG_A, 'pro', 'active');
    await post(VALID);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].userEmail, 'sam@acme.example');
    assert.equal(sent[0].planTier, 'pro');
    assert.equal(sent[0].orgName, 'Acme Recruitment');
    assert.equal(sent[0].category, 'product');
  });
});

describe('email composition', () => {
  const base = {
    category: 'product', title: 'Bulk export', body: 'Please.',
    planTier: 'pro', userEmail: 'sam@acme.example', orgName: 'Acme Recruitment',
    orgId: ORG_A, createdAt: '2026-07-31T10:00:00.000Z',
  };

  test('plain text only — no html field to escape', () => {
    const mail = buildFeatureRequestEmail(base);
    assert.ok(mail.text);
    assert.equal(mail.html, undefined);
  });

  test('the subject survives control characters, bidi overrides and a huge org name', () => {
    const mail = buildFeatureRequestEmail({
      ...base,
      title: 'Bulk\r\nBcc: victim@x.example\u202E',
      orgName: 'A'.repeat(5000) + '\n\u202EEvil',
    });
    assert.ok(!/[\r\n]/.test(mail.subject), 'subject must be a single line');
    assert.ok(!/[\x00-\x1F\x7F\u200B-\u200F\u2028\u2029\u202A-\u202E\uFEFF]/.test(mail.subject), 'no control or bidi chars');
    assert.ok(mail.subject.length < 300, `subject must stay bounded, got ${mail.subject.length}`);
    assert.ok(mail.subject.startsWith('[Feature Request] '));
  });

  test('the stored title is preserved in the body even when the subject is sanitised', () => {
    const mail = buildFeatureRequestEmail({ ...base, body: 'Line one\nLine two' });
    assert.ok(mail.text.includes('Line one\nLine two'), 'body newlines are legitimate and kept');
  });

  test('reply-to is dropped for addresses that could be reparsed as a list', () => {
    assert.equal(safeReplyTo('a,victim@partner.example'), null);
    assert.equal(safeReplyTo('Name<attacker@evil.example>'), null);
    assert.equal(safeReplyTo('a b@x.example'), null);
    assert.equal(safeReplyTo('x'.repeat(250) + '@x.example'), null);
    assert.equal(safeReplyTo('sam@acme.example'), 'sam@acme.example');
    assert.equal(safeReplyTo('sam.o-b+tag@sub.acme.co.uk'), 'sam.o-b+tag@sub.acme.co.uk');
  });

  test('every interpolated field is sanitised, not just title and body', () => {
    // orgName is unbounded and uncontrolled: createOrganization only trims it.
    const DIRTY = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F\u061C\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u206F\uFEFF\uFFF9-\uFFFB]|[\u{E0000}-\u{E007F}]/u;
    for (const evil of ['\u0085', '\u0080', '\u061C', '\u2060', '\u2066', '\u206A', '\uFFF9', '\u{E0041}', '\u202E']) {
      const mail = buildFeatureRequestEmail({
        ...base,
        title: 'ok title',
        body: 'Legit.\n' + evil + '\nForged: New feature request submitted',
        orgName: 'Org' + evil,
        userEmail: 'a@b.co',
      });
      assert.ok(!DIRTY.test(mail.subject), `subject leaked ${escape(evil)}`);
      assert.ok(!DIRTY.test(mail.text), `body leaked ${escape(evil)}`);
    }
  });

  test('bodySafe keeps legitimate newlines and tabs', () => {
    assert.equal(bodySafe('line one\nline two\tcol'), 'line one\nline two\tcol');
    assert.equal(bodySafe('a\u202Eb'), 'ab');
  });

  test('a hostile submitter address yields no reply-to rather than a malformed one', () => {
    const mail = buildFeatureRequestEmail({ ...base, userEmail: 'a,b@evil.example' });
    assert.equal(mail.replyTo, null);
    assert.ok(mail.text.includes('a,b@evil.example'), 'operator can still see the raw address in the body');
  });
});
