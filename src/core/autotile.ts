import type { AssetRect } from './doc';

/**
 * Quarters of an RPG Maker floor block (columns 0-3, rows 0-5 of half
 * squares) that make up the inside of a floor: top-left, top-right,
 * bottom-left, bottom-right. The pack draws them so that this square
 * repeats with no edge showing, which is what a rectangle of floor needs.
 */
const INSIDE: readonly (readonly [number, number])[] = [
  [2, 4],
  [1, 4],
  [2, 3],
  [1, 3],
];

/** Squares across a floor page, so its thumbnails come out in tidy rows. */
const FLOOR_COLUMNS = 8;

/**
 * A floor page straight from a pack (RPG Maker A2): blocks of 2 by 3 squares.
 * Old projects call these "Paths"; they are "Floors" now.
 */
export function isRawFloorSheet(name: string, imgW: number, imgH: number, tile: number): boolean {
  if (!/^(?:paths|floors) \d+$/i.test(name) || tile < 2 || tile % 2 !== 0) return false;
  return imgW % (tile * 2) === 0 && imgH % (tile * 3) === 0 && imgW >= tile * 2 && imgH >= tile * 3;
}

export interface FloorTiles {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  cols: number;
  rows: number;
  assets: AssetRect[];
}

/**
 * One seamless square per floor type on a pack's floor page, in reading
 * order. Painted next to itself, or across a whole rectangle, it joins with
 * no seams, because it is the inside of the floor rather than an edge.
 */
export function floorTiles(rgba: Uint8ClampedArray, width: number, height: number, tile: number): FloorTiles {
  const half = tile / 2;
  const blocksX = Math.floor(width / (tile * 2));
  const blocksY = Math.floor(height / (tile * 3));
  const squares: Uint8ClampedArray[] = [];
  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      if (!blockHasInk(rgba, width, bx * tile * 2, by * tile * 3, tile)) continue;
      squares.push(inside(rgba, width, bx * tile * 2, by * tile * 3, half));
    }
  }

  const cols = Math.max(1, Math.min(FLOOR_COLUMNS, squares.length));
  const rows = Math.max(1, Math.ceil(squares.length / cols));
  const outW = cols * tile;
  const outH = rows * tile;
  const out = new Uint8ClampedArray(outW * outH * 4);
  const assets: AssetRect[] = [];
  squares.forEach((square, i) => {
    const x = (i % cols) * tile;
    const y = Math.floor(i / cols) * tile;
    for (let py = 0; py < tile; py++) {
      out.set(square.subarray(py * tile * 4, (py + 1) * tile * 4), ((y + py) * outW + x) * 4);
    }
    assets.push({ x, y, w: tile, h: tile });
  });
  return { rgba: out, width: outW, height: outH, cols, rows, assets };
}

/** Where a floor type painted from an old "Paths" page lands on its floor page. */
export function floorIndexFromPath(index: number, pathStride: number): number {
  return Math.floor(index / pathStride);
}

function inside(src: Uint8ClampedArray, width: number, originX: number, originY: number, half: number): Uint8ClampedArray {
  const tile = half * 2;
  const out = new Uint8ClampedArray(tile * tile * 4);
  INSIDE.forEach(([qx, qy], i) => {
    const sx = originX + qx * half;
    const sy = originY + qy * half;
    const dx = (i % 2) * half;
    const dy = Math.floor(i / 2) * half;
    for (let y = 0; y < half; y++) {
      const s = ((sy + y) * width + sx) * 4;
      out.set(src.subarray(s, s + half * 4), ((dy + y) * tile + dx) * 4);
    }
  });
  return out;
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
