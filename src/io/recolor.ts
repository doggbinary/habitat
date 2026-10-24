import { hsvToRgb, rgbToHsv, type HSV } from '../ui/color-wheel';

/**
 * Recolours a spritesheet by rotating its hues rather than replacing colours.
 *
 * Shifting hue keeps every shade, highlight and outline in the same relative
 * position, so a recoloured sheet still reads as the same art. Replacing
 * colours outright flattens the shading and is why naive recolouring looks
 * wrong.
 */
export interface RecolorOptions {
  /** Degrees to rotate every hue by, -180 to 180. */
  hueShift: number;
  /** Saturation multiplier, 1 leaves it alone. */
  saturation: number;
  /** Brightness multiplier, 1 leaves it alone. */
  brightness: number;
}

/**
 * The hue the art is "about", weighted by how colourful each pixel is.
 *
 * Averaging hues directly is wrong because hue wraps at 360, so red averages
 * with red to give cyan. Summing unit vectors and taking the angle avoids
 * that. Greys are ignored: they have no meaningful hue to contribute.
 */
export function dominantHue(image: HTMLImageElement | HTMLCanvasElement): number {
  const canvas = document.createElement('canvas');
  const w = (canvas.width = image instanceof HTMLImageElement ? image.naturalWidth : image.width);
  const h = (canvas.height = image instanceof HTMLImageElement ? image.naturalHeight : image.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx || w === 0 || h === 0) return 0;
  ctx.drawImage(image, 0, 0);

  const { data } = ctx.getImageData(0, 0, w, h);
  let vx = 0;
  let vy = 0;

  // Sampling every few pixels is plenty for an average and keeps large
  // sheets responsive while the wheel is being dragged.
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 4000))) * 4;
  for (let i = 0; i < data.length; i += step) {
    const o = i - (i % 4);
    if (data[o + 3] < 128) continue;
    const hsv = rgbToHsv(data[o], data[o + 1], data[o + 2]);
    if (hsv.s < 0.15 || hsv.v < 0.12) continue;
    const rad = (hsv.h * Math.PI) / 180;
    vx += Math.cos(rad) * hsv.s;
    vy += Math.sin(rad) * hsv.s;
  }

  if (vx === 0 && vy === 0) return 0;
  let angle = (Math.atan2(vy, vx) * 180) / Math.PI;
  if (angle < 0) angle += 360;
  return angle;
}

/**
 * The colour a tile reads as: dominant hue plus its average saturation and
 * brightness. The asset menu starts its wheel here, so the marker sits on the
 * tile's own colour and dragging it moves the tile from where it already is.
 */
export function dominantColor(image: HTMLImageElement | HTMLCanvasElement): HSV {
  const canvas = document.createElement('canvas');
  const w = (canvas.width = image instanceof HTMLImageElement ? image.naturalWidth : image.width);
  const h = (canvas.height = image instanceof HTMLImageElement ? image.naturalHeight : image.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx || w === 0 || h === 0) return { h: 0, s: 0, v: 1 };
  ctx.drawImage(image, 0, 0);

  const { data } = ctx.getImageData(0, 0, w, h);
  let sTotal = 0;
  let vTotal = 0;
  let count = 0;
  for (let o = 0; o < data.length; o += 4) {
    if (data[o + 3] < 128) continue;
    const hsv = rgbToHsv(data[o], data[o + 1], data[o + 2]);
    sTotal += hsv.s;
    vTotal += hsv.v;
    count += 1;
  }
  if (count === 0) return { h: 0, s: 0, v: 1 };
  return { h: dominantHue(image), s: sTotal / count, v: vTotal / count };
}

export function recolorToCanvas(
  image: HTMLImageElement | HTMLCanvasElement,
  options: RecolorOptions,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  const w = (canvas.width = image instanceof HTMLImageElement ? image.naturalWidth : image.width);
  const h = (canvas.height = image instanceof HTMLImageElement ? image.naturalHeight : image.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return canvas;

  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(image, 0, 0);
  if (w === 0 || h === 0) return canvas;

  const image_ = ctx.getImageData(0, 0, w, h);
  const data = image_.data;

  for (let o = 0; o < data.length; o += 4) {
    // Transparent pixels carry no colour worth shifting.
    if (data[o + 3] === 0) continue;
    const hsv = rgbToHsv(data[o], data[o + 1], data[o + 2]);

    hsv.h = (((hsv.h + options.hueShift) % 360) + 360) % 360;
    hsv.s = Math.max(0, Math.min(1, hsv.s * options.saturation));
    hsv.v = Math.max(0, Math.min(1, hsv.v * options.brightness));

    const [r, g, b] = hsvToRgb(hsv);
    data[o] = r;
    data[o + 1] = g;
    data[o + 2] = b;
  }

  ctx.putImageData(image_, 0, 0);
  return canvas;
}
