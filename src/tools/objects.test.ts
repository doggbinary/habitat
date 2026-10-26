import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDoc, createObjectLayer, objectSize, type MapObject, type ObjectLayer } from '../core/doc';
import { Store } from '../core/store';
import { fakeObject, fakeRenderer, fakeTileset } from '../test-support/fakes';
import { MAX_SCALE, MIN_SCALE, ObjectTools, keepTouchingMap, lineUpObjects, onWholePixels, scaleFromCorner } from './objects';

let store: Store;
let tools: ObjectTools;
let layer: ObjectLayer;

/** Puts objects on a fresh layer, last one in front, and selects the last. */
function withObjects(...objects: MapObject[]): MapObject[] {
  layer.objects = objects;
  if (objects.length) tools.select(layer, objects[objects.length - 1]);
  return objects;
}

beforeEach(() => {
  store = new Store();
  store.doc = createDoc(10, 10, 16);
  store.doc.tilesets = [fakeTileset('a')];
  tools = new ObjectTools(store, fakeRenderer);
  layer = createObjectLayer();
  store.doc.layers.push(layer);
});

describe('placing', () => {
  it('puts a new object layer on top when the map has none', () => {
    store.doc.layers = store.doc.layers.filter((l) => l.kind !== 'objects');
    tools.place('a', { x: 0, y: 0, w: 16, h: 16 }, 50, 60);
    const top = store.doc.layers[store.doc.layers.length - 1] as ObjectLayer;
    expect(top.kind).toBe('objects');
    expect(top.objects).toHaveLength(1);
  });

  it('selects what it placed, snapped onto a grid square', () => {
    tools.place('a', { x: 0, y: 0, w: 16, h: 16 }, 50, 60);
    const obj = tools.selected()?.obj;
    expect(obj?.x).toBe(56);
    expect(obj?.y).toBe(56);
    expect(obj!.x - 8).toBe(48);
    expect(obj!.y - 8).toBe(48);
  });

  it('sizes a prop to match the ground drawn from the same sheet', () => {
    // A 32px sheet on a 16px map draws at half size, like its tiles do.
    store.doc.tilesets = [fakeTileset('big', 32)];
    tools.place('big', { x: 0, y: 0, w: 32, h: 32 }, 0, 0);
    expect(tools.selected()?.obj.scale).toBe(0.5);
  });

  it('can be undone', () => {
    tools.place('a', { x: 0, y: 0, w: 16, h: 16 }, 50, 60);
    store.history.undo();
    expect((store.doc.layers[1] as ObjectLayer).objects).toHaveLength(0);
  });
});

describe('finding objects under a finger', () => {
  it('returns the frontmost of overlapping objects', () => {
    withObjects(fakeObject({ id: 'back' }), fakeObject({ id: 'front' }));
    expect(tools.hitTest(40, 40)?.obj.id).toBe('front');
  });

  it('ignores hidden and locked layers', () => {
    withObjects(fakeObject());
    layer.visible = false;
    expect(tools.hitTest(40, 40)).toBeNull();
    layer.visible = true;
    layer.locked = true;
    expect(tools.hitTest(40, 40)).toBeNull();
  });

  it('uses the turned footprint once an object is rotated', () => {
    // 16 wide x 32 tall, centred at (40, 40). Turned a quarter it becomes
    // 32 wide x 16 tall, so a point 12px to the right now hits it.
    withObjects(fakeObject({ rotation: 0 }));
    expect(tools.hitTest(52, 40)).toBeNull();
    layer.objects[0].rotation = 1;
    expect(tools.hitTest(52, 40)).not.toBeNull();
    expect(objectSize(layer.objects[0])).toEqual({ w: 32, h: 16 });
  });
});

