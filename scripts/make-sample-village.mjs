/**
 * The map a new install opens on: a small Ninja Adventure village with a
 * house whose door leads into a room, a door back out, and a character
 * standing on the path, so the whole loop works before anything is drawn.
 *
 * Run with: npm run sample-village
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng } from './png.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pub = path.join(root, 'public');
const manifest = JSON.parse(fs.readFileSync(path.join(pub, 'starter/manifest.json'), 'utf8'));
const detectVersion = Number(/DETECT_VERSION = (\d+)/.exec(fs.readFileSync(path.join(root, 'src/core/assets.ts'), 'utf8'))[1]);

const TILE = 16;
const W = 40;
const H = 30;

const page = (suffix) => {
  const index = manifest.findIndex((entry) => entry.name.endsWith(suffix));
  if (index === -1) throw new Error(`No starter page named ...${suffix}`);
  return { index, entry: manifest[index], image: decodePng(path.join(pub, manifest[index].url)) };
};
const ground = page('Ground');
const nature = page('Nature');
const houses = page('Houses');
const floors = page('Interior floors');

/** The plainest fully opaque square on a page that passes `wanted`, as its tile index. */
function plainSquare({ image }, wanted) {
  const cols = Math.floor(image.width / TILE);
  let best = null;
  let bestSpread = Infinity;
  for (let ty = 0; ty < Math.floor(image.height / TILE); ty++) {
    for (let tx = 0; tx < cols; tx++) {
      const px = [];
      let opaque = true;
      for (let y = 0; y < TILE; y++) {
        for (let x = 0; x < TILE; x++) {
          const o = ((ty * TILE + y) * image.width + tx * TILE + x) * 4;
          if (image.data[o + 3] < 255) opaque = false;
          px.push([image.data[o], image.data[o + 1], image.data[o + 2]]);
        }
      }
      if (!opaque) continue;
      const mean = [0, 1, 2].map((c) => px.reduce((s, p) => s + p[c], 0) / px.length);
      if (!wanted(mean)) continue;
      const spread = px.reduce((s, p) => s + Math.abs(p[0] - mean[0]) + Math.abs(p[1] - mean[1]) + Math.abs(p[2] - mean[2]), 0);
      if (spread < bestSpread) {
        bestSpread = spread;
        best = ty * cols + tx;
      }
    }
  }
  if (best === null) throw new Error('No plain square found');
  return best;
}

/** A box tightened to the visible pixels inside a region of a page. */
function tighten({ image }, [x0, y0, x1, y1]) {
  let a = x1, b = y1, c = x0, d = y0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (image.data[(y * image.width + x) * 4 + 3] === 0) continue;
      a = Math.min(a, x); b = Math.min(b, y); c = Math.max(c, x); d = Math.max(d, y);
    }
  }
  return { x: a, y: b, w: c - a + 1, h: d - b + 1 };
}

const pack = (sheet, index) => (sheet << 16) | index;
const grass = pack(ground.index, plainSquare(ground, ([r, g, b]) => g > r * 1.1 && g > b * 1.3));
const dirt = pack(ground.index, plainSquare(ground, ([r, g, b]) => r > g && g > b && r - b > 40 && r < 200));
const floor = pack(floors.index, plainSquare(floors, () => true));

/** An empty square, as src/core/tiles.ts stores it. */
const EMPTY = -1;
const tiles = () => new Int32Array(W * H).fill(EMPTY);
const set = (layer, x, y, value) => {
  if (x >= 0 && y >= 0 && x < W && y < H) layer[y * W + x] = value;
};

// Outside: grass on the left 28 columns, a dirt path from the house door.
const groundLayer = tiles();
for (let y = 0; y < H; y++) for (let x = 0; x < 28; x++) set(groundLayer, x, y, grass);
for (let y = 8; y < 23; y++) for (let x = 7; x < 9; x++) set(groundLayer, x, y, dirt);
for (let x = 7; x < 23; x++) for (let y = 21; y < 23; y++) set(groundLayer, x, y, dirt);
// Inside the house: a room off to the right, on its own.
const ROOM = { x0: 30, y0: 4, x1: 37, y1: 11 };
for (let y = ROOM.y0; y <= ROOM.y1; y++) for (let x = ROOM.x0; x <= ROOM.x1; x++) set(groundLayer, x, y, floor);

// Walls nobody sees: the edge of the village, and around the room.
const walls = tiles();
for (let y = 0; y < H; y++) set(walls, 28, y, grass);
for (let x = ROOM.x0 - 1; x <= ROOM.x1 + 1; x++) {
  set(walls, x, ROOM.y0 - 1, grass);
  set(walls, x, ROOM.y1 + 1, grass);
}
for (let y = ROOM.y0 - 1; y <= ROOM.y1 + 1; y++) {
  set(walls, ROOM.x0 - 1, y, grass);
  set(walls, ROOM.x1 + 1, y, grass);
}

