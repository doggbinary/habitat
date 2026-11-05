import { renderView, type Region } from './detect';
import { expand, iou, rectArea, rectGap, type Colour, type Rect, type RGBAImage, drawLabel } from './image';
import { competeForPixels, makeAsset, type Dropped, type Refined, type SheetAnalysis } from './refine';
import { REVIEW_THRESHOLD, type Category, type ExtractedAsset, type Flag, type FlagCode } from './types';
import { toCategory } from './detect';

const PENALTY: Partial<Record<FlagCode, number>> = {
  'touching-split': 0.85,
  'box-mismatch': 0.7,
  'beyond-box': 0.75,
  'possible-split': 0.75,
  'animation-size': 0.85,
  'animation-gap': 0.9,
  'terrain-overlap': 0.8,
  'low-confidence': 1,
  unidentified: 1,
};

function flag(asset: ExtractedAsset, code: FlagCode, severity: Flag['severity'], message: string): void {
  if (asset.flags.some((f) => f.code === code && f.message === message)) return;
  asset.flags.push({ code, severity, message });
}

/** Leftover islands close together are one unidentified thing, not several. */
export function groupLeftovers(sheet: SheetAnalysis, leftovers: number[], owner: Int32Array): ExtractedAsset[] {
  const comps = leftovers.map((id) => sheet.comps.list[id - 1]);
  const parent = comps.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < comps.length; i++) {
    for (let j = i + 1; j < comps.length; j++) if (rectGap(comps[i], comps[j]) <= 2) parent[find(i)] = find(j);
  }
  const groups = new Map<number, number[]>();
  comps.forEach((c, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), c.id]));
  return [...groups.values()].map((ids) => {
    const pixels = Int32Array.from(ids.flatMap((id) => [...sheet.comps.pixels[id - 1]].filter((i) => owner[i] === -1))).sort();
    return makeAsset(
      {
        name: 'unidentified',
        category: 'other',
        kind: 'object',
        confidence: 0.3,
        source: 'pixels',
        flags: [{ code: 'unidentified', severity: 'warn', message: 'Drawn pixels that no detected asset accounted for.' }],
      },
      pixels,
      sheet.image.width,
    );
  });
}

export interface CheckOptions {
  /** False in pixel-only mode, where nothing was seen by a model. */
  modelUsed: boolean;
  /** Asset ids already settled by a second inspection. */
  settled?: Set<string>;
}

/**
 * Stage 3 checks. Each asset gets flags for anything suspicious and a
 * confidence that combines the model's own with what the pixels say.
 * Neighbour ids per asset are returned for the second inspection.
 */
