import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDoc,
  createLayer,
  createObjectLayer,
  type ImageLayer,
  type ObjectLayer,
  type TileLayer,
} from '../core/doc';
import { Store } from '../core/store';
import { EMPTY, indexOf, pack, tilesetOf } from '../core/tiles';
import { fakeObject, fakeRenderer, fakeTileset } from '../test-support/fakes';
import { Editor } from './edit';

let store: Store;
let editor: Editor;
let layer: TileLayer;

const T = (i: number, ts = 0) => pack(ts, i);
const at = (x: number, y: number, l: TileLayer = layer) => l.data[y * store.doc.width + x];
const set = (x: number, y: number, tile: number) => {
  layer.data[y * store.doc.width + x] = tile;
};
const paint = (x: number, y: number, tile: number) => {
  store.stamp = { w: 1, h: 1, tiles: Int32Array.of(tile) };
  if (!editor.beginStroke('Paint')) return false;
  editor.paintStamp(x, y);
  editor.endStroke();
  return true;
};

beforeEach(() => {
  store = new Store();
  store.doc = createDoc(8, 6, 16);
  store.doc.tilesets = [fakeTileset('a')];
  editor = new Editor(store, fakeRenderer);
  layer = store.doc.layers[0] as TileLayer;
});

describe('painting', () => {
  it('writes the stamp and leaves its holes alone', () => {
    set(1, 0, T(9));
    store.stamp = { w: 2, h: 1, tiles: Int32Array.from([T(1), EMPTY]) };
    editor.beginStroke('Paint');
    editor.paintStamp(0, 0);
    editor.endStroke();
    expect(at(0, 0)).toBe(T(1));
    expect(at(1, 0)).toBe(T(9));
  });

  it('clips a stamp that hangs off the edge of the map', () => {
    store.stamp = { w: 3, h: 1, tiles: Int32Array.from([T(1), T(2), T(3)]) };
    editor.beginStroke('Paint');
    expect(() => editor.paintStamp(6, 0)).not.toThrow();
    editor.endStroke();
    expect(at(6, 0)).toBe(T(1));
    expect(at(7, 0)).toBe(T(2));
  });

  it('records a whole stroke as one undo step', () => {
    store.stamp = { w: 1, h: 1, tiles: Int32Array.of(T(4)) };
    editor.beginStroke('Paint');
    editor.paintStamp(2, 2);
    editor.paintStamp(3, 2);
    editor.endStroke();
    editor.undo();
    expect(at(2, 2)).toBe(EMPTY);
    expect(at(3, 2)).toBe(EMPTY);
  });

  it('rolls an aborted stroke back completely', () => {
    store.stamp = { w: 1, h: 1, tiles: Int32Array.of(T(4)) };
    editor.beginStroke('Paint');
    editor.paintStamp(0, 0);
    editor.abortStroke();
    expect(at(0, 0)).toBe(EMPTY);
    expect(store.history.canUndo).toBe(false);
  });
});

describe('which layer painting lands on', () => {
  // Placing an object makes its layer active. Painting ground afterwards must
  // still work, which is why the brush looks beneath an object layer.

  it('paints the tile layer beneath an active object layer', () => {
    store.doc.layers.push(createObjectLayer());
    store.doc.activeLayer = 1;
    expect(paint(2, 2, T(5))).toBe(true);
    expect(at(2, 2)).toBe(T(5));
  });

  it('paints the tile layer beneath an active reference image', () => {
    const image: ImageLayer = {
      kind: 'image',
      id: 'img',
      name: 'Ref',
      visible: true,
      locked: false,
      opacity: 1,
      src: '',
      image: null,
      x: 0,
      y: 0,
      w: 10,
      h: 10,
      naturalW: 10,
      naturalH: 10,
    };
    store.doc.layers.push(image);
    store.doc.activeLayer = 1;
    expect(paint(1, 1, T(3))).toBe(true);
    expect(at(1, 1)).toBe(T(3));
  });

  it('prefers the nearest tile layer below over one further down', () => {
    const middle = createLayer(8, 6, 'Middle');
    store.doc.layers.push(middle, createObjectLayer());
    store.doc.activeLayer = 2;
    paint(0, 0, T(7));
    expect(at(0, 0, middle)).toBe(T(7));
    expect(at(0, 0)).toBe(EMPTY);
  });

  it('names the layer when painting is blocked because it is locked', () => {
    const toast = vi.spyOn(store, 'toast');
    layer.locked = true;
    expect(paint(0, 0, T(1))).toBe(false);
    expect(toast).toHaveBeenCalledWith('Layer 1 is locked');
  });

  it('says to add a tile layer when there is none at all', () => {
    const toast = vi.spyOn(store, 'toast');
    store.doc.layers = [createObjectLayer()];
    store.doc.activeLayer = 0;
    expect(paint(0, 0, T(1))).toBe(false);
    expect(toast).toHaveBeenCalledWith('Add a tile layer to paint on');
  });
});

