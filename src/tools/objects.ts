import {
  createObjectLayer,
  isObjectLayer,
  objectSize,
  spanOffset,
  spanSquares,
  uid,
  type AssetRect,
  type Doc,
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
 * Lets an object hang off the edge of the map, keeping at least one of the
 * squares it covers on the map so it can still be reached. The limits apply
 * to those whole squares and fall on grid lines, so art centred in its
 * squares stays centred and the part left on the map still lines up.
 */
export function keepTouchingMap(obj: MapObject, mapW: number, mapH: number, tile: number): void {
  const { w, h } = objectSize(obj);
  const axis = (artStart: number, size: number, map: number) => {
    const span = spanSquares(size, tile) * tile;
    const offset = spanOffset(size, tile);
    const keep = Math.min(tile, span, map);
    const min = Math.ceil((keep - span) / tile) * tile;
    const max = Math.floor((map - keep) / tile) * tile;
    return Math.max(min, Math.min(max, artStart - offset)) + offset;
  };
  obj.x = axis(obj.x - w / 2, w, mapW) + w / 2;
  obj.y = axis(obj.y - h / 2, h, mapH) + h / 2;
}

/**
 * Lines every unlocked object up with the grid: whole squares on its longer
 * side, centred in the squares it covers. Returns how many moved or changed size.
 */
export function lineUpObjects(doc: Doc): number {
  const tile = doc.tileSize;
  let changed = 0;
  for (const layer of doc.layers) {
    if (layer.kind !== 'objects') continue;
    for (const obj of layer.objects) {
      if (obj.locked) continue;
      const scale = gridScale(obj.rect.w, obj.rect.h, obj.scale, tile);
      const { w, h } = objectSize({ ...obj, scale });
      const at = snapToGrid(w, h, obj.x, obj.y, tile);
      if (scale === obj.scale && at.x === obj.x && at.y === obj.y) continue;
      obj.scale = scale;
      obj.x = at.x;
      obj.y = at.y;
      changed += 1;
    }
  }
  return changed;
}

/**
 * Centre for art of this size, centred in the whole squares it covers. Art
 * rarely fills its squares exactly, and pushed into a corner it leans: two
 * posts either side of a path would not mirror each other, and a door would
 * sit to one side of the path below it.
 */
export function snapToGrid(w: number, h: number, x: number, y: number, tile: number): { x: number; y: number } {
  if (tile <= 0) return { x, y };
  const axis = (centre: number, size: number) => {
    const span = spanSquares(size, tile) * tile;
    const start = Math.round((centre - span / 2) / tile) * tile;
    return start + spanOffset(size, tile) + size / 2;
  };
  return { x: axis(x, w), y: axis(y, h) };
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

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The box around several assets, in world pixels. */
export function boundsOf(objs: MapObject[]): Box | null {
  if (objs.length === 0) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const obj of objs) {
    const { w, h } = objectSize(obj);
    left = Math.min(left, obj.x - w / 2);
    top = Math.min(top, obj.y - h / 2);
    right = Math.max(right, obj.x + w / 2);
    bottom = Math.max(bottom, obj.y + h / 2);
  }
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/** A world box on screen, in CSS pixels. */
export function boxScreenRect(camera: Camera, box: Box): Box {
  return {
    x: (box.x - camera.x) * camera.zoom,
    y: (box.y - camera.y) * camera.zoom,
    w: box.w * camera.zoom,
    h: box.h * camera.zoom,
  };
}

/** Where each asset starts when a whole selection is resized. */
export interface GroupScaleStart {
  box: Box;
  items: { obj: MapObject; scale: number; left: number; top: number }[];
}

export function groupScaleStart(objs: MapObject[]): GroupScaleStart | null {
  const box = boundsOf(objs);
  if (!box) return null;
  return {
    box,
    items: objs.map((obj) => {
      const { w, h } = objectSize(obj);
      return { obj, scale: obj.scale, left: obj.x - w / 2, top: obj.y - h / 2 };
    }),
  };
}

/**
 * Resizes a selection as one picture, from its top-left corner. The factor
 * is rounded so the longer side of the whole box is a whole number of map
 * squares, and every asset keeps its place within the box.
 */
export function scaleGroup(start: GroupScaleStart, factor: number, tile: number): void {
  const { box } = start;
  const wide = Math.max(box.w, box.h, 1);
  const squares = gridSquares(wide * Math.max(0, factor), tile);
  const smallest = Math.min(...start.items.map((item) => item.scale));
  const largest = Math.max(...start.items.map((item) => item.scale));
  const f = Math.max(MIN_SCALE / smallest, Math.min(MAX_SCALE / largest, (squares * tile) / wide));
  for (const item of start.items) {
    if (item.obj.locked) continue;
    item.obj.scale = item.scale * f;
    const { w, h } = objectSize(item.obj);
    const left = box.x + (item.left - box.x) * f;
    const top = box.y + (item.top - box.y) * f;
    const at = snapToGrid(w, h, left + w / 2, top + h / 2, tile);
    item.obj.x = at.x;
    item.obj.y = at.y;
  }
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

  /** What an action applies to: everything selected, or the one selected asset. */
  members(): { layer: ObjectLayer; obj: MapObject }[] {
    const many = this.selectedMany();
    if (many.length > 0) return many;
    const found = this.selected();
    return found ? [found] : [];
  }

  /** The box drawn around a selection of more than one asset, in world pixels. */
  selectionBox(): Box | null {
    const members = this.members();
    return members.length > 1 ? boundsOf(members.map((member) => member.obj)) : null;
  }

  /** The screen point of the resize grip: the selection box's corner, or the asset's. */
  handlePoint(): { x: number; y: number } | null {
    const box = this.selectionBox();
    if (box) {
      const r = boxScreenRect(this.store.camera, box);
      return { x: r.x + r.w, y: r.y + r.h };
    }
    const found = this.selected();
    return found ? objectHandlePoint(this.store.camera, found.obj) : null;
  }

  /** The group id every selected asset shares, when they are exactly one group. */
  sharedGroup(): string | null {
    const members = this.members();
    const id = members[0]?.obj.groupId;
    if (!id || members.length < 2) return null;
    return members.every((member) => member.obj.groupId === id) ? id : null;
  }

  private groupScale: GroupScaleStart | null = null;

  /** Remembers where every selected asset starts, for resizing them together. */
  beginGroupScale(): void {
    this.groupScale = groupScaleStart(this.members().map((member) => member.obj));
  }

  /** Resizes the whole selection by a factor of its size when the gesture began. */
  scaleSelection(factor: number): void {
    if (!this.groupScale) return;
    scaleGroup(this.groupScale, factor, this.doc.tileSize);
    this.renderer.requestDraw();
    this.store.emit('ui');
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
    this.groupScale = null;
    this.store.alignLines = null;
    if (!before) return;
    this.store.history.commitSnapshot(label, before);
    this.store.changed();
  }

  cancelGesture(): void {
    this.gestureBefore = null;
    this.groupScale = null;
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
   * Where a box of this size should sit: centred in the whole squares it
   * covers, so every object occupies whole squares.
   */
  aligned(w: number, h: number, x: number, y: number, ignoreId?: string): { x: number; y: number } {
    void ignoreId;
    this.store.alignLines = null;
    return snapToGrid(w, h, x, y, this.doc.tileSize);
  }

  /**
   * Grows or shrinks in whole map squares, measured on the longer side.
   * The art stays centred in the squares it covers.
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
    const tile = this.doc.tileSize;
    keepTouchingMap(obj, this.doc.width * tile, this.doc.height * tile, tile);
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

  /** Contrast (1 is unchanged) and clarity (0 is unchanged), kept off the object when neutral. */
  setTone(obj: MapObject, tone: { contrast?: number; clarity?: number }): void {
    if (tone.contrast !== undefined) {
      if (tone.contrast === 1) delete obj.contrast;
      else obj.contrast = tone.contrast;
    }
    if (tone.clarity !== undefined) {
      if (tone.clarity === 0) delete obj.clarity;
      else obj.clarity = tone.clarity;
    }
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
      delete obj.contrast;
      delete obj.clarity;
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
      delete obj.contrast;
      delete obj.clarity;
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

  /**
   * Copies everything selected, offset beside the originals so the copies
   * are visibly new, and selects the copies. Copies never share a group with
   * the originals, so moving one never drags the other along; a copied group
   * becomes a group of its own.
   */
  duplicate(): void {
    const members = this.members();
    if (members.length === 0) return;
    const before = snapshot(this.doc);
    const tile = this.doc.tileSize;
    const box = boundsOf(members.map((member) => member.obj))!;
    const dx = Math.max(tile, Math.round(box.w / (members.length > 1 ? 1 : 3) / tile) * tile);
    const newGroups = new Map<string, string>();
    const copies: { layerId: string; objectId: string }[] = [];
    const shared = (id: string) => members.filter((member) => member.obj.groupId === id).length > 1;
    for (const { layer, obj } of members) {
      const { w, h } = objectSize(obj);
      const { groupId, ...rest } = obj;
      let group: string | undefined;
      if (groupId && shared(groupId)) {
        group = newGroups.get(groupId) ?? uid('group');
        newGroups.set(groupId, group);
      }
      const at = snapToGrid(w, h, obj.x + dx, obj.y, tile);
      const copy: MapObject = {
        ...rest,
        ...(group ? { groupId: group } : {}),
        id: uid('obj'),
        rect: { ...obj.rect },
        x: at.x,
        y: at.y,
        locked: false,
      };
      if (members.length === 1) this.keepOnMap(copy);
      const index = layer.objects.indexOf(obj);
      layer.objects.splice(index + 1, 0, copy);
      copies.push({ layerId: layer.id, objectId: copy.id });
    }
    this.store.history.commitSnapshot(members.length > 1 ? `Duplicate ${members.length}` : 'Duplicate', before);
    this.store.selectedObject = copies[0];
    this.store.selectedGroup = copies.length > 1 ? copies : [];
    this.store.changed();
    this.renderer.requestDraw();
  }

  /** Deletes everything selected that is not locked, as one undo step. */
  remove(): void {
    const members = this.members();
    if (members.length === 0) return;
    const doomed = new Set(members.filter((member) => !member.obj.locked).map((member) => member.obj));
    if (doomed.size === 0) {
      this.store.toast('Unlock it to delete');
      return;
    }
    const before = snapshot(this.doc);
    for (const layer of this.doc.layers) {
      if (isObjectLayer(layer)) layer.objects = layer.objects.filter((o) => !doomed.has(o));
    }
    this.store.history.commitSnapshot(doomed.size > 1 ? `Delete ${doomed.size}` : 'Delete asset', before);
    this.store.selectedObject = null;
    this.store.selectedGroup = [];
    this.store.changed();
    this.renderer.requestDraw();
    this.store.toast(doomed.size > 1 ? `Deleted ${doomed.size}` : 'Deleted');
  }
}
