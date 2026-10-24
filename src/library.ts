/**
 * Which pictures in a tileset pack are whole objects (a lamp, a house, a
 * sofa) rather than a ground or wall grid. Packs ship both kinds of page
 * under one folder. Duplicate folders named like "office(1)" are skipped.
 */
export function isLibrarySheet(folders: string[], file: string): boolean {
  if (folders.some((folder) => /\(\d+\)$/.test(folder))) return false;
  return /^tile-b-\d+\.png$/i.test(file) || /^\d+\.png$/i.test(file);
}

/** "Nature Park" + "tile-B-01.png" becomes "Nature Park 1". */
export function librarySheetName(folders: string[], file: string): string {
  const base = file.replace(/\.png$/i, '');
  const page = /^tile-b-\d+$/i.test(base) ? String(Number(base.replace(/^tile-b-/i, ''))) : base;
  return `${folders.join(' ')} ${page}`;
}

/**
 * A page that is one finished picture, such as a whole street, rather than
 * separate objects. One asset covering most of the sheet is that picture.
 */
export function isSampleMap(imgW: number, imgH: number, assets: { w: number; h: number }[]): boolean {
  const sheet = imgW * imgH;
  if (sheet === 0 || assets.length === 0) return false;
  const biggest = assets.reduce((max, asset) => Math.max(max, asset.w * asset.h), 0);
  return biggest / sheet > 0.45;
}

export interface LibraryEntry {
  name: string;
  /** Path relative to the site, already safe to fetch. */
  url: string;
}
