import { DIRECTIONS, frameIndex, framePixels, type Character, type Frame } from '../character/model';
import { createLayer, objectSize, type Doc, type MapObject, type TileLayer } from '../core/doc';
import type { Store } from '../core/store';
import { EMPTY } from '../core/tiles';
import { drawObject } from '../render/object-draw';
import { drawTile } from '../render/tile-draw';
import { scaleFromCorner, type ObjectTools } from '../tools/objects';

/** Tiles crossed per second. Roughly a brisk walk at typical tile sizes. */
const SPEED_TILES = 4.2;
/** How far a joystick must move before it counts as a direction. */
const STICK_DEAD_ZONE = 0.18;
/** Furthest the knob travels from the centre of the pad, in CSS pixels. */
const STICK_RADIUS = 38;
/** The character's feet occupy this fraction of a tile when colliding. */
const FOOT_W = 0.6;
const FOOT_H = 0.35;
const MIN_ZOOM = 1;
const MAX_ZOOM = 8;
/** Movement under this many pixels is still a tap. */
const TAP_SLOP = 6;
/** Fingers that land and lift within this long, without moving, are a tap. */
const TAP_MS = 350;
/** Several fingers wobble more than one, so their taps get a looser slop. */
const MULTI_TAP_SLOP = 14;

type Gesture = 'idle' | 'move' | 'size' | 'pinch';

const PLAY_HINT =
  'Walk with the stick. Tap an object to move, size, block, lock it or make it a door. Pinch to zoom. Two-finger tap undoes, three redoes.';
/** How long the screen takes to fade back in after a door, in seconds. */
const DOOR_FADE_S = 0.35;

/**
 * A full-screen play test.
 *
 * The point is to answer questions the editor cannot: is the character the
 * right size next to a doorway, does the walk cycle read at actual speed, can
 * you get through that gap. It borrows just enough of a game loop to be
 * honest about scale and movement, and deliberately nothing more.
 *
 * The stick in the corner walks. Everything else on screen is the map: tap an
 * object to move it, size it, or make it block the character, and pinch to zoom.
 */
export class PlayMode {
  private readonly root: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;

  private readonly doc: Doc;
  private readonly mapCanvas: HTMLCanvasElement;
  private readonly spriteCanvas: HTMLCanvasElement;
  private readonly solid: Uint8Array;

