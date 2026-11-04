import { buildAutotiles, colourName, type AutotileBuild, type BlockSlot, type FormatGuess } from './formats';
import { createImage, type Rect, type RGBAImage } from './image';

/**
 * Terrain kits: the common layout where one material is drawn as a patch on
 * another inside a 3 x 3 block of cells, with its edge half a cell in, and
 * the inverse block (the other material as a patch on this one) beside it.
 * Pixel Fantasy Town's dirt paths, dark grass and cliff ponds are drawn so.
 *
 * Because the edge sits half a cell in, the patch's middle 4 x 4 quarters are
 * the same thing as an RPG Maker A2 block's lower 2 x 2 cells: corners,
 * edges and middle. The inverse block's quarters beside its hole give the
 * inner corners. Each kit is rearranged into a virtual A2 block and built
 * with the A2 rules, so it paints and checks exactly like an A2 floor.
 */

export interface KitPair {
  /** The material drawn as a patch inside this block. */
  patch: Rect;
  /** The block with the surrounding material drawn as a patch inside this one. */
  inverse: Rect;
  inside: [number, number, number];
  outside: [number, number, number];
}

type RGB = [number, number, number];
const dist = (a: RGB, b: RGB) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);

function meanColour(image: RGBAImage, r: Rect): { colour: RGB; solid: number } {
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  let n = 0;
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      const i = (y * image.width + x) * 4;
      if (image.data[i + 3] < 200) continue;
      s0 += image.data[i];
      s1 += image.data[i + 1];
      s2 += image.data[i + 2];
      n++;
    }
  }
  return { colour: n ? [s0 / n, s1 / n, s2 / n] : [0, 0, 0], solid: n / (r.w * r.h) };
}

/** Share of a quarter's pixels nearer `a` than `b`. */
function share(image: RGBAImage, r: Rect, a: RGB, b: RGB): number {
  let near = 0;
  let n = 0;
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      const i = (y * image.width + x) * 4;
      const c: RGB = [image.data[i], image.data[i + 1], image.data[i + 2]];
      n++;
      if (dist(c, a) < dist(c, b)) near++;
    }
  }
  return n ? near / n : 0;
}

/** Share of a quarter's pixels that are neither material: a rim, a cliff, an outline. */
function foreign(image: RGBAImage, r: Rect, a: RGB, b: RGB): number {
  let far = 0;
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      const i = (y * image.width + x) * 4;
      const c: RGB = [image.data[i], image.data[i + 1], image.data[i + 2]];
      if (dist(c, a) > 90 && dist(c, b) > 90) far++;
    }
  }
  return far / (r.w * r.h);
}

/** Ring quarters of a 6 x 6 quarter block: the outer band. */
const RING: [number, number][] = [];
for (let q = 0; q < 6; q++) RING.push([q, 0], [q, 5], ...(q > 0 && q < 5 ? ([[0, q], [5, q]] as [number, number][]) : []));
/** The four quarters of the centre cell. */
const CENTRE: [number, number][] = [
  [2, 2],
  [3, 2],
  [2, 3],
  [3, 3],
];

/** How well a 3 x 3 block reads as one material patched onto another: null when it does not. */
function readBlock(image: RGBAImage, x: number, y: number, cell: number): { inside: RGB; outside: RGB; score: number } | null {
  const half = cell / 2;
  const block = { x, y, w: 3 * cell, h: 3 * cell };
  if (meanColour(image, block).solid < 0.97) return null;
  const q = (qx: number, qy: number): Rect => ({ x: x + qx * half, y: y + qy * half, w: half, h: half });
  const centre = meanColour(image, { x: x + cell, y: y + cell, w: cell, h: cell });
  const corners = [q(0, 0), q(5, 0), q(0, 5), q(5, 5)].map((r) => meanColour(image, r).colour);
  const outside: RGB = [0, 1, 2].map((k) => corners.reduce((s, c) => s + c[k], 0) / 4) as RGB;
  const inside = centre.colour;
  if (dist(inside, outside) < 30) return null;
  // The corners must agree on what surrounds the patch.
  if (corners.some((c) => dist(c, outside) > 45)) return null;
  const ring = RING.reduce((s, [qx, qy]) => s + share(image, q(qx, qy), outside, inside), 0) / RING.length;
  const middle = CENTRE.reduce((s, [qx, qy]) => s + share(image, q(qx, qy), inside, outside), 0) / CENTRE.length;
  if (ring < 0.7 || middle < 0.85) return null;
  // Between them the boundary is drawn: the quarters just inside are mixed.
  const edges: [number, number][] = [
    [2, 1],
    [3, 1],
    [1, 2],
    [1, 3],
    [4, 2],
    [4, 3],
    [2, 4],
    [3, 4],
  ];
  // A drawn rim between the two (a cliff round a pond) is a third colour and counts as boundary too.
  const mixed = edges.filter(([qx, qy]) => {
    const s = share(image, q(qx, qy), inside, outside);
    return (s > 0.1 && s < 0.97) || foreign(image, q(qx, qy), inside, outside) >= 0.1;
  }).length;
  if (mixed < 6) return null;
  return { inside, outside, score: ring + middle };
}