describe('flood fill', () => {
  it('fills only the connected region and stops at walls', () => {
    for (let y = 0; y < 6; y++) set(3, y, T(1));
    store.stamp = { w: 1, h: 1, tiles: Int32Array.of(T(2)) };
    editor.beginStroke('Fill');
    editor.floodFill(0, 0, false);
    editor.endStroke();
    expect(at(0, 0)).toBe(T(2));
    expect(at(2, 5)).toBe(T(2));
    expect(at(3, 0)).toBe(T(1));
    expect(at(4, 0)).toBe(EMPTY);
  });

  it('does nothing when filling a region with what it already is', () => {
    store.stamp = { w: 1, h: 1, tiles: Int32Array.of(EMPTY) };
    editor.beginStroke('Fill');
    editor.floodFill(0, 0, true);
    editor.endStroke();
    expect(store.history.canUndo).toBe(false);
  });

  it('lays a multi-tile stamp on a grid anchored to the map origin', () => {
    store.stamp = { w: 2, h: 1, tiles: Int32Array.from([T(5), T(6)]) };
    editor.beginStroke('Fill');
    editor.floodFill(3, 3, false);
    editor.endStroke();
    expect(at(0, 0)).toBe(T(5));
    expect(at(1, 0)).toBe(T(6));
    expect(at(2, 0)).toBe(T(5));
  });
});

describe('structural edits', () => {
  it('removing a tileset clears its tiles and renumbers the later sheets', () => {
    store.doc.tilesets = [fakeTileset('a'), fakeTileset('b'), fakeTileset('c')];
    set(0, 0, T(3, 0));
    set(1, 0, T(4, 1));
    set(2, 0, T(5, 2));

    editor.removeTileset(1);

    expect(at(0, 0)).toBe(T(3, 0));
    expect(at(1, 0)).toBe(EMPTY);
    // Sheet c slid from index 2 to 1 but must still point at the same art.
    expect(tilesetOf(at(2, 0))).toBe(1);
    expect(indexOf(at(2, 0))).toBe(5);
  });

  it('removing a tileset removes the objects made from it, and only those', () => {
    store.doc.tilesets = [fakeTileset('a'), fakeTileset('b')];
    const objects = createObjectLayer();
    objects.objects = [fakeObject({ id: 'keep', tilesetId: 'a' }), fakeObject({ id: 'drop', tilesetId: 'b' })];
    store.doc.layers.push(objects);

    editor.removeTileset(1);

    expect((store.doc.layers[1] as ObjectLayer).objects.map((o) => o.id)).toEqual(['keep']);
  });

  it('duplicating an object layer makes independent copies with new ids', () => {
    const objects = createObjectLayer();
    objects.objects = [fakeObject({ id: 'one' })];
    store.doc.layers.push(objects);

    editor.duplicateLayer(1);

    const copy = store.doc.layers[2] as ObjectLayer;
    expect(copy.objects[0].id).not.toBe('one');
    copy.objects[0].x = 999;
    copy.objects[0].rect.w = 999;
    expect(objects.objects[0].x).toBe(40);
    expect(objects.objects[0].rect.w).toBe(16);
  });

  it('resizing keeps tiles anchored at the top-left', () => {
    set(1, 1, T(7));
    editor.resizeMap(4, 3);
    expect(store.doc.width).toBe(4);
    expect(layer.data.length).toBe(12);
    expect(layer.data[1 * 4 + 1]).toBe(T(7));
  });

  it('merging down keeps the upper layer on top', () => {
    editor.addLayer();
    const upper = store.doc.layers[1] as TileLayer;
    set(0, 0, T(1));
    set(1, 0, T(2));
    upper.data[0] = T(9);
    editor.mergeDown(1);
    expect(store.doc.layers).toHaveLength(1);
    expect(at(0, 0)).toBe(T(9));
    expect(at(1, 0)).toBe(T(2));
  });

  it('will not merge an object layer into tiles', () => {
    store.doc.layers.push(createObjectLayer());
    editor.mergeDown(1);
    expect(store.doc.layers).toHaveLength(2);
  });

  it('will not delete the last layer', () => {
    editor.removeLayer(0);
    expect(store.doc.layers).toHaveLength(1);
  });

  it('undoes structural changes', () => {
    editor.addLayer();
    editor.undo();
    expect(store.doc.layers).toHaveLength(1);
  });
});

