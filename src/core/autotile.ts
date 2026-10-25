import type { AssetRect } from './doc';

/** How many placeable pieces each ground type gets: centre, edges, bends, straights, ends. */
export const PATH_STRIDE = 15;

/**
 * Quarter of the autotile block (columns 0-3, rows 0-5 of half-tiles) for
 * each of the 48 RPG Maker floor shapes. Order is top-left, top-right,
 * bottom-left, bottom-right.
 */
const FLOOR: readonly (readonly [number, number])[][] = [
  [[2, 4], [1, 4], [2, 3], [1, 3]], [[2, 0], [1, 4], [2, 3], [1, 3]], [[2, 4], [3, 0], [2, 3], [1, 3]], [[2, 0], [3, 0], [2, 3], [1, 3]],
  [[2, 4], [1, 4], [2, 3], [3, 1]], [[2, 0], [1, 4], [2, 3], [3, 1]], [[2, 4], [3, 0], [2, 3], [3, 1]], [[2, 0], [3, 0], [2, 3], [3, 1]],
  [[2, 4], [1, 4], [2, 1], [1, 3]], [[2, 0], [1, 4], [2, 1], [1, 3]], [[2, 4], [3, 0], [2, 1], [1, 3]], [[2, 0], [3, 0], [2, 1], [1, 3]],
  [[2, 4], [1, 4], [2, 1], [3, 1]], [[2, 0], [1, 4], [2, 1], [3, 1]], [[2, 4], [3, 0], [2, 1], [3, 1]], [[2, 0], [3, 0], [2, 1], [3, 1]],
  [[0, 4], [1, 4], [0, 3], [1, 3]], [[0, 4], [3, 0], [0, 3], [1, 3]], [[0, 4], [1, 4], [0, 3], [3, 1]], [[0, 4], [3, 0], [0, 3], [3, 1]],
  [[2, 2], [1, 2], [2, 3], [1, 3]], [[2, 2], [1, 2], [2, 3], [3, 1]], [[2, 2], [1, 2], [2, 1], [1, 3]], [[2, 2], [1, 2], [2, 1], [3, 1]],
  [[2, 4], [3, 4], [2, 3], [3, 3]], [[2, 4], [3, 4], [2, 1], [3, 3]], [[2, 0], [3, 4], [2, 3], [3, 3]], [[2, 0], [3, 4], [2, 1], [3, 3]],
  [[2, 4], [1, 4], [2, 5], [1, 5]], [[2, 0], [1, 4], [2, 5], [1, 5]], [[2, 4], [3, 0], [2, 5], [1, 5]], [[2, 0], [3, 0], [2, 5], [1, 5]],
  [[0, 4], [3, 4], [0, 3], [3, 3]], [[2, 2], [1, 2], [2, 5], [1, 5]], [[0, 2], [1, 2], [0, 3], [1, 3]], [[0, 2], [1, 2], [0, 3], [3, 1]],
  [[2, 2], [3, 2], [2, 3], [3, 3]], [[2, 2], [3, 2], [2, 1], [3, 3]], [[2, 4], [3, 4], [2, 5], [3, 5]], [[2, 0], [3, 4], [2, 5], [3, 5]],
  [[0, 4], [1, 4], [0, 5], [1, 5]], [[0, 4], [3, 0], [0, 5], [1, 5]], [[0, 2], [3, 2], [0, 3], [3, 3]], [[0, 2], [1, 2], [0, 5], [1, 5]],
  [[0, 4], [3, 4], [0, 5], [3, 5]], [[2, 2], [3, 2], [2, 5], [3, 5]], [[0, 2], [3, 2], [0, 5], [3, 5]], [[0, 0], [1, 0], [0, 1], [1, 1]],
];

