import { beforeEach, describe, expect, it } from 'vitest';
import { createDoc, type ImageLayer, type TileLayer, type Tileset } from '../core/doc';
import { Store } from '../core/store';
import { EMPTY, indexOf, pack, tilesetOf } from '../core/tiles';
import type { Renderer } from '../render/renderer';
import { Editor } from './edit';

/** The editor only tells the renderer which cells to repaint. */
const fakeRenderer = {
  markCell() {},
  markRect() {},
  invalidateAll() {},
  requestDraw() {},
} as unknown as Renderer;

function fakeTileset(name: string): Tileset {
  return {
    id: name,
    name,
    src: '',
    tileW: 16,
    tileH: 16,
    margin: 0,
    spacing: 0,
    image: null,
    imgW: 64,
    imgH: 64,
    cols: 4,
    rows: 4,
    count: 16,
  };
}

let store: Store;
let editor: Editor;
let layer: TileLayer;

const T = (i: number, ts = 0) => pack(ts, i);
const at = (x: number, y: number) => layer.data[y * store.doc.width + x];
const set = (x: number, y: number, tile: number) => {
  layer.data[y * store.doc.width + x] = tile;
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

  it('can be undone as one step', () => {
    store.stamp = { w: 1, h: 1, tiles: Int32Array.of(T(4)) };
    editor.beginStroke('Paint');
    editor.paintStamp(2, 2);
    editor.paintStamp(3, 2);
    editor.endStroke();
    editor.undo();
    expect(at(2, 2)).toBe(EMPTY);
    expect(at(3, 2)).toBe(EMPTY);
  });

  it('refuses to paint on a locked layer', () => {
    layer.locked = true;
    expect(editor.beginStroke('Paint')).toBe(false);
  });

  it('refuses to paint on a reference image', () => {
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
    expect(editor.beginStroke('Paint')).toBe(false);
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

describe('flood fill', () => {
  it('fills only the connected region and stops at the map edge', () => {
    // A wall down column 3 splits the map in two.
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

describe('selection', () => {
  beforeEach(() => {
    set(1, 1, T(1));
    set(2, 1, T(2));
  });

  it('lifts tiles off the map and drops them somewhere else', () => {
    expect(editor.liftSelection({ x0: 1, y0: 1, x1: 2, y1: 1 })).toBe(true);
    expect(at(1, 1)).toBe(EMPTY);

    store.selection!.x = 4;
    store.selection!.y = 3;
    editor.commitSelection();

    expect(at(4, 3)).toBe(T(1));
    expect(at(5, 3)).toBe(T(2));
    expect(at(1, 1)).toBe(EMPTY);
    expect(store.selection).toBeNull();
  });

  it('does not erase what is underneath a hole in the dropped block', () => {
    set(5, 3, T(9));
    editor.liftSelection({ x0: 0, y0: 1, x1: 1, y1: 1 }); // [empty, T(1)]
    store.selection!.x = 5;
    store.selection!.y = 3;
    editor.commitSelection();
    expect(at(5, 3)).toBe(T(9));
    expect(at(6, 3)).toBe(T(1));
  });

  it('picking up empty ground leaves the map untouched', () => {
    expect(editor.liftSelection({ x0: 5, y0: 4, x1: 6, y1: 5 })).toBe(false);
    expect(store.selection).toBeNull();
    expect(store.history.canUndo).toBe(false);
  });

  it('rotating a held block swaps its size and keeps it centred', () => {
    editor.liftSelection({ x0: 1, y0: 1, x1: 2, y1: 1 });
    editor.transformSelection('rotate');
    const s = store.selection!;
    expect([s.w, s.h]).toEqual([1, 2]);
    expect(s.x).toBe(2);
  });

  it('bringing to front past the top creates a new layer to land on', () => {
    editor.liftSelection({ x0: 1, y0: 1, x1: 2, y1: 1 });
    editor.moveSelectionDepth(1);
    expect(store.doc.layers).toHaveLength(2);
    editor.commitSelection();
    const front = store.doc.layers[1] as TileLayer;
    expect(front.data[1 * 8 + 1]).toBe(T(1));
    expect(layer.data[1 * 8 + 1]).toBe(EMPTY);
  });

  it('deleting a held block removes it for good', () => {
    editor.liftSelection({ x0: 1, y0: 1, x1: 2, y1: 1 });
    editor.deleteSelection();
    expect(at(1, 1)).toBe(EMPTY);
    expect(store.selection).toBeNull();
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
    expect(store.doc.tilesets.map((t) => t.name)).toEqual(['a', 'c']);
  });

  it('resizing keeps tiles anchored at the top-left', () => {
    set(1, 1, T(7));
    set(7, 5, T(8));
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

  it('will not delete the last layer', () => {
    editor.removeLayer(0);
    expect(store.doc.layers).toHaveLength(1);
  });

  it('undoes structural changes', () => {
    editor.addLayer();
    expect(store.doc.layers).toHaveLength(2);
    editor.undo();
    expect(store.doc.layers).toHaveLength(1);
  });
});
