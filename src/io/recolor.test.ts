import { describe, expect, it } from 'vitest';
import { sharpenPixels } from './recolor';

/** A row of grey pixels, each [value, alpha]. */
function row(...pixels: [number, number][]): Uint8ClampedArray {
  const data = new Uint8ClampedArray(pixels.length * 4);
  pixels.forEach(([v, a], i) => data.set([v, v, v, a], i * 4));
  return data;
}

describe('clarity', () => {
  it('pushes a pixel away from its neighbours, so edges between colours get crisper', () => {
    const data = row([100, 255], [150, 255], [100, 255]);
    sharpenPixels(data, 3, 1, 1);
    expect(data[4]).toBeGreaterThan(150);
    expect(data[0]).toBeLessThan(100);
  });

  it('leaves flat colour and see-through pixels alone, so outlines get no halo', () => {
    const flat = row([120, 255], [120, 255], [120, 255]);
    sharpenPixels(flat, 3, 1, 1);
    expect([...flat].filter((_, i) => i % 4 === 0)).toEqual([120, 120, 120]);

    const edge = row([0, 0], [80, 255], [80, 255]);
    sharpenPixels(edge, 3, 1, 1);
    expect(edge[4]).toBe(80);
  });

  it('does nothing at zero', () => {
    const data = row([10, 255], [200, 255]);
    sharpenPixels(data, 2, 1, 0);
    expect(data[0]).toBe(10);
    expect(data[4]).toBe(200);
  });
});