export function checkAssets(sheet: SheetAnalysis, assets: ExtractedAsset[], splits: [number, number][], options: CheckOptions): Map<string, string[]> {
  const neighbours = new Map<string, string[]>();
  const near = (a: ExtractedAsset, b: ExtractedAsset) => {
    neighbours.set(a.id, [...new Set([...(neighbours.get(a.id) ?? []), b.id])]);
    neighbours.set(b.id, [...new Set([...(neighbours.get(b.id) ?? []), a.id])]);
  };
  const kept: FlagCode[] = ['confirmed', 'corrected', 'unidentified'];
  for (const a of assets) a.flags = a.flags.filter((f) => kept.includes(f.code));

  for (const [ia, ib] of splits) {
    const a = assets[ia];
    const b = assets[ib];
    if (!a || !b) continue;
    flag(a, 'touching-split', 'warn', `Touches "${b.name}"; the border between them was traced along the outlines.`);
    flag(b, 'touching-split', 'warn', `Touches "${a.name}"; the border between them was traced along the outlines.`);
    near(a, b);
  }

  const tiles = assets.filter((a) => a.kind === 'tile');
  for (const a of assets) {
    if (!options.modelUsed) flag(a, 'no-model', 'info', 'Pixel analysis only: no vision model looked at this sheet.');
    if (a.kind === 'tile') {
      const cell = a.rect.w * a.rect.h;
      if (a.pixels.length < cell) flag(a, 'transparency', 'info', `Cell is ${Math.round((100 * a.pixels.length) / cell)}% drawn; the rest is transparent.`);
      continue;
    }
    if (a.modelBox) {
      const grown = rectArea(a.rect) > rectArea(a.modelBox) * 1.5 && rectArea(a.rect) - rectArea(a.modelBox) > 64;
      if (grown) flag(a, 'beyond-box', 'warn', 'Its pixels reach well outside the box the model drew; it may include a neighbour.');
      else if (iou(a.rect, a.modelBox) < 0.5) flag(a, 'box-mismatch', 'warn', 'The model’s box and the pixels found disagree; parts may be missing.');
    }
    if (a.source === 'model' && a.confidence < 0.5) flag(a, 'low-confidence', 'warn', `The model was unsure (${Math.round(a.confidence * 100)}%).`);
    if (a.modelBox && tiles.some((t) => rectArea(expand(t.rect, 0)) > 0 && iou(t.rect, a.modelBox!) > 0.5)) {
      flag(a, 'terrain-overlap', 'warn', 'Sits where terrain cells were cut; its pixels may have gone to the tiles.');
    }
    if (sheet.fg.background === 'alpha') {
      let soft = 0;
      for (const i of a.pixels) if (sheet.image.data[i * 4 + 3] < 250) soft++;
      if (soft / a.pixels.length > 0.4) flag(a, 'transparency', 'info', 'Mostly semi-transparent pixels: a shadow or effect?');
    } else if (sheet.fg.colour) {
      const [r, g, b] = sheet.fg.colour;
      let backdrop = 0;
      for (const i of a.pixels) {
        const d = sheet.image.data;
        if (d[i * 4] === r && d[i * 4 + 1] === g && d[i * 4 + 2] === b) backdrop++;
      }
      if (backdrop > 0) flag(a, 'transparency', 'info', `Keeps ${backdrop} pixels of the backdrop colour enclosed by the drawing.`);
    }
  }

  // A small piece hugging a bigger object may be a part of it.
  const objects = assets.filter((a) => a.kind !== 'tile');
  for (const a of objects) {
    for (const b of objects) {
      if (a === b || a.pixels.length >= b.pixels.length * 0.15) continue;
      if (rectGap(a.rect, b.rect) > 2) continue;
      flag(a, 'possible-split', 'warn', `Small and right beside "${b.name}"; it may be a piece of it.`);
      near(a, b);
    }
  }

  // Animation frames should match in size and run without gaps.
  const groups = new Map<string, ExtractedAsset[]>();
  for (const a of assets) if (a.animation) groups.set(a.animation.group, [...(groups.get(a.animation.group) ?? []), a]);
  for (const [group, frames] of groups) {
    frames.sort((a, b) => a.animation!.frame - b.animation!.frame);
    const ws = frames.map((f) => f.rect.w).sort((x, y) => x - y);
    const hs = frames.map((f) => f.rect.h).sort((x, y) => x - y);
    const mw = ws[ws.length >> 1];
    const mh = hs[hs.length >> 1];
    for (const f of frames) {
      if (Math.abs(f.rect.w - mw) > mw * 0.25 || Math.abs(f.rect.h - mh) > mh * 0.25) {
        flag(f, 'animation-size', 'warn', `Frame ${f.animation!.frame} of "${group}" is a different size from the others.`);
      }
    }
    const indices = frames.map((f) => f.animation!.frame);
    for (let k = 1; k < indices.length; k++) {
      if (indices[k] - indices[k - 1] > 1) {
        flag(frames[k], 'animation-gap', 'warn', `"${group}" jumps from frame ${indices[k - 1]} to ${indices[k]}; a frame may be missing.`);
      }
      if (indices[k] === indices[k - 1]) flag(frames[k], 'duplicate', 'warn', `"${group}" has two frames numbered ${indices[k]}.`);
    }
  }

  for (const a of assets) {
    const settled = options.settled?.has(a.id) ?? false;
    let c = a.modelConfidence;
    if (!settled) for (const f of a.flags) c *= PENALTY[f.code] ?? 1;
    if (!options.modelUsed) c = Math.min(c, 0.5);
    a.confidence = Math.round(c * 100) / 100;
    a.needsReview = !settled && (a.confidence < REVIEW_THRESHOLD || a.flags.some((f) => f.severity === 'error' || f.code === 'unidentified'));
  }
  return neighbours;
}