describe('resizing', () => {
  it('stays within the allowed range', () => {
    const [obj] = withObjects(fakeObject());
    tools.scaleTo(obj, 1000);
    expect(obj.scale).toBe(MAX_SCALE);
    // Never smaller than half the art: below that pixel art loses rows.
    tools.scaleTo(obj, 0);
    expect(obj.scale).toBe(0.5);
    expect(obj.scale).toBeGreaterThanOrEqual(MIN_SCALE);
  });

  it('only stops on whole squares of the longer side', () => {
    const [obj] = withObjects(fakeObject());
    tools.scaleTo(obj, 2.04);
    expect(obj.scale).toBe(2);
    tools.scaleTo(obj, 1.47);
    expect(obj.scale).toBe(1.5);
    tools.scaleTo(obj, 1.3);
    expect(obj.scale).toBe(1.5);
  });

  it('keeps the edges on whole pixels after a resize', () => {
    const [obj] = withObjects(fakeObject());
    tools.scaleTo(obj, 1.5);
    const { w, h } = objectSize(obj);
    expect(Number.isInteger(obj.x - w / 2)).toBe(true);
    expect(Number.isInteger(obj.y - h / 2)).toBe(true);
  });

  it('lines every unlocked object up with the grid in whole squares', () => {
    const [loose, fixed] = withObjects(
      fakeObject({ id: 'loose', x: 43, y: 51, scale: 1.3 }),
      fakeObject({ id: 'fixed', x: 43, y: 51, locked: true }),
    );
    expect(lineUpObjects(store.doc)).toBe(1);
    const { w, h } = objectSize(loose);
    expect(h % 16).toBe(0);
    expect((loose.x - w / 2) % 16).toBe(0);
    expect((loose.y - h / 2) % 16).toBe(0);
    expect(fixed.x).toBe(43);
    expect(lineUpObjects(store.doc)).toBe(0);
  });

  it('hangs off the edge, keeping one square on the map', () => {
    // 16 x 32 on a 160 px map of 16 px squares.
    const obj = fakeObject();
    const { w, h } = objectSize(obj);
    obj.x = 1000;
    obj.y = 1000;
    keepTouchingMap(obj, 160, 160, 16);
    expect(obj.x - w / 2).toBe(144);
    expect(obj.y - h / 2).toBe(144);
    obj.x = -1000;
    obj.y = -1000;
    keepTouchingMap(obj, 160, 160, 16);
    expect(obj.x + w / 2).toBe(16);
    expect(obj.y + h / 2).toBe(16);
  });

  it('can be dragged partly off the map, and the part left on it stays on the grid', () => {
    // Two squares wide, so one can hang off while the other stays on.
    const [obj] = withObjects(fakeObject({ rect: { x: 0, y: 0, w: 32, h: 32 } }));
    const { w, h } = objectSize(obj);
    tools.moveSelected(obj, -4, 30);
    // Half of it off the left edge, its corner on a grid line.
    expect(obj.x - w / 2).toBe(-16);
    expect(Math.abs((obj.y - h / 2) % 16)).toBe(0);
    tools.moveSelected(obj, 5000, -5000);
    expect(obj.x - w / 2).toBe(144);
    expect(obj.y + h / 2).toBe(16);
  });

  it('keeps one square of a big asset on the map, still on the grid', () => {
    const obj = fakeObject({ rect: { x: 0, y: 0, w: 64, h: 48 } });
    obj.x = -500;
    obj.y = 40;
    keepTouchingMap(obj, 160, 160, 16);
    expect(obj.x - 32).toBe(-48);
    expect(obj.x + 32).toBe(16);
  });

  it('steps one square bigger and smaller', () => {
    const [obj] = withObjects(fakeObject());
    tools.stepSize(obj, 1);
    expect(objectSize(obj).h).toBe(48);
    tools.stepSize(obj, -1);
    expect(objectSize(obj).h).toBe(32);
  });

  it('lets a box bigger than the map sit anywhere that still covers a square', () => {
    const obj = fakeObject({ scale: 20, x: 0, y: 0 });
    const { w, h } = objectSize(obj);
    keepTouchingMap(obj, 160, 160, 16);
    expect(w).toBeGreaterThan(160);
    expect(obj.x + w / 2).toBeGreaterThanOrEqual(16);
    expect(obj.y + h / 2).toBeGreaterThanOrEqual(16);
    expect(Math.abs((obj.x - w / 2) % 16)).toBe(0);
  });

  it('still asks for the larger size after the centre jumps to the grid', () => {
    const [obj] = withObjects(fakeObject());
    const startScale = obj.scale;
    const start = objectSize(obj);
    const anchorX = obj.x - start.w / 2;
    const anchorY = obj.y - start.h / 2;
    const pointerX = anchorX + start.w + store.doc.tileSize;
    const pointerY = anchorY + start.h + store.doc.tileSize;
    const requested = scaleFromCorner(startScale, start.w, start.h, anchorX, anchorY, pointerX, pointerY);
    expect(requested).toBeGreaterThan(startScale);

    const cornerDistance = Math.hypot(start.w / 2, start.h / 2);
    tools.scaleTo(obj, requested);
    expect(obj.scale).toBeGreaterThan(startScale);

    // The same pointer, measured from the corner we remembered, still wants
    // the grown size. Measuring from the centre that just moved does not.
    const again = scaleFromCorner(startScale, start.w, start.h, anchorX, anchorY, pointerX, pointerY);
    expect(again).toBe(requested);
    tools.scaleTo(obj, again);
    expect(obj.scale).toBeGreaterThan(startScale);
    const fromCentre = startScale * (Math.hypot(pointerX - obj.x, pointerY - obj.y) / cornerDistance);
    expect(fromCentre).toBeLessThan(obj.scale);
  });
});

