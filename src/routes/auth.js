'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const { requireSession } = require('../middleware/auth');
const auth = require('../services/authService');
const { getDb } = require('../services/db');

const router = express.Router();

function sendError(res, status, code, message, field) {
  const body = { error: message };
  if (code) body.code = code;
  if (field) body.field = field;
  return res.status(status).json(body);
}

// Builds the session payload returned by signup and login (token shown once).
function sessionResponse(rawToken, user, org) {
  return {
    sessionToken: rawToken,
    user: { email: user.email, orgId: user.org_id, role: user.role },
    org: { name: org ? org.name : null },
  };
}

// --- Rate limiters -----------------------------------------------------------

// Max 10 login attempts per IP per 15 minutes.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    const retryAfter = 15 * 60;
    res.set('Retry-After', String(retryAfter));
    res.status(429).json({ error: 'Too many login attempts. Please try again later.', code: 'RATE_LIMITED', retryAfter });
  },
});

// Max 5 signups per IP per hour.
const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    const retryAfter = 60 * 60;
    res.set('Retry-After', String(retryAfter));
    res.status(429).json({ error: 'Too many sign-up attempts. Please try again later.', code: 'RATE_LIMITED', retryAfter });
  },
});

// Max 3 reset requests per email per hour (in-memory sliding window).
const resetRequestLog = new Map(); // email -> [timestamps]
function resetRateLimited(email) {
  const now = Date.now();
  const windowMs = 60 * 60 * 1000;
  const entries = (resetRequestLog.get(email) || []).filter((t) => now - t < windowMs);
  if (entries.length >= 3) { resetRequestLog.set(email, entries); return true; }
  entries.push(now);
  resetRequestLog.set(email, entries);
  if (resetRequestLog.size > 5000) {
    for (const [k, v] of resetRequestLog) { if (!v.some((t) => now - t < windowMs)) resetRequestLog.delete(k); }
  }
  return false;
}

// --- Reset email delivery ------------------------------------------------------

async function deliverResetLink(email, resetLink) {
  const resendKey = process.env.RESEND_API_KEY;
  if (resendKey) {
    const from = process.env.EMAIL_FROM || 'no-reply@cvsprings.com';
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from,
        to: [email],
        subject: 'Reset your CVsprings password',
        text: `We received a request to reset your CVsprings password.\n\nReset it here (link valid for 30 minutes):\n${resetLink}\n\nIf you didn't request this, you can ignore this email.`,
      }),
    });
    if (!resp.ok) throw new Error(`Resend API responded ${resp.status}`);
    return;
  }
  // No email provider configured — dev fallback. Log the link (never the password).
  console.log(`[auth] Password reset link for ${email}: ${resetLink}`);
}

// --- POST /api/auth/signup ------------------------------------------------------

router.post('/signup', signupLimiter, async (req, res) => {
  try {
    const { email, password, orgName } = req.body || {};
    const normEmail = auth.normalizeEmail(email);
    if (!normEmail || !auth.isValidEmail(normEmail)) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'A valid email address is required.', 'email');
    }
    const pwError = auth.validatePassword(password);
    if (pwError) return sendError(res, 400, 'VALIDATION_ERROR', pwError, 'password');

    if (auth.findUserByEmail(normEmail)) {
      return sendError(res, 409, 'EMAIL_TAKEN', 'An account with this email already exists');
    }

    const passwordHash = await auth.hashPassword(password);
    const org = auth.createOrganization(orgName || 'My Organization');
    let user;
    try {
      user = auth.createUser({ email: normEmail, passwordHash, orgId: org.id, role: 'owner' });
    } catch (err) {
      // UNIQUE constraint race: another signup with the same email won
      if (/UNIQUE/i.test(err.message)) {
        return sendError(res, 409, 'EMAIL_TAKEN', 'An account with this email already exists');
      }
      throw err;
    }
    auth.recordLoginSuccess(user);
    const { rawToken } = auth.createSession(user.id);
    return res.status(201).json(sessionResponse(rawToken, user, org));
  } catch (err) {
    return sendError(res, 500, 'INTERNAL_ERROR', 'Could not create the account.');
  }
});

// --- POST /api/auth/login -------------------------------------------------------

