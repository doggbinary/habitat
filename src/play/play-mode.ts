import { DIRECTIONS, frameIndex, type Character } from '../character/model';
import type { Doc } from '../core/doc';
import { EMPTY } from '../core/tiles';
import { drawObject } from '../render/object-draw';
import { drawTile } from '../render/tile-draw';

/** Tiles crossed per second. Roughly a brisk walk at typical tile sizes. */
const SPEED_TILES = 4.2;
/** How far a joystick must move before it counts as a direction. */
const STICK_DEAD_ZONE = 0.18;
const STICK_RADIUS = 52;
/** The character's feet occupy this fraction of a tile when colliding. */
const FOOT_W = 0.6;
const FOOT_H = 0.35;

/**
 * A full-screen play test.
 *
 * The point is to answer questions the editor cannot: is the character the
 * right size next to a doorway, does the walk cycle read at actual speed, can
 * you get through that gap. It borrows just enough of a game loop to be
 * honest about scale and movement, and deliberately nothing more.
 *
 * Layers marked as colliders become solid. If the map has none, you walk
 * freely, which is the right default for checking sizing alone.
 */
export class PlayMode {
  private readonly root: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;

  private readonly mapCanvas: HTMLCanvasElement;
  private readonly spriteCanvas: HTMLCanvasElement;
  private readonly solid: Uint8Array;

  private x = 0;
  private y = 0;
  private dir = 0;
  private walkTime = 0;
  private moving = false;

  private zoom = 3;
  private dpr = 1;
  private viewW = 0;
  private viewH = 0;

  private frameHandle = 0;
  private lastTime = 0;

  private readonly keys = new Set<string>();
  /** Normalised joystick vector, -1..1 on each axis. */
  private stick = { x: 0, y: 0 };
  private stickId: number | null = null;
  private stickOrigin = { x: 0, y: 0 };
  private readonly stickBase: HTMLElement;
  private readonly stickKnob: HTMLElement;