describe('selecting several to recolour together', () => {
  it('adds assets to the selection one tap at a time, and takes them out again', () => {
    const [a, b, c] = withObjects(fakeObject({ id: 'a' }), fakeObject({ id: 'b' }), fakeObject({ id: 'c' }));
    tools.select(layer, a);
    tools.toggleInSelection(layer, b);
    tools.toggleInSelection(layer, c);
    expect(tools.recolorable().map((o) => o.id)).toEqual(['a', 'b', 'c']);
    tools.toggleInSelection(layer, b);
    expect(tools.recolorable().map((o) => o.id)).toEqual(['a', 'c']);
  });

  it('leaves locked assets out of a recolour', () => {
    const [a, b] = withObjects(fakeObject({ id: 'a' }), fakeObject({ id: 'b', locked: true }));
    tools.select(layer, a);
    tools.toggleInSelection(layer, b);
    expect(tools.recolorable().map((o) => o.id)).toEqual(['a']);
  });

  it('clears the selection when the last asset is taken out', () => {
    const [a] = withObjects(fakeObject({ id: 'a' }));
    tools.select(layer, a);
    tools.toggleInSelection(layer, a);
    expect(tools.selected()).toBeNull();
  });
});

describe('whole pixels', () => {
  it('puts the left and top edges on whole pixels', () => {
    const at = onWholePixels(15, 9, 40.3, 20.8);
    expect(Number.isInteger(at.x - 7.5)).toBe(true);
    expect(Number.isInteger(at.y - 4.5)).toBe(true);
  });
});