describe('picking up and moving painted tiles', () => {
  const block = () => {
    set(1, 1, T(1));
    set(2, 1, T(2));
    set(1, 2, T(3));
  };
  const lift = () => editor.liftSelection({ x0: 1, y0: 1, x1: 2, y1: 2 });

  it('lifts a block off the map and holds it', () => {
    block();
    expect(lift()).toBe(true);
    expect(at(1, 1)).toBe(EMPTY);
    expect(store.selection).toMatchObject({ x: 1, y: 1, w: 2, h: 2 });
    expect([...store.selection!.tiles]).toEqual([T(1), T(2), T(3), EMPTY]);
  });

  it('picks up nothing from bare ground, and records nothing', () => {
    expect(lift()).toBe(false);
    expect(store.selection).toBeNull();
    expect(store.history.canUndo).toBe(false);
  });

  it('moves a block as a single undo step', () => {
    block();
    lift();
    store.selection!.x = 4;
    store.selection!.y = 3;
    editor.commitSelection();
    expect(at(4, 3)).toBe(T(1));
    expect(at(5, 3)).toBe(T(2));
    expect(at(4, 4)).toBe(T(3));
    expect(at(1, 1)).toBe(EMPTY);

    editor.undo();
    expect(at(1, 1)).toBe(T(1));
    expect(at(4, 3)).toBe(EMPTY);
    expect(store.history.canUndo).toBe(false);
  });

  it('records nothing when a block is set down where it started', () => {
    block();
    lift();
    editor.commitSelection();
    expect(at(1, 1)).toBe(T(1));
    expect(store.history.canUndo).toBe(false);
  });

  it('keeps the holes in a block from erasing what is beneath', () => {
    block();
    set(5, 4, T(7));
    lift();
    store.selection!.x = 4;
    store.selection!.y = 3;
    editor.commitSelection();
    expect(at(5, 4)).toBe(T(7));
  });

  it('puts a block back where it came from when undone straight after lifting', () => {
    block();
    lift();
    store.selection!.x = 5;
    editor.undo();
    expect(store.selection).toBeNull();
    expect(at(1, 1)).toBe(T(1));
    expect(at(5, 1)).toBe(EMPTY);
  });

  it('flips and rotates a held block around its centre', () => {
    block();
    lift();
    editor.transformSelection('flipH');
    expect([...store.selection!.tiles].map((t) => (t === EMPTY ? -1 : indexOf(t)))).toEqual([2, 1, -1, 3]);
    editor.transformSelection('rotate');
    expect(store.selection).toMatchObject({ w: 2, h: 2, x: 1, y: 1 });
  });

  it('deletes a held block, and undo brings it back', () => {
    block();
    lift();
    editor.deleteSelection();
    expect(store.selection).toBeNull();
    expect(at(1, 1)).toBe(EMPTY);
    editor.undo();
    expect(at(1, 1)).toBe(T(1));
  });

  it('sets a held block down before any structural change, so it is never stranded', () => {
    block();
    lift();
    store.selection!.x = 4;
    editor.addLayer();
    expect(store.selection).toBeNull();
    expect(at(4, 1)).toBe(T(1));
  });

  it('sets a held block down before painting', () => {
    block();
    lift();
    store.selection!.x = 4;
    paint(0, 5, T(8));
    expect(store.selection).toBeNull();
    expect(at(4, 1)).toBe(T(1));
  });

  it('sets the block down instead of undoing when something else was recorded since the lift', () => {
    block();
    lift();
    store.selection!.x = 4;
    store.history.transact('Unrelated', () => {});
    editor.undo();
    expect(store.selection).toBeNull();
    expect(at(4, 1)).toBe(T(1));
  });

  it('sends a block in front onto a new layer, and lands it there', () => {
    block();
    lift();
    editor.moveSelectionDepth(1);
    expect(store.doc.layers).toHaveLength(2);
    expect(store.selection!.layerId).toBe(store.doc.layers[1].id);
    editor.commitSelection();
    expect(at(1, 1, store.doc.layers[1] as TileLayer)).toBe(T(1));
    expect(at(1, 1)).toBe(EMPTY);
  });

  it('saves the held block as if it were set down, without setting it down', () => {
    block();
    lift();
    store.selection!.x = 4;
    const saved = editor.settledDoc();
    const savedLayer = saved.layers[0] as TileLayer;
    expect(savedLayer.data[1 * store.doc.width + 4]).toBe(T(1));
    expect(store.selection).not.toBeNull();
    expect(at(4, 1)).toBe(EMPTY);
  });

  it('places a picked block once, holes and all', () => {
    set(1, 0, T(9));
    store.stamp = { w: 2, h: 2, tiles: Int32Array.from([T(1), EMPTY, T(3), T(4)]) };
    editor.placeStamp(0, 0);
    expect(at(0, 0)).toBe(T(1));
    expect(at(1, 0)).toBe(T(9));
    expect(at(1, 1)).toBe(T(4));
    editor.undo();
    expect(at(0, 0)).toBe(EMPTY);
  });
});
