import type { Rect, RGBAImage } from './image';

/** Pixels at or below this alpha are background, matching the library detector. */
export const ALPHA_CUTOFF = 24;

export interface Foreground {
  /** 1 for every pixel that belongs to some drawing. */
  mask: Uint8Array;
  /** How the background was told apart. */
  background: 'alpha' | 'colour' | 'none';
  /** The flat backdrop colour, when the sheet paints one instead of being transparent. */
  colour?: [number, number, number];
}

const key = (d: Uint8ClampedArray, i: number) => (d[i * 4] << 16) | (d[i * 4 + 1] << 8) | d[i * 4 + 2];

/**
 * Which pixels are drawing. A transparent sheet is read from its alpha. An
 * opaque one is read from the colour along its border: that colour is
 * flooded inward and only the flooded part is background, so the same
 * colour inside a sprite (white eyes on a white page) is kept.
 */
export function findForeground(image: RGBAImage): Foreground {
  const { width: w, height: h, data } = image;
  const n = w * h;
  const mask = new Uint8Array(n);
  let clear = 0;
  for (let i = 0; i < n; i++) {
    if (data[i * 4 + 3] <= ALPHA_CUTOFF) clear++;
    else mask[i] = 1;
  }
  if (n === 0 || clear / n > 0.01) return { mask, background: 'alpha' };

  const counts = new Map<number, number>();
  let border = 0;
  const visitBorder = (fn: (i: number) => void) => {
    for (let x = 0; x < w; x++) {
      fn(x);
      if (h > 1) fn((h - 1) * w + x);
    }
    for (let y = 1; y < h - 1; y++) {
      fn(y * w);
      if (w > 1) fn(y * w + w - 1);
    }
  };
  visitBorder((i) => {
    if (!mask[i]) return;
    counts.set(key(data, i), (counts.get(key(data, i)) ?? 0) + 1);
    border++;
  });
  let best = -1;
  let bestN = 0;
  for (const [k, c] of counts) if (c > bestN) [best, bestN] = [k, c];
  // A backdrop surrounds the sheet: most of the border, on every side. A tile
  // grid painted edge to edge has no backdrop, its border is many colours.
  const sides = [
    Array.from({ length: w }, (_, x) => x),
    Array.from({ length: w }, (_, x) => (h - 1) * w + x),
    Array.from({ length: h }, (_, y) => y * w),
    Array.from({ length: h }, (_, y) => y * w + w - 1),
  ];
  const onEverySide = best >= 0 && sides.every((side) => side.some((i) => mask[i] && key(data, i) === best));
  if (best < 0 || bestN / border < 0.75 || !onEverySide) return { mask, background: clear > 0 ? 'alpha' : 'none' };

  const stack: number[] = [];
  const seen = new Uint8Array(n);
  visitBorder((i) => {
    if (mask[i] && key(data, i) === best && !seen[i]) {
      seen[i] = 1;
      stack.push(i);
    }
  });
  while (stack.length) {
    const i = stack.pop()!;
    mask[i] = 0;
    const x = i % w;
    const y = (i - x) / w;
    for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
      if (j < 0 || seen[j] || !mask[j] || key(data, j) !== best) continue;
      seen[j] = 1;
      stack.push(j);
    }
  }
  return { mask, background: 'colour', colour: [(best >> 16) & 255, (best >> 8) & 255, best & 255] };
}

export interface Component extends Rect {
  /** 1-based, as stored in the label map. */
  id: number;
  /** Drawn pixels, not box area. */
  area: number;
}

export interface Components {
  /** Component id per pixel, 0 for background. */
  labels: Int32Array;
  list: Component[];
  /** Pixel indices of each component, in the same order as `list`. */
  pixels: Int32Array[];
}