router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const genericFail = () => sendError(res, 401, 'INVALID_CREDENTIALS', 'Invalid email or password');

    const user = auth.findUserByEmail(email);
    if (!user || typeof password !== 'string' || !password) {
      // Burn comparable time so missing accounts are not distinguishable by timing
      await auth.verifyPassword('invalid-password-timing-equalizer', '$2a$12$C6UzMDM.H6dfI/f/IKcEeO7ZUbE0fWY6patgK8j8zSGpA0d6P7yqa');
      return genericFail();
    }
    if (auth.isLocked(user)) return genericFail();

    const ok = await auth.verifyPassword(password, user.password_hash);
    if (!ok) {
      auth.recordLoginFailure(user);
      return genericFail();
    }

    auth.recordLoginSuccess(user);
    const { rawToken } = auth.createSession(user.id);
    const org = auth.getOrganizationById(user.org_id);
    return res.json(sessionResponse(rawToken, user, org));
  } catch (err) {
    // Log the real error (pino err serializer: message+stack only — never the
    // request body or credentials); the client response stays generic.
    req.log.error({ err }, 'login failed');
    return sendError(res, 500, 'INTERNAL_ERROR', 'Login failed.');
  }
});

// --- POST /api/auth/logout ------------------------------------------------------

router.post('/logout', requireSession, (req, res) => {
  auth.deleteSession(req.sessionId);
  res.json({ ok: true });
});

// --- GET /api/auth/me -----------------------------------------------------------

router.get('/me', requireSession, (req, res) => {
  const org = auth.getOrganizationById(req.orgId);
  const branding = auth.getOrganizationBranding(req.orgId);
  res.json({
    user: { email: req.user.email, orgId: req.orgId, role: req.user.role },
    org: { name: org ? org.name : null, retentionDays: org ? org.retentionDays : null, branding },
  });
});

// --- POST /api/auth/change-password ----------------------------------------------

router.post('/change-password', requireSession, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    const user = auth.findUserById(req.userId);
    if (!user) return sendError(res, 401, 'AUTH_REQUIRED', 'Unauthorized');

    const ok = typeof currentPassword === 'string' && await auth.verifyPassword(currentPassword, user.password_hash);
    if (!ok) return sendError(res, 400, 'VALIDATION_ERROR', 'Current password is incorrect.', 'currentPassword');

    const pwError = auth.validatePassword(newPassword);
    if (pwError) return sendError(res, 400, 'VALIDATION_ERROR', pwError, 'newPassword');

    auth.setUserPassword(user.id, await auth.hashPassword(newPassword));
    // Keep this session alive; kill every other one for the user.
    auth.deleteSessionsForUser(user.id, req.sessionId);
    res.json({ ok: true });
  } catch (err) {
    return sendError(res, 500, 'INTERNAL_ERROR', 'Could not change the password.');
  }
});

// --- POST /api/auth/request-reset -------------------------------------------------
// Always returns 200 { ok: true } — no account enumeration.

router.post('/request-reset', async (req, res) => {
  const respond = () => res.json({ ok: true });
  try {
    const email = auth.normalizeEmail((req.body || {}).email);
    if (!email || !auth.isValidEmail(email)) return respond();
    if (resetRateLimited(email)) return respond();

    const user = auth.findUserByEmail(email);
    if (!user) return respond();

    const rawToken = auth.createPasswordReset(user.id);
    const base = (process.env.FRONTEND_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
    const resetLink = `${base}/?reset_token=${rawToken}`;
    try {
      await deliverResetLink(email, resetLink);
    } catch (err) {
      console.error('[auth] Failed to send reset email:', err.message);
    }
    return respond();
  } catch (_) {
    return respond();
  }
});

// --- POST /api/auth/reset-password -------------------------------------------------

router.post('/reset-password', async (req, res) => {
  try {
    const { token, newPassword } = req.body || {};
    const reset = auth.findValidPasswordReset(token);
    if (!reset) return sendError(res, 400, 'INVALID_RESET_TOKEN', 'This reset link is invalid or has expired.');

    const pwError = auth.validatePassword(newPassword);
    if (pwError) return sendError(res, 400, 'VALIDATION_ERROR', pwError, 'newPassword');

    auth.setUserPassword(reset.user_id, await auth.hashPassword(newPassword));
    auth.markPasswordResetUsed(reset.id);
    // Unlock the account and invalidate every existing session.
    getDb().prepare('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?').run(reset.user_id);
    auth.deleteSessionsForUser(reset.user_id);
    res.json({ ok: true });
  } catch (err) {
    return sendError(res, 500, 'INTERNAL_ERROR', 'Could not reset the password.');
  }
});

// --- POST /api/auth/download-token --------------------------------------------------
// Single-use token (60s) for browser-opened report/CSV URLs.

router.post('/download-token', requireSession, (req, res) => {
  const token = auth.createDownloadToken({ orgId: req.orgId, userId: req.userId });
  res.json({ token, expiresIn: 60 });
});

module.exports = router;
