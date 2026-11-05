import type { AssetRect } from '../core/doc';

export type Rect = AssetRect;

/** Straight (not premultiplied) RGBA, row by row, 4 bytes a pixel. */
export interface RGBAImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export type Colour = [number, number, number, number];

export function createImage(width: number, height: number, fill?: Colour): RGBAImage {
  const data = new Uint8ClampedArray(width * height * 4);
  if (fill) for (let i = 0; i < data.length; i += 4) data.set(fill, i);
  return { width, height, data };
}

export function cropImage(image: RGBAImage, rect: Rect): RGBAImage {
  const out = createImage(rect.w, rect.h);
  for (let y = 0; y < rect.h; y++) {
    const sy = rect.y + y;
    if (sy < 0 || sy >= image.height) continue;
    for (let x = 0; x < rect.w; x++) {
      const sx = rect.x + x;
      if (sx < 0 || sx >= image.width) continue;
      const from = (sy * image.width + sx) * 4;
      out.data.set(image.data.subarray(from, from + 4), (y * rect.w + x) * 4);
    }
  }
  return out;
}

/** Nearest neighbour only: pixel art must reach the model with hard edges. */
export function upscale(image: RGBAImage, k: number): RGBAImage {
  if (k === 1) return { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data) };
  const out = createImage(image.width * k, image.height * k);
  for (let y = 0; y < out.height; y++) {
    const sy = Math.floor(y / k);
    for (let x = 0; x < out.width; x++) {
      const from = (sy * image.width + Math.floor(x / k)) * 4;
      out.data.set(image.data.subarray(from, from + 4), (y * out.width + x) * 4);
    }
  }
  return out;
}

/** Composites `src` over `dst` at an offset. */
export function drawImage(dst: RGBAImage, src: RGBAImage, dx: number, dy: number): void {
  for (let y = 0; y < src.height; y++) {
    const ty = dy + y;
    if (ty < 0 || ty >= dst.height) continue;
    for (let x = 0; x < src.width; x++) {
      const tx = dx + x;
      if (tx < 0 || tx >= dst.width) continue;
      const s = (y * src.width + x) * 4;
      blendPixel(dst, tx, ty, [src.data[s], src.data[s + 1], src.data[s + 2], src.data[s + 3]]);
    }
  }
}

export function blendPixel(img: RGBAImage, x: number, y: number, c: Colour): void {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const at = (y * img.width + x) * 4;
  const a = c[3] / 255;
  if (a >= 1) {
    img.data.set(c, at);
    return;
  }
  if (a <= 0) return;
  const da = img.data[at + 3] / 255;
  const oa = a + da * (1 - a);
  for (let k = 0; k < 3; k++) img.data[at + k] = (c[k] * a + img.data[at + k] * da * (1 - a)) / oa;
  img.data[at + 3] = oa * 255;
}

export function fillRect(img: RGBAImage, rect: Rect, c: Colour): void {
  for (let y = Math.max(0, rect.y); y < Math.min(img.height, rect.y + rect.h); y++) {
    for (let x = Math.max(0, rect.x); x < Math.min(img.width, rect.x + rect.w); x++) blendPixel(img, x, y, c);
  }
}

export function strokeRect(img: RGBAImage, rect: Rect, c: Colour, thickness = 1, dash = 0): void {
  const on = (t: number) => dash <= 0 || Math.floor(t / dash) % 2 === 0;
  for (let t = 0; t < thickness; t++) {
    const x0 = rect.x + t;
    const y0 = rect.y + t;
    const x1 = rect.x + rect.w - 1 - t;
    const y1 = rect.y + rect.h - 1 - t;
    if (x1 < x0 || y1 < y0) return;
    for (let x = x0; x <= x1; x++) {
      if (!on(x)) continue;
      blendPixel(img, x, y0, c);
      blendPixel(img, x, y1, c);
    }
    for (let y = y0; y <= y1; y++) {
      if (!on(y)) continue;
      blendPixel(img, x0, y, c);
      blendPixel(img, x1, y, c);
    }
  }
}

