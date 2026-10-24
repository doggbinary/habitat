import type { Doc, Layer, Tileset } from './doc';
import type { PackedTile } from './tiles';

/**
 * Undo is recorded at two granularities.
 *
 * Painting produces `cells` entries, which store only the cells a stroke
 * touched. Structural edits (adding layers, resizing the map, retuning a
 * tileset) produce `snapshot` entries holding a copy of the whole document,
 * because they can change the shape of every layer buffer at once.
 */

interface CellEntry {
  kind: 'cells';
  label: string;
  layerId: string;
  indices: Int32Array;
  before: Int32Array;
  after: Int32Array;
}

export interface DocSnapshot {
  name: string;
  width: number;
  height: number;
  tileSize: number;
  background: string;
  activeLayer: number;
  layers: Layer[];
  tilesets: Tileset[];
}

interface SnapshotEntry {
  kind: 'snapshot';
  label: string;
  before: DocSnapshot;
  after: DocSnapshot;
}

type Entry = CellEntry | SnapshotEntry;

const MAX_ENTRIES = 120;

/** Copies a layer deeply enough that later edits cannot reach into history. */
function copyLayer(layer: Layer): Layer {
  if (layer.kind === 'tiles') return { ...layer, data: layer.data.slice() };
  if (layer.kind === 'objects') {
    return { ...layer, objects: layer.objects.map((o) => ({ ...o, rect: { ...o.rect } })) };
  }
  return { ...layer };
}

export function snapshot(doc: Doc): DocSnapshot {
  return {
    name: doc.name,
    width: doc.width,
    height: doc.height,
    tileSize: doc.tileSize,
    background: doc.background,
    activeLayer: doc.activeLayer,
    layers: doc.layers.map(copyLayer),
    tilesets: doc.tilesets.map((t) => ({ ...t, assets: t.assets?.map((a) => ({ ...a })) })),
  };
}

function restore(doc: Doc, snap: DocSnapshot): void {
  doc.name = snap.name;
  doc.width = snap.width;
  doc.height = snap.height;
  doc.tileSize = snap.tileSize;
  doc.background = snap.background;
  doc.activeLayer = snap.activeLayer;
  doc.layers = snap.layers.map(copyLayer);
  doc.tilesets = snap.tilesets.map((t) => ({ ...t }));
}

/**
 * Accumulates the cells a single stroke changes. A cell painted several times
 * during one drag collapses to one record: the value before the stroke began
 * and the value when the pointer lifted.
 */
export class Stroke {
  private readonly changes = new Map<number, { before: PackedTile; after: PackedTile }>();

  constructor(
    readonly layerId: string,
    readonly label: string,
  ) {}

  record(index: number, before: PackedTile, after: PackedTile): void {
    const existing = this.changes.get(index);
    if (existing) existing.after = after;
    else this.changes.set(index, { before, after });
  }

  get size(): number {
    return this.changes.size;
  }

  /** Walks every touched cell with the value it held before the stroke. */
  forEachOriginal(visit: (index: number, before: PackedTile) => void): void {
    for (const [index, change] of this.changes) visit(index, change.before);
  }

  /** Drops cells whose value ended up where it started. */
  toEntry(): CellEntry | null {
    const indices: number[] = [];
    const before: number[] = [];
    const after: number[] = [];
    for (const [index, change] of this.changes) {
      if (change.before === change.after) continue;
      indices.push(index);
      before.push(change.before);
      after.push(change.after);
    }
    if (indices.length === 0) return null;
    return {
      kind: 'cells',
      label: this.label,
      layerId: this.layerId,
      indices: Int32Array.from(indices),
      before: Int32Array.from(before),
      after: Int32Array.from(after),
    };
  }
}

export class History {
  private undoStack: Entry[] = [];
  private redoStack: Entry[] = [];

  constructor(private readonly doc: () => Doc) {}

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get undoLabel(): string | null {
    return this.undoStack.at(-1)?.label ?? null;
  }

  get redoLabel(): string | null {
    return this.redoStack.at(-1)?.label ?? null;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }

  private push(entry: Entry): void {
    this.undoStack.push(entry);
    if (this.undoStack.length > MAX_ENTRIES) this.undoStack.shift();
    this.redoStack = [];
  }

  commitStroke(stroke: Stroke): boolean {
    const entry = stroke.toEntry();
    if (!entry) return false;
    this.push(entry);
    return true;
  }

  commitSnapshot(label: string, before: DocSnapshot): void {
    this.push({ kind: 'snapshot', label, before, after: snapshot(this.doc()) });
  }

  /**
   * Runs a structural change and records it, snapshotting either side so the
   * caller does not have to think about which buffers the mutation replaced.
   */
  transact(label: string, mutate: () => void): void {
    const before = snapshot(this.doc());
    mutate();
    this.push({ kind: 'snapshot', label, before, after: snapshot(this.doc()) });
  }

  private applyCells(entry: CellEntry, values: Int32Array): boolean {
    const doc = this.doc();
    const layer = doc.layers.find((l) => l.id === entry.layerId);
    // The layer may have been deleted by a later entry that was itself undone
    // out of order; skipping is safer than throwing mid-undo.
    if (!layer || layer.kind !== 'tiles') return false;
    for (let i = 0; i < entry.indices.length; i++) {
      const index = entry.indices[i];
      if (index < layer.data.length) layer.data[index] = values[i];
    }
    const index = doc.layers.indexOf(layer);
    if (index >= 0) doc.activeLayer = index;
    return true;
  }

  undo(): boolean {
    const entry = this.undoStack.pop();
    if (!entry) return false;
    if (entry.kind === 'cells') this.applyCells(entry, entry.before);
    else restore(this.doc(), entry.before);
    this.redoStack.push(entry);
    return true;
  }

  redo(): boolean {
    const entry = this.redoStack.pop();
    if (!entry) return false;
    if (entry.kind === 'cells') this.applyCells(entry, entry.after);
    else restore(this.doc(), entry.after);
    this.undoStack.push(entry);
    return true;
  }
}
