import { describe, expect, it } from 'vitest';
import { detectAssetsInMask, type TileGrid } from './assets';

/** A sheet built from ASCII art: `#` is opaque, anything else transparent. */
function sheet(rows: string[]): { alpha: Uint8Array; w: number; h: number } {
  const h = rows.length;
  const w = rows[0].length;
  const alpha = new Uint8Array(w * h);
  rows.forEach((row, y) => [...row].forEach((ch, x) => (alpha[y * w + x] = ch === '#' ? 255 : 0)));
  return { alpha, w, h };
}

/** Fills a w x h sheet with solid blocks at the given rects. */
function blocks(w: number, h: number, rects: [number, number, number, number][]) {
  const alpha = new Uint8Array(w * h);
  for (const [x0, y0, bw, bh] of rects) {
    for (let y = y0; y < y0 + bh; y++) for (let x = x0; x < x0 + bw; x++) alpha[y * w + x] = 255;
  }
  return alpha;
}

describe('finding props on a sheet', () => {
  it('finds each well-separated prop, fitted to its pixels', () => {
    const s = sheet([
      '..........',
      '.##....##.',
      '.##....##.',
      '..........',
      '..........',
      '..........',
      '....###...',
      '....###...',
    ]);
    const found = detectAssetsInMask(s.alpha, s.w, s.h, { minArea: 1 });
    expect(found).toEqual([
      { x: 1, y: 1, w: 2, h: 2 },
      { x: 7, y: 1, w: 2, h: 2 },
      { x: 4, y: 6, w: 3, h: 2 },
    ]);
  });

  it('bridges a gap of exactly `gap` pixels but not one wider', () => {
    const bridged = sheet(['##..##']);
    expect(detectAssetsInMask(bridged.alpha, bridged.w, bridged.h, { minArea: 1, gap: 2 })).toHaveLength(1);
    const apart = sheet(['##...##']);
    expect(detectAssetsInMask(apart.alpha, apart.w, apart.h, { minArea: 1, gap: 2 })).toHaveLength(2);
  });

  it('keeps a prop whole when its parts nearly touch', () => {
    // A canopy over a trunk, one transparent row between them.
    const s = sheet(['.####.', '.####.', '......', '..##..', '..##..']);
    expect(detectAssetsInMask(s.alpha, s.w, s.h, { minArea: 1 })).toEqual([{ x: 1, y: 0, w: 4, h: 5 }]);
  });

  it('drops scraps too small to be a prop', () => {
    const s = sheet(['#........', '.........', '.........', '.........', '....####.', '....####.']);
    expect(detectAssetsInMask(s.alpha, s.w, s.h, { minArea: 4 })).toEqual([{ x: 4, y: 4, w: 4, h: 2 }]);
  });

  it('lists props in reading order, row by row', () => {
    const s = sheet(['##...##', '##...##', '.......', '.......', '.......', '##.....', '##.....']);
    const found = detectAssetsInMask(s.alpha, s.w, s.h, { minArea: 1 });
    expect(found.map((r) => [r.x, r.y])).toEqual([
      [0, 0],
      [5, 0],
      [0, 5],
    ]);
  });
});

describe('densely packed sheets', () => {
  // RPG Maker style: 16px props packed edge to edge on a 16px grid, so there
  // is no transparency at all between neighbours. Transparency alone fuses
  // the whole block into one giant "prop".
  const tile: TileGrid = { w: 16, h: 16, margin: 0, spacing: 0 };

  it('splits a fused block back into its grid cells instead of one giant prop', () => {
    const w = 128;
    const h = 128;
    // A 6x6 block of touching props in one corner, plus one loose prop.
    const alpha = blocks(w, h, [
      [0, 0, 96, 96],
      [112, 112, 12, 12],
    ]);
    const found = detectAssetsInMask(alpha, w, h, { tile });

    expect(found.every((r) => r.w <= 16 && r.h <= 16)).toBe(true);
    // 36 cells from the block, plus the loose prop.
    expect(found).toHaveLength(37);
    expect(found).toContainEqual({ x: 112, y: 112, w: 12, h: 12 });
  });

  it('leaves a large but genuinely single prop alone when it is not oversized', () => {
    const w = 256;
    const h = 256;
    // A 3x3-tile prop: big, but well under the oversize threshold.
    const alpha = blocks(w, h, [[10, 10, 48, 48]]);
    expect(detectAssetsInMask(alpha, w, h, { tile })).toEqual([{ x: 10, y: 10, w: 48, h: 48 }]);
  });

  it('un-fuses props that only merged because of gap bridging, keeping each whole', () => {
    const w = 160;
    const h = 160;
    // A 6x6 grid of 14px props with 2px gaps. Bridging the gaps fuses them
    // into one huge blob, but they are separate by transparency, so the
    // second pass recovers each prop intact rather than cutting cells.
    const grid: [number, number, number, number][] = [];
    for (let row = 0; row < 6; row++) for (let col = 0; col < 6; col++) grid.push([col * 16, row * 16, 14, 14]);
    const alpha = blocks(w, h, [...grid, [130, 130, 12, 12], [130, 100, 12, 12]]);

    const found = detectAssetsInMask(alpha, w, h, { tile, gap: 2 });
    const props = found.filter((r) => r.x < 128 && r.y < 128);
    expect(props).toHaveLength(36);
    expect(props.every((r) => r.w === 14 && r.h === 14)).toBe(true);
  });

  it('keeps a lone large prop whole even though it spans many tiles', () => {
    // One big building is the only thing on the sheet: nothing to be an
    // outlier against, so it must not be chopped into grid cells.
    const w = 128;
    const h = 128;
    const alpha = blocks(w, h, [[0, 0, 96, 96]]);
    expect(detectAssetsInMask(alpha, w, h, { tile })).toEqual([{ x: 0, y: 0, w: 96, h: 96 }]);
  });

  it('without a known grid, an oversized block is kept rather than guessed at', () => {
    const w = 64;
    const h = 64;
    const alpha = blocks(w, h, [[0, 0, 48, 48]]);
    expect(detectAssetsInMask(alpha, w, h)).toEqual([{ x: 0, y: 0, w: 48, h: 48 }]);
  });
});
