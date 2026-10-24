import { isMovableImage, type ImageLayer } from '../core/doc';
import type { Shape, Store } from '../core/store';
import { clampZoom, screenToCell, screenToWorld, zoomAt } from '../render/camera';
import type { Renderer } from '../render/renderer';
import type { Editor } from '../tools/edit';
import { lineCells } from '../tools/geometry';
import { hitsHandle, scaleFromHandle, snapPlacement } from '../tools/image-transform';

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

type Mode = 'idle' | 'draw' | 'pan' | 'gesture' | 'image' | 'selection-rect' | 'selection-move';

/** A multi-finger tap only counts as a shortcut if it is quick and still. */
const TAP_MAX_MS = 320;
const TAP_MAX_MOVE = 12;

/**
 * Translates pointer events into editing and navigation.
 *
 * The rules that matter on an iPad:
 *  - The Apple Pencil always draws. While it is touching the glass every
 *    `touch` pointer is dropped, which is what makes palm rejection work.
 *  - Fingers navigate by default: one finger pans, two pinch and pan. Drawing
 *    with a finger is opt-in, and even then a second finger rolls the stroke
 *    back and takes over as a pinch.
 *  - Two-finger tap undoes and three-finger tap redoes, matching the system
 *    gesture iPad users already have in their hands.
 */
export class PointerInput {
  private readonly pointers = new Map<number, TrackedPointer>();
  private mode: Mode = 'idle';
  private activeId: number | null = null;

  private penDown = false;
  private spaceHeld = false;

  /** Captured when a stroke starts so a mid-stroke tool change cannot confuse it. */
  private strokeShape: Shape = 'brush';
  private strokeErases = false;
  private lastCell: { x: number; y: number } | null = null;
  private anchorCell: { x: number; y: number } | null = null;

  /** Offset from the selection's corner to where it was grabbed. */
  private selectionGrab = { dx: 0, dy: 0 };

  /** Reference image being dragged, with its placement when the drag began. */
  private imageLayer: ImageLayer | null = null;
  private imageAction: 'move' | 'scale' = 'move';
  private imageStart = { x: 0, y: 0, w: 0, h: 0 };
  private imageGrabWorld = { x: 0, y: 0 };

  /** Pinch baseline, captured when the second finger lands. */
  private pinchDistance = 1;
  private pinchZoom = 1;
  private pinchMid = { x: 0, y: 0 };

  private gestureStart = 0;
  private gestureMaxFingers = 0;
  private gestureMoved = false;

