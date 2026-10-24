import { describe, expect, it } from 'vitest';
import {
  deleteAssets,
  detectAssetsInMask,
  assetsInMask,
  findGround,
  isGroundSheetName,
  mergeAssets,
  type SheetGrid,
  type TileGrid,
} from './assets';

/** A sheet built from ASCII art: `#` is opaque, anything else transparent. */
function sheet(rows: string[]): { alpha: Uint8Array; w: number; h: number } {
  const h = rows.length;
  const w = rows[0].length;
  const alpha = new Uint8Array(w * h);
  rows.forEach((row, y) => [...row].forEach((ch, x) => (alpha[y * w + x] = ch === '#' ? 255 : 0)));
  return { alpha, w, h };
}

/** A w x h sheet with solid blocks at the given rects. */
function blocks(w: number, h: number, rects: [number, number, number, number][]) {
  const alpha = new Uint8Array(w * h);
  for (const [x0, y0, bw, bh] of rects) {
    for (let y = y0; y < y0 + bh; y++) for (let x = x0; x < x0 + bw; x++) alpha[y * w + x] = 255;
  }
  return alpha;
}

const tile: TileGrid = { w: 48, h: 48, margin: 0, spacing: 0 };

describe('finding props on a sheet', () => {
  it('finds each separate prop whole, fitted to its pixels', () => {
    const s = sheet([
      '..........',
      '.##....##.',
      '.##....##.',
      '..........',
      '....###...',
      '....###...',
    ]);
    expect(detectAssetsInMask(s.alpha, s.w, s.h, { minArea: 1 })).toEqual([
      { x: 1, y: 1, w: 2, h: 2 },
      { x: 7, y: 1, w: 2, h: 2 },
      { x: 4, y: 4, w: 3, h: 2 },
    ]);
  });

  it('keeps props a single pixel apart separate', () => {
    // The regression that fused stacked trees into one tall blob: sheets pack
    // separate props this close, so nothing may bridge the gap between them.
    const alpha = blocks(200, 200, [
      [0, 0, 96, 96],
      [0, 97, 96, 96],
    ]);
    expect(detectAssetsInMask(alpha, 200, 200, { tile })).toEqual([
      { x: 0, y: 0, w: 96, h: 96 },
      { x: 0, y: 97, w: 96, h: 96 },
    ]);
  });

  it('never cuts a large prop into grid squares', () => {
    // One 5x5-tile fountain: big, but a single piece of art.
    const alpha = blocks(400, 400, [[10, 10, 240, 240], [300, 300, 20, 20]]);
    expect(detectAssetsInMask(alpha, 400, 400, { tile })).toContainEqual({ x: 10, y: 10, w: 240, h: 240 });
  });

  it('drops specks too small to be a prop', () => {
    const alpha = blocks(200, 200, [[0, 0, 2, 2], [100, 100, 40, 40]]);
    expect(detectAssetsInMask(alpha, 200, 200, { tile, minArea: 16 })).toEqual([{ x: 100, y: 100, w: 40, h: 40 }]);
  });

  it('lists props in reading order, row by row', () => {
    const alpha = blocks(200, 200, [
      [100, 0, 40, 40],
      [0, 0, 40, 40],
      [0, 100, 40, 40],
    ]);
    expect(detectAssetsInMask(alpha, 200, 200, { tile }).map((r) => [r.x, r.y])).toEqual([
      [0, 0],
      [100, 0],
      [0, 100],
    ]);
  });
});

describe('rejoining detached scraps', () => {
  it('folds a tiny scrap hugging a big prop into it', () => {
    // A swing frame with a small seat shadow 2px below it.
    const alpha = blocks(200, 200, [[20, 20, 100, 60], [60, 82, 10, 4]]);
    expect(detectAssetsInMask(alpha, 200, 200, { tile })).toEqual([{ x: 20, y: 20, w: 100, h: 66 }]);
  });

  it('leaves a chair beside a table as its own prop', () => {
    // 15x15 is a real prop, not a scrap, even right next to something bigger.
    const alpha = blocks(200, 200, [[20, 20, 60, 60], [82, 40, 15, 15]]);
    expect(detectAssetsInMask(alpha, 200, 200, { tile })).toHaveLength(2);
  });

  it('leaves a scrap alone when nothing big is close enough', () => {
    const alpha = blocks(200, 200, [[20, 20, 60, 60], [100, 100, 8, 8]]);
    expect(detectAssetsInMask(alpha, 200, 200, { tile })).toHaveLength(2);
  });

  it('never lets two small props swallow each other', () => {
    // Two pebbles side by side: neither is big enough to be the other's parent.
    const alpha = blocks(200, 200, [[20, 20, 8, 8], [30, 20, 8, 8]]);
    expect(detectAssetsInMask(alpha, 200, 200, { tile })).toHaveLength(2);
  });
});

describe('fixing detection by hand', () => {
  const a = { x: 0, y: 0, w: 10, h: 10 };
  const b = { x: 20, y: 5, w: 10, h: 20 };
  const c = { x: 50, y: 50, w: 5, h: 5 };

  it('merging covers every picked asset and takes the first one’s place', () => {
    expect(mergeAssets([a, b, c], [2, 0])).toEqual([{ x: 0, y: 0, w: 55, h: 55 }, b]);
  });

  it('merging needs at least two assets', () => {
    expect(mergeAssets([a, b], [1])).toEqual([a, b]);
  });

  it('deleting removes only the picked assets', () => {
    expect(deleteAssets([a, b, c], [1])).toEqual([a, c]);
  });
});