describe('swapping', () => {
  it('replaces the art but keeps position, direction and order', () => {
    const [a, b] = withObjects(
      fakeObject({ id: 'a' }),
      fakeObject({ id: 'b', x: 70, y: 90, rotation: 1, flipX: true, hueShift: 120, scale: 2 }),
    );
    void a;
    tools.swap('a', { x: 48, y: 0, w: 32, h: 16 });
    expect(b).toMatchObject({ x: 70, y: 90, rotation: 1, flipX: true, scale: 2, hueShift: 0 });
    expect(b.rect).toEqual({ x: 48, y: 0, w: 32, h: 16 });
    expect(layer.objects.map((o) => o.id)).toEqual(['a', 'b']);
  });

  it('keeps the size matched to the map when swapping between sheets of different tile sizes', () => {
    store.doc.tilesets.push(fakeTileset('big', 32));
    const [obj] = withObjects(fakeObject({ id: 'a', scale: 1 }));
    tools.swap('big', { x: 0, y: 0, w: 32, h: 32 });
    expect(obj.scale).toBe(0.5);
  });

  it('can be undone', () => {
    withObjects(fakeObject({ id: 'a' }));
    tools.swap('a', { x: 48, y: 0, w: 32, h: 16 });
    store.history.undo();
    const restored = store.doc.layers.find((l) => l.id === layer.id) as ObjectLayer;
    expect(restored.objects[0].rect).toEqual({ x: 0, y: 0, w: 16, h: 32 });
  });
});

describe('front and back', () => {
  it('bringing forward passes exactly one object', () => {
    const [a, b, c] = withObjects(fakeObject({ id: 'a' }), fakeObject({ id: 'b' }), fakeObject({ id: 'c' }));
    tools.select(layer, a);
    tools.bringForward();
    expect(layer.objects.map((o) => o.id)).toEqual(['b', 'a', 'c']);
    void b;
    void c;
  });

  it('sending backward passes exactly one object', () => {
    withObjects(fakeObject({ id: 'a' }), fakeObject({ id: 'b' }), fakeObject({ id: 'c' }));
    tools.sendBackward();
    expect(layer.objects.map((o) => o.id)).toEqual(['a', 'c', 'b']);
  });

  it('says so rather than silently doing nothing at the front', () => {
    const toast = vi.spyOn(store, 'toast');
    withObjects(fakeObject({ id: 'a' }), fakeObject({ id: 'b' }));
    tools.bringForward();
    expect(layer.objects.map((o) => o.id)).toEqual(['a', 'b']);
    expect(toast).toHaveBeenCalledWith('Nothing in front of it');
  });

  it('steps past the next asset it overlaps, skipping ones elsewhere on the map', () => {
    const [a] = withObjects(
      fakeObject({ id: 'a' }),
      fakeObject({ id: 'far', x: 400 }),
      fakeObject({ id: 'b' }),
      fakeObject({ id: 'c' }),
    );
    tools.select(layer, a);
    tools.bringForward();
    expect(layer.objects.map((o) => o.id)).toEqual(['far', 'b', 'a', 'c']);
  });

  it('cannot reorder past assets it does not touch, and says which way is possible', () => {
    const [a] = withObjects(fakeObject({ id: 'a' }), fakeObject({ id: 'far', x: 400 }), fakeObject({ id: 'b' }));
    tools.select(layer, a);
    expect(tools.canReorder(-1)).toBe(false);
    expect(tools.canReorder(1)).toBe(true);
    tools.select(layer, layer.objects[1]);
    expect(tools.canReorder(1)).toBe(false);
    expect(tools.canReorder(-1)).toBe(false);
  });

  it('brings an asset all the way to the front, and sends one all the way back', () => {
    const [a] = withObjects(fakeObject({ id: 'a' }), fakeObject({ id: 'b' }), fakeObject({ id: 'c' }));
    tools.select(layer, a);
    tools.bringToFront();
    expect(layer.objects.map((o) => o.id)).toEqual(['b', 'c', 'a']);
    tools.sendToBack();
    expect(layer.objects.map((o) => o.id)).toEqual(['a', 'b', 'c']);
  });

  it('reordering can be undone', () => {
    withObjects(fakeObject({ id: 'a' }), fakeObject({ id: 'b' }));
    tools.sendBackward();
    store.history.undo();
    const restored = store.doc.layers.find((l) => l.id === layer.id) as ObjectLayer;
    expect(restored.objects.map((o) => o.id)).toEqual(['a', 'b']);
  });
});

