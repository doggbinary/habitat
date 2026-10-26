import { describe, expect, it } from 'vitest';
import { clearShadows, clearWhiteBackdrop } from './background';

/** A w x h picture filled with one colour, with a block of another painted on it. */
function picture(w: number, h: number, fill: number[], block?: { x: number; y: number; size: number; rgba: number[] }) {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) rgba.set(fill, i * 4);
  if (block) {
    for (let y = block.y; y < block.y + block.size; y++) {
      for (let x = block.x; x < block.x + block.size; x++) rgba.set(block.rgba, (y * w + x) * 4);
    }
  }
  return rgba;
}

const alphaAt = (rgba: Uint8ClampedArray, w: number, x: number, y: number) => rgba[(y * w + x) * 4 + 3];

describe('clearShadows', () => {
  it('clears a see-through dark shadow under an object, keeping its soft outline and light glass', () => {
    // An object in the top rows, then a shadow below it.
    const w = 6;
    const rgba = picture(w, 6, [0, 0, 0, 0], { x: 1, y: 0, size: 2, rgba: [200, 120, 60, 255] });
    for (let x = 0; x < w; x++) for (let y = 2; y < 6; y++) rgba.set([0, 0, 0, 120], (y * w + x) * 4);
    rgba.set([230, 240, 255, 100], (5 * w + 5) * 4);

    expect(clearShadows(rgba, w, 6)).toBe(true);

    // Right under the object: its soft outline stays.
    expect(alphaAt(rgba, w, 1, 2)).toBe(120);
    // Further down, the shadow is gone.
    expect(alphaAt(rgba, w, 1, 4)).toBe(0);
    expect(alphaAt(rgba, w, 4, 3)).toBe(0);
    // A light see-through pixel is glass or a highlight, not shadow.
    expect(alphaAt(rgba, w, 5, 5)).toBe(100);
    // The object itself is untouched.
    expect(alphaAt(rgba, w, 1, 0)).toBe(255);
  });

  it('leaves an opaque picture alone', () => {
    const rgba = picture(4, 4, [20, 20, 20, 255]);
    expect(clearShadows(rgba, 4, 4)).toBe(false);
  });
});

describe('clearWhiteBackdrop', () => {
  it('clears the white around an object, but not white inside it', () => {
    const rgba = picture(12, 12, [255, 255, 255, 255], { x: 3, y: 3, size: 6, rgba: [30, 120, 40, 255] });
    // A white highlight in the middle of the bush.
    rgba.set([255, 255, 255, 255], (5 * 12 + 5) * 4);
    expect(clearWhiteBackdrop(rgba, 12, 12)).toBe(true);
    expect(alphaAt(rgba, 12, 0, 0)).toBe(0);
    expect(alphaAt(rgba, 12, 3, 3)).toBe(255);
    expect(alphaAt(rgba, 12, 5, 5)).toBe(255);
  });

  it('turns a light grey rim into faint dark ink, not a light halo', () => {
    const rgba = picture(12, 12, [255, 255, 255, 255], { x: 3, y: 3, size: 6, rgba: [30, 120, 40, 255] });
    rgba.set([220, 220, 220, 255], (3 * 12 + 3) * 4);
    clearWhiteBackdrop(rgba, 12, 12);
    const at = (3 * 12 + 3) * 4;
    expect(rgba[at]).toBe(0);
    expect(rgba[at + 3]).toBe(35);
  });

  it('leaves sheets that already have transparency alone', () => {
    const rgba = picture(10, 10, [0, 0, 0, 0], { x: 0, y: 0, size: 6, rgba: [255, 255, 255, 255] });
    expect(clearWhiteBackdrop(rgba, 10, 10)).toBe(false);
    expect(alphaAt(rgba, 10, 0, 0)).toBe(255);
  });

  it('leaves a floor with no white alone', () => {
    expect(clearWhiteBackdrop(picture(10, 10, [60, 160, 50, 255]), 10, 10)).toBe(false);
  });
});
