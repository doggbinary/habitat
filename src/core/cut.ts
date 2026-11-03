import type { SheetAssets } from './assets';
import type { AssetRect, Tileset } from './doc';

/**
 * Cutting one asset out of a tileset by hand.
 *
 * Detection sometimes joins two pictures that share an edge. A stroke drawn
 * across that join becomes a straight cut. When a colour change sits close
 * to the stroke, the cut slides onto it, so a rough line still lands between
 * the pictures. The pieces stay rectangles, which is all a sheet can store,
 * and every pixel of the original stays in one piece or the other.
 */

/** Pixels at or below this alpha count as background. Matches detection. */
const ALPHA_CUTOFF = 24;
/** Colour jump across a grid line that means two drawings meet there. */
const SEAM_CUT = 36;
/** A short prop is full of its own detail, so only a hard jump may cut it. */
const SEAM_SHORT = 70;
/** A shared edge thinner than this is two props that merely touch. */
const SEAM_THIN = 0.18;
/** ...judged only where this share of the line has both sides drawn. */
const SEAM_TOUCH = 0.3;
/** How far a drawn line may slide to meet a colour change, in sheet pixels. */
const SNAP = 6;
/** A piece thinner than this share of a cell is a sliver, not a picture. */
const MIN_SIDE = 0.4;

/** One point of a stroke, in sheet pixels. */
export interface CutPoint {
  x: number;
  y: number;
}

/** The tile grid a sheet was sliced with. Only its spacing is needed here. */
export interface CutGrid {
  w: number;
  h: number;
  margin: number;
  spacing: number;
}

/**
 * Splits one asset along the strokes drawn across it.
 *
 * Each stroke that runs most of the way across becomes one straight cut,
 * vertical or horizontal. A stroke that only ticks a corner is ignored, so
 * resting the pencil does not slice the picture. With nothing to cut on,
 * the original rectangle comes back.
 */
export function cutAsset(
  rgba: Uint8ClampedArray,
  alpha: Uint8Array,
  sheetW: number,
  rect: AssetRect,
  strokes: readonly (readonly CutPoint[])[],
): AssetRect[] {
  const cutsX: number[] = [];
  const cutsY: number[] = [];
  for (const stroke of strokes) {
    const guide = guideFromStroke(rgba, alpha, sheetW, rect, stroke);
    if (!guide) continue;
    if (guide.vertical) cutsX.push(guide.at);
    else cutsY.push(guide.at);
  }
  const pieces = splitByGuides(alpha, sheetW, rect, cutsX, cutsY);
  return pieces.length > 1 ? readingOrder(pieces) : [{ ...rect }];
}

/**
 * Splits one asset where the picture itself separates, with no stroke.
 *
 * Drawings that already have background between them come apart first. What
 * is still one island is cut on a grid line where the colours jump, or where
 * the two sides barely touch. A cut that would shave off a sliver is skipped,
 * so Auto leaves a tree whole and still parts a row of benches.
 */
export function autoCutAsset(
  rgba: Uint8ClampedArray,
  alpha: Uint8Array,
  sheetW: number,
  rect: AssetRect,
  grid: CutGrid,
): AssetRect[] {
  const separated = separateIslands(alpha, sheetW, rect, grid);
  if (separated.length > 1) return readingOrder(separated);

  const pieces = applySeams(rgba, alpha, sheetW, rect, grid);
  return pieces.length > 1 ? readingOrder(pieces) : [{ ...rect }];
}

/**
 * Puts the pieces of a cut in place of the asset they came from.
 *
 * Ground marks on every other asset stay put. The cut asset stops being
 * ground: the pieces are objects, and a floor patch that contained it is
 * dropped so painting does not keep treating the old block as one texture.
 * Returns null when there is nothing to replace.
 */
export function replaceAsset(tileset: Tileset, index: number, pieces: AssetRect[]): SheetAssets | null {
  const assets = tileset.assets;
  const cut = assets?.[index];
  if (!assets || !cut || pieces.length < 2) return null;

  const groundKeys = new Set((tileset.groundAssets ?? []).flatMap((i) => (assets[i] ? [rectKey(assets[i])] : [])));
  const wasGround = groundKeys.delete(rectKey(cut));
  let patches = [...(tileset.groundBlocks ?? [])];
  if (wasGround) patches = patches.filter((patch) => !contains(patch, cut));

  const next = [...assets.slice(0, index), ...pieces.map((piece) => ({ ...piece })), ...assets.slice(index + 1)];
  return {
    assets: next,
    ground: next.flatMap((piece, i) => (groundKeys.has(rectKey(piece)) ? [i] : [])),
    patches,
  };
}

