import type { Components, Foreground } from './foreground';
import { pixelBox } from './foreground';
import { expand, intersect, rectArea, rectGap, type Rect, type RGBAImage } from './image';
import type { ExtractedAsset, Proposal, TerrainProposal } from './types';

export interface SheetAnalysis {
  image: RGBAImage;
  fg: Foreground;
  comps: Components;
  cell: number | null;
}

export interface Dropped {
  name: string;
  reason: string;
  bbox: Rect;
}

export interface Refined {
  assets: ExtractedAsset[];
  /** Asset index per sheet pixel, -1 where no asset owns it. */
  owner: Int32Array;
  dropped: Dropped[];
  /** Components no proposal accounted for, too big to be stray specks. */
  leftovers: number[];
  /** Pairs of assets whose border was decided by splitting one island of pixels. */
  splits: [number, number][];
}

/** A cell becomes a tile when at least this much of it is drawn. */
const TILE_FILL = 0.5;
/** An island counts as inside a box when this much of it is. */
const INSIDE = 0.6;
/** ...and has a claim on it, to be shared out, when this much is. */
const PARTIAL = 0.2;
/** How far past a box-only claim its pixels may reach: a box read off a ruler can be a pixel or two short. */
const BOX_SLACK = 2;
/** Specks smaller than this are folded into the nearest asset, or dropped as noise. */
const SPECK = 6;
/** ...when that asset is within this many pixels. */
const SPECK_REACH = 4;

let assetCounter = 0;
export function nextAssetId(): string {
  assetCounter += 1;
  return `a${assetCounter}`;
}

/** Count of drawn pixels in any rectangle in constant time. */
function integral(mask: Uint8Array, w: number, h: number): (r: Rect) => number {
  const sum = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += mask[y * w + x] ? 1 : 0;
      sum[(y + 1) * (w + 1) + x + 1] = sum[y * (w + 1) + x + 1] + row;
    }
  }
  return (r) => {
    const x0 = Math.max(0, r.x);
    const y0 = Math.max(0, r.y);
    const x1 = Math.min(w, r.x + r.w);
    const y1 = Math.min(h, r.y + r.h);
    if (x1 <= x0 || y1 <= y0) return 0;
    return sum[y1 * (w + 1) + x1] - sum[y0 * (w + 1) + x1] - sum[y1 * (w + 1) + x0] + sum[y0 * (w + 1) + x0];
  };
}

const inBox = (r: Rect, x: number, y: number) => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;

export function anchorFor(kind: ExtractedAsset['kind'], rect: Rect): { x: number; y: number } {
  return kind === 'tile' ? { x: 0, y: 0 } : { x: Math.floor(rect.w / 2), y: rect.h };
}

/** Builds an asset from owned pixels; tiles keep their whole cell as the box so they still tile. */
export function makeAsset(
  base: Pick<ExtractedAsset, 'name' | 'category' | 'kind' | 'confidence' | 'source'> &
    Partial<Pick<ExtractedAsset, 'animation' | 'modelBox' | 'flags'>>,
  pixels: Int32Array,
  w: number,
  cellRect?: Rect,
): ExtractedAsset {
  const rect = cellRect ?? pixelBox(pixels, w)!;
  return {
    id: nextAssetId(),
    name: base.name,
    category: base.category,
    kind: base.kind,
    rect,
    pixels,
    anchor: anchorFor(base.kind, rect),
    confidence: base.confidence,
    modelConfidence: base.confidence,
    needsReview: false,
    flags: base.flags ? [...base.flags] : [],
    ...(base.animation ? { animation: base.animation } : {}),
    ...(base.modelBox ? { modelBox: base.modelBox } : {}),
    source: base.source,
  };
}

/** A small binary heap of pixel indices keyed by cost. */
class Heap {
  private keys: number[] = [];
  private vals: number[] = [];
  get size(): number {
    return this.keys.length;
  }
  push(key: number, val: number): void {
    const k = this.keys;
    const v = this.vals;
    let i = k.length;
    k.push(key);
    v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p];
      v[i] = v[p];
      i = p;
    }
    k[i] = key;
    v[i] = val;
  }
  pop(): [number, number] {
    const k = this.keys;
    const v = this.vals;
    const top: [number, number] = [k[0], v[0]];
    const lastK = k.pop()!;
    const lastV = v.pop()!;
    if (k.length > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        let mk = lastK;
        if (l < k.length && k[l] < mk) [m, mk] = [l, k[l]];
        if (r < k.length && k[r] < mk) m = r;
        if (m === i) break;
        k[i] = k[m];
        v[i] = v[m];
        i = m;
      }
      k[i] = lastK;
      v[i] = lastV;
    }
    return top;
  }
}