/** Which piece to draw for a cell, from whether the same path continues in each direction. */
export function pathRole(north: boolean, east: boolean, south: boolean, west: boolean): number {
  const borders = (!north ? 1 : 0) | (!east ? 2 : 0) | (!south ? 4 : 0) | (!west ? 8 : 0);
  return [0, 1, 2, 5, 3, 9, 6, 11, 4, 8, 10, 13, 7, 12, 14, 0][borders];
}

/** A ground page straight from the pack: blocks of 2 by 3 tiles, not the expanded set. */
export function isRawPathSheet(name: string, imgW: number, imgH: number, tile: number): boolean {
  if (!/^paths \d+$/i.test(name) || tile < 2 || tile % 2 !== 0) return false;
  return imgW % (tile * 2) === 0 && imgH % (tile * 3) === 0 && imgW >= tile * 2 && imgH >= tile * 3;
}

export interface ExpandedPaths {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  cols: number;
  rows: number;
  assets: AssetRect[];
}

/**
 * Turns one autotile page into rows of pieces that meet: the centre, the four
 * edges, the four bends, the two straights, and the four ends.
 */
export function expandPathSheet(rgba: Uint8ClampedArray, width: number, height: number, tile: number): ExpandedPaths {
  const half = tile / 2;
  const blocksX = Math.floor(width / (tile * 2));
  const blocksY = Math.floor(height / (tile * 3));
  const rows: Uint8ClampedArray[] = [];

  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      if (!blockHasInk(rgba, width, bx * tile * 2, by * tile * 3, tile)) continue;
      const shapes = FLOOR.map((_, shape) => compose(rgba, width, bx * tile * 2, by * tile * 3, half, shape));
      const center = calmest(shapes, tile);
      const row = new Uint8ClampedArray(PATH_STRIDE * tile * tile * 4);
      for (let role = 0; role < PATH_STRIDE; role++) {
        const shape = pickShape(shapes, center, roleMask(role), tile);
        blitTile(shapes[shape], row, role * tile, 0, tile, PATH_STRIDE * tile);
      }
      rows.push(row);
    }
  }

  const cols = PATH_STRIDE;
  const outW = cols * tile;
  const outH = Math.max(1, rows.length) * tile;
  const out = new Uint8ClampedArray(outW * outH * 4);
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y];
    for (let py = 0; py < tile; py++) {
      for (let px = 0; px < outW; px++) {
        const s = (py * outW + px) * 4;
        const d = ((y * tile + py) * outW + px) * 4;
        out[d] = row[s];
        out[d + 1] = row[s + 1];
        out[d + 2] = row[s + 2];
        out[d + 3] = row[s + 3];
      }
    }
  }

  const assets: AssetRect[] = [];
  for (let row = 0; row < rows.length; row++) {
    for (let col = 0; col < cols; col++) {
      if (opaque(out, outW, col * tile, row * tile, tile) < 8) continue;
      assets.push({ x: col * tile, y: row * tile, w: tile, h: tile });
    }
  }
  return { rgba: out, width: outW, height: outH, cols, rows: rows.length, assets };
}

/** Sides that should show the outside of the path for each role. Bit 1 top, 2 right, 4 bottom, 8 left. */
function roleMask(role: number): number {
  return [0, 1, 2, 4, 8, 1 | 2, 4 | 2, 4 | 8, 1 | 8, 1 | 4, 2 | 8, 1 | 2 | 4, 1 | 4 | 8, 1 | 2 | 8, 2 | 4 | 8][role];
}

function compose(
  src: Uint8ClampedArray,
  width: number,
  originX: number,
  originY: number,
  half: number,
  shape: number,
): Uint8ClampedArray {
  const tile = half * 2;
  const out = new Uint8ClampedArray(tile * tile * 4);
  FLOOR[shape].forEach(([qx, qy], i) => {
    const sx = originX + qx * half;
    const sy = originY + qy * half;
    const dx = (i % 2) * half;
    const dy = Math.floor(i / 2) * half;
    for (let y = 0; y < half; y++) {
      for (let x = 0; x < half; x++) {
        const s = ((sy + y) * width + (sx + x)) * 4;
        const d = ((dy + y) * tile + (dx + x)) * 4;
        out[d] = src[s];
        out[d + 1] = src[s + 1];
        out[d + 2] = src[s + 2];
        out[d + 3] = src[s + 3];
      }
    }
  });
  return out;
}

