import type { Components } from './foreground';
import {
  createImage,
  drawImage,
  drawLabel,
  expand,
  intersect,
  iou,
  paletteColour,
  rectArea,
  strokeRect,
  textSize,
  union,
  upscale,
  cropImage,
  type Colour,
  type Rect,
  type RGBAImage,
} from './image';
import { CATEGORIES, type AssetKind, type Category, type Proposal, type TerrainProposal } from './types';

/** One window of the sheet sent to the model, enlarged so every pixel is visible. */
export interface Region {
  index: number;
  rect: Rect;
  scale: number;
}

/** Longest side of the art area in a picture sent to the model. */
const VIEW_TARGET = 1152;
/** Region side, in sheet pixels, once a sheet is too big for one view. */
const REGION_SIDE = 512;
/** Marks smaller than this many pixels are not numbered; refinement attaches them. */
export const MIN_MARK_AREA = 6;
/** Ruler band, in picture pixels. */
const RULER = 26;
/** Transparent pixels are shown as this flat colour, which the prompt names. */
const EMPTY: Colour = [255, 0, 255, 255];

/**
 * Overlapping windows over the sheet. A small sheet is one window; a large
 * one is covered by several, each enlarged at least 2x, so the model never
 * sees a shrunken copy. Neighbouring windows overlap by at least a cell, so
 * anything cut by one window's edge is whole in the next.
 */
export function planRegions(w: number, h: number, cell: number | null): Region[] {
  if (Math.max(w, h) <= REGION_SIDE) {
    const scale = Math.max(1, Math.min(6, Math.floor(VIEW_TARGET / Math.max(w, h))));
    return [{ index: 0, rect: { x: 0, y: 0, w, h }, scale }];
  }
  const overlap = Math.min(160, Math.max(64, (cell ?? 16) * 2));
  const starts = (size: number): number[] => {
    if (size <= REGION_SIDE) return [0];
    const n = Math.ceil((size - overlap) / (REGION_SIDE - overlap));
    const step = (size - REGION_SIDE) / (n - 1);
    return Array.from({ length: n }, (_, i) => Math.round(i * step));
  };
  const regions: Region[] = [];
  for (const y of starts(h)) {
    for (const x of starts(w)) {
      const rect = { x, y, w: Math.min(REGION_SIDE, w - x), h: Math.min(REGION_SIDE, h - y) };
      regions.push({ index: regions.length, rect, scale: Math.max(2, Math.floor(1024 / Math.max(rect.w, rect.h))) });
    }
  }
  return regions;
}

/** The region's art enlarged, with transparent pixels flattened onto the empty colour. */
function regionArt(image: RGBAImage, region: Region): RGBAImage {
  const crop = cropImage(image, region.rect);
  const flat = createImage(crop.width, crop.height, EMPTY);
  drawImage(flat, crop, 0, 0);
  return upscale(flat, region.scale);
}

function rulerStep(region: Region, cell: number | null): number {
  const base = cell && cell >= 8 ? cell : 16;
  let step = base;
  while (textSize(String(region.rect.x + region.rect.w), 2).w + 8 > step * region.scale) step += base;
  return step;
}

/** Rulers in sheet coordinates along the top and left, so the model can read positions off them. */
function framed(art: RGBAImage, region: Region, cell: number | null): RGBAImage {
  const out = createImage(art.width + RULER, art.height + RULER, [24, 24, 28, 255]);
  drawImage(out, art, RULER, RULER);
  const step = rulerStep(region, cell);
  const white: Colour = [240, 240, 240, 255];
  const clear: Colour = [0, 0, 0, 0];
  const first = Math.ceil(region.rect.x / step) * step;
  for (let sx = first; sx <= region.rect.x + region.rect.w; sx += step) {
    const px = RULER + (sx - region.rect.x) * region.scale;
    strokeRect(out, { x: px, y: RULER - 6, w: 1, h: 6 }, white);
    if (px + 2 < out.width - 10) drawLabel(out, String(sx), px + 2, 2, 2, white, clear);
  }
  const firstY = Math.ceil(region.rect.y / step) * step;
  for (let sy = firstY; sy <= region.rect.y + region.rect.h; sy += step) {
    const py = RULER + (sy - region.rect.y) * region.scale;
    strokeRect(out, { x: RULER - 6, y: py, w: 6, h: 1 }, white);
    // Vertical labels would be unreadable, so the left ruler shows the number in short form.
    if (py + 12 < out.height) drawLabel(out, String(sy), 0, py + 2, 1, white, clear);
  }
  return out;
}

