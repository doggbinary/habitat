import { describe, expect, it } from 'vitest';
import { createDoc, createLayer, resizedLayerData, type TileLayer } from '../core/doc';
import { quantizeSquares, resizePlan } from './map-resize';

describe('map edge resize', () => {
  it('snaps to a whole square, or to an even count, or to only the squares crossed', () => {
    expect(quantizeSquares(10.4, true, false)).toBe(10);
    expect(quantizeSquares(10.6, true, false)).toBe(11);
    expect(quantizeSquares(10.6, true, true)).toBe(10);
    expect(quantizeSquares(11.2, false, false)).toBe(11);
    expect(quantizeSquares(11.9, false, true)).toBe(10);
    expect(quantizeSquares(0.2, false, false)).toBe(1);
  });

  it('grows the left edge without moving the squares that were already there', () => {
    const plan = resizePlan({ w: 10, h: 8, originCol: 0, originRow: 0 }, 'w', { x: -32, y: 0 }, 16, true, false);
    expect(plan).toEqual({ w: 12, h: 8, shiftX: 2, shiftY: 0 });
    const doc = createDoc(10, 8, 16);
    const layer = doc.layers[0] as TileLayer;
    layer.data[3] = 7;
    const next = resizedLayerData(layer, 10, 8, plan.w, plan.h, plan.shiftX, plan.shiftY);
    // Column 0 moves two places right, so its world column stays 0 once the origin shifts back by 2.
    expect(next[3 + 2]).toBe(7);
    expect(next[0]).toBe(-1);
  });

  it('drops columns from the left and keeps the rest on their world columns', () => {
    const plan = resizePlan({ w: 10, h: 8, originCol: 0, originRow: 0 }, 'e', { x: 16 * 6, y: 0 }, 16, true, false);
    expect(plan).toEqual({ w: 6, h: 8, shiftX: 0, shiftY: 0 });
    const north = resizePlan({ w: 10, h: 8, originCol: 0, originRow: 0 }, 'n', { x: 0, y: -16 }, 16, true, false);
    expect(north).toEqual({ w: 10, h: 9, shiftX: 0, shiftY: 1 });
  });

  it('a new layer buffer is the size of the resized map', () => {
    const doc = createDoc(2, 2, 16);
    const layer = createLayer(2, 2, 'Ground');
    layer.data[0] = 4;
    const next = resizedLayerData(layer, 2, 2, 3, 2, 1, 0);
    expect(next.length).toBe(6);
    expect(next[1]).toBe(4);
    expect(doc.width).toBe(2);
  });
});
