import { DIRECTIONS, frameIndex, type Character } from '../character/model';
import { createLayer, objectSize, type Doc, type TileLayer } from '../core/doc';
import type { Store } from '../core/store';
import { EMPTY, pack } from '../core/tiles';
import { drawObject } from '../render/object-draw';
import { drawTile } from '../render/tile-draw';
import type { ObjectTools } from '../tools/objects';

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

  private readonly doc: Doc;
  private readonly mapCanvas: HTMLCanvasElement;
  private readonly spriteCanvas: HTMLCanvasElement;
  private readonly solid: Uint8Array;

  /** Walk, resize an object, or paint squares the character cannot enter. */
  private tool: 'walk' | 'size' | 'block' = 'walk';
  private editId: number | null = null;
  private sizing = false;
  private dragging = false;
  private grabDx = 0;
  private grabDy = 0;
  private dragStart = { x: 0, y: 0 };
  private scaleStart = 1;
  private scaleStartDistance = 1;
  private blockClearing = false;
  private blockLayer: TileLayer | null = null;
  private blockBefore: Int32Array | null = null;

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
    private readonly store: Store,
    private readonly objects: ObjectTools,
    private readonly character: Character,
    startTile: { x: number; y: number },
    private readonly onExit: () => void,
  ) {
    this.doc = store.doc;
    this.mapCanvas = composeMap(this.doc);
    this.solid = buildCollision(this.doc);

    // Start standing on the middle of the requested tile.
    this.x = (startTile.x + 0.5) * this.doc.tileSize;
    this.y = (startTile.y + 0.5) * this.doc.tileSize;

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
    hint.textContent = 'Drag to walk. In Size, drag an object to move it and its corner to resize. Block paints squares you cannot enter.';

    const tools = element('div', 'play-tools');
    for (const [id, label] of [
      ['walk', 'Walk'],
      ['size', 'Size'],
      ['block', 'Block'],
    ] as const) {
      const button = element('button', `play-tool${id === 'walk' ? ' active' : ''}`) as HTMLButtonElement;
      button.type = 'button';
      button.textContent = label;
      button.addEventListener('click', () => {
        this.tool = id;
        this.sizing = false;
        this.dragging = false;
        if (id !== 'size') this.objects.deselect();
        for (const child of tools.children) child.classList.toggle('active', child === button);
      });
      tools.append(button);
    }

    this.root = element('div', 'play-root', [
      this.canvas,
      hint,
      this.stickBase,
      tools,
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
    // The whole canvas is the joystick while walking. Size and Block use the
    // same surface to change the map, and the character feels it at once.
    this.canvas.addEventListener(
      'pointerdown',
      (e) => {
        e.preventDefault();
        if (this.tool !== 'walk') {
          this.onEditDown(e);
          return;
        }
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
        if (this.tool !== 'walk') {
          this.onEditMove(e);
          return;
        }
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
      if (this.tool !== 'walk') {
        this.onEditUp(e);
        return;
      }
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

  // --- Editing while the character is in the scene ------------------------

  private onEditDown(e: PointerEvent): void {
    if (this.editId !== null) return;
    this.editId = e.pointerId;
    this.canvas.setPointerCapture?.(e.pointerId);
    const local = this.local(e);
    if (this.tool === 'size') {
      const found = this.objects.selected();
      if (found && this.onHandle(local.x, local.y)) {
        const world = this.worldAt(local.x, local.y);
        this.sizing = true;
        this.scaleStart = found.obj.scale;
        this.scaleStartDistance = Math.max(1, Math.hypot(world.x - found.obj.x, world.y - found.obj.y));
        this.objects.beginGesture();
        return;
      }
      const world = this.worldAt(local.x, local.y);
      const hit = this.objects.hitTest(world.x, world.y);
      if (hit) {
        this.objects.select(hit.layer, hit.obj);
        if (!hit.obj.locked) {
          this.dragging = true;
          this.grabDx = world.x - hit.obj.x;
          this.grabDy = world.y - hit.obj.y;
          this.dragStart = { x: hit.obj.x, y: hit.obj.y };
          this.objects.beginGesture();
        }
      } else {
        this.objects.deselect();
      }
      return;
    }
    this.blockLayer = ensureCollisionLayer(this.doc);
    this.blockBefore = this.blockLayer.data.slice();
    this.blockClearing = this.cellSolid(this.cellAt(local.x, local.y));
    this.paintBlock(local.x, local.y);
  }

  private onEditMove(e: PointerEvent): void {
    if (e.pointerId !== this.editId) return;
    const local = this.local(e);
    if (this.tool === 'size' && (this.sizing || this.dragging)) {
      const found = this.objects.selected();
      if (!found) return;
      const world = this.worldAt(local.x, local.y);
      if (this.sizing) {
        const distance = Math.hypot(world.x - found.obj.x, world.y - found.obj.y);
        this.objects.scaleTo(found.obj, this.scaleStart * (distance / this.scaleStartDistance));
      } else {
        this.objects.moveSelected(found.obj, world.x - this.grabDx, world.y - this.grabDy);
      }
      return;
    }
    if (this.tool === 'block') this.paintBlock(local.x, local.y);
  }

  private onEditUp(e: PointerEvent): void {
    if (e.pointerId !== this.editId) return;
    if (this.sizing) this.objects.endGesture('Resize');
    if (this.dragging) {
      const found = this.objects.selected();
      if (found && found.obj.x === this.dragStart.x && found.obj.y === this.dragStart.y) this.objects.cancelGesture();
      else this.objects.endGesture('Move');
    }
    this.commitBlock();
    this.sizing = false;
    this.dragging = false;
    this.editId = null;
  }

  /** One undo step for a whole Block stroke. The squares already block the character. */
  private commitBlock(): void {
    const layer = this.blockLayer;
    const before = this.blockBefore;
    this.blockLayer = null;
    this.blockBefore = null;
    if (!layer || !before) return;
    const after = layer.data.slice();
    let changed = false;
    for (let i = 0; i < after.length; i++) if (after[i] !== before[i]) changed = true;
    if (!changed) return;
    layer.data.set(before);
    this.store.history.transact('Collision', () => {
      layer.data.set(after);
    });
  }

  /** Grows from the centre, so the first sample matches the size the object already is. */
  private onHandle(sx: number, sy: number): boolean {
    const found = this.objects.selected();
    if (!found) return false;
    const { w, h } = objectSize(found.obj);
    const cam = this.camera();
    const hx = (found.obj.x + w / 2 - cam.x) * this.zoom;
    const hy = (found.obj.y + h / 2 - cam.y) * this.zoom;
    return Math.hypot(sx - hx, sy - hy) <= 28;
  }

  private paintBlock(sx: number, sy: number): void {
    const cell = this.cellAt(sx, sy);
    if (!cell) return;
    const layer = this.blockLayer;
    if (!layer) return;
    const index = cell.y * this.doc.width + cell.x;
    const tile = this.blockClearing ? EMPTY : this.markerTile();
    if (layer.data[index] === tile) return;
    layer.data[index] = tile;
    this.solid[index] = tile === EMPTY ? 0 : 1;
  }

  private markerTile(): number {
    for (const tile of this.store.stamp.tiles) if (tile !== EMPTY) return tile;
    return this.doc.tilesets.length > 0 ? pack(0, 0) : EMPTY;
  }

  private cellSolid(cell: { x: number; y: number } | null): boolean {
    if (!cell) return false;
    return this.solid[cell.y * this.doc.width + cell.x] === 1;
  }

  private local(e: PointerEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private cellAt(sx: number, sy: number): { x: number; y: number } | null {
    const world = this.worldAt(sx, sy);
    const size = this.doc.tileSize;
    const x = Math.floor(world.x / size);
    const y = Math.floor(world.y / size);
    if (x < 0 || y < 0 || x >= this.doc.width || y >= this.doc.height) return null;
    return { x, y };
  }

  private worldAt(sx: number, sy: number): { x: number; y: number } {
    const cam = this.camera();
    return { x: cam.x + sx / this.zoom, y: cam.y + sy / this.zoom };
  }

  private camera(): { x: number; y: number } {
    const zoom = this.zoom;
    const mapW = this.doc.width * this.doc.tileSize;
    const mapH = this.doc.height * this.doc.tileSize;
    const viewWorldW = this.viewW / zoom;
    const viewWorldH = this.viewH / zoom;
    return {
      x: mapW < viewWorldW ? (mapW - viewWorldW) / 2 : clamp(this.x - viewWorldW / 2, 0, mapW - viewWorldW),
      y: mapH < viewWorldH ? (mapH - viewWorldH) / 2 : clamp(this.y - viewWorldH / 2, 0, mapH - viewWorldH),
    };
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
    const cam = this.camera();
    const camX = cam.x;
    const camY = cam.y;

    ctx.drawImage(this.mapCanvas, -camX * zoom, -camY * zoom, mapW * zoom, mapH * zoom);

    ctx.globalAlpha = 1;
    for (const layer of this.doc.layers) {
      if (layer.kind !== 'objects' || !layer.visible) continue;
      ctx.globalAlpha = layer.opacity;
      for (const obj of layer.objects) drawObject(ctx, this.doc, obj, -camX * zoom, -camY * zoom, zoom);
    }
    ctx.globalAlpha = 1;

    ctx.fillStyle = 'rgba(255, 90, 90, 0.38)';
    const size = this.doc.tileSize;
    for (let i = 0; i < this.solid.length; i++) {
      if (!this.solid[i]) continue;
      const tx = i % this.doc.width;
      const ty = (i / this.doc.width) | 0;
      ctx.fillRect((tx * size - camX) * zoom, (ty * size - camY) * zoom, size * zoom, size * zoom);
    }

    if (this.tool === 'size') {
      const found = this.objects.selected();
      if (found) {
        const { w, h } = objectSize(found.obj);
        const x = (found.obj.x - w / 2 - camX) * zoom;
        const y = (found.obj.y - h / 2 - camY) * zoom;
        ctx.strokeStyle = '#ffd666';
        ctx.lineWidth = 2;
        ctx.strokeRect(x, y, w * zoom, h * zoom);
        ctx.fillStyle = '#ffd666';
        ctx.beginPath();
        ctx.arc(x + w * zoom, y + h * zoom, 9, 0, Math.PI * 2);
        ctx.fill();
      }
    }

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
    if (layer.kind === 'objects') continue;
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

/** The layer whose squares block the character, created the first time one is painted. */
export function ensureCollisionLayer(doc: Doc): TileLayer {
  for (const layer of doc.layers) {
    if (layer.kind === 'tiles' && layer.collider) return layer;
  }
  const layer = createLayer(doc.width, doc.height, 'Collision');
  layer.collider = true;
  layer.opacity = 0.45;
  doc.layers.push(layer);
  return layer;
}

/** Any tile on a collision layer is solid. */
export function buildCollision(doc: Doc): Uint8Array {
  const solid = new Uint8Array(doc.width * doc.height);
  for (const layer of doc.layers) {
    if (layer.kind !== 'tiles' || !layer.collider) continue;
    for (let i = 0; i < solid.length; i++) {
      if (layer.data[i] !== EMPTY) solid[i] = 1;
    }
  }
  return solid;
}
