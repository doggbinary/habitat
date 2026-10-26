import type { Doc } from './doc';
import { EMPTY, flagsOf, indexOf, pack, tilesetOf } from './tiles';

/**
 * A floor page from an older project: the built-in "Floors" or "Paths"
 * pages, one whose picture is missing, or the generated "My floors" page.
 */
export function isFloorSheet(name: string): boolean {
  return /^(?:(?:paths|floors) \d+(?: \(missing\))?|my floors)$/i.test(name);
}

/**
 * Takes sheets out of a project and repairs everything that pointed at them.
 * Painted squares remember their sheet by position, so squares from a removed
 * sheet are cleared and squares from later sheets move down to match.
 * Objects, pins and folder entries from a removed sheet go with it.
 * Returns how many sheets were removed.
 */
export function dropTilesets(doc: Doc, shouldDrop: (name: string, index: number) => boolean): number {
  const remap: number[] = [];
  const removedIds = new Set<string>();
  let kept = 0;
  doc.tilesets.forEach((sheet, index) => {
    if (shouldDrop(sheet.name, index)) {
      remap.push(-1);
      removedIds.add(sheet.id);
    } else {
      remap.push(kept++);
    }
  });
  if (removedIds.size === 0) return 0;

  doc.tilesets = doc.tilesets.filter((sheet) => !removedIds.has(sheet.id));
  for (const layer of doc.layers) {
    if (layer.kind === 'objects') {
      layer.objects = layer.objects.filter((obj) => !removedIds.has(obj.tilesetId));
      continue;
    }
    if (layer.kind !== 'tiles') continue;
    const data = layer.data;
    for (let i = 0; i < data.length; i++) {
      const tile = data[i];
      if (tile === EMPTY) continue;
      const to = remap[tilesetOf(tile)] ?? -1;
      data[i] = to === -1 ? EMPTY : pack(to, indexOf(tile), flagsOf(tile));
    }
  }
  doc.pins = (doc.pins ?? []).filter((pin) => !removedIds.has(pin.tilesetId));
  for (const folder of doc.folders ?? []) {
    folder.assets = folder.assets.filter((asset) => !removedIds.has(asset.tilesetId));
  }
  return removedIds.size;
}
