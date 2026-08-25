'use strict';

/**
 * src/routes/team.js — team members & invitations.
 *
 * Only orgs on an ACTIVE Team plan may have more than one active user; Free/
 * Pro stay owner-only. Plan + seat limits are enforced server-side at invite,
 * at acceptance, and on every member request (see middleware/auth.js). Invites
 * work without an email provider via a copyable link; email is an enhancement.
 *
 * Attribution: audit reviewedBy and change-history changedBy are email
 * snapshots, so removing a user never breaks the audit trail.
 */

const express = require('express');
const { requireSession } = require('../middleware/auth');
const auth = require('../services/authService');
const billing = require('../services/billing');
const { getOrgBilling } = require('../services/db');
const { baseUrlFor } = require('../config/appUrl');

const router = express.Router();

// Seat cap (0 = unlimited). Defined in services/billing.js next to the seat
// gate itself, so the capacity enforced here is the capacity the plan panel
// advertises — one number, not two that can drift.
const { TEAM_MAX_MEMBERS } = billing;

function sendError(res, status, code, message, field) {
  const body = { error: message, code };
  if (field) body.field = field;
  return res.status(status).json(body);
}

function requireOwner(req, res, next) {
  const user = auth.findUserById(req.userId);
  if (!user || user.org_id !== req.orgId || user.role !== 'owner') {
    return sendError(res, 403, 'OWNER_REQUIRED', 'Only the organization owner can manage the team.');
  }
  return next();
}

function orgHasTeamPlan(orgId) {
  return billing.hasActiveTeamPlan(getOrgBilling(orgId));
}

// Capacity: TEAM_MAX_MEMBERS active users (0 = unlimited).
function atSeatLimit(orgId) {
  if (!TEAM_MAX_MEMBERS) return false;
  return auth.countOrgUsers(orgId) >= TEAM_MAX_MEMBERS;
}

// Invite links go in emails, so they must carry the public origin. Resolved by
// the one shared helper (src/config/appUrl.js).
const appBaseUrl = baseUrlFor;

async function deliverInviteEmail(email, orgName, inviteUrl) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return false; // no provider — caller relies on the copyable link
  const from = process.env.EMAIL_FROM || 'no-reply@cvsprings.com';
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      to: [email],
      subject: `You've been invited to join ${orgName || 'a team'} on CVsprings`,
      text: `You've been invited to join ${orgName || 'a team'} on CVsprings.\n\nAccept the invitation and set your password here (link valid for 7 days):\n${inviteUrl}\n\nIf you weren't expecting this, you can ignore this email.`,
    }),
  });
  if (!resp.ok) throw new Error(`Email provider responded ${resp.status}`);
  return true;
}

function sessionResponse(rawToken, user, org) {
  return {
    sessionToken: rawToken,
    user: { email: user.email, orgId: user.org_id, role: user.role },
    org: { name: org ? org.name : null },
  };
}

// --- POST /api/team/invite (owner) ------------------------------------------
router.post('/invite', requireSession, requireOwner, async (req, res) => {
  try {
    if (!orgHasTeamPlan(req.orgId)) {
      return sendError(res, 403, 'TEAM_PLAN_REQUIRED', 'Inviting members requires an active Team plan.');
    }
    if (atSeatLimit(req.orgId)) {
      return sendError(res, 403, 'SEAT_LIMIT', `Your plan is limited to ${TEAM_MAX_MEMBERS} members.`);
    }
    const email = auth.normalizeEmail((req.body || {}).email);
    if (!email || !auth.isValidEmail(email)) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'A valid email address is required.', 'email');
    }
    if (auth.findUserByEmail(email)) {
      return sendError(res, 409, 'EMAIL_TAKEN', 'A user with this email already exists.');
    }
    const rawToken = auth.createOrRefreshInvite({ orgId: req.orgId, email, invitedBy: req.userId });
    const inviteUrl = `${appBaseUrl(req)}/?invite=${rawToken}`;
    let emailed = false;
    try {
      const org = auth.getOrganizationById(req.orgId);
      emailed = await deliverInviteEmail(email, org ? org.name : null, inviteUrl);
    } catch (err) {
      console.error('[team] invite email failed:', err.message); // link still returned
    }
    res.status(201).json({ inviteUrl, emailed, email });
  } catch (err) {
    sendError(res, 500, 'INTERNAL_ERROR', 'Could not create the invite.');
  }
});

