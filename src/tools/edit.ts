import {
  activeLayerOf,
  cellIndex,
  createLayer,
  inBounds,
  isEditable,
  isTileLayer,
  resizedLayerData,
  uid,
  type ImageLayer,
  type Layer,
  type TileLayer,
  type Tileset,
} from '../core/doc';
import { snapshot, Stroke, type DocSnapshot } from '../core/history';
import {
  flipStampH,
  flipStampV,
  isEmptyStamp,
  randomTile,
  rotateStampCW,
  stampTileAt,
  type Stamp,
} from '../core/stamp';
import type { Store } from '../core/store';
import { EMPTY, flagsOf, indexOf, pack, tilesetOf, type PackedTile } from '../core/tiles';
import type { Renderer } from '../render/renderer';
import { normalizeRect, type Cell, type Rect } from './geometry';

/**
 * All map mutations funnel through here so every edit is recorded for undo and
 * the renderer's layer caches are invalidated exactly where they changed.
 */
export class Editor {
  private stroke: Stroke | null = null;
  /** Document state captured when an image drag starts, for a single undo step. */
  private imageBefore: DocSnapshot | null = null;

  constructor(
    private readonly store: Store,
    private readonly renderer: Renderer,
  ) {}

  get isStroking(): boolean {
    return this.stroke !== null;
  }

  private get doc() {
    return this.store.doc;
  }

  /** The layer edits land on, or null when it is locked, hidden or missing. */
  targetLayer(): TileLayer | null {
    const layer = activeLayerOf(this.doc);
    return isEditable(layer) ? layer : null;
  }

  beginStroke(label: string): boolean {
    const layer = this.targetLayer();
    if (!layer) {
      const active = activeLayerOf(this.doc);
      this.store.toast(
        !active
          ? 'Add a layer first'
          : active.kind === 'image'
            ? 'Pick a tile layer to paint on'
            : 'That layer is locked or hidden',
      );
      return false;
    }
    this.stroke = new Stroke(layer.id, label);
    return true;
  }

  endStroke(): void {
    if (!this.stroke) return;
    const committed = this.store.history.commitStroke(this.stroke);
    this.stroke = null;
    if (committed) this.store.changed();
  }

  /**
   * Rolls an in-progress stroke back to where it started and records nothing.
   * Used when a second finger lands mid-stroke to start a pinch: the gesture
   * was meant as navigation, not as a mark.
   */
  abortStroke(): void {
    const stroke = this.stroke;
    this.stroke = null;
    if (!stroke) return;
    const layer = this.doc.layers.find((l) => l.id === stroke.layerId);
    if (layer && layer.kind === 'tiles') {
      stroke.forEachOriginal((index, before) => {
        layer.data[index] = before;
        this.renderer.markCell(layer.id, index % this.doc.width, (index / this.doc.width) | 0);
      });
    }
    this.store.changed();
  }

  private write(layer: TileLayer, x: number, y: number, tile: PackedTile): void {
    if (!inBounds(this.doc, x, y)) return;
    const index = cellIndex(this.doc, x, y);
    const before = layer.data[index];
    if (before === tile) return;
    layer.data[index] = tile;
    this.stroke?.record(index, before, tile);
    this.renderer.markCell(layer.id, x, y);
  }

  // --- Painting ------------------------------------------------------------

  /** Stamps the brush block with its top-left corner at a cell. */
  paintStamp(x: number, y: number): void {
    const layer = this.targetLayer();
    if (!layer) return;
    const stamp = this.store.stamp;
    if (isEmptyStamp(stamp)) return;

    if (this.store.settings.randomize) {
      this.write(layer, x, y, randomTile(stamp));
      return;
    }

    for (let sy = 0; sy < stamp.h; sy++) {
      for (let sx = 0; sx < stamp.w; sx++) {
        const tile = stamp.tiles[sy * stamp.w + sx];
        // Holes in a multi-tile selection stay transparent rather than erasing.
        if (tile === EMPTY) continue;
        this.write(layer, x + sx, y + sy, tile);
      }
    }
  }

