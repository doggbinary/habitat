import { assetsOf } from '../core/assets';
import type { AssetRect, Tileset } from '../core/doc';
import type { Store } from '../core/store';
import { button, clear, el } from './dom';
import { icon } from './icons';

/** Target thumbnail size; the column count adapts to the panel width. */
const TARGET_CELL = 76;
/** A finger held this long without moving picks the asset up. */
const LONG_PRESS_MS = 220;
/** Movement that turns a press into a scroll (finger) or a drag (Pencil). */
const TOUCH_SLOP = 10;
const PEN_SLOP = 5;

const FLING_MIN = 0.08;
const FLING_DECAY = 0.94;

export interface PaletteActions {
  addTileset: () => void;
  editTileset: (index: number) => void;
  removeTileset: (index: number) => void;
  /** A tap on an asset: add an object, or pick a ground tile for the brush. */
  tapAsset: (tilesetIndex: number, assetIndex: number) => void;
  dragStart: (tilesetId: string, rect: AssetRect) => void;
  dragMove: (clientX: number, clientY: number) => void;
  /** `dropped` is false when the gesture was cancelled by the system. */
  dragEnd: (clientX: number, clientY: number, dropped: boolean) => void;
  /** Switches a sheet between painted ground tiles and placeable props. */
  setSplitMode: (tilesetIndex: number, mode: 'grid' | 'objects') => void;
}

/**
 * The asset library: every separate thing on the current sheet, laid out as
 * thumbnails.
 *
 * Scrolling and picking up used to fight because both were "drag a finger".
 * They now follow the convention iPad apps already teach: a finger swipe
 * scrolls, a finger press-and-hold lifts the asset, and the Pencil lifts
 * immediately because it has no reason to scroll. Two fingers always scroll.
 */
export class PalettePanel {
  readonly element: HTMLElement;

  private readonly scroller: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly header: HTMLElement;
  private readonly empty: HTMLElement;

  private cell = TARGET_CELL;
  private columns = 3;
  private assets: AssetRect[] = [];

  private mode: 'idle' | 'pending' | 'scroll' | 'drag' = 'idle';
  private activeId: number | null = null;
  private pressAsset = -1;
  private pressPoint = { x: 0, y: 0 };
  private lastPoint = { x: 0, y: 0 };
  private velocity = { x: 0, y: 0 };
  private longPressTimer = 0;
  private flingHandle = 0;
  private readonly pointers = new Map<number, string>();

  private ghost: HTMLCanvasElement | null = null;

  constructor(
    private readonly store: Store,
    private readonly actions: PaletteActions,
  ) {
    this.canvas = el('canvas', { class: 'palette-canvas' });
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas is unavailable');
    this.ctx = ctx;

    this.scroller = el('div', { class: 'palette-scroll' }, [this.canvas]);
    this.header = el('div', { class: 'palette-header' });
    this.empty = el('div', { class: 'panel-empty' }, [
      icon('image', 34),
      el('p', { text: 'No assets yet' }),
      el('p', {
        class: 'muted',
        text: 'Import a sprite sheet. Trees, props and buildings are split apart automatically.',
      }),
      button('btn primary', 'Import assets', () => this.actions.addTileset(), [
        icon('upload', 18),
        el('span', { text: 'Import assets' }),
      ]),
    ]);

    this.element = el('div', { class: 'palette' }, [this.header, this.scroller, this.empty]);
    this.bindPointer();
    window.addEventListener('resize', () => this.layout());
  }

  private activeTileset(): Tileset | null {
    return this.store.doc.tilesets[this.store.activeTileset] ?? null;
  }

  // --- Hit testing ---------------------------------------------------------

  private assetAt(clientX: number, clientY: number): number {
    const rect = this.canvas.getBoundingClientRect();
    const col = Math.floor((clientX - rect.left) / this.cell);
    const row = Math.floor((clientY - rect.top) / this.cell);
    if (col < 0 || col >= this.columns || row < 0) return -1;
    const index = row * this.columns + col;
    return index < this.assets.length ? index : -1;
  }