/** 3 x 5 glyphs, one row per string, for labels that read the same in Node and the browser. */
const GLYPHS: Record<string, string[]> = {
  '0': ['###', '#.#', '#.#', '#.#', '###'],
  '1': ['.#.', '##.', '.#.', '.#.', '###'],
  '2': ['###', '..#', '###', '#..', '###'],
  '3': ['###', '..#', '###', '..#', '###'],
  '4': ['#.#', '#.#', '###', '..#', '..#'],
  '5': ['###', '#..', '###', '..#', '###'],
  '6': ['###', '#..', '###', '#.#', '###'],
  '7': ['###', '..#', '.#.', '.#.', '.#.'],
  '8': ['###', '#.#', '###', '#.#', '###'],
  '9': ['###', '#.#', '###', '..#', '###'],
  '-': ['...', '...', '###', '...', '...'],
  ',': ['...', '...', '...', '.#.', '#..'],
  '#': ['#.#', '###', '#.#', '###', '#.#'],
  x: ['...', '#.#', '.#.', '#.#', '...'],
  y: ['#.#', '#.#', '.##', '..#', '##.'],
  '?': ['###', '..#', '.##', '...', '.#.'],
  ' ': ['...', '...', '...', '...', '...'],
};

export function textSize(text: string, scale: number): { w: number; h: number } {
  return { w: text.length * 4 * scale - scale, h: 5 * scale };
}

/** Draws a label on a solid backdrop so it stays legible over any art. */
export function drawLabel(img: RGBAImage, text: string, x: number, y: number, scale: number, fg: Colour, bg: Colour): Rect {
  const size = textSize(text, scale);
  const box = { x: x, y: y, w: size.w + 2 * scale, h: size.h + 2 * scale };
  fillRect(img, box, bg);
  [...text].forEach((ch, i) => {
    const glyph = GLYPHS[ch] ?? GLYPHS['?'];
    for (let gy = 0; gy < 5; gy++) {
      for (let gx = 0; gx < 3; gx++) {
        if (glyph[gy][gx] !== '#') continue;
        fillRect(img, { x: x + scale + (i * 4 + gx) * scale, y: y + scale + gy * scale, w: scale, h: scale }, fg);
      }
    }
  });
  return box;
}

export function rectArea(r: Rect): number {
  return Math.max(0, r.w) * Math.max(0, r.h);
}

export function intersect(a: Rect, b: Rect): Rect | null {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

export function union(a: Rect, b: Rect): Rect {
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  return { x: x0, y: y0, w: Math.max(a.x + a.w, b.x + b.w) - x0, h: Math.max(a.y + a.h, b.y + b.h) - y0 };
}

export function iou(a: Rect, b: Rect): number {
  const i = intersect(a, b);
  if (!i) return 0;
  const inter = rectArea(i);
  return inter / (rectArea(a) + rectArea(b) - inter);
}

export function expand(r: Rect, by: number, bounds?: { width: number; height: number }): Rect {
  let x0 = r.x - by;
  let y0 = r.y - by;
  let x1 = r.x + r.w + by;
  let y1 = r.y + r.h + by;
  if (bounds) {
    x0 = Math.max(0, x0);
    y0 = Math.max(0, y0);
    x1 = Math.min(bounds.width, x1);
    y1 = Math.min(bounds.height, y1);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Gap in pixels between two boxes along whichever axis separates them; 0 when they touch or overlap. */
export function rectGap(a: Rect, b: Rect): number {
  const dx = Math.max(0, b.x - (a.x + a.w), a.x - (b.x + b.w));
  const dy = Math.max(0, b.y - (a.y + a.h), a.y - (b.y + b.h));
  return Math.max(dx, dy);
}

/** A stable, distinct colour per index, for outlines. */
export function paletteColour(i: number, alpha = 255): Colour {
  const hue = (i * 137.508) % 360;
  const s = 0.85;
  const l = 0.55;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = hue / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r, g, b] =
    hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = l - c / 2;
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255), alpha];
}
