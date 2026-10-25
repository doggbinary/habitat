import { describe, expect, it } from 'vitest';
import { createCharacter } from '../character/model';
import { createDoc, createObjectLayer, type ObjectLayer, type TileLayer } from '../core/doc';
import { EMPTY, pack } from '../core/tiles';
import { fakeObject, fakeTileset } from '../test-support/fakes';
import { buildMapJson } from './export';
import {
  deserializeCharacters,
  deserializeProject,
  isProjectFile,
  serializeProject,
  type SerializedProject,
} from './project';

/** Round-trips through JSON text, exactly as saving to a file does. */
const throughJson = (p: SerializedProject): SerializedProject => JSON.parse(JSON.stringify(p));

describe('saving and loading a project', () => {
  it('keeps every painted tile, including transforms', async () => {
    const doc = createDoc(5, 4, 16);
    const tiles = doc.layers[0] as TileLayer;
    tiles.data[0] = pack(0, 3);
    tiles.data[7] = pack(2, 511, 6);
    tiles.collider = true;

    const loaded = await deserializeProject(throughJson(serializeProject(doc)));
    const back = loaded.layers[0] as TileLayer;
    expect([...back.data]).toEqual([...tiles.data]);
    expect(back.collider).toBe(true);
  });

  it('keeps placed objects exactly, in their front-to-back order', async () => {
    const doc = createDoc(5, 4, 16);
    const objects = createObjectLayer('Props');
    objects.objects = [
      fakeObject({ id: 'tree', x: 10, y: 20, scale: 1.5, rotation: 3, flipX: true }),
      fakeObject({ id: 'rock', hueShift: 42, saturation: 0.5, brightness: 1.2 }),
    ];
    doc.layers.push(objects);

    const loaded = await deserializeProject(throughJson(serializeProject(doc)));
    const back = loaded.layers[1] as ObjectLayer;
    expect(back.kind).toBe('objects');
    expect(back.name).toBe('Props');
    expect(back.objects).toEqual(objects.objects);
  });

  it('remembers which assets are ground, so the Ground page survives a reload', async () => {
    const doc = createDoc(2, 2, 16);
    const sheet = fakeTileset('a');
    sheet.assets = [
      { x: 0, y: 0, w: 16, h: 16 },
      { x: 16, y: 0, w: 16, h: 16 },
      { x: 32, y: 0, w: 16, h: 32 },
    ];
    sheet.groundAssets = [0, 1];
    doc.tilesets = [sheet];

    const loaded = await deserializeProject(throughJson(serializeProject(doc)));
    expect(loaded.tilesets[0].groundAssets).toEqual([0, 1]);
  });

  it('loads a damaged object with neutral values instead of failing', async () => {
    const doc = createDoc(2, 2, 16);
    doc.layers.push(createObjectLayer());
    const saved = throughJson(serializeProject(doc));
    const layer = saved.layers[1] as { objects: unknown[] };
    layer.objects = [{ tilesetId: 'a', x: 'oops', rotation: 7, rect: { x: 1, y: 2 } }];

    const loaded = await deserializeProject(saved);
    const [obj] = (loaded.layers[1] as ObjectLayer).objects;
    expect(obj.x).toBe(0);
    expect(obj.rotation).toBe(3);
    expect(obj.scale).toBe(1);
    expect(obj.rect).toEqual({ x: 1, y: 2, w: 1, h: 1 });
    expect(obj.id).toBeTruthy();
  });

  it('opens version 1 files, which had no layer kinds', async () => {
    const doc = createDoc(2, 2, 16);
    const saved = throughJson(serializeProject(doc));
    delete (saved.layers[0] as { kind?: string }).kind;
    saved.version = 1;

    const loaded = await deserializeProject(saved);
    expect(loaded.layers[0].kind).toBe('tiles');
  });

  it('pads a layer whose saved size disagrees with the map', async () => {
    const doc = createDoc(3, 3, 16);
    const saved = throughJson(serializeProject(doc));
    saved.width = 4;

    const loaded = await deserializeProject(saved);
    const data = (loaded.layers[0] as TileLayer).data;
    expect(data.length).toBe(12);
    expect(data[11]).toBe(EMPTY);
  });

  it('keeps characters, frames and all', () => {
    const character = createCharacter(16, 2, 2, 4, 'Riley');
    character.frames[5].data[0] = 200;
    const saved = throughJson(serializeProject(createDoc(), [character]));

    const [back] = deserializeCharacters(saved);
    expect(back.name).toBe('Riley');
    expect(back.frames).toHaveLength(16);
    expect(back.frames[5].data[0]).toBe(200);
  });

  it('remembers which character Play should walk', () => {
    const first = createCharacter(16, 1, 1, 1, 'One');
    const second = createCharacter(16, 1, 1, 1, 'Two');
    const saved = throughJson(serializeProject(createDoc(), [first, second], second.id));
    expect(saved.lastPlayedCharacter).toBe(second.id);
  });

  it('keeps the picture traced over and the last canvas size', () => {
    const character = createCharacter(16, 2, 2, 1, 'Tracer');
    character.reference = { src: 'data:image/png;base64,AAAA', opacity: 0.3, visible: false };
    const saved = throughJson(serializeProject(createDoc(), [character], character.id, { tilesW: 3, tilesH: 4 }));
    const [back] = deserializeCharacters(saved);
    expect(back.reference).toEqual({ src: 'data:image/png;base64,AAAA', opacity: 0.3, visible: false });
    expect(saved.lastCharacterSize).toEqual({ tilesW: 3, tilesH: 4 });
  });

  it('keeps pixels that live in part of a larger buffer', () => {
    const character = createCharacter(16, 1, 1, 1, 'Slice');
    const expected = character.w * character.h * 4;
    const bigger = new Uint8ClampedArray(expected + 40);
    bigger.fill(7);
    const view = bigger.subarray(40);
    view[0] = 200;
    character.frames[0].data = view;
    const [back] = deserializeCharacters(throughJson(serializeProject(createDoc(), [character])));
    expect(back.frames[0].data[0]).toBe(200);
    expect(back.frames[0].data[1]).toBe(7);
  });

  it('recognises its own files and rejects others', () => {
    expect(isProjectFile(serializeProject(createDoc()))).toBe(true);
    expect(isProjectFile({ layers: [] })).toBe(false);
    expect(isProjectFile(null)).toBe(false);
  });
});

