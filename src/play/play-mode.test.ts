import { describe, expect, it } from 'vitest';
import { createDoc, createLayer, type TileLayer } from '../core/doc';
import { EMPTY, pack } from '../core/tiles';
import { buildCollision, ensureCollisionLayer } from './play-mode';

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