// --- Strokes ----------------------------------------------------------------

interface Guide {
  vertical: boolean;
  at: number;
  score: number;
}

/**
 * A stroke that crosses the asset, as the straight cut it is asking for.
 * The cut prefers a colour change within a few pixels of where the line
 * was drawn, and otherwise stays on the line itself.
 */
function guideFromStroke(
  rgba: Uint8ClampedArray,
  alpha: Uint8Array,
  sheetW: number,
  rect: AssetRect,
  stroke: readonly CutPoint[],
): { vertical: boolean; at: number } | null {
  if (stroke.length < 2) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const point of stroke) {
    if (point.x < minX) minX = point.x;
    if (point.x > maxX) maxX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.y > maxY) maxY = point.y;
  }
  const dx = maxX - minX;
  const dy = maxY - minY;
  const vertical = dy >= dx && dy >= rect.h * 0.35;
  const horizontal = dx > dy && dx >= rect.w * 0.35;
  if (!vertical && !horizontal) return null;

  const at = vertical
    ? snapToSeam(rgba, alpha, sheetW, rect, median(stroke.map((point) => point.x)), true)
    : snapToSeam(rgba, alpha, sheetW, rect, median(stroke.map((point) => point.y)), false);
  const start = vertical ? rect.x : rect.y;
  const size = vertical ? rect.w : rect.h;
  // A line along the outer edge, or through empty margin, does not divide the picture.
  if (at <= start + 1 || at >= start + size - 1) return null;
  if (!bothSides(alpha, sheetW, rect, at, vertical)) return null;
  return { vertical, at };
}

/** The cut nearest the stroke that actually separates two drawings, or the stroke itself. */
function snapToSeam(
  rgba: Uint8ClampedArray,
  alpha: Uint8Array,
  sheetW: number,
  rect: AssetRect,
  mid: number,
  vertical: boolean,
): number {
  const rounded = Math.round(mid);
  let bestAt = rounded;
  let bestScore = -1;
  let bestDist = 0;
  for (let at = rounded - SNAP; at <= rounded + SNAP; at++) {
    const start = vertical ? rect.x : rect.y;
    const size = vertical ? rect.w : rect.h;
    if (at <= start + 1 || at >= start + size - 1) continue;
    const strength = seamStrength(rgba, alpha, sheetW, at, rect, vertical);
    if (strength === null) continue;
    // A mild colour change is the picture's own shading. A real jump, or a
    // gap, is where two drawings meet. An empty line only counts when both
    // sides still hold pixels, so the cut is not pulled into bare margin.
    const gap = strength < 0;
    if (!gap && strength < SEAM_CUT) continue;
    if (!bothSides(alpha, sheetW, rect, at, vertical)) continue;
    const score = gap ? 10_000 : strength;
    const dist = Math.abs(at - rounded);
    if (score > bestScore || (score === bestScore && dist < bestDist)) {
      bestScore = score;
      bestAt = at;
      bestDist = dist;
    }
  }
  return bestAt;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
}

/** Whether a straight cut leaves drawn pixels on both sides. */
function bothSides(
  alpha: Uint8Array,
  sheetW: number,
  rect: AssetRect,
  at: number,
  vertical: boolean,
): boolean {
  const left = vertical
    ? tightBox(alpha, sheetW, rect.x, rect.y, at, rect.y + rect.h)
    : tightBox(alpha, sheetW, rect.x, rect.y, rect.x + rect.w, at);
  const right = vertical
    ? tightBox(alpha, sheetW, at, rect.y, rect.x + rect.w, rect.y + rect.h)
    : tightBox(alpha, sheetW, rect.x, at, rect.x + rect.w, rect.y + rect.h);
  return left !== null && right !== null;
}

// --- Automatic cuts ---------------------------------------------------------

/** Islands of a sheet that already have background between them. */
interface Island {
  x: number;
  y: number;
  w: number;
  h: number;
  area: number;
}

/**
 * The separate drawings inside one rectangle. Scraps hugging a real drawing
 * stay with it; a scrap off on its own is kept only when it is big enough
 * to place. One drawing comes back as a single-item list.
 */