let nextId = 0;
const object = (sheet, rect, left, top, extra = {}) => ({
  id: `sample-${++nextId}`,
  tilesetId: `starter-${sheet.index}`,
  rect,
  x: left + rect.w / 2,
  y: top + rect.h / 2,
  scale: 1,
  rotation: 0,
  flipX: false,
  flipY: false,
  hueShift: 0,
  saturation: 1,
  brightness: 1,
  ...extra,
});

const houseRect = houses.entry.assets.find((a) => a.x === 0 && a.y === 0);
const doorRect = tighten(houses, [32, 48, 48, 64]);
// The two green trees at the start of the nature page's top row.
const treeRects = [0, 32].map((x) => nature.entry.assets.find((a) => a.y < 4 && a.x === x));
if (treeRects.some((rect) => !rect)) throw new Error('Green trees not found on the nature page');
const center = (tx, ty) => ({ x: (tx + 0.5) * TILE, y: (ty + 0.5) * TILE });

const objects = [
  // The house, its top-left on square (6, 5). Its door leads into the room.
  object(houses, houseRect, 6 * TILE, 5 * TILE, { blocks: true, door: center(33, 9) }),
  // The way back out, on the bottom wall of the room, to the path in front of the house.
  object(houses, doorRect, 33 * TILE + (TILE - doorRect.w) / 2, ROOM.y1 * TILE + (TILE - doorRect.h), {
    door: center(7, 9),
  }),
];
const treeSpots = [[1, 1], [14, 2], [2, 12], [18, 9], [12, 15], [23, 4], [24, 17], [3, 24], [19, 25], [25, 11]];
treeSpots.forEach(([tx, ty], i) => {
  objects.push(object(nature, treeRects[i % treeRects.length], tx * TILE, ty * TILE, { blocks: true }));
});

// The Boy from the pack, so Play works straight away. The pack lays out
// down, up, left, right across and the walk frames down; the app keeps
// down, left, right, up.
const boy = decodePng(path.join(pub, 'starter/ninja-adventure/characters/boy.png'));
const COLUMN_FOR = [0, 2, 3, 1];
const frames = [];
for (const col of COLUMN_FOR) {
  for (let row = 0; row < 4; row++) {
    const frame = Buffer.alloc(TILE * TILE * 4);
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const s = ((row * TILE + y) * boy.width + col * TILE + x) * 4;
        frame.set(boy.data.subarray(s, s + 4), (y * TILE + x) * 4);
      }
    }
    frames.push(frame.toString('base64'));
  }
}
const palette = [...new Set(
  Array.from({ length: boy.width * boy.height }, (_, i) => i * 4)
    .filter((o) => boy.data[o + 3] === 255)
    .map((o) => `#${[0, 1, 2].map((c) => boy.data[o + c].toString(16).padStart(2, '0')).join('')}`),
)].slice(0, 16);

const layer = (id, name, data, extra = {}) => ({
  id,
  kind: 'tiles',
  name,
  visible: true,
  locked: false,
  opacity: 1,
  collider: false,
  data: Buffer.from(data.buffer).toString('base64'),
  ...extra,
});

const project = {
  format: 'pixel-fusion-project',
  version: 2,
  name: 'Ninja Village',
  width: W,
  height: H,
  tileSize: TILE,
  background: '#1b1d24',
  tilesets: manifest.map((entry, index) => ({
    id: `starter-${index}`,
    name: entry.name,
    src: entry.url,
    tileW: TILE,
    tileH: TILE,
    margin: 0,
    spacing: 0,
    ...(entry.assets
      ? {
          splitMode: 'objects',
          assets: entry.assets,
          assetsVersion: detectVersion,
          assetsEdited: true,
          propsOnly: true,
          groundAssets: [],
        }
      : {}),
  })),
  layers: [
    layer('sample-ground', 'Ground', groundLayer),
    layer('sample-walls', 'Walls', walls, { visible: false, collider: true }),
    { id: 'sample-objects', kind: 'objects', name: 'Objects', visible: true, locked: false, opacity: 1, objects },
  ],
  activeLayer: 0,
  characters: [
    { id: 'sample-boy', name: 'Boy', tilesW: 1, tilesH: 1, w: TILE, h: TILE, frameCount: 4, frameMs: 140, palette, frames },
  ],
  lastPlayedCharacter: 'sample-boy',
  characterAt: { x: 7, y: 10 },
};

const out = path.join(pub, 'starter/sample-village.pfproj');
fs.writeFileSync(out, JSON.stringify(project));
console.log(`wrote ${path.relative(root, out)}: ${objects.length} objects, door ${JSON.stringify(doorRect)}`);
