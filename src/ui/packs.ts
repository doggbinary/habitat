import type { AssetRect } from '../core/doc';

/** A single sticker, remembered by the sheet it lives on and its rectangle. */
export interface AssetRef {
  tilesetId: string;
  rect: AssetRect;
}

export interface AssetFolder {
  id: string;
  name: string;
  assets: AssetRef[];
}

/** "Nature Park 1" belongs with "Nature Park 2", and "Ninja Adventure — Water" with "Ninja Adventure — Houses". */
export function packOf(name: string): string {
  const titled = name.indexOf(' — ');
  if (titled > 0) return name.slice(0, titled);
  return name.replace(/ \d+$/, '') || name;
}

export function sameAsset(a: AssetRef, b: AssetRef): boolean {
  return a.tilesetId === b.tilesetId && a.rect.x === b.rect.x && a.rect.y === b.rect.y && a.rect.w === b.rect.w && a.rect.h === b.rect.h;
}

/** Packs in alphabetical order, with pinned packs first in the order they were pinned. */
export function packNames(sheetNames: string[], pinned: string[] = []): string[] {
  const names = [...new Set(sheetNames.map(packOf))];
  names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const first = pinned.filter((name) => names.includes(name));
  return [...first, ...names.filter((name) => !first.includes(name))];
}