  private readonly onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      this.close();
      return;
    }
    this.keys.add(e.key.toLowerCase());
  };
  private readonly onKeyUp = (e: KeyboardEvent) => this.keys.delete(e.key.toLowerCase());
  private readonly onResize = () => this.resize();

  constructor(
    private readonly doc: Doc,
    private readonly character: Character,
    startTile: { x: number; y: number },
    private readonly onExit: () => void,
  ) {
    this.mapCanvas = composeMap(doc);
    this.solid = buildCollision(doc);

    // Start standing on the middle of the requested tile.
    this.x = (startTile.x + 0.5) * doc.tileSize;
    this.y = (startTile.y + 0.5) * doc.tileSize;

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'play-canvas';
    const ctx = this.canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('2D canvas is unavailable');
    this.ctx = ctx;

    this.spriteCanvas = document.createElement('canvas');
    this.spriteCanvas.width = character.w;
    this.spriteCanvas.height = character.h;

    this.stickKnob = element('div', 'play-stick-knob');
    this.stickBase = element('div', 'play-stick', [this.stickKnob]);

    const exit = element('button', 'play-exit');
    exit.textContent = 'Done';
    exit.addEventListener('click', () => this.close());

    const zoomOut = element('button', 'play-zoom');
    zoomOut.textContent = '−';
    zoomOut.addEventListener('click', () => this.nudgeZoom(-1));
    const zoomIn = element('button', 'play-zoom');
    zoomIn.textContent = '+';
    zoomIn.addEventListener('click', () => this.nudgeZoom(1));

    const hint = element('div', 'play-hint');
    hint.textContent = hasCollision(doc)
      ? 'Drag anywhere to walk. Collision layers block you.'
      : 'Drag anywhere to walk. No collision layer, so nothing blocks you.';

    this.root = element('div', 'play-root', [
      this.canvas,
      hint,
      this.stickBase,
      element('div', 'play-controls', [zoomOut, zoomIn, exit]),
    ]);

    document.body.append(this.root);
    this.bindInput();
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('resize', this.onResize);

    this.resize();
    this.fitZoom();
    this.lastTime = performance.now();
    this.frameHandle = requestAnimationFrame(this.tick);
  }

  // --- Setup ---------------------------------------------------------------

  /** Picks a zoom that frames roughly 22 tiles across, then rounds to integer. */
  private fitZoom(): void {
    const target = this.viewW / (22 * this.doc.tileSize);
    this.zoom = Math.max(1, Math.min(8, Math.round(target) || 2));
  }

  private nudgeZoom(delta: number): void {
    this.zoom = Math.max(1, Math.min(8, this.zoom + delta));
  }

  private resize(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.viewW = window.innerWidth;
    this.viewH = window.innerHeight;
    this.dpr = dpr;
    this.canvas.width = Math.round(this.viewW * dpr);
    this.canvas.height = Math.round(this.viewH * dpr);
  }

  private bindInput(): void {
    // The whole canvas is the joystick: touch down anywhere and drag. That
    // avoids hunting for a small control while watching the character.
    this.canvas.addEventListener(
      'pointerdown',
      (e) => {
        e.preventDefault();
        if (this.stickId !== null) return;
        this.stickId = e.pointerId;
        this.stickOrigin = { x: e.clientX, y: e.clientY };
        this.canvas.setPointerCapture?.(e.pointerId);
        this.showStick(e.clientX, e.clientY, 0, 0);
      },
      { passive: false },
    );

    this.canvas.addEventListener(
      'pointermove',
      (e) => {
        if (e.pointerId !== this.stickId) return;
        e.preventDefault();
        const dx = e.clientX - this.stickOrigin.x;
        const dy = e.clientY - this.stickOrigin.y;
        const distance = Math.hypot(dx, dy) || 1;
        const clamped = Math.min(distance, STICK_RADIUS);
        this.stick = { x: (dx / distance) * (clamped / STICK_RADIUS), y: (dy / distance) * (clamped / STICK_RADIUS) };
        this.showStick(this.stickOrigin.x, this.stickOrigin.y, (dx / distance) * clamped, (dy / distance) * clamped);
      },
      { passive: false },
    );

    const release = (e: PointerEvent) => {
      if (e.pointerId !== this.stickId) return;
      this.stickId = null;
      this.stick = { x: 0, y: 0 };
      this.stickBase.style.opacity = '0';
    };
    this.canvas.addEventListener('pointerup', release);
    this.canvas.addEventListener('pointercancel', release);
  }

  private showStick(cx: number, cy: number, dx: number, dy: number): void {
    this.stickBase.style.opacity = '1';
    this.stickBase.style.left = `${cx}px`;
    this.stickBase.style.top = `${cy}px`;
    this.stickKnob.style.transform = `translate(${dx}px, ${dy}px)`;
  }

  // --- Loop ----------------------------------------------------------------

  private tick = (now: number): void => {
    this.frameHandle = requestAnimationFrame(this.tick);
    // Clamp the step so a backgrounded tab cannot teleport the character.
    const dt = Math.min(0.05, (now - this.lastTime) / 1000);
    this.lastTime = now;
    this.update(dt);
    this.draw();
  };

  private update(dt: number): void {
    let vx = this.stick.x;
    let vy = this.stick.y;

    if (this.keys.has('arrowleft') || this.keys.has('a')) vx -= 1;
    if (this.keys.has('arrowright') || this.keys.has('d')) vx += 1;
    if (this.keys.has('arrowup') || this.keys.has('w')) vy -= 1;
    if (this.keys.has('arrowdown') || this.keys.has('s')) vy += 1;

    const magnitude = Math.hypot(vx, vy);
    this.moving = magnitude > STICK_DEAD_ZONE;

    if (!this.moving) {
      // Settle on the standing frame rather than freezing mid-stride.
      this.walkTime = 0;
      return;
    }

    // Normalise so diagonals are not faster than the cardinals.
    vx /= magnitude;
    vy /= magnitude;

    // Face whichever axis dominates, which is what reads correctly for
    // four-direction art.
    if (Math.abs(vx) > Math.abs(vy)) this.dir = DIRECTIONS.indexOf(vx < 0 ? 'left' : 'right');
    else this.dir = DIRECTIONS.indexOf(vy < 0 ? 'up' : 'down');

    const step = SPEED_TILES * this.doc.tileSize * dt;
    // Resolve axes separately so hitting a wall slides along it instead of
    // stopping dead.
    this.moveAxis(vx * step, 0);
    this.moveAxis(0, vy * step);

    this.walkTime += dt;
  }

  private moveAxis(dx: number, dy: number): void {
    const nextX = this.x + dx;
    const nextY = this.y + dy;
    if (!this.blocked(nextX, nextY)) {
      this.x = nextX;
      this.y = nextY;
    }
  }

  /** Tests the character's feet, not its whole body, against solid tiles. */
  private blocked(cx: number, cy: number): boolean {
    const size = this.doc.tileSize;
    const halfW = (FOOT_W * size) / 2;
    const halfH = (FOOT_H * size) / 2;

    const left = Math.floor((cx - halfW) / size);
    const right = Math.floor((cx + halfW) / size);
    const top = Math.floor((cy - halfH) / size);
    const bottom = Math.floor((cy + halfH) / size);

    for (let ty = top; ty <= bottom; ty++) {
      for (let tx = left; tx <= right; tx++) {
        // The map edge is a wall, so you cannot wander off the canvas.
        if (tx < 0 || ty < 0 || tx >= this.doc.width || ty >= this.doc.height) return true;
        if (this.solid[ty * this.doc.width + tx]) return true;
      }
    }
    return false;
  }

  private draw(): void {
    const { ctx } = this;
    const zoom = this.zoom;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#0b0c10';
    ctx.fillRect(0, 0, this.viewW, this.viewH);
    ctx.imageSmoothingEnabled = false;

    const mapW = this.doc.width * this.doc.tileSize;
    const mapH = this.doc.height * this.doc.tileSize;

    // Centre on the character, but stop at the map edges unless the map is
    // smaller than the screen, in which case centre the map itself.
    const viewWorldW = this.viewW / zoom;
    const viewWorldH = this.viewH / zoom;
    const camX = mapW < viewWorldW ? (mapW - viewWorldW) / 2 : clamp(this.x - viewWorldW / 2, 0, mapW - viewWorldW);
    const camY = mapH < viewWorldH ? (mapH - viewWorldH) / 2 : clamp(this.y - viewWorldH / 2, 0, mapH - viewWorldH);

    ctx.drawImage(this.mapCanvas, -camX * zoom, -camY * zoom, mapW * zoom, mapH * zoom);

    // Walk frames alternate stand, step, stand, other step.
    const frame = this.moving
      ? Math.floor(this.walkTime / (this.character.frameMs / 1000)) % this.character.frameCount
      : 0;
    const cell = this.character.frames[frameIndex(this.dir, frame, this.character.frameCount)];
    if (!cell) return;

    const sctx = this.spriteCanvas.getContext('2d');
    if (!sctx) return;
    const image = sctx.createImageData(this.character.w, this.character.h);
    image.data.set(cell.data);
    sctx.putImageData(image, 0, 0);

    // Feet sit on the character's position; the art rises above it.
    const drawX = (this.x - this.character.w / 2 - camX) * zoom;
    const drawY = (this.y + (FOOT_H * this.doc.tileSize) / 2 - this.character.h - camY) * zoom;
    ctx.drawImage(this.spriteCanvas, drawX, drawY, this.character.w * zoom, this.character.h * zoom);
  }

  // --- Teardown ------------------------------------------------------------

  close(): void {
    cancelAnimationFrame(this.frameHandle);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('resize', this.onResize);
    this.root.remove();
    this.onExit();
  }
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.max(min, Math.min(max, value));
}

