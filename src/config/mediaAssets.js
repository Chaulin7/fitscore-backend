'use strict';

/**
 * src/config/mediaAssets.js — content-hashed URLs for the demo video assets.
 *
 * The demo video and its poster are the only large static files the landing
 * page pulls, and they are the only ones worth a year-long cache. A year-long
 * cache is also the only one that can strand a visitor on a stale copy
 * forever, so the two decisions are inseparable: `immutable` is safe *only*
 * because the URL changes when the bytes change.
 *
 * So each file is hashed once at boot and its URL carries `?v=<hash>`. That
 * hash is substituted into the served HTML the same way __PRICING_JSONLD__ and
 * __LEGAL_FOOTER__ are (src/index.js) — computed per deploy, not per request,
 * because the files cannot change while the process is up.
 *
 * The poster is hashed too, not just the mp4s. A poster is a still frame of
 * the video: re-encode the video without re-versioning the poster and the page
 * shows a frame from the previous cut for up to a year. Same bug, quieter.
 *
 * Why a query string rather than a hashed filename: the filenames are what
 * gets committed to git, and rewriting them on every re-encode would add a new
 * ~4 MB blob to history under a new path each time while the old one stayed
 * reachable forever. With `?v=`, the committed path is stable and only the
 * substituted URL moves. Cloudflare's default Cache Level (Standard) includes
 * the full query string in its cache key, so the versioned URL is a distinct
 * cache entry from an unversioned one — see the route in src/routes/mediaAssets.js,
 * which refuses to send `immutable` unless the hash actually matches.
 *
 * A missing file does not throw. Dev checkouts and CI may not have the video
 * (it is committed, but a sparse or partial checkout would not); the URL then
 * falls back to unversioned and the route serves a short cache, so the page
 * degrades to "video may be stale" rather than "server will not boot".
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/** Directory the hashed assets are served from, relative to the public root. */
const MEDIA_DIR = path.join(__dirname, '..', '..', 'public', 'assets', 'video');

/** URL prefix the route below is mounted at. Must match src/index.js. */
const URL_PREFIX = '/assets/video';

/**
 * The files under management, keyed by the HTML placeholder that carries their
 * URL. Adding a file here is all it takes to version it — the route derives
 * its allowlist from this same table, so a file absent from it is not
 * servable through the immutable route at all.
 */
const MANAGED = {
  __DEMO_VIDEO_1080__: 'cvsprings-demo-1080.mp4',
  __DEMO_VIDEO_720__: 'cvsprings-demo-720.mp4',
  __DEMO_POSTER_JPG__: 'cvsprings-demo-poster.jpg',
  __DEMO_POSTER_WEBP__: 'cvsprings-demo-poster.webp',
};

/**
 * Publication date of the recording, as schema.org VideoObject.uploadDate.
 *
 * It lives here, beside the files it describes, rather than next to the
 * JSON-LD that consumes it: everything else about these assets updates itself
 * when the bytes change, because it is derived from the bytes. This one field
 * cannot be — a re-encode of the same recording is not a new upload, and a
 * file mtime is reset by any fresh checkout, so it would lie on every deploy.
 *
 * MUST BE BUMPED WHEN THE DEMO IS RE-RECORDED. Re-encoding the existing cut
 * (a new resolution, a smaller file) does not change it; recording new footage
 * does. Getting it wrong misdates the video in search results and nowhere
 * else, so nothing will fail to tell you.
 */
const DEMO_VIDEO_UPLOAD_DATE = '2026-09-04';

/**
 * First 10 hex chars of the file's SHA-256, or null if it cannot be read.
 *
 * 10 hex chars is 40 bits. These are cache-busting tokens, not integrity
 * checks — the threat is an accidental collision between two builds of the
 * same file, not a forged one, and 40 bits is far past that.
 */
function hashFile(absPath) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex').slice(0, 10);
  } catch (_) {
    return null; // missing or unreadable — caller degrades to an unversioned URL
  }
}

/** fileName -> hash, for every managed file that could be read at boot. */
const hashes = {};
/** fileName -> byte size, logged at boot so a truncated asset is visible. */
const sizes = {};
const missing = [];

for (const fileName of Object.values(MANAGED)) {
  const abs = path.join(MEDIA_DIR, fileName);
  const hash = hashFile(abs);
  if (hash === null) {
    missing.push(fileName);
    continue;
  }
  hashes[fileName] = hash;
  sizes[fileName] = fs.statSync(abs).size;
}

/**
 * Public URL for a managed file, content-hashed when the file was readable.
 * Unknown names throw: a typo here would otherwise render as a dead <source>
 * that fails silently in the player.
 */
function assetUrl(fileName) {
  if (!Object.values(MANAGED).includes(fileName)) {
    throw new Error(`mediaAssets: ${fileName} is not a managed asset`);
  }
  const hash = hashes[fileName];
  return hash ? `${URL_PREFIX}/${fileName}?v=${hash}` : `${URL_PREFIX}/${fileName}`;
}

/** Placeholder -> URL, for the startup substitution pass in src/index.js. */
const MEDIA_PLACEHOLDERS = Object.fromEntries(
  Object.entries(MANAGED).map(([placeholder, fileName]) => [placeholder, assetUrl(fileName)]),
);

/**
 * The hash currently in force for a file, or null if the file is not managed
 * or was unreadable at boot. The route uses this to decide whether a request's
 * `?v=` earns the immutable header.
 */
function currentVersion(fileName) {
  return Object.prototype.hasOwnProperty.call(hashes, fileName) ? hashes[fileName] : null;
}

/** Absolute path for a managed file, or null if the name is not managed. */
function resolvePath(fileName) {
  // Allowlist, not sanitisation: the name must be one of the four literals in
  // MANAGED. Path traversal is not filtered out, it is unrepresentable.
  if (!Object.values(MANAGED).includes(fileName)) return null;
  return path.join(MEDIA_DIR, fileName);
}

/**
 * Say once, at boot, what was hashed — and say loudly what was not. A missing
 * video does not break the server, so nothing else would ever mention it.
 */
function logMediaAssets(log) {
  const names = Object.keys(hashes);
  if (names.length) {
    log.info(' Media assets hashed: ' + names.map((n) => `${n}@${hashes[n]} (${(sizes[n] / 1048576).toFixed(2)} MB)`).join(', '));
  }
  if (missing.length) {
    log.warn(`Media assets missing from public/assets/video: ${missing.join(', ')}`
      + ' — they will be served unversioned with a short cache, if at all.');
  }
}

module.exports = {
  MANAGED,
  URL_PREFIX,
  DEMO_VIDEO_UPLOAD_DATE,
  MEDIA_PLACEHOLDERS,
  assetUrl,
  currentVersion,
  resolvePath,
  logMediaAssets,
};
