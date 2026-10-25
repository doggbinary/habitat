import type { AssetRect, Tileset } from './doc';

/** Pixels at or below this alpha count as background. */
const ALPHA_CUTOFF = 24;

/**
 * Bumped whenever detection changes in a way that alters results, so sheets
 * detected by an older version are redone when a project loads.
 */
export const DETECT_VERSION = 13;

/** A ground cell is drawn corner to corner; a prop leaves background showing. */
const TERRAIN_FILL = 0.92;
/** Cells this close in average colour are the same ground. */
const TERRAIN_MATCH = 12;
/** ...and ground has to turn up this many times to count as a texture. */
const TERRAIN_REPEATS = 3;
/** How plain a square has to be: a cupboard door is patterned, grass is not. */
const TERRAIN_FLAT = 8;
/**
 * A unique floor tile (a crosswalk, a parking line) is almost all ground
 * colour. A tree on a sidewalk is not, and must not be swallowed.
 */
/**
 * A unique floor tile (a parking line, a crosswalk) is almost all ground
 * colour and still fairly flat. A boat on water is not flat.
 */
const TERRAIN_COVER_BUSY = 0.8;
const TERRAIN_COVER_FLAT = 12;
/** Each cell is averaged down to this many blocks a side before comparing. */
const LOOK_SIZE = 8;
/** Colour jump across a grid line that means two drawings meet there. */
const SEAM_CUT = 36;
/** A shared edge thinner than this is two props that merely touch: always cut. */
const SEAM_THIN = 0.18;
/** ...judged only where this share of the line has both sides drawn. */
const SEAM_TOUCH = 0.3;
/** A colour has to cover this much of the ground to count as a ground colour. */
const PALETTE_SHARE = 0.002;
/** ...and a pixel this close to one of those colours is ground too. */
const PALETTE_NEAR = 20;
/** An island this many cells big may be a panel with things standing on it. */
const PANEL_MIN_CELLS = 6;
/** ...and is only treated as one when this much of it turns out to be ground. */
const PANEL_BACKGROUND = 0.3;
/** Whatever is left standing has to be this much of a cell to be a prop. */
const PANEL_PIECE_SHARE = 0.25;

/**
 * Some packs paint objects on solid white instead of a transparent
 * background. That white joins every tent or tree into one island, so it
 * is treated as empty — but only when the sheet has no real transparency
 * and a large share of the picture is that flat void.
 */
function punchFakeBackground(rgba: Uint8ClampedArray, alpha: Uint8Array): void {
  let clear = 0;
  let white = 0;
  for (let i = 0; i < alpha.length; i++) {
    if (alpha[i] <= ALPHA_CUTOFF) {
      clear += 1;
      continue;
    }
    const at = i * 4;
    if (rgba[at] > 245 && rgba[at + 1] > 245 && rgba[at + 2] > 245) white += 1;
  }
  if (clear / alpha.length > 0.02 || white / alpha.length < 0.15) return;
  for (let i = 0; i < alpha.length; i++) {
    if (alpha[i] <= ALPHA_CUTOFF) continue;
    const at = i * 4;
    if (rgba[at] > 245 && rgba[at + 1] > 245 && rgba[at + 2] > 245) alpha[i] = 0;
  }
}

/** A leftover after floors were lifted, not a sticker someone would place. */
function isLeftoverProp(
  rect: AssetRect,
  rgba: Uint8ClampedArray,
  alpha: Uint8Array,
  w: number,
  h: number,
  palette: number[][],
): boolean {
  if ((rect.w * rect.h) / (w * h) > 0.85) return true;

  let drawn = 0;
  let white = 0;
  let dark = 0;
  let terrain = 0;
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      const i = y * w + x;
      if (alpha[i] <= ALPHA_CUTOFF) continue;
      drawn += 1;
      const at = i * 4;
      if (rgba[at] > 240 && rgba[at + 1] > 240 && rgba[at + 2] > 240) white += 1;
      if (rgba[at] + rgba[at + 1] + rgba[at + 2] < 500) dark += 1;
      if (isTerrainColour(rgba, at, palette)) terrain += 1;
    }
  }
  if (drawn === 0) return true;
  // Punching a painted white background leaves empty rectangles behind.
  // A real white prop (paper, a tent fly) has a drawn outline.
  if (white / drawn > 0.92 && dark / drawn < 0.02) return true;
  // Leftover grass or pavement after the squares were taken: a sliver,
  // or a whole leftover patch that is only floor colour.
  if (palette.length > 0 && terrain / drawn > 0.9) return true;
  if (palette.length > 0 && (rect.w <= 6 || rect.h <= 6) && terrain / drawn > 0.8) return true;
  return false;
}

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

/** Floor pages are a grid of floor squares, one asset per square. */
export function sheetIsAllTiles(name: string): boolean {
  return isGroundSheetName(name) || /^(?:(?:paths|floors) \d+|my floors)$/i.test(name);
}

