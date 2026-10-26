import { describe, expect, it } from 'vitest';
import { createDoc, type TileLayer } from './doc';
import { dropTilesets, isFloorSheet } from './path-merge';
import { EMPTY, indexOf, pack, tilesetOf } from './tiles';
import { fakeObject, fakeTileset } from '../test-support/fakes';

describe('taking sheets out of a project', () => {
  it('knows the old floor pages, including missing ones and My floors', () => {
    expect(isFloorSheet('Floors 3')).toBe(true);
    expect(isFloorSheet('Paths 12')).toBe(true);
    expect(isFloorSheet('Paths 7 (missing)')).toBe(true);
    expect(isFloorSheet('My floors')).toBe(true);
    expect(isFloorSheet('Pixel Fantasy Town 1')).toBe(false);
  });

  it('keeps squares from later sheets pointing at the same picture', () => {
    const doc = createDoc(4, 1, 16);
    doc.tilesets = [fakeTileset('floors'), fakeTileset('town'), fakeTileset('more-floors'), fakeTileset('fence')];
    doc.tilesets[0].name = 'Floors 1';
    doc.tilesets[1].name = 'Pixel Fantasy Town 1';
    doc.tilesets[2].name = 'Floors 2';
    doc.tilesets[3].name = 'Pixel Fantasy Town 2';
    const layer = doc.layers[0] as TileLayer;
    layer.data[0] = pack(0, 5);
    layer.data[1] = pack(1, 7);
    layer.data[2] = pack(2, 5);
    layer.data[3] = pack(3, 9);

    expect(dropTilesets(doc, isFloorSheet)).toBe(2);

    expect(doc.tilesets.map((s) => s.id)).toEqual(['town', 'fence']);
    expect(layer.data[0]).toBe(EMPTY);
    expect(layer.data[2]).toBe(EMPTY);
    expect(doc.tilesets[tilesetOf(layer.data[1])].id).toBe('town');
    expect(indexOf(layer.data[1])).toBe(7);
    expect(doc.tilesets[tilesetOf(layer.data[3])].id).toBe('fence');
    expect(indexOf(layer.data[3])).toBe(9);
  });

  it('takes away objects, pins and folder entries from a removed sheet', () => {
    const doc = createDoc(4, 1, 16);
    doc.tilesets = [fakeTileset('gone'), fakeTileset('kept')];
    doc.tilesets[0].name = 'My floors';
    doc.tilesets[1].name = 'Town 1';
    doc.layers.push({
      id: 'objs',
      kind: 'objects',
      name: 'Objects',
      visible: true,
      locked: false,
      opacity: 1,
      objects: [fakeObject({ tilesetId: 'gone' }), fakeObject({ tilesetId: 'kept' })],
    });
    const rect = { x: 0, y: 0, w: 16, h: 16 };
    doc.pins = [{ tilesetId: 'gone', rect }, { tilesetId: 'kept', rect }];
    doc.folders = [{ id: 'f', name: 'Mine', assets: [{ tilesetId: 'gone', rect }] }];

    dropTilesets(doc, isFloorSheet);

    const objects = doc.layers[1];
    expect(objects.kind === 'objects' && objects.objects.map((o) => o.tilesetId)).toEqual(['kept']);
    expect(doc.pins.map((p) => p.tilesetId)).toEqual(['kept']);
    expect(doc.folders[0].assets).toEqual([]);
  });

  it('changes nothing when no sheet matches', () => {
    const doc = createDoc(2, 1, 16);
    doc.tilesets = [fakeTileset('a')];
    doc.tilesets[0].name = 'Town 1';
    (doc.layers[0] as TileLayer).data[0] = pack(0, 3);
    expect(dropTilesets(doc, isFloorSheet)).toBe(0);
    expect((doc.layers[0] as TileLayer).data[0]).toBe(pack(0, 3));
  });
});
