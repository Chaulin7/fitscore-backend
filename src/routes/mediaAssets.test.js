'use strict';

/**
 * src/routes/mediaAssets.test.js
 *
 * Two things about the demo video route fail silently, which is why they are
 * tested over real HTTP rather than by reading the handler:
 *
 *   1. `immutable` on an unversioned URL. A year-long immutable cache cannot
 *      be revoked — no re-deploy, no purge, nothing reaches a browser that
 *      already holds one. If the route ever stamps it on a URL whose `?v=`
 *      does not match the bytes on disk, the damage is done at the moment a
 *      visitor loads the page and is invisible until someone re-encodes the
 *      video and wonders why the old cut is still playing for some people.
 *
 *   2. Range requests. A 200 on the whole file looks perfectly healthy in a
 *      terminal and in a browser network tab. What it produces in a player is
 *      a video that plays from the start and cannot be seeked — the scrub bar
 *      moves and the picture does not. So these assert 206, Content-Range, and
 *      that the returned bytes are the bytes at that offset.
 *
 * The router is mounted exactly as src/index.js mounts it, ahead of a static
 * handler, because the ordering is load-bearing: express.static answering
 * first is precisely the bug the route exists to prevent.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const express = require('express');
const mediaAssetsRouter = require('./mediaAssets');
const { MANAGED, URL_PREFIX, MEDIA_PLACEHOLDERS, assetUrl, currentVersion } = require('../config/mediaAssets');

const MEDIA_DIR = path.join(__dirname, '..', '..', 'public', 'assets', 'video');
const VIDEO = 'cvsprings-demo-1080.mp4';

let server;
let base;
/**
 * Counts trips to the global error handler. src/index.js logs every one of
 * those at error level with a stack trace, so "did this reach the error
 * handler" is a real assertion about production log volume, not a detail.
 */
let errorHandlerHits = 0;

before(async () => {
  const app = express();
  app.use(URL_PREFIX, mediaAssetsRouter);
  // Mounted after, as in index.js — anything the router declines falls here.
  app.use(express.static(path.join(__dirname, '..', '..', 'public'), { index: false }));
  app.use((req, res) => res.status(404).json({ error: 'Not found' }));
  // Mirrors the shape of the final error handler in src/index.js.
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    errorHandlerHits += 1;
    res.status(err.status || err.statusCode || 500).end();
  });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => { try { server.close(); } catch (_) { /* already closed */ } });

/** The assets are committed, so their absence is a broken checkout, not a skip. */
describe('the managed assets are present', () => {
  for (const fileName of Object.values(MANAGED)) {
    test(`${fileName} exists and is non-empty`, () => {
      const abs = path.join(MEDIA_DIR, fileName);
      assert.ok(fs.existsSync(abs), `${fileName} is managed but missing from public/assets/video/`);
      assert.ok(fs.statSync(abs).size > 0, `${fileName} is zero bytes`);
    });
  }

  test('every placeholder resolves to a hashed URL', () => {
    for (const [placeholder, url] of Object.entries(MEDIA_PLACEHOLDERS)) {
      assert.match(url, /^\/assets\/video\/[\w.-]+\?v=[0-9a-f]{10}$/, `${placeholder} -> ${url}`);
    }
  });

  test('the hash is the real digest of the file, not a build number', () => {
    const abs = path.join(MEDIA_DIR, VIDEO);
    const expected = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex').slice(0, 10);
    assert.equal(currentVersion(VIDEO), expected);
  });
});

describe('immutable is sent only when the hash matches the bytes on disk', () => {
  test('a matching ?v= earns the year-long immutable cache', async () => {
    const res = await fetch(base + assetUrl(VIDEO));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  });

  test('an unversioned URL does NOT — it is unrevokable if wrong', async () => {
    const res = await fetch(`${base}${URL_PREFIX}/${VIDEO}`);
    assert.equal(res.status, 200);
    const cc = res.headers.get('cache-control');
    assert.doesNotMatch(cc, /immutable/, 'a bare URL must never be pinned for a year');
    assert.match(cc, /max-age=300/);
  });

  test('a stale ?v= does not either, but still serves the current file', async () => {
    const res = await fetch(`${base}${URL_PREFIX}/${VIDEO}?v=0000000000`);
    assert.equal(res.status, 200, 'a visitor on a cached page must not get a 404');
    assert.doesNotMatch(res.headers.get('cache-control'), /immutable/);
    assert.equal(Number(res.headers.get('content-length')), fs.statSync(path.join(MEDIA_DIR, VIDEO)).size);
  });

  test('the poster is versioned too — a stale still frame is the same bug', async () => {
    for (const poster of ['cvsprings-demo-poster.jpg', 'cvsprings-demo-poster.webp']) {
      const res = await fetch(base + assetUrl(poster));
      assert.equal(res.status, 200, poster);
      assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable', poster);
    }
  });
});

