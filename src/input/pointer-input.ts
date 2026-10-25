import { tileIsGround } from '../core/assets';
import { EMPTY, indexOf, tilesetOf } from '../core/tiles';
import { isMovableImage, type ImageLayer, type MapObject } from '../core/doc';
import type { Shape, Store } from '../core/store';
import { clampZoom, screenToCell, screenToWorld, snapZoom, zoomAt } from '../render/camera';
import type { Renderer } from '../render/renderer';
import type { Editor } from '../tools/edit';
import { lineCells } from '../tools/geometry';
import { hitsHandle, scaleFromHandle, snapPlacement } from '../tools/image-transform';
import { HANDLE_HIT, objectHandlePoint, objectScreenRect, type ObjectTools } from '../tools/objects';

interface TrackedPointer {
  id: number;
  type: string;
  x: number;
  y: number;
  /** Where the pointer went down, kept for tap detection. */
  startX: number;
  startY: number;
  /** Previous sample, used for pan deltas. */
  lastX: number;
  lastY: number;
}

type Mode =
  | 'idle'
  | 'draw'
  | 'pan'
  | 'gesture'
  | 'image'
  | 'object-move'
  | 'object-scale'
  | 'object-pinch'
  | 'selection-rect'
  | 'selection-move';

/** A multi-finger tap only counts as a shortcut if it is quick and still. */
const TAP_MAX_MS = 320;
const TAP_MAX_MOVE = 12;
/** Window for the second tap of a double-tap. */
const DOUBLE_TAP_MS = 380;
/** How far from a selected object a pinch may start and still resize it. */
const PINCH_REACH = 90;

/**
 * Translates pointer events into editing and navigation.
 *
 * The rules that matter on an iPad:
 *  - The Apple Pencil draws, and grabs placed assets directly. While it is
 *    touching the glass every `touch` pointer is dropped, which is what makes
 *    palm rejection work.
 *  - Fingers navigate: one finger pans, two pinch to zoom. A tap selects an
 *    asset, and only an already-selected asset follows a finger drag, so a map
 *    full of trees can still be panned without grabbing one.
 *  - Pinching over a selected asset resizes it instead of zooming the map.
 *  - Two-finger tap undoes and three-finger tap redoes.
 */
export class PointerInput {
  private readonly pointers = new Map<number, TrackedPointer>();
  private mode: Mode = 'idle';
  private activeId: number | null = null;

  private penDown = false;
  private spaceHeld = false;

  /** Where the current single-finger touch began, for tap detection. */
  private tapStart: { clientX: number; clientY: number; x: number; y: number } | null = null;
  private lastTap: { time: number; cell: { x: number; y: number } } | null = null;
  /** The asset under a finger that went down, selected only if it was a tap. */
  private tapObject: MapObject | null = null;
  private tapObjectLayer: string | null = null;

  /** Called when a placed ground tile is double-tapped. */
  onDoubleTap: ((cell: { x: number; y: number }, clientX: number, clientY: number) => void) | null = null;

  /** Captured when a stroke starts so a mid-stroke tool change cannot confuse it. */
  private strokeShape: Shape = 'brush';
  private strokeErases = false;
  private lastCell: { x: number; y: number } | null = null;
  private anchorCell: { x: number; y: number } | null = null;

  /** Reference image being dragged, with its placement when the drag began. */
  private imageLayer: ImageLayer | null = null;
  private imageAction: 'move' | 'scale' = 'move';
  private imageStart = { x: 0, y: 0, w: 0, h: 0 };
  private imageGrabWorld = { x: 0, y: 0 };

  /** Offset from a held block's corner to the cell it was grabbed by. */
  private selectionGrab = { dx: 0, dy: 0 };

  /** Asset gesture state. */
  private grab = { dx: 0, dy: 0 };
  private objectMoved = false;
  private scaleStart = 1;
  private scaleStartDistance = 1;

  /** Pinch baseline, captured when the second finger lands. */
  private pinchDistance = 1;
  private pinchZoom = 1;
  private pinchMid = { x: 0, y: 0 };

  private wheelSettle: ReturnType<typeof setTimeout> | undefined;

  private gestureStart = 0;
  private gestureMaxFingers = 0;
  private gestureMoved = false;

