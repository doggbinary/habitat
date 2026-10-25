import type { Doc } from './doc';
import { EMPTY, flagsOf, indexOf, pack, tilesetOf } from './tiles';

/** What the merge needs to know about a sheet, without touching its pixels. */
export interface PathSheet {
  id: string;
  name: string;
  src: string;
  /** A small grayscale copy of the picture, or null when it will not decode. */
  thumb: Uint8Array | null;
}

/** A floor page ("Paths" in older projects), including one whose picture is missing. */
export function isPathsSheet(name: string): boolean {
  return /^(?:paths|floors) \d+(?: \(missing\))?$/i.test(name);
}

/** Two ground pages drawn the same way, allowing for a pack's small retouches. */
export function samePicture(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff += Math.abs(a[i] - b[i]);
  return diff / a.length < 8;
}

/**
 * Which ground pages are repeats, and which page each one folds into.
 *
 * Packs ship the same floors over and over, and early versions of the app
 * saved one page per pack, so a project can hold dozens of copies. Pages
 * whose picture is gone fold into the first page kept, because the picture
 * they pointed at is the one that survived.
 *
 * Keyed by index, valued by the id of the page to keep: indices shift as
 * pages are taken out, ids do not.
 */
export function pathMergePlan(sheets: PathSheet[]): Map<number, string> {
  const seen: { thumb: Uint8Array; id: string }[] = [];
  const bySrc = new Map<string, string>();
  const plan = new Map<number, string>();
  const dead: number[] = [];

  sheets.forEach((sheet, index) => {
    if (!isPathsSheet(sheet.name)) return;
    if (!sheet.thumb) {
      dead.push(index);
      return;
    }
    const sameUrl = bySrc.get(sheet.src);
    if (sameUrl !== undefined) {
      plan.set(index, sameUrl);
      return;
    }
    const kept = seen.find((item) => samePicture(item.thumb, sheet.thumb!));
    if (!kept) {
      seen.push({ thumb: sheet.thumb, id: sheet.id });
      bySrc.set(sheet.src, sheet.id);
    } else {
      plan.set(index, kept.id);
    }
  });

  const fallback = seen[0]?.id;
  // With nothing left to fold into, the pages stay as they are.
  if (!fallback) return new Map();
  for (const index of dead) plan.set(index, fallback);
  return plan;
}

/**
 * Removes the repeated sheets and points everything that used them at the
 * page that was kept: painted tiles, placed assets, pins and folders.
 */
export function applyTilesetMerge(doc: Doc, plan: Map<number, string>): void {
  // Highest index first, so the indices still to be handled stay valid.
  const drop = [...plan.keys()].sort((a, b) => b - a);
  for (const index of drop) {
    const removed = doc.tilesets[index];
    const keptSheet = doc.tilesets.find((sheet) => sheet.id === plan.get(index));
    if (!removed || !keptSheet || keptSheet === removed) continue;
    doc.tilesets.splice(index, 1);
    const keep = doc.tilesets.indexOf(keptSheet);

    for (const layer of doc.layers) {
      if (layer.kind === 'objects') {
        for (const obj of layer.objects) if (obj.tilesetId === removed.id) obj.tilesetId = keptSheet.id;
        continue;
      }
      if (layer.kind !== 'tiles') continue;
      const data = layer.data;
      for (let i = 0; i < data.length; i++) {
        const tile = data[i];
        if (tile === EMPTY) continue;
        const owner = tilesetOf(tile);
        if (owner === index) data[i] = pack(keep, indexOf(tile), flagsOf(tile));
        else if (owner > index) data[i] = pack(owner - 1, indexOf(tile), flagsOf(tile));
      }
    }

    for (const pin of doc.pins ?? []) if (pin.tilesetId === removed.id) pin.tilesetId = keptSheet.id;
    for (const folder of doc.folders ?? []) {
      for (const asset of folder.assets) if (asset.tilesetId === removed.id) asset.tilesetId = keptSheet.id;
    }
  }

  let number = 1;
  for (const sheet of doc.tilesets) {
    if (isPathsSheet(sheet.name)) sheet.name = `Floors ${number++}`;
  }
}
