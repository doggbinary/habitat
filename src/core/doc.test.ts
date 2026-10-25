import { describe, expect, it } from 'vitest';
import {
  ART_TILE,
  createDoc,
  createObjectLayer,
  exactPlacement,
  fitPlacement,
  pictureMapSize,
  upgradeTileSize,
  type ImageLayer,
} from './doc';
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
});