describe('exported map data', () => {
  it('keeps the Sprite Fusion tile layout that engine importers expect', () => {
    const doc = createDoc(3, 2, 16);
    (doc.layers[0] as TileLayer).data[4] = pack(0, 9);
    const json = JSON.parse(buildMapJson(doc));

    expect(json).toMatchObject({ tileSize: 16, mapWidth: 3, mapHeight: 2 });
    expect(json.layers[0].tiles).toEqual([{ id: '9', x: 1, y: 1 }]);
  });

  it('includes placed objects instead of silently dropping them', () => {
    const doc = createDoc(3, 2, 16);
    const objects = createObjectLayer('Props');
    objects.objects = [fakeObject({ x: 30, y: 44, rotation: 1, scale: 2 }), fakeObject()];
    doc.layers.push(objects);

    const json = JSON.parse(buildMapJson(doc));
    expect(json.objectLayers).toHaveLength(1);
    const [first, second] = json.objectLayers[0].objects;
    expect(first).toMatchObject({ x: 30, y: 44, rotation: 90, scale: 2, depth: 0 });
    // 16x32 scaled by two and turned a quarter: 64 wide, 32 tall.
    expect(first).toMatchObject({ width: 64, height: 32 });
    expect(second.depth).toBe(1);
  });

  it('leaves object layers out of the tile list, so old importers still parse it', () => {
    const doc = createDoc(2, 2, 16);
    doc.layers.push(createObjectLayer());
    const json = JSON.parse(buildMapJson(doc));
    expect(json.layers).toHaveLength(1);
    expect(json.layers[0]).toHaveProperty('tiles');
  });

  it('adds no object section to a map that has no objects', () => {
    expect(JSON.parse(buildMapJson(createDoc(2, 2, 16)))).not.toHaveProperty('objectLayers');
  });
});