/** The assets worth a second look, least certain first. */
export function reinspectionQueue(assets: ExtractedAsset[], limit: number): ExtractedAsset[] {
  return assets
    .filter((a) => a.needsReview || a.flags.some((f) => f.severity === 'warn'))
    .filter((a) => a.kind !== 'tile' || a.needsReview)
    .sort((a, b) => a.confidence - b.confidence)
    .slice(0, limit);
}

const GREEN: Colour = [40, 255, 90, 255];
const BLUE: Colour = [60, 150, 255, 255];
const RED: Colour = [255, 40, 40, 255];

/** Outlines a pixel set by drawing every edge between a member and a non-member. */
function outline(view: RGBAImage, pixels: ArrayLike<number>, sheetW: number, region: Region, offset: number, colour: Colour): void {
  const set = new Set<number>();
  for (let k = 0; k < pixels.length; k++) set.add(pixels[k]);
  const s = region.scale;
  const t = Math.max(1, Math.floor(s / 3));
  const put = (x: number, y: number, ww: number, hh: number) => {
    for (let yy = y; yy < y + hh; yy++) {
      for (let xx = x; xx < x + ww; xx++) {
        if (xx < 0 || yy < 0 || xx >= view.width || yy >= view.height) continue;
        view.data.set(colour, (yy * view.width + xx) * 4);
      }
    }
  };
  for (const i of set) {
    const x = i % sheetW;
    const y = (i - x) / sheetW;
    if (x < region.rect.x || y < region.rect.y || x >= region.rect.x + region.rect.w || y >= region.rect.y + region.rect.h) continue;
    const vx = offset + (x - region.rect.x) * s;
    const vy = offset + (y - region.rect.y) * s;
    if (!set.has(i - 1) || x === 0) put(vx, vy, t, s);
    if (!set.has(i + 1)) put(vx + s - t, vy, t, s);
    if (!set.has(i - sheetW)) put(vx, vy, s, t);
    if (!set.has(i + sheetW)) put(vx, vy + s - t, s, t);
  }
}

export interface ReinspectView {
  clean: RGBAImage;
  marked: RGBAImage;
  region: Region;
  /** Neighbour asset ids by the number drawn on them. */
  numbered: string[];
}

/** A close-up of one asset with its exact extracted outline, its neighbours, and unclaimed pixels. */
export function renderReinspection(sheet: SheetAnalysis, assets: ExtractedAsset[], asset: ExtractedAsset, owner: Int32Array): ReinspectView {
  const w = sheet.image.width;
  const around = Math.max(10, Math.round(Math.max(asset.rect.w, asset.rect.h) * 0.4));
  const rect = expand(asset.rect, around, sheet.image);
  const scale = Math.max(2, Math.min(10, Math.floor(720 / Math.max(rect.w, rect.h))));
  const region: Region = { index: 0, rect, scale };
  const { clean, marked, offset } = renderView(sheet.image, region, sheet.cell);
  const numbered: string[] = [];
  for (const other of assets) {
    if (other === asset || rectGap(other.rect, rect) > 0) continue;
    outline(marked, other.pixels, w, region, offset, BLUE);
    numbered.push(other.id);
  }
  outline(marked, asset.pixels, w, region, offset, GREEN);
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      const i = y * w + x;
      if (!sheet.fg.mask[i] || owner[i] !== -1) continue;
      const vx = offset + (x - rect.x) * scale + (scale >> 1);
      const vy = offset + (y - rect.y) * scale + (scale >> 1);
      marked.data.set(RED, (vy * marked.width + vx) * 4);
    }
  }
  numbered.forEach((id, n) => {
    const other = assets.find((a) => a.id === id)!;
    const x = offset + Math.max(0, other.rect.x - rect.x) * scale;
    const y = offset + Math.max(0, other.rect.y - rect.y) * scale;
    drawLabel(marked, String(n + 1), Math.min(x, marked.width - 20), Math.min(y, marked.height - 16), 2, [255, 255, 255, 255], [20, 60, 160, 230]);
  });
  return { clean, marked, region, numbered };
}

export const REINSPECT_SYSTEM =
  'You are reviewing the output of a pixel-art asset extractor. You check one extracted asset at a time and say ' +
  'exactly how to fix it. You reply with a single JSON object and nothing else.';

