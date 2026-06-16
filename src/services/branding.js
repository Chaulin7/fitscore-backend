'use strict';

/**
 * src/services/branding.js
 *
 * Resolves effective report branding: per-org overrides fall back to env
 * defaults (the Chaulin defaults). Also provides validation used both when
 * saving branding (PATCH /api/org/branding) and when rendering the report.
 *
 * Injected values must be validated/escaped by the caller before they reach
 * HTML. This module only validates structure (URL scheme, colour shape) and
 * length; HTML-escaping happens at render time.
 */

const DEFAULT_BRAND_NAME = process.env.BRAND_NAME || 'Chaulin';
const DEFAULT_BRAND_COLOR = process.env.BRAND_COLOR || '#0f2847';
const DEFAULT_BRAND_LOGO_URL = process.env.BRAND_LOGO_URL || null;

// Only http(s) absolute URLs are allowed for the logo (no data:, javascript:, etc.).
function isSafeHttpUrl(value) {
  if (typeof value !== 'string' || !value) return false;
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

// Accept #rgb / #rrggbb hex colours only.
function isValidColor(value) {
  return typeof value === 'string' && /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(value.trim());
}

// Effective branding for a report: org overrides win, else env defaults.
// Returns sanitised primitives (still HTML-escape name at render).
function resolveBranding(orgBranding) {
  const b = orgBranding || {};
  const name = (typeof b.brandDisplayName === 'string' && b.brandDisplayName.trim())
    ? b.brandDisplayName.trim().slice(0, 80)
    : DEFAULT_BRAND_NAME;
  const color = isValidColor(b.brandColor) ? b.brandColor.trim() : DEFAULT_BRAND_COLOR;
  const logoUrl = isSafeHttpUrl(b.brandLogoUrl) ? b.brandLogoUrl
    : (isSafeHttpUrl(DEFAULT_BRAND_LOGO_URL) ? DEFAULT_BRAND_LOGO_URL : null);
  return { name, color, logoUrl };
}

module.exports = {
  DEFAULT_BRAND_NAME,
  DEFAULT_BRAND_COLOR,
  DEFAULT_BRAND_LOGO_URL,
  isSafeHttpUrl,
  isValidColor,
  resolveBranding,
};