export interface RegionViews {
  clean: RGBAImage;
  marked: RGBAImage;
  /** Mark ids drawn in this view. */
  marks: number[];
}

/**
 * The two pictures for one region: the art as it is, and the same art with
 * every separate island outlined and numbered. The numbers are how the model
 * says which pixels belong together; the rulers are how it gives positions.
 */
export function renderRegion(image: RGBAImage, comps: Components, region: Region, cell: number | null): RegionViews {
  const { clean, marked, offset } = renderView(image, region, cell);
  const s = region.scale;
  const marks: number[] = [];
  const toView = (r: Rect): Rect => ({
    x: offset + (r.x - region.rect.x) * s,
    y: offset + (r.y - region.rect.y) * s,
    w: r.w * s,
    h: r.h * s,
  });
  const visible = comps.list
    .filter((c) => c.area >= MIN_MARK_AREA && intersect(c, region.rect))
    .sort((a, b) => b.area - a.area);
  for (const c of visible) {
    const box = toView(intersect(c, region.rect)!);
    strokeRect(marked, box, paletteColour(c.id, 230), s >= 3 ? 2 : 1);
  }
  for (const c of visible) {
    const box = toView(intersect(c, region.rect)!);
    const label = String(c.id);
    const size = textSize(label, 2);
    const x = Math.min(Math.max(offset, box.x), marked.width - size.w - 4);
    const y = Math.min(Math.max(offset, box.y), marked.height - size.h - 4);
    drawLabel(marked, label, x, y, 2, [255, 255, 255, 255], [0, 0, 0, 210]);
    marks.push(c.id);
  }
  return { clean, marked, marks };
}

/** Two framed copies of a region's art, one to keep clean and one to draw on, and where the art starts in them. */
export function renderView(image: RGBAImage, region: Region, cell: number | null): { clean: RGBAImage; marked: RGBAImage; offset: number } {
  const art = regionArt(image, region);
  return { clean: framed(art, region, cell), marked: framed(art, region, cell), offset: RULER };
}

export const DETECT_SYSTEM =
  'You are a meticulous pixel-art asset annotator for a 2D map editor. You look at sprite and tileset sheets and ' +
  'identify every individual asset exactly. You reply with a single JSON object and nothing else.';

export function detectPrompt(region: Region, count: number, sheet: { w: number; h: number }, cell: number | null): string {
  const r = region.rect;
  return [
    `Sheet: ${sheet.w} x ${sheet.h} pixels. This is view ${region.index + 1} of ${count}; it shows sheet pixels x ${r.x} to ${r.x + r.w} and y ${r.y} to ${r.y + r.h}, enlarged ${region.scale}x with nearest-neighbour scaling.`,
    `The rulers on the top and left edges give SHEET pixel coordinates${cell ? `; the sheet's grid cell looks like ${cell} px` : ''}. Flat magenta (#FF00FF) is empty, transparent background, never part of an asset.`,
    'Picture A is the art. Picture B is the same view with every separate island of pixels outlined and numbered: these numbers are "marks".',
    '',
    'List every individual asset visible in this view. Rules:',
    '- One asset is one complete thing a level designer would place: a tree, bush, rock, bench, lamp, sign, flower, fence piece, building, character pose.',
    '- A tree with separated leaf clusters, branches and trunk is ONE asset: list all of its marks together.',
    '- Two trees standing close together are TWO assets. Things that touch and share one mark are still separate assets: give each its own bbox and list the shared mark in both.',
    '- A bench or table spanning several grid cells is ONE asset. A building with many parts is ONE asset unless the sheet clearly lays it out as separate modular pieces.',
    '- Every variation (each colour, each size, each season) is its own asset.',
    '- Animation strips: every frame is its own asset with kind "frame" and animation {"group": a shared name, "frame": 0-based index in order}.',
    '- Tiny specks next to an object (sparkles, falling leaves, a shadow pixel) belong to that object.',
    '- An asset cut off by the edge of this view still gets listed with its visible part; set "edge": true.',
    '- Repeating ground, floor, path, water or wall texture laid out as a modular block of grid cells meant to be painted cell by cell: do NOT list each cell. Add one "terrain" entry per material block (grass, dirt, wooden floor, ...) with its bbox and the cell size in sheet pixels. Every repeated cell in it will be cut out separately.',
    '- A single decorated tile that is not part of a repeating block (a manhole, a crosswalk) is an asset with kind "tile".',
    '',
    `Categories: ${CATEGORIES.join(', ')}.`,
    'bbox is [x0, y0, x1, y1] in SHEET pixels read from the rulers, x1 and y1 exclusive, tight around the visible pixels.',
    'confidence is 0 to 1: how sure you are that this is exactly one complete asset with the right marks.',
    '',
    'Reply with JSON only, in this shape:',
    '{"assets":[{"name":"round oak tree","category":"tree","kind":"object","marks":[12,13],"bbox":[0,0,32,48],"confidence":0.9,"edge":false,"animation":null}],',
    ' "terrain":[{"name":"short grass","category":"terrain","bbox":[0,96,96,240],"cell":48,"confidence":0.9}]}',
  ].join('\n');
}

