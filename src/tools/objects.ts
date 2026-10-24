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
  hitTest(wx: number, wy: number): { layer: ObjectLayer; obj: MapObject } | null {
    const layers = this.doc.layers;
    for (let li = layers.length - 1; li >= 0; li--) {
      const layer = layers[li];
      if (!isObjectLayer(layer) || !layer.visible || layer.locked) continue;
      for (let oi = layer.objects.length - 1; oi >= 0; oi--) {
        const obj = layer.objects[oi];
        const { w, h } = objectSize(obj);
        if (Math.abs(wx - obj.x) <= w / 2 && Math.abs(wy - obj.y) <= h / 2) return { layer, obj };
      }
    }
    return null;
  }

  select(layer: ObjectLayer, obj: MapObject): void {
    this.store.selectedObject = { layerId: layer.id, objectId: obj.id };
    this.store.emit('ui');
    this.renderer.requestDraw();
  }

  deselect(): void {
    if (!this.store.selectedObject) return;
    this.store.selectedObject = null;
    this.store.emit('ui');
    this.renderer.requestDraw();
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
    const scale = sheet && sheet.tileW > 0 ? this.doc.tileSize / sheet.tileW : 1;

    const before = snapshot(this.doc);
    const layer = this.targetLayer();
    const obj: MapObject = {
      id: uid('obj'),
      tilesetId,
      rect: { ...rect },
      x: Math.round(wx),
      y: Math.round(wy),
      scale,
      rotation: 0,
      flipX: false,
      flipY: false,
      hueShift: 0,
      saturation: 1,
      brightness: 1,
    };
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
    if (!before) return;
    this.store.history.commitSnapshot(label, before);
    this.store.changed();
  }

  cancelGesture(): void {
    this.gestureBefore = null;
  }

  moveTo(obj: MapObject, wx: number, wy: number): void {
    obj.x = Math.round(wx);
    obj.y = Math.round(wy);
    this.renderer.requestDraw();
  }

  /**
   * Sets the size, nudging toward whole and half multiples when close.
   * Pixel art only looks crisp at those, so it is worth a gentle pull.
   */
  scaleTo(obj: MapObject, scale: number): void {
    let next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale));
    const nearestHalf = Math.round(next * 2) / 2;
    if (nearestHalf > 0 && Math.abs(next - nearestHalf) / nearestHalf < 0.05) next = nearestHalf;
    obj.scale = next;
    this.renderer.requestDraw();
    this.store.emit('ui');
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
    const before = snapshot(this.doc);
    mutate(found.layer, found.obj);
    this.store.history.commitSnapshot(label, before);
    this.store.changed();
    this.renderer.requestDraw();
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

  private reorder(delta: number): void {
    const found = this.selected();
    if (!found) return;
    const { layer, obj } = found;
    const index = layer.objects.indexOf(obj);
    const target = index + delta;

    if (target >= 0 && target < layer.objects.length) {
      this.apply(delta > 0 ? 'Bring forward' : 'Send backward', (l) => {
        l.objects.splice(index, 1);
        l.objects.splice(target, 0, obj);
      });
      return;
    }

    // Already at the front or back of its layer: there is nothing further in
    // this layer to pass, so say so instead of silently doing nothing.
    this.store.toast(delta > 0 ? 'Already in front' : 'Already at the back');
  }

  duplicate(): void {
    const found = this.selected();
    if (!found) return;
    const before = snapshot(this.doc);
    const { w } = objectSize(found.obj);
    // Offset the copy so it is visibly a second object, not hidden on top.
    const copy: MapObject = { ...found.obj, id: uid('obj'), rect: { ...found.obj.rect }, x: found.obj.x + Math.max(8, w / 3) };
    const index = found.layer.objects.indexOf(found.obj);
    found.layer.objects.splice(index + 1, 0, copy);
    this.store.history.commitSnapshot('Duplicate', before);
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
  }
}
