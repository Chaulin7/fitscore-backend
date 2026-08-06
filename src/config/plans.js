'use strict';

/**
 * src/config/plans.js — SINGLE SOURCE OF TRUTH for CVsprings plan tiers.
 *
 * Canonical and server-side. The pricing page and the in-product Settings both
 * read it over GET /api/plans (see src/routes/plans.js), so tier name, price,
 * feature copy and capability flags are defined exactly once. This file
 * replaced public/plans.js, which was browser-only and therefore unreadable by
 * the code that actually enforces the tiers.
 *
 * LIMITS below are what the backend actually ENFORCES today:
 *   - monthly analysis quota — Free = 25/month (FREE_MONTHLY_LIMIT), Pro/Team
 *     unlimited (src/services/billing.js)
 *   - seats — Team = multi-user, Free/Pro = single user (same file)
 *   - customBranding — whether the report header may carry the org's own mark
 *     instead of the CVsprings brandmark (src/services/branding.js)
 *
 * That third axis is why `capabilities` exists. Report branding used to be
 * gated by calling isUnlimited(), a quota predicate borrowed for a question it
 * does not answer — which meant branding entitlement could never diverge from
 * quota entitlement even where the product wanted it to. The flag below is now
 * the ONLY expression of that gate: nothing downstream compares tier names.
 *
 * `baseline` = features available on EVERY plan (NOT plan-gated in code). They
 * are listed once here rather than duplicated per tier. Note that branded PDF
 * reports are baseline — every report at every tier carries a mark and a
 * provenance footer. The paid differentiator is WHOSE brand, never whether
 * there is one.
 *
 * FOLLOW-UP (separate backend ticket): 'Audit log, change history & CSV export'
 * and 'Bias monitoring report' are slated to become paid-only (the compliance
 * differentiator). When that server-side gating lands, MOVE those two out of
 * `baseline` and into the Pro/Team tiers' highlights here.
 */

const WHITE_LABEL_HIGHLIGHT =
  'White-label reports — replace the CVsprings mark with your own logo';

const PLANS = {
  currency: '€',

  // Included on all plans (not gated in code).
  baseline: [
    'Deterministic, explainable scoring engine',
    'Skill & eligibility extraction',
    'Single & batch CV upload',
    'Audit log, change history & CSV export',
    'Professional branded PDF assessment reports',
    'Bias monitoring report',
    'Role templates & presets',
  ],

  // Ordered low -> high; `highlights` are the ENFORCED per-tier differentiators.
  tiers: [
    {
      id: 'free', name: 'Free', priceLabel: '€0', per: '/month',
      tagline: 'Try CVsprings on a real role.',
      limits: { analysesPerMonth: 25, seats: 1 },
      capabilities: { customBranding: false },
      highlights: ['25 CV analyses / month', 'Single user'],
    },
    {
      id: 'pro', name: 'Pro', priceLabel: '€49', per: '/month', featured: true,
      tagline: 'For recruiters screening at volume.',
      limits: { analysesPerMonth: null, seats: 1 },
      capabilities: { customBranding: true },
      highlights: ['Unlimited CV analyses', 'Single user', WHITE_LABEL_HIGHLIGHT],
      upgradePlan: 'pro', // -> POST /api/billing/checkout {plan:'pro'} (existing flow)
    },
    {
      id: 'team', name: 'Team', priceLabel: '€199', per: '/month',
      tagline: 'For agencies with a screening team.',
      limits: { analysesPerMonth: null, seats: 'multiple' },
      capabilities: { customBranding: true },
      highlights: ['Unlimited CV analyses', 'Multiple team members', WHITE_LABEL_HIGHLIGHT],
      upgradePlan: 'team',
    },
  ],
};

// Capabilities applied when a plan id is unknown, missing, or malformed.
// Deliberately the free set: an org whose plan cannot be identified gets the
// least entitlement, never the most.
const FALLBACK_CAPABILITIES = Object.freeze({ customBranding: false });

function tierById(planId) {
  if (typeof planId !== 'string') return null;
  return PLANS.tiers.find((t) => t.id === planId) || null;
}

/**
 * Capability flags for a plan id. Fails closed on anything unrecognised.
 * @param {string|null|undefined} planId
 * @returns {{customBranding: boolean}}
 */
function capabilitiesFor(planId) {
  const tier = tierById(planId);
  if (!tier || !tier.capabilities) return { ...FALLBACK_CAPABILITIES };
  return { ...FALLBACK_CAPABILITIES, ...tier.capabilities };
}

/**
 * The subset served over the public, unauthenticated GET /api/plans.
 *
 * An explicit allowlist rather than a copy of the whole object, so any internal
 * field added to a tier later has to be opted in to be published. Capability
 * flags ARE included: the client needs them to render entitlement-dependent UI
 * (e.g. the Settings branding panel's disabled state), and they are not
 * secrets. The server never trusts a client's copy — every gate re-reads this
 * module directly.
 */
function marketingView() {
  return {
    currency: PLANS.currency,
    baseline: [...PLANS.baseline],
    tiers: PLANS.tiers.map((t) => ({
      id: t.id,
      name: t.name,
      priceLabel: t.priceLabel,
      per: t.per,
      tagline: t.tagline,
      featured: !!t.featured,
      limits: { ...t.limits },
      capabilities: capabilitiesFor(t.id),
      highlights: [...t.highlights],
      ...(t.upgradePlan ? { upgradePlan: t.upgradePlan } : {}),
    })),
  };
}

module.exports = {
  PLANS,
  FALLBACK_CAPABILITIES,
  tierById,
  capabilitiesFor,
  marketingView,
};
