'use strict';

/**
 * GET /api/plans — the public tier table.
 *
 * Serves the marketing-safe view of src/config/plans.js so the pricing page and
 * the in-product Settings render from the same definitions the server gates on.
 * This replaced public/plans.js, a browser-only copy that the server could not
 * read — which is how the tier copy and the enforced behaviour drifted apart in
 * the first place.
 *
 * No auth: it is the pricing page, visible to logged-out visitors. Cacheable
 * for a short window — the content only changes on deploy, and a stale copy is
 * cosmetic (every gate is enforced server-side, never from this payload).
 */

const express = require('express');
const { marketingView } = require('../config/plans');

const router = express.Router();

// Computed once at module load: the table is static per deploy.
const PAYLOAD = marketingView();

router.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.json(PAYLOAD);
});

module.exports = router;
