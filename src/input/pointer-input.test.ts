import { beforeEach, describe, expect, it } from 'vitest';
import { createDoc, type ObjectLayer, type TileLayer } from '../core/doc';
import { Store } from '../core/store';
import { EMPTY, pack } from '../core/tiles';
import { fakeRenderer, fakeTileset } from '../test-support/fakes';
import { Editor } from '../tools/edit';
import { ObjectTools } from '../tools/objects';
import { PointerInput } from './pointer-input';

type Handler = (e: unknown) => void;

let store: Store;
let layer: TileLayer;
let objects: ObjectTools;
let handlers: Record<string, Handler>;

/** Enough of a canvas for the input handler to listen on. */
function fakeCanvas(): HTMLCanvasElement {
  handlers = {};
  return {
    addEventListener: (name: string, fn: Handler) => {
      handlers[name] = fn;
    },
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 1000, bottom: 1000, width: 1000, height: 1000 }),
    setPointerCapture: () => {},
    hasPointerCapture: () => false,
    releasePointerCapture: () => {},
  } as unknown as HTMLCanvasElement;
}

/** A Pencil event at a screen point. One map square is 16 px at zoom 1. */
function touch(x: number, y: number) {
  return {
    pointerId: 1,
    pointerType: 'touch',
    clientX: x,
    clientY: y,
    button: 0,
    buttons: 1,
    preventDefault: () => {},
  };
}

function pen(x: number, y: number) {
  return {
    pointerId: 1,
    pointerType: 'pen',
    clientX: x,
    clientY: y,
    button: 0,
    buttons: 1,
    preventDefault: () => {},
  };
}

const painted = () => [...layer.data].filter((tile) => tile !== EMPTY).length;

beforeEach(() => {
  store = new Store();
  store.doc = createDoc(8, 8, 16);
  store.doc.tilesets = [fakeTileset('a')];
  store.camera.x = 0;
  store.camera.y = 0;
  store.camera.zoom = 1;
  store.stamp = { w: 1, h: 1, tiles: Int32Array.of(pack(0, 1)) };
  layer = store.doc.layers[0] as TileLayer;
  const editor = new Editor(store, fakeRenderer);
  objects = new ObjectTools(store, fakeRenderer);
  new PointerInput(fakeCanvas(), store, editor, fakeRenderer, objects);
});

describe('fingers and placed objects', () => {
  it('selects an object with a finger tap, even while fingers paint floors', () => {
    store.doc.tilesets[0].name = 'Floors 1';
    store.settings.fingerDraws = true;
    store.setTool('brush');
    objects.place('a', { x: 0, y: 0, w: 16, h: 16 }, 40, 40);
    const placed = objects.selected()!.obj;
    objects.deselect();
    handlers.pointerdown(touch(placed.x, placed.y));
    handlers.pointerup(touch(placed.x, placed.y));
    expect(objects.selected()?.obj.id).toBe(placed.id);
    expect(painted()).toBe(0);
  });

  it('places another copy on every tap of the map', () => {
    store.doc.tilesets[0].assets = [{ x: 0, y: 0, w: 16, h: 16 }];
    store.libraryPick = { tilesetId: 'a', index: 0 };
    handlers.pointerdown(touch(24, 24));
    handlers.pointerup(touch(24, 24));
    handlers.pointerdown(touch(72, 24));
    handlers.pointerup(touch(72, 24));
    const objectsLayer = store.doc.layers.find((l) => l.kind === 'objects') as ObjectLayer;
    expect(objectsLayer.objects).toHaveLength(2);
    expect(objectsLayer.objects[0].x).not.toBe(objectsLayer.objects[1].x);
  });
});

describe('a touch the system cancels', () => {
  it('does not commit a half-drawn rectangle', () => {
    store.setTool('rect');
    handlers.pointerdown(pen(2, 2));
    handlers.pointermove(pen(50, 50));
    handlers.pointercancel(pen(50, 50));
    expect(painted()).toBe(0);
    expect(store.history.canUndo).toBe(false);
  });

  it('rolls back a brush stroke that was underway', () => {
    store.setTool('brush');
    handlers.pointerdown(pen(2, 2));
    handlers.pointercancel(pen(2, 2));
    expect(painted()).toBe(0);
  });

  it('still commits a rectangle that is finished normally', () => {
    store.setTool('rect');
    handlers.pointerdown(pen(2, 2));
    handlers.pointermove(pen(50, 50));
    handlers.pointerup(pen(50, 50));
    expect(painted()).toBe(16);
  });
});
