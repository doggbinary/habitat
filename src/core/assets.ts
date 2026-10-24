import type { AssetRect, Tileset } from './doc';

/** Pixels at or below this alpha count as background. */
const ALPHA_CUTOFF = 24;

/**
 * Splits a sheet into separate assets by finding the islands of opaque pixels
 * on its transparent background.
 *
 * Artists rarely leave a perfectly clean gap: a tree's canopy and trunk may
 * not quite touch, and antialiasing leaves stray faint pixels. So islands
 * closer than `gap` pixels are joined into one asset, and scraps smaller than
 * `minArea` pixels are dropped rather than becoming useless one-pixel assets.
 */
export function detectAssets(
  image: CanvasImageSource & { width: number; height: number },
  options: { gap?: number; minArea?: number } = {},
): AssetRect[] {
  const gap = options.gap ?? 2;
  const minArea = options.minArea ?? 16;

  const w = 'naturalWidth' in image ? (image as HTMLImageElement).naturalWidth : image.width;
  const h = 'naturalHeight' in image ? (image as HTMLImageElement).naturalHeight : image.height;
  if (w === 0 || h === 0) return [];

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return [];
  ctx.drawImage(image, 0, 0);
  const pixels = ctx.getImageData(0, 0, w, h).data;

  const solid = new Uint8Array(w * h);
  for (let i = 0; i < solid.length; i++) solid[i] = pixels[i * 4 + 3] > ALPHA_CUTOFF ? 1 : 0;

  // Thicken the islands so near-touching parts of one object fuse. Labels are
  // found on this widened mask, but bounds come from the real pixels below.
  const grown = gap > 0 ? dilate(solid, w, h, gap) : solid;

  const labels = new Int32Array(w * h);
  const bounds: { x0: number; y0: number; x1: number; y1: number; area: number }[] = [];
  const stack: number[] = [];

  for (let start = 0; start < grown.length; start++) {
    if (!grown[start] || labels[start]) continue;
    const label = bounds.length + 1;
    const box = { x0: w, y0: h, x1: -1, y1: -1, area: 0 };
    labels[start] = label;
    stack.push(start);

    while (stack.length > 0) {
      const index = stack.pop()!;
      const x = index % w;
      const y = (index / w) | 0;

      // Only genuinely opaque pixels shape the final rectangle.
      if (solid[index]) {
        if (x < box.x0) box.x0 = x;
        if (y < box.y0) box.y0 = y;
        if (x > box.x1) box.x1 = x;
        if (y > box.y1) box.y1 = y;
        box.area += 1;
      }

      // 8-connected, so diagonal pixel art strokes stay in one piece.
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const ni = ny * w + nx;
          if (!grown[ni] || labels[ni]) continue;
          labels[ni] = label;
          stack.push(ni);
        }
      }
    }
    bounds.push(box);
  }

  const rects: AssetRect[] = bounds
    .filter((b) => b.area >= minArea && b.x1 >= b.x0)
    .map((b) => ({ x: b.x0, y: b.y0, w: b.x1 - b.x0 + 1, h: b.y1 - b.y0 + 1 }));

  return readingOrder(rects);
}

/** Marks every pixel within `radius` of a solid one. */
function dilate(mask: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  // Two separable passes, horizontal then vertical, which grows a square
  // neighbourhood in O(w*h*r) instead of O(w*h*r^2).
  const horizontal = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (!mask[row + x]) continue;
      const from = Math.max(0, x - radius);
      const to = Math.min(w - 1, x + radius);
      for (let i = from; i <= to; i++) horizontal[row + i] = 1;
    }
  }
  const out = new Uint8Array(mask.length);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      if (!horizontal[y * w + x]) continue;
      const from = Math.max(0, y - radius);
      const to = Math.min(h - 1, y + radius);
      for (let i = from; i <= to; i++) out[i * w + x] = 1;
    }
  }
  return out;
}

/**
 * Sorts assets the way you would read the sheet: rows top to bottom, left to
 * right within a row. Rows are grouped by overlap rather than exact top edge,
 * because objects on one shelf of a sheet rarely start on the same pixel.
 */
function readingOrder(rects: AssetRect[]): AssetRect[] {
  const sorted = [...rects].sort((a, b) => a.y - b.y);
  const rows: AssetRect[][] = [];
  for (const rect of sorted) {
    const centre = rect.y + rect.h / 2;
    const row = rows.find((r) => {
      const top = Math.min(...r.map((q) => q.y));
      const bottom = Math.max(...r.map((q) => q.y + q.h));
      return centre >= top && centre <= bottom;
    });
    if (row) row.push(rect);
    else rows.push([rect]);
  }
  return rows.flatMap((row) => row.sort((a, b) => a.x - b.x));
}

/** Fraction of the sheet that is transparent, used to suggest a split mode. */
export function transparencyRatio(image: HTMLImageElement | HTMLCanvasElement): number {
  const w = image instanceof HTMLImageElement ? image.naturalWidth : image.width;
  const h = image instanceof HTMLImageElement ? image.naturalHeight : image.height;
  if (w === 0 || h === 0) return 0;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return 0;
  ctx.drawImage(image, 0, 0);
  const data = ctx.getImageData(0, 0, w, h).data;
  let clear = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] <= ALPHA_CUTOFF) clear += 1;
  return clear / (w * h);
}

/**
 * A sheet that is mostly background is almost certainly a sheet of separate
 * props; one that is mostly filled is ground tiles that butt up against each
 * other and would otherwise fuse into a single giant "object".
 */
export function suggestSplitMode(image: HTMLImageElement | HTMLCanvasElement): 'grid' | 'objects' {
  return transparencyRatio(image) > 0.35 ? 'objects' : 'grid';
}

/** The assets a sheet offers, whichever way it is split. */
export function assetsOf(tileset: Tileset): AssetRect[] {
  if (tileset.splitMode === 'objects' && tileset.assets) return tileset.assets;
  const rects: AssetRect[] = [];
  for (let i = 0; i < tileset.count; i++) {
    const col = i % tileset.cols;
    const row = Math.floor(i / tileset.cols);
    rects.push({
      x: tileset.margin + col * (tileset.tileW + tileset.spacing),
      y: tileset.margin + row * (tileset.tileH + tileset.spacing),
      w: tileset.tileW,
      h: tileset.tileH,
    });
  }
  return rects;
}
