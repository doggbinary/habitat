import { describe, expect, it } from 'vitest';
import { floorIndexFromPath, floorTiles, isRawFloorSheet } from './autotile';

const TILE = 12;

/** A floor page of two 2-by-3 blocks; each half square is one flat colour. */
function floorPage(): Uint8ClampedArray {
  const tile = TILE;
  const width = tile * 4;
  const height = tile * 3;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const block = Math.floor(x / (tile * 2));
      const hx = Math.floor((x % (tile * 2)) / (tile / 2));
      const hy = Math.floor(y / (tile / 2));
      rgba.set([block * 100 + hx * 10, hy * 10, 50, 255], (y * width + x) * 4);
    }
  }
  return rgba;
}

describe('floor pages', () => {
  it('recognises a pack floor page, under its old or new name', () => {
    expect(isRawFloorSheet('Floors 1', 768, 576, 48)).toBe(true);
    expect(isRawFloorSheet('Paths 2', 768, 576, 48)).toBe(true);
    expect(isRawFloorSheet('Modern Park 1', 768, 576, 48)).toBe(false);
  });

  it('makes one square per floor type, from the inside of the block', () => {
    const floors = floorTiles(floorPage(), TILE * 4, TILE * 3, TILE);
    expect(floors.assets).toEqual([
      { x: 0, y: 0, w: TILE, h: TILE },
      { x: TILE, y: 0, w: TILE, h: TILE },
    ]);
    // Top-left quarter is half square (2, 4) of the first block.
    expect([...floors.rgba.subarray(0, 3)]).toEqual([20, 40, 50]);
    // Top-left quarter of the second block's square.
    expect([...floors.rgba.subarray(TILE * 4, TILE * 4 + 3)]).toEqual([120, 40, 50]);
  });

  it('turns an old painted path piece into its floor type', () => {
    expect(floorIndexFromPath(2 * 47 + 30, 47)).toBe(2);
    expect(floorIndexFromPath(3 * 15 + 9, 15)).toBe(3);
  });
});
