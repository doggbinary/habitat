import { assetsOf, type AssetEdit } from '../core/assets';
import { MY_FLOORS } from '../core/custom-tiles';
import type { AssetRect, Tileset } from '../core/doc';
import type { Store } from '../core/store';
import { button, clear, el } from './dom';
import { icon, type IconName } from './icons';
import { packNames, packOf, sameAsset, type AssetRef } from './packs';

/**
 * Which page of the library is open. Pinned and folders gather stickers from
 * any number of sheets; a sheet page is one imported picture.
 */
type View = { kind: 'sheet' } | { kind: 'pins' } | { kind: 'folder'; id: string };

/** One thumbnail: the sticker, and the sheet it has to be drawn from. */
interface Entry {
  tileset: Tileset;
  tilesetIndex: number;
  rect: AssetRect;
  /** Its place on its own sheet, which is what the edit actions work on. */
  assetIndex: number;
}

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
  /** A tap on an asset: add it to the map, or paint with it if it is a floor square. */
  tapAsset: (tilesetIndex: number, assetIndex: number) => void;
  dragStart: (tilesetId: string, rect: AssetRect) => void;
  dragMove: (clientX: number, clientY: number) => void;
  /** `dropped` is false when the gesture was cancelled by the system. */
  dragEnd: (clientX: number, clientY: number, dropped: boolean) => void;
  /** Fixes detection by hand: join pieces of one asset, or drop strays. */
  editAssets: (tilesetIndex: number, op: AssetEdit, indices: number[]) => void;
  /** Adds stickers to the Pinned page, or takes them off it. */
  setPinned: (refs: AssetRef[], pinned: boolean) => void;
  /**
   * Sets what a folder holds, creating it when `folderId` is null. The list
   * is the whole contents, so this adds and removes with one call.
   */
  fileAssets: (folderId: string | null, name: string, refs: AssetRef[]) => void;
  /** Empties and removes a folder. The stickers themselves are untouched. */
  removeFolder: (folderId: string) => void;
}