const KINDS: AssetKind[] = ['object', 'tile', 'frame'];

export function toCategory(value: unknown): Category {
  const v = String(value ?? '').toLowerCase().trim();
  return (CATEGORIES as readonly string[]).includes(v) ? (v as Category) : 'other';
}

function toBox(value: unknown, bounds: Rect): Rect | null {
  if (!Array.isArray(value) || value.length !== 4 || !value.every((v) => Number.isFinite(Number(v)))) return null;
  let [x0, y0, x1, y1] = value.map(Number);
  if (x1 < x0) [x0, x1] = [x1, x0];
  if (y1 < y0) [y0, y1] = [y1, y0];
  const box = intersect({ x: Math.floor(x0), y: Math.floor(y0), w: Math.ceil(x1) - Math.floor(x0), h: Math.ceil(y1) - Math.floor(y0) }, bounds);
  return box && box.w >= 1 && box.h >= 1 ? box : null;
}

function cleanName(value: unknown, fallback: string): string {
  const name = String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
  return name || fallback;
}

let proposalCounter = 0;
export function nextProposalId(prefix = 'p'): string {
  proposalCounter += 1;
  return `${prefix}${proposalCounter}`;
}

/**
 * Reads one region's reply. Anything malformed is skipped rather than
 * guessed at; marks that were not drawn in the region are ignored.
 */
export function parseDetection(
  json: unknown,
  region: Region,
  shownMarks: number[],
  sheet: { w: number; h: number },
): { proposals: Proposal[]; terrain: TerrainProposal[]; skipped: number } {
  const proposals: Proposal[] = [];
  const terrain: TerrainProposal[] = [];
  let skipped = 0;
  const obj = (json ?? {}) as { assets?: unknown; terrain?: unknown };
  const shown = new Set(shownMarks);
  // Boxes may run a little past the view when the model reads the ruler loosely.
  const bounds = intersect(expand(region.rect, 8), { x: 0, y: 0, w: sheet.w, h: sheet.h })!;
  for (const raw of Array.isArray(obj.assets) ? obj.assets : []) {
    const a = (raw ?? {}) as Record<string, unknown>;
    const marks = Array.isArray(a.marks) ? a.marks.map(Number).filter((m) => shown.has(m)) : [];
    const bbox = toBox(a.bbox, bounds);
    if (!bbox && marks.length === 0) {
      skipped++;
      continue;
    }
    const kind = KINDS.includes(a.kind as AssetKind) ? (a.kind as AssetKind) : 'object';
    const anim = a.animation as { group?: unknown; frame?: unknown } | null | undefined;
    const animation =
      anim && typeof anim === 'object' && anim.group !== undefined && Number.isFinite(Number(anim.frame))
        ? { group: cleanName(anim.group, 'animation'), frame: Math.max(0, Math.round(Number(anim.frame))) }
        : undefined;
    const confidence = Number(a.confidence);
    proposals.push({
      id: nextProposalId(),
      name: cleanName(a.name, 'asset'),
      category: toCategory(a.category),
      kind: animation ? 'frame' : kind,
      bbox: bbox ?? { x: 0, y: 0, w: 0, h: 0 },
      marks: [...new Set(marks)],
      confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.5,
      ...(animation ? { animation } : {}),
      source: 'model',
      region: region.index,
    });
  }
  for (const raw of Array.isArray(obj.terrain) ? obj.terrain : []) {
    const t = (raw ?? {}) as Record<string, unknown>;
    const bbox = toBox(t.bbox, bounds);
    const cell = Math.round(Number(t.cell));
    if (!bbox || !(cell >= 4)) {
      skipped++;
      continue;
    }
    const confidence = Number(t.confidence);
    terrain.push({
      name: cleanName(t.name, 'ground'),
      category: toCategory(t.category ?? 'terrain'),
      bbox,
      cell,
      confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.5,
      region: region.index,
    });
  }
  return { proposals, terrain, skipped };
}

