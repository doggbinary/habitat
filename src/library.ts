/**
 * Which pictures in a tileset pack are whole objects (a lamp, a house, a
 * sofa) rather than a ground or wall grid. Packs ship both kinds of page
 * under one folder. Duplicate folders named like "office(1)" are skipped.
 */
export function isLibrarySheet(folders: string[], file: string): boolean {
  if (folders.some((folder) => /\(\d+\)$/.test(folder))) return false;
  return /^tile-b-\d+\.png$/i.test(file) || /^\d+\.png$/i.test(file);
}

export function libraryUrl(folders: string[], file: string): string {
  return `library/${[...folders, file].map((part) => encodeURIComponent(part)).join('/')}`;
}

export interface LibraryFile {
  folders: string[];
  file: string;
  /** Square size the pack was drawn on, when it is not 48 px. */
  tile?: number;
  /** The page holds only whole objects. */
  props?: boolean;
  /** Exact picture boxes, when the page was laid out by hand. */
  assets?: { x: number; y: number; w: number; h: number }[];
}

/** Object pages, named after their pack and listed in pack order. */
export function buildLibraryEntries(files: LibraryFile[]): LibraryEntry[] {
  const objects: LibraryEntry[] = [];
  for (const item of files) {
    if (!isLibrarySheet(item.folders, item.file)) continue;
    objects.push({
      name: librarySheetName(item.folders, item.file),
      url: libraryUrl(item.folders, item.file),
      ...(item.tile ? { tile: item.tile } : {}),
      ...(item.props ? { props: true } : {}),
      ...(item.assets?.length ? { assets: item.assets } : {}),
    });
  }
  objects.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return objects;
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
  if (sheet === 0) return false;
  if (assets.length === 0) return true;
  const biggest = assets.reduce((max, asset) => Math.max(max, asset.w * asset.h), 0);
  // A finished picture is the page. A long counter on a furniture page can
  // also be large, but that page still has a normal library of other props.
  return biggest / sheet > 0.45 && assets.length <= 4;
}

export interface LibraryEntry {
  name: string;
  /** Path relative to the site, already safe to fetch. */
  url: string;
  /** Square size the page was drawn on. Packs without it use 48 px. */
  tile?: number;
  /** A page of whole objects, with no floor squares to find on it. */
  props?: boolean;
  /** Exact boxes of the pictures on a page that was laid out by hand, so nothing is guessed. */
  assets?: { x: number; y: number; w: number; h: number }[];
}