  private rect: DOMRect;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly store: Store,
    private readonly editor: Editor,
    private readonly renderer: Renderer,
  ) {
    this.rect = canvas.getBoundingClientRect();

    canvas.addEventListener('pointerdown', this.onDown, { passive: false });
    canvas.addEventListener('pointermove', this.onMove, { passive: false });
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onUp);
    canvas.addEventListener('pointerleave', this.onLeave);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

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

  private touchCount(): number {
    let n = 0;
    for (const p of this.pointers.values()) if (p.type === 'touch') n += 1;
    return n;
  }

  // --- Starting an interaction --------------------------------------------

  /** Resolves the shape a stroke should draw, folding in modifiers. */
  private resolveShape(penEraser: boolean): { shape: Shape | 'pan' | 'picker'; erases: boolean } {
    if (this.spaceHeld) return { shape: 'pan', erases: false };
    if (penEraser) return { shape: this.store.eraserShape, erases: true };
    const tool = this.store.tool;
    if (tool === 'pan') return { shape: 'pan', erases: false };
    if (tool === 'picker') return { shape: 'picker', erases: false };
    if (tool === 'eraser') return { shape: this.store.eraserShape, erases: true };
    // `select` never reaches here: it is handled before a stroke begins.
    if (tool === 'select') return { shape: 'pan', erases: false };
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
    this.imageGrabWorld = screenToWorld(this.store.camera, pointer.x, pointer.y);
    this.editor.beginImageTransform();
  }

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

    const active = this.store.doc.layers[this.store.doc.activeLayer];
    if (!this.spaceHeld && this.store.tool !== 'pan' && isMovableImage(active)) {
      this.startImageDrag(pointer, active);
      return;
    }

    const { shape, erases } = this.resolveShape(penEraser);
    if (shape === 'pan') {
      this.beginPan(pointer);
      return;
    }

    this.activeId = pointer.id;
    const cell = this.cellAt(pointer.x, pointer.y);

    if (this.store.tool === 'select' && !this.spaceHeld) {
      this.startSelect(cell);
      return;
    }

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

  /**
   * The select tool does one of two things depending on where you press:
   * inside a floating block it drags that block, anywhere else it starts a
   * new marquee (dropping whatever was floating first).
   */
  private startSelect(cell: { x: number; y: number }): void {
    const selection = this.store.selection;

    if (selection && insideSelection(selection, cell)) {
      this.mode = 'selection-move';
      this.selectionGrab = { dx: cell.x - selection.x, dy: cell.y - selection.y };
      return;
    }

    // Pressing outside the block means you are done with it.
    if (selection) this.editor.commitSelection();

    this.mode = 'selection-rect';
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
    this.mode = 'gesture';
    this.activeId = null;
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
      const drawsWithFinger =
        this.store.settings.fingerDraws && this.store.tool !== 'pan' && !this.spaceHeld;
      if (drawsWithFinger) this.startDraw(pointer, false);
      else this.beginPan(pointer);
      return;
    }

    // Second finger: whatever was happening becomes a pinch.
    if (this.mode === 'draw') this.editor.abortStroke();
    else if (this.mode === 'image') this.cancelImageDrag();
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

    if (this.mode === 'image' && e.pointerId === this.activeId) {
      this.updateImageDrag(x, y);
      return;
    }

    if (e.pointerId === this.activeId && (this.mode === 'selection-rect' || this.mode === 'selection-move')) {
      const cell = this.cellAt(x, y);
      if (this.mode === 'selection-rect' && this.anchorCell) {
        this.store.preview = { x0: this.anchorCell.x, y0: this.anchorCell.y, x1: cell.x, y1: cell.y };
      } else if (this.store.selection) {
        this.store.selection.x = cell.x - this.selectionGrab.dx;
        this.store.selection.y = cell.y - this.selectionGrab.dy;
      }
      this.renderer.requestDraw();
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

    if (this.mode === 'gesture') {
      // Rebase the pinch when a finger lifts but others remain, otherwise the
      // view would jump as the midpoint moves.
      if (this.touchCount() >= 2) this.startGesture();
      else if (this.touchCount() === 0) this.endInteraction();
      return;
    }

    if (e.pointerId === this.activeId) {
      if (this.mode === 'draw') this.finishDraw();
      else if (this.mode === 'image') this.finishImageDrag();
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
    if (this.mode === 'gesture' || this.mode === 'pan') {
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
    // coalesced queue keeps fast strokes from skipping tiles.
    const coalesced = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
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
    const world = screenToWorld(this.store.camera, x, y);

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

  private finishSelectRect(): void {
    const preview = this.store.preview;
    this.store.preview = null;
    this.anchorCell = null;
    if (!preview) return;
    this.editor.liftSelection(preview);
    this.store.emit('ui');
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

  /** Called when the last pointer lifts: resolves multi-finger tap shortcuts. */
  private endInteraction(): void {
    const elapsed = performance.now() - this.gestureStart;
    const fingers = this.gestureMaxFingers;
    const wasTap = !this.gestureMoved && elapsed < TAP_MAX_MS;

    this.mode = 'idle';
    this.activeId = null;
    this.gestureMaxFingers = 0;
    this.gestureMoved = false;
    this.store.preview = null;
    this.anchorCell = null;

    if (!wasTap) return;
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

function insideSelection(s: { x: number; y: number; w: number; h: number }, cell: { x: number; y: number }): boolean {
  return cell.x >= s.x && cell.y >= s.y && cell.x < s.x + s.w && cell.y < s.y + s.h;
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
