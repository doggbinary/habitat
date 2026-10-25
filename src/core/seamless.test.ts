import { describe, expect, it } from 'vitest';
import { isSolid, seamlessFloor } from './seamless';

const W = 100;

/**
 * A dirt plot: a 90 px square with cut-off corners and a dark 3 px outline,
 * filled with a smooth left-to-right ramp so seams are easy to measure.
 */
function plot(): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(W * W * 4);
  for (let y = 5; y < 95; y++) {
    for (let x = 5; x < 95; x++) {
      const dx = Math.min(x - 5, 94 - x);
      const dy = Math.min(y - 5, 94 - y);
      if (dx + dy < 8) continue;
      const rim = dx < 3 || dy < 3;
      rgba.set(rim ? [20, 10, 5, 255] : [100 + x, 60 + y, 30, 255], (y * W + x) * 4);
    }
  }
  return rgba;
}

const at = (px: Uint8ClampedArray, size: number, x: number, y: number) => [...px.subarray((y * size + x) * 4, (y * size + x) * 4 + 4)];

describe('seamlessFloor', () => {
  it('cuts a fully painted square from inside the outline', () => {
    const square = seamlessFloor(plot(), W, { x: 5, y: 5, w: 90, h: 90 }, 48)!;
    expect(square).not.toBeNull();
    for (let i = 0; i < 48 * 48; i++) {
      expect(square[i * 4 + 3]).toBe(255);
      expect(square[i * 4]).toBeGreaterThan(20);
    }
  });

  it('runs straight on from its last column into its first', () => {
    const square = seamlessFloor(plot(), W, { x: 5, y: 5, w: 90, h: 90 }, 48)!;
    // A plain cut of the ramp would jump 47 shades from its last column to its first.
    let jump = 0;
    for (let y = 0; y < 48; y++) jump += Math.abs(at(square, 48, 0, y)[0] - at(square, 48, 47, y)[0]);
    expect(jump / 48).toBeLessThan(8);
  });

  it('fills a square from a pile too small to hold one, by repeating a smaller piece', () => {
    const square = seamlessFloor(plot(), W, { x: 30, y: 30, w: 44, h: 40 }, 48)!;
    expect(square).not.toBeNull();
    for (let i = 0; i < 48 * 48; i++) expect(square[i * 4 + 3]).toBe(255);
    // A 16 px piece, three times across.
    expect(at(square, 48, 5, 7)).toEqual(at(square, 48, 21, 7));
    expect(at(square, 48, 5, 7)).toEqual(at(square, 48, 37, 39));
  });

  it('gives up on a speck with no middle to speak of', () => {
    expect(seamlessFloor(plot(), W, { x: 30, y: 30, w: 20, h: 20 }, 48)).toBeNull();
  });
});

describe('isSolid', () => {
  it('tells a filled square from a shaped one', () => {
    const rgba = plot();
    expect(isSolid(rgba, W, { x: 20, y: 20, w: 48, h: 48 })).toBe(true);
    expect(isSolid(rgba, W, { x: 5, y: 5, w: 48, h: 48 })).toBe(false);
  });
});