/**
 * Shares one island of pixels between assets that touch. Pixels inside only
 * one claimant's box seed that claimant; the rest go to whichever seed
 * reaches them most cheaply, where stepping across a sharp colour change
 * (an outline between two drawings) costs far more than stepping within one
 * colour. The border therefore follows the art's own outlines rather than
 * a straight line between boxes.
 */
export function competeForPixels(image: RGBAImage, pixels: Int32Array, boxes: Rect[]): Int32Array {
  const w = image.width;
  const d = image.data;
  const owner = new Map<number, number>();
  const cost = new Map<number, number>();
  const member = new Set<number>();
  for (const i of pixels) member.add(i);
  const heap = new Heap();
  for (const i of pixels) {
    const x = i % w;
    const y = (i - x) / w;
    let only = -1;
    let count = 0;
    boxes.forEach((b, k) => {
      if (inBox(b, x, y)) {
        only = k;
        count++;
      }
    });
    if (count === 1) {
      owner.set(i, only);
      cost.set(i, 0);
      heap.push(0, i);
    }
  }
  const diff = (a: number, b: number) =>
    Math.abs(d[a * 4] - d[b * 4]) + Math.abs(d[a * 4 + 1] - d[b * 4 + 1]) + Math.abs(d[a * 4 + 2] - d[b * 4 + 2]);
  while (heap.size) {
    const [c, i] = heap.pop();
    if (c > (cost.get(i) ?? Infinity)) continue;
    const x = i % w;
    const y = (i - x) / w;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= image.height) continue;
        const j = ny * w + nx;
        if (!member.has(j)) continue;
        const step = (dx && dy ? 1.41 : 1) + diff(i, j) / 48;
        const next = c + step;
        if (next < (cost.get(j) ?? Infinity)) {
          cost.set(j, next);
          owner.set(j, owner.get(i)!);
          heap.push(next, j);
        }
      }
    }
  }
  const out = new Int32Array(pixels.length);
  pixels.forEach((i, k) => {
    const got = owner.get(i);
    if (got !== undefined) {
      out[k] = got;
      return;
    }
    // No seed reaches this part: give it to the box whose centre is nearest.
    const x = i % w;
    const y = (i - x) / w;
    let best = 0;
    let bestD = Infinity;
    boxes.forEach((b, n) => {
      const dd = (b.x + b.w / 2 - x) ** 2 + (b.y + b.h / 2 - y) ** 2;
      if (dd < bestD) [best, bestD] = [n, dd];
    });
    out[k] = best;
  });
  return out;
}

