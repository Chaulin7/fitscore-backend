'use strict';

/**
 * src/routes/logoUpload.test.js
 *
 * White-label logo upload: the input that finally makes resolveBranding's
 * { image: … } branch reachable.
 *
 * Covers (TESTS): content-based validation — PNG and JPEG accepted, SVG and a
 * mislabelled file rejected by magic bytes rather than by extension, dimensions
 * bounded, and a truncated header failing CLOSED; the byte cap firing at the
 * edge rather than after the body is absorbed; server-side entitlement, proven
 * by calling the endpoint directly rather than through the UI gate; that a
 * lapsed org's logo persists but stops being served and comes back on
 * re-entitlement; that the stored image never rides a JSON response; and that
 * a real wide and a real tall upload stay inside the header's bound on both
 * document types.
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fitscore-logo-test-'));
process.env.DATABASE_PATH = path.join(TMP_DIR, 'logo-test.db');

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { getDb, closeDb } = require('../services/db');
const auth = require('../services/authService');
const {
  resolveBranding, publicBranding, uploadedLogoDataUri, HEADER_MARK_FIT,
} = require('../services/branding');
const fileSec = require('../services/fileSecurity');
const { buildReportDoc } = require('./reportRenderer');
const orgRouter = require('./org');

const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures', 'logos');
const WIDE = fs.readFileSync(path.join(FIXTURES, 'logo_wide.png'));   // 480x120
const TALL = fs.readFileSync(path.join(FIXTURES, 'logo_tall.png'));   // 120x480
const SQUARE_JPG = fs.readFileSync(path.join(FIXTURES, 'logo_square.jpg')); // 200x200
const SVG = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'brandmark.svg'));

let server; let baseUrl;
let ORG_PRO; let ORG_FREE; let TOKEN_PRO; let TOKEN_FREE;

// Real orgs, real owners, real sessions. requireSession and requireOwner both
// read the DB, so stubbing them would leave the entitlement gate — the thing
// these tests exist to prove — untested.
function makeOrgWithOwner(plan, status) {
  const org = auth.createOrganization(`logo-${plan}-${Math.random().toString(36).slice(2, 8)}`);
  const user = auth.createUser({ email: `owner-${org.id}@example.com`, passwordHash: 'x', orgId: org.id, role: 'owner' });
  const token = auth.createSession(user.id);
  getDb().prepare('UPDATE organizations SET plan = ?, subscription_status = ? WHERE id = ?')
    .run(plan, status, org.id);
  return { orgId: org.id, token: typeof token === 'string' ? token : (token.rawToken || token.token) };
}
const setPlan = (id, plan, status) => getDb()
  .prepare('UPDATE organizations SET plan = ?, subscription_status = ? WHERE id = ?').run(plan, status, id);

async function uploadLogo(buffer, filename, token = TOKEN_PRO, type = 'image/png') {
  const fd = new FormData();
  fd.append('logo', new Blob([buffer], { type }), filename);
  const res = await fetch(`${baseUrl}/api/org/branding/logo`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/org', orgRouter);
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  ({ orgId: ORG_PRO, token: TOKEN_PRO } = makeOrgWithOwner('pro', 'active'));
  ({ orgId: ORG_FREE, token: TOKEN_FREE } = makeOrgWithOwner('free', null));
});
after(() => { if (server) server.close(); closeDb(); });

describe('validation is by content, not by name', () => {
  test('a PNG is accepted, with its real dimensions', () => {
    const r = fileSec.validateLogoUpload(WIDE);
    assert.equal(r.type, 'png');
    assert.equal(r.width, 480); assert.equal(r.height, 120);
    assert.ok(r.dataUri.startsWith('data:image/png;base64,'));
  });

  test('a JPEG is accepted, with its real dimensions', () => {
    const r = fileSec.validateLogoUpload(SQUARE_JPG);
    assert.equal(r.type, 'jpeg');
    assert.equal(r.width, 200); assert.equal(r.height, 200);
    assert.ok(r.dataUri.startsWith('data:image/jpeg;base64,'));
  });

  test('SVG is rejected outright', () => {
    assert.throws(() => fileSec.validateLogoUpload(SVG), /PNG or JPEG/);
  });

  test('a JPEG named .png is judged by its bytes, not its extension', async () => {
    // Uploaded under a PNG filename and a PNG content-type; both are forgeable.
    const { status, body } = await uploadLogo(SQUARE_JPG, 'logo.png', TOKEN_PRO, 'image/png');
    assert.equal(status, 200, 'it is a valid JPEG, so it is accepted on its merits');
    assert.equal(body.logo.type, 'jpeg', 'sniffed as JPEG despite the .png name');
  });

  test('an SVG named .png is rejected despite the extension and content-type', async () => {
    const { status, body } = await uploadLogo(SVG, 'logo.png', TOKEN_PRO, 'image/png');
    assert.equal(status, 400);
    assert.match(body.error, /PNG or JPEG/);
  });

  test('a truncated image fails CLOSED, not open', () => {
    // Sniffs as PNG, but the IHDR is gone: dimensions cannot be verified, so
    // the bound cannot be enforced, so it must not reach the renderer.
    assert.throws(() => fileSec.validateLogoUpload(WIDE.subarray(0, 12)), /incomplete or corrupt/);
  });

  test('random bytes are rejected', () => {
    assert.throws(() => fileSec.validateLogoUpload(Buffer.alloc(64, 7)), /PNG or JPEG/);
    assert.throws(() => fileSec.validateLogoUpload(Buffer.alloc(0)), /No image/);
  });

  test('an over-dimension image is rejected even when the file is small', () => {
    // A PNG header claiming 5000x5000. Tiny on disk, enormous once decoded —
    // which is exactly why a byte cap alone is not enough.
    const buf = Buffer.from(WIDE);
    buf.writeUInt32BE(5000, 16); buf.writeUInt32BE(5000, 20);
    assert.throws(() => fileSec.validateLogoUpload(buf), /5000×5000/);
    assert.ok(buf.length < fileSec.MAX_LOGO_BYTES, 'the byte cap would have let this through');
  });

  test('the dimension bound is 2000px on either side', () => {
    assert.equal(fileSec.MAX_LOGO_DIMENSION, 2000);
    const ok = Buffer.from(WIDE); ok.writeUInt32BE(2000, 16); ok.writeUInt32BE(2000, 20);
    assert.doesNotThrow(() => fileSec.validateLogoUpload(ok));
    const over = Buffer.from(WIDE); over.writeUInt32BE(2001, 16);
    assert.throws(() => fileSec.validateLogoUpload(over));
  });
});

describe('the byte cap fires at the edge', () => {
  test('the raw cap is 384KB, which stays under 512KB once base64-encoded', () => {
    assert.equal(fileSec.MAX_LOGO_BYTES, 384 * 1024);
    assert.ok(Math.ceil(fileSec.MAX_LOGO_BYTES / 3) * 4 <= 512 * 1024);
  });

  test('an over-cap upload is refused by multer, not absorbed then checked', async () => {
    const big = Buffer.concat([WIDE, Buffer.alloc(400 * 1024, 0)]);
    assert.ok(big.length > fileSec.MAX_LOGO_BYTES);
    const { status, body } = await uploadLogo(big, 'big.png');
    assert.equal(status, 400);
    assert.match(body.error, /larger than the 384 KB limit/);
    assert.equal(body.code, 'INVALID_FILE');
  });
});

describe('entitlement is enforced server-side', () => {
  test('a free org cannot upload, even calling the endpoint directly', async () => {
    const { status, body } = await uploadLogo(WIDE, 'logo.png', TOKEN_FREE);
    assert.equal(status, 403);
    assert.equal(body.code, 'UPGRADE_REQUIRED');
    assert.equal(uploadedLogoDataUri(auth.getOrganizationBranding(ORG_FREE)), null, 'nothing stored');
  });

  test('a free org cannot remove either', async () => {
    const res = await fetch(`${baseUrl}/api/org/branding/logo`, {
      method: 'DELETE', headers: { Authorization: 'Bearer ' + TOKEN_FREE },
    });
    assert.equal(res.status, 403);
  });

  test('an entitled org uploads and the resolver serves it as an image', async () => {
    const { status, body } = await uploadLogo(SQUARE_JPG, 'logo.jpg', TOKEN_PRO, 'image/jpeg');
    assert.equal(status, 200);
    assert.equal(body.hasLogo, true);
    const b = resolveBranding(auth.getOrganizationBranding(ORG_PRO), { plan: 'pro', subscriptionStatus: 'active' });
    assert.equal(b.isCustom, true);
    assert.equal(b.headerLogoType, 'image');
    assert.ok(b.headerLogo.startsWith('data:image/jpeg;base64,'));
  });

  test('a lapsed org keeps the logo stored but stops being served it; re-entitlement restores it', async () => {
    await uploadLogo(WIDE, 'logo.png', TOKEN_PRO);
    const stored = uploadedLogoDataUri(auth.getOrganizationBranding(ORG_PRO));
    assert.ok(stored, 'uploaded');

    setPlan(ORG_PRO, 'pro', 'canceled');
    const lapsed = resolveBranding(auth.getOrganizationBranding(ORG_PRO), { plan: 'pro', subscriptionStatus: 'canceled' });
    assert.equal(lapsed.isCustom, false, 'not served while lapsed');
    assert.equal(lapsed.headerLogoType, 'svg');
    assert.equal(uploadedLogoDataUri(auth.getOrganizationBranding(ORG_PRO)), stored,
      'but the stored bytes are untouched');

    setPlan(ORG_PRO, 'pro', 'active');
    const back = resolveBranding(auth.getOrganizationBranding(ORG_PRO), { plan: 'pro', subscriptionStatus: 'active' });
    assert.equal(back.isCustom, true, 're-subscribing restores it with no re-upload');
    assert.equal(back.headerLogo, stored);
  });

  test('removal reverts to the CVsprings mark', async () => {
    await uploadLogo(WIDE, 'logo.png', TOKEN_PRO);
    const res = await fetch(`${baseUrl}/api/org/branding/logo`, {
      method: 'DELETE', headers: { Authorization: 'Bearer ' + TOKEN_PRO },
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).hasLogo, false);
    const b = resolveBranding(auth.getOrganizationBranding(ORG_PRO), { plan: 'pro', subscriptionStatus: 'active' });
    assert.equal(b.isCustom, false);
    assert.equal(b.headerLogoType, 'svg');
    assert.ok(b.headerLogo.includes('<svg'));
  });
});

describe('the stored image never rides a JSON response', () => {
  test('publicBranding reports presence, not content', async () => {
    await uploadLogo(WIDE, 'logo.png', TOKEN_PRO);
    const pub = publicBranding(auth.getOrganizationBranding(ORG_PRO));
    assert.equal(pub.hasLogo, true);
    assert.equal(pub.brandLogoData, undefined);
    assert.ok(JSON.stringify(pub).length < 500, 'must not carry a ~512KB blob');
  });

  test('the upload response itself carries no image data', async () => {
    const { body } = await uploadLogo(WIDE, 'logo.png', TOKEN_PRO);
    assert.ok(!JSON.stringify(body).includes('base64'));
    assert.deepEqual(Object.keys(body.logo).sort(), ['height', 'type', 'width']);
  });

  test('the preview endpoint returns the bytes, uncacheable', async () => {
    await uploadLogo(SQUARE_JPG, 'logo.jpg', TOKEN_PRO, 'image/jpeg');
    const res = await fetch(`${baseUrl}/api/org/branding/logo`, { headers: { Authorization: 'Bearer ' + TOKEN_PRO } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/jpeg');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.equal(fileSec.sniffType(bytes), 'jpeg', 'round-trips to a real JPEG');
  });

  test('an org with no logo gets a 404 from the preview endpoint', async () => {
    const res = await fetch(`${baseUrl}/api/org/branding/logo`, { headers: { Authorization: 'Bearer ' + TOKEN_FREE } });
    assert.equal(res.status, 404);
  });
});

describe('real uploads stay inside the header bound', () => {
  const fitOf = (node) => {
    let found = null;
    (function walk(n) {
      if (!n || typeof n !== 'object' || found) return;
      if (Array.isArray(n)) return n.forEach(walk);
      if ((n.svg || n.image) && Array.isArray(n.fit)) { found = n.fit; return; }
      ['columns', 'stack'].forEach((k) => walk(n[k]));
    }(node));
    return found;
  };
  const AUDIT = { id: 'a1', overall: 70, scores: { keywords: 70 }, analysisDetail: {} };

  for (const [label, buf] of [['very wide (480x120)', WIDE], ['very tall (120x480)', TALL]]) {
    test(`${label} is fit-bounded on the candidate PDF`, () => {
      const dataUri = fileSec.validateLogoUpload(buf).dataUri;
      const brand = {
        ...resolveBranding(null, null), headerLogo: dataUri, headerLogoType: 'image', isCustom: true,
      };
      const doc = buildReportDoc(AUDIT, brand);
      const fit = fitOf(doc.content);
      assert.deepEqual(fit, [...HEADER_MARK_FIT],
        'fit must be applied to a raster mark, not only to the SVG one');
      // fit scales to the box preserving aspect ratio, so neither extreme can
      // exceed either side of it.
      const { width, height } = fileSec.validateLogoUpload(buf);
      const scale = Math.min(fit[0] / width, fit[1] / height);
      assert.ok(width * scale <= fit[0] + 0.01 && height * scale <= fit[1] + 0.01,
        `${label} would render ${(width * scale).toFixed(1)}x${(height * scale).toFixed(1)}, outside ${fit}`);
    });
  }

  test('the rendered PDF actually embeds a raster upload without throwing', async () => {
    const { renderReportBuffer } = require('./reportRenderer');
    const dataUri = fileSec.validateLogoUpload(WIDE).dataUri;
    const brand = {
      ...resolveBranding(null, null), headerLogo: dataUri, headerLogoType: 'image', isCustom: true,
    };
    const pdf = await renderReportBuffer(AUDIT, brand);
    assert.ok(pdf.length > 8000, 'a real PDF came out the other side');
    assert.equal(pdf.subarray(0, 4).toString('latin1'), '%PDF');
  });
});
