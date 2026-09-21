'use strict';

/**
 * src/services/entitlements.test.js — the single status -> entitlement mapping.
 *
 * This module exists because the rule was previously written out three times
 * and all three copies omitted 'trialing'. The tests below are therefore as
 * much about the ABSENCE of second copies as about the mapping: the last block
 * asserts that the two predicates in services/billing.js and the write gate all
 * give the same answer for the same status, so a future edit to one of them
 * that does not go through this module shows up as a failure here.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  ENTITLEMENT, entitlementForStatus, entitlementForOrg, canRead, canWrite, writeAccessFor,
} = require('./entitlements');
const billing = require('./billing');

describe('entitlementForStatus — the mapping the spec states', () => {
  test('trialing and active grant full access', () => {
    assert.equal(entitlementForStatus('trialing'), ENTITLEMENT.FULL);
    assert.equal(entitlementForStatus('active'), ENTITLEMENT.FULL);
  });

  test('paused is read-only', () => {
    assert.equal(entitlementForStatus('paused'), ENTITLEMENT.READ_ONLY);
    assert.equal(canRead(ENTITLEMENT.READ_ONLY), true, 'reads still pass');
    assert.equal(canWrite(ENTITLEMENT.READ_ONLY), false, 'writes do not');
  });

  test('canceled and unpaid grant nothing', () => {
    assert.equal(entitlementForStatus('canceled'), ENTITLEMENT.NONE);
    assert.equal(entitlementForStatus('unpaid'), ENTITLEMENT.NONE);
  });

  test('past_due keeps access — the documented dunning grace, not a lockout', () => {
    assert.equal(entitlementForStatus('past_due'), ENTITLEMENT.FULL);
  });

  test('an unrecognised or absent status fails closed', () => {
    for (const bad of [null, undefined, '', 'something_new', 42, {}]) {
      assert.equal(entitlementForStatus(bad), ENTITLEMENT.NONE, `fails closed on ${String(bad)}`);
    }
  });
});

describe('entitlementForOrg — what an account may actually do', () => {
  test('a free org has full access; the quota gate is a separate axis', () => {
    assert.equal(entitlementForOrg({ plan: 'free', subscriptionStatus: null }), ENTITLEMENT.FULL);
  });

  test('a comped org is fully entitled with no subscription at all', () => {
    assert.equal(entitlementForOrg({ plan: 'pro', subscriptionStatus: null, comped: 1 }), ENTITLEMENT.FULL);
  });

  test('a trialing paid org has full access', () => {
    assert.equal(entitlementForOrg({ plan: 'pro', subscriptionStatus: 'trialing' }), ENTITLEMENT.FULL);
  });

  test('a paused paid org is read-only', () => {
    assert.equal(entitlementForOrg({ plan: 'pro', subscriptionStatus: 'paused' }), ENTITLEMENT.READ_ONLY);
  });

  test('a churned org falls back to the free tier rather than being locked out', () => {
    // The webhook resets plan to 'free' on the terminal statuses, so this is
    // what a canceled customer looks like a moment later — and Free is a
    // product we ship, not a punishment. docs/billing/README.md: "the org
    // returns to Free and the cap resumes".
    assert.equal(entitlementForOrg({ plan: 'free', subscriptionStatus: 'canceled' }), ENTITLEMENT.FULL);
    assert.equal(entitlementForOrg({ plan: 'pro', subscriptionStatus: 'canceled' }), ENTITLEMENT.FULL);
  });

  test('paused is the one dead status that does NOT fall back to free', () => {
    // Falling back would hand a trialist ten free analyses a month forever and
    // remove every reason to add a card.
    assert.equal(entitlementForOrg({ plan: 'team', subscriptionStatus: 'paused' }), ENTITLEMENT.READ_ONLY);
  });

  test('an unknown org is treated as free, not as forbidden', () => {
    assert.equal(entitlementForOrg(null), ENTITLEMENT.FULL);
  });
});

describe('dunning grace is for customers who have paid', () => {
  // Stripe reports a paused trial whose resumption invoice was DECLINED as
  // past_due, not paused. past_due normally grants full access on purpose —
  // the documented grace window. Extending that to an account that arrived on
  // a free trial and has never paid anything would make "decline the card" a
  // way to keep using the product indefinitely.

  test('a trial that never converted loses the grace', () => {
    assert.equal(entitlementForOrg({
      plan: 'pro', subscriptionStatus: 'past_due',
      trialOriginAt: '2026-01-01T00:00:00Z', trialConvertedAt: null,
    }), ENTITLEMENT.READ_ONLY);
  });

  test('it keys on trial ORIGIN, not on the campaign, which is nullable', () => {
    // An invite minted without a campaign is legitimate. Keying the rule on
    // trial_campaign would silently hand those orgs the grace.
    assert.equal(entitlementForOrg({
      plan: 'pro', subscriptionStatus: 'past_due',
      trialOriginAt: '2026-01-01T00:00:00Z', trialCampaign: null, trialConvertedAt: null,
    }), ENTITLEMENT.READ_ONLY);
  });

  test('a converted trial customer KEEPS the grace on a later failed renewal', () => {
    assert.equal(entitlementForOrg({
      plan: 'pro', subscriptionStatus: 'past_due',
      trialOriginAt: '2026-01-01T00:00:00Z', trialConvertedAt: '2026-02-01T00:00:00Z',
    }), ENTITLEMENT.FULL);
  });

  test('an ordinary customer who never trialed is untouched', () => {
    assert.equal(entitlementForOrg({ plan: 'pro', subscriptionStatus: 'past_due' }), ENTITLEMENT.FULL);
    assert.equal(entitlementForOrg({ plan: 'team', subscriptionStatus: 'past_due' }), ENTITLEMENT.FULL);
  });

  test('the rule touches no other status', () => {
    for (const status of ['active', 'trialing', 'paused', 'canceled']) {
      const trial = { plan: 'pro', subscriptionStatus: status, trialOriginAt: '2026-01-01T00:00:00Z', trialConvertedAt: null };
      const plain = { plan: 'pro', subscriptionStatus: status };
      assert.equal(entitlementForOrg(trial), entitlementForOrg(plain), `status ${status}`);
    }
  });
});

describe('writeAccessFor — what a blocked write is told', () => {
  test('a paused org is refused with a code that names the cause', () => {
    const access = writeAccessFor({ plan: 'pro', subscriptionStatus: 'paused' });
    assert.equal(access.allowed, false);
    assert.equal(access.code, 'SUBSCRIPTION_PAUSED');
    assert.match(access.message, /read-only/i);
    assert.match(access.message, /data is intact/i, 'says nothing was deleted');
    assert.match(access.message, /add a card/i, 'says how to fix it');
  });

  test('a trialing org may write', () => {
    assert.equal(writeAccessFor({ plan: 'pro', subscriptionStatus: 'trialing' }).allowed, true);
  });

  test('a free org may write', () => {
    assert.equal(writeAccessFor({ plan: 'free', subscriptionStatus: null }).allowed, true);
  });
});

describe('no second copy of the rule survives in services/billing.js', () => {
  // isUnlimited and hasActiveTeamPlan used to carry their own status lists.
  // These assertions pin them to THIS module's answers, so re-introducing a
  // literal status comparison in either one fails here.
  const statuses = [
    'trialing', 'active', 'past_due', 'paused', 'canceled', 'unpaid', 'incomplete', 'incomplete_expired', null,
  ];

  test('quota entitlement follows canWrite(entitlementForStatus)', () => {
    for (const status of statuses) {
      const expected = canWrite(entitlementForStatus(status));
      assert.equal(billing.isUnlimited({ plan: 'pro', subscriptionStatus: status }), expected,
        `pro/${status}`);
      assert.equal(billing.isUnlimited({ plan: 'team', subscriptionStatus: status }), expected,
        `team/${status}`);
    }
  });

  test('seat entitlement follows canRead(entitlementForStatus), for Team only', () => {
    for (const status of statuses) {
      const expected = canRead(entitlementForStatus(status));
      assert.equal(billing.hasActiveTeamPlan({ plan: 'team', subscriptionStatus: status }), expected,
        `team/${status}`);
      assert.equal(billing.hasActiveTeamPlan({ plan: 'pro', subscriptionStatus: status }), false,
        `pro never seats members (${status})`);
    }
  });

  test('the trial statuses are the two that changed, and nothing else did', () => {
    // The pre-existing rule, transcribed from git history, so a regression on
    // the paid path is visible as a failure rather than as a silent widening.
    const wasUnlimited = (s) => s === 'active' || s === 'past_due';
    for (const status of statuses) {
      const now = billing.isUnlimited({ plan: 'pro', subscriptionStatus: status });
      if (status === 'trialing') assert.equal(now, true, 'trialing is newly unlimited');
      else assert.equal(now, wasUnlimited(status), `pro/${status} is unchanged`);
    }

    const wasSeated = (s) => s === 'active' || s === 'past_due';
    for (const status of statuses) {
      const now = billing.hasActiveTeamPlan({ plan: 'team', subscriptionStatus: status });
      if (status === 'trialing' || status === 'paused') {
        assert.equal(now, true, `${status} newly seats members`);
      } else {
        assert.equal(now, wasSeated(status), `team/${status} is unchanged`);
      }
    }
  });

  test('a free plan is never unlimited, whatever the status says', () => {
    for (const status of statuses) {
      assert.equal(billing.isUnlimited({ plan: 'free', subscriptionStatus: status }), false);
    }
  });
});
