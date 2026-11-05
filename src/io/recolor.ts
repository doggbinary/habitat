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
  /** Pushes light and dark apart around mid-grey; 1 leaves it alone. */
  contrast?: number;
  /** Sharpens each pixel against its neighbours, 0 to 1; 0 leaves it alone. */
  clarity?: number;
  /**
   * When set, the main colour is repainted from this ramp instead of shifting
   * every pixel. Darkest stop first. Grey and the outline are left alone.
   */
  shadeRamp?: RampStop[];
}

/** Strength of full clarity: how far a pixel is pushed away from its neighbours' average. */
const CLARITY_STRENGTH = 1.5;

/**
 * Sharpens pixel art: each pixel moves away from the average of its four
 * neighbours. Only opaque neighbours count, so an outline against a clear
 * background does not grow a dark halo.
 */
export function sharpenPixels(data: Uint8ClampedArray, w: number, h: number, amount: number): void {
  if (amount <= 0) return;
  const source = data.slice();
  const k = amount * CLARITY_STRENGTH;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (source[o + 3] === 0) continue;
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      const add = (nx: number, ny: number) => {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) return;
        const p = (ny * w + nx) * 4;
        if (source[p + 3] === 0) return;
        r += source[p];
        g += source[p + 1];
        b += source[p + 2];
        n += 1;
      };
      add(x - 1, y);
      add(x + 1, y);
      add(x, y - 1);
      add(x, y + 1);
      if (n === 0) continue;
      data[o] = source[o] + k * (source[o] - r / n);
      data[o + 1] = source[o + 1] + k * (source[o + 1] - g / n);
      data[o + 2] = source[o + 2] + k * (source[o + 2] - b / n);
    }
  }
}

/** Leaves the art as it is. The recolour dialog starts here. */
export const NO_RECOLOR: RecolorOptions = { hueShift: 0, saturation: 1, brightness: 1 };

/**
 * Shift that makes one object's main colour read as another's, without
 * flattening the shading. Hue rotates, and saturation and brightness scale,
 * so highlights stay highlights and outlines stay darker than the body.
 */
/** Shortest gap between two hues, in degrees. */
export function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** Perceived lightness, 0 to 1. Used to order a shade ramp. */
export function lightness(r: number, g: number, b: number): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/**
 * Grey metal, glass and black outlines sit under this saturation. They are
 * not part of the colour being matched, so a recolour leaves them alone.
 */
export const NEUTRAL_SATURATION = 0.07;

/** A pixel this close to the art's main hue belongs to that colour's ramp. */
export const MAIN_HUE_SPAN = 48;

/** One colour in a ramp, darkest first. */
export type RampStop = [number, number, number];

/** The hue a picture is about, ignoring grey and see-through pixels. */
export function mainHueOf(data: Uint8ClampedArray): number {
  let vx = 0;
  let vy = 0;
  for (let o = 0; o < data.length; o += 4) {
    if (data[o + 3] < 128) continue;
    const hsv = rgbToHsv(data[o], data[o + 1], data[o + 2]);
    // Only clearly coloured pixels vote, so a brown window cannot swing a blue frame.
    if (hsv.s < 0.14 || hsv.v < 0.12) continue;
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
 * True when this pixel is part of the main colour, not the hardware around it.
 * A black outline stays an outline even if the paint tinted it. Grey knobs,
 * glass and bare metal stay grey unless they actually carry the main hue.
 */
export function sharesMainHue(hsv: HSV, main: number): boolean {
  if (hsv.s < NEUTRAL_SATURATION) return false;
  if (hsv.v < 0.12 && hsv.s < 0.55) return false;
  const distance = hueDistance(hsv.h, main);
  // A weak tint has to sit on the main hue. Mixed pixels at a window edge stay put.
  if (hsv.s < 0.18) return distance <= 28;
  return distance <= MAIN_HUE_SPAN;
}

interface Sample {
  L: number;
  r: number;
  g: number;
  b: number;
}

function coloredSamples(data: Uint8ClampedArray): Sample[] {
  const main = mainHueOf(data);
  const samples: Sample[] = [];
  for (let o = 0; o < data.length; o += 4) {
    if (data[o + 3] < 128) continue;
    const hsv = rgbToHsv(data[o], data[o + 1], data[o + 2]);
    if (!sharesMainHue(hsv, main)) continue;
    samples.push({ L: lightness(data[o], data[o + 1], data[o + 2]), r: data[o], g: data[o + 1], b: data[o + 2] });
  }
  samples.sort((a, b) => a.L - b.L);
  return samples;
}

/** The picture's own shades, darkest first, sampled evenly across its lightness. */
export function shadeRampFromPixels(data: Uint8ClampedArray, steps = 24): RampStop[] {
  const samples = coloredSamples(data);
  if (samples.length === 0) return [];
  return sampleRamp(samples, steps);
}

/**
 * A shade ladder for one dropped colour. Lightness runs from a dark shade of
 * that hue to a light one, so the art's own steps have somewhere to land
 * without inventing a second colour.
 */
export function shadeRampFromColor(r: number, g: number, b: number, steps = 24): RampStop[] {
  const hsv = rgbToHsv(r, g, b);
  const samples: Sample[] = [];
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    const v = 0.1 + t * 0.86;
    const s = hsv.s < NEUTRAL_SATURATION ? hsv.s : hsv.s * (0.72 + 0.28 * Math.sin(Math.PI * t));
    const [rr, gg, bb] = hsvToRgb({ h: hsv.h, s, v });
    samples.push({ L: lightness(rr, gg, bb), r: rr, g: gg, b: bb });
  }
  samples.sort((a, b) => a.L - b.L);
  return sampleRamp(samples, steps);
}

function sampleRamp(samples: Sample[], steps: number): RampStop[] {
  const min = samples[0].L;
  const max = samples[samples.length - 1].L;
  const ramp: RampStop[] = [];
  for (let i = 0; i < steps; i++) {
    const goal = min + (i / Math.max(1, steps - 1)) * (max - min);
    let lo = 0;
    let hi = samples.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (samples[mid].L < goal) lo = mid + 1;
      else hi = mid;
    }
    const next = samples[lo];
    const prev = samples[Math.max(0, lo - 1)];
    const pick = Math.abs(prev.L - goal) <= Math.abs(next.L - goal) ? prev : next;
    ramp.push([pick.r, pick.g, pick.b]);
  }
  return ramp;
}

