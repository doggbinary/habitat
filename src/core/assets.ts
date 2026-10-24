import type { AssetRect, Tileset } from './doc';

/** Pixels at or below this alpha count as background. */
const ALPHA_CUTOFF = 24;

/**
 * A detected asset is treated as several props fused together only when it
 * spans more than this many tiles in both directions...
 */
const OVERSIZE_TILES = 4;
/**
 * ...and is also this many times larger than the typical asset on the same
 * sheet. Being big is not enough on its own: a sheet holding one large tree,
 * or only large props, must keep each one whole. What gives fusion away is a
 * single blob dwarfing everything else that was found.
 */
const OUTLIER_FACTOR = 16;

export interface TileGrid {
  w: number;
  h: number;
  margin: number;
  spacing: number;
}

export interface DetectOptions {
  /** Islands closer than this many pixels are joined into one asset. */
  gap?: number;
  /** Islands with fewer opaque pixels than this are dropped as noise. */
  minArea?: number;
  /**
   * The sheet's tile grid. Densely packed sheets put props edge to edge, so
   * transparency alone cannot separate them; the grid is the fallback.
   */
  tile?: TileGrid;
}

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
  options: DetectOptions = {},
): AssetRect[] {
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

  const alpha = new Uint8Array(w * h);
  for (let i = 0; i < alpha.length; i++) alpha[i] = pixels[i * 4 + 3];
  return detectAssetsInMask(alpha, w, h, options);
}

/**
 * The detection itself, on a plain alpha channel so it can be reasoned about
 * and tested without a canvas.
 *
 * It works in up to three passes, each only where the last one failed:
 *  1. Islands, with small gaps bridged so one prop's loose parts stay whole.
 *  2. Any suspiciously large result is re-split with no gap bridging, in
 *     case bridging is what fused neighbours together.
 *  3. Anything still too large is cut along the sheet's tile grid. Packed
 *     sheets are designed on that grid, so it is where the props really are.
 */
export function detectAssetsInMask(
  alpha: Uint8Array,
  w: number,
  h: number,
  options: DetectOptions = {},
): AssetRect[] {
  const gap = options.gap ?? 2;
  const minArea = options.minArea ?? 16;
  const tile = options.tile;
  if (w === 0 || h === 0) return [];

  const solid = new Uint8Array(w * h);
  for (let i = 0; i < solid.length; i++) solid[i] = alpha[i] > ALPHA_CUTOFF ? 1 : 0;

  const full: AssetRect = { x: 0, y: 0, w, h };
  const islands = findIslands(solid, w, full, gap, minArea);

  // The lower median, so a sheet with only a couple of finds still has a
  // sensible "typical" size rather than an average dragged up by the outlier.
  const areas = islands.map((r) => r.w * r.h).sort((a, b) => a - b);
  const typical = areas.length > 0 ? areas[Math.floor((areas.length - 1) / 2)] : 0;
  const oversized = (r: AssetRect) =>
    !!tile &&
    r.w > tile.w * OVERSIZE_TILES &&
    r.h > tile.h * OVERSIZE_TILES &&
    r.w * r.h > typical * OUTLIER_FACTOR;

  const result: AssetRect[] = [];

  for (const island of islands) {
    if (!oversized(island)) {
      result.push(island);
      continue;
    }
    for (const part of findIslands(solid, w, island, 0, minArea)) {
      if (oversized(part) && tile) result.push(...splitByGrid(solid, w, part, tile, minArea));
      else result.push(part);
    }
  }

  return readingOrder(result);
}

/**
 * Connected regions of opaque pixels inside `region`, 8-connected so diagonal
 * pixel-art strokes stay in one piece. Labels come from a mask widened by
 * `gap`, but each rectangle is fitted to the real pixels.
 */
function findIslands(solid: Uint8Array, sheetW: number, region: AssetRect, gap: number, minArea: number): AssetRect[] {
  const { x: rx, y: ry, w, h } = region;
  const local = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) local[y * w + x] = solid[(ry + y) * sheetW + (rx + x)];
  }

  // Both neighbours grow toward each other, so growing each by half the gap
  // bridges exactly `gap` transparent pixels. Growing each by the full gap
  // would bridge twice that, fusing separate props on a tightly packed sheet.
  const grown = gap > 0 ? dilate(local, w, h, Math.ceil(gap / 2)) : local;
  const labels = new Uint8Array(w * h);
  const rects: AssetRect[] = [];
  const stack: number[] = [];

  for (let start = 0; start < grown.length; start++) {
    if (!grown[start] || labels[start]) continue;
    let x0 = w;
    let y0 = h;
    let x1 = -1;
    let y1 = -1;
    let area = 0;
    labels[start] = 1;
    stack.push(start);

    while (stack.length > 0) {
      const index = stack.pop()!;
      const x = index % w;
      const y = (index / w) | 0;

      // Only genuinely opaque pixels shape the final rectangle.
      if (local[index]) {
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
        area += 1;
      }

      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const ni = ny * w + nx;
          if (!grown[ni] || labels[ni]) continue;
          labels[ni] = 1;
          stack.push(ni);
        }
      }
    }

    if (area >= minArea && x1 >= x0) rects.push({ x: rx + x0, y: ry + y0, w: x1 - x0 + 1, h: y1 - y0 + 1 });
  }
  return rects;
}

/** One asset per grid cell of `region` that holds anything, fitted tight. */
function splitByGrid(solid: Uint8Array, sheetW: number, region: AssetRect, tile: TileGrid, minArea: number): AssetRect[] {
  const pitchX = tile.w + tile.spacing;
  const pitchY = tile.h + tile.spacing;
  const firstCol = Math.max(0, Math.floor((region.x - tile.margin) / pitchX));
  const firstRow = Math.max(0, Math.floor((region.y - tile.margin) / pitchY));
  const lastCol = Math.floor((region.x + region.w - 1 - tile.margin) / pitchX);
  const lastRow = Math.floor((region.y + region.h - 1 - tile.margin) / pitchY);
  const rects: AssetRect[] = [];

  for (let row = firstRow; row <= lastRow; row++) {
    for (let col = firstCol; col <= lastCol; col++) {
      // The cell, clipped to the region being split.
      const cx0 = Math.max(region.x, tile.margin + col * pitchX);
      const cy0 = Math.max(region.y, tile.margin + row * pitchY);
      const cx1 = Math.min(region.x + region.w, tile.margin + col * pitchX + tile.w) - 1;
      const cy1 = Math.min(region.y + region.h, tile.margin + row * pitchY + tile.h) - 1;

      let x0 = Number.POSITIVE_INFINITY;
      let y0 = Number.POSITIVE_INFINITY;
      let x1 = -1;
      let y1 = -1;
      let area = 0;
      for (let y = cy0; y <= cy1; y++) {
        for (let x = cx0; x <= cx1; x++) {
          if (!solid[y * sheetW + x]) continue;
          if (x < x0) x0 = x;
          if (y < y0) y0 = y;
          if (x > x1) x1 = x;
          if (y > y1) y1 = y;
          area += 1;
        }
      }
      if (area >= minArea) rects.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 });
    }
  }
  return rects;
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

/** The tile grid a sheet was sliced with, for detection's grid fallback. */
export function gridOf(tileset: Tileset): TileGrid {
  return { w: tileset.tileW, h: tileset.tileH, margin: tileset.margin, spacing: tileset.spacing };
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
