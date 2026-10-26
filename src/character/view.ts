import {
  activeReference,
  frameIndex,
  framePixels,
  pinchReference,
  referenceImage,
  referencePlacement,
  type Character,
  type CharacterReference,
  type Frame,
} from './model';
import type { Studio } from './studio';

const BACKDROP = '#0e0f13';
const CHECKER_A = '#1b1d24';
const CHECKER_B = '#22252e';
const GRID = 'rgba(255,255,255,0.08)';
const GRID_TILE = 'rgba(126,160,255,0.45)';
const CURSOR = 'rgba(255,255,255,0.85)';

/**
 * The sprite canvas: one pixel of the character per on-screen block.
 *
 * Input follows the same rule as the map editor, because switching between
 * them should not mean relearning anything: the Apple Pencil draws, fingers
 * pan and pinch, and a second finger mid-stroke turns the gesture into a
 * zoom instead of leaving a stray mark.
 */
export class CharacterView {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;

  /** Screen pixels per sprite pixel. */
  zoom = 10;
  offsetX = 0;
  offsetY = 0;

  /** Runs when a finger has finished moving or sizing the traced picture. */
  onPictureChanged: (() => void) | null = null;

  private dpr = 1;
  private viewW = 0;
  private viewH = 0;
  private frameHandle = 0;

  private hover: { x: number; y: number } | null = null;
  private readonly pointers = new Map<number, { type: string; x: number; y: number }>();
  private mode: 'idle' | 'draw' | 'blocked' | 'move' | 'pinch' = 'idle';
  private activeId: number | null = null;
  private penDown = false;
  private last: { x: number; y: number } | null = null;
  /** Where a drag of the traced picture began: the screen point and the picture's nudge then. */
  private moveFrom: { sx: number; sy: number; x: number; y: number } | null = null;
  /** The two fingers pinching the traced picture, and the picture as it was when they landed. */
  private pinchFrom: {
    ids: [number, number];
    mid: { x: number; y: number };
    distance: number;
    scale?: number;
    x?: number;
    y?: number;
  } | null = null;

  /** Scratch canvas a frame is written into before being scaled up. */
  private readonly scratch = document.createElement('canvas');
  private readonly scratchCtx: CanvasRenderingContext2D;

  constructor(private readonly studio: Studio) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'sprite-canvas';
    const ctx = this.canvas.getContext('2d', { alpha: false });
    const scratchCtx = this.scratch.getContext('2d', { willReadFrequently: true });
    if (!ctx || !scratchCtx) throw new Error('2D canvas is unavailable');
    this.ctx = ctx;
    this.scratchCtx = scratchCtx;

