'use strict';

/**
 * src/services/authService.js
 *
 * Email + password authentication and organization multi-tenancy.
 *
 * - Passwords are hashed with bcrypt (cost 12); plaintext is never stored or logged.
 * - Session tokens are random 256-bit values; only their SHA-256 hash is stored.
 * - Password-reset tokens follow the same hash-at-rest pattern (30 min TTL, single use).
 * - Download tokens (for browser-opened report/CSV URLs that cannot send an
 *   Authorization header) are single-use, 60-second, in-memory tokens.
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { getDb, nowIso, RETENTION_DEFAULT_DAYS } = require('./db');

const BCRYPT_COST = 12;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const RESET_TTL_MS = 30 * 60 * 1000;             // 30 minutes
const DOWNLOAD_TOKEN_TTL_MS = 60 * 1000;         // 60 seconds
const MIN_PASSWORD_LENGTH = 10;
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;               // 15 minutes

// Short list of the most common passwords (>= 10 chars, since shorter ones
// already fail the length rule). Compared lowercase.
const COMMON_PASSWORDS = new Set([
  '1234567890', '12345678910', 'qwertyuiop', 'password123', 'password1234',
  'passw0rd123', 'admin123456', 'iloveyou123', '1q2w3e4r5t6y', 'qwerty123456',
  'welcome12345', 'sunshine123', 'football123', 'monkey123456', 'dragon123456',
  'letmein12345', 'baseball1234', 'superman1234', 'changemenow1', 'cvsprings123',
]);

function sha256hex(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

// Returns an error message string, or null when the password is acceptable.
function validatePassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`;
  }
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    return 'That password is too common. Please choose a less guessable one.';
  }
  return null;
}

async function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_COST);
}

async function verifyPassword(password, passwordHash) {
  return bcrypt.compare(password, passwordHash);
}

// --- Organizations ---------------------------------------------------------

function createOrganization(name) {
  const org = { id: uuidv4(), name: String(name || '').trim() || 'My Organization', createdAt: nowIso() };
  // Set retention explicitly to the conservative default so new orgs on an
  // existing database get 730 regardless of the column's historical default.
  getDb().prepare('INSERT INTO organizations (id, name, created_at, retention_days) VALUES (?, ?, ?, ?)')
    .run(org.id, org.name, org.createdAt, RETENTION_DEFAULT_DAYS);
  return org;
}

function getOrganizationById(id) {
  const row = getDb().prepare('SELECT id, name, created_at as createdAt, retention_days as retentionDays, timezone FROM organizations WHERE id = ?').get(id);
  return row || null;
}

// Org-wide audit retention. 0 = keep until manually deleted; otherwise 30-1095 days.
function setOrganizationRetention(id, days) {
  getDb().prepare('UPDATE organizations SET retention_days = ? WHERE id = ?').run(days, id);
}

// Per-org report branding (nullable). Raw values; callers validate/escape.
function getOrganizationBranding(id) {
  const row = getDb().prepare('SELECT brand_display_name AS brandDisplayName, brand_logo_url AS brandLogoUrl, brand_color AS brandColor FROM organizations WHERE id = ?').get(id);
  return row || { brandDisplayName: null, brandLogoUrl: null, brandColor: null };
}

function setOrganizationBranding(id, { brandDisplayName, brandLogoUrl, brandColor }) {
  getDb().prepare('UPDATE organizations SET brand_display_name = ?, brand_logo_url = ?, brand_color = ? WHERE id = ?')
    .run(brandDisplayName || null, brandLogoUrl || null, brandColor || null, id);
}

// --- Users -------------------------------------------------------------------

function findUserByEmail(email) {
  return getDb().prepare('SELECT * FROM users WHERE email = ?').get(normalizeEmail(email)) || null;
}

function findUserById(id) {
  return getDb().prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
}

function createUser({ email, passwordHash, orgId, role }) {
  const user = {
    id: uuidv4(),
    email: normalizeEmail(email),
    password_hash: passwordHash,
    org_id: orgId,
    role: role || 'member',
    created_at: nowIso(),
  };
  getDb().prepare(`
    INSERT INTO users (id, email, password_hash, org_id, role, created_at, failed_logins)
    VALUES (@id, @email, @password_hash, @org_id, @role, @created_at, 0)
  `).run(user);
  return user;
}

function isLocked(user) {
  return !!(user.locked_until && Date.parse(user.locked_until) > Date.now());
}

// If the account's lock has already expired, clear it and reset the failure
// counter to 0 BEFORE the current attempt is evaluated. Without this, a stale
// locked_until in the past leaves failed_logins pinned at the cap, so the very
// next wrong password re-locks immediately — one attempt per LOCKOUT_MS forever
// (a slow-motion version of the rolling lockout). The threshold then correctly
// means "MAX_FAILED_LOGINS failures since the last lock expired", not "ever".
// Mutates the passed-in user object so the caller sees the cleared state, and
// returns true when a reset was performed. No-op on a still-active lock.
function resetExpiredLock(user) {
  if (user.locked_until && Date.parse(user.locked_until) <= Date.now()) {
    getDb().prepare('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?').run(user.id);
    user.failed_logins = 0;
    user.locked_until = null;
    return true;
  }
  return false;
}

function recordLoginFailure(user) {
  const failed = (user.failed_logins || 0) + 1;
  // Defensive: if the account is ALREADY locked, advance the attempt counter
  // but keep the existing unlock time — never push locked_until further out.
  // Otherwise every attempt against a locked account would roll the lockout
  // another LOCKOUT_MS forward, turning it into a permanent-denial vector
  // against any known email. Only cross the threshold into a fresh lock when
  // the account isn't currently locked.
  const lockedUntil = isLocked(user)
    ? user.locked_until
    : (failed >= MAX_FAILED_LOGINS
        ? new Date(Date.now() + LOCKOUT_MS).toISOString()
        : user.locked_until);
  getDb().prepare('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?').run(failed, lockedUntil || null, user.id);
}

function recordLoginSuccess(user) {
  getDb().prepare('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?').run(nowIso(), user.id);
}

function setUserPassword(userId, passwordHash) {
  getDb().prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, userId);
}

// --- Team members & invitations ----------------------------------------------

// All users in an org (for the members list + capacity counting).
function listOrgUsers(orgId) {
  return getDb().prepare(`
    SELECT id, email, role, created_at AS createdAt, last_login_at AS lastLoginAt
    FROM users WHERE org_id = ? ORDER BY created_at ASC
  `).all(orgId);
}

function countOrgUsers(orgId) {
  return getDb().prepare('SELECT COUNT(*) AS c FROM users WHERE org_id = ?').get(orgId).c;
}

function countOrgOwners(orgId) {
  return getDb().prepare("SELECT COUNT(*) AS c FROM users WHERE org_id = ? AND role = 'owner'").get(orgId).c;
}

function setUserRole(userId, role) {
  getDb().prepare('UPDATE users SET role = ? WHERE id = ?').run(role, userId);
}

function deleteUser(userId) {
  getDb().prepare('DELETE FROM users WHERE id = ?').run(userId);
}

// Create or refresh a pending invite for an email (idempotent per pending
// email). Returns the raw token. Any existing pending invite for the same
// (org,email) is revoked so only one token is live at a time.
function createOrRefreshInvite({ orgId, email, invitedBy, ttlMs = 7 * 24 * 60 * 60 * 1000 }) {
  const normEmail = normalizeEmail(email);
  getDb().prepare(`
    UPDATE invites SET revoked_at = ?
    WHERE org_id = ? AND email = ? AND accepted_at IS NULL AND revoked_at IS NULL
  `).run(nowIso(), orgId, normEmail);
  const rawToken = crypto.randomBytes(32).toString('hex');
  getDb().prepare(`
    INSERT INTO invites (id, org_id, email, role, token_hash, invited_by, expires_at, created_at)
    VALUES (?, ?, ?, 'member', ?, ?, ?, ?)
  `).run(uuidv4(), orgId, normEmail, sha256hex(rawToken), invitedBy || null, new Date(Date.now() + ttlMs).toISOString(), nowIso());
  return rawToken;
}

function listPendingInvites(orgId) {
  return getDb().prepare(`
    SELECT id, email, role, invited_by AS invitedBy, expires_at AS expiresAt, created_at AS createdAt
    FROM invites
    WHERE org_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?
    ORDER BY created_at DESC
  `).all(orgId, nowIso());
}

function revokeInvite(orgId, inviteId) {
  const r = getDb().prepare(`
    UPDATE invites SET revoked_at = ?
    WHERE id = ? AND org_id = ? AND accepted_at IS NULL AND revoked_at IS NULL
  `).run(nowIso(), inviteId, orgId);
  return r.changes > 0;
}

// Returns a valid (unexpired, unrevoked, unaccepted) invite by raw token, else null.
function findValidInvite(rawToken) {
  if (!rawToken || typeof rawToken !== 'string') return null;
  const row = getDb().prepare('SELECT * FROM invites WHERE token_hash = ?').get(sha256hex(rawToken));
  if (!row) return null;
  if (row.accepted_at || row.revoked_at) return null;
  if (Date.parse(row.expires_at) <= Date.now()) return null;
  return row;
}

function markInviteAccepted(id) {
  getDb().prepare('UPDATE invites SET accepted_at = ? WHERE id = ?').run(nowIso(), id);
}

// --- Sessions ----------------------------------------------------------------

// Creates a session and returns the raw token (only the hash is stored).
function createSession(userId) {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const session = {
    id: uuidv4(),
    user_id: userId,
    token_hash: sha256hex(rawToken),
    expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
    created_at: nowIso(),
  };
  getDb().prepare(`
    INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
    VALUES (@id, @user_id, @token_hash, @expires_at, @created_at)
  `).run(session);
  return { rawToken, session };
}

// Validates a raw session token. Returns { session, user } or null.
function findSessionByToken(rawToken) {
  if (!rawToken || typeof rawToken !== 'string') return null;
  const session = getDb().prepare('SELECT * FROM sessions WHERE token_hash = ?').get(sha256hex(rawToken));
  if (!session) return null;
  if (Date.parse(session.expires_at) <= Date.now()) {
    getDb().prepare('DELETE FROM sessions WHERE id = ?').run(session.id);
    return null;
  }
  const user = findUserById(session.user_id);
  if (!user) return null;
  return { session, user };
}

function deleteSession(sessionId) {
  getDb().prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

// Invalidates every session for a user except (optionally) one to keep alive.
function deleteSessionsForUser(userId, exceptSessionId) {
  if (exceptSessionId) {
    getDb().prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(userId, exceptSessionId);
  } else {
    getDb().prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }
}

// --- Password resets -----------------------------------------------------------

// Creates a reset token for the user; returns the raw token.
function createPasswordReset(userId) {
  const rawToken = crypto.randomBytes(32).toString('hex');
  getDb().prepare(`
    INSERT INTO password_resets (id, user_id, token_hash, expires_at, used_at, created_at)
    VALUES (?, ?, ?, ?, NULL, ?)
  `).run(uuidv4(), userId, sha256hex(rawToken), new Date(Date.now() + RESET_TTL_MS).toISOString(), nowIso());
  return rawToken;
}

// Returns the reset row if the raw token is valid (unexpired, unused), else null.
function findValidPasswordReset(rawToken) {
  if (!rawToken || typeof rawToken !== 'string') return null;
  const row = getDb().prepare('SELECT * FROM password_resets WHERE token_hash = ?').get(sha256hex(rawToken));
  if (!row) return null;
  if (row.used_at) return null;
  if (Date.parse(row.expires_at) <= Date.now()) return null;
  return row;
}

function markPasswordResetUsed(id) {
  getDb().prepare('UPDATE password_resets SET used_at = ? WHERE id = ?').run(nowIso(), id);
}

// --- Download tokens (single-use, 60s, in-memory) ------------------------------

const downloadTokens = new Map(); // token -> { orgId, userId, expiresAt }

function createDownloadToken({ orgId, userId }) {
  const token = crypto.randomBytes(24).toString('hex');
  downloadTokens.set(token, { orgId, userId, expiresAt: Date.now() + DOWNLOAD_TOKEN_TTL_MS });
  // Opportunistic cleanup so the map cannot grow unbounded
  if (downloadTokens.size > 1000) {
    const now = Date.now();
    for (const [t, v] of downloadTokens) { if (v.expiresAt <= now) downloadTokens.delete(t); }
  }
  return token;
}

// Validates AND consumes a download token. Returns { orgId, userId } or null.
function consumeDownloadToken(token) {
  if (!token || typeof token !== 'string') return null;
  const entry = downloadTokens.get(token);
  if (!entry) return null;
  downloadTokens.delete(token);
  if (entry.expiresAt <= Date.now()) return null;
  return { orgId: entry.orgId, userId: entry.userId };
}

// --- Legacy data migration ------------------------------------------------------

const LEGACY_ORG_NAME = 'Chaulin (legacy)';

function getLegacyOrg() {
  return getDb().prepare('SELECT * FROM organizations WHERE name = ?').get(LEGACY_ORG_NAME) || null;
}

/**
 * One organization named "Chaulin (legacy)" adopts every pre-auth record
 * (audit_log, audit_changes, templates rows with org_id IS NULL), and an
 * owner user is created from OWNER_EMAIL + OWNER_PASSWORD if configured.
 * Idempotent: safe to run on every boot.
 */
