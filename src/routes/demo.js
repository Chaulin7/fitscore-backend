'use strict';

/**
 * src/routes/demo.js — demo requests from the marketing landing page.
 *
 * POST /api/demo-request  (public — no session; the landing page has no auth)
 *   { name, email, agency, note, website }
 *
 * `website` is a honeypot: humans never see the field, bots fill everything.
 * A non-empty honeypot gets the normal success response and nothing else —
 * no row, no email, no log line that could reveal the discard.
 *
 * Leads are stored first, then two Resend emails go out (notification +
 * prospect confirmation). Email failure never fails the request — the lead
 * is already in the DB and the error is logged server-side.
 */

const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { isValidEmail } = require('../services/authService');
const { insertDemoRequest } = require('../services/db');

let Resend = null;
try { ({ Resend } = require('resend')); } catch (_) { /* SDK optional until configured */ }

const router = express.Router();

function sendError(res, status, code, message, field) {
  const body = { error: message, code };
  if (field) body.field = field;
  return res.status(status).json(body);
}

// Scoped limiter for this route only (same pattern as the login/signup
// limiters in routes/auth.js): 5 submissions per hour per IP.
const demoLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many demo requests from this address. Please try again later.', code: 'RATE_LIMITED' },
});

const CAPS = { name: 120, agency: 160, note: 2000 }; // email cap (254) lives in isValidEmail

// Privacy: never store raw IPs. A salted hash is enough for abuse forensics.
function ipHash(ip) {
  const salt = process.env.IP_HASH_SALT || '';
  return crypto.createHash('sha256').update(salt + '|' + (ip || '')).digest('hex');
}

async function sendDemoEmails({ name, email, agency, note, createdAt }) {
  const from = process.env.DEMO_FROM_EMAIL || 'demo@cvsprings.com';
  const notify = process.env.DEMO_NOTIFY_EMAIL || null;
  // Prospects are invited to reply with their anonymised CVs, so replies must
  // land in a monitored inbox — the From address is send-only.
  const replyTo = process.env.REPLY_TO_EMAIL || notify || null;

  const subjectA = `Demo request — ${agency || name || email}`;
  const bodyA = [
    'New demo request from the landing page.',
    '',
    `Name:    ${name || '—'}`,
    `Email:   ${email}`,
    `Agency:  ${agency || '—'}`,
    `Note:    ${note || '—'}`,
    `At:      ${createdAt}`,
  ].join('\n');

  const subjectB = 'Demo request received';
  const bodyB = [
    'Thanks — your demo request is logged.',
    '',
    'We reply within one working day with a scheduling link for a 15-minute',
    'call. If you want us to run your own candidates live, attach your 3',
    'anonymised CVs (PDF or DOCX) and the job spec in your reply to this',
    'email.',
    '',
    'No slideshow: we run the engine in front of you, twice, so you can',
    'watch the outputs match.',
    '',
    '— CVsprings',
  ].join('\n');

  const key = process.env.RESEND_API_KEY;
  if (!key || !Resend) {
    // Local dev: no provider configured — log the would-be emails instead.
    console.log('[demo] RESEND_API_KEY unset — would send notification:', { to: notify, subject: subjectA });
    console.log(bodyA);
    console.log('[demo] would send confirmation:', { to: email, subject: subjectB, replyTo });
    return;
  }
  const resend = new Resend(key);
  if (notify) {
    await resend.emails.send({ from, to: notify, subject: subjectA, text: bodyA });
  }
  await resend.emails.send({
    from,
    to: email,
    subject: subjectB,
    text: bodyB,
    ...(replyTo ? { replyTo } : {}),
  });
}

// POST /api/demo-request
router.post('/', demoLimiter, async (req, res) => {
  try {
    const b = req.body || {};

    // Honeypot tripped: normal success body, nothing stored, nothing sent,
    // nothing logged.
    if (typeof b.website === 'string' && b.website.trim() !== '') {
      return res.json({ ok: true });
    }

    const t = (v) => (typeof v === 'string' ? v.trim() : '');
    const name = t(b.name);
    const email = t(b.email);
    const agency = t(b.agency);
    const note = t(b.note);

    if (!email || !isValidEmail(email)) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'A valid email address is required.', 'email');
    }
    if (name.length > CAPS.name) return sendError(res, 400, 'VALIDATION_ERROR', `Name is too long (max ${CAPS.name} characters).`, 'name');
    if (agency.length > CAPS.agency) return sendError(res, 400, 'VALIDATION_ERROR', `Agency is too long (max ${CAPS.agency} characters).`, 'agency');
    if (note.length > CAPS.note) return sendError(res, 400, 'VALIDATION_ERROR', `Note is too long (max ${CAPS.note} characters).`, 'note');

    // Store first — the lead survives even if email delivery fails.
    const record = insertDemoRequest({ name, email, agency, note, ipHash: ipHash(req.ip) });

    try {
      await sendDemoEmails({ name, email, agency, note, createdAt: record.createdAt });
    } catch (err) {
      console.error('[demo] email delivery failed (lead stored):', err.message);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[demo] request failed:', err.message);
    sendError(res, 500, 'INTERNAL_ERROR', 'Could not submit the request.');
  }
});

module.exports = router;
