#!/usr/bin/env node
// Generates the complete PWA icon set from a single vector definition.
//
// No dependencies on purpose: the PNGs are encoded by hand (IHDR / IDAT / IEND
// with zlib) and the favicon is plain SVG, so a fresh clone can rebuild the
// artwork with nothing but Node. Run it via `pnpm --filter @initiative/web icons`.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/* ------------------------------------------------------------------ brand */

/** Logo gradient – the same two colours as `--accent-strong` and `--accent-2`. */
const GRADIENT_FROM = [0x57, 0x66, 0xf5];
const GRADIENT_TO = [0x22, 0xd3, 0xee];

/** Corner radius of the tile as a fraction of the edge length. */
const CORNER_RADIUS = 0.22;

/** Height of the bolt relative to the canvas. */
const BOLT_SCALE = 0.82;
/** Maskable icons shrink the motif so it stays inside the safe zone (inner 80%). */
const MASKABLE_SCALE = 0.8;
/** The notification badge is monochrome and gets scaled down hard by Android. */
const BADGE_SCALE = 0.94;

/**
 * Outline of the lightning bolt inside a 0..1 box (y grows downwards).
 *
 * The six points are point-symmetric around the centre, which keeps the motif
 * optically balanced at every size and makes the SVG path fall out of the same
 * numbers as the rasteriser.
 */
const BOLT = [
  [0.615, 0.055],
  [0.255, 0.545],
  [0.455, 0.545],
  [0.385, 0.945],
  [0.745, 0.455],
  [0.545, 0.455],
];

/** Samples per pixel and axis – 4x4 = 16 samples for every pixel. */
const SUPERSAMPLE = 4;

/* ------------------------------------------------------------ PNG encoder */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(bytes) {
  let crc = -1;
  for (let i = 0; i < bytes.length; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

/** One PNG chunk: length, type, payload, CRC32 over type + payload. */
function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/**
 * Encodes RGBA pixels as a PNG. With `alpha: false` the alpha channel is
 * dropped and colour type 2 (truecolour) is written – iOS wants an icon
 * without transparency.
 */
function encodePng(pixels, size, { alpha = true } = {}) {
  const channels = alpha ? 4 : 3;
  const stride = size * channels;
  const raw = Buffer.alloc((stride + 1) * size);

  for (let y = 0; y < size; y += 1) {
    const row = y * (stride + 1);
    raw[row] = 0; // filter type 0 (None) – zlib compresses the flat artwork well enough
    for (let x = 0; x < size; x += 1) {
      const from = (y * size + x) * 4;
      const to = row + 1 + x * channels;
      raw[to] = pixels[from];
      raw[to + 1] = pixels[from + 1];
      raw[to + 2] = pixels[from + 2];
      if (alpha) raw[to + 3] = pixels[from + 3];
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = alpha ? 6 : 2; // colour type: RGBA or RGB
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlacing

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* -------------------------------------------------------------- geometry */

/** Signed distance to the rounded square filling the canvas – negative inside. */
function roundedSquareDistance(x, y, size) {
  const half = size / 2;
  const radius = size * CORNER_RADIUS;
  const qx = Math.abs(x - half) - (half - radius);
  const qy = Math.abs(y - half) - (half - radius);
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - radius;
}

/**
 * Signed distance from a point to a polygon – negative inside, positive outside.
 * The sign comes from an even-odd ray cast, the magnitude from the nearest edge.
 */
function polygonDistance(x, y, points) {
  let nearest = Infinity;
  let inside = false;

  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    const ex = xj - xi;
    const ey = yj - yi;
    const wx = x - xi;
    const wy = y - yi;
    const t = Math.min(1, Math.max(0, (wx * ex + wy * ey) / (ex * ex + ey * ey)));
    const dx = wx - ex * t;
    const dy = wy - ey * t;
    nearest = Math.min(nearest, dx * dx + dy * dy);
    if (yi > y !== yj > y && x < (ex * (y - yi)) / ey + xi) inside = !inside;
  }

  const distance = Math.sqrt(nearest);
  return inside ? -distance : distance;
}

/** Coverage of one subsample: a linear ramp exactly one subsample wide. */
function coverage(distance) {
  return Math.min(1, Math.max(0, 0.5 - distance * SUPERSAMPLE));
}

/** The 135° gradient: top left is the indigo end, bottom right the cyan one. */
function gradientAt(x, y, size) {
  const t = Math.min(1, Math.max(0, (x + y) / (2 * size)));
  return [
    GRADIENT_FROM[0] + (GRADIENT_TO[0] - GRADIENT_FROM[0]) * t,
    GRADIENT_FROM[1] + (GRADIENT_TO[1] - GRADIENT_FROM[1]) * t,
    GRADIENT_FROM[2] + (GRADIENT_TO[2] - GRADIENT_FROM[2]) * t,
  ];
}

/** Scales the unit outline around the centre and maps it onto the canvas. */
function boltPolygon(size, scale) {
  return BOLT.map(([x, y]) => [(0.5 + (x - 0.5) * scale) * size, (0.5 + (y - 0.5) * scale) * size]);
}

/* ------------------------------------------------------------- rasteriser */

/**
 * Draws one icon into an RGBA buffer.
 *
 * `background: false` yields the bare white silhouette (notification badge),
 * `rounded: false` a full-bleed tile (maskable and iOS, where the platform
 * applies its own mask).
 */
function renderIcon({ size, rounded = true, background = true, boltScale = BOLT_SCALE }) {
  const pixels = new Uint8Array(size * size * 4);
  const bolt = boltPolygon(size, boltScale);
  const left = Math.min(...bolt.map((point) => point[0])) - 1;
  const right = Math.max(...bolt.map((point) => point[0])) + 1;
  const top = Math.min(...bolt.map((point) => point[1])) - 1;
  const bottom = Math.max(...bolt.map((point) => point[1])) + 1;

  const sampleBackground = background && rounded;
  const step = 1 / SUPERSAMPLE;
  const samples = SUPERSAMPLE * SUPERSAMPLE;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let backAlpha = background ? 1 : 0;
      let boltAlpha = 0;
      const nearBolt = x + 1 > left && x < right && y + 1 > top && y < bottom;

      if (sampleBackground || nearBolt) {
        let backSum = 0;
        let boltSum = 0;
        for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
          const py = y + (sy + 0.5) * step;
          for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
            const px = x + (sx + 0.5) * step;
            if (sampleBackground) backSum += coverage(roundedSquareDistance(px, py, size));
            if (nearBolt) boltSum += coverage(polygonDistance(px, py, bolt));
          }
        }
        if (sampleBackground) backAlpha = backSum / samples;
        if (nearBolt) boltAlpha = boltSum / samples;
      }

      const alpha = boltAlpha + backAlpha * (1 - boltAlpha);
      if (alpha <= 0) continue;

      // Source-over: white bolt on top of the gradient, stored unpremultiplied.
      const share = (backAlpha * (1 - boltAlpha)) / alpha;
      const white = (255 * boltAlpha) / alpha;
      const [r, g, b] = gradientAt(x + 0.5, y + 0.5, size);
      const offset = (y * size + x) * 4;
      pixels[offset] = Math.round(white + r * share);
      pixels[offset + 1] = Math.round(white + g * share);
      pixels[offset + 2] = Math.round(white + b * share);
      pixels[offset + 3] = Math.round(alpha * 255);
    }
  }

  return pixels;
}

