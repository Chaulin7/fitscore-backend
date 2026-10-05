'use strict';

/**
 * test/helpers/clientDocs.js — the docs/ files that leave the building.
 *
 * SHIPPED: the EU AI Act compliance pack (the files compliance-pack-cover.md
 * lists under "Documents in this pack", plus the cover itself) and the DPA
 * template, which every site footer offers on request. Everything else in
 * docs/ (records of processing, retention policy, billing, security, API
 * notes) is internal.
 *
 * OPEN_ITEMS_VISIBLE: shipped drafts whose open items are meant to be seen by
 * the reader until they are done. Each must say so in its own header, and the
 * tests check that it still does. Every other shipped doc must show no TODO.
 */

const SHIPPED = Object.freeze([
  'docs/compliance/compliance-pack-cover.md',
  'docs/compliance/instructions-for-use.md',
  'docs/compliance/risk-management-log.md',
  'docs/compliance/technical-documentation-outline.md',
  'docs/compliance/candidate-notice.md',
  'docs/privacy/dpa-template.md',
]);

const OPEN_ITEMS_VISIBLE = Object.freeze({
  // A contract draft: an unfilled placeholder must stay impossible to miss.
  'docs/privacy/dpa-template.md': 'DRAFT — for legal review before signature.',
  // An Annex IV working document; the pack cover tells clients its open items are flagged.
  'docs/compliance/technical-documentation-outline.md': 'Sections marked **TODO** are open work items',
});

module.exports = { SHIPPED, OPEN_ITEMS_VISIBLE };