/**
 * Paints the target ramp onto this picture's main colour, matched by
 * lightness. The darkest coloured pixel receives the ramp's darkest stop,
 * the lightest receives the lightest, and a pixel halfway between them
 * receives the stop halfway between. Grey metal, glass and the dark outline
 * are not part of that ramp, so they stay as drawn.
 */
export function applyShadeRamp(data: Uint8ClampedArray, ramp: RampStop[]): void {
  if (ramp.length === 0) return;
  const main = mainHueOf(data);
  let min = Infinity;
  let max = -Infinity;
  const colored: { o: number; L: number }[] = [];
  for (let o = 0; o < data.length; o += 4) {
    if (data[o + 3] < 128) continue;
    const hsv = rgbToHsv(data[o], data[o + 1], data[o + 2]);
    if (!sharesMainHue(hsv, main)) continue;
    const L = lightness(data[o], data[o + 1], data[o + 2]);
    if (L < min) min = L;
    if (L > max) max = L;
    colored.push({ o, L });
  }
  if (colored.length === 0) return;
  const span = max - min;
  const last = ramp.length - 1;
  for (const pixel of colored) {
    const t = span < 1e-4 ? 0.5 : (pixel.L - min) / span;
    const stop = ramp[Math.max(0, Math.min(last, Math.round(t * last)))];
    data[pixel.o] = stop[0];
    data[pixel.o + 1] = stop[1];
    data[pixel.o + 2] = stop[2];
  }
}

export function matchShift(from: HSV, to: HSV): { hueShift: number; saturation: number; brightness: number } {
  let hue = to.h - from.h;
  if (hue > 180) hue -= 360;
  if (hue < -180) hue += 360;
  return {
    hueShift: hue,
    saturation: from.s > 0.02 ? to.s / from.s : 1,
    brightness: from.v > 0.02 ? to.v / from.v : 1,
  };
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
  const contrast = options.contrast ?? 1;
  const ramp = options.shadeRamp;

  if (ramp && ramp.length > 0) applyShadeRamp(data, ramp);

  for (let o = 0; o < data.length; o += 4) {
    // Transparent pixels carry no colour worth shifting.
    if (data[o + 3] === 0) continue;
    let r = data[o];
    let g = data[o + 1];
    let b = data[o + 2];
    if (!ramp || ramp.length === 0) {
      const hsv = rgbToHsv(r, g, b);
      hsv.h = (((hsv.h + options.hueShift) % 360) + 360) % 360;
      hsv.s = Math.max(0, Math.min(1, hsv.s * options.saturation));
      hsv.v = Math.max(0, Math.min(1, hsv.v * options.brightness));
      [r, g, b] = hsvToRgb(hsv);
    }
    // Clamped by the pixel array itself.
    data[o] = (r - 128) * contrast + 128;
    data[o + 1] = (g - 128) * contrast + 128;
    data[o + 2] = (b - 128) * contrast + 128;
  }
  sharpenPixels(data, w, h, options.clarity ?? 0);

  ctx.putImageData(image_, 0, 0);
  return canvas;
}
