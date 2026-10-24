import type { AssetRect, Tileset } from './doc';

/** Pixels at or below this alpha count as background. */
const ALPHA_CUTOFF = 24;

/**
 * Bumped whenever detection changes in a way that alters results, so sheets
 * detected by an older version are redone when a project loads.
 */
export const DETECT_VERSION = 3;

/** A cell this solid reads as floor: ground texture runs edge to edge. */
const FLOOR_FILL = 0.97;
/**
 * A partly filled cell continues a floor when the edge they share is this
 * solid. A real border or counter front spans the whole edge; a bush pressed
 * against the end of a floor does not, and must stay a prop.
 */
const FLOOR_EDGE = 0.95;
/**
 * ...and when this share of what is drawn in it hangs off that edge. Sheets
 * often let a floor's art spill a pixel past the grid line, so a pot sitting
 * just below a floor gets a solid top row too; but the pot is not attached to
 * it, while a border or a counter's legs are.
 */
const FLOOR_ATTACHED = 0.8;
/**
 * Solid runs this many cells or smaller are probably things (a fridge, a
 * door), so they stay available as props as well as ground.
 */
const SMALL_RUN = 3;
/**
 * RPG Maker style packs name their sheets by kind: A1 to A5 are ground and
 * wall autotiles, B onwards are objects. Most packs follow it, and it is far
 * more reliable than guessing from pixels: some ground sheets are a third
 * transparent, and some object sheets are completely solid.
 */
export function isGroundSheetName(name: string): boolean {
  return /(?:^|[^a-z0-9])a[1-5](?:[^0-9]|$)/i.test(name);
}

function isObjectSheetName(name: string): boolean {
  return /(?:^|[^a-z0-9])[b-e](?:[^a-z]|$)/i.test(name);
}

/**
 * A scrap smaller than this share of a tile may belong to a bigger neighbour.
 * Tuned below the size of the smallest real props on typical sheets: a chair
 * beside a table is a prop in its own right and must not be swallowed.
 */
const FRAGMENT_SHARE = 1 / 16;
/** ...if it sits within this many pixels of it... */
const FRAGMENT_REACH = 4;
/** ...and that neighbour is at least this many times its size. */
const FRAGMENT_PARENT_RATIO = 6;

export interface TileGrid {
  w: number;
  h: number;
  margin: number;
  spacing: number;
}

export interface DetectOptions {
  /**
   * Islands closer than this many pixels are joined into one asset. Off by
   * default: sheets pack separate props a pixel or two apart, so bridging
   * even small gaps glues neighbours together (stacked trees become one tall
   * blob). Detached bits of one prop are rejoined by fragment absorption
   * instead, which only ever attaches small scraps to large neighbours.
   */
  gap?: number;
  /** Islands with fewer opaque pixels than this are dropped as noise. */
  minArea?: number;
  /** The sheet's tile grid, used to judge what counts as a small scrap. */
  tile?: TileGrid;
  /** Ground to leave out, so props drawn beside a floor do not fuse with it. */
  ground?: Ground;
}

/** A tile grid with its extent, enough to walk every cell. */
export interface SheetGrid extends TileGrid {
  cols: number;
  rows: number;
}

/** Which cells of a sheet are ground, as opposed to props. */
export interface Ground {
  grid: SheetGrid;
  /** 1 for each cell, by tile index, that is ground. */
  cells: Uint8Array;
  /** Small solid runs that are also offered as props. */
  props: AssetRect[];
}

type SheetImage = CanvasImageSource & { width: number; height: number };

/** A sheet's alpha channel, one byte per pixel, with its dimensions. */
export function alphaChannel(image: SheetImage): { alpha: Uint8Array; w: number; h: number } {
  const w = 'naturalWidth' in image ? (image as HTMLImageElement).naturalWidth : image.width;
  const h = 'naturalHeight' in image ? (image as HTMLImageElement).naturalHeight : image.height;
  const alpha = new Uint8Array(w * h);
  if (w === 0 || h === 0) return { alpha, w, h };

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return { alpha, w, h };
  ctx.drawImage(image, 0, 0);
  const pixels = ctx.getImageData(0, 0, w, h).data;
  for (let i = 0; i < alpha.length; i++) alpha[i] = pixels[i * 4 + 3];
  return { alpha, w, h };
}

