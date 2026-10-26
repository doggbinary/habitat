import {
  createObjectLayer,
  isObjectLayer,
  objectSize,
  uid,
  type AssetRect,
  type MapObject,
  type ObjectLayer,
} from '../core/doc';
import { snapshot, type DocSnapshot } from '../core/history';
import type { Camera, Store } from '../core/store';
import type { Renderer } from '../render/renderer';
/** Smallest and largest an object may be scaled to. */
export const MIN_SCALE = 0.1;
export const MAX_SCALE = 16;

/** Drawn radius of the resize grip, and the more forgiving radius for hitting it. */
export const HANDLE_RADIUS = 11;
export const HANDLE_HIT = 26;

/** An object's bounds on screen, in CSS pixels. */
export function objectScreenRect(camera: Camera, obj: MapObject): { x: number; y: number; w: number; h: number } {
  const { w, h } = objectSize(obj);
  return {
    x: (obj.x - w / 2 - camera.x) * camera.zoom,
    y: (obj.y - h / 2 - camera.y) * camera.zoom,
    w: w * camera.zoom,
    h: h * camera.zoom,
  };
}

/**
 * A centre for a box of this size whose left and top edges sit on whole
 * world pixels, so its art pixels line up with the tiles around it.
 */
export function onWholePixels(w: number, h: number, x: number, y: number): { x: number; y: number } {
  return { x: Math.round(x - w / 2) + w / 2, y: Math.round(y - h / 2) + h / 2 };
}

/** How many map squares a length covers, and never fewer than one. */
export function gridSquares(pixels: number, tile: number): number {
  if (tile <= 0) return 1;
  return Math.max(1, Math.round(pixels / tile));
}

/**
 * Scale that makes the longer side of the art an exact number of map squares.
 * A tree then grows from one square to two, then three, and never sits between them.
 */
export function gridScale(rectW: number, rectH: number, requested: number, tile: number): number {
  const wide = Math.max(rectW, rectH, 1);
  const squares = gridSquares(wide * Math.max(0, requested), tile);
  const next = (squares * tile) / wide;
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, next));
}

/**
 * Scale that puts the bottom-right corner on the pointer, measured from the
 * top-left corner captured when the drag began.
 *
 * The live centre cannot be used. Snapping onto the grid moves it toward the
 * pointer, and the next sample would ask for the old size.
 */
export function scaleFromCorner(
  startScale: number,
  startW: number,
  startH: number,
  anchorX: number,
  anchorY: number,
  pointerX: number,
  pointerY: number,
): number {
  const sx = startW > 0 ? (pointerX - anchorX) / startW : 0;
  const sy = startH > 0 ? (pointerY - anchorY) / startH : 0;
  return startScale * Math.max(sx, sy, 0);
}

/**
 * Pulls a box back inside the map. A box bigger than the map is centred,
 * because it cannot sit fully inside.
 */
export function clampInsideMap(obj: MapObject, mapW: number, mapH: number): void {
  const { w, h } = objectSize(obj);
  const left = w >= mapW ? (mapW - w) / 2 : Math.max(0, Math.min(mapW - w, obj.x - w / 2));
  const top = h >= mapH ? (mapH - h) / 2 : Math.max(0, Math.min(mapH - h, obj.y - h / 2));
  obj.x = left + w / 2;
  obj.y = top + h / 2;
}

/** Centre of a box whose top-left corner sits on a grid line. */
export function snapToGrid(w: number, h: number, x: number, y: number, tile: number): { x: number; y: number } {
  if (tile <= 0) return { x, y };
  const left = Math.round((x - w / 2) / tile) * tile;
  const top = Math.round((y - h / 2) / tile) * tile;
  return { x: left + w / 2, y: top + h / 2 };
}

/** True when two placed assets cover some of the same ground. */
export function overlaps(a: MapObject, b: MapObject): boolean {
  const sa = objectSize(a);
  const sb = objectSize(b);
  return Math.abs(a.x - b.x) * 2 < sa.w + sb.w && Math.abs(a.y - b.y) * 2 < sa.h + sb.h;
}

