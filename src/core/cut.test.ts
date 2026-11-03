import { describe, expect, it } from 'vitest';
import type { AssetRect, Tileset } from './doc';
import { autoCutAsset, cutAsset, replaceAsset, type CutGrid, type CutPoint } from './cut';

const grid: CutGrid = { w: 16, h: 16, margin: 0, spacing: 0 };

function image(w: number, h: number) {
  return { rgba: new Uint8ClampedArray(w * h * 4), alpha: new Uint8Array(w * h), w, h };
}

function fill(
  img: ReturnType<typeof image>,
  x: number,
  y: number,
  w: number,
  h: number,
  rgb: [number, number, number],
): void {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      const i = yy * img.w + xx;
      img.alpha[i] = 255;
      const p = i * 4;
      img.rgba[p] = rgb[0];
      img.rgba[p + 1] = rgb[1];
      img.rgba[p + 2] = rgb[2];
      img.rgba[p + 3] = 255;
    }
  }
}

/** A straight stroke in sheet pixels, inclusive. */
function line(x0: number, y0: number, x1: number, y1: number): CutPoint[] {
  const points: CutPoint[] = [];
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  for (let i = 0; i <= steps; i++) {
    points.push({
      x: x0 + ((x1 - x0) * i) / steps,
      y: y0 + ((y1 - y0) * i) / steps,
    });
  }
  return points;
}

/** Every opaque pixel of `rect` belongs to exactly one piece. */
function covers(img: ReturnType<typeof image>, rect: AssetRect, pieces: AssetRect[]): boolean {
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      if (img.alpha[y * img.w + x] <= 24) continue;
      const owners = pieces.filter((piece) => x >= piece.x && x < piece.x + piece.w && y >= piece.y && y < piece.y + piece.h);
      if (owners.length !== 1) return false;
    }
  }
  return true;
}

describe('cutting an asset by hand', () => {
  const rect = { x: 0, y: 0, w: 32, h: 16 };

  it('splits two touching pictures along the stroke', () => {
    const img = image(32, 16);
    fill(img, 0, 0, 16, 16, [40, 160, 60]);
    fill(img, 16, 0, 16, 16, [40, 160, 60]);
    const pieces = cutAsset(img.rgba, img.alpha, img.w, rect, [line(16, 0, 16, 15)]);
    expect(pieces).toEqual([
      { x: 0, y: 0, w: 16, h: 16 },
      { x: 16, y: 0, w: 16, h: 16 },
    ]);
    expect(covers(img, rect, pieces)).toBe(true);
  });

  it('slides the cut onto a colour change a few pixels from the stroke', () => {
    const img = image(32, 16);
    fill(img, 0, 0, 16, 16, [200, 40, 40]);
    fill(img, 16, 0, 16, 16, [40, 80, 200]);
    // Drawn two pixels into the right picture. The red/blue edge is at x = 16.
    const pieces = cutAsset(img.rgba, img.alpha, img.w, rect, [line(18, 0, 18, 15)]);
    expect(pieces).toEqual([
      { x: 0, y: 0, w: 16, h: 16 },
      { x: 16, y: 0, w: 16, h: 16 },
    ]);
  });

  it('ignores a short tick that does not cross the picture', () => {
    const img = image(32, 16);
    fill(img, 0, 0, 32, 16, [40, 160, 60]);
    expect(cutAsset(img.rgba, img.alpha, img.w, rect, [line(16, 4, 16, 6)])).toEqual([rect]);
  });

  it('turns two strokes into three pieces', () => {
    const wide = { x: 0, y: 0, w: 48, h: 16 };
    const img = image(48, 16);
    fill(img, 0, 0, 48, 16, [90, 90, 90]);
    const pieces = cutAsset(img.rgba, img.alpha, img.w, wide, [line(16, 0, 16, 15), line(32, 0, 32, 15)]);
    expect(pieces).toEqual([
      { x: 0, y: 0, w: 16, h: 16 },
      { x: 16, y: 0, w: 16, h: 16 },
      { x: 32, y: 0, w: 16, h: 16 },
    ]);
    expect(covers(img, wide, pieces)).toBe(true);
  });

  it('leaves the picture whole when the line stays in the margin', () => {
    const img = image(32, 16);
    fill(img, 6, 0, 20, 16, [40, 160, 60]);
    expect(cutAsset(img.rgba, img.alpha, img.w, rect, [line(2, 0, 2, 15)])).toEqual([rect]);
  });
});

