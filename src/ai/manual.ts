import { pixelBox } from './foreground';
import { anchorFor, makeAsset, type Refined, type SheetAnalysis } from './refine';
import type { AssetKind, Category, ExtractedAsset } from './types';
import type { Rect } from './image';

/**
 * Hand corrections, the fallback when the automatic result is wrong. They
 * keep the same guarantee as the pipeline: every drawn pixel belongs to at
 * most one asset, and every box is tight around its pixels.
 */

const manualFlag = (message: string) => ({ code: 'corrected' as const, severity: 'info' as const, message });

function settle(asset: ExtractedAsset): void {
  asset.source = 'manual';
  asset.confidence = 1;
  asset.modelConfidence = 1;
  asset.needsReview = false;
  asset.flags = asset.flags.filter((f) => f.severity === 'info');
}

function reown(refined: Refined): void {
  refined.owner.fill(-1);
  refined.assets.forEach((a, k) => {
    for (const i of a.pixels) refined.owner[i] = k;
  });
}

export function mergeSelected(sheet: SheetAnalysis, refined: Refined, ids: string[]): ExtractedAsset | null {
  const picked = refined.assets.filter((a) => ids.includes(a.id));
  if (picked.length < 2) return null;
  const pixels = Int32Array.from(picked.flatMap((a) => [...a.pixels])).sort();
  const first = picked[0];
  const merged = makeAsset(
    { name: first.name, category: first.category, kind: picked.some((a) => a.kind === 'frame') ? 'frame' : 'object', confidence: 1, source: 'manual' },
    pixels,
    sheet.image.width,
  );
  merged.flags.push(manualFlag(`Merged by hand from ${picked.length} pieces.`));
  settle(merged);
  const at = refined.assets.indexOf(first);
  refined.assets = refined.assets.filter((a) => !ids.includes(a.id));
  refined.assets.splice(Math.min(at, refined.assets.length), 0, merged);
  reown(refined);
  return merged;
}

export function deleteSelected(refined: Refined, ids: string[]): number {
  const before = refined.assets.length;
  for (const a of refined.assets) {
    if (ids.includes(a.id)) refined.dropped.push({ name: a.name, bbox: a.rect, reason: 'deleted by hand' });
  }
  refined.assets = refined.assets.filter((a) => !ids.includes(a.id));
  reown(refined);
  return before - refined.assets.length;
}

/**
 * A new asset from every drawn pixel inside a box drawn on the sheet,
 * taken from whatever owned them. Tiles lose the pixels too, so a box over
 * part of a tile carves it.
 */
export function claimBox(sheet: SheetAnalysis, refined: Refined, box: Rect, name = 'new asset', category: Category = 'other'): ExtractedAsset | null {
  const w = sheet.image.width;
  const taken: number[] = [];
  for (let y = Math.max(0, box.y); y < Math.min(sheet.image.height, box.y + box.h); y++) {
    for (let x = Math.max(0, box.x); x < Math.min(w, box.x + box.w); x++) {
      const i = y * w + x;
      if (sheet.fg.mask[i]) taken.push(i);
    }
  }
  if (taken.length === 0) return null;
  const set = new Set(taken);
  refined.assets = refined.assets.flatMap((a) => {
    if (!a.pixels.some((i) => set.has(i))) return [a];
    const left = a.pixels.filter((i) => !set.has(i));
    if (left.length === 0) return [];
    const rect = a.kind === 'tile' ? a.rect : pixelBox(left, w)!;
    return [{ ...a, pixels: left, rect, anchor: anchorFor(a.kind, rect) }];
  });
  const asset = makeAsset({ name, category, kind: 'object', confidence: 1, source: 'manual' }, Int32Array.from(taken), w);
  asset.flags.push(manualFlag('Drawn by hand.'));
  settle(asset);
  refined.assets.push(asset);
  reown(refined);
  return asset;
}

/** Turns an asset into a floor tile (its cell, untrimmed) or back into a placed object. */
export function setKind(sheet: SheetAnalysis, refined: Refined, id: string, kind: AssetKind): boolean {
  const a = refined.assets.find((x) => x.id === id);
  if (!a || a.kind === kind) return false;
  const w = sheet.image.width;
  if (kind === 'tile') {
    const cell = sheet.cell;
    const rect = a.rect;
    if (!cell || rect.w > cell || rect.h > cell) return false;
    const x = Math.floor(rect.x / cell) * cell;
    const y = Math.floor(rect.y / cell) * cell;
    if (rect.x + rect.w > x + cell || rect.y + rect.h > y + cell) return false;
    a.rect = { x, y, w: cell, h: cell };
  } else {
    a.rect = pixelBox(a.pixels, w)!;
  }
  a.kind = kind;
  a.anchor = anchorFor(kind, a.rect);
  settle(a);
  return true;
}

export function rename(refined: Refined, id: string, name: string, category?: Category): void {
  const a = refined.assets.find((x) => x.id === id);
  if (!a) return;
  if (name.trim()) a.name = name.trim().slice(0, 60);
  if (category) a.category = category;
}

/** Marks an asset as checked by a person, without changing it. */
export function approve(refined: Refined, id: string): void {
  const a = refined.assets.find((x) => x.id === id);
  if (!a) return;
  a.needsReview = false;
  a.flags.push({ code: 'confirmed', severity: 'info', message: 'Approved by hand.' });
}
