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

/** "Nature Park 1" belongs with "Nature Park 2". Path pages share one folder. */
export function packOf(name: string): string {
  if (/^paths \d+$/i.test(name)) return 'Paths';
  return name.replace(/ \d+$/, '') || name;
}

export function sameAsset(a: AssetRef, b: AssetRef): boolean {
  return a.tilesetId === b.tilesetId && a.rect.x === b.rect.x && a.rect.y === b.rect.y && a.rect.w === b.rect.w && a.rect.h === b.rect.h;
}

/** Packs in alphabetical order, Paths first because that is the ground set. */
export function packNames(sheetNames: string[]): string[] {
  const names = [...new Set(sheetNames.map(packOf))];
  names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const paths = names.indexOf('Paths');
  if (paths > 0) {
    names.splice(paths, 1);
    names.unshift('Paths');
  }
  return names;
}