/** Every patch-and-inverse pair on a sheet, without overlapping blocks. */
export function findKits(image: RGBAImage, cell: number): KitPair[] {
  if (cell < 8 || cell % 2) return [];
  const blocks: { rect: Rect; inside: RGB; outside: RGB; score: number }[] = [];
  for (let y = 0; y + 3 * cell <= image.height; y += cell) {
    for (let x = 0; x + 3 * cell <= image.width; x += cell) {
      const read = readBlock(image, x, y, cell);
      if (read) blocks.push({ rect: { x, y, w: 3 * cell, h: 3 * cell }, ...read });
    }
  }
  blocks.sort((a, b) => b.score - a.score);
  const kept: typeof blocks = [];
  const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  for (const b of blocks) if (!kept.some((k) => overlaps(k.rect, b.rect))) kept.push(b);
  const pairs: KitPair[] = [];
  for (const a of kept) {
    // The inverse has the colours the other way round.
    const inverse = kept.find((b) => b !== a && dist(b.inside, a.outside) < 25 && dist(b.outside, a.inside) < 25);
    if (inverse) pairs.push({ patch: a.rect, inverse: inverse.rect, inside: a.inside, outside: a.outside });
  }
  return pairs;
}

/** Where a patch's edge is drawn on each side, in quarters of its 3 x 3 block. */
interface Edges {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/**
 * Kits are drawn in perspective: a pond's back wall sits half a cell in, its
 * near lip right at the block's edge. Each side's edge quarters are taken
 * from wherever that side's boundary is actually drawn: the inset position,
 * or one quarter further out when the inset quarters are still all patch.
 */
function patchEdges(image: RGBAImage, block: Rect, inside: RGB, outside: RGB, cell: number): Edges {
  const half = cell / 2;
  const q = (qx: number, qy: number): Rect => ({ x: block.x + qx * half, y: block.y + qy * half, w: half, h: half });
  const clean = (cells: [number, number][]) =>
    cells.every(([qx, qy]) => share(image, q(qx, qy), inside, outside) >= 0.98 && foreign(image, q(qx, qy), inside, outside) < 0.02);
  const boundary = (cells: [number, number][]) =>
    cells.every(([qx, qy]) => {
      const s = share(image, q(qx, qy), inside, outside);
      // Only a sliver is enough here: the side is only moved when the inset quarters are entirely patch.
      return (s > 0.03 && s < 0.9) || foreign(image, q(qx, qy), inside, outside) >= 0.03;
    });
  const side = (inset: [number, number][], out: [number, number][], at: number, further: number) => (clean(inset) && boundary(out) ? further : at);
  return {
    top: side([[2, 1], [3, 1]], [[2, 0], [3, 0]], 1, 0),
    bottom: side([[2, 4], [3, 4]], [[2, 5], [3, 5]], 4, 5),
    left: side([[1, 2], [1, 3]], [[0, 2], [0, 3]], 1, 0),
    right: side([[4, 2], [4, 3]], [[5, 2], [5, 3]], 4, 5),
  };
}

/**
 * The virtual A2 block for one kit: preview from the patch's centre cell,
 * inner corners from just outside the inverse block's hole, and the patch's
 * corners, edges and middle from where each side's edge is drawn.
 */
export function kitAsA2(image: RGBAImage, kit: KitPair, cell: number): RGBAImage {
  const half = cell / 2;
  const out = createImage(2 * cell, 3 * cell);
  const copy = (from: Rect, sx: number, sy: number, dx: number, dy: number) => {
    for (let y = 0; y < half; y++) {
      const src = ((from.y + sy * half + y) * image.width + from.x + sx * half) * 4;
      out.data.set(image.data.subarray(src, src + half * 4), ((dy * half + y) * out.width + dx * half) * 4);
    }
  };
  const p = patchEdges(image, kit.patch, kit.inside, kit.outside, cell);
  const hole = patchEdges(image, kit.inverse, kit.outside, kit.inside, cell);
  // Preview: the centre cell.
  copy(kit.patch, 2, 2, 0, 0);
  copy(kit.patch, 3, 2, 1, 0);
  copy(kit.patch, 2, 3, 0, 1);
  copy(kit.patch, 3, 3, 1, 1);
  // Inner corners, A2 quarters [2,0] TL, [3,0] TR, [2,1] BL, [3,1] BR: the
  // quarter diagonally outside each corner of the inverse block's hole.
  // Where the hole reaches the block's edge there is none, and the middle
  // stands in.
  const inner = (qx: number, qy: number, dx: number, dy: number) => {
    if (qx < 0 || qy < 0 || qx > 5 || qy > 5) copy(kit.patch, 2 + (dx % 2), 2 + (dy % 2), dx, dy);
    else copy(kit.inverse, qx, qy, dx, dy);
  };
  inner(hole.right + 1, hole.bottom + 1, 2, 0);
  inner(hole.left - 1, hole.bottom + 1, 3, 0);
  inner(hole.right + 1, hole.top - 1, 2, 1);
  inner(hole.left - 1, hole.top - 1, 3, 1);
  // Corners, edges and middle: A2 quarters (0..3, 2..5).
  const cols = [p.left, 2, 3, p.right];
  const rows = [p.top, 2, 3, p.bottom];
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) copy(kit.patch, cols[c], rows[r], c, r + 2);
  return out;
}

