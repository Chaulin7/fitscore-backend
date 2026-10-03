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
 * prospect confirmation). The lead is never lost: it is in the DB before any
 * email is attempted. But a failed send IS a failure: it is logged, and the
 * visitor gets 502 DEMO_EMAIL_FAILED, which the landing page words as "we saved
 * your request, but you may not receive a confirmation". Resend's SDK resolves
 * { error } instead of throwing, so both sends check it.
 */

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const rateLimit = require('express-rate-limit');
const { isValidEmail } = require('../services/authService');
const { insertDemoRequest } = require('../services/db');

// EU AI Act checklist, attached to the prospect confirmation email. Read once
// at startup; when the file is missing (dev checkouts), log clearly and send
// confirmations without the attachment rather than failing requests.
const CHECKLIST_PATH = path.join(__dirname, '..', '..', 'assets', 'CVsprings-EU-AI-Act-checklist.pdf');
let checklistPdf = null;
try {
  checklistPdf = fs.readFileSync(CHECKLIST_PATH);
} catch (_) {
  console.warn(`[demo] checklist PDF missing at ${CHECKLIST_PATH} — confirmation emails will go out without the attachment`);
}

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

function resendClient() {
  const key = process.env.RESEND_API_KEY;
  return key && Resend ? new Resend(key) : null;
}

async function sendOne(client, mail) {
  const { error } = await client.emails.send(mail);
  if (error) throw new Error(`Resend responded: ${error.name || 'error'} — ${error.message || 'unknown'}`);
}

async function sendDemoEmails({ name, email, agency, note, createdAt }, client = router.resendClient()) {
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
    ...(checklistPdf ? ['', 'Our one-page EU AI Act checklist for recruitment tooling is attached.'] : []),
    '',
    '— CVsprings',
  ].join('\n');

  if (!client) {
    // No provider: in production nothing would reach anyone, so say so.
    if (process.env.NODE_ENV === 'production') throw new Error('RESEND_API_KEY is not set');
    // Local dev: metadata only — never the lead's name, address or note.
    console.log('[demo] RESEND_API_KEY unset — would send notification + confirmation', { notify: !!notify, attachment: !!checklistPdf });
    return;
  }
  // Both are attempted even if one fails, so a notification outage does not
  // also cost the prospect their confirmation (or the other way round).
  const sends = [
    notify ? ['notification', sendOne(client, { from, to: notify, subject: subjectA, text: bodyA })] : null,
    ['confirmation', sendOne(client, {
      from,
      to: email,
      subject: subjectB,
      text: bodyB,
      ...(replyTo ? { replyTo } : {}),
      ...(checklistPdf ? { attachments: [{ filename: 'CVsprings-EU-AI-Act-checklist.pdf', content: checklistPdf }] } : {}),
    })],
  ].filter(Boolean);
  const results = await Promise.allSettled(sends.map(([, p]) => p));
  const failed = results.map((r, i) => (r.status === 'rejected' ? `${sends[i][0]}: ${r.reason && r.reason.message}` : null)).filter(Boolean);
  if (failed.length) throw new Error(failed.join('; '));
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
      await router.sendDemoEmails({ name, email, agency, note, createdAt: record.createdAt });
    } catch (err) {
      // The lead is stored; the visitor still has to hear that an email failed.
      console.error('[demo] email delivery failed (lead stored):', err.message);
      return sendError(res, 502, 'DEMO_EMAIL_FAILED', 'We saved your request, but an email could not be sent.');
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[demo] request failed:', err.message);
    sendError(res, 500, 'INTERNAL_ERROR', 'Could not submit the request.');
  }
});

// Seams for tests: swap the client (or the whole send) without a network or key.
router.resendClient = resendClient;
router.sendDemoEmails = sendDemoEmails;

module.exports = router;
