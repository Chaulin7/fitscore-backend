'use strict';

/**
 * src/config/privacyContact.js — the address the Privacy Policy gives for
 * privacy requests (access, correction, deletion).
 *
 * PRIVACY_CONTACT_EMAIL when the operator sets one, otherwise the Imprint's
 * address (CONTACT_EMAIL in ./legal.js). Resolved once at startup and written
 * into the page by src/index.js (__PRIVACY_CONTACT_EMAIL__), so a visitor
 * without JavaScript reads the same address as everyone else. It used to be
 * swapped in client-side after a fetch, which meant two answers.
 *
 * The value goes into HTML unescaped, so it must be a plain address: the strict
 * pattern admits only [A-Za-z0-9._%+-] before the @ and a dotted domain after
 * it. Anything else is ignored in favour of the default, and the boot log says
 * so — without echoing the rejected value.
 */

const { CONTACT_EMAIL } = require('./legal');
const { STRICT_EMAIL } = require('../services/mailText');

/** @returns {{email: string, source: 'env'|'default', warning: string|null}} */
function resolvePrivacyContact(env = process.env) {
  const raw = typeof env.PRIVACY_CONTACT_EMAIL === 'string' ? env.PRIVACY_CONTACT_EMAIL.trim() : '';
  if (!raw) return { email: CONTACT_EMAIL, source: 'default', warning: null };
  if (raw.length <= 254 && STRICT_EMAIL.test(raw)) return { email: raw, source: 'env', warning: null };
  return {
    email: CONTACT_EMAIL,
    source: 'default',
    warning: `[privacy] PRIVACY_CONTACT_EMAIL is not a plain email address; the Privacy Policy shows ${CONTACT_EMAIL} instead.`,
  };
}

module.exports = { resolvePrivacyContact };