/** Whether this library sticker is a floor square, painted with a finger, not placed. */
export function assetIsGround(tileset: Tileset, assetIndex: number): boolean {
  if (sheetIsAllTiles(tileset.name) || tileset.pathStride) return true;
  return (tileset.groundAssets ?? []).includes(assetIndex);
}

/**
 * A scrap smaller than this share of a tile may belong to a bigger neighbour.
 * Tuned below the size of the smallest real props on typical sheets: a chair
 * beside a table is a prop in its own right and must not be swallowed.
 */
const FRAGMENT_SHARE = 1 / 12;
/** ...if it sits within this many pixels of it... */
const FRAGMENT_REACH = 8;
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

/** A hand correction to a sheet's assets. */
export type AssetEdit = 'merge' | 'delete' | 'toGround' | 'toObjects';

/** A sheet's assets, which of them are ground, and its ground patches. */
export interface SheetAssets {
  assets: AssetRect[];
  ground: number[];
  patches: AssetRect[];
}

const rectKey = (r: AssetRect) => `${r.x},${r.y},${r.w},${r.h}`;
const contains = (outer: AssetRect, inner: AssetRect) =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;

/** The grid squares an asset covers, as sheet rectangles. */
function squaresUnder(tileset: Tileset, rect: AssetRect): AssetRect[] {
  const stepX = tileset.tileW + tileset.spacing;
  const stepY = tileset.tileH + tileset.spacing;
  const c0 = Math.max(0, Math.floor((rect.x - tileset.margin) / stepX));
  const r0 = Math.max(0, Math.floor((rect.y - tileset.margin) / stepY));
  const c1 = Math.floor((rect.x + rect.w - 1 - tileset.margin) / stepX);
  const r1 = Math.floor((rect.y + rect.h - 1 - tileset.margin) / stepY);
  const squares: AssetRect[] = [];
  for (let row = r0; row <= r1; row++) {
    for (let col = c0; col <= c1; col++) {
      squares.push({
        x: tileset.margin + col * stepX,
        y: tileset.margin + row * stepY,
        w: tileset.tileW,
        h: tileset.tileH,
      });
    }
  }
  return squares;
}

/**
 * Applies a hand correction, keeping track of which assets are ground.
 *
 * Merge and Delete keep every remaining ground square marked. "To ground"
 * turns assets into paintable squares: a one-square asset is simply marked,
 * a bigger one is split into its grid squares, kept together as a patch so
 * it paints as one continuous texture. "To objects" undoes that: a square,
 * or the whole patch it belongs to, becomes a single object again.
 */
