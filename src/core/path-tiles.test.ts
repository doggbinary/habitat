import { describe, expect, it } from 'vitest';
import { PATH_PREVIEW, PATH_STRIDE } from './autotile';
import { cellIndex, createDoc, type TileLayer } from './doc';
import { pathPieceAt, repieceAllPaths, restridePaths } from './path-tiles';
import { EMPTY, indexOf, pack } from './tiles';
import { fakeTileset } from '../test-support/fakes';

function pathDoc() {
  const doc = createDoc(5, 5, 48);
  const sheet = fakeTileset('paths', 48);
  sheet.pathStride = PATH_STRIDE;
  sheet.count = PATH_STRIDE * 4;
  doc.tilesets = [sheet];
  return { doc, layer: doc.layers[0] as TileLayer };
}

const piece = (doc: ReturnType<typeof pathDoc>['doc'], layer: TileLayer, x: number, y: number) =>
  indexOf(layer.data[cellIndex(doc, x, y)]) % PATH_STRIDE;

describe('path squares on the map', () => {
  it('joins a T-junction with inner corners', () => {
    const { doc, layer } = pathDoc();
    for (const [x, y] of [[0, 1], [1, 1], [2, 1], [1, 2], [1, 3]]) layer.data[cellIndex(doc, x, y)] = pack(0, PATH_PREVIEW);
    repieceAllPaths(doc);
    expect(piece(doc, layer, 1, 1)).toBe(23);
    expect(piece(doc, layer, 1, 3)).not.toBe(PATH_PREVIEW);
  });

  it('only joins squares of the same ground type', () => {
    const { doc, layer } = pathDoc();
    layer.data[cellIndex(doc, 0, 0)] = pack(0, 0);
    layer.data[cellIndex(doc, 1, 0)] = pack(0, PATH_STRIDE);
    expect(indexOf(pathPieceAt(doc, layer, 0, 0)!) % PATH_STRIDE).toBe(PATH_PREVIEW);
  });

  it('moves maps painted with the old 15-piece layout onto the new pieces', () => {
    const { doc, layer } = pathDoc();
    // Ground type 2, old piece 9, in a horizontal run of three.
    for (const x of [0, 1, 2]) layer.data[cellIndex(doc, x, 2)] = pack(0, 2 * 15 + 9);
    restridePaths(doc, 0, 15, PATH_STRIDE);
    repieceAllPaths(doc);
    for (const x of [0, 1, 2]) {
      expect(Math.floor(indexOf(layer.data[cellIndex(doc, x, 2)]) / PATH_STRIDE)).toBe(2);
    }
    expect(piece(doc, layer, 1, 2)).toBe(33);
    expect(layer.data[cellIndex(doc, 4, 4)]).toBe(EMPTY);
  });
});