function element(tag: string, className: string, children: HTMLElement[] = []): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  for (const child of children) node.append(child);
  return node;
}

function hasCollision(doc: Doc): boolean {
  return doc.layers.some((l) => l.kind === 'tiles' && l.collider);
}

/** Flattens every visible tile layer into one canvas, drawn once per session. */
function composeMap(doc: Doc): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = doc.width * doc.tileSize;
  canvas.height = doc.height * doc.tileSize;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = doc.background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (const layer of doc.layers) {
    if (!layer.visible) continue;
    ctx.globalAlpha = layer.opacity;
    if (layer.kind === 'image') {
      if (layer.image) {
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(layer.image, layer.x, layer.y, layer.w, layer.h);
        ctx.imageSmoothingEnabled = false;
      }
      continue;
    }
    if (layer.kind === 'objects') {
      for (const obj of layer.objects) drawObject(ctx, doc, obj, 0, 0, 1);
      continue;
    }
    for (let y = 0; y < doc.height; y++) {
      const row = y * doc.width;
      for (let x = 0; x < doc.width; x++) {
        const tile = layer.data[row + x];
        if (tile === EMPTY) continue;
        drawTile(ctx, doc, tile, x * doc.tileSize, y * doc.tileSize, doc.tileSize);
      }
    }
  }
  ctx.globalAlpha = 1;
  return canvas;
}

/** Any tile on a collision layer is solid. */
function buildCollision(doc: Doc): Uint8Array {
  const solid = new Uint8Array(doc.width * doc.height);
  for (const layer of doc.layers) {
    if (layer.kind !== 'tiles' || !layer.collider) continue;
    for (let i = 0; i < solid.length; i++) {
      if (layer.data[i] !== EMPTY) solid[i] = 1;
    }
  }
  return solid;
}