describe('turning and mirroring', () => {
  type M = [number, number, number, number];
  const mul = (a: M, b: M): M => [
    a[0] * b[0] + a[1] * b[2] + 0,
    a[0] * b[1] + a[1] * b[3] + 0,
    a[2] * b[0] + a[3] * b[2] + 0,
    a[2] * b[1] + a[3] * b[3] + 0,
  ];
  const R: M = [0, -1, 1, 0];
  const ACROSS: M = [-1, 0, 0, 1];
  const DOWN: M = [1, 0, 0, -1];

  /** What `drawObject` applies: rotate by quarter turns, then mirror. */
  function matrixOf(obj: MapObject): M {
    let m: M = [obj.flipX ? -1 : 1, 0, 0, obj.flipY ? -1 : 1];
    for (let i = 0; i < obj.rotation; i++) m = mul(R, m);
    return m;
  }

  const every = () => {
    const all: Pick<MapObject, 'rotation' | 'flipX' | 'flipY'>[] = [];
    for (let rotation = 0; rotation < 4; rotation++) {
      for (const flipX of [false, true]) for (const flipY of [false, true]) all.push({ rotation, flipX, flipY });
    }
    return all;
  };

  it('"flip across" mirrors across the screen however the object is turned', () => {
    for (const pose of every()) {
      const [obj] = withObjects(fakeObject(pose));
      const before = matrixOf(obj);
      tools.flipAcross();
      expect(matrixOf(tools.selected()!.obj)).toEqual(mul(ACROSS, before));
    }
  });

  it('"flip down" mirrors down the screen however the object is turned', () => {
    for (const pose of every()) {
      const [obj] = withObjects(fakeObject(pose));
      const before = matrixOf(obj);
      tools.flipDown();
      expect(matrixOf(tools.selected()!.obj)).toEqual(mul(DOWN, before));
    }
  });

  it('rotate turns a quarter clockwise and wraps after four', () => {
    const [obj] = withObjects(fakeObject());
    for (let i = 0; i < 4; i++) tools.rotate();
    expect(obj.rotation).toBe(0);
  });
});

describe('continuous gestures', () => {
  it('a whole drag is one undo step, however many moves it made', () => {
    const [obj] = withObjects(fakeObject());
    tools.beginGesture();
    for (let i = 0; i < 20; i++) tools.moveTo(obj, 40 + i, 40);
    tools.endGesture('Move');
    expect(obj.x).toBe(56);

    store.history.undo();
    const restored = (store.doc.layers.find((l) => l.id === layer.id) as ObjectLayer).objects[0];
    expect(restored.x).toBe(40);
  });

  it('a cancelled gesture records nothing', () => {
    withObjects(fakeObject());
    tools.beginGesture();
    tools.cancelGesture();
    expect(store.history.canUndo).toBe(false);
  });
});

describe('duplicate and delete', () => {
  it('duplicates beside the original, in front of it, as a new object', () => {
    const [obj] = withObjects(fakeObject({ id: 'orig' }));
    tools.duplicate();
    expect(layer.objects).toHaveLength(2);
    const copy = layer.objects[1];
    expect(copy.id).not.toBe('orig');
    expect(copy.x).toBeGreaterThan(obj.x);
    expect(tools.selected()?.obj.id).toBe(copy.id);
  });

  it('a copy of a grouped asset is not tied to the original', () => {
    const [obj] = withObjects(fakeObject({ id: 'orig', groupId: 'g1' }));
    store.selectedGroup = [{ layerId: layer.id, objectId: 'orig' }];
    tools.duplicate();
    const copy = layer.objects[1];
    expect(copy.groupId).toBeUndefined();
    expect(store.selectedGroup).toHaveLength(0);
    const startX = obj.x;
    tools.moveSelected(copy, copy.x + 64, copy.y);
    expect(obj.x).toBe(startX);
  });

  it('a locked asset does not move, until it is unlocked', () => {
    const [obj] = withObjects(fakeObject({ id: 'fixed', x: 40, y: 40 }));
    tools.toggleLock();
    tools.moveTo(obj, 200, 200);
    expect(obj.x).toBe(40);
    expect(obj.y).toBe(40);
    tools.toggleLock();
    tools.moveTo(obj, 200, 200);
    expect(obj.x).toBe(200);
    expect(obj.y).toBe(208);
  });

  it('deletes the selected object and can be undone', () => {
    withObjects(fakeObject({ id: 'gone' }));
    tools.remove();
    expect(layer.objects).toHaveLength(0);
    expect(tools.selected()).toBeNull();
    store.history.undo();
    expect((store.doc.layers.find((l) => l.id === layer.id) as ObjectLayer).objects).toHaveLength(1);
  });
});