/** The resize grip sits on the bottom-right corner, where a thumb expects it. */
export function objectHandlePoint(camera: Camera, obj: MapObject): { x: number; y: number } {
  const r = objectScreenRect(camera, obj);
  return { x: r.x + r.w, y: r.y + r.h };
}

/**
 * Edits to placed objects.
 *
 * Continuous gestures (dragging, pinching, dragging the colour wheel) apply
 * live and record one undo step when they end. One-shot actions such as
 * flipping record their own step immediately.
 */
export class ObjectTools {
  private gestureBefore: DocSnapshot | null = null;

  constructor(
    private readonly store: Store,
    private readonly renderer: Renderer,
  ) {}

  private get doc() {
    return this.store.doc;
  }

  // --- Lookup --------------------------------------------------------------

  selected(): { layer: ObjectLayer; obj: MapObject } | null {
    const sel = this.store.selectedObject;
    if (!sel) return null;
    const layer = this.doc.layers.find((l) => l.id === sel.layerId);
    if (!isObjectLayer(layer)) return null;
    const obj = layer.objects.find((o) => o.id === sel.objectId);
    return obj ? { layer, obj } : null;
  }

  /** Topmost object under a world point, searching front to back. */
  hitTest(wx: number, wy: number, pad = 0): { layer: ObjectLayer; obj: MapObject } | null {
    const layers = this.doc.layers;
    for (let li = layers.length - 1; li >= 0; li--) {
      const layer = layers[li];
      if (!isObjectLayer(layer) || !layer.visible || layer.locked) continue;
      for (let oi = layer.objects.length - 1; oi >= 0; oi--) {
        const obj = layer.objects[oi];
        const { w, h } = objectSize(obj);
        if (Math.abs(wx - obj.x) <= w / 2 + pad && Math.abs(wy - obj.y) <= h / 2 + pad) return { layer, obj };
      }
    }
    return null;
  }

  select(layer: ObjectLayer, obj: MapObject): void {
    const members = obj.groupId ? this.withGroup(obj.groupId) : [{ layer, obj }];
    this.store.selectedObject = { layerId: layer.id, objectId: obj.id };
    this.store.selectedGroup = members.map((member) => ({ layerId: member.layer.id, objectId: member.obj.id }));
    this.store.emit('ui');
    this.renderer.requestDraw();
  }

  /** Box-select. Replaces whatever was selected. */
  selectMany(hits: { layer: ObjectLayer; obj: MapObject }[]): void {
    if (hits.length === 0) {
      this.deselect();
      return;
    }
    this.store.selectedObject = { layerId: hits[0].layer.id, objectId: hits[0].obj.id };
    this.store.selectedGroup = hits.map((hit) => ({ layerId: hit.layer.id, objectId: hit.obj.id }));
    this.store.emit('ui');
    this.renderer.requestDraw();
  }

  /** Whether an asset is part of the current selection. */
  isSelected(obj: MapObject): boolean {
    return this.store.selectedGroup.some((sel) => sel.objectId === obj.id) || this.store.selectedObject?.objectId === obj.id;
  }

  /**
   * Adds an asset (with its group) to the selection, or takes it out if it
   * is already in, so several can be recoloured or moved together.
   */
  toggleInSelection(layer: ObjectLayer, obj: MapObject): void {
    const members = obj.groupId ? this.withGroup(obj.groupId) : [{ layer, obj }];
    const ids = new Set(members.map((member) => member.obj.id));
    let group = this.store.selectedGroup.length
      ? [...this.store.selectedGroup]
      : this.store.selectedObject
        ? [this.store.selectedObject]
        : [];
    if (this.isSelected(obj)) {
      group = group.filter((sel) => !ids.has(sel.objectId));
    } else {
      group.push(...members.map((member) => ({ layerId: member.layer.id, objectId: member.obj.id })));
    }
    if (group.length === 0) {
      this.deselect();
      return;
    }
    this.store.selectedGroup = group;
    if (!this.store.selectedObject || !group.some((sel) => sel.objectId === this.store.selectedObject?.objectId)) {
      this.store.selectedObject = group[0];
    }
    this.store.emit('ui');
    this.renderer.requestDraw();
  }