function separateIslands(alpha: Uint8Array, sheetW: number, rect: AssetRect, grid: CutGrid): AssetRect[] {
  const found = findIslands(alpha, sheetW, rect);
  if (found.length < 2) return found.map(toRect);

  const maxFragment = grid.w * grid.h * (1 / 12);
  const big = found.filter((island) => island.area >= maxFragment);
  const small = found.filter((island) => island.area < maxFragment);
  const hosts = big.length > 0 ? big : found.filter((island) => island.area >= 8);
  if (hosts.length === 0) return [];

  for (const scrap of big.length > 0 ? small : []) {
    let nearest: Island | null = null;
    let nearestGap = Infinity;
    for (const host of hosts) {
      const gap = gapBetween(host, scrap);
      if (gap < nearestGap) {
        nearest = host;
        nearestGap = gap;
      }
    }
    if (nearest && nearestGap <= 2) include(nearest, scrap);
    else if (scrap.area >= 8) hosts.push({ ...scrap });
  }
  return hosts.map(toRect);
}

function findIslands(alpha: Uint8Array, sheetW: number, rect: AssetRect): Island[] {
  const { x: rx, y: ry, w, h } = rect;
  if (w <= 0 || h <= 0) return [];
  const seen = new Uint8Array(w * h);
  const islands: Island[] = [];
  const stack: number[] = [];
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ];

  const opaque = (lx: number, ly: number) => {
    const sx = rx + lx;
    const sy = ry + ly;
    if (sy < 0 || sx < 0) return false;
    return (alpha[sy * sheetW + sx] ?? 0) > ALPHA_CUTOFF;
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const start = y * w + x;
      if (seen[start] || !opaque(x, y)) continue;
      seen[start] = 1;
      stack.push(start);
      let x0 = x;
      let y0 = y;
      let x1 = x;
      let y1 = y;
      let area = 0;
      while (stack.length > 0) {
        const index = stack.pop() as number;
        const cx = index % w;
        const cy = (index / w) | 0;
        area += 1;
        if (cx < x0) x0 = cx;
        if (cy < y0) y0 = cy;
        if (cx > x1) x1 = cx;
        if (cy > y1) y1 = cy;
        for (const [dx, dy] of dirs) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const ni = ny * w + nx;
          if (seen[ni] || !opaque(nx, ny)) continue;
          seen[ni] = 1;
          stack.push(ni);
        }
      }
      islands.push({ x: rx + x0, y: ry + y0, w: x1 - x0 + 1, h: y1 - y0 + 1, area });
    }
  }
  return islands;
}

/** Chebyshev gap between two boxes. Overlapping boxes have a gap of 0. */
function gapBetween(a: Island, b: Island): number {
  const dx = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w));
  const dy = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h));
  return Math.max(dx, dy);
}

function include(host: Island, scrap: Island): void {
  const x1 = Math.max(host.x + host.w, scrap.x + scrap.w);
  const y1 = Math.max(host.y + host.h, scrap.y + scrap.h);
  host.x = Math.min(host.x, scrap.x);
  host.y = Math.min(host.y, scrap.y);
  host.w = x1 - host.x;
  host.h = y1 - host.y;
  host.area += scrap.area;
}

function toRect(island: Island): AssetRect {
  return { x: island.x, y: island.y, w: island.w, h: island.h };
}

/**
 * Grid-line cuts, strongest first, keeping only the ones that leave real
 * pictures on both sides. Horizontal colour jumps are ignored: that is how
 * a roof sits on a wall, and cutting there would slice every building.
 */
function applySeams(
  rgba: Uint8ClampedArray,
  alpha: Uint8Array,
  sheetW: number,
  rect: AssetRect,
  grid: CutGrid,
): AssetRect[] {
  const stepX = grid.w + grid.spacing;
  const stepY = grid.h + grid.spacing;
  const short = rect.w <= stepX * 4.3;
  const guides: Guide[] = [];
  for (const at of gridLines(rect.x, rect.w, grid.margin, stepX)) {
    const guide = scoreGuide(rgba, alpha, sheetW, rect, at, true, short ? SEAM_SHORT : SEAM_CUT);
    if (guide) guides.push(guide);
  }
  for (const at of gridLines(rect.y, rect.h, grid.margin, stepY)) {
    // Infinity: only a thin touch cuts horizontally, never a colour jump.
    const guide = scoreGuide(rgba, alpha, sheetW, rect, at, false, Number.POSITIVE_INFINITY);
    if (guide) guides.push(guide);
  }
  guides.sort((a, b) => b.score - a.score || a.at - b.at);

  const minSide = Math.max(4, Math.min(grid.w, grid.h) * MIN_SIDE);
  const cutsX: number[] = [];
  const cutsY: number[] = [];
  for (const guide of guides) {
    const nextX = guide.vertical ? [...cutsX, guide.at] : cutsX;
    const nextY = guide.vertical ? cutsY : [...cutsY, guide.at];
    const pieces = splitByGuides(alpha, sheetW, rect, nextX, nextY);
    if (pieces.length > 1 && pieces.every((piece) => piece.w >= minSide && piece.h >= minSide)) {
      if (guide.vertical) cutsX.push(guide.at);
      else cutsY.push(guide.at);
    }
  }
  return splitByGuides(alpha, sheetW, rect, cutsX, cutsY);
}