/**
 * Splits a sheet into separate assets by finding the islands of opaque pixels
 * on its transparent background: one asset per separate thing on the sheet,
 * kept whole, never cut along the grid.
 */
export function detectAssets(image: SheetImage, options: DetectOptions = {}): AssetRect[] {
  const { alpha, w, h } = alphaChannel(image);
  return detectAssetsInMask(alpha, w, h, options);
}

// --- Fixing detection by hand ----------------------------------------------

/**
 * Joins several assets into one covering all of them, for a prop that came
 * out in pieces. The result takes the place of the first one picked, so the
 * palette does not jump around.
 */
export function mergeAssets(assets: AssetRect[], indices: number[]): AssetRect[] {
  const picked = [...new Set(indices)].filter((i) => assets[i]).sort((a, b) => a - b);
  if (picked.length < 2) return assets;
  const rects = picked.map((i) => assets[i]);
  const x0 = Math.min(...rects.map((r) => r.x));
  const y0 = Math.min(...rects.map((r) => r.y));
  const x1 = Math.max(...rects.map((r) => r.x + r.w));
  const y1 = Math.max(...rects.map((r) => r.y + r.h));
  const merged: AssetRect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  const drop = new Set(picked.slice(1));
  return assets.flatMap((r, i) => (drop.has(i) ? [] : i === picked[0] ? [merged] : [r]));
}

export function deleteAssets(assets: AssetRect[], indices: number[]): AssetRect[] {
  const drop = new Set(indices);
  return assets.filter((_, i) => !drop.has(i));
}

/** Replaces one asset with the pieces it was split into, in its place. */
export function replaceAsset(assets: AssetRect[], index: number, pieces: AssetRect[]): AssetRect[] {
  if (!assets[index]) return assets;
  return [...assets.slice(0, index), ...pieces, ...assets.slice(index + 1)];
}

/**
 * The detection itself, on a plain alpha channel so it can be reasoned about
 * and tested without a canvas.
 *
 *  1. Every island of opaque pixels becomes a candidate asset.
 *  2. Tiny scraps hugging a much larger asset are folded into it: a swing's
 *     seats, sparkles beside a fountain. A scrap with nothing big nearby is
 *     its own small prop, or noise if it is below `minArea`.
 */
export function detectAssetsInMask(
  alpha: Uint8Array,
  w: number,
  h: number,
  options: DetectOptions = {},
): AssetRect[] {
  const gap = options.gap ?? 0;
  const minArea = options.minArea ?? 16;
  if (w === 0 || h === 0) return [];

  const solid = new Uint8Array(w * h);
  for (let i = 0; i < solid.length; i++) solid[i] = alpha[i] > ALPHA_CUTOFF ? 1 : 0;
  const ground = options.ground;
  if (ground) {
    forEachCell(ground.grid, w, h, (index, x0, y0, cw, ch) => {
      if (!ground.cells[index]) return;
      for (let y = y0; y < y0 + ch; y++) solid.fill(0, y * w + x0, y * w + x0 + cw);
    });
  }

  // Keep even single pixels for now: a scrap too small to stand alone may
  // still be part of the prop beside it, and only absorption can tell.
  const islands = findIslands(solid, w, { x: 0, y: 0, w, h }, gap, 1);
  const tileArea = options.tile ? options.tile.w * options.tile.h : 48 * 48;
  const kept = absorbFragments(islands, tileArea * FRAGMENT_SHARE).filter((r) => r.area >= minArea);

  const rects = kept.map(({ x, y, w: rw, h: rh }) => ({ x, y, w: rw, h: rh }));
  if (ground) rects.push(...ground.props);
  return readingOrder(rects);
}