  private readonly pointers = new Map<number, { x: number; y: number; startX: number; startY: number }>();
  private gesture: Gesture = 'idle';
  private activeId: number | null = null;
  private moved = false;
  private grabDx = 0;
  private grabDy = 0;
  private scaleStart = 1;
  private scaleAnchor = { x: 0, y: 0 };
  private scaleStartSize = { w: 1, h: 1 };
  private pinchDistance = 1;
  private pinchZoom = 1;
  /** Bookkeeping for two- and three-finger taps, which undo and redo. */
  private touchStart = 0;
  private touchMost = 0;
  private touchWandered = false;
  /** The corner grip only shows once Size is chosen for the tapped object. */
  private sizeOpen = false;
  /** The object whose door is waiting for a tap on where it leads. */
  private linkingDoor: string | null = null;
  /** False after going through a door, until the feet leave every doorway, so nobody bounces straight back. */
  private doorArmed = true;
  /** Black over the screen after a door, fading from 1 to 0. */
  private fade = 0;

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
  private readonly stickBase: HTMLElement;
  private readonly stickKnob: HTMLElement;
  private readonly menu: HTMLElement;
  private readonly sizeButton: HTMLButtonElement;
  private readonly blockButton: HTMLButtonElement;
  private readonly lockButton: HTMLButtonElement;
  private readonly doorButton: HTMLButtonElement;
  private readonly hint: HTMLElement;
  private readonly smallerButton: HTMLButtonElement;
  private readonly biggerButton: HTMLButtonElement;
  private readonly undoButton: HTMLButtonElement;
  private readonly redoButton: HTMLButtonElement;

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
    /** Called with the square the character's feet ended on. */
    private readonly onExit: (tile: { x: number; y: number }) => void,
  ) {
    this.doc = store.doc;
    this.mapCanvas = composeMap(this.doc);
    this.solid = buildCollision(this.doc);
    this.objects.deselect();

    // Start standing on the middle of the requested tile.
    this.x = (startTile.x + 0.5) * this.doc.tileSize;
    this.y = (startTile.y + 0.5) * this.doc.tileSize;
    // Starting in a doorway must not count as walking through it.
    this.doorArmed = !doorAt(this.doc, this.x, this.y);

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

    const exit = button('play-exit', 'Done', () => this.close());
    this.undoButton = button('play-history', 'Undo', () => this.stepHistory(false));
    this.redoButton = button('play-history', 'Redo', () => this.stepHistory(true));
    const zoomOut = button('play-zoom', '−', () => this.nudgeZoom(-1));
    const zoomIn = button('play-zoom', '+', () => this.nudgeZoom(1));

    this.sizeButton = button('play-menu-btn', 'Size', () => {
      this.sizeOpen = !this.sizeOpen;
    });
    this.smallerButton = button('play-menu-btn play-menu-step', '−', () => this.stepSize(-1));
    this.biggerButton = button('play-menu-btn play-menu-step', '+', () => this.stepSize(1));
    this.blockButton = button('play-menu-btn', 'Block', () => this.toggleBlock());
    this.lockButton = button('play-menu-btn', 'Lock', () => this.toggleLock());
    this.doorButton = button('play-menu-btn', 'Door', () => this.toggleDoor());
    this.menu = element('div', 'play-object-menu', [
      this.sizeButton,
      this.smallerButton,
      this.biggerButton,
      this.blockButton,
      this.doorButton,
      this.lockButton,
    ]);
    // A press on the menu must not reach the map underneath and deselect.
    this.menu.addEventListener('pointerdown', (e) => e.stopPropagation());

    this.hint = element('div', 'play-hint');
    this.hint.textContent = PLAY_HINT;

    this.root = element('div', 'play-root', [
      this.canvas,
      this.hint,
      this.menu,
      this.stickBase,
      element('div', 'play-controls', [this.undoButton, this.redoButton, zoomOut, zoomIn, exit]),
    ]);

    document.body.append(this.root);
    this.bindStick();
    this.bindMap();
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
    this.zoom = clamp(Math.round(target) || 2, MIN_ZOOM, MAX_ZOOM);
  }

  /** Far enough out to see the whole map at once, or 1x when that is further in. */
  private minZoom(): number {
    const mapW = this.doc.width * this.doc.tileSize;
    const mapH = this.doc.height * this.doc.tileSize;
    if (!this.viewW || !this.viewH || !mapW || !mapH) return MIN_ZOOM;
    return Math.min(MIN_ZOOM, this.viewW / mapW, this.viewH / mapH);
  }

  /** Whole steps at 1x and up, where pixels stay even; smaller steps below, down to the whole map. */
  private nudgeZoom(delta: number): void {
    this.zoom = clamp(nextZoom(this.zoom, delta), this.minZoom(), MAX_ZOOM);
  }

  private resize(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.viewW = window.innerWidth;
    this.viewH = window.innerHeight;
    this.dpr = dpr;
    this.canvas.width = Math.round(this.viewW * dpr);
    this.canvas.height = Math.round(this.viewH * dpr);
  }

  // --- Walking stick -------------------------------------------------------

  /** The pad stays in the corner. The knob follows the finger but never leaves the pad. */
  private bindStick(): void {
    const base = this.stickBase;
    const aim = (e: PointerEvent) => {
      const rect = base.getBoundingClientRect();
      const dx = e.clientX - (rect.left + rect.width / 2);
      const dy = e.clientY - (rect.top + rect.height / 2);
      const distance = Math.hypot(dx, dy) || 1;
      const reach = Math.min(distance, STICK_RADIUS);
      const kx = (dx / distance) * reach;
      const ky = (dy / distance) * reach;
      this.stick = { x: kx / STICK_RADIUS, y: ky / STICK_RADIUS };
      this.stickKnob.style.transform = `translate(${kx}px, ${ky}px)`;
    };
    base.addEventListener(
      'pointerdown',
      (e) => {
        e.preventDefault();
        if (this.stickId !== null) return;
        this.stickId = e.pointerId;
        base.setPointerCapture?.(e.pointerId);
        base.classList.add('active');
        aim(e);
      },
      { passive: false },
    );
    base.addEventListener(
      'pointermove',
      (e) => {
        if (e.pointerId !== this.stickId) return;
        e.preventDefault();
        aim(e);
      },
      { passive: false },
    );
    const release = (e: PointerEvent) => {
      if (e.pointerId !== this.stickId) return;
      this.stickId = null;
      this.stick = { x: 0, y: 0 };
      this.stickKnob.style.transform = '';
      base.classList.remove('active');
    };
    base.addEventListener('pointerup', release);
    base.addEventListener('pointercancel', release);
  }

  // --- The map: objects and zoom -------------------------------------------

  private bindMap(): void {
    const canvas = this.canvas;
    canvas.addEventListener(
      'pointerdown',
      (e) => {
        e.preventDefault();
        const local = this.local(e);
        // The first finger of a new touch: anything still tracked lost its
        // lift somewhere, and would otherwise turn every touch into a pinch
        // that never moves.
        if (e.isPrimary && this.pointers.size > 0) {
          if (this.gesture === 'move' || this.gesture === 'size') this.finishGesture();
          this.pointers.clear();
          this.gesture = 'idle';
          this.activeId = null;
        }
        if (this.pointers.size === 0) {
          this.touchStart = performance.now();
          this.touchMost = 0;
          this.touchWandered = false;
        }
        this.pointers.set(e.pointerId, { ...local, startX: local.x, startY: local.y });
        this.touchMost = Math.max(this.touchMost, this.pointers.size);
        canvas.setPointerCapture?.(e.pointerId);
        if (this.pointers.size >= 2) {
          this.startPinch();
          return;
        }
        this.pressMap(e.pointerId, local.x, local.y);
      },
      { passive: false },
    );
    canvas.addEventListener(
      'pointermove',
      (e) => {
        const tracked = this.pointers.get(e.pointerId);
        if (!tracked) return;
        e.preventDefault();
        const local = this.local(e);
        tracked.x = local.x;
        tracked.y = local.y;
        if (Math.hypot(local.x - tracked.startX, local.y - tracked.startY) > MULTI_TAP_SLOP) this.touchWandered = true;
        if (this.gesture === 'pinch') {
          this.updatePinch();
          return;
        }
        if (e.pointerId !== this.activeId) return;
        if (!this.moved && Math.hypot(local.x - tracked.startX, local.y - tracked.startY) <= TAP_SLOP) return;
        this.moved = true;
        this.dragTo(local.x, local.y);
      },
      { passive: false },
    );
    const release = (e: PointerEvent) => {
      if (!this.pointers.delete(e.pointerId)) return;
      if (this.gesture === 'pinch') {
        if (this.pointers.size === 0) {
          this.gesture = 'idle';
          this.multiFingerTap(e.type === 'pointerup');
        }
        return;
      }
      if (e.pointerId !== this.activeId) return;
      this.finishGesture();
    };
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);
    canvas.addEventListener('lostpointercapture', release);
    // A trackpad pinch arrives as a wheel with ctrl held; a mouse wheel steps.
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const factor = e.ctrlKey ? Math.exp(-e.deltaY / 100) : e.deltaY < 0 ? 1.25 : 0.8;
        this.zoom = clamp(this.zoom * factor, this.minZoom(), MAX_ZOOM);
      },
      { passive: false },
    );
  }

  private pressMap(id: number, sx: number, sy: number): void {
    const world = this.worldAt(sx, sy);
    if (this.linkingDoor) {
      this.linkDoorTo(world.x, world.y);
      return;
    }
    const found = this.objects.selected();
    if (found && this.sizeOpen && !found.obj.locked && this.onHandle(sx, sy)) {
      const size = objectSize(found.obj);
      const anchor = { x: found.obj.x - size.w / 2, y: found.obj.y - size.h / 2 };
      this.scaleStart = found.obj.scale;
      this.scaleAnchor = anchor;
      // The grab is the unit of scale, so touching the grip does not jump the
      // size. Later samples stay measured from this corner, not the centre.
      this.scaleStartSize = { w: Math.max(1, world.x - anchor.x), h: Math.max(1, world.y - anchor.y) };
      this.begin('size', id);
      return;
    }
    const hit = this.objects.hitTest(world.x, world.y);
    if (!hit) {
      this.objects.deselect();
      this.sizeOpen = false;
      return;
    }
    if (!found || found.obj.id !== hit.obj.id) this.sizeOpen = false;
    this.objects.select(hit.layer, hit.obj);
    if (hit.obj.locked) return;
    this.grabDx = world.x - hit.obj.x;
    this.grabDy = world.y - hit.obj.y;
    this.begin('move', id);
  }

  private begin(gesture: Gesture, id: number): void {
    this.gesture = gesture;
    this.activeId = id;
    this.moved = false;
    this.objects.beginGesture();
  }

  private dragTo(sx: number, sy: number): void {
    const found = this.objects.selected();
    if (!found) return;
    const world = this.worldAt(sx, sy);
    if (this.gesture === 'size') {
      this.objects.scaleTo(
        found.obj,
        scaleFromCorner(
          this.scaleStart,
          this.scaleStartSize.w,
          this.scaleStartSize.h,
          this.scaleAnchor.x,
          this.scaleAnchor.y,
          world.x,
          world.y,
        ),
      );
    } else if (this.gesture === 'move') {
      this.objects.moveSelected(found.obj, world.x - this.grabDx, world.y - this.grabDy);
    }
    // A blocking object takes its blocked squares along as it moves and resizes.
    if (found.obj.blocks) this.refreshSolid();
  }

  private finishGesture(): void {
    if (this.gesture === 'move' || this.gesture === 'size') {
      if (this.moved) this.objects.endGesture(this.gesture === 'size' ? 'Resize' : 'Move');
      else this.objects.cancelGesture();
    }
    this.gesture = 'idle';
    this.activeId = null;
    this.moved = false;
  }

  /** A second finger turns the gesture into a zoom and puts back anything the first finger dragged. */
  private startPinch(): void {
    if (this.gesture === 'move' || this.gesture === 'size') {
      this.objects.revertGesture();
      this.refreshSolid();
    }
    const [a, b] = [...this.pointers.values()];
    this.pinchDistance = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    this.pinchZoom = this.zoom;
    this.gesture = 'pinch';
    this.activeId = null;
    this.moved = false;
  }

  private updatePinch(): void {
    const [a, b] = [...this.pointers.values()];
    if (!a || !b) return;
    const distance = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    this.zoom = clamp(this.pinchZoom * (distance / this.pinchDistance), this.minZoom(), MAX_ZOOM);
  }

  /** Two fingers tapped together undo, three redo, as in the map editor. */
  private multiFingerTap(lifted: boolean): void {
    const quick = performance.now() - this.touchStart < TAP_MS;
    if (!lifted || !quick || this.touchWandered || this.touchMost < 2) return;
    // The fingers barely moved, but enough to nudge the zoom; put it back.
    this.zoom = this.pinchZoom;
    if (this.touchMost === 2) this.stepHistory(false);
    else this.stepHistory(true);
  }

  private stepSize(squares: number): void {
    const found = this.objects.selected();
    if (!found || found.obj.locked) return;
    this.objects.beginGesture();
    this.objects.stepSize(found.obj, squares);
    this.objects.endGesture('Resize');
    this.refreshSolid();
  }

  /**
   * Makes the object stop the character, or lets it through again. Block
   * belongs to the object, so the blocked squares move and resize with it.
   * Unblocking also clears squares an older version painted under it.
   */
  private toggleBlock(): void {
    const found = this.objects.selected();
    if (!found) return;
    const blocked = this.isBlocked(found.obj);
    this.objects.beginGesture();
    if (blocked) {
      delete found.obj.blocks;
      const cells = objectCells(this.doc, found.obj);
      for (const layer of this.doc.layers) {
        if (layer.kind !== 'tiles' || !layer.collider) continue;
        for (const index of cells) layer.data[index] = EMPTY;
      }
    } else {
      found.obj.blocks = true;
    }
    this.objects.endGesture(blocked ? 'Unblock' : 'Block');
    this.refreshSolid();
  }

  private isBlocked(obj: MapObject): boolean {
    if (obj.blocks) return true;
    const cells = objectCells(this.doc, obj);
    return cells.length > 0 && cells.every((index) => this.solid[index] === 1);
  }

  private toggleLock(): void {
    if (!this.objects.selected()) return;
    this.objects.toggleLock();
    this.sizeOpen = false;
  }

  /** Door on an object without one asks where it leads; on one that has one, takes it off. */
  private toggleDoor(): void {
    const found = this.objects.selected();
    if (!found) return;
    if (this.linkingDoor) {
      this.stopLinking();
      return;
    }
    if (found.obj.door) {
      this.objects.beginGesture();
      delete found.obj.door;
      this.objects.endGesture('Remove door');
      return;
    }
    this.linkingDoor = found.obj.id;
    this.hint.textContent = 'Tap where this door leads, such as inside a room. Tap Door again to cancel.';
    this.hint.classList.add('linking');
  }

  /** Sends the door being linked to the middle of the tapped square. */
  private linkDoorTo(wx: number, wy: number): void {
    const id = this.linkingDoor;
    this.stopLinking();
    const size = this.doc.tileSize;
    const tx = clamp(Math.floor(wx / size), 0, this.doc.width - 1);
    const ty = clamp(Math.floor(wy / size), 0, this.doc.height - 1);
    for (const layer of this.doc.layers) {
      if (layer.kind !== 'objects') continue;
      const obj = layer.objects.find((o) => o.id === id);
      if (!obj) continue;
      this.objects.beginGesture();
      obj.door = { x: (tx + 0.5) * size, y: (ty + 0.5) * size };
      this.objects.endGesture('Door');
      this.store.toast('Door set. Walk into its doorway to go through.');
      return;
    }
  }

  private stopLinking(): void {
    this.linkingDoor = null;
    this.hint.textContent = PLAY_HINT;
    this.hint.classList.remove('linking');
  }

  /** Steps through a door: the character comes out at the far side and the screen fades back in. */
  private checkDoor(): void {
    const door = doorAt(this.doc, this.x, this.y);
    if (!door?.door) {
      this.doorArmed = true;
      return;
    }
    if (!this.doorArmed) return;
    this.x = door.door.x;
    this.y = door.door.y;
    this.doorArmed = false;
    this.fade = 1;
  }

  private refreshSolid(): void {
    const next = buildCollision(this.doc);
    this.solid.set(next.subarray(0, this.solid.length));
  }

  private onHandle(sx: number, sy: number): boolean {
    const found = this.objects.selected();
    if (!found) return false;
    const { w, h } = objectSize(found.obj);
    const cam = this.camera();
    const hx = (found.obj.x + w / 2 - cam.x) * this.zoom;
    const hy = (found.obj.y + h / 2 - cam.y) * this.zoom;
    return Math.hypot(sx - hx, sy - hy) <= 28;
  }

  private local(e: PointerEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
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
    this.fade = Math.max(0, this.fade - dt / DOOR_FADE_S);
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
    this.checkDoor();

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

  /** The pose to draw. An undrawn step falls back to a frame that has pixels. */
  private visibleFrame(): Frame | undefined {
    const count = this.character.frameCount;
    const step = this.moving ? Math.floor(this.walkTime / (this.character.frameMs / 1000)) % count : 0;
    const wanted = frameIndex(this.dir, step, count);
    const inked = (frame: Frame | undefined): frame is Frame =>
      !!frame && frame.data.some((value, index) => (index & 3) === 3 && value > 0);
    const frames = this.character.frames;
    if (inked(frames[wanted])) return frames[wanted];
    for (let f = 0; f < count; f++) {
      const frame = frames[frameIndex(this.dir, f, count)];
      if (inked(frame)) return frame;
    }
    return frames.find(inked) ?? frames[wanted];
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

    // Blocked squares show while an object is being worked on, so walking
    // around the world is not covered in red.
    if (this.objects.selected()) {
      ctx.fillStyle = 'rgba(255, 90, 90, 0.38)';
      const size = this.doc.tileSize;
      for (let i = 0; i < this.solid.length; i++) {
        if (!this.solid[i]) continue;
        const tx = i % this.doc.width;
        const ty = (i / this.doc.width) | 0;
        ctx.fillRect((tx * size - camX) * zoom, (ty * size - camY) * zoom, size * zoom, size * zoom);
      }
    }

    // Walk frames alternate stand, step, stand, other step. A pose the user
    // never drew falls back to one that has pixels, so Play is not a blank.
    const cell = this.visibleFrame();
    if (cell) {
      const sctx = this.spriteCanvas.getContext('2d');
      if (sctx) {
        const image = sctx.createImageData(this.character.w, this.character.h);
        image.data.set(framePixels(cell.data, this.character.w, this.character.h));
        sctx.putImageData(image, 0, 0);

        // Feet sit on the character's position; the art rises above it.
        const drawX = (this.x - this.character.w / 2 - camX) * zoom;
        const drawY = (this.y + (FOOT_H * this.doc.tileSize) / 2 - this.character.h - camY) * zoom;
        ctx.drawImage(this.spriteCanvas, drawX, drawY, this.character.w * zoom, this.character.h * zoom);
      }
    }

    // After the character, so a sprite standing on the object cannot hide it.
    const found = this.objects.selected();
    if (found) {
      const { w, h } = objectSize(found.obj);
      const x = (found.obj.x - w / 2 - camX) * zoom;
      const y = (found.obj.y - h / 2 - camY) * zoom;
      ctx.strokeStyle = '#ffd666';
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, w * zoom, h * zoom);
      // Where this door leads: its doorway joined to the square it opens onto.
      const door = found.obj.door;
      if (door) {
        const size = this.doc.tileSize;
        const zone = doorZone(found.obj, size);
        const fromX = ((zone.x0 + zone.x1) / 2 - camX) * zoom;
        const fromY = (zone.y0 + size / 2 - camY) * zoom;
        const toX = (door.x - camX) * zoom;
        const toY = (door.y - camY) * zoom;
        ctx.save();
        ctx.setLineDash([6, 5]);
        ctx.beginPath();
        ctx.moveTo(fromX, fromY);
        ctx.lineTo(toX, toY);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.strokeRect(toX - (size * zoom) / 2, toY - (size * zoom) / 2, size * zoom, size * zoom);
        ctx.restore();
      }
      if (this.sizeOpen) {
        ctx.fillStyle = '#ffd666';
        ctx.beginPath();
        ctx.arc(x + w * zoom, y + h * zoom, 9, 0, Math.PI * 2);
        ctx.fill();
      }
      this.placeMenu(found.obj, x, y, w * zoom);
    } else {
      this.menu.classList.remove('visible');
      this.sizeOpen = false;
      if (this.linkingDoor) this.stopLinking();
    }

    if (this.fade > 0) {
      ctx.fillStyle = `rgba(0, 0, 0, ${this.fade})`;
      ctx.fillRect(0, 0, this.viewW, this.viewH);
    }
    this.refreshHistory();
  }

  /** Keeps the object's menu just above it, and on screen. */
  private placeMenu(obj: MapObject, x: number, y: number, w: number): void {
    const menu = this.menu;
    menu.classList.add('visible');
    const locked = !!obj.locked;
    this.sizeButton.classList.toggle('active', this.sizeOpen);
    this.sizeButton.disabled = locked;
    this.smallerButton.hidden = !this.sizeOpen;
    this.biggerButton.hidden = !this.sizeOpen;
    this.blockButton.classList.toggle('active', this.isBlocked(obj));
    this.lockButton.classList.toggle('active', locked);
    this.lockButton.textContent = locked ? 'Unlock' : 'Lock';
    this.doorButton.classList.toggle('active', !!obj.door || this.linkingDoor === obj.id);
    this.doorButton.textContent = this.linkingDoor === obj.id ? 'Cancel door' : obj.door ? 'Door ✓' : 'Door';
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    const left = clamp(x + w / 2 - mw / 2, 8, this.viewW - mw - 8);
    const above = y - mh - 10;
    const top = above >= 8 ? above : Math.min(this.viewH - mh - 8, y + 10);
    menu.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  /** Undo and redo cover moves, resizes and blocking done in this session. */
  private stepHistory(redo: boolean): void {
    if (this.gesture === 'move' || this.gesture === 'size') this.finishGesture();
    if (redo) this.store.history.redo();
    else this.store.history.undo();
    this.refreshSolid();
    this.refreshHistory();
  }

  private refreshHistory(): void {
    this.undoButton.disabled = !this.store.history.canUndo;
    this.redoButton.disabled = !this.store.history.canRedo;
  }

  // --- Teardown ------------------------------------------------------------

  close(): void {
    cancelAnimationFrame(this.frameHandle);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('resize', this.onResize);
    this.root.remove();
    const size = this.doc.tileSize;
    this.onExit({
      x: clamp(Math.floor(this.x / size), 0, this.doc.width - 1),
      y: clamp(Math.floor(this.y / size), 0, this.doc.height - 1),
    });
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

/**
 * The next zoom for a − or + press: whole steps from 1x up, where every
 * pixel stays the same size, and steps of a third below 1x.
 */
export function nextZoom(zoom: number, delta: number): number {
  if (delta > 0) return zoom < 1 - 1e-6 ? Math.min(1, zoom * 1.5) : Math.floor(zoom + 1e-6) + 1;
  return zoom > 1 + 1e-6 ? Math.ceil(zoom - 1e-6) - 1 : zoom / 1.5;
}

/**
 * iPad often delivers a tap as pointerup and then drops the click, so the
 * press itself runs the action and the click is only a fallback.
 */
function button(className: string, label: string, onPress: () => void): HTMLButtonElement {
  const node = element('button', className) as HTMLButtonElement;
  node.type = 'button';
  node.textContent = label;
  let pressed = false;
  node.addEventListener('pointerdown', (e) => e.stopPropagation());
  node.addEventListener('pointerup', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    pressed = true;
    onPress();
  });
  node.addEventListener('click', (e) => {
    e.preventDefault();
    if (pressed) {
      pressed = false;
      return;
    }
    onPress();
  });
  return node;
}

/**
 * The doorway of an object that leads somewhere: the middle of its bottom
 * edge, reaching a little below it so a house that blocks the character can
 * still be walked into from the front.
 */
export function doorZone(obj: MapObject, tile: number): { x0: number; y0: number; x1: number; y1: number } {
  const { w, h } = objectSize(obj);
  const half = Math.max(tile / 2, w / 6);
  const bottom = obj.y + h / 2;
  return { x0: obj.x - half, x1: obj.x + half, y0: bottom - tile, y1: bottom + tile * 0.6 };
}

/** The door object whose doorway the character's feet are in, if any. */
export function doorAt(doc: Doc, x: number, y: number): MapObject | null {
  for (let li = doc.layers.length - 1; li >= 0; li--) {
    const layer = doc.layers[li];
    if (layer.kind !== 'objects' || !layer.visible) continue;
    for (const obj of layer.objects) {
      if (!obj.door) continue;
      const zone = doorZone(obj, doc.tileSize);
      if (x >= zone.x0 && x <= zone.x1 && y >= zone.y0 && y <= zone.y1) return obj;
    }
  }
  return null;
}

/** Map squares an object's box covers, as indices into a layer. */
export function objectCells(doc: Doc, obj: MapObject): number[] {
  const { w, h } = objectSize(obj);
  const size = doc.tileSize;
  const x0 = Math.max(0, Math.floor((obj.x - w / 2) / size + 1e-6));
  const y0 = Math.max(0, Math.floor((obj.y - h / 2) / size + 1e-6));
  const x1 = Math.min(doc.width, Math.ceil((obj.x + w / 2) / size - 1e-6));
  const y1 = Math.min(doc.height, Math.ceil((obj.y + h / 2) / size - 1e-6));
  const cells: number[] = [];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) cells.push(y * doc.width + x);
  return cells;
}

