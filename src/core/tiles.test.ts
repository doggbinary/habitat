import { describe, expect, it } from 'vitest';
import {
  EMPTY,
  FLIP_H,
  FLIP_V,
  ROT_90,
  flagsOf,
  flipFlagsH,
  flipFlagsV,
  indexOf,
  pack,
  rotateFlagsCW,
  sameArt,
  tilesetOf,
  withFlags,
} from './tiles';

const ALL_FLAGS = [0, 1, 2, 3, 4, 5, 6, 7];

type Matrix = [number, number, number, number];

// `+ 0` folds -0 into 0: `toEqual` tells them apart, but the renderer cannot.
const mul = (a: Matrix, b: Matrix): Matrix => [
  a[0] * b[0] + a[1] * b[2] + 0,
  a[0] * b[1] + a[1] * b[3] + 0,
  a[2] * b[0] + a[3] * b[2] + 0,
  a[2] * b[1] + a[3] * b[3] + 0,
];

/** Canvas `rotate(PI/2)` with y pointing down maps (x, y) to (-y, x). */
const R: Matrix = [0, -1, 1, 0];
const FLIP_X: Matrix = [-1, 0, 0, 1];
const FLIP_Y: Matrix = [1, 0, 0, -1];

/**
 * The transform `drawTile` actually applies for a set of flags:
 * `rotate(ROT_90)` then `scale(FLIP_H, FLIP_V)`, i.e. M = R^r * S.
 */
function matrixFor(flags: number): Matrix {
  const scale: Matrix = [flags & FLIP_H ? -1 : 1, 0, 0, flags & FLIP_V ? -1 : 1];
  return flags & ROT_90 ? mul(R, scale) : scale;
}

describe('packing', () => {
  it('round-trips tileset, index and flags', () => {
    for (const [ts, index, flags] of [
      [0, 0, 0],
      [3, 517, 5],
      [255, 65535, 7],
    ]) {
      const tile = pack(ts, index, flags);
      expect(tilesetOf(tile)).toBe(ts);
      expect(indexOf(tile)).toBe(index);
      expect(flagsOf(tile)).toBe(flags);
    }
  });

  it('never confuses EMPTY with the first tile of the first sheet', () => {
    expect(pack(0, 0, 0)).not.toBe(EMPTY);
  });

  it('stays positive so EMPTY (-1) can never collide with a real tile', () => {
    expect(pack(255, 65535, 7)).toBeGreaterThan(0);
  });

  it('treats tiles with different flags as the same art', () => {
    expect(sameArt(pack(1, 9, 0), pack(1, 9, 6))).toBe(true);
    expect(sameArt(pack(1, 9, 0), pack(1, 10, 0))).toBe(false);
    expect(sameArt(EMPTY, EMPTY)).toBe(true);
    expect(sameArt(EMPTY, pack(0, 0, 0))).toBe(false);
  });

  it('leaves EMPTY empty when flags are applied', () => {
    expect(withFlags(EMPTY, 7)).toBe(EMPTY);
  });
});

describe('orientation flags match the renderer', () => {
  // These are the properties that matter: pressing "flip" or "rotate" must
  // do to the tile on screen exactly what the button says, whatever
  // orientation it was already in.

  it('flipping horizontally mirrors on screen from any orientation', () => {
    for (const flags of ALL_FLAGS) {
      expect(matrixFor(flipFlagsH(flags))).toEqual(mul(FLIP_X, matrixFor(flags)));
    }
  });

  it('flipping vertically mirrors on screen from any orientation', () => {
    for (const flags of ALL_FLAGS) {
      expect(matrixFor(flipFlagsV(flags))).toEqual(mul(FLIP_Y, matrixFor(flags)));
    }
  });

  it('rotating turns a quarter clockwise on screen from any orientation', () => {
    for (const flags of ALL_FLAGS) {
      expect(matrixFor(rotateFlagsCW(flags))).toEqual(mul(R, matrixFor(flags)));
    }
  });

  it('four rotations return to the start', () => {
    for (const flags of ALL_FLAGS) {
      let f = flags;
      for (let i = 0; i < 4; i++) f = rotateFlagsCW(f);
      expect(f).toBe(flags);
    }
  });

  it('flipping twice is a no-op', () => {
    for (const flags of ALL_FLAGS) {
      expect(flipFlagsH(flipFlagsH(flags))).toBe(flags);
      expect(flipFlagsV(flipFlagsV(flags))).toBe(flags);
    }
  });

  it('every one of the eight orientations is distinct', () => {
    const seen = new Set(ALL_FLAGS.map((f) => matrixFor(f).join(',')));
    expect(seen.size).toBe(8);
  });
});
