import type { Tileset } from '../core/doc';
import { EMPTY_STAMP, flipStampH, flipStampV, rotateStampCW, singleStamp, stampFromRegion } from '../core/stamp';
import type { Store } from '../core/store';
import { button, clear, el } from './dom';
import { icon } from './icons';

const MIN_CELL = 22;
const MAX_CELL = 72;

/**
 * The tile picker. Tapping selects one tile; dragging selects a rectangular
 * block that becomes a multi-tile stamp.
 *
 * Touch gets special treatment: by default a finger drag scrolls the palette,
 * because a long tileset is unusable otherwise. The "select region" toggle
 * flips the canvas to `touch-action: none` so a finger can draw a marquee
 * instead. An Apple Pencil always draws a marquee and never scrolls.
 */
export class PalettePanel {
  readonly element: HTMLElement;

  private readonly scroller: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly header: HTMLElement;
  private readonly empty: HTMLElement;

  private cell = 32;
  private regionSelect = false;
  private dragging = false;
  private dragStart: { x: number; y: number } | null = null;

  constructor(
    private readonly store: Store,
    private readonly actions: {
      addTileset: () => void;
      editTileset: (index: number) => void;
      removeTileset: (index: number) => void;
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

  // --- Selection -----------------------------------------------------------

  private activeTileset(): Tileset | null {
    return this.store.doc.tilesets[this.store.activeTileset] ?? null;
  }

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
    const stamp = stampFromRegion(
      this.store.activeTileset,
      tileset.cols,
      x0,
      y0,
      w,
      h,
      tileset.count,
    );
    this.store.setStamp(stamp, { x: x0, y: y0, w, h });
    this.draw();
  }

  private bindPointer(): void {
    const canvas = this.canvas;

    canvas.addEventListener(
      'pointerdown',
      (e) => {
        const marquee = e.pointerType !== 'touch' || this.regionSelect;
        const cell = this.tileAt(e.clientX, e.clientY);
        if (!cell) return;
        if (marquee) {
          e.preventDefault();
          canvas.setPointerCapture?.(e.pointerId);
          this.dragging = true;
        }
        this.dragStart = cell;
        this.applySelection(cell, cell);
      },
      { passive: false },
    );

    canvas.addEventListener('pointermove', (e) => {
      if (!this.dragging || !this.dragStart) return;
      const cell = this.tileAt(e.clientX, e.clientY);
      if (!cell) return;
      e.preventDefault();
      this.applySelection(this.dragStart, cell);
    });

    const end = (e: PointerEvent) => {
      this.dragging = false;
      this.dragStart = null;
      if (canvas.hasPointerCapture?.(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
  }

  // --- Rendering -----------------------------------------------------------

  /**
   * Switches to another tileset, wrapping at either end so the arrows always
   * do something. The first tile is selected so you can paint immediately
   * rather than having to pick one before the brush works again.
   */
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

    // The dropdown stays in the middle so a project with many sheets can jump
    // straight to one, while the arrows handle the common case of flipping.
    const select = el('select', { class: 'select' });
    doc.tilesets.forEach((tileset, index) => {
      const option = el('option', { value: String(index), text: tileset.name });
      if (index === current) option.selected = true;
      select.append(option);
    });
    select.addEventListener('change', () => this.showPage(Number(select.value)));

    const prev = button('icon-btn', 'Previous tileset', () => this.showPage(current - 1), [
      icon('chevronLeft', 20),
    ]);
    const next = button('icon-btn', 'Next tileset', () => this.showPage(current + 1), [
      icon('chevronRight', 20),
    ]);
    prev.disabled = single;
    next.disabled = single;

    const pager = el('div', { class: 'palette-pager' }, [
      prev,
      select,
      next,
    ]);

    const transforms = el('div', { class: 'palette-transforms' }, [
      button('icon-btn', 'Flip horizontally', () => {
        this.store.setStamp(flipStampH(this.store.stamp), this.store.paletteSelection);
      }, [icon('flipH', 18)]),
      button('icon-btn', 'Flip vertically', () => {
        this.store.setStamp(flipStampV(this.store.stamp), this.store.paletteSelection);
      }, [icon('flipV', 18)]),
      button('icon-btn', 'Rotate 90°', () => {
        this.store.setStamp(rotateStampCW(this.store.stamp), this.store.paletteSelection);
      }, [icon('rotate', 18)]),
      this.toggle('dice', 'Scatter: place a random tile from the selection', this.store.settings.randomize, () => {
        this.store.settings.randomize = !this.store.settings.randomize;
        this.buildHeader();
      }),
      this.toggle('tiles', 'Select a region with your finger instead of scrolling', this.regionSelect, () => {
        this.regionSelect = !this.regionSelect;
        this.canvas.classList.toggle('region-select', this.regionSelect);
        this.buildHeader();
      }),
    ]);

    const tileset = doc.tilesets[current];
    const meta = el('div', { class: 'palette-meta' }, [
      el('span', { text: single ? `${tileset?.count ?? 0} tiles` : `Sheet ${current + 1} of ${total}` }),
      el('span', { class: 'muted', text: single ? '' : `${tileset?.count ?? 0} tiles` }),
    ]);

    this.header.append(
      pager,
      meta,
      el('div', { class: 'palette-row' }, [
        button('icon-btn', 'Tileset settings', () => this.actions.editTileset(this.store.activeTileset), [
          icon('settings', 18),
        ]),
        button('icon-btn', 'Import another tileset', () => this.actions.addTileset(), [icon('plus', 18)]),
        button('icon-btn danger', 'Remove tileset', () => this.actions.removeTileset(this.store.activeTileset), [
          icon('trash', 18),
        ]),
      ]),
      transforms,
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

  /** Recomputes the cell size for the current panel width and repaints. */
  layout(): void {
    const tileset = this.activeTileset();
    const hasTiles = !!tileset && tileset.count > 0;
    this.empty.style.display = this.store.doc.tilesets.length === 0 ? 'flex' : 'none';
    this.scroller.style.display = hasTiles ? 'block' : 'none';

    this.buildHeader();
    if (!tileset || !hasTiles) return;

    const available = Math.max(120, this.scroller.clientWidth - 2);
    // Prefer showing the whole sheet width, but never shrink a tile below the
    // point where you cannot tell what it is.
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
        if (row * tileset.cols + col >= tileset.count) continue;
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
      ctx.strokeStyle = '#7ea0ff';
      ctx.lineWidth = 2;
      ctx.strokeRect(selection.x * cell + 1, selection.y * cell + 1, selection.w * cell - 2, selection.h * cell - 2);
      ctx.fillStyle = 'rgba(126,160,255,0.16)';
      ctx.fillRect(selection.x * cell, selection.y * cell, selection.w * cell, selection.h * cell);
    }
  }
}
