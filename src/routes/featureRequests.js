'use strict';

/**
 * src/routes/featureRequests.js — in-product "Suggest an improvement".
 *
 * POST /api/feature-requests  (authenticated, Pro/Team only)
 *   { category: 'product'|'website'|'other', title, body }
 *
 * The stored row is the source of truth. The notification email to the product
 * inbox is a side effect: if Resend fails, the row stays, the failure is logged,
 * and the caller still gets 201. Losing a customer's suggestion because an
 * email provider had a bad minute would be the worse failure.
 *
 * Reply-To is the SUBMITTING USER, which is what makes this a two-way channel —
 * hitting Reply in the product inbox reaches the customer directly. The From
 * address stays a verified send-only sender; the human identity travels in
 * Reply-To only.
 *
 * Everything that identifies the submitter (org, user email, plan) is derived
 * server-side from the session. Nothing in the request body is trusted for it.
 */

const express = require('express');
const {
  createFeatureRequestIfUnderQuota,
  FEATURE_REQUEST_CATEGORIES,
  FEATURE_REQUEST_MAX_PER_WINDOW,
  getOrgBilling,
} = require('../services/db');
const { getOrganizationById } = require('../services/authService');
const billing = require('../services/billing');

let Resend = null;
try { ({ Resend } = require('resend')); } catch (_) { /* SDK optional until configured */ }

const router = express.Router();

// Same envelope every other router in this codebase produces.
function sendError(res, status, code, message, field) {
  const body = { error: message, code };
  if (field) body.field = field;
  return res.status(status).json(body);
}

const TITLE_MIN = 3;
const TITLE_MAX = 120;
const BODY_MIN = 10;
const BODY_MAX = 4000;

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

/**
 * Compose the notification. Pure and exported so the adversarial cases (bidi
 * overrides, embedded CRLF, a megabyte-long org name) are testable without a DB
 * or a network.
 *
 * Plain text only, no `html` field — every sender in this repo is text-only,
 * and it removes the whole escaping burden plus tracking pixels and deceptive
 * anchor text from attacker-authored content.
 */
function buildFeatureRequestEmail({ category, title, body, planTier, userEmail, orgName, orgId, createdAt }) {
  const subject = `[Feature Request] ${headerSafe(title, TITLE_MAX)} — ${headerSafe(orgName, 80) || 'Unknown org'} (${headerSafe(planTier, 16) || 'unknown'})`;
  // EVERY interpolated value is sanitised, not just the free-text ones: orgName
  // is unbounded and uncontrolled (createOrganization only trims), and the
  // single-line metadata fields must stay single-line or a submitter could forge
  // extra header rows in the operator's view.
  const text = [
    'New feature request submitted from inside the app.',
    '',
    `Category: ${headerSafe(category, 32)}`,
    `Org:      ${headerSafe(orgName, 120) || '—'} (${headerSafe(orgId, 64) || '—'})`,
    `User:     ${headerSafe(userEmail, 254) || '—'}`,
    `Plan:     ${headerSafe(planTier, 16) || '—'}`,
    `At:       ${headerSafe(createdAt, 40)}`,
    '',
    'Title:',
    bodySafe(title),
    '',
    'Description:',
    bodySafe(body),
    '',
    'Reply to this email to answer the submitter directly.',
  ].join('\n');

  const replyTo = safeReplyTo(userEmail);
  return { subject, text, replyTo };
}

async function sendFeatureRequestEmail(payload) {
  // A distinct From, not the shared EMAIL_FROM used by password resets and team
  // invites: this route carries customer-authored content, and a spam complaint
  // against the shared sender would degrade deliverability for password resets.
  const from = process.env.FEATURE_REQUEST_FROM_EMAIL || 'feature-requests@cvsprings.com';
  const to = process.env.FEATURE_REQUEST_NOTIFY_EMAIL || 'jasper@cvsprings.com';
  const { subject, text, replyTo } = buildFeatureRequestEmail(payload);

  const key = process.env.RESEND_API_KEY;
  if (!key || !Resend) {
    // Local dev / unconfigured deploy. Metadata only: demo.js logs its whole
    // composed body, which here would put up to 4000 chars of customer text and
    // an email address into the Render log stream, and let newlines forge
    // convincing fake log lines.
    console.log('[feature-request] RESEND_API_KEY unset — would notify', {
      to, orgId: payload.orgId, category: payload.category, replyTo: replyTo ? 'set' : 'dropped',
    });
    return;
  }

  const resend = new Resend(key);
  const { error } = await resend.emails.send({
    from,
    to,
    subject,
    text,
    // camelCase is the SDK's contract. The raw-fetch senders in auth.js/team.js
    // use snake_case `reply_to` on the wire — mixing them silently drops the
    // field with a 200 response and no error, which would kill the reply channel
    // this feature exists for. Single-element array so a comma inside the
    // address can never be reinterpreted as an address separator.
    ...(replyTo ? { replyTo: [replyTo] } : {}),
  });
  // The SDK RESOLVES { data, error } rather than throwing on an API error, so an
  // unchecked call fails silently (demo.js has this bug). Throw so the caller
  // logs it — the row is already committed and the response is still 201.
  if (error) throw new Error(`Resend responded: ${error.name || 'error'} — ${error.message || 'unknown'}`);
}

