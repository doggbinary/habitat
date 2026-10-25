import { describe, expect, it } from 'vitest';
import { createDoc, type TileLayer } from './doc';
import { applyTilesetMerge, isPathsSheet, pathMergePlan, type PathSheet } from './path-merge';
import { pack, tilesetOf } from './tiles';
import { fakeObject, fakeTileset } from '../test-support/fakes';

const grey = (shade: number) => new Uint8Array(12).fill(shade);

const sheet = (id: string, name: string, src: string, thumb: Uint8Array | null): PathSheet => ({
  id,
  name,
  src,
  thumb,
});

describe('merging repeated ground pages', () => {
  it('knows a ground page, even one whose picture has gone', () => {
    expect(isPathsSheet('Paths 12')).toBe(true);
    expect(isPathsSheet('Paths 7 (missing)')).toBe(true);
    expect(isPathsSheet('Nature Park 1')).toBe(false);
  });

  it('folds pages of the same floors into the first one', () => {
    const plan = pathMergePlan([
      sheet('a', 'Paths 1', 'one.png', grey(100)),
      sheet('b', 'Paths 2', 'two.png', grey(101)),
      sheet('c', 'Paths 3', 'three.png', grey(200)),
    ]);
    expect([...plan]).toEqual([[1, 'a']]);
  });

  it('folds a page whose picture no longer loads into the page that survived', () => {
    const plan = pathMergePlan([
      sheet('dead', 'Paths 1 (missing)', 'gone.png', null),
      sheet('alive', 'Paths 2', 'kept.png', grey(100)),
    ]);
    expect(plan.get(0)).toBe('alive');
  });

  it('leaves object pages alone', () => {
    const plan = pathMergePlan([
      sheet('a', 'Nature Park 1', 'one.png', grey(100)),
      sheet('b', 'Nature Park 2', 'two.png', grey(100)),
    ]);
    expect(plan.size).toBe(0);
  });

  it('repoints painted tiles at the page that was kept', () => {
    const doc = createDoc(4, 1, 16);
    doc.tilesets = [fakeTileset('keep'), fakeTileset('copy'), fakeTileset('props')];
    doc.tilesets[0].name = 'Paths 1';
    doc.tilesets[1].name = 'Paths 2';
    doc.tilesets[2].name = 'Nature Park 1';
    const layer = doc.layers[0] as TileLayer;
    layer.data[0] = pack(0, 5);
    layer.data[1] = pack(1, 5);
    layer.data[2] = pack(2, 5);

    applyTilesetMerge(doc, new Map([[1, 'keep']]));

    expect(doc.tilesets.map((s) => s.id)).toEqual(['keep', 'props']);
    expect(tilesetOf(layer.data[0])).toBe(0);
    expect(tilesetOf(layer.data[1])).toBe(0);
    // The object page slid down one place, and its tiles followed.
    expect(tilesetOf(layer.data[2])).toBe(1);
  });

  it('takes out many copies at once and numbers what is left from one', () => {
    const doc = createDoc(4, 1, 16);
    doc.tilesets = ['a', 'b', 'c', 'd'].map((id) => fakeTileset(id));
    doc.tilesets.forEach((s, i) => {
      s.name = `Paths ${i + 1}`;
    });
    const layer = doc.layers[0] as TileLayer;
    layer.data[0] = pack(3, 2);

    applyTilesetMerge(doc, new Map([[1, 'a'], [2, 'a'], [3, 'a']]));

    expect(doc.tilesets.map((s) => s.name)).toEqual(['Floors 1']);
    expect(tilesetOf(layer.data[0])).toBe(0);
  });

  it('moves placed assets onto the page that was kept', () => {
    const doc = createDoc(4, 1, 16);
    doc.tilesets = [fakeTileset('keep'), fakeTileset('copy')];
    doc.tilesets[0].name = 'Paths 1';
    doc.tilesets[1].name = 'Paths 2';
    doc.layers.push({
      id: 'objs',
      kind: 'objects',
      name: 'Objects',
      visible: true,
      locked: false,
      opacity: 1,
      objects: [fakeObject({ tilesetId: 'copy' })],
    });

    applyTilesetMerge(doc, new Map([[1, 'keep']]));

    const objects = doc.layers[1];
    expect(objects.kind === 'objects' && objects.objects[0].tilesetId).toBe('keep');
  });
});