/** Snaps a model's terrain box to whole grid cells. */
export function snapToCells(bbox: Rect, cell: number, w: number, h: number): Rect {
  const x0 = Math.max(0, Math.round(bbox.x / cell) * cell);
  const y0 = Math.max(0, Math.round(bbox.y / cell) * cell);
  let x1 = Math.min(Math.floor(w / cell) * cell, Math.round((bbox.x + bbox.w) / cell) * cell);
  let y1 = Math.min(Math.floor(h / cell) * cell, Math.round((bbox.y + bbox.h) / cell) * cell);
  if (x1 <= x0) x1 = x0 + cell;
  if (y1 <= y0) y1 = y0 + cell;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Stage 2: turns proposals into exact pixel sets on the original sheet.
 * Every drawn pixel ends up in at most one asset.
 */
export function refine(sheet: SheetAnalysis, proposals: Proposal[], terrain: TerrainProposal[]): Refined {
  const { image, fg, comps } = sheet;
  const w = image.width;
  const h = image.height;
  const owner = new Int32Array(w * h).fill(-1);
  const assets: ExtractedAsset[] = [];
  const dropped: Dropped[] = [];
  const splits: [number, number][] = [];
  const drawnIn = integral(fg.mask, w, h);

  // Terrain first: whole cells, untrimmed, so each still tiles seamlessly.
  for (const block of terrain) {
    const cell = block.cell;
    const area = snapToCells(block.bbox, cell, w, h);
    for (let y = area.y; y + cell <= area.y + area.h; y += cell) {
      for (let x = area.x; x + cell <= area.x + area.w; x += cell) {
        const cellRect = { x, y, w: cell, h: cell };
        const mine: number[] = [];
        for (let yy = y; yy < y + cell; yy++) {
          for (let xx = x; xx < x + cell; xx++) {
            const i = yy * w + xx;
            if (fg.mask[i] && owner[i] === -1) mine.push(i);
          }
        }
        if (mine.length < cell * cell * TILE_FILL) continue;
        const index = assets.length;
        for (const i of mine) owner[i] = index;
        assets.push(
          makeAsset(
            { name: block.name, category: block.category, kind: 'tile', confidence: block.confidence, source: 'model', modelBox: block.bbox },
            Int32Array.from(mine),
            w,
            cellRect,
          ),
        );
      }
    }
  }

  // Which proposals claim each island: by the marks the model named, or,
  // failing that, by an island sitting inside its box.
  const objects = proposals.map((p) => {
    if (rectArea(p.bbox) > 0 || p.marks.length === 0) return p;
    const boxes: Rect[] = p.marks.flatMap((m) => {
      const c = comps.list[m - 1];
      return c ? [{ x: c.x, y: c.y, w: c.w, h: c.h }] : [];
    });
    return boxes.length ? { ...p, bbox: boxes.reduce(unionRect) } : p;
  });
  const claims = new Map<number, number[]>();
  objects.forEach((p, k) => {
    for (const m of p.marks) if (comps.list[m - 1]) claims.set(m, [...(claims.get(m) ?? []), k]);
  });
  const free = (id: number) => comps.pixels[id - 1].filter((i) => owner[i] === -1);
  // A claim by box alone covers the box, not the whole island: what lies
  // outside every claiming box is left for verification to report.
  const byBox = new Set<number>();
  // A mark can be far bigger than the asset named with it: on an opaque
  // terrain sheet the whole sheet is one island. When every claim's box
  // leaves much of the island outside, the boxes bound it, not the mark.
  for (const [id, claimants] of claims) {
    const pixels = free(id);
    if (pixels.length === 0) continue;
    const small = claimants.every((k) => {
      const box = expand(objects[k].bbox, BOX_SLACK);
      let inside = 0;
      for (const i of pixels) if (inBox(box, i % w, Math.floor(i / w))) inside++;
      return rectArea(objects[k].bbox) > 0 && inside / pixels.length < INSIDE;
    });
    if (small) byBox.add(id);
  }
  for (const c of comps.list) {
    if (claims.has(c.id)) continue;
    const pixels = free(c.id);
    if (pixels.length === 0) continue;
    const implicit: { k: number; share: number }[] = [];
    objects.forEach((p, k) => {
      if (rectArea(p.bbox) === 0 || !intersect(c, expand(p.bbox, 1))) return;
      const box = expand(p.bbox, 1);
      let inside = 0;
      for (const i of pixels) if (inBox(box, i % w, Math.floor(i / w))) inside++;
      const ofIsland = inside / pixels.length;
      const ofBox = inside / Math.max(1, drawnIn(p.bbox));
      if (ofIsland >= PARTIAL || (p.marks.length === 0 && ofBox >= INSIDE)) implicit.push({ k, share: ofIsland });
    });
    if (implicit.length === 0) continue;
    claims.set(c.id, implicit.map((x) => x.k));
    byBox.add(c.id);
  }

  const owned: number[][] = objects.map(() => []);
  const touching = new Set<string>();
  for (const [id, claimants] of claims) {
    let pixels = free(id);
    if (byBox.has(id)) {
      // A tile is bounded by its grid cell; anything else by its box and a little slack.
      const boxes = claimants.map((k) =>
        objects[k].kind === 'tile' && sheet.cell ? snapToCells(objects[k].bbox, sheet.cell, w, h) : expand(objects[k].bbox, BOX_SLACK),
      );
      pixels = pixels.filter((i) => boxes.some((b) => inBox(b, i % w, Math.floor(i / w))));
    }
    if (pixels.length === 0) continue;
    if (claimants.length === 1) {
      for (const i of pixels) owned[claimants[0]].push(i);
      continue;
    }
    const split = competeForPixels(image, pixels, claimants.map((k) => objects[k].bbox));
    pixels.forEach((i, n) => owned[claimants[split[n]]].push(i));
    const used = [...new Set(split)].map((n) => claimants[n]);
    for (let a = 0; a < used.length; a++) for (let b = a + 1; b < used.length; b++) touching.add(`${used[a]},${used[b]}`);
  }

  const assetOf = new Map<number, number>();
  objects.forEach((p, k) => {
    const pixels = owned[k];
    if (pixels.length === 0) {
      const holder = assets.findIndex((a) => rectArea(p.bbox) > 0 && intersect(a.rect, p.bbox) && rectArea(intersect(a.rect, p.bbox)!) >= rectArea(p.bbox) * 0.5);
      dropped.push({
        name: p.name,
        bbox: p.bbox,
        reason: holder >= 0 ? `duplicate: its pixels already belong to "${assets[holder].name}"` : 'no drawn pixels where the model pointed',
      });
      return;
    }
    // A single tile only paints as floor when its box is its whole grid cell.
    const box = pixelBox(pixels, w)!;
    const cell = sheet.cell;
    const cellRect =
      p.kind === 'tile' && cell && box.w <= cell && box.h <= cell
        ? { x: Math.floor(box.x / cell) * cell, y: Math.floor(box.y / cell) * cell, w: cell, h: cell }
        : undefined;
    const fits = !!cellRect && box.x + box.w <= cellRect.x + cellRect.w && box.y + box.h <= cellRect.y + cellRect.h;
    const kind = p.kind === 'tile' && !fits ? 'object' : p.kind;
    const index = assets.length;
    for (const i of pixels) owner[i] = index;
    assetOf.set(k, index);
    assets.push(
      makeAsset(
        {
          name: p.name,
          category: p.category,
          kind,
          confidence: p.confidence,
          source: p.source,
          animation: p.animation,
          modelBox: rectArea(p.bbox) > 0 ? p.bbox : undefined,
        },
        Int32Array.from(pixels).sort(),
        w,
        kind === 'tile' ? cellRect : undefined,
      ),
    );
  });
  for (const pair of touching) {
    const [a, b] = pair.split(',').map(Number);
    if (assetOf.has(a) && assetOf.has(b)) splits.push([assetOf.get(a)!, assetOf.get(b)!]);
  }

  const leftovers = absorbSpecks(sheet, assets, owner);
  return { assets, owner, dropped, leftovers, splits };
}

function unionRect(a: Rect, b: Rect): Rect {
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  return { x: x0, y: y0, w: Math.max(a.x + a.w, b.x + b.w) - x0, h: Math.max(a.y + a.h, b.y + b.h) - y0 };
}

/**
 * Islands nobody claimed. Specks within reach of an asset join it (sparkles
 * beside a fountain); the rest are reported so verification can look again.
 */
export function absorbSpecks(sheet: SheetAnalysis, assets: ExtractedAsset[], owner: Int32Array): number[] {
  const w = sheet.image.width;
  const leftovers: number[] = [];
  for (const c of sheet.comps.list) {
    const pixels = sheet.comps.pixels[c.id - 1].filter((i) => owner[i] === -1);
    if (pixels.length === 0) continue;
    if (pixels.length >= SPECK) {
      leftovers.push(c.id);
      continue;
    }
    let best = -1;
    let bestGap = SPECK_REACH + 1;
    assets.forEach((a, k) => {
      if (a.kind === 'tile') return;
      const gap = rectGap(a.rect, c);
      if (gap < bestGap) [best, bestGap] = [k, gap];
    });
    if (best < 0) continue;
    const a = assets[best];
    for (const i of pixels) owner[i] = best;
    const merged = Int32Array.from([...a.pixels, ...pixels]).sort();
    assets[best] = { ...a, pixels: merged, rect: pixelBox(merged, w)! };
    assets[best].anchor = anchorFor(a.kind, assets[best].rect);
  }
  return leftovers;
}
