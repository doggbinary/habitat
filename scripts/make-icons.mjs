/**
 * Generates the PWA icon set. Writing a minimal PNG encoder here keeps the
 * project free of image dependencies - the icons are flat colour blocks, so
 * there is nothing a library would do better.
 *
 * Run with: npm run icons
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

const BG = [0x14, 0x15, 0x1a, 0xff];
const CELLS = {
  a: [0x7e, 0xa0, 0xff, 0xff],
  b: [0x4f, 0x6f, 0xcc, 0xff],
  c: [0x2c, 0x3f, 0x7a, 0xff],
  d: [0x23, 0x27, 0x33, 0xff],
  '.': null,
};

/** 8x8 tile motif: a little slope of "terrain" over a darker base. */
const MOTIF = [
  '..aa....',
  '.aabb...',
  'aabbbb..',
  'abbbbcc.',
  'bbbbccc.',
  'bbccccdd',
  'ccccdddd',
  'ccdddddd',
];

function crc32(buffer) {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, crc]);
}

function encodePng(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  // Prefix every scanline with filter type 0; the data is blocky enough that
  // deflate handles it well without per-line filtering.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0;
    pixels.copy(raw, rowStart + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * @param {number} size output size in pixels
 * @param {number} inset fraction of the canvas left as padding, so maskable
 *   icons keep their artwork inside the safe zone iOS and Android crop to.
 */
function drawIcon(size, inset) {
  const pixels = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) pixels.set(BG, i * 4);

  const artSize = Math.round(size * (1 - inset * 2));
  const offset = Math.round((size - artSize) / 2);
  const cell = artSize / MOTIF.length;

  for (let row = 0; row < MOTIF.length; row++) {
    for (let col = 0; col < MOTIF[row].length; col++) {
      const color = CELLS[MOTIF[row][col]];
      if (!color) continue;
      const x0 = offset + Math.round(col * cell);
      const y0 = offset + Math.round(row * cell);
      const x1 = offset + Math.round((col + 1) * cell);
      const y1 = offset + Math.round((row + 1) * cell);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          if (x < 0 || y < 0 || x >= size || y >= size) continue;
          pixels.set(color, (y * size + x) * 4);
        }
      }
    }
  }
  return encodePng(size, pixels);
}

mkdirSync(OUT_DIR, { recursive: true });

const targets = [
  ['icon-180.png', 180, 0.1],
  ['icon-192.png', 192, 0.1],
  ['icon-512.png', 512, 0.1],
  ['icon-maskable-512.png', 512, 0.2],
];

for (const [name, size, inset] of targets) {
  writeFileSync(resolve(OUT_DIR, name), drawIcon(size, inset));
  console.log(`wrote ${name} (${size}x${size})`);
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8" shape-rendering="crispEdges">
<rect width="8" height="8" fill="#14151a"/>
${MOTIF.flatMap((row, y) =>
  [...row].map((key, x) => {
    const color = CELLS[key];
    return color
      ? `<rect x="${x}" y="${y}" width="1" height="1" fill="rgb(${color[0]},${color[1]},${color[2]})"/>`
      : '';
  }),
)
  .filter(Boolean)
  .join('\n')}
</svg>
`;
writeFileSync(resolve(OUT_DIR, 'icon.svg'), svg);
console.log('wrote icon.svg');