/** Visits every whole cell of a grid that fits inside the image. */
function forEachCell(
  grid: SheetGrid,
  w: number,
  h: number,
  visit: (index: number, x: number, y: number, cw: number, ch: number) => void,
): void {
  for (let row = 0; row < grid.rows; row++) {
    for (let col = 0; col < grid.cols; col++) {
      const x = grid.margin + col * (grid.w + grid.spacing);
      const y = grid.margin + row * (grid.h + grid.spacing);
      if (x + grid.w > w || y + grid.h > h) continue;
      visit(row * grid.cols + col, x, y, grid.w, grid.h);
    }
  }
}

/** Share of a sheet that is see-through. */
export function transparentShare(alpha: Uint8Array): number {
  if (alpha.length === 0) return 0;
  let clear = 0;
  for (let i = 0; i < alpha.length; i++) if (alpha[i] <= ALPHA_CUTOFF) clear++;
  return clear / alpha.length;
}

/**
 * Sorts a sheet's cells into ground and the rest.
 *
 * On a ground sheet (`wholeSheet`, an autotile sheet) every drawn cell is
 * ground: its edge pieces are partly transparent by design. Elsewhere,
 * ground is where texture runs edge to edge across two or more neighbouring
 * cells (grass, cobbles, floorboards, countertops), plus the partly filled
 * cells that carry such a run on across a solid edge (a path's border, a
 * counter's front). A single solid cell is left as a prop.
 */
export function findGround(alpha: Uint8Array, w: number, h: number, grid: SheetGrid, wholeSheet = false): Ground {
  const count = grid.cols * grid.rows;
  const cells = new Uint8Array(count);
  const props: AssetRect[] = [];
  const fill = new Float32Array(count);
  const solidAt = (x: number, y: number) => alpha[y * w + x] > ALPHA_CUTOFF;

  forEachCell(grid, w, h, (index, x0, y0, cw, ch) => {
    let solid = 0;
    for (let y = y0; y < y0 + ch; y++) for (let x = x0; x < x0 + cw; x++) if (solidAt(x, y)) solid++;
    fill[index] = solid / (cw * ch);
  });

  if (wholeSheet) {
    for (let i = 0; i < count; i++) cells[i] = fill[i] > 0 ? 1 : 0;
    return { grid, cells, props };
  }

  // Runs of solid cells, joined edge to edge.
  const run = new Int32Array(count).fill(-1);
  const runs: number[][] = [];
  const neighbours = (i: number): number[] => {
    const col = i % grid.cols;
    const row = Math.floor(i / grid.cols);
    const out: number[] = [];
    if (col > 0) out.push(i - 1);
    if (col < grid.cols - 1) out.push(i + 1);
    if (row > 0) out.push(i - grid.cols);
    if (row < grid.rows - 1) out.push(i + grid.cols);
    return out;
  };
  for (let i = 0; i < count; i++) {
    if (fill[i] < FLOOR_FILL || run[i] !== -1) continue;
    const members: number[] = [];
    const stack = [i];
    run[i] = runs.length;
    while (stack.length > 0) {
      const k = stack.pop()!;
      members.push(k);
      for (const j of neighbours(k)) {
        if (fill[j] >= FLOOR_FILL && run[j] === -1) {
          run[j] = runs.length;
          stack.push(j);
        }
      }
    }
    runs.push(members);
  }
  for (const members of runs) {
    if (members.length < 2) continue;
    for (const k of members) cells[k] = 1;
    if (members.length <= SMALL_RUN) props.push(cellsBox(members, grid));
  }

  // Partly filled cells that continue a run across a solid shared edge. Only
  // one step out, so a run can never creep across a sheet of props.
  const edges: number[] = [];
  for (let i = 0; i < count; i++) {
    if (cells[i] || fill[i] === 0) continue;
    if (neighbours(i).some((j) => cells[j] && continuesFloor(i, j, grid, solidAt))) edges.push(i);
  }
  for (const i of edges) cells[i] = 1;
  return { grid, cells, props };
}

