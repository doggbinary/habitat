import { describe, expect, it } from 'vitest';
import {
  ART_TILE,
  checkGrid,
  createDoc,
  createObjectLayer,
  exactPlacement,
  fitPlacement,
  pictureMapSize,
  rescaleGrid,
  retileSheet,
  upgradeTileSize,
  type ImageLayer,
  type TileLayer,
} from './doc';
import { pack } from './tiles';
import { fakeObject, fakeTileset } from '../test-support/fakes';

describe('maps made from a picture', () => {
  it('is 32 squares wide and as tall as the picture shape needs', () => {
    expect(pictureMapSize(1024, 768)).toEqual({ width: 32, height: 24 });
    expect(pictureMapSize(1000, 1000)).toEqual({ width: 32, height: 32 });
  });

  it('fills the map exactly, so painted squares sit on grid squares', () => {
    const doc = createDoc(32, 24, ART_TILE);
    expect(exactPlacement(doc)).toEqual({ x: 0, y: 0, w: 32 * 48, h: 24 * 48 });
    // A picture of the same shape is fitted edge to edge, not letterboxed.
    expect(fitPlacement(doc, 1024, 768)).toEqual(exactPlacement(doc));
  });
});

describe('upgrading a 16 px map', () => {
  it('moves onto the library art size and scales what sits on it', () => {
    const doc = createDoc(4, 4, 16);
    doc.tilesets = [fakeTileset('lib', 48)];
    const objects = createObjectLayer();
    objects.objects.push(fakeObject({ x: 40, y: 20, scale: 1 / 3 }));
    const image: ImageLayer = {
      kind: 'image',
      id: 'img',
      name: 'ref',
      visible: true,
      locked: false,
      opacity: 1,
      src: '',
      image: null,
      x: 2,
      y: 4,
      w: 64,
      h: 32,
      naturalW: 64,
      naturalH: 32,
    };
    doc.layers.push(objects, image);

    expect(upgradeTileSize(doc)).toBe(true);
    expect(doc.tileSize).toBe(48);
    expect(doc.width).toBe(4);
    expect(objects.objects[0]).toMatchObject({ x: 120, y: 60, scale: 1 });
    expect(image).toMatchObject({ x: 6, y: 12, w: 192, h: 96 });
  });

  it('leaves maps that already match, or have no library art', () => {
    expect(upgradeTileSize(createDoc(4, 4, 48))).toBe(false);
    expect(upgradeTileSize(createDoc(4, 4, 16))).toBe(false);
  });

  it('finds 32 px art stretched on a 48 px map and offers 32', () => {
    const doc = createDoc(4, 4, 48);
    doc.tilesets = [fakeTileset('fantasy', 32), fakeTileset('modern', 48)];
    doc.tilesets[0].name = 'Pixel Fantasy Town 1';
    const tiles = doc.layers[0] as TileLayer;
    tiles.data.fill(pack(0, 1));
    tiles.data[0] = pack(1, 1);
    const objects = createObjectLayer();
    objects.objects = [fakeObject({ tilesetId: 'fantasy', x: 40, y: 64 })];
    doc.layers.push(objects);

    const check = checkGrid(doc);
    expect(check.mismatched.map((m) => m.name)).toEqual(['Pixel Fantasy Town 1']);
    expect(check.suggested).toBe(32);
    // 16 x 32 centred on (40, 64): corner (32, 48), not on a 48 px line.
    expect(check.offGrid).toBe(1);
  });

  it('does not count art at exactly half or double size as uneven', () => {
    const doc = createDoc(4, 4, 32);
    doc.tilesets = [fakeTileset('town', 32), fakeTileset('buildings', 64), fakeTileset('modern', 48)];
    const objects = createObjectLayer();
    objects.objects = [
      fakeObject({ tilesetId: 'buildings', x: 32, y: 32, rect: { x: 0, y: 0, w: 64, h: 64 } }),
      fakeObject({ tilesetId: 'buildings', x: 32, y: 32, rect: { x: 0, y: 0, w: 64, h: 64 } }),
    ];
    doc.layers.push(objects);
    (doc.layers[0] as TileLayer).data[0] = pack(2, 1);
    const check = checkGrid(doc);
    expect(check.mismatched.map((m) => m.tileW)).toEqual([48]);
    // 64 px buildings are the most used, but 32 already shows them evenly.
    expect(check.suggested).toBeNull();
  });

  it('reads a page of objects at a new square size and shrinks what was placed from it', () => {
    const doc = createDoc(10, 10, 32);
    doc.tilesets = [fakeTileset('buildings', 32)];
    const objects = createObjectLayer();
    // A 64 x 64 building drawn at 1x on a 32 px map: two squares, corner at (32, 64).
    objects.objects = [fakeObject({ tilesetId: 'buildings', rect: { x: 0, y: 0, w: 64, h: 64 }, x: 64, y: 96 })];
    doc.layers.push(objects);

    expect(retileSheet(doc, 0, 64)).toBe(true);
    expect(doc.tilesets[0].tileW).toBe(64);
    const obj = objects.objects[0];
    expect(obj.scale).toBe(0.5);
    expect(obj.x - 16).toBe(32);
    expect(obj.y - 16).toBe(64);
  });

  it('leaves a page alone when squares are painted from it', () => {
    const doc = createDoc(4, 4, 32);
    doc.tilesets = [fakeTileset('ground', 32)];
    (doc.layers[0] as TileLayer).data[0] = pack(0, 2);
    expect(retileSheet(doc, 0, 64)).toBe(false);
    expect(doc.tilesets[0].tileW).toBe(32);
  });

  it('switches the grid and scales objects, doors and pictures with it, keeping every cell', () => {
    const doc = createDoc(4, 4, 48);
    const tiles = doc.layers[0] as TileLayer;
    tiles.data[5] = pack(0, 3);
    const objects = createObjectLayer();
    objects.objects = [fakeObject({ x: 72, y: 96, scale: 1.5, door: { x: 120, y: 24 } })];
    doc.layers.push(objects);

    rescaleGrid(doc, 32);

    expect(doc.tileSize).toBe(32);
    expect(tiles.data[5]).toBe(pack(0, 3));
    expect(objects.objects[0]).toMatchObject({ x: 48, y: 64, scale: 1, door: { x: 80, y: 16 } });
  });

  it('leaves a 16 px map alone when its own pack is drawn at 16 px, even beside 48 px packs', () => {
    const doc = createDoc(4, 4, 16);
    doc.tilesets = [fakeTileset('ninja', 16), fakeTileset('modern', 48)];
    expect(upgradeTileSize(doc)).toBe(false);
    expect(doc.tileSize).toBe(16);
  });
});
