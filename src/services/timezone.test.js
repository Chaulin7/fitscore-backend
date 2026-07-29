'use strict';

/**
 * src/services/timezone.test.js
 *
 * DST-correct day-boundary conversion for Europe/Amsterdam (UTC+1 winter,
 * UTC+2 summer), computed with Intl only. Uses the Node.js built-in test runner.
 *
 * Covers (TESTS): DST boundary correctness in both directions (March spring-
 * forward and October fall-back), including a range that spans each transition
 * so the offset is proven to be computed per-date, not once for the range.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { startOfZonedDayUtc, endOfZonedDayUtc, formatInTimeZone } = require('./timezone');

const TZ = 'Europe/Amsterdam';
const startUtc = (d) => startOfZonedDayUtc(d, TZ).toISOString();
const endUtc = (d) => endOfZonedDayUtc(d, TZ).toISOString();

describe('non-transition days', () => {
  test('winter day is UTC+1', () => {
    assert.equal(startUtc('2026-01-15'), '2026-01-14T23:00:00.000Z');
    assert.equal(endUtc('2026-01-15'), '2026-01-15T22:59:59.999Z');
  });
  test('summer day is UTC+2', () => {
    assert.equal(startUtc('2026-07-15'), '2026-07-14T22:00:00.000Z');
    assert.equal(endUtc('2026-07-15'), '2026-07-15T21:59:59.999Z');
  });
});

describe('March transition (spring forward, +1 -> +2)', () => {
  test('the 23-hour transition day has the right bounds', () => {
    // 2026-03-29: clocks jump 02:00 CET -> 03:00 CEST.
    assert.equal(startUtc('2026-03-29'), '2026-03-28T23:00:00.000Z'); // still +1 at midnight
    assert.equal(endUtc('2026-03-29'), '2026-03-29T21:59:59.999Z');   // next day starts +2 at 22:00Z
  });
  test('a range spanning the transition uses each end\'s own offset', () => {
    // from 2026-03-28 (+1) .. to 2026-03-30 (+2): offsets differ across the range.
    assert.equal(startUtc('2026-03-28'), '2026-03-27T23:00:00.000Z');
    assert.equal(endUtc('2026-03-30'), '2026-03-30T21:59:59.999Z');
    // Prove the per-date offset actually changed (not computed once).
    const startOffH = (Date.parse('2026-03-28T00:00:00Z') - Date.parse(startUtc('2026-03-28'))) / 3600000;
    const endStartOffH = (Date.parse('2026-03-30T00:00:00Z') - Date.parse(startUtc('2026-03-30'))) / 3600000;
    assert.equal(startOffH, 1);
    assert.equal(endStartOffH, 2);
  });
});

describe('October transition (fall back, +2 -> +1)', () => {
  test('the 25-hour transition day has the right bounds', () => {
    // 2026-10-25: clocks fall 03:00 CEST -> 02:00 CET.
    assert.equal(startUtc('2026-10-25'), '2026-10-24T22:00:00.000Z'); // still +2 at midnight
    assert.equal(endUtc('2026-10-25'), '2026-10-25T22:59:59.999Z');   // next day starts +1 at 23:00Z
  });
  test('a range spanning the transition uses each end\'s own offset', () => {
    assert.equal(startUtc('2026-10-24'), '2026-10-23T22:00:00.000Z'); // +2
    assert.equal(endUtc('2026-10-26'), '2026-10-26T22:59:59.999Z');   // +1 side
  });
});

describe('formatInTimeZone', () => {
  test('renders the org-local wall time with the correct offset', () => {
    assert.equal(formatInTimeZone('2026-01-19T23:30:00.000Z', TZ), '2026-01-20 00:30:00 +01:00');
    assert.equal(formatInTimeZone('2026-07-01T12:00:00.000Z', TZ), '2026-07-01 14:00:00 +02:00');
  });
});
