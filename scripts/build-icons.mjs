#!/usr/bin/env node
// Generates the site's favicon set from public/brandmark.svg — the same mark
// the pages render via CSS mask, so the icon in a search result and the icon in
// the header are the one shape.
//
// Rasterising is done by headless Chrome (the only SVG renderer we can rely on
// being present on a Mac dev box) and the .ico container is assembled here, so
// the whole set is reproducible from one command with no image dependencies:
//
//   node scripts/build-icons.mjs
//
// Outputs into public/: favicon.ico, icon-32.png, icon-192.png, icon-512.png,
// apple-touch-icon.png. Paths are deliberately stable — Google caches favicons
// by URL and re-crawls them rarely, so renaming one costs weeks of a blank icon.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cvsprings-icons-'));

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// Brand palette, copied from the :root block in public/index.html.
const PAPER = '#F6F5F1';
const INK = '#16181D';

// The mark's own geometry, lifted from public/brandmark.svg. Kept as data
// rather than string-patched out of the file so the small-size variants below
// can rebuild it with different stroke weights.
const SRC = fs.readFileSync(path.join(PUBLIC_DIR, 'brandmark.svg'), 'utf8');
const bodyPath = SRC.match(/<path d="([^"]+)"/)[1];
const gridLines = SRC.match(/<g fill="none"[\s\S]*?<\/g>/)[0]
  .replace(/^<g[^>]*>/, '').replace(/<\/g>$/, '').trim();
// The mark's body is one path whose trailing subpath is the belly ellipse,
// punched out by fill-rule="evenodd" to become the globe. Dropping that
// subpath fills the belly back in, which is what the small sizes want.
const BELLY = ' M26.21 55.42';
const solidPath = bodyPath.slice(0, bodyPath.indexOf(BELLY));
// Below this the globe's grid stops resolving: the meridians land on
// fractions of a pixel and average out into a grey smear that reads as dirt
// rather than as a globe, and the belly cut-out thins the silhouette until the
// penguin and the surrounding ring are two concentric ovals. Under it the icon
// falls back to a solid silhouette, which is the honest reduction of the mark.
const GRID_FLOOR = 96;

// One tile of the icon set.
//   size    output pixels, square
//   pad     fraction of the tile left empty around the 96-unit mark
//   grid    draw the globe's meridians/parallels at all, and how heavy
function markup({ size, pad = 0.02, grid = 1.6 }) {
  const detailed = size >= GRID_FLOOR;
  const body = detailed ? bodyPath : solidPath;
  if (!detailed) grid = 0;
  const inner = 96 / (1 - 2 * pad);
  const off = (inner - 96) / 2;
  // Stroke weights are specified in the mark's own 96-unit space, so a hairline
  // that survives at 512px vanishes at 32px. Scale them up as the tile shrinks
  // to hold a ~1px rendered line, capped at 2x before the globe fills in.
  const pxPerUnit = (size * (1 - 2 * pad)) / 96;
  const weight = grid ? Math.min(grid * 2, Math.max(grid, 0.95 / pxPerUnit)) : 0;
  const ring = Math.min(8, Math.max(4, 1.1 / pxPerUnit));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${-off} ${-off} ${inner} ${inner}">
  <rect x="${-off}" y="${-off}" width="${inner}" height="${inner}" fill="${PAPER}"/>
  <circle cx="48" cy="48" r="44" fill="none" stroke="${INK}" stroke-width="${ring}"/>
  <g transform="translate(48 48) scale(0.86) translate(-48 -48)">
    <path d="${body}" fill="${INK}" fill-rule="evenodd"/>
    ${grid ? `<g fill="none" stroke="${INK}" stroke-width="${weight}" stroke-linecap="round" stroke-linejoin="round">${gridLines}</g>` : ''}
  </g>
</svg>`;
}

function render({ name, size, pad, grid }) {
  const svg = path.join(TMP, `${name}.svg`);
  const html = path.join(TMP, `${name}.html`);
  const out = path.join(TMP, `${name}.png`);
  fs.writeFileSync(svg, markup({ size, pad, grid }));
  // Screenshot an HTML wrapper rather than the .svg directly: it pins the
  // viewport to exactly size x size with no margin, so Chrome cannot letterbox.
  fs.writeFileSync(html, `<!doctype html><style>html,body{margin:0;padding:0;background:${PAPER}}svg{display:block}</style>${fs.readFileSync(svg, 'utf8')}`);
  execFileSync(CHROME, [
    '--headless', '--disable-gpu', '--hide-scrollbars',
    `--screenshot=${out}`, `--window-size=${size},${size}`,
    '--force-device-scale-factor=1', `file://${html}`,
  ], { stdio: 'ignore' });
  return out;
}