/**
 * Proposals from overlapping regions describe the same asset twice, or an
 * asset cut in two by a region edge. Proposals from different regions are
 * joined when they share marks, or when their boxes mostly coincide.
 * Within one region, shared marks mean the model is splitting touching
 * assets, so those are never joined.
 */
export function mergeAcrossRegions(proposals: Proposal[]): Proposal[] {
  const parent = proposals.map((_, i) => i);
  const regionsOf = proposals.map((p) => new Set([p.region]));
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const join = (i: number, j: number) => {
    const a = find(i);
    const b = find(j);
    if (a === b) return;
    // Two proposals from one region are two assets, however they are reached.
    if ([...regionsOf[a]].some((r) => regionsOf[b].has(r))) return;
    parent[a] = b;
    for (const r of regionsOf[a]) regionsOf[b].add(r);
  };
  const pairs: { i: number; j: number; strength: number }[] = [];
  for (let i = 0; i < proposals.length; i++) {
    for (let j = i + 1; j < proposals.length; j++) {
      const a = proposals[i];
      const b = proposals[j];
      if (a.region === b.region) continue;
      const shared = a.marks.filter((m) => b.marks.includes(m)).length;
      const jaccard = shared / Math.max(1, new Set([...a.marks, ...b.marks]).size);
      const boxes = rectArea(a.bbox) > 0 && rectArea(b.bbox) > 0;
      const inter = boxes ? intersect(a.bbox, b.bbox) : null;
      const contained = inter ? rectArea(inter) / Math.min(rectArea(a.bbox), rectArea(b.bbox)) : 0;
      const sameMarks = shared > 0 && jaccard >= 0.5 && (!boxes || contained >= 0.3);
      const sameBox = boxes && (iou(a.bbox, b.bbox) >= 0.5 || (contained >= 0.8 && (shared > 0 || a.marks.length + b.marks.length === 0)));
      if (sameMarks || sameBox) pairs.push({ i, j, strength: jaccard + contained });
    }
  }
  for (const { i, j } of pairs.sort((p, q) => q.strength - p.strength)) join(i, j);
  const groups = new Map<number, Proposal[]>();
  proposals.forEach((p, i) => {
    const root = find(i);
    groups.set(root, [...(groups.get(root) ?? []), p]);
  });
  return [...groups.values()].map((group) => {
    if (group.length === 1) return group[0];
    const best = [...group].sort((a, b) => b.confidence - a.confidence)[0];
    const boxes = group.map((p) => p.bbox).filter((b) => rectArea(b) > 0);
    return {
      ...best,
      bbox: boxes.length ? boxes.reduce(union) : best.bbox,
      marks: [...new Set(group.flatMap((p) => p.marks))],
      confidence: Math.max(...group.map((p) => p.confidence)),
      regions: [...new Set(group.map((p) => p.region))],
    };
  });
}

/** Terrain blocks seen from two regions are one block. */
export function mergeTerrain(blocks: TerrainProposal[]): TerrainProposal[] {
  const out: TerrainProposal[] = [];
  for (const block of blocks) {
    const same = out.find((o) => o.cell === block.cell && o.name === block.name && intersect(expand(o.bbox, 1), block.bbox));
    if (same) {
      same.bbox = union(same.bbox, block.bbox);
      same.confidence = Math.max(same.confidence, block.confidence);
    } else out.push({ ...block });
  }
  return out;
}
