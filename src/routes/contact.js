'use strict';

/**
 * src/routes/contact.js — the general contact form on /contact.
 *
 * POST /api/contact  (public — no session; anyone may write to us)
 *   { name, email, message, lang, website }
 *
 * There is no consent field: the legal basis is legitimate interest or
 * contract (Privacy Policy, section C), and the form says so in a notice line.
 * Pages served before that change send `consent: true`; it is ignored, so a
 * visitor with such a page still gets through.
 *
 * The Impressum's second contact channel, next to the email address it
 * publishes, so it delivers to that same inbox: CONTACT_EMAIL in
 * src/config/legal.js. Reply-To is the sender, so answering is just "Reply".
 *
 * NOTHING IS STORED. The demo form keeps a lead row; this one keeps nothing.
 * A message exists only as the email it becomes: no table, no row, and no log
 * line carrying its content or the sender's address. The consequence is the
 * opposite failure rule to routes/demo.js and routes/featureRequests.js: there
 * is no row to fall back on, so a message that could not be delivered is an
 * error the sender sees (503 CONTACT_UNAVAILABLE, with the address to write to
 * instead), never a quiet 200.
 *
 * Shared with routes/demo.js: the scoped per-IP limiter (5 an hour) and the
 * `website` honeypot, which gets the normal success body and nothing else — no
 * email, no log line that could reveal the discard. Shared with
 * routes/featureRequests.js: the subject/body sanitisers and the strict
 * Reply-To check (services/mailText.js).
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const { CONTACT_EMAIL } = require('../config/legal');
const { headerSafe, bodySafe, safeReplyTo } = require('../services/mailText');
const { SUPPORTED } = require('../../public/i18n.js');

let Resend = null;
try { ({ Resend } = require('resend')); } catch (_) { /* SDK optional until configured */ }

const router = express.Router();

function sendError(res, status, code, message, field, detail) {
  const body = { error: message, code };
  if (field) body.field = field;
  if (detail && detail.reason) body.reason = detail.reason;
  if (detail && detail.params) body.params = detail.params;
  return res.status(status).json(body);
}

const NAME_MAX = 120;
const MESSAGE_MAX = 5000;
const DEFAULT_FROM = 'contact@cvsprings.com';

// Same shape as the demo limiter: 5 submissions an hour per IP, honeypot hits
// and invalid submissions included, so a bot cannot probe the form for free.
// The reason lets the page say "try again later" rather than the generic
// "wait a moment", which is wrong for an hour-long window.
const contactLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many messages from this address. Please try again later.', code: 'RATE_LIMITED', reason: 'CONTACT_LIMIT' },
});

/**
 * Compose the email. Pure and exported for the injection tests. Plain text
 * only, like every sender in this repo: the message is attacker-authored.
 */
function buildContactEmail({ name, email, message, lang, receivedAt }) {
  const subject = `[Contact] ${headerSafe(name, 80) || 'Website visitor'}`;
  const text = [
    'New message from the contact form on the CVsprings website.',
    '',
    `Name:     ${headerSafe(name, NAME_MAX)}`,
    `Email:    ${headerSafe(email, 254)}`,
    `Language: ${headerSafe(lang, 8) || '—'}`,
    `At:       ${headerSafe(receivedAt, 40)}`,
    '',
    'Message:',
    bodySafe(message),
    '',
    'Reply to this email to answer the sender directly.',
  ].join('\n');
  return { subject, text, replyTo: safeReplyTo(email) };
}

async function deliverViaResend(mail) {
  const key = process.env.RESEND_API_KEY;
  if (!key || !Resend) {
    // Nothing is stored, so in production an unconfigured sender would lose
    // every message behind a success screen. Fail instead.
    if (process.env.NODE_ENV === 'production') throw new Error('RESEND_API_KEY is not set');
    // Local dev: metadata only. Never the message, never the sender's address.
    console.log('[contact] RESEND_API_KEY unset — would deliver', { to: mail.to, chars: mail.text.length });
    return;
  }
  const { error } = await new Resend(key).emails.send(mail);
  // The SDK resolves { data, error } instead of throwing on an API error.
  if (error) throw new Error(`Resend responded: ${error.name || 'error'} — ${error.message || 'unknown'}`);
}

