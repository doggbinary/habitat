import { pathShape } from './autotile';
import { cellIndex, inBounds, isTileLayer, type Doc, type TileLayer } from './doc';
import { EMPTY, flagsOf, indexOf, pack, tilesetOf, type PackedTile } from './tiles';

/**
 * The piece a path square should be, given what is painted around it, or
 * null when the square is not a path. Only the ground type (the row) of the
 * neighbours matters, never which piece they currently show, so a whole
 * layer can be redone in place.
 */
export function pathPieceAt(doc: Doc, layer: TileLayer, x: number, y: number): PackedTile | null {
  const tile = layer.data[cellIndex(doc, x, y)];
  if (tile === EMPTY) return null;
  const sheet = tilesetOf(tile);
  const stride = doc.tilesets[sheet]?.pathStride;
  if (!stride) return null;
  const row = Math.floor(indexOf(tile) / stride);
  const same = (dx: number, dy: number) => {
    if (!inBounds(doc, x + dx, y + dy)) return false;
    const other = layer.data[cellIndex(doc, x + dx, y + dy)];
    return other !== EMPTY && tilesetOf(other) === sheet && Math.floor(indexOf(other) / stride) === row;
  };
  const shape = pathShape({
    n: same(0, -1),
    ne: same(1, -1),
    e: same(1, 0),
    se: same(1, 1),
    s: same(0, 1),
    sw: same(-1, 1),
    w: same(-1, 0),
    nw: same(-1, -1),
  });
  return pack(sheet, row * stride + shape, flagsOf(tile));
}

/** Gives every painted path square on every layer the piece that meets its neighbours. */
export function repieceAllPaths(doc: Doc): void {
  for (const layer of doc.layers) {
    if (!isTileLayer(layer)) continue;
    for (let y = 0; y < doc.height; y++) {
      for (let x = 0; x < doc.width; x++) {
        const piece = pathPieceAt(doc, layer, x, y);
        if (piece !== null) layer.data[cellIndex(doc, x, y)] = piece;
      }
    }
  }
}

/**
 * Moves painted squares of one path sheet from an older piece layout to the
 * current one. Each keeps its ground type; the piece is chosen again after.
 */
export function restridePaths(doc: Doc, sheetIndex: number, oldStride: number, newStride: number): void {
  if (oldStride === newStride) return;
  for (const layer of doc.layers) {
    if (!isTileLayer(layer)) continue;
    for (let i = 0; i < layer.data.length; i++) {
      const tile = layer.data[i];
      if (tile === EMPTY || tilesetOf(tile) !== sheetIndex) continue;
      const row = Math.floor(indexOf(tile) / oldStride);
      layer.data[i] = pack(sheetIndex, row * newStride, flagsOf(tile));
    }
  }
}
