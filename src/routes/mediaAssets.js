'use strict';

/**
 * src/routes/mediaAssets.js — the demo video and poster, cached for a year.
 *
 * Mounted at /assets/video BEFORE express.static (src/index.js), because
 * express.static would otherwise answer first and hand out
 * `Cache-Control: public, max-age=0` for a 3.9 MB file on every page view.
 *
 * The one rule that makes `immutable` safe:
 *
 *   the year-long, immutable cache is sent ONLY when the request's `?v=`
 *   equals the hash of the bytes actually on disk.
 *
 * Everything else — no `?v=`, a stale `?v=` from a page cached before the last
 * deploy, a hand-typed URL — gets the current bytes with a five-minute cache.
 * That distinction is the whole point. Registering this route ahead of
 * express.static means it also catches the *unversioned* path, and if it
 * stamped `immutable` on that, a single visit to a bare
 * /assets/video/cvsprings-demo-1080.mp4 would pin that copy in the visitor's
 * browser for a year with no way to revoke it. Cache lifetime is the only
 * thing that varies: an unrecognised `?v=` still serves the current file, so a
 * visitor holding a stale HTML page sees today's video, not a 404.
 *
 * Range requests are not handled here. res.sendFile delegates to `send`, which
 * advertises Accept-Ranges: bytes and answers a Range header with 206 +
 * Content-Range on its own — that is what makes the video seekable, and it is
 * covered end to end in mediaAssets.test.js rather than assumed.
 */

const express = require('express');
const { currentVersion, resolvePath } = require('../config/mediaAssets');

const router = express.Router();

/** One year, the maximum any cache should be asked to hold anything. */
const IMMUTABLE_MAX_AGE = '1y';

/**
 * Unversioned or stale-versioned requests. Long enough to absorb a burst,
 * short enough that a re-encode reaches everyone the same afternoon.
 */
const UNVERSIONED_MAX_AGE = '5m';

router.get('/:file', (req, res, next) => {
  const abs = resolvePath(req.params.file);
  // Not one of the managed assets — let express.static and the 404 handler
  // deal with it. This route claims four filenames, not the whole directory.
  if (!abs) return next();

  const version = currentVersion(req.params.file);
  const versioned = Boolean(version) && req.query.v === version;

  const options = versioned
    ? { maxAge: IMMUTABLE_MAX_AGE, immutable: true }
    : { maxAge: UNVERSIONED_MAX_AGE };

  res.sendFile(abs, options, (err) => {
    if (!err) return;
    // A client that aborts mid-download (seeking, or navigating away) surfaces
    // here after the response is already streaming. There is nothing to say to
    // a socket that is gone, and it is not an error worth logging.
    if (res.headersSent) return;

    const status = err.status || err.statusCode || 500;

    // 416 is not a fault. Players routinely probe past the end of a file while
    // seeking, and `send` raises this for every one of them. Left to fall
    // through, it reaches the global error handler in src/index.js, which logs
    // `unhandled error` with a stack trace — so ordinary scrubbing would fill
    // production logs with noise. send has already set Content-Range: bytes
    // */<size> on the response, which is exactly what a 416 owes the client,
    // so ending it here sends the correct answer and says nothing.
    if (status === 416) return res.status(416).end();

    // The file was readable at boot and is not now. Fall through to the static
    // handler and the 404, rather than reporting a 500 for a missing file.
    if (status === 404 || err.code === 'ENOENT') return next();

    next(err);
  });
});

module.exports = router;