// Pro/Team gate. Reuses billing.isUnlimited — the same predicate the analysis
// quota uses (plan pro|team AND subscription active|past_due), so branding,
// quota and this feature can never disagree about who has paid.
// NOT hasActiveTeamPlan, which is Team-only and would lock Pro out.
// Runs before validation so a Free org gets the upsell code whatever it typed.
function requirePaidPlan(req, res, next) {
  if (!billing.isUnlimited(getOrgBilling(req.orgId))) {
    return sendError(res, 403, 'PAID_PLAN_REQUIRED',
      'Feature requests are available on the Pro and Team plans.');
  }
  return next();
}

// POST /api/feature-requests
router.post('/', requirePaidPlan, async (req, res) => {
  try {
    const b = req.body || {};
    const t = (v) => (typeof v === 'string' ? v.trim() : '');
    const category = t(b.category);
    const title = t(b.title);
    // Normalise line endings so a CRLF-typed body measures and stores the same
    // as an LF one; NFC so stored text is stable for later search/dedup.
    const body = t(b.body).replace(/\r\n/g, '\n').normalize('NFC');

    if (!FEATURE_REQUEST_CATEGORIES.includes(category)) {
      return sendError(res, 400, 'VALIDATION_ERROR',
        `Category must be one of: ${FEATURE_REQUEST_CATEGORIES.join(', ')}.`, 'category');
    }
    // Reject rather than silently strip: a legitimate title has no reason to
    // contain a newline or a bidi override, and stripping would hide the attempt
    // while leaving the inbox subject different from the stored row.
    if (CONTROL_OR_BIDI.test(title) || /[\r\n\t]/.test(title)) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Title contains invalid characters.', 'title');
    }
    if (title.length < TITLE_MIN || title.length > TITLE_MAX) {
      return sendError(res, 400, 'VALIDATION_ERROR',
        `Title must be between ${TITLE_MIN} and ${TITLE_MAX} characters.`, 'title');
    }
    if (body.length < BODY_MIN || body.length > BODY_MAX) {
      return sendError(res, 400, 'VALIDATION_ERROR',
        `Description must be between ${BODY_MIN} and ${BODY_MAX} characters.`, 'body');
    }

    // Identity is server-derived. Anything the client sent for orgId, email or
    // plan is ignored outright.
    const orgId = req.orgId;
    const userEmail = (req.user && req.user.email) || null;
    const orgBilling = getOrgBilling(orgId);
    const planTier = (orgBilling && orgBilling.plan) || 'free';

    // Quota and insert in one transaction: validated input only, so garbage can
    // never burn a slot, and the check cannot race the write.
    const result = createFeatureRequestIfUnderQuota({ orgId, userEmail, category, title, body, planTier });
    if (!result.ok) {
      res.set('Retry-After', String(result.retryAfterSec));
      // Deliberately does not name which member used the quota — in a Team org
      // that would leak who submitted what to a colleague.
      return res.status(429).json({
        error: `Your organization has reached the limit of ${FEATURE_REQUEST_MAX_PER_WINDOW} feature requests per 24 hours. Please try again later.`,
        code: 'RATE_LIMITED',
        retryAfter: result.retryAfterSec,
      });
    }

    let orgName = null;
    try { orgName = (getOrganizationById(orgId) || {}).name || null; } catch (_) { /* name is cosmetic */ }

    try {
      await router.sendFeatureRequestEmail({
        category, title, body, planTier, userEmail, orgName, orgId,
        createdAt: result.row.createdAt,
      });
    } catch (err) {
      // Row is already committed — the submission is not lost.
      console.error('[feature-request] notification failed (request stored):', err.message);
    }

    return res.status(201).json({ ok: true, id: result.row.id, createdAt: result.row.createdAt });
  } catch (err) {
    // Log detail server-side, return a generic message — err.message can carry
    // SQLite internals and file paths.
    console.error('[feature-request] submission failed:', err.message);
    return sendError(res, 500, 'INTERNAL_ERROR', 'Could not submit the feature request.');
  }
});

// Assigned to the router so tests can swap the mailer without a network or an
// API key, and so the real handler always calls through the same seam.
router.sendFeatureRequestEmail = sendFeatureRequestEmail;

module.exports = router;
module.exports.buildFeatureRequestEmail = buildFeatureRequestEmail;
module.exports.safeReplyTo = safeReplyTo;
module.exports.headerSafe = headerSafe;
module.exports.bodySafe = bodySafe;