describe('range requests: the video is seekable, not merely downloadable', () => {
  test('Accept-Ranges is advertised', async () => {
    const res = await fetch(base + assetUrl(VIDEO));
    assert.equal(res.headers.get('accept-ranges'), 'bytes');
  });

  test('a mid-file range returns 206 with the correct Content-Range', async () => {
    const size = fs.statSync(path.join(MEDIA_DIR, VIDEO)).size;
    const res = await fetch(base + assetUrl(VIDEO), { headers: { Range: 'bytes=2000000-2000099' } });
    assert.equal(res.status, 206, 'a 200 here means the player cannot seek');
    assert.equal(res.headers.get('content-range'), `bytes 2000000-2000099/${size}`);
    assert.equal(Number(res.headers.get('content-length')), 100);
  });

  test('the bytes returned are the bytes at that offset', async () => {
    const res = await fetch(base + assetUrl(VIDEO), { headers: { Range: 'bytes=2000000-2000099' } });
    const served = Buffer.from(await res.arrayBuffer());
    const onDisk = Buffer.alloc(100);
    const fd = fs.openSync(path.join(MEDIA_DIR, VIDEO), 'r');
    try { fs.readSync(fd, onDisk, 0, 100, 2000000); } finally { fs.closeSync(fd); }
    assert.ok(served.equals(onDisk), 'served range does not match the file at that offset');
  });

  test('an open-ended range (seek to the end) works', async () => {
    const size = fs.statSync(path.join(MEDIA_DIR, VIDEO)).size;
    const res = await fetch(base + assetUrl(VIDEO), { headers: { Range: `bytes=${size - 100}-` } });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get('content-range'), `bytes ${size - 100}-${size - 1}/${size}`);
  });

  test('a range past EOF is refused with 416, not a truncated 206', async () => {
    const res = await fetch(base + assetUrl(VIDEO), { headers: { Range: 'bytes=99999999999-' } });
    assert.equal(res.status, 416);
    assert.equal(res.headers.get('content-range'), `bytes */${fs.statSync(path.join(MEDIA_DIR, VIDEO)).size}`);
  });

  test('...and does so without waking the error handler', async () => {
    // Regression guard. `send` raises RangeNotSatisfiableError for this, and
    // forwarding it to next() makes the global handler log `unhandled error`
    // with a stack trace. Players probe past EOF as a normal part of seeking,
    // so that turns ordinary scrubbing into a stream of production errors —
    // and the status code still comes back 416, which is what makes it easy
    // to miss.
    const before = errorHandlerHits;
    await fetch(base + assetUrl(VIDEO), { headers: { Range: 'bytes=99999999999-' } });
    assert.equal(errorHandlerHits, before, 'a seek past EOF must not be logged as a server error');
  });

  test('the mp4 is faststart — moov before mdat, or seeking stalls anyway', () => {
    // Correct Range handling does not help if the player has to fetch the
    // whole file to find the index. Both encodes must carry moov up front.
    for (const name of ['cvsprings-demo-1080.mp4', 'cvsprings-demo-720.mp4']) {
      const fd = fs.openSync(path.join(MEDIA_DIR, name), 'r');
      const order = [];
      try {
        let off = 0;
        for (let i = 0; i < 8; i += 1) {
          const head = Buffer.alloc(8);
          if (fs.readSync(fd, head, 0, 8, off) < 8) break;
          let size = head.readUInt32BE(0);
          order.push(head.toString('ascii', 4, 8));
          if (size === 0) break;
          if (size === 1) {
            const ext = Buffer.alloc(8);
            fs.readSync(fd, ext, 0, 8, off + 8);
            size = Number(ext.readBigUInt64BE(0));
          }
          off += size;
        }
      } finally { fs.closeSync(fd); }
      const moov = order.indexOf('moov');
      const mdat = order.indexOf('mdat');
      assert.ok(moov !== -1 && mdat !== -1, `${name}: found neither moov nor mdat in ${order.join(',')}`);
      assert.ok(moov < mdat, `${name} has moov after mdat — re-encode with faststart`);
    }
  });
});

describe('the route claims four filenames, not the directory', () => {
  test('an unmanaged name falls through rather than being served', async () => {
    const res = await fetch(`${base}${URL_PREFIX}/not-a-real-asset.mp4`);
    assert.equal(res.status, 404);
  });

  for (const attempt of ['../../package.json', '..%2f..%2fpackage.json', '%2e%2e/.env']) {
    test(`traversal is unrepresentable: ${attempt}`, async () => {
      const res = await fetch(`${base}${URL_PREFIX}/${attempt}`);
      assert.equal(res.status, 404, 'the allowlist should make this impossible to express');
    });
  }

  test('assetUrl rejects a name it does not manage', () => {
    assert.throws(() => assetUrl('some-other-file.mp4'), /not a managed asset/);
  });
});
