'use strict';

/**
 * src/i18n/narrative/index.js — the locale registry.
 *
 * Static requires, deliberately. Resolving a catalogue by building a path from
 * the caller's locale string would turn a request parameter into a filesystem
 * read, and would make the set of supported locales unknowable by reading the
 * code. Adding Dutch is one require and one entry below; nothing in
 * narrativeGenerator.js changes.
 *
 * templateVersion is re-exported from the catalogue rather than declared here,
 * so it can never drift from the strings it describes.
 */

const en = require('./en');

const CATALOGUES = Object.freeze({ en });

/** Locales this build can render, sorted — used in error messages. */
const SUPPORTED_LOCALES = Object.freeze(Object.keys(CATALOGUES).sort());

/**
 * @param {string} locale
 * @returns {{locale: string, templateVersion: string, TEMPLATES: object}}
 * @throws {RangeError} on a locale this build has no catalogue for — never a
 *   silent fall back to English, which would ship a Dutch customer an English
 *   report that looks intentional.
 */
function catalogueFor(locale) {
  const key = String(locale);
  if (!Object.prototype.hasOwnProperty.call(CATALOGUES, key)) {
    throw new RangeError(
      `narrative: no template catalogue for locale "${key}" (have: ${SUPPORTED_LOCALES.join(', ')})`,
    );
  }
  return CATALOGUES[key];
}

module.exports = Object.freeze({
  catalogueFor,
  SUPPORTED_LOCALES,
  templateVersion: en.templateVersion,
});
