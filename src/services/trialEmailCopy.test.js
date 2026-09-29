'use strict';

/**
 * src/services/trialEmailCopy.test.js — what the trial emails actually say.
 *
 * A customer reported the welcome email reading "No card was taken and none is
 * needed until in three days". Two faults met there: the caller passed no trial
 * end date, and the shared date formatter answered a missing date with the
 * string 'in three days' — copy belonging to the trial_will_end message, where
 * Stripe's three-day offset makes it true, leaking into a message where it is
 * both wrong and ungrammatical.
 *
 * So these tests are about the CLASS, not the sentence: no message may invent a
 * duration, and every duration printed must come from the constant that governs
 * the behaviour. Email copy is the one output nothing else checks — it is not
 * rendered in a test browser and it is not type-checked; the first reader is a
 * customer.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  composeTrialWelcome, composeTrialWillEnd, composeTrialPaused,
} = require('./trialEmail');
const { TRIAL_PERIOD_DAYS, SIGNUP_LINK_TTL_DAYS } = require('./trialInvites');

const ARGS = {
  companyName: 'CVsprings', planName: 'Pro',
  signupUrl: 'https://cvsprings.com/signup?t=tok',
  portalUrl: 'https://billing.stripe.com/p/x',
  appUrl: 'https://cvsprings.com/dashboard',
};
const WITH_DATE = '2026-10-28T09:00:00.000Z';

/** Every message, in both states: with a real date and with none. */
function everyMessage() {
  const out = [];
  for (const trialEndsAt of [WITH_DATE, null, undefined, 'not-a-date']) {
    out.push(['welcome', composeTrialWelcome({ ...ARGS, trialEndsAt }), trialEndsAt]);
    out.push(['trial_will_end', composeTrialWillEnd({ ...ARGS, trialEndsAt }), trialEndsAt]);
    out.push(['paused', composeTrialPaused({ ...ARGS, trialEndsAt }), trialEndsAt]);
  }
  return out;
}

describe('the reported bug', () => {
  test('the welcome email never says "three days"', () => {
    for (const trialEndsAt of [WITH_DATE, null, undefined, 'not-a-date']) {
      const { text, subject } = composeTrialWelcome({ ...ARGS, trialEndsAt });
      assert.equal(/three days/i.test(text), false,
        `welcome body says "three days" with trialEndsAt=${String(trialEndsAt)}`);
      assert.equal(/three days/i.test(subject), false);
    }
  });

  test('and never produces "until in", the grammar that gave it away', () => {
    for (const [kind, msg, date] of everyMessage()) {
      assert.equal(/until in\b/i.test(msg.text), false,
        `${kind} (date=${String(date)}) reads "until in"`);
    }
  });

  test('with no date it states the trial length instead of inventing one', () => {
    const { text } = composeTrialWelcome({ ...ARGS, trialEndsAt: null });
    assert.match(text, new RegExp(`none is needed for ${TRIAL_PERIOD_DAYS} days`));
  });

  test('with a date it prints that date', () => {
    const { text } = composeTrialWelcome({ ...ARGS, trialEndsAt: WITH_DATE });
    assert.match(text, /none is needed until 2026-10-28\./);
  });
});

describe('no message invents a duration', () => {
  // The trial is 30 days and the claim link lasts 14. Any OTHER day-count in
  // the copy is a number somebody typed, and a number somebody typed is a number
  // that drifts when the constant changes.
  const allowed = new Set([String(TRIAL_PERIOD_DAYS), String(SIGNUP_LINK_TTL_DAYS)]);

  test('every "N day(s)" in every message comes from a governing constant', () => {
    for (const [kind, msg, date] of everyMessage()) {
      const body = `${msg.subject}\n${msg.text}`;
      for (const m of body.matchAll(/(\d+)[- ]day/gi)) {
        assert.ok(allowed.has(m[1]),
          `${kind} (date=${String(date)}) prints "${m[0]}" — not ${TRIAL_PERIOD_DAYS} or ${SIGNUP_LINK_TTL_DAYS}`);
      }
    }
  });

  test('no message spells a duration out in words', () => {
    // 'in three days' is how the original bug read. Words dodge the digit check
    // above, so they get their own.
    const words = /\b(one|two|three|four|five|six|seven|ten|fourteen|thirty)[- ](day|days|week|weeks|month|months)\b/i;
    for (const [kind, msg, date] of everyMessage()) {
      const body = `${msg.subject}\n${msg.text}`;
      const hit = body.match(words);
      assert.equal(hit, null, `${kind} (date=${String(date)}) spells out "${hit && hit[0]}"`);
    }
  });

  test('the trial length tracks TRIAL_PERIOD_DAYS, not a literal 30', () => {
    for (const compose of [composeTrialWelcome, composeTrialWillEnd, composeTrialPaused]) {
      const { text } = compose({ ...ARGS, trialEndsAt: WITH_DATE });
      if (/\d+-day/.test(text)) {
        assert.match(text, new RegExp(`${TRIAL_PERIOD_DAYS}-day`));
      }
    }
  });

  test('the claim-link deadline tracks SIGNUP_LINK_TTL_DAYS', () => {
    const { text } = composeTrialWelcome({ ...ARGS, trialEndsAt: WITH_DATE });
    assert.match(text, new RegExp(`next ${SIGNUP_LINK_TTL_DAYS} days`));
  });
});

describe('every message is well-formed whatever it is handed', () => {
  test('no empty interpolation, no "null", no "undefined", no "NaN"', () => {
    for (const [kind, msg, date] of everyMessage()) {
      const body = `${msg.subject}\n${msg.text}`;
      for (const leak of ['undefined', 'null', 'NaN', 'Invalid Date', '[object Object]']) {
        assert.equal(body.includes(leak), false,
          `${kind} (date=${String(date)}) leaked "${leak}"`);
      }
      assert.equal(/\s{2,}\./.test(body), false, `${kind}: gap before a full stop`);
    }
  });

  test('every subject is non-empty and single-line', () => {
    for (const [kind, msg] of everyMessage()) {
      assert.ok(msg.subject.trim().length > 10, `${kind}: subject too short`);
      assert.equal(msg.subject.includes('\n'), false, `${kind}: subject spans lines`);
    }
  });

  test('the welcome email carries the claim link', () => {
    const { text } = composeTrialWelcome({ ...ARGS, trialEndsAt: WITH_DATE });
    assert.match(text, /https:\/\/cvsprings\.com\/signup\?t=tok/);
  });

  test('the paused email says the data is safe, in both states', () => {
    for (const trialEndsAt of [WITH_DATE, null]) {
      const { text } = composeTrialPaused({ ...ARGS, trialEndsAt });
      assert.match(text, /NOTHING HAS BEEN DELETED/);
    }
  });
});