export function reinspectPrompt(asset: ExtractedAsset, view: ReinspectView): string {
  const r = view.region.rect;
  const issues = asset.flags.filter((f) => f.severity !== 'info').map((f) => `- ${f.message}`);
  return [
    `This close-up shows sheet pixels x ${r.x} to ${r.x + r.w} and y ${r.y} to ${r.y + r.h}, enlarged ${view.region.scale}x. Rulers give SHEET pixel coordinates. Flat magenta is transparent background.`,
    'Picture A is the art. In picture B the extracted asset under review is outlined in GREEN, neighbouring extracted assets are outlined in BLUE and numbered, and RED dots mark drawn pixels that no asset owns yet.',
    `The extractor called the green asset "${asset.name}" (${asset.category}, ${asset.kind}).${issues.length ? ' It was flagged for:' : ''}`,
    ...issues,
    '',
    'Decide what is right:',
    '- "keep": the green outline is exactly one complete asset.',
    '- "merge": the green asset and the listed blue neighbours are one single object; give their numbers in merge_with.',
    '- "split": the green outline holds several separate assets; give a tight bbox [x0, y0, x1, y1] in SHEET pixels for each in parts.',
    '- "drop": the green pixels are not a usable asset (noise, stray background, a leftover fragment that belongs to nothing).',
    'Also give the best descriptive name and category for the result.',
    '',
    'Reply with JSON only:',
    '{"verdict":"keep","merge_with":[],"parts":[{"name":"small rock","category":"rock","bbox":[0,0,16,16]}],"name":"mossy boulder","category":"rock","confidence":0.9,"reason":"short reason"}',
  ].join('\n');
}

export interface ReinspectReply {
  verdict: 'keep' | 'merge' | 'split' | 'drop';
  mergeWith: number[];
  parts: { name: string; category: Category; bbox: Rect }[];
  name?: string;
  category?: Category;
  confidence: number;
  reason: string;
}

export function parseReinspection(json: unknown, sheet: { w: number; h: number }): ReinspectReply | null {
  const o = (json ?? {}) as Record<string, unknown>;
  const verdict = String(o.verdict ?? '').toLowerCase();
  if (!['keep', 'merge', 'split', 'drop'].includes(verdict)) return null;
  const parts = (Array.isArray(o.parts) ? o.parts : []).flatMap((raw) => {
    const p = (raw ?? {}) as Record<string, unknown>;
    const b = Array.isArray(p.bbox) ? p.bbox.map(Number) : [];
    if (b.length !== 4 || !b.every(Number.isFinite)) return [];
    const x0 = Math.max(0, Math.min(b[0], b[2]));
    const y0 = Math.max(0, Math.min(b[1], b[3]));
    const x1 = Math.min(sheet.w, Math.max(b[0], b[2]));
    const y1 = Math.min(sheet.h, Math.max(b[1], b[3]));
    if (x1 - x0 < 1 || y1 - y0 < 1) return [];
    return [{ name: String(p.name ?? 'asset').slice(0, 60), category: toCategory(p.category), bbox: { x: Math.floor(x0), y: Math.floor(y0), w: Math.ceil(x1 - x0), h: Math.ceil(y1 - y0) } }];
  });
  const confidence = Number(o.confidence);
  return {
    verdict: verdict as ReinspectReply['verdict'],
    mergeWith: (Array.isArray(o.merge_with) ? o.merge_with : []).map(Number).filter((n) => Number.isInteger(n) && n > 0),
    parts,
    name: typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, 60) : undefined,
    category: o.category ? toCategory(o.category) : undefined,
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.5,
    reason: String(o.reason ?? '').slice(0, 200),
  };
}

/**
 * Applies a second inspection's verdict. Returns the ids of assets that are
 * now settled (confirmed or rebuilt), so the next check does not send them
 * straight back.
 */