/* ------------------------------------------------------------------- SVG */

function faviconSvg() {
  const size = 64;
  const round = (value) => Number(value.toFixed(2));
  const path = boltPolygon(size, BOLT_SCALE)
    .map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${round(x)} ${round(y)}`)
    .join('');
  const hex = (rgb) => `#${rgb.map((value) => value.toString(16).padStart(2, '0')).join('')}`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="Initiative">
  <defs>
    <linearGradient id="initiative-bolt" x1="0" y1="0" x2="${size}" y2="${size}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${hex(GRADIENT_FROM)}" />
      <stop offset="1" stop-color="${hex(GRADIENT_TO)}" />
    </linearGradient>
  </defs>
  <rect width="${size}" height="${size}" rx="${round(size * CORNER_RADIUS)}" fill="url(#initiative-bolt)" />
  <path d="${path}Z" fill="#ffffff" />
</svg>
`;
}

/* ------------------------------------------------------------------- main */

const iconsDir = fileURLToPath(new URL('../public/icons/', import.meta.url));
mkdirSync(iconsDir, { recursive: true });

const targets = [
  // Regular launcher icons: the rounded tile is the icon edge.
  { file: 'icon-192.png', size: 192 },
  { file: 'icon-512.png', size: 512 },
  // Maskable: full-bleed background (the platform crops the corners itself),
  // motif at 80% so it survives even an aggressive circular mask.
  { file: 'maskable-192.png', size: 192, rounded: false, boltScale: BOLT_SCALE * MASKABLE_SCALE },
  { file: 'maskable-512.png', size: 512, rounded: false, boltScale: BOLT_SCALE * MASKABLE_SCALE },
  // iOS rounds the home-screen icon itself and does not want an alpha channel.
  { file: 'apple-touch-icon.png', size: 180, rounded: false, alpha: false },
  // Android status bar: white silhouette on transparent, everything else is ignored.
  { file: 'badge-96.png', size: 96, background: false, boltScale: BADGE_SCALE },
];

const written = [];

for (const { file, size, rounded, background, boltScale, alpha } of targets) {
  const pixels = renderIcon({ size, rounded, background, boltScale });
  const png = encodePng(pixels, size, { alpha });
  writeFileSync(join(iconsDir, file), png);
  written.push([file, `${size}x${size}`, png.length]);
}

const svg = Buffer.from(faviconSvg(), 'utf8');
writeFileSync(join(iconsDir, 'favicon.svg'), svg);
written.push(['favicon.svg', 'vector', svg.length]);

for (const [file, dimensions, bytes] of written) {
  console.log(`${file.padEnd(22)} ${dimensions.padEnd(9)} ${(bytes / 1024).toFixed(1)} kB`);
}
console.log(`\n${written.length} Dateien in ${iconsDir}`);