    this.bind();
  }

  // --- Geometry ------------------------------------------------------------

  private toPixel(sx: number, sy: number): { x: number; y: number } {
    return {
      x: Math.floor((sx - this.offsetX) / this.zoom),
      y: Math.floor((sy - this.offsetY) / this.zoom),
    };
  }

  /** Centres the sprite and picks a zoom that fills the viewport comfortably. */
  fit(): void {
    const character = this.studio.character;
    if (!character || this.viewW === 0) return;
    const padding = 40;
    const zoom = Math.max(
      1,
      Math.floor(Math.min((this.viewW - padding * 2) / character.w, (this.viewH - padding * 2) / character.h)),
    );
    this.zoom = zoom;
    this.offsetX = Math.round((this.viewW - character.w * zoom) / 2);
    this.offsetY = Math.round((this.viewH - character.h * zoom) / 2);
    this.requestDraw();
  }

  /** The canvas is locked: it always fills the space it has, centred. */
  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.viewW = rect.width;
    this.viewH = rect.height;
    this.dpr = dpr;
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.fit();
    this.draw();
  }

  requestDraw(): void {
    if (this.frameHandle) return;
    this.frameHandle = requestAnimationFrame(() => {
      this.frameHandle = 0;
      this.draw();
    });
  }

  // --- Drawing -------------------------------------------------------------

  /** Renders a frame's RGBA buffer into the scratch canvas. */
  private frameCanvas(character: Character, frame: Frame): HTMLCanvasElement {
    if (this.scratch.width !== character.w || this.scratch.height !== character.h) {
      this.scratch.width = character.w;
      this.scratch.height = character.h;
    }
    const image = this.scratchCtx.createImageData(character.w, character.h);
    image.data.set(framePixels(frame.data, character.w, character.h));
    this.scratchCtx.putImageData(image, 0, 0);
    return this.scratch;
  }

  draw(): void {
    const { ctx } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = BACKDROP;
    ctx.fillRect(0, 0, this.viewW, this.viewH);

    const character = this.studio.character;
    if (!character) return;

    const w = character.w * this.zoom;
    const h = character.h * this.zoom;
    const x = this.offsetX;
    const y = this.offsetY;

    this.drawCheckerboard(x, y, w, h);

    // Traced pictures sit behind everything you draw, bottom first.
    for (const reference of character.references) {
      const picture = reference.visible ? referenceImage(reference, () => this.requestDraw()) : null;
      if (!picture) continue;
      const at = referencePlacement(picture.naturalWidth, picture.naturalHeight, character.w, character.h, reference);
      ctx.globalAlpha = reference.opacity;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(picture, x + at.x * this.zoom, y + at.y * this.zoom, at.w * this.zoom, at.h * this.zoom);
      ctx.globalAlpha = 1;
    }
    ctx.imageSmoothingEnabled = false;

    // Onion skin first, faint, so the previous pose guides the current one.
    const onion = this.studio.onionFrame;
    if (onion) {
      ctx.globalAlpha = 0.28;
      ctx.drawImage(this.frameCanvas(character, onion), x, y, w, h);
      ctx.globalAlpha = 1;
    }

    // Every visible layer, bottom first, straight from what is being drawn.
    const index = frameIndex(this.studio.direction, this.studio.frame, character.frameCount);
    for (const layer of character.layers) {
      const frame = layer.visible ? layer.frames[index] : null;
      if (frame) ctx.drawImage(this.frameCanvas(character, frame), x, y, w, h);
    }

    this.drawGrid(character, x, y);
    this.drawCursor(character, x, y);
  }

  private drawCheckerboard(x: number, y: number, w: number, h: number): void {
    const { ctx } = this;
    const size = 8;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.fillStyle = CHECKER_A;
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = CHECKER_B;
    for (let yy = 0; yy < h; yy += size) {
      for (let xx = 0; xx < w; xx += size) {
        if (((xx / size) | 0) % 2 === ((yy / size) | 0) % 2) continue;
        ctx.fillRect(x + xx, y + yy, size, size);
      }
    }
    ctx.restore();
  }

  private drawGrid(character: Character, x: number, y: number): void {
    const { ctx } = this;
    const tileSize = character.w / character.tilesW;

    // The per-pixel grid only helps once blocks are big enough to aim at.
    if (this.studio.showGrid && this.zoom >= 6) {
      ctx.strokeStyle = GRID;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let px = 1; px < character.w; px++) {
        const sx = Math.round(x + px * this.zoom) + 0.5;
        ctx.moveTo(sx, y);
        ctx.lineTo(sx, y + character.h * this.zoom);
      }
      for (let py = 1; py < character.h; py++) {
        const sy = Math.round(y + py * this.zoom) + 0.5;
        ctx.moveTo(x, sy);
        ctx.lineTo(x + character.w * this.zoom, sy);
      }
      ctx.stroke();
    }

    // Tile boundaries, so you can see how the sprite will sit on the map.
    ctx.strokeStyle = GRID_TILE;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let tx = 0; tx <= character.tilesW; tx++) {
      const sx = Math.round(x + tx * tileSize * this.zoom) + 0.5;
      ctx.moveTo(sx, y);
      ctx.lineTo(sx, y + character.h * this.zoom);
    }
    for (let ty = 0; ty <= character.tilesH; ty++) {
      const sy = Math.round(y + ty * tileSize * this.zoom) + 0.5;
      ctx.moveTo(x, sy);
      ctx.lineTo(x + character.w * this.zoom, sy);
    }
    ctx.stroke();

    // Mirror axis, when symmetric drawing is on.
    if (this.studio.mirrorX) {
      const sx = Math.round(x + (character.w / 2) * this.zoom) + 0.5;
      ctx.strokeStyle = 'rgba(126,231,184,0.7)';
      ctx.setLineDash([6, 5]);
      ctx.beginPath();
      ctx.moveTo(sx, y);
      ctx.lineTo(sx, y + character.h * this.zoom);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  private drawCursor(character: Character, x: number, y: number): void {
    const hover = this.hover;
    if (!hover) return;
    if (hover.x < 0 || hover.y < 0 || hover.x >= character.w || hover.y >= character.h) return;
    const { ctx } = this;
    // The outline is the brush's whole square, so a big eraser shows what it will clear.
    const size = this.studio.brushSize;
    const from = Math.floor((size - 1) / 2);
    const side = size * this.zoom;
    ctx.strokeStyle = CURSOR;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x + (hover.x - from) * this.zoom, y + (hover.y - from) * this.zoom, side, side);
    if (this.studio.mirrorX) {
      const mx = character.w - 1 - hover.x;
      if (mx !== hover.x) {
        ctx.globalAlpha = 0.5;
        ctx.strokeRect(x + (mx - (size - 1 - from)) * this.zoom, y + (hover.y - from) * this.zoom, side, side);
        ctx.globalAlpha = 1;
      }
    }
  }

  // --- Input ---------------------------------------------------------------

  private local(e: { clientX: number; clientY: number }) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private touchCount(): number {
    let n = 0;
    for (const p of this.pointers.values()) if (p.type === 'touch') n += 1;
    return n;
  }

  private bind(): void {
    const canvas = this.canvas;

    canvas.addEventListener(
      'pointerdown',
      (e) => {
        if (e.pointerType === 'touch' && this.penDown) return;
        e.preventDefault();
        const { x, y } = this.local(e);
        this.pointers.set(e.pointerId, { type: e.pointerType, x, y });
        canvas.setPointerCapture?.(e.pointerId);

        if (e.pointerType === 'pen') {
          this.penDown = true;
          for (const [id, p] of [...this.pointers]) if (p.type === 'touch') this.pointers.delete(id);
          this.moveFrom = null;
          this.pinchFrom = null;
          this.startDraw(e.pointerId, x, y);
          return;
        }
        if (e.pointerType === 'mouse') {
          if (e.button === 0) this.startDraw(e.pointerId, x, y);
          return;
        }

        // An unlocked picture belongs to the fingers: one drags it, two pinch
        // it. The Pencil still draws over it.
        if (this.pictureFollowsFingers()) {
          if (this.touchCount() === 1) this.startMove(e.pointerId, x, y);
          else if (this.touchCount() === 2 && this.mode !== 'draw') this.startPinch();
          return;
        }

        // The canvas is locked, so fingers never pan or zoom it. A second
        // finger is a palm or a slip: take back only what the first one is
        // drawing right now, never a stroke finished earlier.
        if (this.touchCount() === 1) {
          this.startDraw(e.pointerId, x, y);
        } else if (this.touchCount() > 1) {
          if (this.mode === 'draw') this.studio.cancelStroke();
          this.mode = 'blocked';
          this.activeId = null;
          this.last = null;
        }
      },
      { passive: false },
    );

    canvas.addEventListener(
      'pointermove',
      (e) => {
        if (e.pointerType === 'touch' && this.penDown) return;
        const { x, y } = this.local(e);
        const tracked = this.pointers.get(e.pointerId);

        if (!tracked) {
          if (e.pointerType === 'pen' || e.pointerType === 'mouse') this.setHover(x, y);
          return;
        }
        e.preventDefault();
        tracked.x = x;
        tracked.y = y;
        if (this.mode === 'draw' && e.pointerId === this.activeId) {
          this.continueDraw(e, x, y);
          return;
        }
        if (this.mode === 'move' && e.pointerId === this.activeId) {
          this.dragReference(x, y);
          return;
        }
        if (this.mode === 'pinch') {
          this.pinchReference();
          return;
        }
        this.setHover(x, y);
      },
      { passive: false },
    );

    const end = (e: PointerEvent) => {
      const tracked = this.pointers.get(e.pointerId);
      this.pointers.delete(e.pointerId);
      if (canvas.hasPointerCapture?.(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
      if (e.pointerType === 'pen') this.penDown = false;
      if (!tracked) return;

      if (this.mode === 'blocked') {
        if (this.pointers.size === 0) this.mode = 'idle';
        return;
      }
      if (this.mode === 'pinch') {
        if (!this.pinchFrom?.ids.includes(e.pointerId)) return;
        // The finger left behind carries on dragging from where it is.
        this.pinchFrom = null;
        this.studio.emit();
        this.onPictureChanged?.();
        const rest = [...this.pointers].find(([, p]) => p.type === 'touch');
        if (rest) this.startMove(rest[0], rest[1].x, rest[1].y);
        else this.mode = 'idle';
        this.requestDraw();
        return;
      }
      if (e.pointerId === this.activeId) {
        if (this.mode === 'draw') this.studio.endStroke();
        // The picture's new place is saved with the character.
        if (this.mode === 'move') {
          this.studio.emit();
          this.onPictureChanged?.();
        }
        this.moveFrom = null;
        this.mode = 'idle';
        this.activeId = null;
        this.last = null;
      }
      if (e.pointerType === 'touch') this.hover = null;
      this.requestDraw();
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('pointerleave', () => {
      if (this.mode === 'idle' && this.hover) {
        this.hover = null;
        this.requestDraw();
      }
    });

    canvas.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });

    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** The traced picture chosen in the panel, which is the one fingers move. */
  private activePicture(): CharacterReference | null {
    const character = this.studio.character;
    return character ? activeReference(character) : null;
  }

  /** True while the traced picture is showing and unlocked, so fingers move it instead of drawing. */
  private pictureFollowsFingers(): boolean {
    const reference = this.activePicture();
    return !!reference && reference.visible && !reference.locked;
  }

  private startMove(id: number, x: number, y: number): void {
    const reference = this.activePicture();
    if (!reference) return;
    this.mode = 'move';
    this.activeId = id;
    this.moveFrom = { sx: x, sy: y, x: reference.x ?? 0, y: reference.y ?? 0 };
  }

  private startPinch(): void {
    const reference = this.activePicture();
    const touches = [...this.pointers].filter(([, p]) => p.type === 'touch').slice(0, 2);
    if (!reference || touches.length < 2) return;
    const [[idA, a], [idB, b]] = touches;
    this.mode = 'pinch';
    this.activeId = null;
    this.moveFrom = null;
    this.pinchFrom = {
      ids: [idA, idB],
      mid: this.toSprite((a.x + b.x) / 2, (a.y + b.y) / 2),
      distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      scale: reference.scale,
      x: reference.x,
      y: reference.y,
    };
  }

  /** Sizes the picture by how far the fingers have spread, keeping it under them. */
  private pinchReference(): void {
    const character = this.studio.character;
    const reference = this.activePicture();
    const picture = reference?.image;
    const from = this.pinchFrom;
    if (!character || !reference || !picture || !from) return;
    const a = this.pointers.get(from.ids[0]);
    const b = this.pointers.get(from.ids[1]);
    if (!a || !b) return;
    const next = pinchReference(
      picture.naturalWidth,
      picture.naturalHeight,
      character.w,
      character.h,
      from,
      from.mid,
      this.toSprite((a.x + b.x) / 2, (a.y + b.y) / 2),
      Math.hypot(a.x - b.x, a.y - b.y) / from.distance,
    );
    reference.scale = next.scale;
    reference.x = next.x;
    reference.y = next.y;
    this.requestDraw();
  }

  /** A screen point in sprite pixels, not rounded to a cell. */
  private toSprite(sx: number, sy: number): { x: number; y: number } {
    return { x: (sx - this.offsetX) / this.zoom, y: (sy - this.offsetY) / this.zoom };
  }

  private startDraw(id: number, x: number, y: number): void {
    const cell = this.toPixel(x, y);
    const character = this.studio.character;
    // A touch beside the drawing is not a stroke: nothing to record or take back.
    if (!character || cell.x < 0 || cell.y < 0 || cell.x >= character.w || cell.y >= character.h) {
      this.mode = 'idle';
      this.activeId = null;
      return;
    }
    this.mode = 'draw';
    this.activeId = id;
    this.studio.beginStroke();
    this.studio.paint(cell.x, cell.y);
    this.last = cell;
    this.setHover(x, y);
    this.requestDraw();
  }

  /** Follows the finger or Pencil with the traced picture, in sprite pixels. */
  private dragReference(x: number, y: number): void {
    const reference = this.activePicture();
    const from = this.moveFrom;
    if (!reference || !from) return;
    reference.x = from.x + (x - from.sx) / this.zoom;
    reference.y = from.y + (y - from.sy) / this.zoom;
    this.requestDraw();
  }

  private continueDraw(e: PointerEvent, x: number, y: number): void {
    // The Pencil samples faster than the display refreshes; replaying the
    // coalesced queue keeps a quick stroke continuous.
    const coalesced =
      e.pointerType === 'pen' && typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    const points = coalesced.length > 0 ? coalesced.map((s) => this.local(s)) : [{ x, y }];
    for (const point of points) {
      const cell = this.toPixel(point.x, point.y);
      if (this.last) this.studio.paintLine(this.last.x, this.last.y, cell.x, cell.y);
      else this.studio.paint(cell.x, cell.y);
      this.last = cell;
    }
    this.setHover(x, y);
    this.requestDraw();
  }

  private setHover(x: number, y: number): void {
    const cell = this.toPixel(x, y);
    if (this.hover && this.hover.x === cell.x && this.hover.y === cell.y) return;
    this.hover = cell;
    this.requestDraw();
  }
}