  deselect(): void {
    if (!this.store.selectedObject && this.store.selectedGroup.length === 0) return;
    this.store.addingToSelection = false;
    this.store.selectedObject = null;
    this.store.selectedGroup = [];
    this.store.alignLines = null;
    this.store.emit('ui');
    this.renderer.requestDraw();
  }

  /** Placed assets whose boxes meet a tile rectangle. */
  inRect(rect: { x0: number; y0: number; x1: number; y1: number }): { layer: ObjectLayer; obj: MapObject }[] {
    const tile = this.doc.tileSize;
    const left = Math.min(rect.x0, rect.x1) * tile;
    const right = (Math.max(rect.x0, rect.x1) + 1) * tile;
    const top = Math.min(rect.y0, rect.y1) * tile;
    const bottom = (Math.max(rect.y0, rect.y1) + 1) * tile;
    const hits: { layer: ObjectLayer; obj: MapObject }[] = [];
    for (const layer of this.doc.layers) {
      if (!isObjectLayer(layer) || !layer.visible || layer.locked) continue;
      for (const obj of layer.objects) {
        const { w, h } = objectSize(obj);
        const overlaps =
          obj.x + w / 2 > left && obj.x - w / 2 < right && obj.y + h / 2 > top && obj.y - h / 2 < bottom;
        if (overlaps) hits.push({ layer, obj });
      }
    }
    return hits;
  }

  selectedMany(): { layer: ObjectLayer; obj: MapObject }[] {
    const out: { layer: ObjectLayer; obj: MapObject }[] = [];
    for (const sel of this.store.selectedGroup) {
      const layer = this.doc.layers.find((item) => item.id === sel.layerId);
      if (!isObjectLayer(layer)) continue;
      const obj = layer.objects.find((item) => item.id === sel.objectId);
      if (obj) out.push({ layer, obj });
    }
    return out;
  }

  private withGroup(groupId: string): { layer: ObjectLayer; obj: MapObject }[] {
    const out: { layer: ObjectLayer; obj: MapObject }[] = [];
    for (const layer of this.doc.layers) {
      if (!isObjectLayer(layer)) continue;
      for (const obj of layer.objects) if (obj.groupId === groupId) out.push({ layer, obj });
    }
    return out;
  }

  /** Moves the asset under the finger and anything else in the selection by the same amount. */
  moveSelected(anchor: MapObject, wx: number, wy: number): void {
    if (anchor.locked) return;
    const beforeX = anchor.x;
    const beforeY = anchor.y;
    const { w, h } = objectSize(anchor);
    const next = this.aligned(w, h, wx, wy, anchor.id);
    anchor.x = next.x;
    anchor.y = next.y;
    this.keepOnMap(anchor);
    const dx = anchor.x - beforeX;
    const dy = anchor.y - beforeY;
    for (const { obj } of this.selectedMany()) {
      if (obj === anchor || obj.locked) continue;
      obj.x += dx;
      obj.y += dy;
    }
    this.renderer.requestDraw();
  }

  groupSelected(): void {
    const members = this.selectedMany().filter((member) => !member.obj.locked);
    if (members.length < 2) return;
    const before = snapshot(this.doc);
    const groupId = uid('group');
    for (const member of members) member.obj.groupId = groupId;
    this.store.history.commitSnapshot('Group', before);
    this.store.selectedGroup = members.map((member) => ({ layerId: member.layer.id, objectId: member.obj.id }));
    this.store.changed();
    this.renderer.requestDraw();
    this.store.toast(`Grouped ${members.length}`);
  }

  ungroupSelected(): void {
    const members = this.selectedMany();
    if (members.length === 0) return;
    const before = snapshot(this.doc);
    for (const member of members) delete member.obj.groupId;
    this.store.history.commitSnapshot('Ungroup', before);
    this.store.changed();
    this.renderer.requestDraw();
    this.store.toast('Ungrouped');
  }

