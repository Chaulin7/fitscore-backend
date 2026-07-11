'use strict';

/**
 * src/services/provenanceCache.js
 *
 * Server-side binding for extraction provenance. The analyze -> save flow is
 * stateless HTTP from the client's perspective: /api/analyze returns the
 * extraction summary (engine, versions, text SHA-256, counts) and the client
 * echoes it back when saving an audit record. An echo the client controls is
 * not tamper-evident, so the server remembers every summary it issues, keyed
 * by (orgId, textSha256), and the audit save persists the SERVER-HELD copy —
 * the client echo is reduced to a lookup key. A sha the server never issued
 * for that org resolves to null and no provenance is stored.
 *
 * Bounds: entries expire after TTL_MS and the map is capped (oldest evicted
 * first). Known caveat, accepted for this threat model (recruiters, not
 * adversaries): the cache is in-memory, so provenance is lost on server
 * restart or if a save happens > TTL after analysis — those saves store null
 * provenance rather than trusting the client.
 */

const TTL_MS = 24 * 60 * 60 * 1000; // provenance is claimable for 24h after analysis
const MAX_ENTRIES = 5000;           // bound memory; oldest evicted first

const cache = new Map(); // "orgId:sha" -> { summary, expiresAt }

function cacheKey(orgId, sha) {
  return `${orgId}:${sha}`;
}

// Called by /api/analyze for every successful extraction it returns.
function remember(orgId, summary) {
  if (!orgId || !summary || typeof summary.textSha256 !== 'string') return;
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  cache.set(cacheKey(orgId, summary.textSha256), {
    summary: { ...summary },
    expiresAt: Date.now() + TTL_MS,
  });
}

// Called by POST /api/audit: resolves an echoed sha to the server-held
// summary for this org, or null if the server never issued it (or it expired).
function lookup(orgId, sha) {
  if (!orgId || typeof sha !== 'string') return null;
  const key = cacheKey(orgId, sha);
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return { ...entry.summary };
}

module.exports = { remember, lookup };