describe('telling ground from props', () => {
  /** A 6 x 4 grid of 10px cells. */
  const grid: SheetGrid = { w: 10, h: 10, margin: 0, spacing: 0, cols: 6, rows: 4 };
  const W = 60;
  const H = 40;
  const cell = (col: number, row: number): [number, number, number, number] => [col * 10, row * 10, 10, 10];
  const groundAt = (cells: Uint8Array) =>
    [...cells].flatMap((v, i) => (v ? [`${i % grid.cols},${Math.floor(i / grid.cols)}`] : []));

  it('counts a run of solid cells as ground, but not one solid cell on its own', () => {
    const alpha = blocks(W, H, [cell(0, 0), cell(1, 0), cell(2, 0), cell(4, 2)]);
    expect(groundAt(findGround(alpha, W, H, grid).cells)).toEqual(['0,0', '1,0', '2,0']);
  });

  it('carries a floor on into a partly filled cell across a solid edge, like a path border', () => {
    // Floor along the top; below its first cell, a border filling the top half.
    const alpha = blocks(W, H, [cell(0, 0), cell(1, 0), [0, 10, 10, 5]]);
    expect(groundAt(findGround(alpha, W, H, grid).cells)).toContain('0,1');
  });

  it('does not let a prop that merely touches a floor become ground', () => {
    // A pole 2px wide standing on the floor's lower edge.
    const alpha = blocks(W, H, [cell(0, 0), cell(1, 0), [14, 10, 2, 10]]);
    expect(groundAt(findGround(alpha, W, H, grid).cells)).not.toContain('1,1');
  });

  it('is not fooled by a floor whose art spills a pixel past the grid line', () => {
    // The floor's bottom row of pixels lands in the cell below, above a small pot.
    const alpha = blocks(W, H, [cell(0, 0), cell(1, 0), [0, 10, 10, 1], [3, 14, 4, 6]]);
    expect(groundAt(findGround(alpha, W, H, grid).cells)).not.toContain('0,1');
  });

  it('counts legs hanging from a counter as part of it', () => {
    // A counter's front edge with two legs below, open in the middle.
    const alpha = blocks(W, H, [cell(0, 0), cell(1, 0), [0, 10, 10, 1], [0, 11, 2, 9], [8, 11, 2, 9]]);
    expect(groundAt(findGround(alpha, W, H, grid).cells)).toContain('0,1');
  });

  it('only reaches one cell out from a floor, so it cannot creep across a sheet', () => {
    // A border below the floor, and another border below that one.
    const alpha = blocks(W, H, [cell(0, 0), cell(1, 0), [0, 10, 10, 5], [0, 20, 10, 5]]);
    expect(groundAt(findGround(alpha, W, H, grid).cells)).not.toContain('0,2');
  });

  it('also offers small solid runs as props, since they are usually things like a fridge', () => {
    const alpha = blocks(W, H, [cell(5, 0), cell(5, 1), cell(0, 3), cell(1, 3), cell(2, 3), cell(3, 3)]);
    expect(findGround(alpha, W, H, grid).props).toEqual([{ x: 50, y: 0, w: 10, h: 20 }]);
  });

  it('treats every drawn cell of a ground sheet as ground, transparent edges and all', () => {
    const alpha = blocks(W, H, [cell(0, 0), [12, 2, 3, 3]]);
    expect(groundAt(findGround(alpha, W, H, grid, true).cells)).toEqual(['0,0', '1,0']);
  });

  it('finds a prop standing beside a floor on its own, instead of fused with the floor', () => {
    // A 3-cell floor with a bush pressed right up against its end.
    const alpha = blocks(W, H, [cell(0, 0), cell(1, 0), cell(2, 0), cell(3, 0), [40, 2, 8, 8]]);
    const ground = findGround(alpha, W, H, grid);
    expect(detectAssetsInMask(alpha, W, H, { minArea: 1, ground })).toEqual([{ x: 40, y: 2, w: 8, h: 8 }]);
  });

  it('lists every asset whole: props first, then each floor square on its own', () => {
    // A 4-cell floor, and a bush pressed against its end.
    const alpha = blocks(W, H, [cell(0, 0), cell(1, 0), cell(2, 0), cell(3, 0), [40, 2, 6, 6]]);
    expect(assetsInMask(alpha, W, H, grid, false)).toEqual([
      { x: 40, y: 2, w: 6, h: 6 },
      { x: 0, y: 0, w: 10, h: 10 },
      { x: 10, y: 0, w: 10, h: 10 },
      { x: 20, y: 0, w: 10, h: 10 },
      { x: 30, y: 0, w: 10, h: 10 },
    ]);
  });

  it('also offers a small solid run whole, like a fridge, as well as square by square', () => {
    const alpha = blocks(W, H, [cell(5, 0), cell(5, 1)]);
    expect(assetsInMask(alpha, W, H, grid, false)).toEqual([
      { x: 50, y: 0, w: 10, h: 20 },
      { x: 50, y: 0, w: 10, h: 10 },
      { x: 50, y: 10, w: 10, h: 10 },
    ]);
  });

  it('lists a ground sheet as all floor squares', () => {
    const alpha = blocks(W, H, [cell(0, 0), [12, 2, 3, 3]]);
    expect(assetsInMask(alpha, W, H, grid, true)).toEqual([
      { x: 0, y: 0, w: 10, h: 10 },
      { x: 10, y: 0, w: 10, h: 10 },
    ]);
  });

  it('reads sheet kinds from RPG Maker style names', () => {
    expect(isGroundSheetName('Tile_A2-1 (2)')).toBe(true);
    expect(isGroundSheetName('Auto-tile-A4-walls-3')).toBe(true);
    expect(isGroundSheetName('tile-B-01')).toBe(false);
    expect(isGroundSheetName('1')).toBe(false);
    expect(isGroundSheetName('Area 51')).toBe(false);
  });
});
