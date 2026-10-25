import type { AssetRect } from './doc';

/**
 * Pieces built for each ground type: the 47 RPG Maker floor shapes, which
 * cover every way the squares around one can continue, inner corners
 * included. The 48th shape in the table is only the pack's preview square.
 */
export const PATH_STRIDE = 47;

/** The piece shown for a path type in the library: one square on its own. */
export const PATH_PREVIEW = 46;

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

/** Whether the same path continues into each of the eight squares around one. */
export interface Neighbours {
  n: boolean;
  ne: boolean;
  e: boolean;
  se: boolean;
  s: boolean;
  sw: boolean;
  w: boolean;
  nw: boolean;
}

type Half = readonly [number, number];

/**
 * One quarter of a square, from its two side neighbours and the diagonal
 * between them: inside the path, an inner corner where only the diagonal is
 * missing, an edge along the side that stops, or an outer corner.
 */
function quarter(
  vertical: boolean,
  horizontal: boolean,
  diagonal: boolean,
  pieces: { inside: Half; inner: Half; side: Half; top: Half; corner: Half },
): Half {
  if (vertical && horizontal) return diagonal ? pieces.inside : pieces.inner;
  if (vertical) return pieces.side;
  if (horizontal) return pieces.top;
  return pieces.corner;
}

const SHAPE_OF = new Map<string, number>();
FLOOR.forEach((quarters, shape) => {
  const key = quarters.map(([x, y]) => `${x},${y}`).join(';');
  if (!SHAPE_OF.has(key)) SHAPE_OF.set(key, shape);
});

/** Which of the 47 floor shapes a square takes, given which neighbours are the same path. */
export function pathShape(around: Neighbours): number {
  const { n, ne, e, se, s, sw, w, nw } = around;
  const quarters = [
    quarter(n, w, nw, { inside: [2, 4], inner: [2, 0], side: [0, 4], top: [2, 2], corner: [0, 2] }),
    quarter(n, e, ne, { inside: [1, 4], inner: [3, 0], side: [3, 4], top: [1, 2], corner: [3, 2] }),
    quarter(s, w, sw, { inside: [2, 3], inner: [2, 1], side: [0, 3], top: [2, 5], corner: [0, 5] }),
    quarter(s, e, se, { inside: [1, 3], inner: [3, 1], side: [3, 3], top: [1, 5], corner: [3, 5] }),
  ];
  return SHAPE_OF.get(quarters.map(([x, y]) => `${x},${y}`).join(';')) ?? PATH_PREVIEW;
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
 * Turns one autotile page into rows of pieces, one row per ground type, built
 * from the pack's 2 by 3 block exactly as RPG Maker assembles them.
 */
export function expandPathSheet(rgba: Uint8ClampedArray, width: number, height: number, tile: number): ExpandedPaths {
  const half = tile / 2;
  const blocksX = Math.floor(width / (tile * 2));
  const blocksY = Math.floor(height / (tile * 3));
  const rows: Uint8ClampedArray[] = [];

  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      if (!blockHasInk(rgba, width, bx * tile * 2, by * tile * 3, tile)) continue;
      const row = new Uint8ClampedArray(PATH_STRIDE * tile * tile * 4);
      for (let shape = 0; shape < PATH_STRIDE; shape++) {
        const piece = compose(rgba, width, bx * tile * 2, by * tile * 3, half, shape);
        blitTile(piece, row, shape * tile, 0, tile, PATH_STRIDE * tile);
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

  // One thumbnail per ground type. Painting picks the right piece around it,
  // so offering every corner and edge separately would only be clutter.
  const assets: AssetRect[] = [];
  for (let row = 0; row < rows.length; row++) {
    const x = PATH_PREVIEW * tile;
    if (opaque(out, outW, x, row * tile, tile) < 8) continue;
    assets.push({ x, y: row * tile, w: tile, h: tile });
  }
  return { rgba: out, width: outW, height: outH, cols, rows: rows.length, assets };
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
