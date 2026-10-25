import { describe, expect, it } from 'vitest';
import { PATH_PREVIEW, PATH_STRIDE, pathShape, type Neighbours } from './autotile';

const none: Neighbours = { n: false, ne: false, e: false, se: false, s: false, sw: false, w: false, nw: false };
const all: Neighbours = { n: true, ne: true, e: true, se: true, s: true, sw: true, w: true, nw: true };

describe('path pieces', () => {
  it('uses the full centre when the path continues all round', () => {
    expect(pathShape(all)).toBe(0);
  });

  it('draws an inner corner where only the diagonal is missing', () => {
    // A wide road turning: everything continues except up and to the left.
    expect(pathShape({ ...all, nw: false })).toBe(1);
    expect(pathShape({ ...all, ne: false })).toBe(2);
  });

  it('uses straights for a one-square-wide road', () => {
    expect(pathShape({ ...none, e: true, w: true })).toBe(33);
    expect(pathShape({ ...none, n: true, s: true })).toBe(32);
  });

  it('joins a T-junction with inner corners on the side the road leaves from', () => {
    // Road running east-west with a branch going south, no diagonals.
    expect(pathShape({ ...none, e: true, w: true, s: true })).toBe(23);
  });

  it('uses the edge piece along the side of a two-wide road', () => {
    // Top row of a road two squares tall: continues left, right and down.
    expect(pathShape({ ...none, e: true, w: true, s: true, se: true, sw: true })).toBe(20);
  });

  it('uses the lone piece for a single square', () => {
    expect(pathShape(none)).toBe(PATH_PREVIEW);
  });

  it('has a piece for every arrangement of neighbours', () => {
    const shapes = new Set<number>();
    for (let mask = 0; mask < 256; mask++) {
      const [n, ne, e, se, s, sw, w, nw] = [...Array(8)].map((_, i) => (mask & (1 << i)) !== 0);
      shapes.add(pathShape({ n, ne, e, se, s, sw, w, nw }));
    }
    expect(shapes.size).toBe(PATH_STRIDE);
  });
});