/** 8-connected islands, so diagonal pixel-art strokes stay one piece. Ids follow reading order. */
export function labelComponents(mask: Uint8Array, w: number, h: number): Components {
  const labels = new Int32Array(w * h);
  const list: Component[] = [];
  const pixels: Int32Array[] = [];
  const stack: number[] = [];
  for (let start = 0; start < labels.length; start++) {
    if (!mask[start] || labels[start]) continue;
    const id = list.length + 1;
    const members: number[] = [];
    labels[start] = id;
    stack.push(start);
    let x0 = w;
    let y0 = h;
    let x1 = -1;
    let y1 = -1;
    while (stack.length) {
      const i = stack.pop()!;
      members.push(i);
      const x = i % w;
      const y = (i - x) / w;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if ((dx === 0 && dy === 0) || nx < 0 || nx >= w) continue;
          const j = ny * w + nx;
          if (!mask[j] || labels[j]) continue;
          labels[j] = id;
          stack.push(j);
        }
      }
    }
    list.push({ id, x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, area: members.length });
    pixels.push(Int32Array.from(members).sort());
  }
  return { labels, list, pixels };
}

/** Bounding box of a set of pixel indices, or null when empty. */
export function pixelBox(indices: ArrayLike<number>, w: number): Rect | null {
  if (indices.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -1;
  let y1 = -1;
  for (let k = 0; k < indices.length; k++) {
    const i = indices[k];
    const x = i % w;
    const y = (i - x) / w;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/**
 * How strongly the picture changes across grid lines every `cell` pixels,
 * relative to across any line at all. Above 1 means the lines are real
 * seams. Only lines with drawing on both sides count.
 */
export function gridLineScore(image: RGBAImage, mask: Uint8Array, cell: number, except = 0): number {
  const { width: w, height: h, data } = image;
  if (cell < 4 || cell * 2 > Math.max(w, h)) return 0;
  const diff = (a: number, b: number) =>
    Math.abs(data[a * 4] - data[b * 4]) + Math.abs(data[a * 4 + 1] - data[b * 4 + 1]) + Math.abs(data[a * 4 + 2] - data[b * 4 + 2]);
  let onSum = 0;
  let onN = 0;
  let allSum = 0;
  let allN = 0;
  for (let x = 1; x < w; x++) {
    let s = 0;
    let n = 0;
    for (let y = 0; y < h; y++) {
      const i = y * w + x;
      if (!mask[i] || !mask[i - 1]) continue;
      s += diff(i, i - 1);
      n++;
    }
    if (n === 0) continue;
    allSum += s;
    allN += n;
    if (x % cell === 0 && (!except || x % except !== 0)) {
      onSum += s;
      onN += n;
    }
  }
  for (let y = 1; y < h; y++) {
    let s = 0;
    let n = 0;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!mask[i] || !mask[i - w]) continue;
      s += diff(i, i - w);
      n++;
    }
    if (n === 0) continue;
    allSum += s;
    allN += n;
    if (y % cell === 0 && (!except || y % except !== 0)) {
      onSum += s;
      onN += n;
    }
  }
  if (onN === 0 || allN === 0 || allSum === 0) return 0;
  return onSum / onN / (allSum / allN);
}

/** Common pixel-art cell sizes. */
export const CELL_SIZES = [8, 16, 24, 32, 48, 64];

/**
 * The sheet's cell size from its seams, or null when nothing stands out.
 * The strongest size is taken first, then a smaller size that divides it
 * replaces it only when its own extra lines are seams too: every 96 px line
 * is also a 48 px line, so 96 can win on a 48 px sheet, but 48's lines in
 * between are what prove 48.
 */
export function detectCellSize(image: RGBAImage, mask: Uint8Array, hint?: number): number | null {
  const strong = 1.3;
  if (hint && gridLineScore(image, mask, hint) >= strong) return hint;
  const sizes = [...CELL_SIZES, 96, 128].filter((s) => s * 2 <= Math.max(image.width, image.height));
  const scored = sizes.map((s) => ({ s, score: gridLineScore(image, mask, s) }));
  const top = scored.reduce((a, b) => (b.score > a.score ? b : a), { s: 0, score: 0 });
  if (top.score < strong) return hint ?? null;
  let cell = top.s;
  for (const s of [...sizes].sort((a, b) => b - a)) {
    if (s >= cell || cell % s !== 0) continue;
    if (gridLineScore(image, mask, s, cell) >= strong) cell = s;
  }
  return cell;
}
