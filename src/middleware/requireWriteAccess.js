'use strict';

/**
 * src/middleware/requireWriteAccess.js — the read-only gate.
 *
 * A subscription that Stripe paused (a trial that ended with no payment method)
 * leaves the account in a state the product previously had no way to express:
 * not entitled, not gone. This middleware is that state, enforced.
 *
 * READS ALWAYS PASS. GET, HEAD and OPTIONS go through untouched at every
 * entitlement level above NONE, because read-only has to actually mean
 * read-only — an account that cannot open its own audit log has been deleted in
 * everything but name, and the whole point of pausing rather than cancelling is
 * that nothing is deleted.
 *
 * It decides nothing itself. The status -> entitlement mapping is
 * services/entitlements.js and only services/entitlements.js; this file turns
 * that answer into an HTTP response.
 *
 * NOT MOUNTED ON /api/billing, deliberately and load-bearingly. The way out of
 * a paused subscription is POST /api/billing/portal — adding a card. Gating
 * billing behind the entitlement that only a card can restore would lock the
 * customer in the room with the key on the other side of the door.
 *
 * Skipped when req.orgId is unset. Two mounts (/api/org, /api/team) run before
 * their routers' own requireSession, and a request with no resolved org has no
 * entitlement to check — the route's auth answers it first, with a 401.
 */

const { getOrgBilling } = require('../services/db');
const { writeAccessFor } = require('../services/entitlements');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function requireWriteAccess(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  if (!req.orgId) return next(); // not yet authenticated; the route will say so

  const access = writeAccessFor(getOrgBilling(req.orgId));
  if (access.allowed) return next();

  // 402 Payment Required is the honest code for both refusals: the account is
  // authenticated and authorized, and the only thing standing in the way is
  // money. It is also what the quota gate already returns for QUOTA_EXCEEDED,
  // so the client's existing "this needs billing attention" branch catches it.
  return res.status(402).json({
    error: access.message,
    code: access.code,
    entitlement: access.level,
  });
}

module.exports = { requireWriteAccess };
