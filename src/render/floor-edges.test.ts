import { describe, expect, it } from 'vitest';
import { floorEdgeInset, nearestScale, opaqueInsets } from './floor-edges';

function square(size: number, fill: [number, number, number], edge?: { side: 'top' | 'bottom' | 'left' | 'right'; colour: [number, number, number] }): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < rgba.length; i += 4) rgba.set([...fill, 255], i);
  if (edge) {
    for (let i = 0; i < size; i++) {
      const x = edge.side === 'left' ? 0 : edge.side === 'right' ? size - 1 : i;
      const y = edge.side === 'top' ? 0 : edge.side === 'bottom' ? size - 1 : i;
      rgba.set([...edge.colour, 255], (y * size + x) * 4);
    }
  }
  return rgba;
}

describe('floor outline', () => {
  it('drops a flat dark line drawn around a floor square', () => {
    const rgba = square(16, [170, 120, 80], { side: 'top', colour: [40, 32, 48] });
    expect(floorEdgeInset(rgba, 16, 0, 0, 16, 16)).toEqual({ top: 1, right: 0, bottom: 0, left: 0 });
  });

  it('keeps an edge that is part of the texture', () => {
    const rgba = square(16, [90, 150, 70]);
    // A varied darker row, like blades of grass, is not an outline.
    for (let x = 0; x < 16; x++) rgba.set([40 + (x % 3) * 30, 90 + (x % 4) * 20, 40, 255], x * 4);
    expect(floorEdgeInset(rgba, 16, 0, 0, 16, 16)).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
  });

  it('drops the darker line drawn just inside a see-through one', () => {
    const rgba = square(16, [170, 120, 80]);
    for (let x = 0; x < 16; x++) {
      rgba.set([50, 40, 60, 150], x * 4);
      rgba.set([90, 60, 70, 255], (16 + x) * 4);
    }
    expect(floorEdgeInset(rgba, 16, 0, 0, 16, 16).top).toBe(2);
  });

  it('drops a see-through line along the edge of a floor square', () => {
    const rgba = square(16, [170, 120, 80]);
    for (let x = 0; x < 16; x++) rgba.set([50, 40, 60, 150], x * 4);
    expect(floorEdgeInset(rgba, 16, 0, 0, 16, 16).top).toBe(1);
  });

  it('shrinks a floor square by whole pixels, not by averaging them', () => {
    const src = new Uint8ClampedArray(6 * 3 * 4);
    for (let x = 0; x < 6; x++) src.set([x * 40, 0, 0, 255], (x + 6) * 4);
    const out = nearestScale(src, 6, 0, 1, 6, 1, 2, 1);
    expect([out[0], out[4]]).toEqual([0, 120]);
  });

  it('ignores clear padding when measuring where the art actually ends', () => {
    const rgba = new Uint8ClampedArray(8 * 6 * 4);
    for (let y = 1; y < 5; y++) for (let x = 2; x < 7; x++) rgba[(y * 8 + x) * 4 + 3] = 255;
    expect(opaqueInsets(rgba, 8, 0, 0, 8, 6)).toEqual({ l: 2, t: 1, r: 1, b: 1 });
  });

  it('keeps a square that is already seamless', () => {
    const rgba = square(16, [120, 120, 120]);
    expect(floorEdgeInset(rgba, 16, 0, 0, 16, 16)).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
  });
});