function blitTile(tile: Uint8ClampedArray, dest: Uint8ClampedArray, dx: number, dy: number, tileSize: number, destW: number): void {
  for (let y = 0; y < tileSize; y++) {
    for (let x = 0; x < tileSize; x++) {
      const s = (y * tileSize + x) * 4;
      const d = ((dy + y) * destW + (dx + x)) * 4;
      dest[d] = tile[s];
      dest[d + 1] = tile[s + 1];
      dest[d + 2] = tile[s + 2];
      dest[d + 3] = tile[s + 3];
    }
  }
}

/** The shape whose edges match its own middle: the piece that repeats cleanly. */
function calmest(shapes: Uint8ClampedArray[], tile: number): number {
  let best = 0;
  let score = Number.POSITIVE_INFINITY;
  for (let i = 0; i < shapes.length; i++) {
    const mid = average(shapes[i], tile, tile / 2 - 4, tile / 2 - 4, 8, 8);
    let diff = 0;
    diff += distance(average(shapes[i], tile, 0, 8, 3, tile - 16), mid);
    diff += distance(average(shapes[i], tile, tile - 3, 8, 3, tile - 16), mid);
    diff += distance(average(shapes[i], tile, 8, 0, tile - 16, 3), mid);
    diff += distance(average(shapes[i], tile, 8, tile - 3, tile - 16, 3), mid);
    if (diff < score) {
      score = diff;
      best = i;
    }
  }
  return best;
}

function pickShape(shapes: Uint8ClampedArray[], center: number, mask: number, tile: number): number {
  const base = sides(shapes[center], tile);
  let best = center;
  let score = Number.POSITIVE_INFINITY;
  const bits = [1, 2, 4, 8];
  for (let i = 0; i < shapes.length; i++) {
    const mine = sides(shapes[i], tile);
    let total = 0;
    for (let s = 0; s < 4; s++) {
      const diff = distance(mine[s], base[s]);
      total += mask & bits[s] ? Math.max(0, 48 - diff) : diff;
    }
    if (total < score) {
      score = total;
      best = i;
    }
  }
  return best;
}

function sides(px: Uint8ClampedArray, tile: number): [number, number, number][] {
  return [
    average(px, tile, 8, 0, tile - 16, 3),
    average(px, tile, tile - 3, 8, 3, tile - 16),
    average(px, tile, 8, tile - 3, tile - 16, 3),
    average(px, tile, 0, 8, 3, tile - 16),
  ];
}

function average(px: Uint8ClampedArray, tile: number, x: number, y: number, w: number, h: number): [number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      const i = (yy * tile + xx) * 4;
      if (px[i + 3] < 16) continue;
      r += px[i];
      g += px[i + 1];
      b += px[i + 2];
      n++;
    }
  }
  return n ? [r / n, g / n, b / n] : [0, 0, 0];
}

function distance(a: [number, number, number], b: [number, number, number]): number {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
}

function blockHasInk(src: Uint8ClampedArray, width: number, x: number, y: number, tile: number): boolean {
  return opaque(src, width, x, y, tile * 2) > 24 || opaque(src, width, x, y + tile, tile * 2) > 24;
}

function opaque(src: Uint8ClampedArray, width: number, x: number, y: number, size: number): number {
  let n = 0;
  const x1 = Math.min(width, x + size);
  for (let yy = y; yy < y + size; yy += 3) {
    for (let xx = x; xx < x1; xx += 3) {
      if (src[(yy * width + xx) * 4 + 3] > 24) n++;
    }
  }
  return n;
}
