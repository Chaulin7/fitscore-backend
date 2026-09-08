'use strict';

/**
 * src/services/trialInvites.js — 30-day no-card trial tokens.
 *
 * A token is a one-shot right to open a Checkout Session that bills EUR 0 for
 * 30 days. It is minted by the operator (POST /admin/trial-invites), sent to a
 * named prospect, and spent at GET /start.
 *
 * Validation is a PURE function of the row and the clock (validateInvite), with
 * the database read split out (validateToken), so the four outcomes the product
 * cares about — unknown, expired, already redeemed, valid — are testable without
 * a database and without a Stripe account. Each has its own reason code because
 * each is a different thing to say to a person: "that link has already been
 * used" and "that link expired" are not the same message, and neither is "we
 * have never seen that link".
 *
 * The reason is NOT shown to the visitor. GET /start redirects to the pricing
 * page with a soft message either way — telling an anonymous caller which of
 * "unknown" and "expired" their guess was turns the endpoint into an oracle for
 * enumerating live tokens. The distinction is for the server log and the
 * operator.
 */

const { v4: uuidv4 } = require('uuid');

const {
  createTrialInvite, findTrialInviteByToken, markTrialInviteRedeemed, setTrialInviteTarget,
} = require('./db');

/**
 * The trial length, in days.
 *
 * ONE constant, used three times and never retyped: the default expiry of a
 * token minted by the admin endpoint, the `subscription_data.trial_period_days`
 * sent to Stripe, and the copy in the invite response. Those three drifting
 * apart is a token that outlives the trial it opens, or a customer promised
 * thirty days and given fourteen.
 */
const TRIAL_PERIOD_DAYS = 30;

/** How long a minted token stays redeemable, unless the caller overrides it. */
const DEFAULT_INVITE_TTL_DAYS = TRIAL_PERIOD_DAYS;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Why a token was refused. Server-side vocabulary; never sent to a visitor. */
const REASON = Object.freeze({
  MALFORMED: 'MALFORMED',
  UNKNOWN: 'UNKNOWN',
  EXPIRED: 'EXPIRED',
  ALREADY_REDEEMED: 'ALREADY_REDEEMED',
});

// A v4 uuid, which is the only shape mint() produces. Checked before the
// database is touched so a URL carrying a SQL fragment or a megabyte of text
// never reaches a query, and so the common case of a mangled link costs nothing.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isWellFormedToken(token) {
  return typeof token === 'string' && UUID_RE.test(token.trim());
}

/** ISO timestamp `days` from `now`. */
function expiryFrom(now, days) {
  return new Date(now + Math.round(days * MS_PER_DAY)).toISOString();
}

/**
 * Validate an already-loaded invite row against a clock.
 *
 * Order matters and is deliberate: redemption is checked BEFORE expiry, because
 * a token that was used and has since expired was used — "you already started
 * your trial" is the true and useful thing to tell that operator, and "that link
 * expired" would send them looking for a link that worked fine.
 *
 * @param {object|null} invite a row from db.findTrialInviteByToken()
 * @param {number} now epoch ms
 * @returns {{ok: boolean, reason: string|null, invite: object|null}}
 */
function validateInvite(invite, now = Date.now()) {
  if (!invite) return { ok: false, reason: REASON.UNKNOWN, invite: null };
  if (invite.redeemedAt) return { ok: false, reason: REASON.ALREADY_REDEEMED, invite };

  const expiresAtMs = Date.parse(invite.expiresAt);
  // An unparseable expiry is treated as expired rather than as absent. Failing
  // open here would make a corrupt row a permanent free trial.
  if (!Number.isFinite(expiresAtMs)) return { ok: false, reason: REASON.EXPIRED, invite };
  // Exactly at the boundary the token is spent: expires_at is the first instant
  // it no longer works, not the last instant it does.
  if (now >= expiresAtMs) return { ok: false, reason: REASON.EXPIRED, invite };

  return { ok: true, reason: null, invite };
}

/**
 * Look a token up and validate it.
 * @param {string} token the raw ?t= value
 * @param {number} now epoch ms
 */
function validateToken(token, now = Date.now()) {
  if (!isWellFormedToken(token)) return { ok: false, reason: REASON.MALFORMED, invite: null };
  return validateInvite(findTrialInviteByToken(token.trim()), now);
}

const trim = (v) => (typeof v === 'string' ? v.trim() : '');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const CAPS = Object.freeze({ email: 254, companyName: 200, campaign: 100 });

/**
 * Normalise and check one {email, company_name, campaign} entry.
 * Accepts snake_case (the documented request shape) and camelCase alike, so a
 * caller scripting this endpoint does not have to guess.
 * @returns {{ok: boolean, error: string|null, value: object|null}}
 */