describe('automatic cuts', () => {
  it('separates pictures that already have a gap between them', () => {
    const img = image(40, 16);
    fill(img, 0, 0, 16, 16, [40, 160, 60]);
    fill(img, 20, 0, 16, 16, [40, 160, 60]);
    const rect = { x: 0, y: 0, w: 40, h: 16 };
    expect(autoCutAsset(img.rgba, img.alpha, img.w, rect, grid)).toEqual([
      { x: 0, y: 0, w: 16, h: 16 },
      { x: 20, y: 0, w: 16, h: 16 },
    ]);
  });

  it('cuts on a grid line where the colour jumps', () => {
    const img = image(32, 16);
    fill(img, 0, 0, 16, 16, [200, 40, 40]);
    fill(img, 16, 0, 16, 16, [40, 80, 200]);
    const rect = { x: 0, y: 0, w: 32, h: 16 };
    expect(autoCutAsset(img.rgba, img.alpha, img.w, rect, grid)).toEqual([
      { x: 0, y: 0, w: 16, h: 16 },
      { x: 16, y: 0, w: 16, h: 16 },
    ]);
  });

  it('does not slice a roof off the wall it sits on', () => {
    const img = image(32, 32);
    fill(img, 0, 0, 32, 16, [180, 50, 40]);
    fill(img, 0, 16, 32, 16, [70, 90, 140]);
    const rect = { x: 0, y: 0, w: 32, h: 32 };
    expect(autoCutAsset(img.rgba, img.alpha, img.w, rect, grid)).toEqual([rect]);
  });

  it('does not shave a sliver off one picture', () => {
    const img = image(32, 16);
    fill(img, 0, 0, 16, 16, [200, 40, 40]);
    fill(img, 16, 0, 4, 16, [40, 80, 200]);
    const rect = { x: 0, y: 0, w: 32, h: 16 };
    expect(autoCutAsset(img.rgba, img.alpha, img.w, rect, grid)).toEqual([rect]);
  });

  it('keeps one solid picture whole', () => {
    const img = image(32, 32);
    fill(img, 0, 0, 32, 32, [40, 160, 60]);
    const rect = { x: 0, y: 0, w: 32, h: 32 };
    expect(autoCutAsset(img.rgba, img.alpha, img.w, rect, grid)).toEqual([rect]);
  });

  it('parts two pictures that only kiss along a grid line', () => {
    const img = image(32, 32);
    fill(img, 0, 0, 16, 32, [40, 140, 70]);
    fill(img, 17, 0, 15, 32, [180, 140, 40]);
    // Two pixels of contact, so the flood fill joins them and a gap does not.
    fill(img, 16, 0, 1, 2, [180, 140, 40]);
    const rect = { x: 0, y: 0, w: 32, h: 32 };
    expect(autoCutAsset(img.rgba, img.alpha, img.w, rect, grid)).toEqual([
      { x: 0, y: 0, w: 16, h: 32 },
      { x: 16, y: 0, w: 16, h: 32 },
    ]);
  });
});

describe('replacing the cut asset', () => {
  const a = { x: 0, y: 0, w: 16, h: 16 };
  const b = { x: 16, y: 0, w: 16, h: 16 };
  const c = { x: 32, y: 0, w: 16, h: 16 };

  function sheet(ground: number[], patches: AssetRect[] = []): Tileset {
    return { assets: [a, b, c], groundAssets: ground, groundBlocks: patches } as Tileset;
  }

  it('inserts the pieces and keeps the other ground marks', () => {
    const left = { x: 0, y: 0, w: 8, h: 16 };
    const right = { x: 8, y: 0, w: 8, h: 16 };
    const next = replaceAsset(sheet([0, 2]), 1, [left, right]);
    expect(next?.assets).toEqual([a, left, right, c]);
    // a was ground at 0 and stays. c slides from 2 to 3. The cut asset was not ground.
    expect(next?.ground).toEqual([0, 3]);
  });

  it('drops a floor patch when the cut asset was ground', () => {
    const patch = { x: 0, y: 0, w: 16, h: 16 };
    const next = replaceAsset(sheet([0], [patch]), 0, [
      { x: 0, y: 0, w: 8, h: 16 },
      { x: 8, y: 0, w: 8, h: 16 },
    ]);
    expect(next?.ground).toEqual([]);
    expect(next?.patches).toEqual([]);
  });

  it('does nothing when the cut did not split', () => {
    expect(replaceAsset(sheet([]), 0, [a])).toBeNull();
  });
});