export function applyReinspection(
  sheet: SheetAnalysis,
  refined: Refined,
  assetId: string,
  view: ReinspectView,
  reply: ReinspectReply,
): { settled: string[]; note: string } {
  const assets = refined.assets;
  const index = assets.findIndex((a) => a.id === assetId);
  if (index < 0) return { settled: [], note: 'already changed by an earlier correction' };
  const asset = assets[index];
  const w = sheet.image.width;
  const why = reply.reason ? `: ${reply.reason}` : '';

  if (reply.verdict === 'keep') {
    asset.name = asset.name === 'unidentified' && reply.name ? reply.name : (reply.name ?? asset.name);
    if (reply.category) asset.category = reply.category;
    asset.flags = asset.flags.filter((f) => f.severity === 'info' || f.code === 'touching-split');
    asset.flags.push({ code: 'confirmed', severity: 'info', message: `Confirmed by a second inspection${why}.` });
    asset.modelConfidence = Math.max(asset.modelConfidence, reply.confidence);
    if (asset.source === 'pixels') asset.source = 'reinspection';
    return { settled: [asset.id], note: `kept "${asset.name}"` };
  }

  if (reply.verdict === 'drop') {
    for (const i of asset.pixels) refined.owner[i] = -1;
    assets.splice(index, 1);
    reindexOwner(refined);
    refined.dropped.push({ name: asset.name, bbox: asset.rect, reason: `second inspection: not an asset${why}` });
    return { settled: [], note: `dropped "${asset.name}"` };
  }

  if (reply.verdict === 'merge') {
    const targets = reply.mergeWith
      .map((n) => view.numbered[n - 1])
      .map((id) => assets.find((a) => a.id === id))
      .filter((a): a is ExtractedAsset => !!a && a.kind !== 'tile');
    if (targets.length === 0) return { settled: [], note: 'merge named no usable neighbour, left as it was' };
    const pixels = Int32Array.from([...asset.pixels, ...targets.flatMap((t) => [...t.pixels])]).sort();
    const merged = makeAsset(
      {
        name: reply.name ?? asset.name,
        category: reply.category ?? asset.category,
        kind: asset.kind === 'frame' ? 'frame' : 'object',
        confidence: reply.confidence,
        source: 'reinspection',
        flags: [{ code: 'corrected', severity: 'info', message: `Merged with ${targets.map((t) => `"${t.name}"`).join(', ')} after a second inspection${why}.` }],
        animation: asset.animation,
      },
      pixels,
      w,
    );
    const gone = new Set([asset.id, ...targets.map((t) => t.id)]);
    refined.assets = assets.filter((a) => !gone.has(a.id));
    refined.assets.push(merged);
    reindexOwner(refined);
    return { settled: [merged.id], note: `merged "${asset.name}" with ${targets.length} neighbour(s)` };
  }

  // Split: the green pixels are shared among the parts the model boxed.
  const parts = reply.parts.filter((p) => asset.pixels.some((i) => inside(p.bbox, i, w)));
  if (parts.length < 2) return { settled: [], note: 'split gave fewer than two parts, left as it was' };
  const owners = competeForPixels(sheet.image, asset.pixels, parts.map((p) => p.bbox));
  const pieces = parts
    .map((p, n) => ({ p, pixels: Int32Array.from(asset.pixels.filter((_, k) => owners[k] === n)) }))
    .filter((x) => x.pixels.length > 0)
    .map(({ p, pixels }) =>
      makeAsset(
        {
          name: p.name,
          category: p.category,
          kind: asset.kind === 'tile' ? 'object' : asset.kind,
          confidence: reply.confidence,
          source: 'reinspection',
          modelBox: p.bbox,
          flags: [{ code: 'corrected', severity: 'info', message: `Split from "${asset.name}" after a second inspection${why}.` }],
        },
        pixels,
        w,
      ),
    );
  refined.assets = [...assets.slice(0, index), ...pieces, ...assets.slice(index + 1)];
  reindexOwner(refined);
  return { settled: pieces.map((p) => p.id), note: `split "${asset.name}" into ${pieces.length}` };
}

function inside(r: Rect, i: number, w: number): boolean {
  const x = i % w;
  const y = (i - x) / w;
  return x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
}

/** Rebuilds the pixel owner map after assets were added, removed or reordered. */
export function reindexOwner(refined: Refined): void {
  refined.owner.fill(-1);
  refined.assets.forEach((a, k) => {
    for (const i of a.pixels) refined.owner[i] = k;
  });
}

export type { Dropped };
