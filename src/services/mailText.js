'use strict';

/**
 * src/services/mailText.js — making user-typed text safe to put in an email.
 *
 * Moved here unchanged from routes/featureRequests.js so the contact form
 * (routes/contact.js) can use the same rules without loading that router,
 * which pulls in the database. Both routes send attacker-authored text to one
 * known human reader, so they must sanitise it the same way.
 */

// C0 and C1 controls (minus \t \n \r), DEL, and every invisible / bidi-control
// range that lets a crafted string render as something other than what is
// stored: ALM, the zero-width and directional marks, LINE/PARAGRAPH SEPARATOR,
// the embedding + isolate controls, word joiner and invisible operators, the
// deprecated format controls, BOM, interlinear annotation, and the Unicode tag
// block. Matters because title reaches an email SUBJECT line and the body
// reaches a human operator's inbox: an RLO override plus homoglyphs is a
// working spoof aimed at one known, high-value reader.
const CONTROL_OR_BIDI = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F\u061C\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u206F\uFEFF\uFFF9-\uFFFB]|[\u{E0000}-\u{E007F}]/u;
const CONTROL_OR_BIDI_G = new RegExp(CONTROL_OR_BIDI.source, 'gu');

// Collapse anything that could break out of, or visually spoof, a single header
// line. Applied to the SUBJECT copy only — never to the value being stored, so
// the DB keeps exactly what the user typed.
function headerSafe(value, max) {
  return String(value == null ? '' : value)
    .replace(CONTROL_OR_BIDI_G, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

// Body copy for the email. Newlines are legitimate here (it is multi-line free
// text), so only the invisible/bidi class is stripped. Same rule as the subject:
// sanitise the copy that is sent, never the row that is stored. Without this a
// submitter could paste an RLO override or a forged second "New feature request"
// block into the description and have it render convincingly in the inbox.
function bodySafe(value) {
  return String(value == null ? '' : value).replace(CONTROL_OR_BIDI_G, '');
}

// Deliberately stricter than authService.isValidEmail, which permits commas,
// semicolons and angle brackets. Resend accepts a string OR an array for
// replyTo, so "a,victim@partner.com" could be parsed as an address list and CC
// a reply onto a third party; "Name<attacker@evil>" renders as a display name.
// A failing address means we send with NO Reply-To rather than a malformed one.
// Not applied to isValidEmail itself — tightening that would lock out existing
// accounts.
const STRICT_EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
function safeReplyTo(email) {
  const e = typeof email === 'string' ? email.trim() : '';
  return e && e.length <= 254 && STRICT_EMAIL.test(e) ? e : null;
}

module.exports = { CONTROL_OR_BIDI, STRICT_EMAIL, headerSafe, bodySafe, safeReplyTo };
