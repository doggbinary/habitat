/**
 * Packs draw a thin dark line around a floor swatch so the squares are easy
 * to tell apart on the sheet. Painted edge to edge, that line becomes a gap
 * between every square. An edge that is one flat colour, and clearly darker
 * than the middle of the square, is that line: it is left out when the
 * square is drawn and the texture inside is stretched the one pixel back.
 */

export interface EdgeInset {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const NO_INSET: EdgeInset = { top: 0, right: 0, bottom: 0, left: 0 };

/** Mean channel deviation below this is one flat colour, not a texture. */
const OUTLINE_SPREAD = 22;
/** The line has to be at least this much darker than the middle of the square. */
const OUTLINE_DARKER = 30;
/** Alpha deviation below this is one even line, not a ragged edge. */
const OUTLINE_ALPHA = 40;
/** An even edge this see-through is a soft outline, not the texture. */
const OUTLINE_ALPHA_MAX = 230;

/**
 * Which edges of a floor square are a flat dark outline, in pixels (0 or 1).
 * A square smaller than a few pixels, or one whose edges are part of the
 * texture, is left untouched.
 */
export function floorEdgeInset(
  rgba: Uint8ClampedArray,
  width: number,
  x0: number,
  y0: number,
  w: number,
  h: number,
): EdgeInset {
  if (w < 6 || h < 6) return NO_INSET;
  let centre = 0;
  let counted = 0;
  for (let y = y0 + 2; y < y0 + h - 2; y++) {
    for (let x = x0 + 2; x < x0 + w - 2; x++) {
      const p = (y * width + x) * 4;
      if (rgba[p + 3] < 200) continue;
      centre += rgba[p] + rgba[p + 1] + rgba[p + 2];
      counted++;
    }
  }
  if (counted < 4) return NO_INSET;
  centre /= counted;

  const inset: EdgeInset = { top: 0, right: 0, bottom: 0, left: 0 };
  /** How many pixels of flat outline sit on this side. Packs often draw two: a see-through line, then a darker one. */
  const depth = (horizontal: boolean, start: number, step: number, limit: number): number => {
    let n = 0;
    for (let i = 0; i < 2 && n < limit; i++) {
      if (!isOutline(horizontal, start + step * i)) break;
      n++;
    }
    return n;
  };
  const isOutline = (horizontal: boolean, at: number): boolean => {
    const n = horizontal ? w : h;
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    for (let i = 0; i < n; i++) {
      const x = horizontal ? x0 + i : at;
      const y = horizontal ? at : y0 + i;
      const p = (y * width + x) * 4;
      r += rgba[p];
      g += rgba[p + 1];
      b += rgba[p + 2];
      a += rgba[p + 3];
    }
    const mr = r / n;
    const mg = g / n;
    const mb = b / n;
    let dev = 0;
    let alphaDev = 0;
    const ma = a / n;
    for (let i = 0; i < n; i++) {
      const x = horizontal ? x0 + i : at;
      const y = horizontal ? at : y0 + i;
      const p = (y * width + x) * 4;
      dev += Math.abs(rgba[p] - mr) + Math.abs(rgba[p + 1] - mg) + Math.abs(rgba[p + 2] - mb);
      alphaDev += Math.abs(rgba[p + 3] - ma);
    }
    const even = dev / n <= OUTLINE_SPREAD && alphaDev / n <= OUTLINE_ALPHA;
    const lum = (r + g + b) / n;
    // A flat dark line, or a flat see-through line. Both read as a gap once
    // the square is painted on the map's dark background.
    return even && (lum + OUTLINE_DARKER <= centre || ma <= OUTLINE_ALPHA_MAX);
  };
  inset.top = depth(true, y0, 1, h);
  inset.bottom = depth(true, y0 + h - 1, -1, h);
  inset.left = depth(false, x0, 1, w);
  inset.right = depth(false, x0 + w - 1, -1, w);
  if (inset.left + inset.right >= w - 2) {
    inset.left = 0;
    inset.right = 0;
  }
  if (inset.top + inset.bottom >= h - 2) {
    inset.top = 0;
    inset.bottom = 0;
  }
  return inset;
}

const pixels = new WeakMap<HTMLImageElement | HTMLCanvasElement, { data: Uint8ClampedArray; width: number }>();

/** The outline inset for a square of a sheet image, read once and remembered. */
export function imageEdgeInset(
  image: HTMLImageElement | HTMLCanvasElement,
  x: number,
  y: number,
  w: number,
  h: number,
): EdgeInset {
  let cached = pixels.get(image);
  if (!cached) {
    if (typeof document === 'undefined') return NO_INSET;
    const width = image instanceof HTMLImageElement ? image.naturalWidth : image.width;
    const height = image instanceof HTMLImageElement ? image.naturalHeight : image.height;
    if (width <= 0 || height <= 0) return NO_INSET;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return NO_INSET;
    ctx.drawImage(image, 0, 0);
    cached = { data: ctx.getImageData(0, 0, width, height).data, width };
    pixels.set(image, cached);
  }
  return floorEdgeInset(cached.data, cached.width, x, y, w, h);
}