export function editSheetAssets(tileset: Tileset, op: AssetEdit, indices: number[]): SheetAssets {
  const assets = tileset.assets ?? [];
  const groundKeys = new Set((tileset.groundAssets ?? []).flatMap((i) => (assets[i] ? [rectKey(assets[i])] : [])));
  let patches = [...(tileset.groundBlocks ?? [])];
  let next = assets;
  const picked = [...new Set(indices)].filter((i) => assets[i]);

  if (op === 'merge') {
    next = mergeAssets(assets, picked);
  } else if (op === 'delete') {
    next = deleteAssets(assets, picked);
  } else if (op === 'toGround') {
    const drop = new Set<number>();
    const added: AssetRect[] = [];
    for (const i of picked) {
      const rect = assets[i];
      const squares = squaresUnder(tileset, rect);
      if (squares.length === 1 && rectKey(squares[0]) === rectKey(rect)) {
        groundKeys.add(rectKey(rect));
        continue;
      }
      drop.add(i);
      for (const square of squares) {
        groundKeys.add(rectKey(square));
        if (!assets.some((a) => rectKey(a) === rectKey(square))) added.push(square);
      }
      if (squares.length > 1) {
        patches = patches.filter((p) => !squares.some((s) => contains(p, s)));
        const x0 = squares[0].x;
        const y0 = squares[0].y;
        const last = squares[squares.length - 1];
        patches.push({ x: x0, y: y0, w: last.x + last.w - x0, h: last.y + last.h - y0 });
      }
    }
    next = [...assets.filter((_, i) => !drop.has(i)), ...added];
  } else {
    const drop = new Set<number>();
    const added: AssetRect[] = [];
    for (const i of picked) {
      const rect = assets[i];
      const patch = patches.find((p) => contains(p, rect));
      if (!patch) {
        groundKeys.delete(rectKey(rect));
        continue;
      }
      // The whole patch goes back as the one object it was drawn as.
      patches = patches.filter((p) => p !== patch);
      assets.forEach((a, j) => {
        if (contains(patch, a) && groundKeys.has(rectKey(a))) {
          drop.add(j);
          groundKeys.delete(rectKey(a));
        }
      });
      added.push({ ...patch });
    }
    next = [...assets.filter((_, i) => !drop.has(i)), ...added];
  }

  return {
    assets: next,
    ground: next.flatMap((rect, i) => (groundKeys.has(rectKey(rect)) ? [i] : [])),
    patches,
  };
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

  // A piece hanging directly under something much bigger, within its width,
  // is part of it even when larger than a scrap: swing seats. A chair beside
  // a table, or a post standing above a hedge, is never taken.
  const tucked = (scrap: Island, other: Island) =>
    scrap.y >= other.y + other.h && scrap.x >= other.x && scrap.x + scrap.w <= other.x + other.w;

  for (const scrap of order) {
    if (scrap.area >= maxFragment * 3 || gone.has(scrap)) continue;
    let parent: Island | null = null;
    let best = FRAGMENT_REACH + 1;
    for (const other of pool) {
      if (other === scrap || gone.has(other)) continue;
      if (other.area < scrap.area * FRAGMENT_PARENT_RATIO) continue;
      if (scrap.area >= maxFragment && !tucked(scrap, other)) continue;
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
function findIslands(
  solid: Uint8Array,
  sheetW: number,
  region: AssetRect,
  gap: number,
  minArea: number,
  ortho = false,
): Island[] {
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

      const dirs = ortho
        ? [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
          ]
        : [
            [-1, -1],
            [0, -1],
            [1, -1],
            [-1, 0],
            [1, 0],
            [-1, 1],
            [0, 1],
            [1, 1],
          ];
      for (const [dx, dy] of dirs) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (!grown[ni] || labels[ni]) continue;
        labels[ni] = 1;
        stack.push(ni);
      }
    }

    if (area >= minArea && x1 >= x0) rects.push({ x: rx + x0, y: ry + y0, w: x1 - x0 + 1, h: y1 - y0 + 1, area });
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

/** The tile grid a sheet was sliced with. */
export function gridOf(tileset: Tileset): TileGrid {
  return { w: tileset.tileW, h: tileset.tileH, margin: tileset.margin, spacing: tileset.spacing };
}

export function sheetGrid(tileset: Tileset): SheetGrid {
  return { ...gridOf(tileset), cols: tileset.cols, rows: tileset.rows };
}

/**
 * Every asset on a sheet, whole: first the props, found with the floor left
 * out so a bench never fuses with the grass beside it, then each floor
 * square on its own. A ground sheet (A1 to A5) is all floor squares.
 */
export function detectSheetAssets(tileset: Tileset): AssetRect[] {
  return detectSheetSplit(tileset).assets;
}

/** The sheet's assets along with which of them are paintable ground. */
export function detectSheetSplit(tileset: Tileset): SheetSplit {
  if (!tileset.image) return { assets: [], ground: [] };
  const { w, h } = alphaChannel(tileset.image);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return { assets: [], ground: [] };
  ctx.drawImage(tileset.image, 0, 0);
  const rgba = ctx.getImageData(0, 0, w, h).data;
  return splitSheet(rgba, w, h, sheetGrid(tileset), sheetIsAllTiles(tileset.name));
}

/**
 * Every asset on a sheet, and which of them are ground.
 *
 * A ground page is one square per cell. An object page is one sticker per
 * connected drawing, with the terrain underneath lifted out first: a tree
 * standing on grass is a tree, the grass is a paintable square, and a
 * building, which is solid but does not repeat, stays one whole sticker.
 */
export function assetsInImage(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  grid: SheetGrid,
  groundSheet: boolean,
): AssetRect[] {
  return splitSheet(rgba, w, h, grid, groundSheet).assets;
}

export interface SheetSplit {
  assets: AssetRect[];
  /** Places in `assets` that are a square of ground, ready for the brush. */
  ground: number[];
  /** Ground squares drawn to sit together, painted as one continuous texture. */
  patches?: AssetRect[];
}

export function splitSheet(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  grid: SheetGrid,
  groundSheet: boolean,
): SheetSplit {
  const alpha = new Uint8Array(w * h);
  for (let i = 0; i < alpha.length; i++) alpha[i] = rgba[i * 4 + 3];
  punchFakeBackground(rgba, alpha);
  const count = grid.cols * grid.rows;

  if (groundSheet) {
    const whole = findGround(alpha, w, h, grid, true);
    const floor: AssetRect[] = [];
    for (let i = 0; i < count; i++) if (whole.cells[i]) floor.push(cellsBox([i], grid));
    const assets = readingOrder(floor);
    return { assets, ground: assets.map((_, i) => i) };
  }

  const terrain = terrainCells(rgba, alpha, w, h, grid);
  const squares: AssetRect[] = [];
  for (let i = 0; i < count; i++) if (terrain[i]) squares.push(cellsBox([i], grid));

  // The terrain is held back while the props are found, so a bench on a
  // path is a bench rather than part of the path.
  const found = detectAssetsInMask(alpha, w, h, { tile: grid, ground: { grid, cells: terrain, props: [] } });
  // Packs butt drawings right up against each other, with no background
  // between them to split on, so touching ones are cut at the grid line
  // where the picture changes.
  const cut = found.flatMap((rect) => splitAtSeams(rect, rgba, alpha, w, grid));
  // Trees arranged on a panel of grass are joined by the grass, which no
  // amount of flood filling will separate, so the grass is taken out from
  // under them and what is left standing is found again.
  const palette = terrainPalette(rgba, alpha, w, h, grid, terrain);
  const props = withoutInnerPieces(
    cut
      .flatMap((rect) => splitPanel(rect, rgba, alpha, w, grid, palette))
      .flatMap((rect) => splitCellFloor(rect, rgba, alpha, w, grid, palette))
      .flatMap((rect) => splitCellBlobs(rect, alpha, w, grid)),
  ).filter((rect) => !isLeftoverProp(rect, rgba, alpha, w, h, palette));

  const assets = readingOrder([...props, ...squares]);
  const isGround = new Set(squares);
  return {
    assets,
    ground: assets.flatMap((rect, i) => (isGround.has(rect) ? [i] : [])),
    patches: groundPatches(rgba, w, h, grid, terrain),
  };
}

/**
 * The colours ground is made of on this sheet, taken from the cells already
 * known to be ground. A sheet with no ground has an empty palette, so a page
 * of buildings is never touched by the step that uses it.
 */
function terrainPalette(
  rgba: Uint8ClampedArray,
  alpha: Uint8Array,
  w: number,
  h: number,
  grid: SheetGrid,
  terrain: Uint8Array,
): number[][] {
  const counts = new Map<number, number>();
  let total = 0;
  forEachCell(grid, w, h, (index, x0, y0, cw, ch) => {
    if (!terrain[index]) return;
    for (let y = y0; y < y0 + ch; y++) {
      for (let x = x0; x < x0 + cw; x++) {
        const i = y * w + x;
        if (alpha[i] <= ALPHA_CUTOFF) continue;
        const key = (rgba[i * 4] << 16) | (rgba[i * 4 + 1] << 8) | rgba[i * 4 + 2];
        counts.set(key, (counts.get(key) ?? 0) + 1);
        total += 1;
      }
    }
  });
  if (total === 0) return [];

  const palette: number[][] = [];
  for (const [key, n] of counts) {
    if (n / total < PALETTE_SHARE) continue;
    palette.push([(key >> 16) & 255, (key >> 8) & 255, key & 255]);
  }
  return palette;
}

/** Whether a pixel is close enough to one of the ground colours to be background. */
function isTerrainColour(rgba: Uint8ClampedArray, at: number, palette: number[][]): boolean {
  const r = rgba[at];
  const g = rgba[at + 1];
  const b = rgba[at + 2];
  for (const colour of palette) {
    if (Math.abs(colour[0] - r) + Math.abs(colour[1] - g) + Math.abs(colour[2] - b) <= PALETTE_NEAR) return true;
  }
  return false;
}

/**
 * Breaks up a panel of ground with things standing on it.
 *
 * Sheets often draw a block of grass and dot trees and bushes over it. The
 * grass runs behind them all, so they come out as one island however the
 * flood fill is tuned. Taking out the pixels that are the sheet's own ground
 * colours leaves the trees standing alone, and they can then be found
 * separately. Only large, solidly filled islands are treated this way, so an
 * ordinary prop is never picked apart.
 */
function splitPanel(
  rect: AssetRect,
  rgba: Uint8ClampedArray,
  alpha: Uint8Array,
  w: number,
  grid: SheetGrid,
  palette: number[][],
): AssetRect[] {
  if (palette.length === 0) return [rect];
  const cellArea = grid.w * grid.h;
  if (rect.w * rect.h < cellArea * PANEL_MIN_CELLS) return [rect];

  const mask = new Uint8Array(w * (rect.y + rect.h));
  let drawn = 0;
  let kept = 0;
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      const i = y * w + x;
      if (alpha[i] <= ALPHA_CUTOFF) continue;
      drawn += 1;
      if (isTerrainColour(rgba, i * 4, palette)) continue;
      mask[i] = 1;
      kept += 1;
    }
  }

  // Mostly background means this was a panel. Mostly left means the ground
  // colours were incidental and the island is a drawing in its own right.
  const removed = drawn === 0 ? 0 : 1 - kept / drawn;
  if (removed < PANEL_BACKGROUND) return [rect];

  const pieces = absorbFragments(findIslands(mask, w, rect, 0, 1), cellArea * FRAGMENT_SHARE)
    .filter((piece) => piece.area >= cellArea * PANEL_PIECE_SHARE)
    .map(({ x, y, w: pw, h: ph }) => ({ x, y, w: pw, h: ph }));
  return pieces.length > 1 ? pieces : [rect];
}

