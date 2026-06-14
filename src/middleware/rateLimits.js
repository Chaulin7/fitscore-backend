'use strict';

/**
 * src/middleware/rateLimits.js
 *
 * Server-side rate limiting. Authenticated routes are limited per ORGANIZATION;
 * unauthenticated ones per IP (handled in their own routers).
 *
 * The store is in-memory: correct for a single instance. A multi-instance
 * deploy needs a shared store (e.g. Redis) — see docs/security/README.md.
 *
 * All limits come from env so scaling/tuning needs no code change.
 */

const rateLimit = require('express-rate-limit');

const intEnv = (name, def) => {
  const v = Number.parseInt(process.env[name], 10);
  return Number.isFinite(v) && v > 0 ? v : def;
};

const ANALYZE_RATE = intEnv('ANALYZE_RATE', 60);        // analyses-worth / org / window
const ANALYZE_WINDOW_MS = 10 * 60 * 1000;
const MUTATION_RATE = intEnv('MUTATION_RATE', 300);     // mutating requests / org / window
const MUTATION_WINDOW_MS = 10 * 60 * 1000;

// Key authenticated requests by org; fall back to IP if somehow unauthenticated.
function orgKey(req) {
  return req.orgId ? 'org:' + req.orgId : 'ip:' + req.ip;
}

// --- Cost-weighted analyze limiter (custom; a batch costs its CV count) -----
// Fixed window per org. checkAndConsume reserves `cost` units; if that would
// exceed the cap it consumes nothing and reports retryAfter.
const analyzeBuckets = new Map(); // key -> { count, resetAt }

function checkAndConsumeAnalyze(req, cost) {
  const key = orgKey(req);
  const now = Date.now();
  let b = analyzeBuckets.get(key);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + ANALYZE_WINDOW_MS };
    analyzeBuckets.set(key, b);
  }
  if (b.count + cost > ANALYZE_RATE) {
    return { allowed: false, retryAfter: Math.ceil((b.resetAt - now) / 1000), limit: ANALYZE_RATE };
  }
  b.count += cost;
  // Opportunistic cleanup so the map can't grow without bound.
  if (analyzeBuckets.size > 5000) {
    for (const [k, v] of analyzeBuckets) { if (v.resetAt <= now) analyzeBuckets.delete(k); }
  }
  return { allowed: true, limit: ANALYZE_RATE, used: b.count };
}

// Helper for routes: enforce the analyze rate; on block, write 429 + Retry-After.
function enforceAnalyzeRate(req, res, cost) {
  const r = checkAndConsumeAnalyze(req, cost);
  if (!r.allowed) {
    res.set('Retry-After', String(r.retryAfter));
    res.status(429).json({ error: 'Too many requests, please slow down.', code: 'RATE_LIMITED', retryAfter: r.retryAfter });
    return false;
  }
  return true;
}

// --- Mutating audit/template limiter (express-rate-limit, org-keyed) --------
// Skips GET reads; catches runaway write loops.
const mutationLimiter = rateLimit({
  windowMs: MUTATION_WINDOW_MS,
  max: MUTATION_RATE,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: orgKey,
  skip: (req) => req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS',
  handler: (req, res) => {
    const retryAfter = Math.ceil(MUTATION_WINDOW_MS / 1000);
    res.set('Retry-After', String(retryAfter));
    res.status(429).json({ error: 'Too many requests, please slow down.', code: 'RATE_LIMITED', retryAfter });
  },
});

// --- Sample/onboarding limiter (org-keyed safety net) ----------------------
// The sample endpoint is cached and not quota-counted; this just guards abuse.
const sampleLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: intEnv('SAMPLE_RATE', 20),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: orgKey,
  handler: (req, res) => {
    const retryAfter = 60 * 60;
    res.set('Retry-After', String(retryAfter));
    res.status(429).json({ error: 'Too many requests, please slow down.', code: 'RATE_LIMITED', retryAfter });
  },
});

module.exports = {
  ANALYZE_RATE,
  MUTATION_RATE,
  enforceAnalyzeRate,
  mutationLimiter,
  sampleLimiter,
};
