import { createDoc, type AssetRect, type Doc } from './doc';
import { History } from './history';
import { EMPTY_STAMP, type Stamp } from './stamp';

export type ToolId = 'brush' | 'eraser' | 'fill' | 'rect' | 'line' | 'picker' | 'pan' | 'select';

/**
 * A block of painted tiles picked up off the map with the select tool.
 *
 * Its source cells are cleared when it is lifted, so what you see is the
 * truth: setting it down writes exactly what is drawn floating.
 */
export interface MapSelection {
  /** Current top-left position in tiles. */
  x: number;
  y: number;
  w: number;
  h: number;
  tiles: Int32Array;
  /** Layer the block came from, and will be set down on. */
  layerId: string;
  /** A duplicate, not lifted off the map, so dropping it loses nothing. */
  copy?: boolean;
}

/**
 * The geometry a stroke lays down. The eraser reuses these shapes rather than
 * being freehand-only, so erasing a rectangle does not mean scrubbing by hand.
 */
export type Shape = 'brush' | 'rect' | 'line' | 'fill';

export interface Camera {
  /** World pixel at the top-left of the viewport. */
  x: number;
  y: number;
  zoom: number;
}

export interface Settings {
  showGrid: boolean;
  /** Dim everything outside the active layer so it is easy to see what you edit. */
  highlightActiveLayer: boolean;
  /** Scatter mode: pick a random tile from the stamp per cell. */
  randomize: boolean;
  /** Continue painting a drag past the tile where it started. */
  snapToStamp: boolean;
  showTileOutlines: boolean;
  /** Round a dragged reference image onto the tile grid when you let go. */
  snapImageToGrid: boolean;
  /** Pink lines, and a gentle pull, when a moved asset lines up with another. */
  alignGuides: boolean;
  /** Squares across that the brush and eraser paint. A single tile repeats to fill them. */
  brushSize: number;
}

/** `view` covers anything that only moves the viewport or the hovered cell. */
/** `library`: asset pages were added or redone; only the asset list cares. */
type EventName = 'doc' | 'structure' | 'ui' | 'view' | 'toast' | 'library';

type Listener = (payload?: unknown) => void;

export class Store {
  doc: Doc = createDoc();
  readonly history = new History(() => this.doc);

  tool: ToolId = 'brush';
  previousTool: ToolId = 'brush';
  /** Geometry used while the eraser is the active tool. */
  eraserShape: Shape = 'brush';
  stamp: Stamp = EMPTY_STAMP;
  activeTileset = 0;
  /** Palette selection rect, kept so the UI can draw the marquee. */
  paletteSelection: { x: number; y: number; w: number; h: number } | null = null;

  camera: Camera = { x: 0, y: 0, zoom: 1 };

  settings: Settings = {
    showGrid: true,
    highlightActiveLayer: false,
    randomize: false,
    snapToStamp: false,
    showTileOutlines: false,
    snapImageToGrid: false,
    alignGuides: true,
    brushSize: 1,
  };

  /** Lines showing while an asset is being dragged into line with another. */
  alignLines: { vertical: number[]; horizontal: number[] } | null = null;

  /**
   * A character dropped onto the map purely to judge scale. It is never part
   * of the document, so it is not saved and never exported.
   */
  characterPreview = {
    enabled: false,
    /** While true, tapping the map relocates the character instead of painting. */
    placing: false,
    /** Tile the character stands on. */
    tx: 0,
    ty: 0,
    animate: true,
  };

  /** Cell under the pointer, or null when the pointer is away from the map. */
  hover: { x: number; y: number } | null = null;
  /** Live preview rect for the rectangle and line tools. */
  preview: { x0: number; y0: number; x1: number; y1: number } | null = null;
  /** The placed asset whose options are showing. */
  selectedObject: { layerId: string; objectId: string } | null = null;
  /** Every asset in the current selection, including `selectedObject`. */
  selectedGroup: { layerId: string; objectId: string }[] = [];
  /** While on, tapping an asset adds it to the selection or takes it out. */
  addingToSelection = false;
  /** The library asset being dragged onto the map, and where it would land. */
  drag: {
    tilesetId: string;
    rect: AssetRect;
    /** World position under the finger, or null while off the map. */
    world: { x: number; y: number } | null;
  } | null = null;
  /** The asset picked in the library, used to paint ground with the brush. */
  libraryPick: { tilesetId: string; index: number } | null = null;
  /** Painted tiles currently held up with the select tool. */
  selection: MapSelection | null = null;

  private readonly listeners = new Map<EventName, Set<Listener>>();

  on(event: EventName, listener: Listener): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return () => set!.delete(listener);
  }

  emit(event: EventName, payload?: unknown): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of [...set]) listener(payload);
  }

  /** Tiles changed: repaint the canvas and refresh undo buttons. */
  changed(): void {
    this.emit('doc');
    this.emit('ui');
  }

  /** Layers, tilesets or map dimensions changed: panels need a rebuild too. */
  restructured(): void {
    this.emit('structure');
    this.emit('doc');
    this.emit('ui');
  }

  setTool(tool: ToolId): void {
    if (this.tool === tool) return;
    if (this.tool !== 'pan') this.previousTool = this.tool;
    this.tool = tool;
    this.preview = null;
    this.emit('ui');
  }

  setStamp(stamp: Stamp, selection: Store['paletteSelection'] = null): void {
    this.stamp = stamp;
    this.paletteSelection = selection;
    this.emit('ui');
    this.emit('doc');
  }

  toast(message: string): void {
    this.emit('toast', message);
  }
}