/**
 * Lifts a prop off the floor tile it was drawn on.
 *
 * Object pages often paint a tree or a bench on top of the sidewalk in the
 * same cell. The leftover island after neighbouring floor is punched out is
 * only one or two cells, too small for the panel pass, so the dominant
 * ground colour is taken out here and whatever is still standing is kept.
 */
function splitCellFloor(
  rect: AssetRect,
  rgba: Uint8ClampedArray,
  alpha: Uint8Array,
  w: number,
  grid: SheetGrid,
  palette: number[][],
): AssetRect[] {
  if (palette.length === 0) return [rect];
  const cellArea = grid.w * grid.h;
  if (rect.w * rect.h > cellArea * 4) return [rect];

  const counts = new Map<number, number>();
  let drawn = 0;
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      const i = y * w + x;
      if (alpha[i] <= ALPHA_CUTOFF) continue;
      const key = (rgba[i * 4] << 16) | (rgba[i * 4 + 1] << 8) | rgba[i * 4 + 2];
      counts.set(key, (counts.get(key) ?? 0) + 1);
      drawn += 1;
    }
  }
  if (drawn === 0) return [rect];

  let bestKey = 0;
  let bestN = 0;
  for (const [key, n] of counts) {
    if (n > bestN) {
      bestKey = key;
      bestN = n;
    }
  }
  if (bestN / drawn < 0.35) return [rect];
  const colour = [(bestKey >> 16) & 255, (bestKey >> 8) & 255, bestKey & 255];
  if (!isTerrainColour(Uint8ClampedArray.from(colour), 0, palette)) return [rect];

  const mask = new Uint8Array(w * (rect.y + rect.h));
  let kept = 0;
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      const i = y * w + x;
      if (alpha[i] <= ALPHA_CUTOFF) continue;
      if (Math.abs(rgba[i * 4] - colour[0]) + Math.abs(rgba[i * 4 + 1] - colour[1]) + Math.abs(rgba[i * 4 + 2] - colour[2]) <= 12) {
        continue;
      }
      mask[i] = 1;
      kept += 1;
    }
  }
  if (kept === 0 || 1 - kept / drawn < 0.25) return [rect];

  const pieces = absorbFragments(findIslands(mask, w, rect, 0, 1), cellArea * FRAGMENT_SHARE)
    .filter((piece) => piece.area >= cellArea * PANEL_PIECE_SHARE)
    .map(({ x, y, w: pw, h: ph }) => ({ x, y, w: pw, h: ph }));
  return pieces.length > 0 ? pieces : [rect];
}