// --- GET /api/team/invites (owner) ------------------------------------------
router.get('/invites', requireSession, requireOwner, (req, res) => {
  try {
    res.json(auth.listPendingInvites(req.orgId));
  } catch (err) {
    sendError(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// --- DELETE /api/team/invite/:id (owner) ------------------------------------
router.delete('/invite/:id', requireSession, requireOwner, (req, res) => {
  try {
    const ok = auth.revokeInvite(req.orgId, req.params.id);
    if (!ok) return sendError(res, 404, 'NOT_FOUND', 'Invite not found or already used.');
    res.json({ ok: true });
  } catch (err) {
    sendError(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// --- POST /api/team/accept (PUBLIC) -----------------------------------------
router.post('/accept', async (req, res) => {
  try {
    const { token, password } = req.body || {};
    const invite = auth.findValidInvite(token);
    if (!invite) return sendError(res, 400, 'INVALID_INVITE', 'This invitation is invalid, expired, or already used.');

    // Re-check plan + capacity at acceptance (may have changed since invite).
    if (!orgHasTeamPlan(invite.org_id)) {
      return sendError(res, 403, 'TEAM_PLAN_REQUIRED', 'This organization no longer has an active Team plan.');
    }
    if (atSeatLimit(invite.org_id)) {
      return sendError(res, 403, 'SEAT_LIMIT', 'This organization has reached its member limit.');
    }
    const pwError = auth.validatePassword(password);
    if (pwError) return sendError(res, 400, 'VALIDATION_ERROR', pwError, 'password');
    if (auth.findUserByEmail(invite.email)) {
      return sendError(res, 409, 'EMAIL_TAKEN', 'An account with this email already exists.');
    }

    const passwordHash = await auth.hashPassword(password);
    const user = auth.createUser({ email: invite.email, passwordHash, orgId: invite.org_id, role: 'member' });
    auth.markInviteAccepted(invite.id);
    auth.recordLoginSuccess(user);
    const { rawToken } = auth.createSession(user.id);
    const org = auth.getOrganizationById(invite.org_id);
    res.status(201).json(sessionResponse(rawToken, user, org));
  } catch (err) {
    if (/UNIQUE/i.test(err.message)) return sendError(res, 409, 'EMAIL_TAKEN', 'An account with this email already exists.');
    sendError(res, 500, 'INTERNAL_ERROR', 'Could not accept the invitation.');
  }
});

// --- GET /api/team/members (any member) -------------------------------------
router.get('/members', requireSession, (req, res) => {
  try {
    const org = auth.getOrganizationById(req.orgId);
    res.json({
      org: { name: org ? org.name : null, teamPlan: orgHasTeamPlan(req.orgId) },
      seatLimit: TEAM_MAX_MEMBERS || null, // additive; null = unlimited seats
      members: auth.listOrgUsers(req.orgId),
    });
  } catch (err) {
    sendError(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// --- DELETE /api/team/member/:userId (owner) --------------------------------
router.delete('/member/:userId', requireSession, requireOwner, (req, res) => {
  try {
    const target = auth.findUserById(req.params.userId);
    if (!target || target.org_id !== req.orgId) return sendError(res, 404, 'NOT_FOUND', 'Member not found.');
    if (target.id === req.userId) return sendError(res, 400, 'CANNOT_REMOVE_SELF', 'You cannot remove yourself.');
    if (target.role === 'owner' && auth.countOrgOwners(req.orgId) <= 1) {
      return sendError(res, 400, 'LAST_OWNER', 'There must be at least one owner.');
    }
    // Invalidate access but KEEP their audit attribution (reviewedBy snapshot).
    auth.deleteSessionsForUser(target.id);
    auth.deleteUser(target.id);
    res.json({ ok: true });
  } catch (err) {
    sendError(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// --- PATCH /api/team/member/:userId { role } (owner) ------------------------
router.patch('/member/:userId', requireSession, requireOwner, (req, res) => {
  try {
    const role = (req.body || {}).role;
    if (role !== 'owner' && role !== 'member') {
      return sendError(res, 400, 'VALIDATION_ERROR', "role must be 'owner' or 'member'.", 'role');
    }
    const target = auth.findUserById(req.params.userId);
    if (!target || target.org_id !== req.orgId) return sendError(res, 404, 'NOT_FOUND', 'Member not found.');
    // Demoting the last owner would leave the org ownerless.
    if (target.role === 'owner' && role === 'member' && auth.countOrgOwners(req.orgId) <= 1) {
      return sendError(res, 400, 'LAST_OWNER', 'There must be at least one owner.');
    }
    auth.setUserRole(target.id, role);
    res.json({ ok: true, role });
  } catch (err) {
    sendError(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

module.exports = router;
