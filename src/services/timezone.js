'use strict';

/**
 * src/services/timezone.js
 *
 * DST-correct conversion between a calendar day in an IANA timezone and UTC
 * instants, using only Intl.DateTimeFormat (no date library). created_at stays
 * stored as UTC ISO; this module only interprets user-facing day boundaries and
 * formats stored UTC instants back into the org timezone for display.
 *
 * The offset is recomputed for each specific instant, so a range spanning a DST
 * transition (Europe/Amsterdam is UTC+1 in winter, UTC+2 in summer) gets the
 * right offset at each end rather than one offset for the whole range.
 */

// Offset (ms) of `timeZone` from UTC at the given UTC instant. Positive = the
// zone is ahead of UTC. Works by formatting the instant AS wall-clock time in
// the zone and diffing that against the instant.
function tzOffsetMsAt(instantMs, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  for (const part of dtf.formatToParts(new Date(instantMs))) {
    if (part.type !== 'literal') p[part.type] = part.value;
  }
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUTC - instantMs;
}

// Convert a local wall-clock time in `timeZone` to the corresponding UTC Date.
// Two-step: guess by treating the wall time as UTC, correct by the offset there,
// then re-check the offset at the corrected instant so DST edges resolve.
function zonedTimeToUtc(y, mo, d, h, mi, s, timeZone) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const off1 = tzOffsetMsAt(guess, timeZone);
  let utc = guess - off1;
  const off2 = tzOffsetMsAt(utc, timeZone);
  if (off2 !== off1) utc = guess - off2;
  return new Date(utc);
}

function parseYmd(dateStr) {
  const [y, mo, d] = String(dateStr).split('-').map(Number);
  return { y, mo, d };
}

// Start-of-day UTC instant for a calendar day in `timeZone`.
function startOfZonedDayUtc(dateStr, timeZone) {
  const { y, mo, d } = parseYmd(dateStr);
  return zonedTimeToUtc(y, mo, d, 0, 0, 0, timeZone);
}

// Inclusive end-of-day UTC instant: the last millisecond before the next local
// day begins (Date.UTC handles the day/month rollover). DST-correct because the
// next day's start is computed with its own offset.
function endOfZonedDayUtc(dateStr, timeZone) {
  const { y, mo, d } = parseYmd(dateStr);
  const nextStart = zonedTimeToUtc(y, mo, d + 1, 0, 0, 0, timeZone);
  return new Date(nextStart.getTime() - 1);
}

// True if `tz` is a usable IANA zone.
function isValidTimeZone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; }
  catch (_) { return false; }
}

// Format a UTC ISO instant as an unambiguous, offset-bearing string in the org
// timezone, e.g. "2026-10-25 02:30:00 +02:00". Used by the CSV export.
function formatInTimeZone(iso, timeZone) {
  if (!iso) return '';
  const instant = new Date(iso);
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  for (const part of dtf.formatToParts(instant)) if (part.type !== 'literal') p[part.type] = part.value;
  const offMin = Math.round(tzOffsetMsAt(instant.getTime(), timeZone) / 60000);
  const sign = offMin >= 0 ? '+' : '-';
  const ab = Math.abs(offMin);
  const off = sign + String(Math.floor(ab / 60)).padStart(2, '0') + ':' + String(ab % 60).padStart(2, '0');
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second} ${off}`;
}

module.exports = {
  tzOffsetMsAt,
  zonedTimeToUtc,
  startOfZonedDayUtc,
  endOfZonedDayUtc,
  isValidTimeZone,
  formatInTimeZone,
};
