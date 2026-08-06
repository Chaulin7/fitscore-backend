'use strict';

/**
 * src/services/brandmark.js
 *
 * The CVsprings brandmark, inlined as a module constant.
 *
 * Read ONCE at module load and held in memory, so rendering a report never
 * depends on a filesystem read from the ephemeral app directory. The asset is
 * git-tracked and ships with the deploy slug; it is not org data and never
 * changes at runtime.
 *
 * A failed read THROWS. This is deliberate and replaces a try/catch that
 * swallowed the error and left the mark null, which the renderer then treated
 * as "just omit it" — producing a silently unbranded report that was
 * indistinguishable from a design decision. A missing brandmark is a broken
 * build: fail loudly at require time, where it is obvious, rather than shipping
 * blank headers.
 */

const fs = require('fs');
const path = require('path');

const BRANDMARK_PATH = path.join(__dirname, '..', '..', 'public', 'brandmark.svg');

function loadBrandmark() {
  let markup;
  try {
    markup = fs.readFileSync(BRANDMARK_PATH, 'utf8');
  } catch (cause) {
    throw new Error(
      `CVsprings brandmark missing or unreadable at ${BRANDMARK_PATH}. ` +
      'Reports cannot be rendered without it. ' +
      `(${cause && cause.message})`,
    );
  }
  if (!markup.includes('<svg')) {
    throw new Error(`CVsprings brandmark at ${BRANDMARK_PATH} is not SVG markup.`);
  }
  return markup;
}

// Source markup, as authored: a single-colour mark drawn in #000.
const BRANDMARK_SVG = loadBrandmark();

/**
 * The brandmark recoloured to `hex`.
 *
 * Anchored on the quote that closes the attribute so only whole `#000` colour
 * values are rewritten — a bare replaceAll('#000', …) would also corrupt a
 * longer hex such as #0001ff if one were ever added to the source.
 *
 * @param {string} hex  a #rgb / #rrggbb colour
 * @returns {string} SVG markup, ready for a pdfmake { svg: … } node
 */
function tintedBrandmark(hex) {
  if (typeof hex !== 'string' || !/^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(hex)) {
    throw new Error(`tintedBrandmark() needs a hex colour, got: ${JSON.stringify(hex)}`);
  }
  return BRANDMARK_SVG.replace(/#000(?=["'])/g, hex);
}

module.exports = { BRANDMARK_PATH, BRANDMARK_SVG, tintedBrandmark };