/**
 * Cuts one run of touching drawings apart at the grid lines where the
 * picture actually changes.
 *
 * Sheets pack buildings and shopfronts edge to edge with no background
 * between them, so they come out of the flood fill as one island. Along a
 * grid line inside a single drawing the pixels either side match, because
 * it is one continuous wall; between two drawings they jump. Cutting only
 * at the jumps keeps a tower whole and still separates it from its
 * neighbour.
 */
function splitAtSeams(
  rect: AssetRect,
  rgba: Uint8ClampedArray,
  alpha: Uint8Array,
  w: number,
  grid: SheetGrid,
): AssetRect[] {
  // A stall or a flower box is only a few cells wide. Colour jumps inside
  // it (apples next to cabbages) are not a reason to clip it in half.
  const short = rect.w <= (grid.w + grid.spacing) * 4.3;
  const cutsX = seamCuts(rect.x, rect.w, grid.margin, grid.w + grid.spacing, short ? 70 : SEAM_CUT, (at) =>
    seamStrength(rgba, alpha, w, at, rect, true),
  );
  // Horizontal colour jumps are how a roof sits on its own shopfront.
  // Cutting there slices every building into storeys. Only a thin touch
  // (two props stacked, not one facade) is a real split.
  const cutsY = seamCuts(rect.y, rect.h, grid.margin, grid.h + grid.spacing, Number.POSITIVE_INFINITY, (at) =>
    seamStrength(rgba, alpha, w, at, rect, false),
  );
  if (cutsX.length === 0 && cutsY.length === 0) return [rect];

  const spans = (start: number, size: number, cuts: number[]): number[] => [start, ...cuts, start + size];
  const xs = spans(rect.x, rect.w, cutsX);
  const ys = spans(rect.y, rect.h, cutsY);
  const pieces: AssetRect[] = [];
  for (let r = 0; r < ys.length - 1; r++) {
    for (let c = 0; c < xs.length - 1; c++) {
      const box = tightBox(alpha, w, xs[c], ys[r], xs[c + 1], ys[r + 1]);
      if (box) pieces.push(box);
    }
  }
  return pieces.length > 0 ? pieces : [rect];
}

/** Grid lines strictly inside a span, where the picture jumps. */
function seamCuts(
  start: number,
  size: number,
  margin: number,
  step: number,
  least: number,
  strengthAt: (at: number) => number | null,
): number[] {
  // One cell wide or less has no line inside it to cut on.
  if (size < step * 2) return [];
  const cuts: number[] = [];
  const first = Math.ceil((start - margin) / step);
  for (let k = first; ; k++) {
    const at = margin + k * step;
    if (at <= start) continue;
    if (at >= start + size) break;
    const strength = strengthAt(at);
    if (strength === null) continue;
    // A thin shared edge is two props that only kiss at a corner or a pole.
    // Leaving them joined is how two trees or a row of benches become one tile.
    if (strength < 0) cuts.push(at);
    else if (strength >= least) cuts.push(at);
  }
  return cuts;
}