/** Pixel box covering a set of cells. */
function cellsBox(members: number[], grid: SheetGrid): AssetRect {
  const cols = members.map((k) => k % grid.cols);
  const rows = members.map((k) => Math.floor(k / grid.cols));
  const c0 = Math.min(...cols);
  const r0 = Math.min(...rows);
  const c1 = Math.max(...cols);
  const r1 = Math.max(...rows);
  return {
    x: grid.margin + c0 * (grid.w + grid.spacing),
    y: grid.margin + r0 * (grid.h + grid.spacing),
    w: (c1 - c0) * (grid.w + grid.spacing) + grid.w,
    h: (r1 - r0) * (grid.h + grid.spacing) + grid.h,
  };
}

/**
 * Whether cell `i` carries on the floor in neighbour `j`: solid right along
 * the edge they share, with most of what is drawn in it attached to that edge.
 */
function continuesFloor(
  i: number,
  j: number,
  grid: SheetGrid,
  solidAt: (x: number, y: number) => boolean,
): boolean {
  const col = i % grid.cols;
  const row = Math.floor(i / grid.cols);
  const x0 = grid.margin + col * (grid.w + grid.spacing);
  const y0 = grid.margin + row * (grid.h + grid.spacing);
  const horizontal = Math.abs(i - j) === 1;
  const length = horizontal ? grid.h : grid.w;

  const edge: [number, number][] = [];
  for (let t = 0; t < length; t++) {
    const x = horizontal ? (j > i ? x0 + grid.w - 1 : x0) : x0 + t;
    const y = horizontal ? y0 + t : j > i ? y0 + grid.h - 1 : y0;
    if (solidAt(x, y)) edge.push([x, y]);
  }
  if (edge.length / length < FLOOR_EDGE) return false;

  // Flood from the edge through solid pixels, staying inside the cell.
  const seen = new Uint8Array(grid.w * grid.h);
  const stack = edge.map(([x, y]) => (y - y0) * grid.w + (x - x0));
  for (const k of stack) seen[k] = 1;
  let attached = 0;
  while (stack.length > 0) {
    const k = stack.pop()!;
    attached++;
    const lx = k % grid.w;
    const ly = Math.floor(k / grid.w);
    for (const [nx, ny] of [[lx + 1, ly], [lx - 1, ly], [lx, ly + 1], [lx, ly - 1]]) {
      if (nx < 0 || ny < 0 || nx >= grid.w || ny >= grid.h) continue;
      const n = ny * grid.w + nx;
      if (seen[n] || !solidAt(x0 + nx, y0 + ny)) continue;
      seen[n] = 1;
      stack.push(n);
    }
  }
  let total = 0;
  for (let y = y0; y < y0 + grid.h; y++) for (let x = x0; x < x0 + grid.w; x++) if (solidAt(x, y)) total++;
  return attached / total >= FLOOR_ATTACHED;
}

interface Island extends AssetRect {
  /** Opaque pixels, not box area: a thin diagonal pole has a big box but few pixels. */
  area: number;
}

/** Gap in pixels between two boxes along whichever axis separates them. */
function boxGap(a: AssetRect, b: AssetRect): number {
  const dx = Math.max(0, b.x - (a.x + a.w), a.x - (b.x + b.w));
  const dy = Math.max(0, b.y - (a.y + a.h), a.y - (b.y + b.h));
  return Math.max(dx, dy);
}

/**
 * Folds each small scrap into the nearest much larger island within reach.
 * Smallest scraps go first, and a scrap only ever joins something at least
 * `FRAGMENT_PARENT_RATIO` times bigger, so two genuine small props can never
 * absorb each other and a pebble beside a fence stays a pebble.
 */