  // --- Placing -------------------------------------------------------------

  /**
   * The layer new objects go on: the active one if it holds objects, else
   * the topmost object layer, else a fresh one on top of everything, so a
   * dropped asset always lands in front of the ground.
   */
  private targetLayer(): ObjectLayer {
    const doc = this.doc;
    const active = doc.layers[doc.activeLayer];
    if (isObjectLayer(active) && !active.locked) return active;
    for (let i = doc.layers.length - 1; i >= 0; i--) {
      const layer = doc.layers[i];
      if (isObjectLayer(layer) && !layer.locked) return layer;
    }
    const layer = createObjectLayer();
    doc.layers.push(layer);
    return layer;
  }

  /**
   * Places an asset centred on a world point. Its starting size matches how
   * tiles from the same sheet are drawn, so a prop sits at the scale of the
   * ground it came alongside.
   */
  place(tilesetId: string, rect: AssetRect, wx: number, wy: number): void {
    const sheet = this.doc.tilesets.find((t) => t.id === tilesetId);
    const base = sheet && sheet.tileW > 0 ? this.doc.tileSize / sheet.tileW : 1;
    const scale = gridScale(rect.w, rect.h, base, this.doc.tileSize);

    const before = snapshot(this.doc);
    const layer = this.targetLayer();
    const at = snapToGrid(rect.w * scale, rect.h * scale, wx, wy, this.doc.tileSize);
    this.store.alignLines = null;
    const obj: MapObject = {
      id: uid('obj'),
      tilesetId,
      rect: { ...rect },
      x: at.x,
      y: at.y,
      scale,
      rotation: 0,
      flipX: false,
      flipY: false,
      hueShift: 0,
      saturation: 1,
      brightness: 1,
    };
    this.keepOnMap(obj);
    layer.objects.push(obj);
    this.doc.activeLayer = this.doc.layers.indexOf(layer);
    this.store.history.commitSnapshot('Place asset', before);
    this.store.selectedObject = { layerId: layer.id, objectId: obj.id };
    this.store.restructured();
    this.renderer.requestDraw();
  }

  // --- Continuous gestures -------------------------------------------------

  beginGesture(): void {
    this.gestureBefore = snapshot(this.doc);
  }

  /** Records the gesture as one undo step, if anything actually changed. */
  endGesture(label: string): void {
    const before = this.gestureBefore;
    this.gestureBefore = null;
    this.store.alignLines = null;
    if (!before) return;
    this.store.history.commitSnapshot(label, before);
    this.store.changed();
  }

  cancelGesture(): void {
    this.gestureBefore = null;
    this.store.alignLines = null;
  }

  /** Puts objects back where the gesture started and drops the undo step. */
  revertGesture(): void {
    const before = this.gestureBefore;
    this.gestureBefore = null;
    this.store.alignLines = null;
    if (!before) return;
    for (const layer of this.doc.layers) {
      if (!isObjectLayer(layer)) continue;
      const saved = before.layers.find((item) => item.id === layer.id);
      if (!saved || saved.kind !== 'objects') continue;
      layer.objects = saved.objects.map((obj) => ({ ...obj, rect: { ...obj.rect } }));
    }
    this.renderer.requestDraw();
  }

  toggleLock(): void {
    const found = this.selected();
    if (!found) return;
    const locking = !found.obj.locked;
    this.apply(locking ? 'Lock' : 'Unlock', (_, obj) => {
      obj.locked = locking;
    });
    this.store.toast(locking ? 'Locked' : 'Unlocked');
  }

  moveTo(obj: MapObject, wx: number, wy: number): void {
    if (obj.locked) return;
    const { w, h } = objectSize(obj);
    const next = this.aligned(w, h, wx, wy, obj.id);
    obj.x = next.x;
    obj.y = next.y;
    this.renderer.requestDraw();
  }