/**
 * How different the two sides of a line are, averaged over the pixels where
 * both sides are drawn. Null when the sides barely touch, which means the
 * flood fill joined them through a thin bridge and there is nothing to judge.
 */
function seamStrength(
  rgba: Uint8ClampedArray,
  alpha: Uint8Array,
  w: number,
  at: number,
  rect: AssetRect,
  sideways: boolean,
): number | null {
  const from = sideways ? rect.y : rect.x;
  const to = sideways ? rect.y + rect.h : rect.x + rect.w;
  let total = 0;
  let shared = 0;
  for (let t = from; t < to; t++) {
    const before = sideways ? t * w + at - 1 : (at - 1) * w + t;
    const after = sideways ? t * w + at : at * w + t;
    if (alpha[before] <= ALPHA_CUTOFF || alpha[after] <= ALPHA_CUTOFF) continue;
    total +=
      Math.abs(rgba[before * 4] - rgba[after * 4]) +
      Math.abs(rgba[before * 4 + 1] - rgba[after * 4 + 1]) +
      Math.abs(rgba[before * 4 + 2] - rgba[after * 4 + 2]);
    shared += 1;
  }
  const span = to - from;
  if (shared === 0 || shared < span * SEAM_THIN) return -1;
  if (shared < span * SEAM_TOUCH) return null;
  return total / (shared * 3);
}

/**
 * Two small props packed into one cell often only touch at a corner. The
 * first pass is 8-connected, so they come out as one sticker. Splitting on
 * 4-connected islands inside a single cell pulls them apart without
 * touching a building that spans several cells.
 */
function splitCellBlobs(rect: AssetRect, alpha: Uint8Array, w: number, grid: SheetGrid): AssetRect[] {
  if (rect.w > grid.w * 1.15 || rect.h > grid.h * 1.15) return [rect];
  const mask = new Uint8Array(w * (rect.y + rect.h));
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      if (alpha[y * w + x] > ALPHA_CUTOFF) mask[y * w + x] = 1;
    }
  }
  const found = findIslands(mask, w, rect, 0, 8, true);
  if (found.length < 2) return [rect];
  const areas = found.map((p) => p.area).sort((a, b) => b - a);
  // An awning's poles, a tree's trunk, a lamp's post: much smaller than the
  // body they hang from. Two benches in one cell are about the same size.
  if (areas[1] < areas[0] * 0.35) return [rect];
  return found.map(({ x, y, w: pw, h: ph }) => ({ x, y, w: pw, h: ph }));
}

/** The box of drawn pixels inside a region, or null when it is all background. */
function tightBox(alpha: Uint8Array, w: number, x0: number, y0: number, x1: number, y1: number): AssetRect | null {
  let minX = x1;
  let minY = y1;
  let maxX = x0 - 1;
  let maxY = y0 - 1;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (alpha[y * w + x] <= ALPHA_CUTOFF) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < minX) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/**
 * Which cells are ground: grass, water, brick, pavement.
 *
 * Ground is a texture that repeats. A building facade fills its cells just
 * as solidly, but every cell of it is different, so counting look-alikes
 * tells the two apart where counting solid pixels cannot. Cells are matched
 * against the handful of looks found so far rather than against each other,
 * which keeps a 16 by 16 sheet to a few thousand comparisons.
 */
export function terrainCells(
  rgba: Uint8ClampedArray,
  alpha: Uint8Array,
  w: number,
  h: number,
  grid: SheetGrid,
): Uint8Array {
  const count = grid.cols * grid.rows;
  const cells = new Uint8Array(count);
  const fill = new Float32Array(count);
  const structure = new Float32Array(count);
  const kinds: { look: Float64Array; members: number[] }[] = [];

  forEachCell(grid, w, h, (index, x0, y0, cw, ch) => {
    let solid = 0;
    for (let y = y0; y < y0 + ch; y++) {
      for (let x = x0; x < x0 + cw; x++) if (alpha[y * w + x] > ALPHA_CUTOFF) solid += 1;
    }
    fill[index] = solid / (cw * ch);
    if (fill[index] === 0) return;
    const look = cellLook(rgba, w, x0, y0, cw, ch);
    structure[index] = lookStructure(look);
    if (fill[index] < TERRAIN_FILL) return;

    // Ground is a flat texture. A cupboard front or a window repeats just as
    // often and fills its square just as fully, but it has a design in it:
    // a frame, a handle, panes. Measuring how much the square varies within
    // itself keeps those out of the seed set.
    if (structure[index] > TERRAIN_FLAT) return;

    const kind = kinds.find((k) => lookDistance(k.look, look) < TERRAIN_MATCH);
    if (kind) kind.members.push(index);
    else kinds.push({ look, members: [index] });
  });

  for (const kind of kinds) {
    if (kind.members.length < TERRAIN_REPEATS) continue;
    for (const index of kind.members) {
      // A flat roof sitting on a windowed facade is part of a building, not a floor.
      const below = index + grid.cols;
      const above = index - grid.cols;
      const facade =
        (below < count && fill[below] > 0.8 && structure[below] > TERRAIN_FLAT) ||
        (above >= 0 && fill[above] > 0.8 && structure[above] > TERRAIN_FLAT);
      if (!facade) cells[index] = 1;
    }
  }

  // Unique floor tiles (a crosswalk, a parking space with a line) sit next
  // to the repeating ones. Once the repeating ground is known, any cell
  // that is mostly those colours is ground too, even with a tree on it.
  const palette = terrainPalette(rgba, alpha, w, h, grid, cells);
  if (palette.length > 0) {
    forEachCell(grid, w, h, (index, x0, y0, cw, ch) => {
      if (cells[index] || fill[index] === 0) return;
      let drawn = 0;
      let matched = 0;
      for (let y = y0; y < y0 + ch; y++) {
        for (let x = x0; x < x0 + cw; x++) {
          const i = y * w + x;
          if (alpha[i] <= ALPHA_CUTOFF) continue;
          drawn += 1;
          if (isTerrainColour(rgba, i * 4, palette)) matched += 1;
        }
      }
      const cover = drawn === 0 ? 0 : matched / drawn;
      // Almost all ground colour means a unique floor tile (a crosswalk, a
      // parking line). A tree sitting on a sidewalk is not this covered, and
      // must stay so it can be lifted off the floor in a later pass.
      if (cover >= TERRAIN_COVER_BUSY && structure[index] < TERRAIN_COVER_FLAT) cells[index] = 1;
    });
  }

  return cells;
}

