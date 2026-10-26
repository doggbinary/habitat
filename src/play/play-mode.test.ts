import { describe, expect, it } from 'vitest';
import { createDoc, createLayer, type TileLayer } from '../core/doc';
import { EMPTY, pack } from '../core/tiles';
import { fakeObject } from '../test-support/fakes';
import { buildCollision, ensureCollisionLayer, objectCells } from './play-mode';

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