  /**
   * Where a box of this size should sit: its top-left corner on a grid line,
   * so every object occupies whole squares.
   */
  aligned(w: number, h: number, x: number, y: number, ignoreId?: string): { x: number; y: number } {
    void ignoreId;
    this.store.alignLines = null;
    return snapToGrid(w, h, x, y, this.doc.tileSize);
  }

  /**
   * Grows or shrinks in whole map squares, measured on the longer side.
   * The corner of the box stays on a grid line.
   */
  scaleTo(obj: MapObject, scale: number): void {
    if (obj.locked) return;
    const clamped = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale));
    const next = gridScale(obj.rect.w, obj.rect.h, clamped, this.doc.tileSize);
    if (next === obj.scale) return;
    const size = objectSize({ ...obj, scale: next });
    const at = snapToGrid(size.w, size.h, obj.x, obj.y, this.doc.tileSize);
    obj.scale = next;
    obj.x = at.x;
    obj.y = at.y;
    this.keepOnMap(obj);
    this.renderer.requestDraw();
    this.store.emit('ui');
  }

  /** One map square bigger or smaller, measured on the longer side. */
  stepSize(obj: MapObject, squares: number): void {
    const tile = this.doc.tileSize;
    const wide = Math.max(obj.rect.w, obj.rect.h, 1);
    const now = gridSquares(wide * obj.scale, tile);
    this.scaleTo(obj, (Math.max(1, now + squares) * tile) / wide);
  }

  private keepOnMap(obj: MapObject): void {
    clampInsideMap(obj, this.doc.width * this.doc.tileSize, this.doc.height * this.doc.tileSize);
  }

  /** Every unlocked asset in the selection, or just the selected one. */
  recolorable(): MapObject[] {
    const many = this.selectedMany().map((member) => member.obj);
    const found = this.selected();
    const all = many.length > 0 ? many : found ? [found.obj] : [];
    return all.filter((obj) => !obj.locked);
  }

  setColor(obj: MapObject, color: { hueShift: number; saturation: number; brightness: number }): void {
    obj.hueShift = color.hueShift;
    obj.saturation = color.saturation;
    obj.brightness = color.brightness;
    this.renderer.requestDraw();
  }

  // --- One-shot actions ----------------------------------------------------

  private apply(label: string, mutate: (layer: ObjectLayer, obj: MapObject) => void): void {
    const found = this.selected();
    if (!found) return;
    if (found.obj.locked && label !== 'Lock' && label !== 'Unlock') return;
    const before = snapshot(this.doc);
    mutate(found.layer, found.obj);
    this.store.history.commitSnapshot(label, before);
    this.store.changed();
    this.renderer.requestDraw();
  }

  /**
   * Replaces the selected asset's art with another, keeping where it stands,
   * which way it faces and its place in front-to-back order. Size carries
   * over relative to each sheet's tiles, so swapping between sheets drawn at
   * different scales still matches the map. The colour resets, since a tint
   * picked for one asset rarely suits another.
   */
  swap(tilesetId: string, rect: AssetRect): void {
    const found = this.selected();
    if (!found) return;
    const base = (id: string) => {
      const sheet = this.doc.tilesets.find((t) => t.id === id);
      return sheet && sheet.tileW > 0 ? this.doc.tileSize / sheet.tileW : 1;
    };
    const scale = found.obj.scale * (base(tilesetId) / base(found.obj.tilesetId));
    this.apply('Swap asset', (_, obj) => {
      obj.tilesetId = tilesetId;
      obj.rect = { ...rect };
      obj.scale = scale;
      obj.hueShift = 0;
      obj.saturation = 1;
      obj.brightness = 1;
    });
  }

  rotate(): void {
    this.apply('Rotate', (_, obj) => {
      obj.rotation = (obj.rotation + 1) % 4;
    });
  }

  /**
   * Mirrors across the screen. Once an object is turned a quarter, its own
   * horizontal axis points up the screen, so the flags swap to keep "across"
   * meaning across.
   */
  flipAcross(): void {
    this.apply('Flip', (_, obj) => {
      if (obj.rotation % 2 === 1) obj.flipY = !obj.flipY;
      else obj.flipX = !obj.flipX;
    });
  }

  flipDown(): void {
    this.apply('Flip', (_, obj) => {
      if (obj.rotation % 2 === 1) obj.flipX = !obj.flipX;
      else obj.flipY = !obj.flipY;
    });
  }

  resetColor(): void {
    this.apply('Reset colour', (_, obj) => {
      obj.hueShift = 0;
      obj.saturation = 1;
      obj.brightness = 1;
    });
  }

  /** Steps one place forward among the objects on the same layer. */
  bringForward(): void {
    this.reorder(1);
  }

  sendBackward(): void {
    this.reorder(-1);
  }

  bringToFront(): void {
    this.reorder(1, true);
  }

  sendToBack(): void {
    this.reorder(-1, true);
  }

  /**
   * Where one step forward or back would put the selected asset, or -1 when
   * nothing overlaps it on that side.
   *
   * A step passes the next asset that actually overlaps it, not merely the
   * next one in the list. Passing an asset across the map changes nothing
   * you can see, and a button that looks broken is worse than none.
   */
  private stepTarget(delta: 1 | -1): number {
    const found = this.selected();
    if (!found) return -1;
    const { layer, obj } = found;
    const index = layer.objects.indexOf(obj);
    for (let i = index + delta; i >= 0 && i < layer.objects.length; i += delta) {
      if (overlaps(obj, layer.objects[i])) return i;
    }
    return -1;
  }

  /** True when moving the selected asset that way would change what you see. */
  canReorder(delta: 1 | -1): boolean {
    return this.stepTarget(delta) !== -1;
  }

  private reorder(delta: 1 | -1, all = false): void {
    const found = this.selected();
    if (!found) return;
    const { layer, obj } = found;
    const index = layer.objects.indexOf(obj);
    const step = this.stepTarget(delta);
    if (step === -1) {
      // Say so instead of silently doing nothing.
      this.store.toast(delta > 0 ? 'Nothing in front of it' : 'Nothing behind it');
      return;
    }
    const target = all ? (delta > 0 ? layer.objects.length - 1 : 0) : step;
    const label = all ? (delta > 0 ? 'Bring to front' : 'Send to back') : delta > 0 ? 'Bring forward' : 'Send backward';
    this.apply(label, (l) => {
      l.objects.splice(index, 1);
      l.objects.splice(target, 0, obj);
    });
  }

  duplicate(): void {
    const found = this.selected();
    if (!found) return;
    const before = snapshot(this.doc);
    const { w, h } = objectSize(found.obj);
    // Offset the copy so it is visibly a second object, not hidden on top. It
    // is its own object: no shared group, so it never drags the original along.
    const { groupId: _group, ...rest } = found.obj;
    void _group;
    const at = snapToGrid(w, h, found.obj.x + Math.max(this.doc.tileSize, Math.round(w / 3)), found.obj.y, this.doc.tileSize);
    const copy: MapObject = {
      ...rest,
      id: uid('obj'),
      rect: { ...found.obj.rect },
      x: at.x,
      y: at.y,
      locked: false,
    };
    this.keepOnMap(copy);
    const index = found.layer.objects.indexOf(found.obj);
    found.layer.objects.splice(index + 1, 0, copy);
    this.store.history.commitSnapshot('Duplicate', before);
    this.store.selectedGroup = [];
    this.store.selectedObject = { layerId: found.layer.id, objectId: copy.id };
    this.store.changed();
    this.renderer.requestDraw();
  }

  remove(): void {
    const found = this.selected();
    if (!found) return;
    const before = snapshot(this.doc);
    found.layer.objects = found.layer.objects.filter((o) => o !== found.obj);
    this.store.history.commitSnapshot('Delete asset', before);
    this.store.selectedObject = null;
    this.store.changed();
    this.renderer.requestDraw();
    this.store.toast('Deleted');
  }
}