/** Ground squares side by side this close in average colour are one patch. */
const PATCH_MATCH = 12;
/** Largest patch kept, in squares a side; bigger panels are cut into these. */
const PATCH_MAX = 6;

/**
 * Rectangles of ground squares the pack drew to sit together, such as a 3 by
 * 3 patch of grass. Painting one of its squares then uses the neighbouring
 * square of the patch beside it, so the texture continues instead of
 * repeating one square and showing its edges. Single squares are left out:
 * they have no neighbours to continue into.
 */
export function groundPatches(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  grid: SheetGrid,
  terrain: Uint8Array,
): AssetRect[] {
  const mean = new Map<number, [number, number, number]>();
  forEachCell(grid, w, h, (index, x0, y0, cw, ch) => {
    if (!terrain[index]) return;
    const look = cellLook(rgba, w, x0, y0, cw, ch);
    let r = 0;
    let g = 0;
    let b = 0;
    const blocks = look.length / 3;
    for (let i = 0; i < blocks; i++) {
      r += look[i * 3];
      g += look[i * 3 + 1];
      b += look[i * 3 + 2];
    }
    mean.set(index, [r / blocks, g / blocks, b / blocks]);
  });
  const alike = (a: number, b: number) => {
    const ca = mean.get(a);
    const cb = mean.get(b);
    if (!ca || !cb) return false;
    return (Math.abs(ca[0] - cb[0]) + Math.abs(ca[1] - cb[1]) + Math.abs(ca[2] - cb[2])) / 3 < PATCH_MATCH;
  };

  // Greedy rectangles in reading order: run right from the first free
  // square while the squares match, then grow down while a whole row does.
  const used = new Uint8Array(grid.cols * grid.rows);
  const patches: AssetRect[] = [];
  for (let row = 0; row < grid.rows; row++) {
    for (let col = 0; col < grid.cols; col++) {
      const start = row * grid.cols + col;
      if (used[start] || !mean.has(start)) continue;
      let width = 1;
      while (
        width < PATCH_MAX &&
        col + width < grid.cols &&
        !used[start + width] &&
        alike(start + width - 1, start + width)
      ) {
        width += 1;
      }
      let height = 1;
      grow: while (height < PATCH_MAX && row + height < grid.rows) {
        for (let dx = 0; dx < width; dx++) {
          const below = start + height * grid.cols + dx;
          if (used[below] || !alike(below - grid.cols, below)) break grow;
        }
        height += 1;
      }
      const members: number[] = [];
      for (let dy = 0; dy < height; dy++) {
        for (let dx = 0; dx < width; dx++) {
          used[start + dy * grid.cols + dx] = 1;
          members.push(start + dy * grid.cols + dx);
        }
      }
      if (members.length > 1) patches.push(cellsBox(members, grid));
    }
  }
  return patches;
}

/** How much a square varies within itself: near zero for a flat texture. */
function lookStructure(look: Float64Array): number {
  const blocks = look.length / 3;
  let mr = 0;
  let mg = 0;
  let mb = 0;
  for (let i = 0; i < blocks; i++) {
    mr += look[i * 3];
    mg += look[i * 3 + 1];
    mb += look[i * 3 + 2];
  }
  mr /= blocks;
  mg /= blocks;
  mb /= blocks;

  let spread = 0;
  for (let i = 0; i < blocks; i++) {
    spread += Math.abs(look[i * 3] - mr) + Math.abs(look[i * 3 + 1] - mg) + Math.abs(look[i * 3 + 2] - mb);
  }
  return spread / (blocks * 3);
}