async function sendContactEmail(payload) {
  const { subject, text, replyTo } = buildContactEmail(payload);
  return router.deliver({
    // Its own sender, like feature requests: this route mails text a stranger
    // wrote, and a spam complaint should not land on the password-reset sender.
    from: process.env.CONTACT_FROM_EMAIL || DEFAULT_FROM,
    to: CONTACT_EMAIL,
    subject,
    text,
    // camelCase is the SDK's field; a one-element array so a comma can never
    // turn the address into a list. Validation below guarantees it is set.
    replyTo: [replyTo],
  });
}

/**
 * The one boot-log line src/index.js prints when the contact form cannot
 * deliver as configured, or null when it can. A misconfigured deploy must be
 * obvious in the Render logs before the first visitor finds out. It names the
 * missing variables and what that means; it never prints a value.
 */
function configWarning(env = process.env) {
  const missing = [];
  const effects = [];
  if (!env.RESEND_API_KEY) {
    missing.push('RESEND_API_KEY');
    effects.push(env.NODE_ENV === 'production'
      ? 'every message is refused with 503 CONTACT_UNAVAILABLE'
      : 'messages are logged as metadata, not sent');
  }
  if (!env.CONTACT_FROM_EMAIL) {
    missing.push('CONTACT_FROM_EMAIL');
    effects.push(`sending from the default ${DEFAULT_FROM}, which must be a Resend-verified sender`);
  }
  if (!missing.length) return null;
  return `[contact] contact form not fully configured: ${missing.join(' and ')} not set — ${effects.join('; ')}.`;
}

// POST /api/contact
router.post('/', contactLimiter, async (req, res) => {
  try {
    const b = req.body || {};

    // Honeypot tripped: normal success body; nothing sent, nothing logged.
    if (typeof b.website === 'string' && b.website.trim() !== '') {
      return res.json({ ok: true });
    }

    const t = (v) => (typeof v === 'string' ? v.trim() : '');
    const name = t(b.name);
    const email = t(b.email);
    const message = t(b.message).replace(/\r\n/g, '\n');
    const lang = SUPPORTED.includes(b.lang) ? b.lang : null;

    // `name` with reason REQUIRED would pick up errors.VALIDATION_ERROR.name.REQUIRED,
    // which is the template form's sentence ("Give the template a name."), so the
    // contact form's name errors carry reasons of their own.
    if (!name) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Please enter your name.', 'name', { reason: 'NAME_REQUIRED' });
    }
    if (name.length > NAME_MAX) {
      return sendError(res, 400, 'VALIDATION_ERROR', `Your name is too long (max ${NAME_MAX} characters).`, 'name',
        { reason: 'NAME_TOO_LONG', params: { max: NAME_MAX } });
    }
    // The strict check, not authService.isValidEmail: the address becomes the
    // Reply-To, and a reply is the only way the sender ever hears back.
    if (!safeReplyTo(email)) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'A valid email address is required.', 'email');
    }
    if (!message) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Please write a message.', 'message', { reason: 'REQUIRED' });
    }
    if (message.length > MESSAGE_MAX) {
      return sendError(res, 400, 'VALIDATION_ERROR', `Your message is too long (max ${MESSAGE_MAX} characters).`, 'message',
        { reason: 'TOO_LONG', params: { max: MESSAGE_MAX } });
    }
    try {
      await sendContactEmail({ name, email, message, lang, receivedAt: new Date().toISOString() });
    } catch (err) {
      console.error('[contact] delivery failed:', err.message);
      return sendError(res, 503, 'CONTACT_UNAVAILABLE', `Your message could not be sent. Please email ${CONTACT_EMAIL} instead.`, null,
        { params: { email: CONTACT_EMAIL } });
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error('[contact] request failed:', err.message);
    return sendError(res, 500, 'INTERNAL_ERROR', 'Could not send the message.');
  }
});

// Assigned to the router so tests can swap delivery without a network or an
// API key, and so the real handler always calls through the same seam.
router.deliver = deliverViaResend;

module.exports = router;
module.exports.buildContactEmail = buildContactEmail;
module.exports.configWarning = configWarning;
module.exports.NAME_MAX = NAME_MAX;
module.exports.MESSAGE_MAX = MESSAGE_MAX;