/** Whether the sheet pixel at (x, y) is part of the artwork rather than its transparent background. */
export type AlphaAt = (x: number, y: number) => boolean;

/** A square only blocks when the artwork fills at least this much of it. */
export const BLOCK_COVERAGE = 1 / 3;

/**
 * Map squares an object's visible pixels fill, as indices into a layer: the
 * walls of a house rather than the empty corners of its picture. Each pixel
 * of the art is placed exactly as `drawObject` draws it, rotated and flipped,
 * and a square blocks when the pixels in it add up to a third of its area.
 */
export function opaqueCells(doc: Doc, obj: MapObject, alphaAt: AlphaAt): number[] {
  const size = doc.tileSize;
  const s = obj.scale;
  const { rect } = obj;
  const w = rect.w * s;
  const h = rect.h * s;
  const turn = ((obj.rotation % 4) + 4) % 4;
  const fx = obj.flipX ? -1 : 1;
  const fy = obj.flipY ? -1 : 1;
  const covered = new Map<number, number>();
  const eps = 1e-6;

  for (let v = 0; v < rect.h; v++) {
    for (let u = 0; u < rect.w; u++) {
      if (!alphaAt(rect.x + u, rect.y + v)) continue;
      // The pixel's centre in the object's own frame, mirrored, then turned
      // clockwise by quarter turns as the canvas does.
      const lx = fx * (-w / 2 + (u + 0.5) * s);
      const ly = fy * (-h / 2 + (v + 0.5) * s);
      let px = lx;
      let py = ly;
      if (turn === 1) [px, py] = [-ly, lx];
      else if (turn === 2) [px, py] = [-lx, -ly];
      else if (turn === 3) [px, py] = [ly, -lx];
      const x0 = obj.x + px - s / 2;
      const y0 = obj.y + py - s / 2;
      const x1 = x0 + s;
      const y1 = y0 + s;
      const cx0 = Math.max(0, Math.floor(x0 / size + eps));
      const cy0 = Math.max(0, Math.floor(y0 / size + eps));
      const cx1 = Math.min(doc.width - 1, Math.floor(x1 / size - eps));
      const cy1 = Math.min(doc.height - 1, Math.floor(y1 / size - eps));
      for (let cy = cy0; cy <= cy1; cy++) {
        const oy = Math.min(y1, (cy + 1) * size) - Math.max(y0, cy * size);
        if (oy <= 0) continue;
        for (let cx = cx0; cx <= cx1; cx++) {
          const ox = Math.min(x1, (cx + 1) * size) - Math.max(x0, cx * size);
          if (ox <= 0) continue;
          const index = cy * doc.width + cx;
          covered.set(index, (covered.get(index) ?? 0) + ox * oy);
        }
      }
    }
  }

  const needed = size * size * BLOCK_COVERAGE - eps;
  return [...covered].filter(([, area]) => area >= needed).map(([index]) => index).sort((a, b) => a - b);
}

