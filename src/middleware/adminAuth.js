'use strict';

/**
 * src/middleware/adminAuth.js — the platform-operator guard.
 *
 * Lifted verbatim out of routes/adminMetrics.js when a SECOND operator-only
 * endpoint appeared (POST /admin/trial-invites). The rules below are subtle
 * enough — 404 on every failure, no session tokens from the query string, a
 * timing-safe owner comparison — that a second copy would have been a second
 * chance to get one of them wrong, and the wrong one fails open and silent.
 *
 * NOT DISCOVERABLE. Every rejection — no credential, an expired session, a valid
 * session belonging to somebody else, a non-owner member — returns the same 404
 * JSON body the application's catch-all returns. In particular it does not 401:
 * a 401 on /admin/trial-invites next to a 404 on /admin/trial-invitez tells a
 * prober exactly which of the two is real.
 */

const authService = require('../services/authService');
// The owner rule lives in config/platformOwner so this guard and the
// isPlatformOwner flag on the session payload cannot drift apart.
const { isPlatformOwner } = require('../config/platformOwner');

/**
 * The application's catch-all 404, byte for byte.
 *
 * `path` is rebuilt from the mount plus the route rather than hardcoded, so it
 * reports what the catch-all would have reported for this same URL — which is
 * the whole point of being indistinguishable from it.
 */
function notFound(req, res) {
  const path = `${req.baseUrl || ''}${req.path || ''}` || req.originalUrl || '/';
  return res.status(404).json({ error: 'Not found', code: 'NOT_FOUND', path });
}

/**
 * Resolve the caller, or null.
 *
 * Two credentials, both existing mechanisms, no new one invented:
 *
 *   Authorization: Bearer …  the normal session token, same lookup
 *                            middleware/auth.requireSession does.
 *   ?dt=…                    a single-use 60s download token from
 *                            POST /api/auth/download-token. GET /admin/metrics
 *                            is opened in a browser tab, and a browser tab
 *                            cannot send an Authorization header — the same
 *                            constraint that put ?dt= on the HTML report and
 *                            the CSV export.
 *
 * A session token is never accepted from the query string. It is long-lived,
 * and a URL lands in browser history, in a Referer, and in any log that does
 * not strip query strings. The download token is minted for one navigation and
 * is dead by the time the page has rendered. GET only, for the same reason:
 * nothing that mutates state should be reachable by following a link.
 */
function resolveCaller(req) {
  const header = req.headers.authorization || '';
  const bearer = /^Bearer\s+(.+)$/i.exec(header);
  if (bearer) {
    const found = authService.findSessionByToken(bearer[1].trim());
    if (found && found.user) return { user: found.user, authMethod: 'session' };
  }

  const dt = req.query && req.query.dt;
  if (dt && req.method === 'GET') {
    const grant = authService.consumeDownloadToken(String(dt));
    if (grant && grant.userId) {
      const user = authService.findUserById(grant.userId);
      if (user) return { user, authMethod: 'download_token' };
    }
  }

  return null;
}

/**
 * Owner-only guard. 404 on every failure path.
 *
 * The ownership rule itself is config/platformOwner.isPlatformOwner — email AND
 * role 'owner', compared timing-safely. This function's job is the 404, not the
 * rule: routes/auth publishes the same predicate to the SPA so the menu item and
 * this gate agree by construction rather than by both being kept up to date.
 *
 * Re-derived from the session on every request. The client's isPlatformOwner
 * flag is a rendering hint and is never consulted here.
 */
function requirePlatformOwner(req, res, next) {
  const caller = resolveCaller(req);
  if (!caller) return notFound(req, res);
  if (!isPlatformOwner(caller.user)) return notFound(req, res);

  req.adminUser = caller.user;
  req.adminAuthMethod = caller.authMethod;
  return next();
}

module.exports = { requirePlatformOwner, resolveCaller, notFound };
