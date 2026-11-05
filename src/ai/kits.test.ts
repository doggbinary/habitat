import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { FLOOR_AUTOTILE_TABLE } from '../core/autotile';
import { loadPng, repoPath } from '../test-support/png-node';
import { createImage, fillRect, type Colour, type RGBAImage } from './image';
import { buildKits, findKits, kitAsA2 } from './kits';

const DIRT: Colour = [230, 180, 140, 255];
const GRASS: Colour = [120, 220, 90, 255];
const RIM: Colour = [90, 60, 40, 255];

/**
 * A kit the way packs draw one: in a 3 x 3 block of 16 px cells, one ground
 * as a patch half a cell in from the edges, with a darker rim along the
 * boundary, and beside it the inverse block.
 */
function kitSheet(): RGBAImage {
  const img = createImage(112, 48);
  const block = (x0: number, inside: Colour, outside: Colour) => {
    fillRect(img, { x: x0, y: 0, w: 48, h: 48 }, outside);
    fillRect(img, { x: x0 + 8, y: 8, w: 32, h: 32 }, RIM);
    fillRect(img, { x: x0 + 10, y: 10, w: 28, h: 28 }, inside);
    // A little texture, as real ground has.
    for (let y = 0; y < 48; y += 5) for (let x = (y * 3) % 7; x < 48; x += 9) {
      const i = (y * img.width + x0 + x) * 4;
      img.data[i] = Math.max(0, img.data[i] - 12);
    }
  };
  block(0, DIRT, GRASS);
  fillRect(img, { x: 48, y: 0, w: 16, h: 48 }, GRASS);
  block(64, GRASS, DIRT);
  return img;
}

describe('terrain kits', () => {
  it('finds a patch and its inverse, both ways round', () => {
    const kits = findKits(kitSheet(), 16);
    expect(kits.map((k) => [k.patch.x, k.inverse.x])).toEqual([
      [0, 64],
      [64, 0],
    ]);
  });

  it('finds nothing on a page of objects or plain ground', () => {
    const img = createImage(96, 96, GRASS);
    fillRect(img, { x: 20, y: 20, w: 30, h: 30 }, [200, 60, 60, 255]);
    expect(findKits(img, 16)).toEqual([]);
  });

  it('assembles every shape from the kit’s own quarters, pixel for pixel', () => {
    const img = kitSheet();
    const [kit] = findKits(img, 16);
    const a2 = kitAsA2(img, kit, 16);
    const build = buildKits(img, 16, 'kit')!;
    expect(build.sheet.format).toBe('terrain-kit');
    expect(build.sheet.materials).toHaveLength(2);
    expect(build.sheet.materials[0].name).toMatch(/ on /);
    // Every shape of the first material comes from the virtual A2 block.
    FLOOR_AUTOTILE_TABLE.forEach((pieces, shape) => {
      pieces.forEach(([qx, qy], k) => {
        for (let y = 0; y < 8; y++) {
          for (let x = 0; x < 8; x++) {
            const from = ((qy * 8 + y) * a2.width + qx * 8 + x) * 4;
            const to = ((Math.floor(k / 2) * 8 + y) * build.atlas.width + shape * 16 + (k % 2) * 8 + x) * 4;
            for (let c = 0; c < 4; c++) if (build.atlas.data[to + c] !== a2.data[from + c]) throw new Error(`shape ${shape} quarter ${k}`);
          }
        }
      });
    });
    // A lone cell is the patch's four corner quarters: dirt in the middle, ringed by the rim.
    const at = (shape: number, x: number, y: number) => Array.from(build.atlas.data.subarray((y * build.atlas.width + shape * 16 + x) * 4, (y * build.atlas.width + shape * 16 + x) * 4 + 4));
    expect(at(46, 8, 8)).toEqual(Array.from(DIRT));
    expect(at(46, 0, 8)).toEqual(Array.from(RIM));
    expect(at(46, 15, 8)).toEqual(Array.from(RIM));
  });
});

describe('the Pixel Fantasy Town kits in the local library', () => {
  const page = (n: number) => repoPath(`public/library/Pixel Fantasy Town/${n}.png`);
  it.skipIf(!existsSync(page(1)))('builds the dirt paths and dark grass on page 1, and the pond and island on page 2', async () => {
    const one = buildKits(await loadPng(page(1)), 32, 'Pixel Fantasy Town 1')!;
    expect(one.sheet.materials).toHaveLength(4);
    const two = buildKits(await loadPng(page(2)), 32, 'Pixel Fantasy Town 2')!;
    expect(two.sheet.materials).toHaveLength(2);
    expect([...one.sheet.materials, ...two.sheet.materials].every((m) => m.flags.length === 0)).toBe(true);
  });
});