function normalizeInviteInput(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'Each invite must be an object.', value: null };
  const email = trim(raw.email).toLowerCase();
  const companyName = trim(raw.company_name !== undefined ? raw.company_name : raw.companyName);
  const campaign = trim(raw.campaign);

  if (!email || !EMAIL_RE.test(email) || email.length > CAPS.email) {
    return { ok: false, error: `"${email || '(blank)'}" is not a valid email address.`, value: null };
  }
  if (companyName.length > CAPS.companyName) {
    return { ok: false, error: `company_name is too long for ${email} (max ${CAPS.companyName}).`, value: null };
  }
  if (campaign.length > CAPS.campaign) {
    return { ok: false, error: `campaign is too long for ${email} (max ${CAPS.campaign}).`, value: null };
  }
  return { ok: true, error: null, value: { email, companyName: companyName || null, campaign: campaign || null } };
}

/**
 * Resolve the expiry every token in one request gets.
 *
 * Two overrides, both optional: `expiresAt` (an explicit ISO instant) wins over
 * `expiresInDays`. Neither given, tokens last DEFAULT_INVITE_TTL_DAYS.
 * @returns {{ok: boolean, error: string|null, expiresAt: string|null}}
 */
function resolveExpiry({ expiresAt, expiresInDays } = {}, now = Date.now()) {
  if (expiresAt !== undefined && expiresAt !== null && expiresAt !== '') {
    const ms = Date.parse(expiresAt);
    if (!Number.isFinite(ms)) return { ok: false, error: 'expiresAt must be an ISO-8601 timestamp.', expiresAt: null };
    if (ms <= now) return { ok: false, error: 'expiresAt must be in the future.', expiresAt: null };
    return { ok: true, error: null, expiresAt: new Date(ms).toISOString() };
  }
  if (expiresInDays !== undefined && expiresInDays !== null && expiresInDays !== '') {
    const days = Number(expiresInDays);
    if (!Number.isFinite(days) || days <= 0 || days > 365) {
      return { ok: false, error: 'expiresInDays must be a number between 1 and 365.', expiresAt: null };
    }
    return { ok: true, error: null, expiresAt: expiryFrom(now, days) };
  }
  return { ok: true, error: null, expiresAt: expiryFrom(now, DEFAULT_INVITE_TTL_DAYS) };
}

/** The URL a prospect is sent. Built from the caller's resolved public origin. */
function inviteUrl(baseUrl, token) {
  return `${String(baseUrl || '').replace(/\/+$/, '')}/start?t=${encodeURIComponent(token)}`;
}

/**
 * Mint tokens for a batch of prospects.
 *
 * Validates the WHOLE batch before writing any of it: a campaign upload with one
 * bad address should be fixed and resent, not half-committed leaving the
 * operator to work out which half.
 *
 * @returns {{ok: boolean, errors: string[], invites: object[]}}
 */
function mintInvites(entries, { expiresAt, expiresInDays, baseUrl } = {}, now = Date.now()) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return { ok: false, errors: ['Provide a non-empty array of invites.'], invites: [] };
  }

  const expiry = resolveExpiry({ expiresAt, expiresInDays }, now);
  if (!expiry.ok) return { ok: false, errors: [expiry.error], invites: [] };

  const errors = [];
  const normalized = [];
  for (const [i, raw] of entries.entries()) {
    const parsed = normalizeInviteInput(raw);
    if (!parsed.ok) errors.push(`invites[${i}]: ${parsed.error}`);
    else normalized.push(parsed.value);
  }
  if (errors.length) return { ok: false, errors, invites: [] };

  const invites = normalized.map((entry) => {
    const token = uuidv4();
    const row = createTrialInvite({ ...entry, token, expiresAt: expiry.expiresAt, createdAt: new Date(now).toISOString() });
    return {
      token,
      email: row.email,
      company_name: row.companyName,
      campaign: row.campaign,
      created_at: row.createdAt,
      expires_at: row.expiresAt,
      trial_period_days: TRIAL_PERIOD_DAYS,
      url: inviteUrl(baseUrl, token),
    };
  });

  return { ok: true, errors: [], invites };
}

module.exports = {
  TRIAL_PERIOD_DAYS,
  DEFAULT_INVITE_TTL_DAYS,
  REASON,
  isWellFormedToken,
  validateInvite,
  validateToken,
  normalizeInviteInput,
  resolveExpiry,
  inviteUrl,
  mintInvites,
  // Re-exported so callers have one import for the whole token lifecycle.
  markTrialInviteRedeemed,
  setTrialInviteTarget,
  findTrialInviteByToken,
};