/** A cell boiled down to a grid of average colours, so near-matches still match. */
function cellLook(rgba: Uint8ClampedArray, w: number, x0: number, y0: number, cw: number, ch: number): Float64Array {
  const look = new Float64Array(LOOK_SIZE * LOOK_SIZE * 3);
  for (let by = 0; by < LOOK_SIZE; by++) {
    for (let bx = 0; bx < LOOK_SIZE; bx++) {
      const sx = x0 + Math.floor((bx * cw) / LOOK_SIZE);
      const ex = x0 + Math.floor(((bx + 1) * cw) / LOOK_SIZE);
      const sy = y0 + Math.floor((by * ch) / LOOK_SIZE);
      const ey = y0 + Math.floor(((by + 1) * ch) / LOOK_SIZE);
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let y = sy; y < ey; y++) {
        for (let x = sx; x < ex; x++) {
          const i = (y * w + x) * 4;
          r += rgba[i];
          g += rgba[i + 1];
          b += rgba[i + 2];
          n += 1;
        }
      }
      if (n === 0) continue;
      const at = (by * LOOK_SIZE + bx) * 3;
      look[at] = r / n;
      look[at + 1] = g / n;
      look[at + 2] = b / n;
    }
  }
  return look;
}

function lookDistance(a: Float64Array, b: Float64Array): number {
  let total = 0;
  for (let i = 0; i < a.length; i++) total += Math.abs(a[i] - b[i]);
  return total / a.length;
}

/** Drops any asset lying entirely inside another: it is a piece of that one, not an asset. */
function withoutInnerPieces(rects: AssetRect[]): AssetRect[] {
  const inside = (a: AssetRect, b: AssetRect) =>
    a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;
  // Of two identical boxes, the first is kept.
  return rects.filter((r, i) => !rects.some((other, j) => j !== i && inside(r, other) && (!inside(other, r) || j < i)));
}

function gridCells(tileset: Tileset): AssetRect[] {
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

/**
 * The assets a sheet offers. The edited-tiles sheet grows a square at a time
 * as tiles are recoloured, so its squares are listed directly.
 */
export function assetsOf(tileset: Tileset): AssetRect[] {
  if (tileset.generated) return gridCells(tileset);
  return tileset.assets ?? [];
}

/** Grid cell of a sheet pixel position. */
function cellAt(tileset: Tileset, px: number, py: number): { col: number; row: number } {
  return {
    col: Math.floor((px - tileset.margin) / (tileset.tileW + tileset.spacing)),
    row: Math.floor((py - tileset.margin) / (tileset.tileH + tileset.spacing)),
  };
}

/**
 * The square to paint at a map position when the brush is a square of a
 * ground patch: the patch square that falls there, counting from the map's
 * top-left corner. Neighbouring squares then come out as the pack drew them
 * side by side, and separate strokes still meet. Anything else is unchanged.
 */
export function patchTileAt(tileset: Tileset, tileIndex: number, x: number, y: number): number {
  const patches = tileset.groundBlocks;
  if (!patches || patches.length === 0 || tileset.pathStride || tileset.cols <= 0) return tileIndex;
  const col = tileIndex % tileset.cols;
  const row = Math.floor(tileIndex / tileset.cols);
  for (const patch of patches) {
    const a = cellAt(tileset, patch.x, patch.y);
    const b = cellAt(tileset, patch.x + patch.w - 1, patch.y + patch.h - 1);
    if (col < a.col || col > b.col || row < a.row || row > b.row) continue;
    const w = b.col - a.col + 1;
    const h = b.row - a.row + 1;
    const pc = a.col + (((x % w) + w) % w);
    const pr = a.row + (((y % h) + h) % h);
    return pr * tileset.cols + pc;
  }
  return tileIndex;
}

/** Whether a painted square of this sheet is ground: a path, floor or grass. */
export function tileIsGround(tileset: Tileset, tileIndex: number): boolean {
  if (sheetIsAllTiles(tileset.name) || tileset.pathStride) return true;
  const ground = tileset.groundAssets;
  if (!ground || ground.length === 0) return false;
  const rects = assetsOf(tileset);
  return ground.some((i) => rects[i] !== undefined && tileIndexOf(tileset, rects[i]) === tileIndex);
}

/**
 * The tile an asset is, when it is exactly one square of the sheet's grid,
 * so it can be painted with the brush; otherwise -1.
 */
export function tileIndexOf(tileset: Tileset, rect: AssetRect): number {
  if (rect.w !== tileset.tileW || rect.h !== tileset.tileH) return -1;
  const stepX = tileset.tileW + tileset.spacing;
  const stepY = tileset.tileH + tileset.spacing;
  const dx = rect.x - tileset.margin;
  const dy = rect.y - tileset.margin;
  if (dx < 0 || dy < 0 || dx % stepX !== 0 || dy % stepY !== 0) return -1;
  const index = (dy / stepY) * tileset.cols + dx / stepX;
  return index < tileset.count ? index : -1;
}
