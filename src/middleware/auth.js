'use strict';

/**
 * src/middleware/auth.js
 *
 * Session-token authentication middleware (replaces the old X-Api-Key scheme).
 *
 * Requests must carry:  Authorization: Bearer {sessionToken}
 * The token is hashed with SHA-256 and looked up in the sessions table
 * (expiry checked). On success the request context gets:
 *   req.userId    - the authenticated user's id
 *   req.orgId     - the user's organization id (used for ALL data scoping)
 *   req.sessionId - the session row id (used by /logout and change-password)
 *   req.user      - the full user row (password_hash stripped)
 *
 * On failure: 401 { error: 'Unauthorized', code: 'AUTH_REQUIRED' }.
 *
 * requireSessionOrDownloadToken additionally accepts ?dt={downloadToken}
 * on GET requests for the two browser-opened endpoints (HTML report, CSV
 * export) that cannot send an Authorization header. Download tokens are
 * single-use, 60-second tokens bound to the issuing session's org.
 */

const authService = require('../services/authService');
const billing = require('../services/billing');
const { getOrgBilling } = require('../services/db');

function unauthorized(res) {
  return res.status(401).json({ error: 'Unauthorized', code: 'AUTH_REQUIRED' });
}

function extractBearerToken(req) {
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : null;
}

function requireSession(req, res, next) {
  const rawToken = extractBearerToken(req);
  if (!rawToken) return unauthorized(res);

  const found = authService.findSessionByToken(rawToken);
  if (!found) return unauthorized(res);

  const { session, user } = found;
  // Seat/plan gate: only an active Team plan permits non-owner members. If the
  // org downgrades or the Team subscription lapses, members are blocked on
  // their next request (no data is deleted; the owner re-upgrades to restore).
  if (user.role !== 'owner' && !billing.hasActiveTeamPlan(getOrgBilling(user.org_id))) {
    return res.status(403).json({
      error: 'Your team access is inactive. Ask your organization owner to re-activate the Team plan.',
      code: 'SEAT_LIMIT',
    });
  }
  req.userId = user.id;
  req.orgId = user.org_id;
  req.sessionId = session.id;
  const { password_hash, ...safeUser } = user;
  req.user = safeUser;
  return next();
}

// Paths (relative to the /api/audit mount) that may authenticate via ?dt=.
// Strictly the GETs a browser opens in a new tab or window, which cannot carry
// an Authorization header. Anchored one path at a time — the JSON bias-report
// endpoint is deliberately absent, because nothing opens it in a window and a
// single-use token is a weaker credential than a session.
const DOWNLOAD_TOKEN_PATHS = [
  /^\/report\/[^/]+$/,
  /^\/export\/csv$/,
  /^\/bias-report\/pdf$/,
];

function requireSessionOrDownloadToken(req, res, next) {
  const dt = req.query && req.query.dt;
  if (dt && req.method === 'GET' && DOWNLOAD_TOKEN_PATHS.some((re) => re.test(req.path))) {
    const grant = authService.consumeDownloadToken(String(dt));
    if (!grant) return unauthorized(res);
    req.userId = grant.userId;
    req.orgId = grant.orgId;
    return next();
  }
  return requireSession(req, res, next);
}

module.exports = { requireSession, requireSessionOrDownloadToken };