  erase(x: number, y: number, w = 1, h = 1): void {
    const layer = this.targetLayer();
    if (!layer) return;
    for (let sy = 0; sy < h; sy++) {
      for (let sx = 0; sx < w; sx++) this.write(layer, x + sx, y + sy, EMPTY);
    }
  }

  paintCells(cells: Cell[], erasing: boolean): void {
    for (const cell of cells) {
      if (erasing) this.erase(cell.x, cell.y);
      else this.paintStamp(cell.x, cell.y);
    }
  }

  fillRect(rect: Rect, erasing: boolean): void {
    const layer = this.targetLayer();
    if (!layer) return;
    const r = normalizeRect(rect);
    const stamp = this.store.stamp;
    if (!erasing && isEmptyStamp(stamp)) return;

    for (let y = r.y0; y <= r.y1; y++) {
      for (let x = r.x0; x <= r.x1; x++) {
        if (erasing) {
          this.write(layer, x, y, EMPTY);
        } else if (this.store.settings.randomize) {
          this.write(layer, x, y, randomTile(stamp));
        } else {
          const tile = stampTileAt(stamp, x - r.x0, y - r.y0);
          if (tile !== EMPTY) this.write(layer, x, y, tile);
        }
      }
    }
  }

  /**
   * Replaces the contiguous run of identical tiles touching a cell. The stamp
   * pattern is anchored to the map origin so repeated fills line up.
   */
  floodFill(x: number, y: number, erasing: boolean): void {
    const layer = this.targetLayer();
    if (!layer) return;
    const doc = this.doc;
    if (!inBounds(doc, x, y)) return;

    const stamp = this.store.stamp;
    if (!erasing && isEmptyStamp(stamp)) return;

    const target = layer.data[cellIndex(doc, x, y)];
    const singleReplacement = erasing ? EMPTY : stamp.w === 1 && stamp.h === 1 ? stamp.tiles[0] : null;
    if (singleReplacement !== null && singleReplacement === target) return;

    const seen = new Uint8Array(doc.width * doc.height);
    const stack: number[] = [cellIndex(doc, x, y)];
    seen[stack[0]] = 1;

    while (stack.length > 0) {
      const index = stack.pop()!;
      const cx = index % doc.width;
      const cy = (index / doc.width) | 0;

      const tile = erasing || singleReplacement !== null
        ? (singleReplacement as PackedTile)
        : this.store.settings.randomize
          ? randomTile(stamp)
          : stampTileAt(stamp, cx, cy);
      this.write(layer, cx, cy, tile);

      const push = (nx: number, ny: number) => {
        if (!inBounds(doc, nx, ny)) return;
        const ni = cellIndex(doc, nx, ny);
        if (seen[ni]) return;
        if (layer.data[ni] !== target) return;
        seen[ni] = 1;
        stack.push(ni);
      };
      push(cx + 1, cy);
      push(cx - 1, cy);
      push(cx, cy + 1);
      push(cx, cy - 1);
    }
  }

  /** Reads the tile under a cell into the brush. Returns false when empty. */
  pick(x: number, y: number): boolean {
    const doc = this.doc;
    if (!inBounds(doc, x, y)) return false;
    // Sample the topmost visible layer so picking matches what you see.
    for (let i = doc.layers.length - 1; i >= 0; i--) {
      const layer = doc.layers[i];
      if (!layer.visible || layer.kind !== 'tiles') continue;
      const tile = layer.data[cellIndex(doc, x, y)];
      if (tile === EMPTY) continue;
      this.store.setStamp({ w: 1, h: 1, tiles: Int32Array.of(tile) });
      return true;
    }
    return false;
  }

  // --- Selection ------------------------------------------------------------