function absorbFragments(islands: Island[], maxFragment: number): Island[] {
  const pool = islands.map((r) => ({ ...r }));
  const order = [...pool].sort((a, b) => a.area - b.area);
  const gone = new Set<Island>();

  for (const scrap of order) {
    if (scrap.area >= maxFragment || gone.has(scrap)) continue;
    let parent: Island | null = null;
    let best = FRAGMENT_REACH + 1;
    for (const other of pool) {
      if (other === scrap || gone.has(other)) continue;
      if (other.area < scrap.area * FRAGMENT_PARENT_RATIO) continue;
      const d = boxGap(scrap, other);
      if (d < best) {
        best = d;
        parent = other;
      }
    }
    if (!parent) continue;
    const x0 = Math.min(parent.x, scrap.x);
    const y0 = Math.min(parent.y, scrap.y);
    parent.w = Math.max(parent.x + parent.w, scrap.x + scrap.w) - x0;
    parent.h = Math.max(parent.y + parent.h, scrap.y + scrap.h) - y0;
    parent.x = x0;
    parent.y = y0;
    parent.area += scrap.area;
    gone.add(scrap);
  }
  return pool.filter((r) => !gone.has(r));
}

/**
 * Connected regions of opaque pixels inside `region`, 8-connected so diagonal
 * pixel-art strokes stay in one piece. Labels come from a mask widened by
 * `gap`, but each rectangle is fitted to the real pixels.
 */
function findIslands(solid: Uint8Array, sheetW: number, region: AssetRect, gap: number, minArea: number): Island[] {
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
  const rects: Island[] = [];
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

    if (area >= minArea && x1 >= x0) rects.push({ x: rx + x0, y: ry + y0, w: x1 - x0 + 1, h: y1 - y0 + 1, area });
  }
  return rects;
}

/**
 * Cuts one asset into a grid cell per piece that holds anything, fitted
 * tight. Never applied automatically: it is the user's "split into tiles"
 * for art drawn to blend together, such as a strip of tulip beds.
 */
export function splitAssetByGrid(
  alpha: Uint8Array,
  sheetW: number,
  region: AssetRect,
  tile: TileGrid,
  minArea = 16,
): AssetRect[] {
  const pitchX = tile.w + tile.spacing;
  const pitchY = tile.h + tile.spacing;
  const firstCol = Math.max(0, Math.floor((region.x - tile.margin) / pitchX));
  const firstRow = Math.max(0, Math.floor((region.y - tile.margin) / pitchY));
  const lastCol = Math.floor((region.x + region.w - 1 - tile.margin) / pitchX);
  const lastRow = Math.floor((region.y + region.h - 1 - tile.margin) / pitchY);
  const rects: AssetRect[] = [];

  for (let row = firstRow; row <= lastRow; row++) {
    for (let col = firstCol; col <= lastCol; col++) {
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
          if (alpha[y * sheetW + x] <= ALPHA_CUTOFF) continue;
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
export function suggestSplitMode(image: HTMLImageElement | HTMLCanvasElement, name = ''): 'grid' | 'objects' {
  if (isGroundSheetName(name)) return 'grid';
  if (isObjectSheetName(name)) return 'objects';
  return transparencyRatio(image) > 0.35 ? 'objects' : 'grid';
}

/** The tile grid a sheet was sliced with, for detection's grid fallback. */
export function gridOf(tileset: Tileset): TileGrid {
  return { w: tileset.tileW, h: tileset.tileH, margin: tileset.margin, spacing: tileset.spacing };
}

export function sheetGrid(tileset: Tileset): SheetGrid {
  return { ...gridOf(tileset), cols: tileset.cols, rows: tileset.rows };
}

/** Which of a sheet's cells are ground. */
export function groundOf(tileset: Tileset): Ground | null {
  if (!tileset.image) return null;
  const { alpha, w, h } = alphaChannel(tileset.image);
  return findGround(alpha, w, h, sheetGrid(tileset), isGroundSheetName(tileset.name));
}

/**
 * A sheet's props, found with its ground left out, so the floor a prop
 * stands beside never fuses with it into one giant asset.
 */
export function detectSheetProps(tileset: Tileset): AssetRect[] {
  if (!tileset.image) return [];
  const { alpha, w, h } = alphaChannel(tileset.image);
  // On a ground sheet every cell is ground, so there would be nothing left
  // to find; any props there come from the whole image instead.
  const ground = isGroundSheetName(tileset.name) ? undefined : findGround(alpha, w, h, sheetGrid(tileset));
  return detectAssetsInMask(alpha, w, h, { tile: gridOf(tileset), ground });
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
