import type { Tileset } from '../core/doc';
import { EMPTY_STAMP, singleStamp, stampFromRegion } from '../core/stamp';
import type { Store } from '../core/store';
import { button, clear, el } from './dom';
import { icon } from './icons';

const MIN_CELL = 22;
const MAX_CELL = 72;

/** Below this speed at release, inertia is not worth starting. */
const FLING_MIN = 0.08;
const FLING_DECAY = 0.94;

/**
 * The tile picker.
 *
 * Scrolling and selecting used to fight each other: a finger drag did both at
 * once, which made multi-tile selection impossible on touch. They are now
 * separated by *where* the drag starts. Dragging from a tile draws a selection
 * marquee; dragging from a blank square scrolls the sheet, because a blank
 * square has nothing to select anyway. Two fingers always scroll, which is the
 * fallback for a densely packed sheet with no blank squares to grab.
 */
export class PalettePanel {
  readonly element: HTMLElement;

  private readonly scroller: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly header: HTMLElement;
  private readonly empty: HTMLElement;

  private cell = 32;

  /** Which tiles are fully transparent, so they can act as scroll handles. */
  private blankTiles = new Uint8Array(0);
  private blankKey = '';

  private mode: 'idle' | 'select' | 'scroll' = 'idle';
  private activeId: number | null = null;
  private dragStart: { x: number; y: number } | null = null;
  private lastPoint = { x: 0, y: 0 };
  private velocity = { x: 0, y: 0 };
  private flingHandle = 0;
  private readonly pointers = new Map<number, { type: string; x: number; y: number }>();

  constructor(
    private readonly store: Store,
    private readonly actions: {
      addTileset: () => void;
      editTileset: (index: number) => void;
      removeTileset: (index: number) => void;
      recolorTileset: (index: number) => void;
    },
  ) {
    this.canvas = el('canvas', { class: 'palette-canvas' });
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas is unavailable');
    this.ctx = ctx;

    this.scroller = el('div', { class: 'palette-scroll' }, [this.canvas]);
    this.header = el('div', { class: 'palette-header' });
    this.empty = el('div', { class: 'panel-empty' }, [
      icon('image', 34),
      el('p', { text: 'No tileset yet' }),
      el('p', {
        class: 'muted',
        text: 'Import a spritesheet to start painting. PNG with evenly spaced tiles works best.',
      }),
      button('btn primary', 'Import tileset', () => this.actions.addTileset(), [
        icon('upload', 18),
        el('span', { text: 'Import tileset' }),
      ]),
    ]);

    this.element = el('div', { class: 'palette' }, [this.header, this.scroller, this.empty]);

    this.bindPointer();
    window.addEventListener('resize', () => this.layout());
  }

  private activeTileset(): Tileset | null {
    return this.store.doc.tilesets[this.store.activeTileset] ?? null;
  }

  // --- Blank-tile analysis -------------------------------------------------

  /**
   * Finds the fully transparent tiles. These become the scroll handles, and
   * are also skipped when selecting so a marquee never picks up nothing.
   */
  private analyzeBlanks(tileset: Tileset): void {
    const key = `${tileset.id}:${tileset.tileW}x${tileset.tileH}:${tileset.margin}:${tileset.spacing}:${tileset.count}`;
    if (this.blankKey === key) return;
    this.blankKey = key;
    this.blankTiles = new Uint8Array(tileset.count);
    if (!tileset.image) return;

    const probe = document.createElement('canvas');
    probe.width = tileset.tileW;
    probe.height = tileset.tileH;
    const ctx = probe.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    for (let i = 0; i < tileset.count; i++) {
      const col = i % tileset.cols;
      const row = Math.floor(i / tileset.cols);
      ctx.clearRect(0, 0, tileset.tileW, tileset.tileH);
      ctx.drawImage(
        tileset.image,
        tileset.margin + col * (tileset.tileW + tileset.spacing),
        tileset.margin + row * (tileset.tileH + tileset.spacing),
        tileset.tileW,
        tileset.tileH,
        0,
        0,
        tileset.tileW,
        tileset.tileH,
      );
      const { data } = ctx.getImageData(0, 0, tileset.tileW, tileset.tileH);
      let blank = 1;
      for (let p = 3; p < data.length; p += 4) {
        if (data[p] > 8) {
          blank = 0;
          break;
        }
      }
      this.blankTiles[i] = blank;
    }
  }

  private isBlankAt(tileset: Tileset, x: number, y: number): boolean {
    const index = y * tileset.cols + x;
    if (index >= tileset.count) return true;
    return this.blankTiles[index] === 1;
  }

  // --- Selection -----------------------------------------------------------

  private tileAt(clientX: number, clientY: number): { x: number; y: number } | null {
    const tileset = this.activeTileset();
    if (!tileset) return null;
    const rect = this.canvas.getBoundingClientRect();
    const x = Math.floor((clientX - rect.left) / this.cell);
    const y = Math.floor((clientY - rect.top) / this.cell);
    if (x < 0 || y < 0 || x >= tileset.cols || y >= tileset.rows) return null;
    return { x, y };
  }

