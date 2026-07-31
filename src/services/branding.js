'use strict';

/**
 * src/services/branding.js
 *
 * Resolves effective report branding: per-org overrides fall back to the
 * platform defaults. Also provides validation used both when saving branding
 * (PATCH /api/org/branding) and when rendering the report.
 *
 * This module is the SINGLE place that decides whether an org gets its own
 * branding on a report or the platform's. Custom report branding is a paid
 * feature: free orgs render with platform branding plus a "Made with
 * CVsprings" footer credit, no matter what they have saved. Every PDF path
 * must go through resolveBranding() so that decision cannot drift.
 *
 * Injected values must be validated/escaped by the caller before they reach
 * HTML. This module only validates structure (URL scheme, colour shape) and
 * length; HTML-escaping happens at render time.
 */

// Entitlement predicate shared with the analysis quota gate. Reusing it (rather
// than re-deriving "is this org paid?") means branding and quota can never
// disagree about what plan an org is on.
const { isUnlimited } = require('./billing');

// The product brand, NOT the operating legal entity (that is Chaulin BV, set
// via COMPANY_LEGAL_NAME and shown in terms/privacy). This name heads the
// report, so it must agree with FREE_TIER_CREDIT_TEXT below — a free-tier
// report reading "Chaulin — Candidate Assessment Report" over a "Made with
// CVsprings" credit is the drift this default previously caused. Overriding
// BRAND_NAME re-introduces that mismatch unless the credit is changed too.
const DEFAULT_BRAND_NAME = process.env.BRAND_NAME || 'CVsprings';
const DEFAULT_BRAND_COLOR = process.env.BRAND_COLOR || '#0f2847';
const DEFAULT_BRAND_LOGO_URL = process.env.BRAND_LOGO_URL || null;

// The exact free-tier credit string. Kept as one constant so the wording can be
// tuned without touching render logic — the renderer prints whatever
// resolveBranding() hands it back as `creditText` and never hardcodes it.
const FREE_TIER_CREDIT_TEXT = 'Made with CVsprings';

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

// Platform (CVsprings) branding, ignoring any org overrides. Used for free orgs
// and as the gap-filler for paid orgs that haven't configured their own.
function platformBranding() {
  return {
    name: DEFAULT_BRAND_NAME,
    color: DEFAULT_BRAND_COLOR,
    logoUrl: isSafeHttpUrl(DEFAULT_BRAND_LOGO_URL) ? DEFAULT_BRAND_LOGO_URL : null,
  };
}

/**
 * Effective branding for a report, plus whether to stamp the free-tier credit.
 *
 * @param {object|null} orgBranding  row from getOrganizationBranding()
 * @param {object|null} orgBilling   row from getOrgBilling() — the org's CURRENT plan
 * @returns {{name, color, logoUrl, showCredit: boolean, creditText: string|null}}
 *
 * Entitlement is decided here, server-side, from the live billing row — never
 * from anything the client sends. Two independent axes, deliberately decoupled:
 *
 *   showCredit  — strictly a free-tier element. Paid orgs never see it, even
 *                 when they have configured no branding of their own (#5: they
 *                 have paid; don't nag them).
 *   name/color/logoUrl — org's own only when entitled, otherwise platform.
 *
 * Fails closed: a missing or unreadable billing row resolves to free treatment,
 * so an outage can never hand out the paid experience.
 *
 * Nothing is memoised — callers pass freshly read rows and this returns a new
 * object every time, so a plan change takes effect on the very next report.
 */
function resolveBranding(orgBranding, orgBilling) {
  if (!isUnlimited(orgBilling)) {
    return { ...platformBranding(), showCredit: true, creditText: FREE_TIER_CREDIT_TEXT };
  }
  const b = orgBranding || {};
  const name = (typeof b.brandDisplayName === 'string' && b.brandDisplayName.trim())
    ? b.brandDisplayName.trim().slice(0, 80)
    : DEFAULT_BRAND_NAME;
  const color = isValidColor(b.brandColor) ? b.brandColor.trim() : DEFAULT_BRAND_COLOR;
  const logoUrl = isSafeHttpUrl(b.brandLogoUrl) ? b.brandLogoUrl
    : (isSafeHttpUrl(DEFAULT_BRAND_LOGO_URL) ? DEFAULT_BRAND_LOGO_URL : null);
  return { name, color, logoUrl, showCredit: false, creditText: null };
}

module.exports = {
  DEFAULT_BRAND_NAME,
  DEFAULT_BRAND_COLOR,
  DEFAULT_BRAND_LOGO_URL,
  FREE_TIER_CREDIT_TEXT,
  isSafeHttpUrl,
  isValidColor,
  resolveBranding,
};
