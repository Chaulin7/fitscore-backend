'use strict';

/**
 * src/routes/adminTrialInvites.js — POST /admin/trial-invites.
 *
 * Mints 30-day no-card trial tokens for a batch of named prospects and hands
 * back the tokens and the full URLs to send them.
 *
 * OPERATOR ONLY, behind the same guard as /admin/metrics
 * (middleware/adminAuth.requirePlatformOwner) and mounted outside /api for the
 * same reason: this is not part of the product's API surface, it is a lever the
 * one operator pulls. Every rejection is a 404 identical to the application's
 * catch-all, so the endpoint is indistinguishable from a path that does not
 * exist — which matters more here than on the metrics page, because what is
 * behind this one is the ability to mint free subscriptions.
 *
 * Read the request/response shape as: give me a list of companies, get back a
 * list of links. Nothing else is inferred, and no email is sent from here —
 * the operator owns the outreach, and a token minted but not sent costs
 * nothing and expires on its own.
 */

const express = require('express');

const { requirePlatformOwner } = require('../middleware/adminAuth');
const { mintInvites, TRIAL_PERIOD_DAYS, DEFAULT_INVITE_TTL_DAYS } = require('../services/trialInvites');
const { baseUrlFor } = require('../config/appUrl');

const router = express.Router();

// A single request's ceiling. Not a rate limit — the operator is trusted — but
// a guard against a malformed script POSTing a million rows and filling the
// disk inside one transaction.
const MAX_INVITES_PER_REQUEST = 500;

function sendError(res, status, code, message, extra) {
  return res.status(status).json({ error: message, code, ...(extra || {}) });
}

/**
 * POST /admin/trial-invites
 *
 * Body:
 *   {
 *     invites: [{ email, company_name, campaign }, …],   // required
 *     expiresAt?: ISO-8601,        // explicit expiry, wins over expiresInDays
 *     expiresInDays?: number       // 1–365; default DEFAULT_INVITE_TTL_DAYS
 *   }
 *
 * A bare array body is accepted too, since that is what a one-liner naturally
 * sends.
 *
 * Response 201:
 *   { count, trialPeriodDays, expiresAt, invites: [{ token, url, … }] }
 *
 * The batch is all-or-nothing on validation: one bad address rejects the whole
 * request with every problem listed, rather than committing the good half and
 * leaving the operator to work out which prospects got a link.
 */
router.post('/trial-invites', requirePlatformOwner, (req, res) => {
  try {
    const body = req.body;
    const entries = Array.isArray(body) ? body : (body && body.invites);
    const options = Array.isArray(body) ? {} : (body || {});

    if (!Array.isArray(entries) || entries.length === 0) {
      return sendError(res, 400, 'VALIDATION_ERROR',
        'Provide invites: a non-empty array of { email, company_name, campaign }.');
    }
    if (entries.length > MAX_INVITES_PER_REQUEST) {
      return sendError(res, 400, 'VALIDATION_ERROR',
        `Too many invites in one request (max ${MAX_INVITES_PER_REQUEST}).`);
    }

    // The URL the prospect will click is built from the deployment's public
    // origin (config/appUrl), never from a value in the request body. An
    // operator pasting these into an email must not be able to be handed a link
    // pointing somewhere else, and behind a proxy the request host is the proxy.
    const result = mintInvites(entries, {
      expiresAt: options.expiresAt,
      expiresInDays: options.expiresInDays,
      baseUrl: baseUrlFor(req),
    });

    if (!result.ok) {
      return sendError(res, 400, 'VALIDATION_ERROR', result.errors[0], { errors: result.errors });
    }

    console.log('[trial] minted invites', {
      count: result.invites.length,
      campaigns: [...new Set(result.invites.map((i) => i.campaign).filter(Boolean))],
      expiresAt: result.invites[0].expires_at,
      by: req.adminUser.email,
    });

    return res.status(201).json({
      count: result.invites.length,
      trialPeriodDays: TRIAL_PERIOD_DAYS,
      defaultTtlDays: DEFAULT_INVITE_TTL_DAYS,
      expiresAt: result.invites[0].expires_at,
      invites: result.invites,
    });
  } catch (err) {
    console.error('[trial] minting invites failed:', err.message);
    return sendError(res, 500, 'INTERNAL_ERROR', 'Could not create the trial invites.');
  }
});

module.exports = router;
