/**
 * Which pictures in a tileset pack are whole objects (a lamp, a house, a
 * sofa) rather than a ground or wall grid. Packs ship both kinds of page
 * under one folder. Duplicate folders named like "office(1)" are skipped.
 */
export function isLibrarySheet(folders: string[], file: string): boolean {
  if (folders.some((folder) => /\(\d+\)$/.test(folder))) return false;
  return /^tile-b-\d+\.png$/i.test(file) || /^\d+\.png$/i.test(file);
}

/** Floor pages (RPG Maker A2) are the road, grass, gravel and brick squares. */
export function isPathSheet(folders: string[], file: string): boolean {
  if (folders.some((folder) => /\(\d+\)$/.test(folder))) return false;
  return /(?:^|[^a-z0-9])a2(?:[^0-9]|$)/i.test(file);
}

export function libraryUrl(folders: string[], file: string): string {
  return `library/${[...folders, file].map((part) => encodeURIComponent(part)).join('/')}`;
}

export interface LibraryFile {
  folders: string[];
  file: string;
  /**
   * Identity of the picture. Path pages with the same id are the same sheet
   * copied into several packs, and only the first is kept.
   */
  id?: string;
}

/**
 * Object pages keep their pack names. Packs repeat the same floor page, so
 * each distinct one is kept once as Floors 1, Floors 2, and so on, listed
 * first.
 */
export function buildLibraryEntries(files: LibraryFile[]): LibraryEntry[] {
  const objects: LibraryEntry[] = [];
  const paths: LibraryEntry[] = [];
  const seenPath = new Set<string>();
  for (const item of files) {
    const url = libraryUrl(item.folders, item.file);
    if (isLibrarySheet(item.folders, item.file)) objects.push({ name: librarySheetName(item.folders, item.file), url });
    else if (isPathSheet(item.folders, item.file)) {
      const id = item.id ?? url;
      if (seenPath.has(id)) continue;
      seenPath.add(id);
      paths.push({ name: url, url });
    }
  }
  objects.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  paths.sort((a, b) => a.url.localeCompare(b.url, undefined, { numeric: true }));
  paths.forEach((entry, index) => {
    entry.name = `Floors ${index + 1}`;
  });
  return [...paths, ...objects];
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
}
