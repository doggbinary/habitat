import type { MapObject, Tileset } from '../core/doc';
import type { Renderer } from '../render/renderer';

/**
 * Shared stand-ins for tests. Kept out of any `*.test.ts` file because
 * importing from a test file makes the runner execute that file's tests a
 * second time inside whichever file imported it.
 */

/** The editing code only ever tells the renderer what to repaint. */
export const fakeRenderer = {
  markCell() {},
  markRect() {},
  invalidateAll() {},
  requestDraw() {},
} as unknown as Renderer;

/** A sheet with no decoded image, which the editing code never needs. */
export function fakeTileset(id: string, tileW = 16): Tileset {
  return {
    id,
    name: id,
    src: '',
    tileW,
    tileH: tileW,
    margin: 0,
    spacing: 0,
    image: null,
    imgW: tileW * 4,
    imgH: tileW * 4,
    cols: 4,
    rows: 4,
    count: 16,
  };
}

let nextObject = 0;

/** A 16x32 object centred at (40, 40), untransformed unless overridden. */
export function fakeObject(overrides: Partial<MapObject> = {}): MapObject {
  nextObject += 1;
  return {
    id: `obj-${nextObject}`,
    tilesetId: 'a',
    rect: { x: 0, y: 0, w: 16, h: 32 },
    x: 40,
    y: 40,
    scale: 1,
    rotation: 0,
    flipX: false,
    flipY: false,
    hueShift: 0,
    saturation: 1,
    brightness: 1,
    ...overrides,
  };
}
