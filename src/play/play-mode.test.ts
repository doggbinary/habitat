import { describe, expect, it } from 'vitest';
import { createDoc, createLayer, type TileLayer } from '../core/doc';
import { EMPTY, pack } from '../core/tiles';
import { fakeObject } from '../test-support/fakes';
import {
  buildCollision,
  doorAt,
  ensureCollisionLayer,
  nextZoom,
  objectCells,
  opaqueCells,
  type AlphaAt,
} from './play-mode';

describe('doors', () => {
  // A 64 x 48 house whose box runs from (32, 32) to (96, 80), on 16 px squares.
  const house = () => fakeObject({ id: 'house', rect: { x: 0, y: 0, w: 64, h: 48 }, x: 64, y: 56, door: { x: 200, y: 200 } });
  const withObjects = (...objects: ReturnType<typeof fakeObject>[]) => {
    const doc = createDoc(20, 20, 16);
    doc.layers.push({ id: 'o', kind: 'objects', name: 'Objects', visible: true, locked: false, opacity: 1, objects });
    return doc;
  };

  it('opens at the middle of the bottom edge, including just in front of it', () => {
    const doc = withObjects(house());
    expect(doorAt(doc, 64, 76)?.id).toBe('house');
    // Standing on the path just below the house, as a blocking house allows.
    expect(doorAt(doc, 64, 86)?.id).toBe('house');
  });

  it('is not the whole house: the roof, the far corners and the yard do not lead anywhere', () => {
    const doc = withObjects(house());
    expect(doorAt(doc, 64, 40)).toBeNull();
    expect(doorAt(doc, 34, 76)).toBeNull();
    expect(doorAt(doc, 64, 100)).toBeNull();
  });

  it('ignores objects with no door and hidden layers', () => {
    const plain = house();
    delete plain.door;
    expect(doorAt(withObjects(plain), 64, 76)).toBeNull();
    const doc = withObjects(house());
    doc.layers[1].visible = false;
    expect(doorAt(doc, 64, 76)).toBeNull();
  });
});

describe('blocking under an object', () => {
  it('covers exactly the squares under the box', () => {
    const doc = createDoc(10, 10, 16);
    // 16 x 32 box with its top-left on (32, 32): squares (2,2) and (2,3).
    const cells = objectCells(doc, fakeObject({ x: 40, y: 48 }));
    expect(cells).toEqual([2 * 10 + 2, 3 * 10 + 2]);
  });

  it('ignores the part of a box that hangs off the map', () => {
    const doc = createDoc(4, 4, 16);
    const cells = objectCells(doc, fakeObject({ x: 64, y: 64 }));
    expect(cells).toEqual([3 * 4 + 3]);
  });

  it('follows a blocking object when it moves and resizes, and only blocks where it is now', () => {
    const doc = createDoc(10, 10, 16);
    const obj = fakeObject({ x: 40, y: 48, blocks: true });
    doc.layers.push({ id: 'o', kind: 'objects', name: 'Objects', visible: true, locked: false, opacity: 1, objects: [obj] });
    const blockedAt = () => [...buildCollision(doc)].flatMap((v, i) => (v ? [i] : []));
    expect(blockedAt()).toEqual([22, 32]);

    obj.x += 64;
    expect(blockedAt()).toEqual([26, 36]);

    // Twice the size from the same top-left corner: 2 x 4 squares.
    obj.scale = 2;
    obj.x = 96 + 16;
    obj.y = 32 + 32;
    expect(blockedAt()).toEqual([26, 27, 36, 37, 46, 47, 56, 57]);

    delete obj.blocks;
    expect(blockedAt()).toEqual([]);
  });
});

describe('blocking only what is drawn', () => {
  // A 64 x 48 picture: a 16 px roof peak in the middle of the top row and a
  // 40 px wide body below it, leaving the corners transparent.
  const houseAlpha: AlphaAt = (u, v) => (v < 16 ? u >= 24 && u < 40 : u >= 12 && u < 52);

  it('leaves the empty corners of a house picture walkable', () => {
    const doc = createDoc(20, 20, 16);
    // Box from (32, 32) to (96, 80): squares 2 to 5 across, 2 to 4 down.
    const house = fakeObject({ rect: { x: 0, y: 0, w: 64, h: 48 }, x: 64, y: 56, blocks: true });
    expect(objectCells(doc, house)).toHaveLength(12);
    // The roof fills half of squares 3 and 4 on top; the body's 4 px edges
    // fill a quarter of the outer squares, too little to stop anyone.
    expect(opaqueCells(doc, house, houseAlpha)).toEqual([43, 44, 63, 64, 83, 84]);
    doc.layers.push({ id: 'o', kind: 'objects', name: 'Objects', visible: true, locked: false, opacity: 1, objects: [house] });
    const solid = buildCollision(doc, () => houseAlpha);
    expect([...solid].flatMap((v, i) => (v ? [i] : []))).toEqual([43, 44, 63, 64, 83, 84]);
  });

  it('follows the art when it is turned and mirrored', () => {
    const doc = createDoc(10, 10, 16);
    // A 16 x 32 post whose top half is drawn.
    const topHalf: AlphaAt = (_u, v) => v < 16;
    expect(opaqueCells(doc, fakeObject({ x: 40, y: 48 }), topHalf)).toEqual([22]);
    // A quarter turn clockwise lays it across (32, 32) to (64, 48), top pointing right.
    const turned = fakeObject({ x: 48, y: 40, rotation: 1 });
    expect(opaqueCells(doc, turned, topHalf)).toEqual([23]);
    expect(opaqueCells(doc, { ...turned, flipY: true }, topHalf)).toEqual([22]);
  });

  it('counts a bigger object by the area its pixels cover', () => {
    const doc = createDoc(10, 10, 16);
    // At twice the size each art pixel is 2 x 2, so 8 drawn columns fill a whole square.
    const post = fakeObject({ rect: { x: 0, y: 0, w: 16, h: 16 }, x: 48, y: 48, scale: 2 });
    expect(opaqueCells(doc, post, (u) => u < 8)).toEqual([22, 32]);
  });
});

describe('zoom steps', () => {
  it('steps in whole sizes from 1x up and in thirds below it', () => {
    expect(nextZoom(2, 1)).toBe(3);
    expect(nextZoom(2.4, 1)).toBe(3);
    expect(nextZoom(2.4, -1)).toBe(2);
    expect(nextZoom(1, -1)).toBeCloseTo(2 / 3);
    expect(nextZoom(2 / 3, 1)).toBe(1);
    expect(nextZoom(0.5, 1)).toBe(0.75);
  });
});

describe('collision tiles', () => {
  it('creates a collision layer and blocks that square', () => {
    const doc = createDoc(4, 4, 16);
    const layer = ensureCollisionLayer(doc);
    layer.data[1] = pack(0, 3);
    const solid = buildCollision(doc);
    expect(layer.collider).toBe(true);
    expect(solid[1]).toBe(1);
    expect(solid[0]).toBe(0);
  });

  it('reuses the collision layer that is already there', () => {
    const doc = createDoc(4, 4, 16);
    const existing = createLayer(4, 4, 'Walls');
    existing.collider = true;
    doc.layers.push(existing);
    expect(ensureCollisionLayer(doc)).toBe(existing);
  });

  it('stops blocking a square once it is cleared', () => {
    const doc = createDoc(4, 4, 16);
    const layer = ensureCollisionLayer(doc) as TileLayer;
    layer.data[2] = pack(0, 1);
    layer.data[2] = EMPTY;
    expect(buildCollision(doc)[2]).toBe(0);
  });
});
