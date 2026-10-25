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

/** "Nature Park 1" belongs with "Nature Park 2". Floor pages share one pack. */
export function packOf(name: string): string {
  if (/^(?:(?:paths|floors) \d+|my floors)$/i.test(name)) return 'Floors';
  return name.replace(/ \d+$/, '') || name;
}

export function sameAsset(a: AssetRef, b: AssetRef): boolean {
  return a.tilesetId === b.tilesetId && a.rect.x === b.rect.x && a.rect.y === b.rect.y && a.rect.w === b.rect.w && a.rect.h === b.rect.h;
}

/** Packs in alphabetical order, Floors first because every map starts there. */
export function packNames(sheetNames: string[]): string[] {
  const names = [...new Set(sheetNames.map(packOf))];
  names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const floors = names.indexOf('Floors');
  if (floors > 0) {
    names.splice(floors, 1);
    names.unshift('Floors');
  }
  return names;
}