  /**
   * Picks up a rectangle of tiles. The source cells are cleared straight away
   * so what is drawn floating is exactly what will be written back down.
   */
  liftSelection(rect: Rect): boolean {
    const layer = this.targetLayer();
    if (!layer) {
      this.store.toast('Pick a tile layer first');
      return false;
    }
    const doc = this.doc;
    const r = normalizeRect(rect);
    const x0 = Math.max(0, r.x0);
    const y0 = Math.max(0, r.y0);
    const x1 = Math.min(doc.width - 1, r.x1);
    const y1 = Math.min(doc.height - 1, r.y1);
    if (x1 < x0 || y1 < y0) return false;

    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    const tiles = new Int32Array(w * h);
    let found = false;

    if (!this.beginStroke('Lift tiles')) return false;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const tile = layer.data[cellIndex(doc, x0 + x, y0 + y)];
        tiles[y * w + x] = tile;
        if (tile !== EMPTY) found = true;
        this.write(layer, x0 + x, y0 + y, EMPTY);
      }
    }

    if (!found) {
      // Nothing there: undo the clear and leave no selection behind.
      this.abortStroke();
      this.store.toast('Nothing to pick up there');
      return false;
    }

    this.endStroke();
    this.store.selection = { x: x0, y: y0, w, h, tiles, layerId: layer.id, lifted: true };
    this.store.changed();
    return true;
  }

  /** Writes a floating selection back into its layer and clears it. */
  commitSelection(): void {
    const selection = this.store.selection;
    if (!selection) return;
    const layer = this.doc.layers.find((l) => l.id === selection.layerId);
    this.store.selection = null;

    if (!layer || layer.kind !== 'tiles') {
      this.store.changed();
      return;
    }

    if (this.beginStroke('Move tiles')) {
      for (let y = 0; y < selection.h; y++) {
        for (let x = 0; x < selection.w; x++) {
          const tile = selection.tiles[y * selection.w + x];
          // Holes in the block stay holes rather than erasing what is beneath.
          if (tile === EMPTY) continue;
          this.write(layer, selection.x + x, selection.y + y, tile);
        }
      }
      this.endStroke();
    }
    this.store.changed();
  }

  /**
   * Sends the floating block in front of or behind what is already on the
   * map. Depth in a tilemap is layer order, so this re-targets which layer
   * the block will land on when it is dropped.
   *
   * Moving past the top or bottom creates a new layer, so "bring to front"
   * always has somewhere to go.
   */
  moveSelectionDepth(delta: number): void {
    const selection = this.store.selection;
    if (!selection) return;
    const doc = this.doc;
    const current = doc.layers.findIndex((l) => l.id === selection.layerId);
    if (current === -1) return;

    const target = current + delta;
    if (target < 0 || target >= doc.layers.length) {
      this.structural(delta > 0 ? 'Add layer in front' : 'Add layer behind', () => {
        const layer = createLayer(doc.width, doc.height, `Layer ${doc.layers.length + 1}`);
        const at = delta > 0 ? doc.layers.length : 0;
        doc.layers.splice(at, 0, layer);
        doc.activeLayer = at;
        selection.layerId = layer.id;
      });
      this.store.toast(delta > 0 ? 'Moved in front, on a new layer' : 'Moved behind, on a new layer');
      return;
    }

    const layer = doc.layers[target];
    if (layer.kind !== 'tiles') {
      this.store.toast('That layer holds a reference image');
      return;
    }
    selection.layerId = layer.id;
    doc.activeLayer = target;
    this.store.toast(`${delta > 0 ? 'In front' : 'Behind'}: ${layer.name}`);
    this.store.restructured();
  }

  /** Throws the floating block away without putting it back. */
  deleteSelection(): void {
    if (!this.store.selection) return;
    this.store.selection = null;
    this.store.changed();
    this.store.toast('Deleted');
  }

  /** Re-orients the floating block in place, around its own centre. */
  transformSelection(kind: 'flipH' | 'flipV' | 'rotate'): void {
    const selection = this.store.selection;
    if (!selection) return;
    const stamp: Stamp = { w: selection.w, h: selection.h, tiles: selection.tiles };
    const next =
      kind === 'flipH' ? flipStampH(stamp) : kind === 'flipV' ? flipStampV(stamp) : rotateStampCW(stamp);

    // Rotation swaps the block's dimensions, so recentre it to stop the
    // selection drifting away from where it sits.
    const cx = selection.x + selection.w / 2;
    const cy = selection.y + selection.h / 2;
    selection.tiles = next.tiles;
    selection.w = next.w;
    selection.h = next.h;
    selection.x = Math.round(cx - next.w / 2);
    selection.y = Math.round(cy - next.h / 2);
    this.store.changed();
  }

  // --- Structural operations ----------------------------------------------

  addLayer(name?: string): void {
    this.store.history.transact('Add layer', () => {
      const doc = this.doc;
      const layer = createLayer(doc.width, doc.height, name ?? `Layer ${doc.layers.length + 1}`);
      doc.layers.splice(doc.activeLayer + 1, 0, layer);
      doc.activeLayer += 1;
    });
    this.renderer.invalidateAll();
    this.store.restructured();
  }

  /** Inserts a reference image above the active layer and selects it. */
  addImageLayer(layer: ImageLayer): void {
    this.store.history.transact('Add reference image', () => {
      const doc = this.doc;
      doc.layers.splice(doc.activeLayer + 1, 0, layer);
      doc.activeLayer = Math.min(doc.activeLayer + 1, doc.layers.length - 1);
    });
    this.renderer.invalidateAll();
    this.store.restructured();
  }

  duplicateLayer(index: number): void {
    this.store.history.transact('Duplicate layer', () => {
      const doc = this.doc;
      const source = doc.layers[index];
      if (!source) return;
      const copy: Layer =
        source.kind === 'tiles'
          ? { ...source, id: uid('layer'), name: `${source.name} copy`, data: source.data.slice() }
          : { ...source, id: uid('layer'), name: `${source.name} copy` };
      doc.layers.splice(index + 1, 0, copy);
      doc.activeLayer = index + 1;
    });
    this.renderer.invalidateAll();
    this.store.restructured();
  }

  // --- Reference image placement ------------------------------------------

  /**
   * Dragging an image fires continuously, so the move is applied live and the
   * undo entry is recorded once, when the pointer lifts.
   */
  beginImageTransform(): void {
    this.imageBefore = snapshot(this.doc);
  }

  applyImagePlacement(layer: ImageLayer, placement: { x: number; y: number; w: number; h: number }): void {
    layer.x = placement.x;
    layer.y = placement.y;
    layer.w = placement.w;
    layer.h = placement.h;
    this.store.emit('doc');
  }

  /** Drops a pending image transform without recording an undo step. */
  cancelImageTransform(): void {
    this.imageBefore = null;
  }

  commitImageTransform(label: string): void {
    const before = this.imageBefore;
    this.imageBefore = null;
    if (!before) return;
    this.store.history.commitSnapshot(label, before);
    this.store.changed();
  }

  /** Records a one-shot placement change made from the panel rather than a drag. */
  setImagePlacement(
    layer: ImageLayer,
    placement: { x: number; y: number; w: number; h: number },
    label = 'Move reference image',
  ): void {
    this.store.history.transact(label, () => {
      layer.x = placement.x;
      layer.y = placement.y;
      layer.w = placement.w;
      layer.h = placement.h;
    });
    this.store.changed();
  }

  removeLayer(index: number): void {
    if (this.doc.layers.length <= 1) {
      this.store.toast('A map needs at least one layer');
      return;
    }
    this.store.history.transact('Delete layer', () => {
      const doc = this.doc;
      doc.layers.splice(index, 1);
      doc.activeLayer = Math.min(doc.activeLayer, doc.layers.length - 1);
    });
    this.renderer.invalidateAll();
    this.store.restructured();
  }

  moveLayer(index: number, delta: number): void {
    const target = index + delta;
    if (target < 0 || target >= this.doc.layers.length) return;
    this.store.history.transact('Reorder layers', () => {
      const doc = this.doc;
      const [layer] = doc.layers.splice(index, 1);
      doc.layers.splice(target, 0, layer);
      doc.activeLayer = target;
    });
    this.renderer.invalidateAll();
    this.store.restructured();
  }

  clearLayer(index: number): void {
    const layer = this.doc.layers[index];
    if (!isTileLayer(layer)) return;
    this.store.history.transact('Clear layer', () => {
      layer.data.fill(EMPTY);
    });
    this.renderer.invalidateAll();
    this.store.changed();
  }

  /** Merges a layer down into the one below, keeping the lower layer's name. */
  mergeDown(index: number): void {
    if (index <= 0) return;
    const upper = this.doc.layers[index];
    const lower = this.doc.layers[index - 1];
    // A reference image holds no tiles, so there is nothing to merge either way.
    if (!isTileLayer(upper) || !isTileLayer(lower)) {
      this.store.toast('Only tile layers can be merged');
      return;
    }
    this.store.history.transact('Merge down', () => {
      for (let i = 0; i < lower.data.length; i++) {
        if (upper.data[i] !== EMPTY) lower.data[i] = upper.data[i];
      }
      this.doc.layers.splice(index, 1);
      this.doc.activeLayer = index - 1;
    });
    this.renderer.invalidateAll();
    this.store.restructured();
  }

  /** Applies a structural change and refreshes every cache. */
  structural(label: string, mutate: () => void): void {
    this.store.history.transact(label, mutate);
    this.renderer.invalidateAll();
    this.store.restructured();
  }

  addTileset(tileset: Tileset): void {
    this.structural('Add tileset', () => {
      this.doc.tilesets.push(tileset);
    });
  }

  /** Swaps a tileset in place, keeping its index so placed tiles still resolve. */
  replaceTileset(index: number, tileset: Tileset): void {
    const existing = this.doc.tilesets[index];
    if (!existing) return;
    this.structural('Update tileset', () => {
      tileset.id = existing.id;
      this.doc.tilesets[index] = tileset;
    });
  }

  /**
   * Removes a tileset and repairs every reference to it: tiles from the
   * removed sheet are cleared, and tiles from later sheets shift down to match
   * the array's new indices.
   */
  removeTileset(index: number): void {
    if (!this.doc.tilesets[index]) return;
    this.structural('Remove tileset', () => {
      const doc = this.doc;
      doc.tilesets.splice(index, 1);
      for (const layer of doc.layers) {
        if (!isTileLayer(layer)) continue;
        const data = layer.data;
        for (let i = 0; i < data.length; i++) {
          const tile = data[i];
          if (tile === EMPTY) continue;
          const owner = tilesetOf(tile);
          if (owner === index) data[i] = EMPTY;
          else if (owner > index) data[i] = pack(owner - 1, indexOf(tile), flagsOf(tile));
        }
      }
    });
  }

  resizeMap(width: number, height: number): void {
    const doc = this.doc;
    if (width === doc.width && height === doc.height) return;
    this.structural('Resize map', () => {
      for (const layer of doc.layers) {
        // Reference images keep their pixel placement; only tile buffers are
        // re-gridded to the new size.
        if (isTileLayer(layer)) {
          layer.data = resizedLayerData(layer, doc.width, doc.height, width, height);
        }
      }
      doc.width = width;
      doc.height = height;
    });
  }

  undo(): void {
    if (!this.store.history.undo()) return;
    this.renderer.invalidateAll();
    this.store.restructured();
  }

  redo(): void {
    if (!this.store.history.redo()) return;
    this.renderer.invalidateAll();
    this.store.restructured();
  }
}
