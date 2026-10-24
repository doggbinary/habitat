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
import { isEmptyStamp, randomTile, stampTileAt } from '../core/stamp';
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

  /**
   * The tile layer painting goes to, editable or not.
   *
   * Usually that is simply the active layer. But placing an object makes its
   * object layer active, and objects and reference images sit on top of the
   * ground, so painting while one is selected means the tile layer beneath
   * it. Without this, placing a tree would silently disable the brush.
   */
  private paintLayer(): TileLayer | null {
    const doc = this.doc;
    const active = activeLayerOf(doc);
    if (isTileLayer(active)) return active;

    const from = active ? doc.activeLayer : doc.layers.length;
    for (let i = from - 1; i >= 0; i--) {
      const layer = doc.layers[i];
      if (isTileLayer(layer)) return layer;
    }
    // Nothing underneath: fall back to the topmost tile layer anywhere.
    for (let i = doc.layers.length - 1; i > from; i--) {
      const layer = doc.layers[i];
      if (isTileLayer(layer)) return layer;
    }
    return null;
  }

  /** The layer edits land on, or null when it is locked, hidden or missing. */
  targetLayer(): TileLayer | null {
    const layer = this.paintLayer();
    return isEditable(layer) ? layer : null;
  }

  beginStroke(label: string): boolean {
    const layer = this.targetLayer();
    if (!layer) {
      const target = this.paintLayer();
      this.store.toast(
        !target
          ? 'Add a tile layer to paint on'
          : target.locked
            ? `${target.name} is locked`
            : `${target.name} is hidden`,
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
      const base = { id: uid('layer'), name: `${source.name} copy` };
      const copy: Layer =
        source.kind === 'tiles'
          ? { ...source, ...base, data: source.data.slice() }
          : source.kind === 'objects'
            ? {
                ...source,
                ...base,
                objects: source.objects.map((o) => ({ ...o, id: uid('obj'), rect: { ...o.rect } })),
              }
            : { ...source, ...base };
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
    const removed = this.doc.tilesets[index];
    if (!removed) return;
    this.structural('Remove tileset', () => {
      const doc = this.doc;
      doc.tilesets.splice(index, 1);
      for (const layer of doc.layers) {
        // Objects refer to their sheet by id, so only ones from the removed
        // sheet need to go; nothing has to be renumbered.
        if (layer.kind === 'objects') {
          layer.objects = layer.objects.filter((o) => o.tilesetId !== removed.id);
          continue;
        }
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
