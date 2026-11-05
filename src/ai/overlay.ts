import { createImage, drawImage, paletteColour, strokeRect, upscale, type Colour, type RGBAImage } from './image';
import type { ExtractedAsset } from './types';

const FLAGGED: Colour = [255, 60, 40, 255];

/** Draws the outline of a pixel set onto a view of the sheet enlarged `scale` times. */
export function outlinePixels(view: RGBAImage, pixels: ArrayLike<number>, sheetW: number, scale: number, colour: Colour, thickness = 1): void {
  const set = new Set<number>();
  for (let k = 0; k < pixels.length; k++) set.add(pixels[k]);
  const put = (x: number, y: number, w: number, h: number) => {
    for (let yy = y; yy < y + h; yy++) {
      if (yy < 0 || yy >= view.height) continue;
      for (let xx = x; xx < x + w; xx++) if (xx >= 0 && xx < view.width) view.data.set(colour, (yy * view.width + xx) * 4);
    }
  };
  for (const i of set) {
    const x = i % sheetW;
    const y = (i - x) / sheetW;
    const vx = x * scale;
    const vy = y * scale;
    if (x === 0 || !set.has(i - 1)) put(vx, vy, thickness, scale);
    if (x === sheetW - 1 || !set.has(i + 1)) put(vx + scale - thickness, vy, thickness, scale);
    if (!set.has(i - sheetW)) put(vx, vy, scale, thickness);
    if (!set.has(i + sheetW)) put(vx, vy + scale - thickness, scale, thickness);
  }
}

/**
 * The original sheet with every extracted asset's exact boundary drawn on
 * it. Tiles get their cell outlined; flagged assets get a red dashed box.
 */
export function renderOverlay(sheet: RGBAImage, assets: ExtractedAsset[], scale = 2): RGBAImage {
  const checker = createImage(sheet.width, sheet.height);
  for (let y = 0; y < sheet.height; y++) {
    for (let x = 0; x < sheet.width; x++) {
      const v = ((x >> 3) + (y >> 3)) % 2 ? 58 : 46;
      checker.data.set([v, v, v + 4, 255], (y * sheet.width + x) * 4);
    }
  }
  drawImage(checker, sheet, 0, 0);
  const view = upscale(checker, scale);
  assets.forEach((a, k) => {
    const colour = paletteColour(k);
    if (a.kind === 'tile') strokeRect(view, { x: a.rect.x * scale, y: a.rect.y * scale, w: a.rect.w * scale, h: a.rect.h * scale }, colour, 1);
    else outlinePixels(view, a.pixels, sheet.width, scale, colour, Math.max(1, scale >> 1));
  });
  for (const a of assets) {
    if (!a.needsReview) continue;
    strokeRect(view, { x: a.rect.x * scale - 2, y: a.rect.y * scale - 2, w: a.rect.w * scale + 4, h: a.rect.h * scale + 4 }, FLAGGED, 2, 4);
  }
  return view;
}