describe('several assets at once', () => {
  const pick = (...objs: MapObject[]) => tools.selectMany(objs.map((obj) => ({ layer, obj })));

  it('deletes everything selected as one undo step, keeping locked ones', () => {
    const [a, b, c, keep] = withObjects(
      fakeObject({ id: 'a' }),
      fakeObject({ id: 'b', x: 120 }),
      fakeObject({ id: 'c', x: 40, y: 120, locked: true }),
      fakeObject({ id: 'keep', x: 140, y: 140 }),
    );
    void keep;
    pick(a, b, c);
    tools.remove();
    expect(layer.objects.map((o) => o.id)).toEqual(['c', 'keep']);
    expect(store.selectedGroup).toEqual([]);
    store.history.undo();
    expect((store.doc.layers.find((l) => l.id === layer.id) as ObjectLayer).objects).toHaveLength(4);
  });

  it('duplicates everything selected, and a copied group is a new group of its own', () => {
    const [a, b] = withObjects(fakeObject({ id: 'a', groupId: 'g1' }), fakeObject({ id: 'b', x: 72, groupId: 'g1' }));
    tools.select(layer, a);
    tools.duplicate();
    const copies = layer.objects.filter((o) => o.id !== 'a' && o.id !== 'b');
    expect(copies).toHaveLength(2);
    expect(copies[0].groupId).toBeDefined();
    expect(copies[0].groupId).not.toBe('g1');
    expect(copies[1].groupId).toBe(copies[0].groupId);
    expect(store.selectedGroup.map((sel) => sel.objectId).sort()).toEqual(copies.map((o) => o.id).sort());
    // The copies keep their spacing.
    expect(copies[1].x - copies[0].x).toBe(b.x - a.x);
  });

  it('offers Ungroup only when the selection is one whole group', () => {
    const [a, b, c] = withObjects(
      fakeObject({ id: 'a', groupId: 'g1' }),
      fakeObject({ id: 'b', groupId: 'g1' }),
      fakeObject({ id: 'c' }),
    );
    tools.select(layer, a);
    expect(tools.sharedGroup()).toBe('g1');
    pick(a, b, c);
    expect(tools.sharedGroup()).toBeNull();
  });

  it('resizes a selection from its top-left corner, keeping each asset in its place', () => {
    // Two 16 x 32 assets side by side, one square apart: a box 48 wide.
    const [a, b] = withObjects(fakeObject({ id: 'a', x: 40, y: 48 }), fakeObject({ id: 'b', x: 72, y: 48 }));
    pick(a, b);
    const box = tools.selectionBox()!;
    expect(box).toEqual({ x: 32, y: 32, w: 48, h: 32 });
    tools.beginGroupScale();
    tools.beginGesture();
    tools.scaleSelection(2);
    expect(a.scale).toBe(2);
    expect(b.scale).toBe(2);
    // The corner stays put and the gap doubles along with everything else.
    expect(a.x - 16).toBe(32);
    expect(a.y - 32).toBe(32);
    expect(b.x - 16).toBe(32 + 64);
    tools.endGesture('Resize');
    store.history.undo();
    const restored = (store.doc.layers.find((l) => l.id === layer.id) as ObjectLayer).objects;
    expect(restored.map((o) => o.scale)).toEqual([1, 1]);
  });
});
