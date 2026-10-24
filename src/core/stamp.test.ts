import { describe, expect, it } from 'vitest';
import {
  flipStampH,
  flipStampV,
  randomTile,
  rotateStampCW,
  singleStamp,
  stampFromRegion,
  stampTileAt,
  type Stamp,
} from './stamp';
import { EMPTY, flagsOf, indexOf, pack } from './tiles';

/** A 3x2 block with every tile distinct, so any misplacement shows up. */
function sample(): Stamp {
  return { w: 3, h: 2, tiles: Int32Array.from([0, 1, 2, 3, 4, 5].map((i) => pack(0, i))) };
}

const indices = (s: Stamp) => [...s.tiles].map((t) => (t === EMPTY ? -1 : indexOf(t)));

describe('stamp transforms', () => {
  it('flipping horizontally reverses each row', () => {
    expect(indices(flipStampH(sample()))).toEqual([2, 1, 0, 5, 4, 3]);
  });

  it('flipping vertically reverses the rows', () => {
    expect(indices(flipStampV(sample()))).toEqual([3, 4, 5, 0, 1, 2]);
  });

  it('rotating clockwise swaps the dimensions and turns the layout', () => {
    const r = rotateStampCW(sample());
    expect([r.w, r.h]).toEqual([2, 3]);
    // The bottom-left corner becomes the top-left after a clockwise turn.
    expect(indices(r)).toEqual([3, 0, 4, 1, 5, 2]);
  });

  it('four rotations restore both layout and tile orientation', () => {
    let s = sample();
    for (let i = 0; i < 4; i++) s = rotateStampCW(s);
    expect([...s.tiles]).toEqual([...sample().tiles]);
  });

  it('flipping twice restores the original exactly', () => {
    expect([...flipStampH(flipStampH(sample())).tiles]).toEqual([...sample().tiles]);
    expect([...flipStampV(flipStampV(sample())).tiles]).toEqual([...sample().tiles]);
  });

  it('flips the art inside each tile, not just the block layout', () => {
    expect(flagsOf(flipStampH(singleStamp(0, 0)).tiles[0])).not.toBe(0);
  });

  it('keeps holes as holes through every transform', () => {
    const holey: Stamp = { w: 2, h: 1, tiles: Int32Array.from([EMPTY, pack(0, 4)]) };
    expect(flipStampH(holey).tiles[1]).toBe(EMPTY);
    expect(rotateStampCW(holey).tiles).toContain(EMPTY);
  });
});

describe('stamp sampling', () => {
  it('repeats the pattern, including at negative offsets', () => {
    const s = sample();
    expect(indexOf(stampTileAt(s, 0, 0))).toBe(0);
    expect(indexOf(stampTileAt(s, 3, 0))).toBe(0);
    expect(indexOf(stampTileAt(s, -1, 0))).toBe(2);
    expect(indexOf(stampTileAt(s, 0, -1))).toBe(3);
  });

  it('marks cells past the end of a sheet as empty', () => {
    // A 4-column sheet with only 6 tiles: the 2x2 block at (2,1) hangs off.
    const s = stampFromRegion(0, 4, 2, 1, 2, 2, 6);
    expect(indices(s)).toEqual([-1, -1, -1, -1]);
    const partial = stampFromRegion(0, 4, 0, 1, 2, 2, 6);
    expect(indices(partial)).toEqual([4, 5, -1, -1]);
  });

  it('never scatters an empty cell', () => {
    const s: Stamp = { w: 3, h: 1, tiles: Int32Array.from([EMPTY, pack(0, 7), EMPTY]) };
    for (let i = 0; i < 50; i++) expect(indexOf(randomTile(s))).toBe(7);
    expect(randomTile({ w: 1, h: 1, tiles: Int32Array.of(EMPTY) })).toBe(EMPTY);
  });
});