/** Builds every kit on a sheet into terrain, one material per kit, ready for the painter. */
export function buildKits(image: RGBAImage, cell: number, sourceName: string, kits = findKits(image, cell)): AutotileBuild | null {
  if (kits.length === 0) return null;
  const blocks = kits.map((kit) => kitAsA2(image, kit, cell));
  // Lay the virtual blocks side by side as a sheet the A2 builder reads.
  const sheet = createImage(blocks.length * 2 * cell, 3 * cell);
  blocks.forEach((b, i) => {
    for (let y = 0; y < b.height; y++) sheet.data.set(b.data.subarray(y * b.width * 4, (y + 1) * b.width * 4), (y * sheet.width + i * 2 * cell) * 4);
  });
  const slots: BlockSlot[] = blocks.map((_, i) => ({ index: i, role: 'floor', kind: 'floor', rect: { x: i * 2 * cell, y: 0, w: 2 * cell, h: 3 * cell } }));
  const guess: FormatGuess = {
    format: 'rpgmaker-a2',
    cell,
    slots,
    byName: false,
    autotiles: true,
    note: `Terrain kit: ${kits.length} material${kits.length === 1 ? '' : 's'} drawn as a patch in a 3 x 3 block beside its inverse, assembled with the A2 rules.`,
  };
  // "cream on green": what is painted, then what it is painted onto.
  const names = kits.map((kit) => `${colourName(solidTile(kit.inside))} on ${colourName(solidTile(kit.outside))}`);
  const build = buildAutotiles(sheet, guess, sourceName, names);
  build.sheet.format = 'terrain-kit';
  // Sources point back at the original sheet, not the virtual one.
  build.sheet.materials.forEach((m, i) => {
    m.source = { ...kits[build.slotOf[i]].patch };
  });
  return build;
}

/** A one-pixel tile of a colour, for naming it. */
function solidTile(c: RGB): { width: number; height: number; data: Uint8ClampedArray } {
  return { width: 1, height: 1, data: new Uint8ClampedArray([c[0], c[1], c[2], 255]) };
}