async function migrateLegacyData(log = console.log) {
  const db = getDb();

  const orphans =
    db.prepare('SELECT COUNT(*) AS c FROM audit_log WHERE org_id IS NULL').get().c +
    db.prepare('SELECT COUNT(*) AS c FROM audit_changes WHERE org_id IS NULL').get().c +
    db.prepare('SELECT COUNT(*) AS c FROM templates WHERE org_id IS NULL').get().c;

  const ownerEmail = normalizeEmail(process.env.OWNER_EMAIL);
  const ownerPassword = process.env.OWNER_PASSWORD;

  let legacyOrg = getLegacyOrg();
  if (!legacyOrg && (orphans > 0 || (ownerEmail && ownerPassword))) {
    legacyOrg = createOrganization(LEGACY_ORG_NAME);
    log(`[auth] Created organization "${LEGACY_ORG_NAME}" (${legacyOrg.id})`);
  }

  if (legacyOrg && orphans > 0) {
    // audit_changes is protected by an append-only UPDATE trigger; lift it
    // for the one-time org_id backfill, then restore it.
    db.exec('DROP TRIGGER IF EXISTS audit_changes_no_update');
    const backfill = db.transaction(() => {
      db.prepare('UPDATE audit_log SET org_id = ? WHERE org_id IS NULL').run(legacyOrg.id);
      db.prepare('UPDATE audit_changes SET org_id = ? WHERE org_id IS NULL').run(legacyOrg.id);
      db.prepare('UPDATE templates SET org_id = ? WHERE org_id IS NULL').run(legacyOrg.id);
    });
    backfill();
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS audit_changes_no_update
      BEFORE UPDATE ON audit_changes
      BEGIN SELECT RAISE(ABORT, 'audit_changes is append-only'); END;
    `);
    log(`[auth] Assigned ${orphans} legacy record(s) to "${LEGACY_ORG_NAME}"`);
  }

  if (ownerEmail && ownerPassword) {
    if (!findUserByEmail(ownerEmail)) {
      const pwError = validatePassword(ownerPassword);
      if (pwError) {
        log(`[auth] WARNING: OWNER_PASSWORD rejected (${pwError}) — owner user not created.`);
      } else {
        const passwordHash = await hashPassword(ownerPassword);
        createUser({ email: ownerEmail, passwordHash, orgId: legacyOrg.id, role: 'owner' });
        log(`[auth] Created owner user ${ownerEmail} for "${LEGACY_ORG_NAME}"`);
      }
    }
  }
}

module.exports = {
  sha256hex,
  normalizeEmail,
  isValidEmail,
  validatePassword,
  hashPassword,
  verifyPassword,
  createOrganization,
  getOrganizationById,
  setOrganizationRetention,
  getOrganizationBranding,
  setOrganizationBranding,
  listOrgUsers,
  countOrgUsers,
  countOrgOwners,
  setUserRole,
  deleteUser,
  createOrRefreshInvite,
  listPendingInvites,
  revokeInvite,
  findValidInvite,
  markInviteAccepted,
  findUserByEmail,
  findUserById,
  createUser,
  isLocked,
  resetExpiredLock,
  recordLoginFailure,
  recordLoginSuccess,
  setUserPassword,
  createSession,
  findSessionByToken,
  deleteSession,
  deleteSessionsForUser,
  createPasswordReset,
  findValidPasswordReset,
  markPasswordResetUsed,
  createDownloadToken,
  consumeDownloadToken,
  migrateLegacyData,
  MAX_FAILED_LOGINS,
};