  private applySelection(a: { x: number; y: number }, b: { x: number; y: number }): void {
    const tileset = this.activeTileset();
    if (!tileset) return;
    const x0 = Math.min(a.x, b.x);
    const y0 = Math.min(a.y, b.y);
    const w = Math.abs(a.x - b.x) + 1;
    const h = Math.abs(a.y - b.y) + 1;
    this.store.setStamp(
      stampFromRegion(this.store.activeTileset, tileset.cols, x0, y0, w, h, tileset.count),
      { x: x0, y: y0, w, h },
    );
    this.draw();
  }

  // --- Pointer handling ----------------------------------------------------

  private touchCount(): number {
    let n = 0;
    for (const p of this.pointers.values()) if (p.type === 'touch') n += 1;
    return n;
  }

  private stopFling(): void {
    if (this.flingHandle) cancelAnimationFrame(this.flingHandle);
    this.flingHandle = 0;
  }

  /** Carries a flick onwards so the sheet feels like a normal scroll view. */
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

  private bindPointer(): void {
    const canvas = this.canvas;

    canvas.addEventListener(
      'pointerdown',
      (e) => {
        this.stopFling();
        this.pointers.set(e.pointerId, { type: e.pointerType, x: e.clientX, y: e.clientY });

        const tileset = this.activeTileset();
        const cell = this.tileAt(e.clientX, e.clientY);
        if (!tileset || !cell) return;

        e.preventDefault();
        canvas.setPointerCapture?.(e.pointerId);
        this.activeId = e.pointerId;
        this.lastPoint = { x: e.clientX, y: e.clientY };
        this.velocity = { x: 0, y: 0 };

        // Two fingers always scroll, whatever is under them.
        if (this.touchCount() >= 2) {
          this.mode = 'scroll';
          return;
        }

        // A blank square has nothing to pick, so it scrolls instead.
        if (e.pointerType === 'touch' && this.isBlankAt(tileset, cell.x, cell.y)) {
          this.mode = 'scroll';
          return;
        }

        this.mode = 'select';
        this.dragStart = cell;
        this.applySelection(cell, cell);
      },
      { passive: false },
    );

    canvas.addEventListener(
      'pointermove',
      (e) => {
        const tracked = this.pointers.get(e.pointerId);
        if (tracked) {
          tracked.x = e.clientX;
          tracked.y = e.clientY;
        }
        if (e.pointerId !== this.activeId || this.mode === 'idle') return;
        e.preventDefault();

        if (this.mode === 'scroll') {
          const dx = e.clientX - this.lastPoint.x;
          const dy = e.clientY - this.lastPoint.y;
          this.scroller.scrollLeft -= dx;
          this.scroller.scrollTop -= dy;
          // Blend the velocity so one jittery sample cannot throw the fling.
          this.velocity.x = this.velocity.x * 0.6 + dx * 0.4;
          this.velocity.y = this.velocity.y * 0.6 + dy * 0.4;
          this.lastPoint = { x: e.clientX, y: e.clientY };
          return;
        }

        if (!this.dragStart) return;
        const cell = this.tileAt(e.clientX, e.clientY);
        if (cell) this.applySelection(this.dragStart, cell);
      },
      { passive: false },
    );

    const end = (e: PointerEvent) => {
      this.pointers.delete(e.pointerId);
      if (canvas.hasPointerCapture?.(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
      if (e.pointerId !== this.activeId) return;
      if (this.mode === 'scroll') this.startFling();
      this.mode = 'idle';
      this.activeId = null;
      this.dragStart = null;
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
  }

  // --- Header --------------------------------------------------------------

  showPage(index: number): void {
    const count = this.store.doc.tilesets.length;
    if (count === 0) return;
    const next = ((index % count) + count) % count;
    this.store.activeTileset = next;

    const tileset = this.store.doc.tilesets[next];
    if (tileset && tileset.count > 0) {
      this.store.setStamp(singleStamp(next, 0), { x: 0, y: 0, w: 1, h: 1 });
    } else {
      this.store.setStamp(EMPTY_STAMP);
    }
    this.layout();
    this.scroller.scrollTop = 0;
  }

  private buildHeader(): void {
    clear(this.header);
    const doc = this.store.doc;
    if (doc.tilesets.length === 0) return;

    const current = this.store.activeTileset;
    const total = doc.tilesets.length;
    const single = total === 1;

    const select = el('select', { class: 'select' });
    doc.tilesets.forEach((tileset, index) => {
      const option = el('option', { value: String(index), text: tileset.name });
      if (index === current) option.selected = true;
      select.append(option);
    });
    select.addEventListener('change', () => this.showPage(Number(select.value)));

    const prev = button('icon-btn', 'Previous tileset', () => this.showPage(current - 1), [icon('chevronLeft', 20)]);
    const next = button('icon-btn', 'Next tileset', () => this.showPage(current + 1), [icon('chevronRight', 20)]);
    prev.disabled = single;
    next.disabled = single;

    const tileset = doc.tilesets[current];

    this.header.append(
      el('div', { class: 'palette-pager' }, [prev, select, next]),
      el('div', { class: 'palette-meta' }, [
        el('span', { text: single ? `${tileset?.count ?? 0} tiles` : `Sheet ${current + 1} of ${total}` }),
        el('span', { class: 'muted', text: single ? '' : `${tileset?.count ?? 0} tiles` }),
      ]),
      el('div', { class: 'palette-row' }, [
        button('icon-btn', 'Tileset settings', () => this.actions.editTileset(current), [icon('settings', 18)]),
        button('icon-btn', 'Import another tileset', () => this.actions.addTileset(), [icon('plus', 18)]),
        button('icon-btn', 'Recolour into a new sheet', () => this.actions.recolorTileset(current), [
          icon('palette', 18),
        ]),
        button('icon-btn danger', 'Remove tileset', () => this.actions.removeTileset(current), [icon('trash', 18)]),
        el('div', { class: 'spacer' }),
        this.toggle('dice', 'Scatter: place a random tile from the selection', this.store.settings.randomize, () => {
          this.store.settings.randomize = !this.store.settings.randomize;
          this.buildHeader();
        }),
      ]),
      el('p', {
        class: 'hint',
        text: 'Drag across tiles to select a block. Drag from an empty square, or with two fingers, to scroll.',
      }),
    );
  }

  private toggle(
    name: Parameters<typeof icon>[0],
    label: string,
    active: boolean,
    onPress: () => void,
  ): HTMLButtonElement {
    const node = button(`icon-btn${active ? ' active' : ''}`, label, onPress, [icon(name, 18)]);
    node.setAttribute('aria-pressed', String(active));
    return node;
  }

  // --- Rendering -----------------------------------------------------------

  layout(): void {
    const tileset = this.activeTileset();
    const hasTiles = !!tileset && tileset.count > 0;
    this.empty.style.display = this.store.doc.tilesets.length === 0 ? 'flex' : 'none';
    this.scroller.style.display = hasTiles ? 'block' : 'none';

    this.buildHeader();
    if (!tileset || !hasTiles) return;

    this.analyzeBlanks(tileset);

    const available = Math.max(120, this.scroller.clientWidth - 2);
    const ideal = Math.floor(available / tileset.cols);
    this.cell = Math.max(MIN_CELL, Math.min(MAX_CELL, ideal));

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const width = tileset.cols * this.cell;
    const height = tileset.rows * this.cell;
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    this.draw();
  }

  draw(): void {
    const tileset = this.activeTileset();
    if (!tileset || !tileset.image) return;
    const { ctx, cell } = this;
    const width = tileset.cols * cell;
    const height = tileset.rows * cell;

    ctx.clearRect(0, 0, width, height);
    ctx.imageSmoothingEnabled = cell < tileset.tileW;

    for (let row = 0; row < tileset.rows; row++) {
      for (let col = 0; col < tileset.cols; col++) {
        const index = row * tileset.cols + col;
        if (index >= tileset.count) continue;

        // Mark the squares that scroll instead of selecting, so the two
        // behaviours are visible rather than something you discover.
        if (this.blankTiles[index] === 1) {
          ctx.fillStyle = 'rgba(255,255,255,0.025)';
          ctx.fillRect(col * cell + 2, row * cell + 2, cell - 4, cell - 4);
          continue;
        }

        ctx.drawImage(
          tileset.image,
          tileset.margin + col * (tileset.tileW + tileset.spacing),
          tileset.margin + row * (tileset.tileH + tileset.spacing),
          tileset.tileW,
          tileset.tileH,
          col * cell,
          row * cell,
          cell,
          cell,
        );
      }
    }

    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let col = 1; col < tileset.cols; col++) {
      ctx.moveTo(col * cell + 0.5, 0);
      ctx.lineTo(col * cell + 0.5, height);
    }
    for (let row = 1; row < tileset.rows; row++) {
      ctx.moveTo(0, row * cell + 0.5);
      ctx.lineTo(width, row * cell + 0.5);
    }
    ctx.stroke();

    const selection = this.store.paletteSelection;
    if (selection) {
      ctx.fillStyle = 'rgba(126,160,255,0.16)';
      ctx.fillRect(selection.x * cell, selection.y * cell, selection.w * cell, selection.h * cell);
      ctx.strokeStyle = '#7ea0ff';
      ctx.lineWidth = 2;
      ctx.strokeRect(selection.x * cell + 1, selection.y * cell + 1, selection.w * cell - 2, selection.h * cell - 2);
    }
  }
}