  // --- Gestures ------------------------------------------------------------

  private stopFling(): void {
    if (this.flingHandle) cancelAnimationFrame(this.flingHandle);
    this.flingHandle = 0;
  }

  private startFling(): void {
    this.stopFling();
    const step = () => {
      this.velocity.x *= FLING_DECAY;
      this.velocity.y *= FLING_DECAY;
      if (Math.abs(this.velocity.x) < FLING_MIN && Math.abs(this.velocity.y) < FLING_MIN) {
        this.flingHandle = 0;
        return;
      }
      this.scroller.scrollLeft -= this.velocity.x;
      this.scroller.scrollTop -= this.velocity.y;
      this.flingHandle = requestAnimationFrame(step);
    };
    this.flingHandle = requestAnimationFrame(step);
  }

  private clearLongPress(): void {
    if (this.longPressTimer) window.clearTimeout(this.longPressTimer);
    this.longPressTimer = 0;
  }

  private beginDrag(clientX: number, clientY: number): void {
    const tileset = this.activeTileset();
    const rect = this.assets[this.pressAsset];
    if (!tileset || !rect) return;
    this.clearLongPress();
    this.mode = 'drag';
    this.showGhost(tileset, rect);
    this.moveGhost(clientX, clientY);
    this.actions.dragStart(tileset.id, rect);
    this.actions.dragMove(clientX, clientY);
  }

