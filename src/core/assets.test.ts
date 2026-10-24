import { describe, expect, it } from 'vitest';
import { detectAssetsInMask, splitAssetByGrid, type TileGrid } from './assets';

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

describe('splitting by hand into tiles', () => {
  it('cuts a strip of blended art into one asset per tile', () => {
    // Three tulip beds drawn to tile into each other: a solid 144x48 strip.
    const alpha = blocks(200, 100, [[0, 0, 144, 48]]);
    expect(splitAssetByGrid(alpha, 200, { x: 0, y: 0, w: 144, h: 48 }, tile)).toEqual([
      { x: 0, y: 0, w: 48, h: 48 },
      { x: 48, y: 0, w: 48, h: 48 },
      { x: 96, y: 0, w: 48, h: 48 },
    ]);
  });

  it('skips empty cells and fits each piece tightly', () => {
    const alpha = blocks(200, 100, [[4, 4, 20, 20], [100, 10, 30, 30]]);
    expect(splitAssetByGrid(alpha, 200, { x: 0, y: 0, w: 144, h: 48 }, tile)).toEqual([
      { x: 4, y: 4, w: 20, h: 20 },
      { x: 100, y: 10, w: 30, h: 30 },
    ]);
  });
});