/** Alpha read from each sheet once, until its picture changes size or is replaced. */
const alphaCache = new WeakMap<object, { w: number; h: number; alpha: Uint8Array }>();

/** Which pixels of a sheet are drawn, or null when its picture is not ready or cannot be read. */
export function sheetAlpha(doc: Doc, tilesetId: string): AlphaAt | null {
  const sheet = doc.tilesets.find((t) => t.id === tilesetId);
  const image = sheet?.image;
  if (!image || typeof document === 'undefined') return null;
  const w = image instanceof HTMLImageElement ? image.naturalWidth : image.width;
  const h = image instanceof HTMLImageElement ? image.naturalHeight : image.height;
  if (!w || !h) return null;
  let cached = alphaCache.get(image);
  if (!cached || cached.w !== w || cached.h !== h) {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return null;
      ctx.drawImage(image, 0, 0);
      const pixels = ctx.getImageData(0, 0, w, h).data;
      const alpha = new Uint8Array(w * h);
      for (let i = 0; i < alpha.length; i++) alpha[i] = pixels[i * 4 + 3];
      cached = { w, h, alpha };
      alphaCache.set(image, cached);
    } catch {
      return null;
    }
  }
  const { alpha } = cached;
  return (x, y) => x >= 0 && y >= 0 && x < w && y < h && alpha[y * w + x] >= 128;
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
    // Solid squares are shown by the red overlay, which follows Block live.
    if (layer.collider) continue;
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

/** The layer whose squares block the character, created the first time one is needed. */
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

/**
 * Any tile on a collision layer is solid, and so is every square an object
 * set to Block fills with its visible pixels, measured from where it is now.
 * Art that cannot be read yet blocks its whole box rather than nothing.
 */
export function buildCollision(
  doc: Doc,
  alphaFor: (doc: Doc, tilesetId: string) => AlphaAt | null = sheetAlpha,
): Uint8Array {
  const solid = new Uint8Array(doc.width * doc.height);
  for (const layer of doc.layers) {
    if (layer.kind === 'objects') {
      if (!layer.visible) continue;
      for (const obj of layer.objects) {
        if (!obj.blocks) continue;
        const alpha = alphaFor(doc, obj.tilesetId);
        const cells = alpha ? opaqueCells(doc, obj, alpha) : objectCells(doc, obj);
        for (const index of cells) solid[index] = 1;
      }
      continue;
    }
    if (layer.kind !== 'tiles' || !layer.collider) continue;
    for (let i = 0; i < solid.length; i++) {
      if (layer.data[i] !== EMPTY) solid[i] = 1;
    }
  }
  return solid;
}
