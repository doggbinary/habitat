import type { Settings } from '../core/store';
import type { Character, Frame } from './model';
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

  private dpr = 1;
  private viewW = 0;
  private viewH = 0;
  private frameHandle = 0;

  private hover: { x: number; y: number } | null = null;
  private readonly pointers = new Map<number, { type: string; x: number; y: number; lastX: number; lastY: number }>();
  private mode: 'idle' | 'draw' | 'pan' | 'pinch' = 'idle';
  private activeId: number | null = null;
  private penDown = false;
  private last: { x: number; y: number } | null = null;
  private pinchDistance = 1;
  private pinchZoom = 1;
  private pinchMid = { x: 0, y: 0 };

  /** Scratch canvas a frame is written into before being scaled up. */
  private readonly scratch = document.createElement('canvas');
  private readonly scratchCtx: CanvasRenderingContext2D;

  constructor(
    private readonly studio: Studio,
    private readonly settings: Settings,
  ) {
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

  private zoomAt(sx: number, sy: number, nextZoom: number): void {
    const zoom = Math.max(1, Math.min(64, nextZoom));
    // Keep the sprite pixel under the gesture anchored while scaling.
    const px = (sx - this.offsetX) / this.zoom;
    const py = (sy - this.offsetY) / this.zoom;
    this.zoom = zoom;
    this.offsetX = sx - px * zoom;
    this.offsetY = sy - py * zoom;
  }

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
    image.data.set(frame.data);
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
    ctx.imageSmoothingEnabled = false;

    // Onion skin first, faint, so the previous pose guides the current one.
    const onion = this.studio.onionFrame;
    if (onion) {
      ctx.globalAlpha = 0.28;
      ctx.drawImage(this.frameCanvas(character, onion), x, y, w, h);
      ctx.globalAlpha = 1;
    }

    const frame = this.studio.currentFrame;
    if (frame) ctx.drawImage(this.frameCanvas(character, frame), x, y, w, h);

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
    ctx.strokeStyle = CURSOR;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x + hover.x * this.zoom, y + hover.y * this.zoom, this.zoom, this.zoom);
    if (this.studio.mirrorX) {
      const mx = character.w - 1 - hover.x;
      if (mx !== hover.x) {
        ctx.globalAlpha = 0.5;
        ctx.strokeRect(x + mx * this.zoom, y + hover.y * this.zoom, this.zoom, this.zoom);
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
        this.pointers.set(e.pointerId, { type: e.pointerType, x, y, lastX: x, lastY: y });
        canvas.setPointerCapture?.(e.pointerId);

        if (e.pointerType === 'pen') {
          this.penDown = true;
          for (const [id, p] of [...this.pointers]) if (p.type === 'touch') this.pointers.delete(id);
          this.startDraw(e.pointerId, x, y);
          return;
        }
        if (e.pointerType === 'mouse') {
          if (e.button === 0) this.startDraw(e.pointerId, x, y);
          else {
            this.mode = 'pan';
            this.activeId = e.pointerId;
          }
          return;
        }

        if (this.touchCount() === 1) {
          if (this.settings.fingerDraws) this.startDraw(e.pointerId, x, y);
          else {
            this.mode = 'pan';
            this.activeId = e.pointerId;
          }
        } else {
          // A pinch is navigation, so undo whatever the first finger drew.
          if (this.mode === 'draw') {
            this.studio.endStroke();
            this.studio.undo();
          }
          this.startPinch();
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

        if (this.mode === 'pinch') {
          this.updatePinch();
          return;
        }
        if (this.mode === 'pan' && e.pointerId === this.activeId) {
          this.offsetX += x - tracked.lastX;
          this.offsetY += y - tracked.lastY;
          tracked.lastX = x;
          tracked.lastY = y;
          this.requestDraw();
          return;
        }
        tracked.lastX = x;
        tracked.lastY = y;

        if (this.mode === 'draw' && e.pointerId === this.activeId) {
          this.continueDraw(e, x, y);
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

      if (this.mode === 'pinch') {
        if (this.touchCount() >= 2) this.startPinch();
        else if (this.touchCount() === 0) this.mode = 'idle';
        return;
      }
      if (e.pointerId === this.activeId) {
        if (this.mode === 'draw') this.studio.endStroke();
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

    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const { x, y } = this.local(e);
        if (e.ctrlKey || e.metaKey) this.zoomAt(x, y, this.zoom * Math.exp(-e.deltaY * 0.01));
        else {
          this.offsetX -= e.deltaX;
          this.offsetY -= e.deltaY;
        }
        this.requestDraw();
      },
      { passive: false },
    );

    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private startDraw(id: number, x: number, y: number): void {
    this.mode = 'draw';
    this.activeId = id;
    const cell = this.toPixel(x, y);
    this.studio.beginStroke();
    this.studio.paint(cell.x, cell.y);
    this.last = cell;
    this.setHover(x, y);
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

  private startPinch(): void {
    const touches = [...this.pointers.values()].filter((p) => p.type === 'touch');
    if (touches.length < 2) return;
    const [a, b] = touches;
    this.pinchDistance = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    this.pinchZoom = this.zoom;
    this.pinchMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    this.mode = 'pinch';
    this.activeId = null;
  }

  private updatePinch(): void {
    const touches = [...this.pointers.values()].filter((p) => p.type === 'touch');
    if (touches.length < 2) return;
    const [a, b] = touches;
    const distance = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    this.zoomAt(mid.x, mid.y, this.pinchZoom * (distance / this.pinchDistance));
    this.offsetX += mid.x - this.pinchMid.x;
    this.offsetY += mid.y - this.pinchMid.y;
    this.pinchMid = mid;
    this.requestDraw();
  }

  private setHover(x: number, y: number): void {
    const cell = this.toPixel(x, y);
    if (this.hover && this.hover.x === cell.x && this.hover.y === cell.y) return;
    this.hover = cell;
    this.requestDraw();
  }
}