  private bindPointer(): void {
    const canvas = this.canvas;

    canvas.addEventListener(
      'pointerdown',
      (e) => {
        e.preventDefault();
        this.stopFling();
        this.pointers.set(e.pointerId, e.pointerType);
        canvas.setPointerCapture?.(e.pointerId);

        // A second finger turns whatever was happening into a scroll.
        const touches = [...this.pointers.values()].filter((t) => t === 'touch').length;
        if (touches >= 2) {
          this.clearLongPress();
          this.mode = 'scroll';
          this.activeId = e.pointerId;
          this.lastPoint = { x: e.clientX, y: e.clientY };
          return;
        }
        if (this.activeId !== null) return;

        this.activeId = e.pointerId;
        this.pressPoint = { x: e.clientX, y: e.clientY };
        this.lastPoint = { x: e.clientX, y: e.clientY };
        this.velocity = { x: 0, y: 0 };
        this.pressAsset = this.assetAt(e.clientX, e.clientY);

        if (this.pressAsset === -1) {
          this.mode = 'scroll';
          return;
        }

        this.mode = 'pending';
        if (e.pointerType === 'touch') {
          const { clientX, clientY } = e;
          this.longPressTimer = window.setTimeout(() => {
            if (this.mode === 'pending') this.beginDrag(clientX, clientY);
          }, LONG_PRESS_MS);
        }
      },
      { passive: false },
    );

    canvas.addEventListener(
      'pointermove',
      (e) => {
        if (e.pointerId !== this.activeId) return;
        e.preventDefault();
        const moved = Math.hypot(e.clientX - this.pressPoint.x, e.clientY - this.pressPoint.y);

        if (this.mode === 'pending') {
          if (e.pointerType === 'touch') {
            // Moving before the hold completes means you meant to scroll.
            if (moved > TOUCH_SLOP) {
              this.clearLongPress();
              this.mode = 'scroll';
            }
          } else if (moved > PEN_SLOP) {
            this.beginDrag(e.clientX, e.clientY);
            return;
          }
        }

        if (this.mode === 'scroll') {
          const dx = e.clientX - this.lastPoint.x;
          const dy = e.clientY - this.lastPoint.y;
          this.scroller.scrollLeft -= dx;
          this.scroller.scrollTop -= dy;
          this.velocity.x = this.velocity.x * 0.6 + dx * 0.4;
          this.velocity.y = this.velocity.y * 0.6 + dy * 0.4;
          this.lastPoint = { x: e.clientX, y: e.clientY };
          return;
        }

        if (this.mode === 'drag') {
          this.moveGhost(e.clientX, e.clientY);
          this.actions.dragMove(e.clientX, e.clientY);
        }
      },
      { passive: false },
    );

    const end = (e: PointerEvent) => {
      this.pointers.delete(e.pointerId);
      if (canvas.hasPointerCapture?.(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
      if (e.pointerId !== this.activeId) return;
      this.clearLongPress();

      const cancelled = e.type === 'pointercancel';
      if (this.mode === 'pending' && !cancelled) {
        this.actions.tapAsset(this.store.activeTileset, this.pressAsset);
      } else if (this.mode === 'scroll') {
        this.startFling();
      } else if (this.mode === 'drag') {
        this.actions.dragEnd(e.clientX, e.clientY, !cancelled);
        this.hideGhost();
      }

      this.mode = 'idle';
      this.activeId = null;
      this.pressAsset = -1;
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
  }

  // --- Drag ghost ----------------------------------------------------------

  private showGhost(tileset: Tileset, rect: AssetRect): void {
    this.hideGhost();
    if (!tileset.image) return;
    // Large enough to recognise under a fingertip, never so large it hides
    // where you are dropping.
    const fit = Math.min(110 / rect.w, 110 / rect.h);
    const scale = fit >= 1 ? Math.max(1, Math.floor(fit)) : fit;
    const w = Math.max(1, Math.round(rect.w * scale));
    const h = Math.max(1, Math.round(rect.h * scale));

    const ghost = el('canvas', { class: 'drag-ghost' });
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    ghost.width = Math.round(w * dpr);
    ghost.height = Math.round(h * dpr);
    ghost.style.width = `${w}px`;
    ghost.style.height = `${h}px`;
    const ctx = ghost.getContext('2d');
    if (ctx) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(tileset.image, rect.x, rect.y, rect.w, rect.h, 0, 0, w, h);
    }
    document.body.append(ghost);
    this.ghost = ghost;
  }

  private moveGhost(clientX: number, clientY: number): void {
    if (!this.ghost) return;
    const w = this.ghost.offsetWidth;
    const h = this.ghost.offsetHeight;
    // Held above the finger so the spot you are aiming at stays visible.
    this.ghost.style.transform = `translate(${clientX - w / 2}px, ${clientY - h - 26}px)`;
  }

  private hideGhost(): void {
    this.ghost?.remove();
    this.ghost = null;
  }

  // --- Header --------------------------------------------------------------

  showPage(index: number): void {
    const count = this.store.doc.tilesets.length;
    if (count === 0) return;
    this.store.activeTileset = ((index % count) + count) % count;
    this.layout();
    this.scroller.scrollTop = 0;
  }

  private buildHeader(): void {
    clear(this.header);
    const doc = this.store.doc;
    if (doc.tilesets.length === 0) return;

    const current = this.store.activeTileset;
    const total = doc.tilesets.length;
    const tileset = doc.tilesets[current];
    const isObjects = tileset?.splitMode === 'objects';

    const select = el('select', { class: 'select' });
    doc.tilesets.forEach((t, i) => {
      const option = el('option', { value: String(i), text: t.name });
      if (i === current) option.selected = true;
      select.append(option);
    });
    select.addEventListener('change', () => this.showPage(Number(select.value)));

    const prev = button('icon-btn', 'Previous sheet', () => this.showPage(current - 1), [icon('chevronLeft', 20)]);
    const next = button('icon-btn', 'Next sheet', () => this.showPage(current + 1), [icon('chevronRight', 20)]);
    prev.disabled = total < 2;
    next.disabled = total < 2;

    this.header.append(
      el('div', { class: 'palette-pager' }, [prev, select, next]),
      el('div', { class: 'palette-meta' }, [
        el('span', { text: `${this.assets.length} ${isObjects ? 'assets' : 'tiles'}` }),
        el('span', { class: 'muted', text: total > 1 ? `Sheet ${current + 1} of ${total}` : '' }),
      ]),
      // Detection guesses from transparency, which a sheet can fool, so the
      // choice stays one tap away.
      el('div', { class: 'split-switch', role: 'tablist' }, [
        this.splitButton('Ground', 'Paint these as tiles on the grid', !isObjects, () =>
          this.actions.setSplitMode(current, 'grid'),
        ),
        this.splitButton('Props', 'Place each thing on the sheet as its own movable object', isObjects, () =>
          this.actions.setSplitMode(current, 'objects'),
        ),
      ]),
      el('div', { class: 'palette-row' }, [
        button('icon-btn', 'Sheet settings', () => this.actions.editTileset(current), [icon('settings', 18)]),
        button('icon-btn', 'Import another sheet', () => this.actions.addTileset(), [icon('plus', 18)]),
        button('icon-btn danger', 'Remove sheet', () => this.actions.removeTileset(current), [icon('trash', 18)]),
      ]),
      el('p', {
        class: 'hint',
        text: isObjects
          ? 'Tap an asset to add it, or press and hold, then drag it onto the map.'
          : 'Tap a tile to paint ground with the brush, or press and hold to drag one onto the map.',
      }),
    );
  }

  private splitButton(label: string, hint: string, active: boolean, onPress: () => void): HTMLButtonElement {
    const node = button(`split-btn${active ? ' active' : ''}`, hint, onPress, [el('span', { text: label })]);
    node.setAttribute('role', 'tab');
    node.setAttribute('aria-selected', String(active));
    return node;
  }

  // --- Rendering -----------------------------------------------------------

  layout(): void {
    const tileset = this.activeTileset();
    this.assets = tileset ? assetsOf(tileset) : [];
    const has = this.assets.length > 0;
    this.empty.style.display = this.store.doc.tilesets.length === 0 ? 'flex' : 'none';
    this.scroller.style.display = has ? 'block' : 'none';
    this.buildHeader();
    if (!tileset || !has) return;

    const available = Math.max(160, this.scroller.clientWidth - 4);
    this.columns = Math.max(3, Math.floor(available / TARGET_CELL));
    this.cell = Math.floor(available / this.columns);

    const rows = Math.ceil(this.assets.length / this.columns);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const width = this.columns * this.cell;
    const height = rows * this.cell;
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  draw(): void {
    const tileset = this.activeTileset();
    if (!tileset?.image) return;
    const { ctx, cell } = this;
    const rows = Math.ceil(this.assets.length / this.columns);
    ctx.clearRect(0, 0, this.columns * cell, rows * cell);
    ctx.imageSmoothingEnabled = false;

    const pick = this.store.libraryPick;
    const pad = 6;

    for (let i = 0; i < this.assets.length; i++) {
      const rect = this.assets[i];
      const col = i % this.columns;
      const row = Math.floor(i / this.columns);
      const x = col * cell;
      const y = row * cell;

      const picked = pick?.tilesetId === tileset.id && pick.index === i;
      ctx.fillStyle = picked ? 'rgba(126,160,255,0.18)' : 'rgba(255,255,255,0.035)';
      roundRect(ctx, x + 3, y + 3, cell - 6, cell - 6, 8);
      ctx.fill();
      if (picked) {
        ctx.strokeStyle = '#7ea0ff';
        ctx.lineWidth = 2;
        roundRect(ctx, x + 3, y + 3, cell - 6, cell - 6, 8);
        ctx.stroke();
      }

      // Whole-number magnification keeps pixel art crisp; only shrink below
      // 1x when an asset genuinely does not fit.
      const room = cell - pad * 2;
      const fit = Math.min(room / rect.w, room / rect.h);
      const scale = fit >= 1 ? Math.floor(fit) : fit;
      const w = rect.w * scale;
      const h = rect.h * scale;
      ctx.imageSmoothingEnabled = scale < 1;
      ctx.drawImage(
        tileset.image,
        rect.x,
        rect.y,
        rect.w,
        rect.h,
        Math.round(x + (cell - w) / 2),
        Math.round(y + (cell - h) / 2),
        Math.round(w),
        Math.round(h),
      );
    }
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
