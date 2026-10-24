import { assetsOf, groundOf } from '../core/assets';
import type { AssetRect, Tileset } from '../core/doc';
import type { Store } from '../core/store';
import type { Stamp } from '../core/stamp';
import { EMPTY, pack, tilesetOf } from '../core/tiles';
import { drawTile } from '../render/tile-draw';
import { button, clear, el } from './dom';
import { icon } from './icons';

/** Target thumbnail size; the column count adapts to the panel width. */
const TARGET_CELL = 76;
/** Ground sheets keep their own layout, sized to fit but never below a fingertip. */
const GROUND_MIN_CELL = 28;
const GROUND_MAX_CELL = 72;
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
  /** Fixes detection by hand: join pieces, cut blended art into tiles, or drop strays. */
  editAssets: (tilesetIndex: number, op: 'merge' | 'split' | 'delete', indices: number[]) => void;
  /** Makes a block of ground tiles the brush; `region` is where it was picked in the palette. */
  pickTiles: (stamp: Stamp, region: { x: number; y: number; w: number; h: number }) => void;
  /** The picked block is being carried over the map. */
  tilesDragMove: (clientX: number, clientY: number) => void;
  tilesDragEnd: (clientX: number, clientY: number, dropped: boolean) => void;
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

  /**
   * Ground sheets are drawn as laid out on the sheet rather than as separate
   * thumbnails. Path edges and corners are drawn next to each other on
   * purpose, and picking a block of them only means something in that layout.
   */
  private ground = false;
  /** Which cells of the sheet on show are ground; the rest scroll instead of picking. */
  private groundCells: Uint8Array = new Uint8Array(0);
  private groundKey = '';
  /** Sheet row shown on each palette row; rows with no ground are left out. */
  private rowMap: number[] = [];
  /** Corner a ground block pick started from. */
  private anchor: { x: number; y: number } | null = null;

  private mode: 'idle' | 'pending' | 'scroll' | 'drag' | 'select' | 'carry' | 'grab' = 'idle';
  /** The pick a Pencil press started on, carried instead if the Pencil leaves the palette. */
  private pressPick: { x: number; y: number; w: number; h: number } | null = null;
  private activeId: number | null = null;
  private pressAsset = -1;
  private pressPoint = { x: 0, y: 0 };
  private lastPoint = { x: 0, y: 0 };
  private velocity = { x: 0, y: 0 };
  private longPressTimer = 0;
  private flingHandle = 0;
  private readonly pointers = new Map<number, string>();

  private ghost: HTMLCanvasElement | null = null;

  /**
   * Edit mode: taps select thumbnails instead of placing them, so detection
   * can be corrected. Off by default and reset on every sheet change, so it
   * never lingers and turns an ordinary tap into something unexpected.
   */
  private editing = false;
  private readonly selected = new Set<number>();

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
        // Something already in flight to the map keeps going.
        if (this.mode === 'drag' || this.mode === 'carry') return;
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
        if (this.ground) {
          this.groundDown(e);
          return;
        }
        this.pressAsset = this.assetAt(e.clientX, e.clientY);

        if (this.pressAsset === -1) {
          this.mode = 'scroll';
          return;
        }

        this.mode = 'pending';
        // Nothing gets picked up while editing; a press is only ever a select.
        if (e.pointerType === 'touch' && !this.editing) {
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
        if (this.ground && this.groundMove(e, moved)) return;

        if (this.mode === 'pending') {
          if (e.pointerType === 'touch') {
            // Moving before the hold completes means you meant to scroll.
            if (moved > TOUCH_SLOP) {
              this.clearLongPress();
              this.mode = 'scroll';
            }
          } else if (moved > PEN_SLOP) {
            if (this.editing) {
              this.mode = 'scroll';
            } else {
              this.beginDrag(e.clientX, e.clientY);
              return;
            }
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
      if (this.ground) {
        this.groundEnd(e, cancelled);
      } else if (this.mode === 'pending' && !cancelled && this.editing) {
        if (this.selected.has(this.pressAsset)) this.selected.delete(this.pressAsset);
        else this.selected.add(this.pressAsset);
        this.buildHeader();
        this.draw();
      } else if (this.mode === 'pending' && !cancelled) {
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
      this.anchor = null;
      this.pressPick = null;
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
  }

  // --- Ground sheets -------------------------------------------------------
  //
  // A finger swipe scrolls, as it does for props. A tap picks one tile, and
  // press-and-hold then drag picks a block. The Pencil has no reason to
  // scroll, so it picks a block straight away. Either way, carrying the pick
  // past the palette's edge drops it onto the map.

  /** The palette cell under a point, in display rows (rows without ground are skipped). */
  private tileAt(clientX: number, clientY: number): { x: number; y: number } | null {
    const tileset = this.activeTileset();
    if (!tileset) return null;
    const rect = this.canvas.getBoundingClientRect();
    const x = Math.floor((clientX - rect.left) / this.cell);
    const y = Math.floor((clientY - rect.top) / this.cell);
    if (x < 0 || y < 0 || x >= tileset.cols || y >= this.rowMap.length) return null;
    return { x, y };
  }

  /** Tile index on the sheet for a palette cell. */
  private sheetIndex(cell: { x: number; y: number }): number {
    const tileset = this.activeTileset();
    const row = this.rowMap[cell.y];
    return tileset && row !== undefined ? row * tileset.cols + cell.x : -1;
  }

  private isGroundAt(cell: { x: number; y: number }): boolean {
    const index = this.sheetIndex(cell);
    return index >= 0 && this.groundCells[index] === 1;
  }

  private groundDown(e: PointerEvent): void {
    const tileset = this.activeTileset();
    const cell = this.tileAt(e.clientX, e.clientY);
    if (!tileset || !cell) {
      this.mode = 'scroll';
      return;
    }
    this.anchor = cell;

    // The Pencil always picks as it drags. If it started on the highlighted
    // pick and then leaves the palette, it carries that pick, not whatever
    // it brushed past on the way out.
    if (e.pointerType !== 'touch') {
      const pick = this.store.paletteSelection;
      this.pressPick = pick && this.insidePick(cell) ? { ...pick } : null;
      this.mode = 'select';
      this.pickBlock(cell);
      return;
    }

    // A finger holding the highlighted pick lifts it to carry to the map.
    if (this.insidePick(cell)) {
      this.mode = 'grab';
      const { clientX, clientY } = e;
      this.longPressTimer = window.setTimeout(() => {
        if (this.mode === 'grab') this.beginCarry(clientX, clientY);
      }, LONG_PRESS_MS);
      return;
    }
    // An empty square has nothing to pick, so it is always a scroll handle.
    if (!this.isGroundAt(cell)) {
      this.mode = 'scroll';
      return;
    }
    this.mode = 'pending';
    this.longPressTimer = window.setTimeout(() => {
      if (this.mode !== 'pending') return;
      this.mode = 'select';
      this.pickBlock(cell);
    }, LONG_PRESS_MS);
  }

  private insidePick(cell: { x: number; y: number }): boolean {
    const pick = this.store.paletteSelection;
    return (
      !!pick &&
      this.stampFromActiveSheet() &&
      cell.x >= pick.x &&
      cell.y >= pick.y &&
      cell.x < pick.x + pick.w &&
      cell.y < pick.y + pick.h
    );
  }

  private beginCarry(clientX: number, clientY: number): void {
    this.clearLongPress();
    this.mode = 'carry';
    this.showStampGhost();
    this.moveGhost(clientX, clientY);
    this.actions.tilesDragMove(clientX, clientY);
  }

  /** Returns true when the move was fully handled here. */
  private groundMove(e: PointerEvent, moved: number): boolean {
    if (this.mode === 'grab') {
      // A finger that moves before the hold completes meant to scroll.
      if (moved <= TOUCH_SLOP) return true;
      this.clearLongPress();
      this.mode = 'scroll';
      return false;
    }
    if (this.mode === 'pending') {
      if (moved <= TOUCH_SLOP) return true;
      this.clearLongPress();
      this.mode = 'scroll';
      return false;
    }
    if (this.mode === 'select') {
      if (!this.insidePalette(e.clientX, e.clientY)) {
        if (this.pressPick) this.actions.pickTiles(this.stampFor(this.pressPick), this.pressPick);
        this.beginCarry(e.clientX, e.clientY);
        this.draw();
        return true;
      }
      const cell = this.tileAt(e.clientX, e.clientY);
      if (cell) this.pickBlock(cell);
      return true;
    }
    if (this.mode === 'carry') {
      this.moveGhost(e.clientX, e.clientY);
      this.actions.tilesDragMove(e.clientX, e.clientY);
      return true;
    }
    return false;
  }

  private groundEnd(e: PointerEvent, cancelled: boolean): void {
    // A tap, including one on the current pick, picks that single tile.
    if ((this.mode === 'pending' || this.mode === 'grab') && !cancelled && this.anchor) {
      const anchor = this.anchor;
      this.anchor = null;
      this.pickBlock(anchor);
    } else if (this.mode === 'scroll') {
      this.startFling();
    } else if (this.mode === 'carry') {
      this.actions.tilesDragEnd(e.clientX, e.clientY, !cancelled);
      this.hideGhost();
    }
  }

  /** Picks the block between the anchor and a cell as the brush. */
  private pickBlock(to: { x: number; y: number }): void {
    const from = this.anchor ?? to;
    const region = {
      x: Math.min(from.x, to.x),
      y: Math.min(from.y, to.y),
      w: Math.abs(from.x - to.x) + 1,
      h: Math.abs(from.y - to.y) + 1,
    };
    const current = this.store.paletteSelection;
    if (
      current &&
      current.x === region.x &&
      current.y === region.y &&
      current.w === region.w &&
      current.h === region.h &&
      this.stampFromActiveSheet()
    ) {
      return;
    }
    this.actions.pickTiles(this.stampFor(region), region);
    this.draw();
  }

  /**
   * The brush for a block of palette cells. Cells that are not ground, such
   * as a prop beside the floor, come out as holes rather than chopped props.
   */
  private stampFor(region: { x: number; y: number; w: number; h: number }): Stamp {
    const tiles = new Int32Array(region.w * region.h).fill(EMPTY);
    for (let dy = 0; dy < region.h; dy++) {
      for (let dx = 0; dx < region.w; dx++) {
        const cell = { x: region.x + dx, y: region.y + dy };
        if (this.isGroundAt(cell)) tiles[dy * region.w + dx] = pack(this.store.activeTileset, this.sheetIndex(cell));
      }
    }
    return { w: region.w, h: region.h, tiles };
  }

  /** True when the brush was picked from the sheet on show, so its marquee belongs here. */
  private stampFromActiveSheet(): boolean {
    for (const tile of this.store.stamp.tiles) {
      if (tile !== EMPTY) return tilesetOf(tile) === this.store.activeTileset;
    }
    return false;
  }

  private insidePalette(clientX: number, clientY: number): boolean {
    const rect = this.scroller.getBoundingClientRect();
    return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
  }

  /**
   * Works out which cells are ground, and which sheet rows have any, once
   * per sheet. Props are left out of the Ground view entirely, and rows with
   * no ground are skipped so the floor pieces sit together.
   */
  private prepareGround(tileset: Tileset): void {
    const key = `${tileset.id}:${tileset.tileW}x${tileset.tileH}:${tileset.margin}:${tileset.spacing}:${tileset.count}:${tileset.imgW}x${tileset.imgH}`;
    if (this.groundKey === key) return;
    this.groundKey = key;
    this.groundCells = groundOf(tileset)?.cells ?? new Uint8Array(0);
    this.rowMap = [];
    for (let row = 0; row < tileset.rows; row++) {
      for (let col = 0; col < tileset.cols; col++) {
        if (this.groundCells[row * tileset.cols + col]) {
          this.rowMap.push(row);
          break;
        }
      }
    }
  }

  /** Renders the picked block into the floating ghost that follows a carry. */
  private showStampGhost(): void {
    this.hideGhost();
    const stamp = this.store.stamp;
    if (stamp.w === 0) return;
    // Big enough to read under a fingertip, small enough not to hide the map.
    const cell = Math.max(18, Math.min(40, Math.floor(120 / Math.max(stamp.w, stamp.h))));
    const ghost = el('canvas', { class: 'drag-ghost' });
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    ghost.width = stamp.w * cell * dpr;
    ghost.height = stamp.h * cell * dpr;
    ghost.style.width = `${stamp.w * cell}px`;
    ghost.style.height = `${stamp.h * cell}px`;
    const ctx = ghost.getContext('2d');
    if (ctx) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = false;
      for (let y = 0; y < stamp.h; y++) {
        for (let x = 0; x < stamp.w; x++) {
          const tile = stamp.tiles[y * stamp.w + x];
          if (tile !== EMPTY) drawTile(ctx, this.store.doc, tile, x * cell, y * cell, cell);
        }
      }
    }
    document.body.append(ghost);
    this.ghost = ghost;
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
    // Editing belongs to one sheet; never carry it onto the next.
    this.editing = false;
    this.selected.clear();
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
        el('span', {
          text: isObjects
            ? `${this.assets.length} props`
            : `${this.groundCells.reduce((sum, c) => sum + c, 0)} ground tiles`,
        }),
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
        el('div', { class: 'spacer' }),
        // Fixing detection only makes sense for props; ground is a plain grid.
        isObjects
          ? button(`chip${this.editing ? ' active' : ''}`, 'Fix how this sheet is split into props', () =>
              this.setEditing(!this.editing),
            [icon('select', 16), el('span', { text: this.editing ? 'Editing' : 'Edit' })])
          : null,
      ]),
      this.editing && isObjects
        ? this.editBar(current)
        : el('p', {
            class: 'hint',
            text: isObjects
              ? 'Tap a prop to add it, or press and hold, then drag it onto the map. With a prop selected on the map, tapping one here swaps it.'
              : this.rowMap.length === 0
                ? 'This sheet has no ground tiles, only props. Switch to Props to place them.'
                : 'Tap a tile to paint with it. To pick a block, drag across tiles with the Pencil, or hold then drag with a finger. Then drag the highlighted block onto the map.',
          }),
    );
  }

  private setEditing(on: boolean): void {
    this.editing = on;
    this.selected.clear();
    this.buildHeader();
    this.draw();
  }

  /**
   * The edit actions, each enabled only when it means something for the
   * current selection, so there is never a button that does nothing.
   */
  private editBar(sheetIndex: number): HTMLElement {
    const picked = [...this.selected].sort((a, b) => a - b);
    const run = (op: 'merge' | 'split' | 'delete') => {
      this.selected.clear();
      this.actions.editAssets(sheetIndex, op, picked);
    };

    const merge = button('chip', 'Join the selected pieces into one prop', () => run('merge'), [
      el('span', { text: 'Merge' }),
    ]);
    merge.disabled = picked.length < 2;
    const split = button('chip', 'Cut the selected prop into one per tile', () => run('split'), [
      el('span', { text: 'Split into tiles' }),
    ]);
    split.disabled = picked.length !== 1;
    const remove = button('chip danger', 'Remove the selected props from this sheet', () => run('delete'), [
      el('span', { text: 'Delete' }),
    ]);
    remove.disabled = picked.length === 0;

    return el('div', { class: 'edit-bar' }, [
      el('p', {
        class: 'hint',
        text:
          picked.length === 0
            ? 'Tap props to select them. Merge pieces that belong together, or split one that should be several.'
            : `${picked.length} selected`,
      }),
      el('div', { class: 'chip-row' }, [merge, split, remove]),
    ]);
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
    // Indices are only meaningful against the list they were picked from.
    for (const i of [...this.selected]) if (i >= this.assets.length) this.selected.delete(i);
    if (tileset?.splitMode !== 'objects') this.editing = false;
    this.ground = !!tileset && tileset.splitMode !== 'objects';
    if (tileset && this.ground) this.prepareGround(tileset);
    const has = this.ground ? this.rowMap.length > 0 : this.assets.length > 0;
    this.empty.style.display = this.store.doc.tilesets.length === 0 ? 'flex' : 'none';
    this.scroller.style.display = has ? 'block' : 'none';
    this.buildHeader();
    if (!tileset || !has) return;
    if (this.ground) {
      this.layoutGround(tileset);
      return;
    }

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

  private layoutGround(tileset: Tileset): void {
    const available = Math.max(120, this.scroller.clientWidth - 2);
    this.cell = Math.max(GROUND_MIN_CELL, Math.min(GROUND_MAX_CELL, Math.floor(available / tileset.cols)));

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const width = tileset.cols * this.cell;
    const height = this.rowMap.length * this.cell;
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  private drawGround(tileset: Tileset & { image: CanvasImageSource }): void {
    const { ctx, cell } = this;
    const width = tileset.cols * cell;
    const height = this.rowMap.length * cell;
    ctx.clearRect(0, 0, width, height);
    ctx.imageSmoothingEnabled = cell < tileset.tileW;

    this.rowMap.forEach((row, shown) => {
      for (let col = 0; col < tileset.cols; col++) {
        const index = row * tileset.cols + col;
        if (index >= tileset.count) continue;
        // Empty squares scroll instead of picking, so mark them faintly to
        // make that visible rather than something you discover.
        if (!this.groundCells[index]) {
          ctx.fillStyle = 'rgba(255,255,255,0.025)';
          ctx.fillRect(col * cell + 2, shown * cell + 2, cell - 4, cell - 4);
          continue;
        }
        ctx.drawImage(
          tileset.image,
          tileset.margin + col * (tileset.tileW + tileset.spacing),
          tileset.margin + row * (tileset.tileH + tileset.spacing),
          tileset.tileW,
          tileset.tileH,
          col * cell,
          shown * cell,
          cell,
          cell,
        );
      }
    });

    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let col = 1; col < tileset.cols; col++) {
      ctx.moveTo(col * cell + 0.5, 0);
      ctx.lineTo(col * cell + 0.5, height);
    }
    for (let shown = 1; shown < this.rowMap.length; shown++) {
      ctx.moveTo(0, shown * cell + 0.5);
      ctx.lineTo(width, shown * cell + 0.5);
    }
    ctx.stroke();

    // Where rows were skipped, a firmer line says these pieces were not
    // drawn next to each other on the sheet.
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let shown = 1; shown < this.rowMap.length; shown++) {
      if (this.rowMap[shown] === this.rowMap[shown - 1] + 1) continue;
      ctx.moveTo(0, shown * cell);
      ctx.lineTo(width, shown * cell);
    }
    ctx.stroke();

    const picked = this.store.paletteSelection;
    if (picked && this.stampFromActiveSheet()) {
      ctx.fillStyle = 'rgba(126,160,255,0.16)';
      ctx.fillRect(picked.x * cell, picked.y * cell, picked.w * cell, picked.h * cell);
      ctx.strokeStyle = '#7ea0ff';
      ctx.lineWidth = 2;
      ctx.strokeRect(picked.x * cell + 1, picked.y * cell + 1, picked.w * cell - 2, picked.h * cell - 2);
    }
  }

  draw(): void {
    const tileset = this.activeTileset();
    if (!tileset?.image) return;
    if (this.ground) {
      this.drawGround({ ...tileset, image: tileset.image });
      return;
    }
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

      // Editing shows its own selection in amber, so it is never confused
      // with the brush's blue "this is what you will place" highlight.
      const chosen = this.editing && this.selected.has(i);
      const picked = !this.editing && pick?.tilesetId === tileset.id && pick.index === i;
      ctx.fillStyle = chosen
        ? 'rgba(255,214,102,0.2)'
        : picked
          ? 'rgba(126,160,255,0.18)'
          : 'rgba(255,255,255,0.035)';
      roundRect(ctx, x + 3, y + 3, cell - 6, cell - 6, 8);
      ctx.fill();
      if (chosen || picked) {
        ctx.strokeStyle = chosen ? '#ffd666' : '#7ea0ff';
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
