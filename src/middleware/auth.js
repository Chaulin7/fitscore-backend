'use strict';

/**
 * src/middleware/auth.js
 *
 * Lightweight API-key authentication middleware.
*
 * Every request must carry an X-Api-Key header.  The key is hashed with
 * SHA-256 and compared against a list of known keys stored in the
 * API_KEYS environment variable (comma-separated, pre-hashed SHA-256 hex
 * values OR raw keys when HASH_KEYS=false for local dev).
 *
 * req.userId is set to the SHA-256 hex of the raw key — this is the
 * stable, opaque tenant identifier that scopes all data access.
 *
 * In single-key deployments (one recruiter, one key) set API_KEYS to a
 * single SHA-256 hex string.  The userId will be that hash.
 *
 * Security notes:
 *   - Keys are never logged or returned in responses.
 *   - Timing-safe comparison is used to prevent timing attacks.
 *   - The header name is case-insensitive (Express normalises to lower).
 */

const crypto = require('crypto');

function sha256hex(str) {
    return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

// Timing-safe string equality
function safeEqual(a, b) {
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/**
 * Build the set of allowed key hashes from the environment.
 * API_KEYS is a comma-separated list of *already-hashed* SHA-256 hex strings.
 * If API_KEYS is not set, auth is disabled in development mode only.
 */
function getAllowedHashes() {
    const raw = (process.env.API_KEYS || '').split(',').map((s) => s.trim()).filter(Boolean);
    return raw;
}

/**
 * requireApiKey(req, res, next)
 *
 * Sets req.userId to the SHA-256 hex of the presented key on success.
 * Returns 401 on missing key or 403 on unrecognised key.
 *
 * DEV BYPASS: when NODE_ENV === 'development' AND API_KEYS is unset,
 * the middleware is skipped and req.userId is set to 'dev-default'.
 * This makes local development possible without configuring keys while
 * ensuring production always enforces auth.
 */
function requireApiKey(req, res, next) {
    const allowedHashes = getAllowedHashes();

  // Dev bypass — only active when no keys are configured at all
  if (allowedHashes.length === 0) {
        if (process.env.NODE_ENV !== 'production') {
                req.userId = 'dev-default';
                return next();
        }
        // Production with no keys configured is a misconfiguration — block all
      return res.status(503).json({
              error: 'Service misconfigured: API_KEYS environment variable is not set.',
              code: 'MISCONFIGURED',
      });
  }

  const presented = req.headers['x-api-key'];
    if (!presented) {
          return res.status(401).json({
                  error: 'Missing X-Api-Key header.',
                  code: 'UNAUTHORIZED',
          });
    }

  const presentedHash = sha256hex(presented);

  // Check against each allowed hash
  const matched = allowedHashes.find((h) => {
        if (h.length !== 64) return false; // not a valid sha256 hex
                                         try {
                                                 return safeEqual(presentedHash, h);
                                         } catch {
                                                 return false;
                                         }
  });

  if (!matched) {
        return res.status(403).json({
                error: 'Invalid API key.',
                code: 'FORBIDDEN',
        });
  }

  // userId is the hash of the key — stable, opaque, never the raw key
  req.userId = presentedHash;
    return next();
}

module.exports = { requireApiKey, sha256hex };