/**
 * The asset library: every thing on the current sheet, whole, laid out as
 * thumbnails. The sheet's floor squares come first, then its props.
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
  private entries: Entry[] = [];
  private view: View = { kind: 'sheet' };

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
      el('p', { text: 'Loading the library…' }),
      el('p', {
        class: 'muted',
        text: 'Packs appear here as each page is ready. You can also import your own sheet.',
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
    return index < this.entries.length ? index : -1;
  }

  /** The sticker under a thumbnail, as it is remembered on a page or in a folder. */
  private refAt(index: number): AssetRef | null {
    const entry = this.entries[index];
    return entry ? { tilesetId: entry.tileset.id, rect: entry.rect } : null;
  }

  private selectedRefs(): AssetRef[] {
    return [...this.selected]
      .sort((a, b) => a - b)
      .map((i) => this.refAt(i))
      .filter((ref): ref is AssetRef => ref !== null);
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
    const entry = this.entries[this.pressAsset];
    if (!entry) return;
    this.clearLongPress();
    this.mode = 'drag';
    this.showGhost(entry.tileset, entry.rect);
    this.moveGhost(clientX, clientY);
    this.actions.dragStart(entry.tileset.id, entry.rect);
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

        // Something already in flight to the map keeps going.
        if (this.mode === 'drag') return;
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
      if (this.mode === 'pending' && !cancelled && this.editing) {
        if (this.selected.has(this.pressAsset)) this.selected.delete(this.pressAsset);
        else this.selected.add(this.pressAsset);
        this.buildHeader();
        this.draw();
      } else if (this.mode === 'pending' && !cancelled) {
        const entry = this.entries[this.pressAsset];
        if (entry) this.actions.tapAsset(entry.tilesetIndex, entry.assetIndex);
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
    // Editing belongs to one sheet; never carry it onto the next.
    this.editing = false;
    this.selected.clear();
    this.view = { kind: 'sheet' };
    this.store.activeTileset = ((index % count) + count) % count;
    this.layout();
    this.scroller.scrollTop = 0;
  }

  /** Opens Pinned, a folder, or back to the sheets. */
  private showView(view: View): void {
    this.editing = false;
    this.selected.clear();
    this.view = view;
    this.layout();
    this.scroller.scrollTop = 0;
  }

  private sameView(a: View, b: View): boolean {
    if (a.kind !== b.kind) return false;
    return a.kind !== 'folder' || b.kind !== 'folder' || a.id === b.id;
  }

  /**
   * The pages across the top: Pinned first, then each folder, then the
   * imported sheets. Everything you filed yourself is reachable without
   * scrolling past two hundred sheets to find it.
   */
  private pageTabs(): HTMLElement {
    const doc = this.store.doc;
    const tab = (view: View, name: IconName, label: string, count: number) =>
      button(`chip${this.sameView(this.view, view) ? ' active' : ''}`, label, () => this.showView(view), [
        icon(name, 16),
        el('span', { class: 'chip-text', text: count > 0 ? `${label} ${count}` : label }),
      ]);

    return el('div', { class: 'palette-tabs' }, [
      tab({ kind: 'pins' }, 'star', 'Pinned', doc.pins.length),
      ...doc.folders.map((folder) => tab({ kind: 'folder', id: folder.id }, 'layers', folder.name, folder.assets.length)),
      tab({ kind: 'sheet' }, 'image', 'Sheets', 0),
    ]);
  }

  /** Pack, then sheet: two short lists instead of one list of every page. */
  private sheetPicker(): HTMLElement {
    const doc = this.store.doc;
    const current = this.store.activeTileset;
    const currentPack = packOf(doc.tilesets[current]?.name ?? '');

    const packs = el('select', { class: 'select' });
    for (const name of packNames(doc.tilesets.map((t) => t.name))) {
      const option = el('option', { value: name, text: name });
      if (name === currentPack) option.selected = true;
      packs.append(option);
    }
    packs.addEventListener('change', () => {
      const first = doc.tilesets.findIndex((t) => packOf(t.name) === packs.value);
      if (first >= 0) this.showPage(first);
    });

    const inPack = doc.tilesets
      .map((t, i) => ({ name: t.name, index: i }))
      .filter((t) => packOf(t.name) === currentPack);
    const pages = el('select', { class: 'select' });
    for (const page of inPack) {
      const option = el('option', { value: String(page.index), text: page.name });
      if (page.index === current) option.selected = true;
      pages.append(option);
    }
    pages.addEventListener('change', () => this.showPage(Number(pages.value)));

    const step = (by: number) => {
      const at = inPack.findIndex((p) => p.index === current);
      const next = inPack[at + by];
      if (next) this.showPage(next.index);
    };
    const prev = button('icon-btn', 'Previous page', () => step(-1), [icon('chevronLeft', 20)]);
    const next = button('icon-btn', 'Next page', () => step(1), [icon('chevronRight', 20)]);
    prev.disabled = inPack[0]?.index === current;
    next.disabled = inPack[inPack.length - 1]?.index === current;

    return el('div', { class: 'palette-picker' }, [packs, el('div', { class: 'palette-pager' }, [prev, pages, next])]);
  }

  /**
   * A page arrived from the library. Only the pack and page lists can have
   * changed, so only they are replaced, and only when they did: rebuilding
   * the buttons under a finger would swallow the tap.
   */
  libraryGrew(): void {
    const picker = this.header.querySelector('.palette-picker');
    if (this.view.kind !== 'sheet' || !picker || this.entries.length === 0) {
      this.layout();
      return;
    }
    const next = this.sheetPicker();
    if (next.textContent !== picker.textContent) picker.replaceWith(next);
  }

  private buildHeader(): void {
    clear(this.header);
    const doc = this.store.doc;
    if (doc.tilesets.length === 0) return;

    const current = this.store.activeTileset;
    const view = this.view;
    const onSheet = view.kind === 'sheet';
    const title =
      view.kind === 'pins'
        ? 'Pinned'
        : view.kind === 'folder'
          ? (doc.folders.find((f) => f.id === view.id)?.name ?? 'Folder')
          : 'Assets';

    this.header.append(
      this.pageTabs(),
      ...(onSheet ? [this.sheetPicker()] : []),
      el('div', { class: 'palette-meta' }, [
        el('span', { class: 'palette-title', text: title }),
        el('span', { class: 'muted', text: `${this.entries.length}` }),
      ]),
      onSheet
        ? el('div', { class: 'palette-row' }, [
            button('icon-btn', 'Sheet settings', () => this.actions.editTileset(current), [icon('settings', 18)]),
            button('icon-btn', 'Import another sheet', () => this.actions.addTileset(), [icon('plus', 18)]),
            button('icon-btn danger', 'Remove sheet', () => this.actions.removeTileset(current), [icon('trash', 18)]),
            el('div', { class: 'spacer' }),
            button(`chip${this.editing ? ' active' : ''}`, 'Pin, file or fix the assets on this sheet', () =>
              this.setEditing(!this.editing),
            [icon('select', 16), el('span', { text: this.editing ? 'Editing' : 'Edit' })]),
          ])
        : el('div', { class: 'palette-row' }, [
            el('div', { class: 'spacer' }),
            button(`chip${this.editing ? ' active' : ''}`, 'Choose assets to take off this page', () =>
              this.setEditing(!this.editing),
            [icon('select', 16), el('span', { text: this.editing ? 'Editing' : 'Edit' })]),
          ]),
      this.editing
        ? this.editBar(current)
        : el('p', {
            class: 'hint',
            text:
              this.entries.length === 0
                ? view.kind === 'pins'
                  ? 'Nothing pinned yet. On a sheet, tap Edit, choose assets, then Pin.'
                  : 'This folder is empty. On a sheet, tap Edit, choose assets, then File.'
                : 'Floor squares come first: tap one, then draw or use Rectangle. Tap any other asset to add it, or press and hold to drag it.',
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
    const refs = this.selectedRefs();
    const done = () => {
      this.selected.clear();
      this.layout();
    };

    const chips: HTMLElement[] = [];
    const view = this.view;

    if (view.kind === 'sheet') {
      // Floor squares are listed first, so a thumbnail's place is not its
      // asset number on the sheet.
      const indices = picked.flatMap((i) => (this.entries[i] ? [this.entries[i].assetIndex] : []));
      const run = (op: AssetEdit) => {
        this.selected.clear();
        this.actions.editAssets(sheetIndex, op, indices);
      };
      const floor = new Set(this.activeTileset()?.groundAssets ?? []);
      const mine = this.activeTileset()?.generated && this.activeTileset()?.name === MY_FLOORS;
      const allFloor = indices.length > 0 && (mine || indices.every((i) => floor.has(i)));
      const floorChip = allFloor
        ? button('chip', 'Turn these back into objects you place', () => run('toObjects'), [
            el('span', { text: 'Not a floor' }),
          ])
        : button('chip', 'Make these floor squares you paint with the brush or rectangle', () => run('toGround'), [
            icon('tiles', 16),
            el('span', { text: 'Make floor' }),
          ]);
      floorChip.disabled = indices.length === 0;
      const merge = button('chip', 'Join the selected pieces into one asset', () => run('merge'), [
        el('span', { text: 'Merge' }),
      ]);
      merge.disabled = picked.length < 2;
      const remove = button('chip danger', 'Remove the selected assets from this sheet', () => run('delete'), [
        el('span', { text: 'Delete' }),
      ]);
      remove.disabled = picked.length === 0;

      const pin = button('chip', 'Keep these on the Pinned page', () => {
        this.actions.setPinned(refs, true);
        done();
      }, [icon('star', 16), el('span', { text: 'Pin' })]);
      pin.disabled = refs.length === 0;

      const file = button('chip', 'Put these in a folder', () => {
        this.chooseFolder(refs);
        done();
      }, [icon('layers', 16), el('span', { text: 'File' })]);
      file.disabled = refs.length === 0;

      chips.push(floorChip, pin, file, merge, remove);
    } else {
      const label = view.kind === 'pins' ? 'Unpin' : 'Take out';
      const take = button('chip danger', `${label} the selected assets`, () => {
        if (view.kind === 'pins') this.actions.setPinned(refs, false);
        else if (view.kind === 'folder') this.unfile(view.id, refs);
        done();
      }, [el('span', { text: label })]);
      take.disabled = refs.length === 0;
      chips.push(take);

      if (view.kind === 'folder') {
        const id = view.id;
        chips.push(
          button('chip danger', 'Delete this folder; the assets stay on their sheets', () => {
            this.actions.removeFolder(id);
            this.showView({ kind: 'sheet' });
          }, [icon('trash', 16), el('span', { text: 'Delete folder' })]),
        );
      }
    }

    return el('div', { class: 'edit-bar' }, [
      el('p', {
        class: 'hint',
        text:
          picked.length === 0
            ? view.kind === 'sheet'
              ? 'Tap assets to select them. Make grass or paving a floor, pin or file them, merge pieces that belong together, or delete stray marks.'
              : 'Tap assets to select them, then take them off this page.'
            : `${picked.length} selected`,
      }),
      el('div', { class: 'chip-row' }, chips),
    ]);
  }

  /** Asks which folder the chosen stickers go in, offering a new one. */
  private chooseFolder(refs: AssetRef[]): void {
    const folders = this.store.doc.folders;
    const names = folders.map((folder, i) => `${i + 1}. ${folder.name}`).join('\n');
    const answer = window.prompt(
      folders.length === 0
        ? `Name a folder for ${refs.length} asset${refs.length === 1 ? '' : 's'}:`
        : `Folder for ${refs.length} asset${refs.length === 1 ? '' : 's'} — type a number or a new name:\n${names}`,
      folders.length === 0 ? 'Favourites' : '',
    );
    if (answer === null) return;
    const name = answer.trim();
    if (!name) return;
    const chosen = folders[Number(name) - 1];
    if (chosen) {
      const added = refs.filter((ref) => !chosen.assets.some((asset) => sameAsset(asset, ref)));
      this.actions.fileAssets(chosen.id, chosen.name, [...chosen.assets, ...added]);
    } else {
      this.actions.fileAssets(null, name, refs);
    }
  }

  private unfile(folderId: string, refs: AssetRef[]): void {
    const folder = this.store.doc.folders.find((f) => f.id === folderId);
    if (!folder) return;
    const keep = folder.assets.filter((asset) => !refs.some((ref) => sameAsset(asset, ref)));
    this.actions.fileAssets(folderId, folder.name, keep);
  }

  // --- Rendering -----------------------------------------------------------

  /**
   * The thumbnails on the open page. A sheet page is that sheet's stickers;
   * Pinned and folders gather stickers from wherever they came from, dropping
   * any whose sheet has since gone.
   */
  private buildEntries(): Entry[] {
    const doc = this.store.doc;
    const view = this.view;
    if (view.kind === 'sheet') {
      const tileset = this.activeTileset();
      if (!tileset) return [];
      const index = this.store.activeTileset;
      // Every asset on its own, with the sheet's floor squares first: a map
      // starts with its floor, then the things standing on it.
      const floor = new Set(tileset.groundAssets ?? []);
      const entries = assetsOf(tileset).map((rect, assetIndex) => ({ tileset, tilesetIndex: index, rect, assetIndex }));
      return [...entries.filter((e) => floor.has(e.assetIndex)), ...entries.filter((e) => !floor.has(e.assetIndex))];
    }

    const refs =
      view.kind === 'pins' ? doc.pins : (doc.folders.find((folder) => folder.id === view.id)?.assets ?? []);

    const entries: Entry[] = [];
    for (const ref of refs) {
      const tilesetIndex = doc.tilesets.findIndex((sheet) => sheet.id === ref.tilesetId);
      const tileset = doc.tilesets[tilesetIndex];
      if (!tileset) continue;
      // A sticker whose sheet has since been re-split no longer exists as
      // itself, so it drops off the page rather than placing the wrong thing.
      const assetIndex = assetsOf(tileset).findIndex((rect) => sameAsset({ tilesetId: tileset.id, rect }, ref));
      if (assetIndex === -1) continue;
      entries.push({ tileset, tilesetIndex, rect: ref.rect, assetIndex });
    }
    return entries;
  }

  layout(): void {
    // A folder that has since been deleted falls back to the sheets, so the
    // panel is never stuck on a page that no longer exists.
    const view = this.view;
    if (view.kind === 'folder' && !this.store.doc.folders.some((f) => f.id === view.id)) {
      this.view = { kind: 'sheet' };
    }
    this.entries = this.buildEntries();
    // Indices are only meaningful against the list they were picked from.
    for (const i of [...this.selected]) if (i >= this.entries.length) this.selected.delete(i);
    const has = this.entries.length > 0;
    this.empty.style.display = this.store.doc.tilesets.length === 0 ? 'flex' : 'none';
    this.scroller.style.display = has ? 'block' : 'none';
    this.buildHeader();
    if (!has) return;

    const available = Math.max(160, this.scroller.clientWidth - 4);
    this.columns = Math.max(3, Math.floor(available / TARGET_CELL));
    this.cell = Math.floor(available / this.columns);

    const rows = Math.ceil(this.entries.length / this.columns);
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
    const { ctx, cell } = this;
    const rows = Math.ceil(this.entries.length / this.columns);
    ctx.clearRect(0, 0, this.columns * cell, rows * cell);
    ctx.imageSmoothingEnabled = false;

    const pick = this.store.libraryPick;
    const pad = 6;

    for (let i = 0; i < this.entries.length; i++) {
      const { tileset, rect, assetIndex } = this.entries[i];
      if (!tileset.image) continue;
      const col = i % this.columns;
      const row = Math.floor(i / this.columns);
      const x = col * cell;
      const y = row * cell;

      // Editing shows its own selection in amber, so it is never confused
      // with the brush's blue "this is what you will place" highlight.
      const chosen = this.editing && this.selected.has(i);
      const picked = !this.editing && pick?.tilesetId === tileset.id && pick.index === assetIndex;
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
