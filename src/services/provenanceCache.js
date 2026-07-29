'use strict';

/**
 * src/services/provenanceCache.js
 *
 * Server-side binding for a single analysis's provenance (extraction summary +
 * the exact weights the engine applied + engine version). The analyze -> save
 * flow is stateless HTTP from the client's perspective: /api/analyze mints an
 * opaque analysisId per scored result, returns it, and the client echoes it back
 * when saving an audit record. The server remembers every record it issues,
 * keyed by (orgId, analysisId), and the save persists the SERVER-HELD copy —
 * the client echo is only a lookup key.
 *
 * Keyed by analysisId, NOT textSha256: the same CV analysed twice under
 * different weights produces two records (two analysisIds), so saving the first
 * result records the first analysis's weights. A textSha256 key would collide
 * (same CV -> same key) and let a later analysis clobber an earlier one's
 * weights — the last-writer-wins bug this replaces.
 *
 * Bounds: entries expire after TTL_MS and the map is capped (oldest evicted
 * first). Known caveat, accepted for this threat model (recruiters, not
 * adversaries): the cache is in-memory, so provenance is lost on server restart
 * or if a save happens > TTL after analysis — those saves store null provenance
 * rather than trusting the client.
 */

const TTL_MS = 24 * 60 * 60 * 1000; // provenance is claimable for 24h after analysis
const MAX_ENTRIES = 5000;           // bound memory; oldest evicted first

const cache = new Map(); // "orgId:analysisId" -> { record, expiresAt }

function cacheKey(orgId, analysisId) {
  return `${orgId}:${analysisId}`;
}

// Called by /api/analyze for every scored result it returns. `record` must
// carry a string analysisId; it also holds the extraction summary (incl.
// textSha256), scoringWeights, and engineVersion.
function remember(orgId, record) {
  if (!orgId || !record || typeof record.analysisId !== 'string') return;
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  cache.set(cacheKey(orgId, record.analysisId), {
    record: { ...record },
    expiresAt: Date.now() + TTL_MS,
  });
}

// Called by POST /api/audit: resolves an echoed analysisId to the server-held
// record for this org, or null if the server never issued it (or it expired).
function lookup(orgId, analysisId) {
  if (!orgId || typeof analysisId !== 'string') return null;
  const key = cacheKey(orgId, analysisId);
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return { ...entry.record };
}

module.exports = { remember, lookup };