// --- minimal PNG reader, enough for what Chrome just wrote --------------------
// 8-bit, non-interlaced, colour type 2 or 6. Only exists so the .ico below can
// be built from real pixels without pulling in an image library.
function decodePng(file) {
  const buf = fs.readFileSync(file);
  let pos = 8, width = 0, height = 0, colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8) throw new Error(`unsupported bit depth ${data[8]}`);
      colorType = data[9];
      if (data[12] !== 0) throw new Error('interlaced PNG unsupported');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (colorType !== 2 && colorType !== 6) throw new Error(`unsupported colour type ${colorType}`);
  const bpp = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[i] = v & 0xff;
    }
    for (let x = 0; x < width; x++) {
      out[(y * width + x) * 4] = line[x * bpp];
      out[(y * width + x) * 4 + 1] = line[x * bpp + 1];
      out[(y * width + x) * 4 + 2] = line[x * bpp + 2];
      out[(y * width + x) * 4 + 3] = bpp === 4 ? line[x * bpp + 3] : 255;
    }
    prev = line;
  }
  return { width, height, rgba: out };
}

// --- ICO writer ---------------------------------------------------------------
// 32-bit BMP entries rather than PNG-compressed ones: every parser that has ever
// read an .ico understands BMP, the sizes involved are tiny, and this file is
// the one a search crawler is most likely to fetch.
function icoEntry({ width, height, rgba }) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(width, 4);
  header.writeInt32LE(height * 2, 8); // colour data + AND mask, per the format
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const src = (height - 1 - y) * width * 4; // BMP rows run bottom-up
    for (let x = 0; x < width; x++) {
      const s = src + x * 4, d = (y * width + x) * 4;
      pixels[d] = rgba[s + 2];
      pixels[d + 1] = rgba[s + 1];
      pixels[d + 2] = rgba[s];
      pixels[d + 3] = rgba[s + 3];
    }
  }
  // Fully opaque icons, but the AND mask is not optional in the container.
  const mask = Buffer.alloc((((width + 31) >> 5) << 2) * height);
  return Buffer.concat([header, pixels, mask]);
}

function writeIco(images, dest) {
  const entries = images.map(icoEntry);
  const dir = Buffer.alloc(6 + 16 * entries.length);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(entries.length, 4);
  let offset = dir.length;
  entries.forEach((entry, i) => {
    const p = 6 + 16 * i;
    const { width, height } = images[i];
    dir[p] = width === 256 ? 0 : width;
    dir[p + 1] = height === 256 ? 0 : height;
    dir[p + 2] = 0;
    dir[p + 3] = 0;
    dir.writeUInt16LE(1, p + 4);
    dir.writeUInt16LE(32, p + 6);
    dir.writeUInt32LE(entry.length, p + 8);
    dir.writeUInt32LE(offset, p + 12);
    offset += entry.length;
  });
  fs.writeFileSync(dest, Buffer.concat([dir, ...entries]));
}

// --- build --------------------------------------------------------------------
const png = [
  // Google renders the search-result icon from a downscale of the largest file
  // it can get, so 512 is the one that matters most for the original ask.
  { name: 'icon-512', size: 512, pad: 0.02, grid: 1.6 },
  { name: 'icon-192', size: 192, pad: 0.02, grid: 1.6 },
  { name: 'icon-32', size: 32, pad: 0.02, grid: 1.6 },
  // Apple masks this one to a rounded square on the home screen, so the ring
  // gets extra clearance from the corners it would otherwise graze.
  { name: 'apple-touch-icon', size: 180, pad: 0.08, grid: 1.6 },
];
for (const spec of png) {
  const out = render(spec);
  fs.copyFileSync(out, path.join(PUBLIC_DIR, `${spec.name}.png`));
  console.log(`  public/${spec.name}.png  ${spec.size}x${spec.size}`);
}

// The classic three. All fall under GRID_FLOOR, so all three come out as the
// solid silhouette; markup() handles that, they are not special-cased here.
const ico = [
  decodePng(render({ name: 'ico-16', size: 16 })),
  decodePng(render({ name: 'ico-32', size: 32 })),
  decodePng(render({ name: 'ico-48', size: 48 })),
];
writeIco(ico, path.join(PUBLIC_DIR, 'favicon.ico'));
console.log(`  public/favicon.ico       ${ico.map((i) => `${i.width}x${i.height}`).join(', ')}`);

fs.rmSync(TMP, { recursive: true, force: true });