  private rect: DOMRect;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly store: Store,
    private readonly editor: Editor,
    private readonly renderer: Renderer,
    private readonly objects: ObjectTools,
  ) {
    this.rect = canvas.getBoundingClientRect();

    canvas.addEventListener('pointerdown', this.onDown, { passive: false });
    canvas.addEventListener('pointermove', this.onMove, { passive: false });
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onCancel);
    canvas.addEventListener('pointerleave', this.onLeave);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    // A mouse click paints, so double-click only opens the tile menu from the
    // select tool, where a click on bare ground changes nothing.
    canvas.addEventListener('dblclick', (e) => {
      if (this.store.tool !== 'select' && this.store.tool !== 'pan') return;
      const { x, y } = this.local(e);
      this.onDoubleTap?.(this.cellAt(x, y), e.clientX, e.clientY);
    });

    // Safari fires these for pinches on the page itself; swallowing them stops
    // the whole app from zooming out from under the editor.
    for (const name of ['gesturestart', 'gesturechange', 'gestureend']) {
      canvas.addEventListener(name, (e) => e.preventDefault());
    }
  }

  setSpaceHeld(held: boolean): void {
    this.spaceHeld = held;
  }

  refreshRect(): void {
    this.rect = this.canvas.getBoundingClientRect();
  }

  private local(e: { clientX: number; clientY: number }) {
    return { x: e.clientX - this.rect.left, y: e.clientY - this.rect.top };
  }

  private cellAt(x: number, y: number) {
    return screenToCell(this.store.camera, this.store.doc, x, y);
  }

  private worldAt(x: number, y: number) {
    return screenToWorld(this.store.camera, x, y);
  }

  private touchCount(): number {
    let n = 0;
    for (const p of this.pointers.values()) if (p.type === 'touch') n += 1;
    return n;
  }

  // --- Assets --------------------------------------------------------------

  private onSelectedHandle(x: number, y: number): boolean {
    const found = this.objects.selected();
    if (!found) return false;
    const handle = objectHandlePoint(this.store.camera, found.obj);
    return Math.hypot(x - handle.x, y - handle.y) <= HANDLE_HIT;
  }

  /** True when a screen point is on or near the selected asset. */
  private nearSelected(x: number, y: number, reach: number): boolean {
    const found = this.objects.selected();
    if (!found) return false;
    const r = objectScreenRect(this.store.camera, found.obj);
    return x >= r.x - reach && x <= r.x + r.w + reach && y >= r.y - reach && y <= r.y + r.h + reach;
  }

  private startObjectMove(pointer: TrackedPointer, obj: MapObject): void {
    const world = this.worldAt(pointer.x, pointer.y);
    this.mode = 'object-move';
    this.activeId = pointer.id;
    this.grab = { dx: world.x - obj.x, dy: world.y - obj.y };
    this.objectMoved = false;
    this.objects.beginGesture();
  }

  private startObjectScale(pointer: TrackedPointer): void {
    const found = this.objects.selected();
    if (!found) return;
    const world = this.worldAt(pointer.x, pointer.y);
    this.mode = 'object-scale';
    this.activeId = pointer.id;
    this.scaleStart = found.obj.scale;
    this.scaleStartDistance = Math.max(1, Math.hypot(world.x - found.obj.x, world.y - found.obj.y));
    this.objects.beginGesture();
  }

  /**
   * Handles a press that lands on an asset, or on the selected asset's grip.
   * Returns false when the press missed every asset, so the caller can fall
   * through to the active tool.
   */
  private pressAsset(pointer: TrackedPointer, precise: boolean): boolean {
    if (this.spaceHeld || this.store.tool === 'pan') return false;

    if (this.onSelectedHandle(pointer.x, pointer.y)) {
      if (this.objects.selected()?.obj.locked) {
        this.store.toast('Unlock it to resize');
        return true;
      }
      this.startObjectScale(pointer);
      return true;
    }

    const world = this.worldAt(pointer.x, pointer.y);
    const hit = this.objects.hitTest(world.x, world.y);
    if (!hit) return false;
    this.editor.commitSelection();

    // The Pencil's eraser removes an asset outright. A finger is treated like
    // any other finger, since one resting on the map is too easy to do by
    // accident: a tap selects the asset, and Delete removes it.
    if (this.store.tool === 'eraser' && precise) {
      this.objects.select(hit.layer, hit.obj);
      if (hit.obj.locked) this.store.toast('Unlock it to delete');
      else this.objects.remove();
      this.mode = 'idle';
      this.activeId = pointer.id;
      return true;
    }

    if (hit.obj.locked) {
      this.objects.select(hit.layer, hit.obj);
      this.mode = 'idle';
      this.activeId = pointer.id;
      return true;
    }

    const isSelected = this.objects.isSelected(hit.obj);

    // Remember what a finger landed on, so a tap can select it on release and
    // a tap on the selected asset does not count as tapping bare map.
    if (!precise) {
      this.tapObject = hit.obj;
      this.tapObjectLayer = hit.layer.id;
    }

    // Building up a selection: the Pencil adds an asset on touch; a finger
    // does it on release, in case the touch turns into a pan.
    if (precise && this.store.addingToSelection && !isSelected) {
      this.objects.toggleInSelection(hit.layer, hit.obj);
      this.mode = 'idle';
      this.activeId = pointer.id;
      return true;
    }

    if (isSelected) {
      // Dragging any asset in the selection moves the whole selection with it.
      this.store.selectedObject = { layerId: hit.layer.id, objectId: hit.obj.id };
      this.startObjectMove(pointer, hit.obj);
      return true;
    }

    if (precise) {
      // The Pencil grabs at once; a finger only drags what is already chosen.
      this.objects.select(hit.layer, hit.obj);
      this.startObjectMove(pointer, hit.obj);
      return true;
    }

    // A finger on an unselected asset: a tap selects it, a drag pans.
    return false;
  }

  // --- Starting an interaction --------------------------------------------

  /** Resolves the shape a stroke should draw, folding in modifiers. */
  private resolveShape(penEraser: boolean): { shape: Shape | 'pan' | 'picker'; erases: boolean } {
    if (this.spaceHeld) return { shape: 'pan', erases: false };
    if (penEraser) return { shape: this.store.eraserShape, erases: true };
    const tool = this.store.tool;
    // `select` is handled before a stroke begins; it never paints.
    if (tool === 'pan' || tool === 'select') return { shape: 'pan', erases: false };
    if (tool === 'picker') return { shape: 'picker', erases: false };
    if (tool === 'eraser') return { shape: this.store.eraserShape, erases: true };
    return { shape: tool, erases: false };
  }

  private beginPan(pointer: TrackedPointer): void {
    this.mode = 'pan';
    this.activeId = pointer.id;
  }

  /**
   * A selected, unlocked reference image takes over the drag: there is nothing
   * to paint on an image layer, so the obvious gesture is to position it.
   */
  private startImageDrag(pointer: TrackedPointer, layer: ImageLayer): void {
    this.mode = 'image';
    this.activeId = pointer.id;
    this.imageLayer = layer;
    this.imageAction = hitsHandle(this.store.camera, layer, pointer.x, pointer.y) ? 'scale' : 'move';
    this.imageStart = { x: layer.x, y: layer.y, w: layer.w, h: layer.h };
    this.imageGrabWorld = this.worldAt(pointer.x, pointer.y);
    this.editor.beginImageTransform();
  }

  /**
   * A finger may paint only while a path square is the brush, and only with
   * "Finger paints paths" on. Objects are placed, not stroked, so picking a
   * bench must not turn the next touch into a draw. The eraser follows the
   * same switch, so a finger never wipes the map by surprise.
   */
  private fingerPaints(): boolean {
    if (this.spaceHeld || this.store.tool === 'pan' || this.store.tool === 'select') return false;
    if (!this.store.settings.fingerDraws) return false;
    const tool = this.store.tool;
    if (tool === 'eraser') return true;
    if (tool !== 'brush' && tool !== 'fill' && tool !== 'rect' && tool !== 'line') return false;
    return this.stampIsGround();
  }

  /** True when every square of the brush is a path or floor square. */
  private stampIsGround(): boolean {
    const { stamp, doc } = this.store;
    let any = false;
    for (const tile of stamp.tiles) {
      if (tile === EMPTY) continue;
      const sheet = doc.tilesets[tilesetOf(tile)];
      if (!sheet || !tileIsGround(sheet, indexOf(tile))) return false;
      any = true;
    }
    return any;
  }

  /** The Pencil, a mouse, or a drawing finger has touched down. */
  private startDraw(pointer: TrackedPointer, penEraser: boolean): void {
    // Placing the scale-test character takes priority: while that mode is on,
    // a tap moves the character rather than painting.
    const preview = this.store.characterPreview;
    if (preview.enabled && preview.placing) {
      const cell = this.cellAt(pointer.x, pointer.y);
      preview.tx = cell.x;
      preview.ty = cell.y;
      this.mode = 'idle';
      this.activeId = pointer.id;
      this.store.emit('view');
      this.renderer.requestDraw();
      return;
    }

    const paints =
      this.store.tool === 'brush' || this.store.tool === 'fill' || this.store.tool === 'rect' || this.store.tool === 'line';
    const touch = pointer.type === 'touch';
    if (!paints && this.pressAsset(pointer, !touch)) return;
    if (touch && this.store.tool === 'eraser') {
      // A finger erasing over a tree must not wipe the ground under it.
      const world = this.worldAt(pointer.x, pointer.y);
      if (this.objects.hitTest(world.x, world.y)) {
        this.mode = 'idle';
        this.activeId = pointer.id;
        return;
      }
    }
    // Pressing on bare map means you have moved on from the selected asset.
    this.objects.deselect();

    const active = this.store.doc.layers[this.store.doc.activeLayer];
    if (!this.spaceHeld && this.store.tool !== 'pan' && isMovableImage(active)) {
      this.startImageDrag(pointer, active);
      return;
    }

    if (this.store.tool === 'select' && !this.spaceHeld && !penEraser) {
      this.startSelect(pointer);
      return;
    }

    const { shape, erases } = this.resolveShape(penEraser);
    if (shape === 'pan') {
      this.beginPan(pointer);
      return;
    }

    this.activeId = pointer.id;
    const cell = this.cellAt(pointer.x, pointer.y);

    if (shape === 'picker') {
      this.mode = 'draw';
      this.strokeShape = 'brush';
      this.strokeErases = false;
      if (this.editor.pick(cell.x, cell.y)) {
        // Sampling is a means to an end, so hand the user back their brush.
        const back = this.store.previousTool;
        this.store.setTool(back === 'picker' ? 'brush' : back);
      } else {
        this.store.toast('No tile there to pick');
      }
      return;
    }

    this.mode = 'draw';
    this.strokeShape = shape;
    this.strokeErases = erases;
    this.lastCell = cell;

    if (shape === 'rect' || shape === 'line') {
      this.anchorCell = cell;
      this.store.preview = { x0: cell.x, y0: cell.y, x1: cell.x, y1: cell.y };
      this.renderer.requestDraw();
      return;
    }

    if (!this.editor.beginStroke(labelFor(shape, erases))) {
      this.mode = 'idle';
      this.activeId = null;
      return;
    }

    if (shape === 'fill') {
      this.editor.floodFill(cell.x, cell.y, erases);
      this.editor.endStroke();
    } else if (erases) {
      this.editor.erase(cell.x, cell.y);
    } else {
      this.editor.paintStamp(cell.x, cell.y);
    }
    this.renderer.requestDraw();
  }

  /** True when a screen point is over the block currently held up. */
  private onHeldBlock(x: number, y: number): boolean {
    const selection = this.store.selection;
    if (!selection) return false;
    const cell = this.cellAt(x, y);
    return (
      cell.x >= selection.x &&
      cell.y >= selection.y &&
      cell.x < selection.x + selection.w &&
      cell.y < selection.y + selection.h
    );
  }

  private grabHeldBlock(pointer: TrackedPointer): void {
    const selection = this.store.selection;
    if (!selection) return;
    const cell = this.cellAt(pointer.x, pointer.y);
    this.mode = 'selection-move';
    this.activeId = pointer.id;
    this.selectionGrab = { dx: cell.x - selection.x, dy: cell.y - selection.y };
  }

  /**
   * Pressing inside the held block drags it; anywhere else sets it down and
   * starts drawing a box around the next tiles to pick up.
   */
  private startSelect(pointer: TrackedPointer): void {
    if (this.onHeldBlock(pointer.x, pointer.y)) {
      this.grabHeldBlock(pointer);
      return;
    }
    const world = this.worldAt(pointer.x, pointer.y);
    const hit = this.objects.hitTest(world.x, world.y);
    if (hit) {
      this.editor.commitSelection();
      this.objects.select(hit.layer, hit.obj);
      if (hit.obj.locked) {
        this.mode = 'idle';
        this.activeId = pointer.id;
        this.store.toast('Unlock it to move');
        return;
      }
      this.startObjectMove(pointer, hit.obj);
      return;
    }
    this.editor.commitSelection();
    const cell = this.cellAt(pointer.x, pointer.y);
    this.mode = 'selection-rect';
    this.activeId = pointer.id;
    this.anchorCell = cell;
    this.store.preview = { x0: cell.x, y0: cell.y, x1: cell.x, y1: cell.y };
    this.renderer.requestDraw();
  }

  private startGesture(): void {
    const touches = [...this.pointers.values()].filter((p) => p.type === 'touch');
    if (touches.length < 2) return;
    const [a, b] = touches;
    this.pinchDistance = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    this.pinchZoom = this.store.camera.zoom;
    this.pinchMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    this.activeId = null;

    // Pinching over the selected asset resizes it; anywhere else zooms.
    const found = this.objects.selected();
    if (found && this.nearSelected(this.pinchMid.x, this.pinchMid.y, PINCH_REACH)) {
      this.mode = 'object-pinch';
      this.scaleStart = found.obj.scale;
      this.objects.beginGesture();
      return;
    }
    this.mode = 'gesture';
  }

  // --- Event handlers ------------------------------------------------------

  private onDown = (e: PointerEvent): void => {
    // A palm landing while the Pencil is drawing must not pan or paint.
    if (e.pointerType === 'touch' && this.penDown) return;

    e.preventDefault();
    this.refreshRect();
    const { x, y } = this.local(e);
    const pointer: TrackedPointer = {
      id: e.pointerId,
      type: e.pointerType,
      x,
      y,
      startX: x,
      startY: y,
      lastX: x,
      lastY: y,
    };
    this.pointers.set(e.pointerId, pointer);
    this.canvas.setPointerCapture?.(e.pointerId);

    if (e.pointerType === 'pen') {
      this.penDown = true;
      // Drop any finger navigation that was underway: the Pencil wins.
      this.dropTouchPointers();
      this.startDraw(pointer, isPenEraser(e));
      return;
    }

    if (e.pointerType === 'mouse') {
      // Right and middle drag pan, which is the habit most editors train.
      if (e.button === 0) this.startDraw(pointer, false);
      else this.beginPan(pointer);
      return;
    }

    const fingers = this.touchCount();
    this.gestureMaxFingers = Math.max(this.gestureMaxFingers, fingers);

    if (fingers === 1) {
      this.gestureStart = performance.now();
      this.gestureMoved = false;
      this.tapStart = { clientX: e.clientX, clientY: e.clientY, x, y };
      this.tapObject = null;
      this.tapObjectLayer = null;

      // Like a selected asset, a held block follows a finger, so it can be
      // moved without the Pencil while the rest of the map still pans.
      if (this.store.tool === 'select' && !this.spaceHeld && this.onHeldBlock(x, y)) {
        this.grabHeldBlock(pointer);
        return;
      }
      // Pick tile is a single tap, so a finger can sample a square too.
      if (this.store.tool === 'picker' && !this.spaceHeld) {
        this.startDraw(pointer, false);
        return;
      }
      // A finger only paints paths. After an object is placed, the next
      // touch pans or moves that object — it must not start a brush stroke.
      if (!this.fingerPaints() && this.pressAsset(pointer, false)) return;
      if (this.fingerPaints()) this.startDraw(pointer, false);
      else this.beginPan(pointer);
      return;
    }

    // Second finger: whatever was happening becomes a pinch.
    if (this.mode === 'draw') this.editor.abortStroke();
    else if (this.mode === 'image') this.cancelImageDrag();
    else if (this.mode === 'object-move' || this.mode === 'object-scale') this.objects.cancelGesture();
    else if (this.mode === 'selection-move') this.store.changed();
    this.store.preview = null;
    this.anchorCell = null;
    this.startGesture();
  };

  private onMove = (e: PointerEvent): void => {
    if (e.pointerType === 'touch' && this.penDown) return;

    const tracked = this.pointers.get(e.pointerId);
    const { x, y } = this.local(e);

    if (!tracked) {
      // Hovering: recent iPads report Pencil position before it touches down,
      // and a mouse always does. Keep the ghost cursor live.
      if (e.pointerType === 'pen' || e.pointerType === 'mouse') this.updateHover(x, y);
      return;
    }

    e.preventDefault();
    tracked.x = x;
    tracked.y = y;
    if (Math.hypot(x - tracked.startX, y - tracked.startY) > TAP_MAX_MOVE) this.gestureMoved = true;

    if (this.mode === 'gesture') {
      this.updatePinch();
      return;
    }

    if (this.mode === 'object-pinch') {
      this.updateObjectPinch();
      return;
    }

    if (e.pointerId === this.activeId && this.mode === 'object-move') {
      const found = this.objects.selected();
      if (found) {
        // Ignore the wobble of a tap. Moving within the slop and releasing
        // must leave the asset exactly where it was, with no undo step.
        const slop = e.pointerType === 'touch' ? TAP_MAX_MOVE : 3;
        if (!this.objectMoved && Math.hypot(x - tracked.startX, y - tracked.startY) <= slop) return;
        this.objectMoved = true;
        const world = this.worldAt(x, y);
        this.objects.moveSelected(found.obj, world.x - this.grab.dx, world.y - this.grab.dy);
      }
      return;
    }

    if (e.pointerId === this.activeId && this.mode === 'object-scale') {
      const found = this.objects.selected();
      if (found) {
        const world = this.worldAt(x, y);
        const distance = Math.hypot(world.x - found.obj.x, world.y - found.obj.y);
        this.objects.scaleTo(found.obj, this.scaleStart * (distance / this.scaleStartDistance));
      }
      return;
    }

    if (this.mode === 'image' && e.pointerId === this.activeId) {
      this.updateImageDrag(x, y);
      return;
    }

    if (e.pointerId === this.activeId && this.mode === 'selection-rect') {
      const cell = this.cellAt(x, y);
      if (this.anchorCell) {
        this.store.preview = { x0: this.anchorCell.x, y0: this.anchorCell.y, x1: cell.x, y1: cell.y };
      }
      this.renderer.requestDraw();
      return;
    }

    if (e.pointerId === this.activeId && this.mode === 'selection-move') {
      const selection = this.store.selection;
      const cell = this.cellAt(x, y);
      if (selection) {
        const nx = cell.x - this.selectionGrab.dx;
        const ny = cell.y - this.selectionGrab.dy;
        if (nx !== selection.x || ny !== selection.y) {
          selection.x = nx;
          selection.y = ny;
          this.renderer.requestDraw();
        }
      }
      return;
    }

    if (this.mode === 'pan' && e.pointerId === this.activeId) {
      const camera = this.store.camera;
      // Pan in world units so the map tracks the finger exactly at any zoom.
      camera.x -= (x - tracked.lastX) / camera.zoom;
      camera.y -= (y - tracked.lastY) / camera.zoom;
      tracked.lastX = x;
      tracked.lastY = y;
      this.store.emit('view');
      this.renderer.requestDraw();
      return;
    }

    tracked.lastX = x;
    tracked.lastY = y;

    if (this.mode === 'draw' && e.pointerId === this.activeId) {
      this.continueDraw(e, x, y);
      return;
    }

    this.updateHover(x, y);
  };

  private onUp = (e: PointerEvent): void => {
    const tracked = this.pointers.get(e.pointerId);
    this.pointers.delete(e.pointerId);
    if (this.canvas.hasPointerCapture?.(e.pointerId)) {
      this.canvas.releasePointerCapture(e.pointerId);
    }
    if (e.pointerType === 'pen') this.penDown = false;
    if (!tracked) return;

    if (this.mode === 'gesture' || this.mode === 'object-pinch') {
      // Rebase when a finger lifts but others remain, otherwise the view or
      // the asset would jump as the midpoint moves.
      if (this.touchCount() >= 2) {
        if (this.mode === 'object-pinch') this.objects.endGesture('Resize');
        this.startGesture();
      } else if (this.touchCount() === 0) {
        if (this.mode === 'object-pinch') this.objects.endGesture('Resize');
        else this.settleZoom(this.pinchMid.x, this.pinchMid.y);
        this.endInteraction();
      } else if (this.mode === 'object-pinch') {
        // One finger left: finish the resize, ignore the remaining finger.
        this.objects.endGesture('Resize');
        this.mode = 'idle';
      }
      return;
    }

    if (e.pointerId === this.activeId) {
      if (this.mode === 'draw') this.finishDraw();
      else if (this.mode === 'image') this.finishImageDrag();
      else if (this.mode === 'object-move') {
        if (this.objectMoved) this.objects.endGesture('Move');
        else this.objects.cancelGesture();
      } else if (this.mode === 'object-scale') this.objects.endGesture('Resize');
      else if (this.mode === 'selection-rect') this.finishSelectRect();
      else if (this.mode === 'selection-move') this.store.changed();
      this.mode = 'idle';
      this.activeId = null;
      this.lastCell = null;
    }

    if (this.pointers.size === 0) this.endInteraction();
    if (e.pointerType === 'touch') this.store.hover = null;
    this.renderer.requestDraw();
  };

  /**
   * iPadOS cancels a touch when it takes the gesture for itself (a swipe
   * from the edge, a palm, the app switcher). That is not the user finishing
   * a rectangle, so whatever was half-drawn is dropped rather than committed.
   */
  private onCancel = (e: PointerEvent): void => {
    if (e.pointerId === this.activeId) {
      if (this.mode === 'draw') {
        if (this.editor.isStroking) this.editor.abortStroke();
        this.mode = 'idle';
      } else if (this.mode === 'selection-rect') {
        this.mode = 'idle';
      } else if (this.mode === 'image') {
        this.cancelImageDrag();
        this.mode = 'idle';
      }
      this.store.preview = null;
      this.anchorCell = null;
    }
    // Never resolve a cancelled touch as a tap: that would undo or deselect.
    this.gestureMoved = true;
    this.onUp(e);
  };

  /** Eases a freehand zoom onto the nearest sharp zoom once the gesture ends. */
  private settleZoom(x: number, y: number): void {
    const camera = this.store.camera;
    const sharp = snapZoom(camera.zoom);
    if (sharp === camera.zoom) return;
    zoomAt(camera, x, y, sharp);
    this.store.emit('view');
    this.renderer.requestDraw();
  }

  private onLeave = (): void => {
    if (this.mode === 'idle' && this.store.hover) {
      this.store.hover = null;
      this.renderer.requestDraw();
    }
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const { x, y } = this.local(e);
    const camera = this.store.camera;
    // Browsers report a trackpad pinch as ctrl+wheel.
    if (e.ctrlKey || e.metaKey) {
      zoomAt(camera, x, y, camera.zoom * Math.exp(-e.deltaY * 0.01));
      clearTimeout(this.wheelSettle);
      this.wheelSettle = setTimeout(() => this.settleZoom(x, y), 160);
    } else {
      camera.x += (e.shiftKey ? e.deltaY : e.deltaX) / camera.zoom;
      if (!e.shiftKey) camera.y += e.deltaY / camera.zoom;
    }
    this.store.emit('view');
    this.renderer.requestDraw();
  };

  // --- Continuing and finishing -------------------------------------------

  private dropTouchPointers(): void {
    for (const [id, p] of [...this.pointers]) {
      if (p.type === 'touch') this.pointers.delete(id);
    }
    if (this.mode === 'object-pinch') this.objects.cancelGesture();
    if (this.mode === 'gesture' || this.mode === 'pan' || this.mode === 'object-pinch') {
      this.mode = 'idle';
      this.activeId = null;
    }
  }

  private updateHover(x: number, y: number): void {
    const cell = this.cellAt(x, y);
    const doc = this.store.doc;
    const inside = cell.x >= 0 && cell.y >= 0 && cell.x < doc.width && cell.y < doc.height;
    const next = inside ? cell : null;
    const prev = this.store.hover;
    if (prev === next) return;
    if (prev && next && prev.x === next.x && prev.y === next.y) return;
    this.store.hover = next;
    this.store.emit('view');
    this.renderer.requestDraw();
  }

  private continueDraw(e: PointerEvent, x: number, y: number): void {
    const shape = this.strokeShape;

    if (shape === 'rect' || shape === 'line') {
      const cell = this.cellAt(x, y);
      if (this.anchorCell) {
        this.store.preview = { x0: this.anchorCell.x, y0: this.anchorCell.y, x1: cell.x, y1: cell.y };
      }
      this.updateHover(x, y);
      this.renderer.requestDraw();
      return;
    }

    if (shape === 'fill') return;

    // The Pencil reports far more samples than there are frames. Replaying the
    // coalesced queue keeps fast strokes from skipping tiles. A finger's
    // extra samples often arrive at 0,0, and following them paints a streak
    // across the map.
    const coalesced =
      e.pointerType === 'pen' && typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    const points = coalesced.length > 0 ? coalesced.map((s) => this.local(s)) : [{ x, y }];

    for (const point of points) {
      const cell = this.cellAt(point.x, point.y);
      if (!this.lastCell) {
        this.editor.paintCells([cell], this.strokeErases);
      } else if (this.lastCell.x !== cell.x || this.lastCell.y !== cell.y) {
        // Join to the previous sample so fast strokes leave no gaps. The first
        // cell of the path was already painted.
        const path = lineCells(this.lastCell.x, this.lastCell.y, cell.x, cell.y);
        this.editor.paintCells(path.slice(1), this.strokeErases);
      }
      this.lastCell = cell;
    }

    this.updateHover(x, y);
    this.renderer.requestDraw();
  }

  private updateImageDrag(x: number, y: number): void {
    const layer = this.imageLayer;
    if (!layer) return;
    const world = this.worldAt(x, y);

    if (this.imageAction === 'scale') {
      const { w, h } = scaleFromHandle(this.imageStart, world.x, world.y);
      this.editor.applyImagePlacement(layer, { x: this.imageStart.x, y: this.imageStart.y, w, h });
    } else {
      // Move by how far the pointer travelled, not to where it is, so the
      // image does not jump to centre itself under the first touch.
      this.editor.applyImagePlacement(layer, {
        x: this.imageStart.x + (world.x - this.imageGrabWorld.x),
        y: this.imageStart.y + (world.y - this.imageGrabWorld.y),
        w: this.imageStart.w,
        h: this.imageStart.h,
      });
    }
    this.renderer.requestDraw();
  }

  private finishImageDrag(): void {
    const layer = this.imageLayer;
    this.imageLayer = null;
    if (!layer) return;
    if (this.store.settings.snapImageToGrid) {
      this.editor.applyImagePlacement(layer, snapPlacement(this.store.doc, layer, this.imageAction === 'scale'));
    }
    this.editor.commitImageTransform(this.imageAction === 'scale' ? 'Resize reference image' : 'Move reference image');
    this.store.restructured();
  }

  /** Puts the image back where it started, for when a pinch takes over. */
  private cancelImageDrag(): void {
    const layer = this.imageLayer;
    this.imageLayer = null;
    if (!layer) return;
    this.editor.applyImagePlacement(layer, this.imageStart);
    this.editor.cancelImageTransform();
    this.renderer.requestDraw();
  }

  private finishDraw(): void {
    const shape = this.strokeShape;

    if ((shape === 'rect' || shape === 'line') && this.store.preview) {
      const preview = this.store.preview;
      if (this.editor.beginStroke(labelFor(shape, this.strokeErases))) {
        if (shape === 'rect') {
          this.editor.fillRect(preview, this.strokeErases);
        } else {
          this.editor.paintCells(
            lineCells(preview.x0, preview.y0, preview.x1, preview.y1),
            this.strokeErases,
          );
        }
        this.editor.endStroke();
      }
    } else if (this.editor.isStroking) {
      this.editor.endStroke();
    }

    this.store.preview = null;
    this.anchorCell = null;
    this.strokeErases = false;
  }

  private finishSelectRect(): void {
    const preview = this.store.preview;
    this.store.preview = null;
    this.anchorCell = null;
    if (!preview) return;
    const assets = this.objects.inRect(preview);
    if (assets.length > 1) {
      this.objects.selectMany(assets);
      this.store.toast(`${assets.length} selected. Drag one to move them, or Group to keep them together.`);
      return;
    }
    if (assets.length === 1) {
      this.objects.select(assets[0].layer, assets[0].obj);
      return;
    }
    this.editor.liftSelection(preview);
  }

  private updatePinch(): void {
    const touches = [...this.pointers.values()].filter((p) => p.type === 'touch');
    if (touches.length < 2) return;
    const [a, b] = touches;
    const distance = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const camera = this.store.camera;

    // Zoom around the gesture midpoint, then translate by how far the midpoint
    // itself travelled, so pinching and dragging feel like one motion.
    zoomAt(camera, mid.x, mid.y, clampZoom(this.pinchZoom * (distance / this.pinchDistance)));
    camera.x -= (mid.x - this.pinchMid.x) / camera.zoom;
    camera.y -= (mid.y - this.pinchMid.y) / camera.zoom;
    this.pinchMid = mid;

    this.store.emit('view');
    this.renderer.requestDraw();
  }

  /** Scales the selected asset by how far the two fingers have spread. */
  private updateObjectPinch(): void {
    const touches = [...this.pointers.values()].filter((p) => p.type === 'touch');
    const found = this.objects.selected();
    if (touches.length < 2 || !found) return;
    const [a, b] = touches;
    const distance = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    this.objects.scaleTo(found.obj, this.scaleStart * (distance / this.pinchDistance));
  }

  /** Two quick taps on the same ground cell open that tile's menu. */
  private registerTap(point: { clientX: number; clientY: number; x: number; y: number }): void {
    const now = performance.now();
    const cell = this.cellAt(point.x, point.y);
    const last = this.lastTap;
    if (last && now - last.time < DOUBLE_TAP_MS && last.cell.x === cell.x && last.cell.y === cell.y) {
      this.lastTap = null;
      this.onDoubleTap?.(cell, point.clientX, point.clientY);
      return;
    }
    this.lastTap = { time: now, cell };
  }

  /** Called when the last pointer lifts: resolves taps and tap shortcuts. */
  private endInteraction(): void {
    const elapsed = performance.now() - this.gestureStart;
    const fingers = this.gestureMaxFingers;
    const wasTap = !this.gestureMoved && elapsed < TAP_MAX_MS;
    const tappedObject = this.tapObject;
    const tappedLayer = this.tapObjectLayer;

    this.mode = 'idle';
    this.activeId = null;
    this.gestureMaxFingers = 0;
    this.gestureMoved = false;
    this.tapObject = null;
    this.tapObjectLayer = null;
    this.store.preview = null;
    this.anchorCell = null;

    if (!wasTap) return;

    if (fingers === 1) {
      // Tapping away from a held block sets it down, the way tapping away
      // from a selected asset deselects it.
      if (this.store.selection) {
        if (!this.tapStart || !this.onHeldBlock(this.tapStart.x, this.tapStart.y)) this.editor.commitSelection();
        return;
      }
      // A finger tap on an asset selects it; on bare map it deselects, and
      // two of those in a row open the ground tile's menu.
      if (tappedObject && tappedLayer) {
        const layer = this.store.doc.layers.find((l) => l.id === tappedLayer);
        if (layer?.kind === 'objects') {
          this.editor.commitSelection();
          if (this.store.addingToSelection) this.objects.toggleInSelection(layer, tappedObject);
          else this.objects.select(layer, tappedObject);
        }
        return;
      }
      const hadSelection = !!this.objects.selected();
      this.objects.deselect();
      if (!hadSelection && this.tapStart) this.registerTap(this.tapStart);
      return;
    }

    if (fingers === 2) {
      this.editor.undo();
      this.store.toast('Undo');
    } else if (fingers === 3) {
      this.editor.redo();
      this.store.toast('Redo');
    }
  }
}

/** Apple Pencil Pro and Surface-style pens report the eraser end as button 5. */
function isPenEraser(e: PointerEvent): boolean {
  return e.pointerType === 'pen' && ((e.buttons & 32) !== 0 || e.button === 5);
}

function labelFor(shape: Shape, erasing: boolean): string {
  if (erasing) {
    if (shape === 'fill') return 'Erase area';
    if (shape === 'rect') return 'Erase rectangle';
    if (shape === 'line') return 'Erase line';
    return 'Erase';
  }
  switch (shape) {
    case 'fill':
      return 'Fill';
    case 'rect':
      return 'Rectangle';
    case 'line':
      return 'Line';
    default:
      return 'Paint';
  }
}
