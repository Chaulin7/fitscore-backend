'use strict';

/**
 * src/config/legal.js — SINGLE SOURCE OF TRUTH for the operating legal entity.
 *
 * Art. 3:15d BW requires a Dutch trader to make its identity, KvK number and
 * VAT identification number "easily, directly and permanently accessible". The
 * operative word is permanently: the details cannot live on a Colofon page a
 * visitor has to go looking for, and they cannot depend on a fetch completing.
 * So they are substituted into every served page at startup (src/index.js,
 * alongside __PRICING_JSONLD__) rather than fetched client-side the way
 * /api/meta supplies the contact address — a visitor with JS disabled still
 * gets the footer.
 *
 * These are CONSTANTS, not configuration. They were deliberately not put behind
 * env vars: COMPANY_LEGAL_NAME already existed for exactly this and was still
 * set to a stale entity name, which is precisely the failure mode a registry
 * number cannot afford. A deployment cannot get the KvK number wrong if there
 * is no knob to get wrong. /api/meta now serves legalName from here too, so the
 * footer and the operator clause in /terms.html cannot disagree.
 *
 * The entity name is also what src/services/branding.js refuses to print on a
 * report — that module derives its blocklist from LEGAL_NAME below, so a future
 * rename cannot leave a stale guard behind.
 */

/** Registered name of the operating entity (the trader, not the product brand). */
const LEGAL_NAME = 'Joyaco BV';

/** Kamer van Koophandel registration number. Eight digits. */
const KVK = '42135911';

/** BTW-identificatienummer (VAT ID) as issued — NL + 9 digits + B + 2 digits. */
const BTW_ID = 'NL005523705B04';

/**
 * The one rendered form, so every surface prints an identical string. Injected
 * as-is into HTML: every character is alphanumeric, a space, or a separator, so
 * there is nothing here for a template to escape.
 */
const FOOTER_LINE = `${LEGAL_NAME} · KvK ${KVK} · BTW ${BTW_ID}`;

module.exports = { LEGAL_NAME, KVK, BTW_ID, FOOTER_LINE };
