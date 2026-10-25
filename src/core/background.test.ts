import { describe, expect, it } from 'vitest';
import { clearWhiteBackdrop } from './background';

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