function scoreGuide(
  rgba: Uint8ClampedArray,
  alpha: Uint8Array,
  sheetW: number,
  rect: AssetRect,
  at: number,
  vertical: boolean,
  least: number,
): Guide | null {
  const strength = seamStrength(rgba, alpha, sheetW, at, rect, vertical);
  if (strength === null) return null;
  // A thin shared edge is two props that only kiss. That always cuts.
  if (strength < 0) return { vertical, at, score: 10_000 };
  if (strength < least) return null;
  return { vertical, at, score: strength };
}

/** Grid lines strictly inside a span. */
function gridLines(start: number, size: number, margin: number, step: number): number[] {
  if (step <= 0 || size < step * 2) return [];
  const lines: number[] = [];
  const first = Math.ceil((start - margin) / step);
  for (let k = first; ; k++) {
    const at = margin + k * step;
    if (at <= start) continue;
    if (at >= start + size) break;
    lines.push(at);
  }
  return lines;
}

/**
 * How different the two sides of a line are, averaged over the pixels where
 * both sides are drawn. Below zero, the sides barely touch. Null when there
 * is too little overlap to judge and too much to call it a kiss.
 */
function seamStrength(
  rgba: Uint8ClampedArray,
  alpha: Uint8Array,
  sheetW: number,
  at: number,
  rect: AssetRect,
  vertical: boolean,
): number | null {
  const from = vertical ? rect.y : rect.x;
  const to = vertical ? rect.y + rect.h : rect.x + rect.w;
  let total = 0;
  let shared = 0;
  for (let t = from; t < to; t++) {
    const before = vertical ? t * sheetW + at - 1 : (at - 1) * sheetW + t;
    const after = vertical ? t * sheetW + at : at * sheetW + t;
    if ((alpha[before] ?? 0) <= ALPHA_CUTOFF || (alpha[after] ?? 0) <= ALPHA_CUTOFF) continue;
    const b = before * 4;
    const a = after * 4;
    total += Math.abs(rgba[b] - rgba[a]) + Math.abs(rgba[b + 1] - rgba[a + 1]) + Math.abs(rgba[b + 2] - rgba[a + 2]);
    shared += 1;
  }
  const span = to - from;
  if (span <= 0) return null;
  if (shared === 0 || shared < span * SEAM_THIN) return -1;
  if (shared < span * SEAM_TOUCH) return null;
  return total / (shared * 3);
}

// --- Pieces ------------------------------------------------------------------

/** Cuts the rectangle on absolute pixel lines and fits each cell to its pixels. */
function splitByGuides(
  alpha: Uint8Array,
  sheetW: number,
  rect: AssetRect,
  cutsX: number[],
  cutsY: number[],
): AssetRect[] {
  const xs = edges(rect.x, rect.x + rect.w, cutsX);
  const ys = edges(rect.y, rect.y + rect.h, cutsY);
  const pieces: AssetRect[] = [];
  for (let row = 0; row < ys.length - 1; row++) {
    for (let col = 0; col < xs.length - 1; col++) {
      const box = tightBox(alpha, sheetW, xs[col], ys[row], xs[col + 1], ys[row + 1]);
      if (box) pieces.push(box);
    }
  }
  return pieces;
}

function edges(start: number, end: number, cuts: number[]): number[] {
  const inside = [...new Set(cuts.map((cut) => Math.round(cut)).filter((cut) => cut > start && cut < end))];
  inside.sort((a, b) => a - b);
  return [start, ...inside, end];
}

/** The box of drawn pixels inside a region, or null when it is all background. */
function tightBox(
  alpha: Uint8Array,
  sheetW: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): AssetRect | null {
  let minX = x1;
  let minY = y1;
  let maxX = x0 - 1;
  let maxY = y0 - 1;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if ((alpha[y * sheetW + x] ?? 0) <= ALPHA_CUTOFF) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < minX) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

function readingOrder(rects: AssetRect[]): AssetRect[] {
  return [...rects].sort((a, b) => a.y - b.y || a.x - b.x);
}

function rectKey(rect: AssetRect): string {
  return `${rect.x},${rect.y},${rect.w},${rect.h}`;
}

function contains(outer: AssetRect, inner: AssetRect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}
