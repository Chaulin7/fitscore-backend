/**
 * public/plans.js — SINGLE SOURCE OF TRUTH for CVsprings plan tiers.
 *
 * Loaded by the in-product Settings (app.html) and, once reconciled, the
 * marketing pages, so tier name/price/feature copy is defined exactly once.
 * Exposes window.CVSPRINGS_PLANS.
 *
 * LIMITS below are what the backend actually ENFORCES today
 * (src/services/billing.js): Free = 25 CV analyses/month (FREE_MONTHLY_LIMIT),
 * Pro/Team = unlimited; Team = multi-user seats, Free/Pro = single user. Those
 * two axes — monthly analysis quota and seats — are the ONLY plan differences
 * the code enforces.
 *
 * `baseline` = features available on EVERY plan (NOT plan-gated in code). They
 * are listed once here rather than duplicated per tier.
 *
 * FOLLOW-UP (separate backend ticket, NOT this PR): 'Audit log, change history &
 * CSV export' and 'Bias monitoring report' are slated to become paid-only (the
 * compliance differentiator). When that server-side gating lands, MOVE those two
 * out of `baseline` and into the Pro/Team tiers' highlights here.
 */
(function (root) {
  root.CVSPRINGS_PLANS = {
    currency: '€',

    // Included on all plans (not gated in code). Review whether any should be paid-only.
    baseline: [
      'Deterministic, explainable scoring engine',
      'Skill & eligibility extraction',
      'Single & batch CV upload',
      'Audit log, change history & CSV export',
      'Branded PDF assessment reports',
      'Bias monitoring report',
      'Role templates & presets',
    ],

    // Ordered low -> high; `highlights` are the ENFORCED per-tier differentiators.
    tiers: [
      {
        id: 'free', name: 'Free', priceLabel: '€0', per: '/month',
        tagline: 'Try CVsprings on a real role.',
        limits: { analysesPerMonth: 25, seats: 1 },
        highlights: ['25 CV analyses / month', 'Single user'],
      },
      {
        id: 'pro', name: 'Pro', priceLabel: '€49', per: '/month', featured: true,
        tagline: 'For recruiters screening at volume.',
        limits: { analysesPerMonth: null, seats: 1 },
        highlights: ['Unlimited CV analyses', 'Single user'],
        upgradePlan: 'pro', // -> POST /api/billing/checkout {plan:'pro'} (existing flow)
      },
      {
        id: 'team', name: 'Team', priceLabel: '€199', per: '/month',
        tagline: 'For agencies with a screening team.',
        limits: { analysesPerMonth: null, seats: 'multiple' },
        highlights: ['Unlimited CV analyses', 'Multiple team members'],
        upgradePlan: 'team',
      },
    ],
  };
})(typeof window !== 'undefined' ? window : this);
