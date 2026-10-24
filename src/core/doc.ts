import { EMPTY, type PackedTile } from './tiles';

export interface Tileset {
  id: string;
  name: string;
  /** Data URL. Kept on the document so a project is self-contained. */
  src: string;
  tileW: number;
  tileH: number;
  margin: number;
  spacing: number;
  /** Decoded image. Rebuilt from `src` on load, never serialised. */
  image: HTMLImageElement | null;
  imgW: number;
  imgH: number;
  cols: number;
  rows: number;
  count: number;
}

interface LayerBase {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  opacity: number;
}

export interface TileLayer extends LayerBase {
  kind: 'tiles';
  /** Marks the layer as collision geometry in the exported JSON. */
  collider: boolean;
  /** `width * height` packed tiles in row-major order. */
  data: Int32Array;
}

/**
 * A reference image sitting in the layer stack. It holds no tiles: it is
 * something to trace over, so it is excluded from exported map data and can
 * be faded back with the usual layer opacity.
 */
export interface ImageLayer extends LayerBase {
  kind: 'image';
  /** Data URL, so the picture travels with the project. */
  src: string;
  image: HTMLImageElement | null;
  /** Placement rectangle in world pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Decoded size, kept so scaling can preserve the aspect ratio. */
  naturalW: number;
  naturalH: number;
}

export type Layer = TileLayer | ImageLayer;

export function isTileLayer(layer: Layer | null | undefined): layer is TileLayer {
  return !!layer && layer.kind === 'tiles';
}

export function isImageLayer(layer: Layer | null | undefined): layer is ImageLayer {
  return !!layer && layer.kind === 'image';
}

export interface Doc {
  name: string;
  width: number;
  height: number;
  tileSize: number;
  background: string;
  tilesets: Tileset[];
  layers: Layer[];
  /** Index into `layers`. Layer 0 renders at the bottom. */
  activeLayer: number;
}

export const MAX_MAP_SIZE = 512;
export const MIN_MAP_SIZE = 1;

let idCounter = 0;
export function uid(prefix = 'id'): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

export function createLayer(width: number, height: number, name: string): TileLayer {
  const data = new Int32Array(width * height);
  data.fill(EMPTY);
  return {
    kind: 'tiles',
    id: uid('layer'),
    name,
    visible: true,
    locked: false,
    opacity: 1,
    collider: false,
    data,
  };
}

export function createImageLayer(
  src: string,
  image: HTMLImageElement,
  name: string,
  placement: { x: number; y: number; w: number; h: number },
): ImageLayer {
  return {
    kind: 'image',
    id: uid('layer'),
    name,
    visible: true,
    locked: false,
    // Reference art reads better slightly faded, and it is what you want
    // almost immediately anyway once you start tracing.
    opacity: 0.6,
    src,
    image,
    naturalW: image.naturalWidth,
    naturalH: image.naturalHeight,
    ...placement,
  };
}

/**
 * Placement that covers the map while keeping the picture's aspect ratio, so
 * an imported mockup lines up with the grid as closely as it can.
 */
export function fitPlacement(
  doc: Doc,
  naturalW: number,
  naturalH: number,
): { x: number; y: number; w: number; h: number } {
  const mapW = doc.width * doc.tileSize;
  const mapH = doc.height * doc.tileSize;
  if (naturalW <= 0 || naturalH <= 0) return { x: 0, y: 0, w: mapW, h: mapH };
  const scale = Math.min(mapW / naturalW, mapH / naturalH);
  const w = naturalW * scale;
  const h = naturalH * scale;
  return { x: (mapW - w) / 2, y: (mapH - h) / 2, w, h };
}

export function createDoc(width = 32, height = 32, tileSize = 16): Doc {
  return {
    name: 'Untitled map',
    width,
    height,
    tileSize,
    background: '#1b1d24',
    tilesets: [],
    layers: [createLayer(width, height, 'Layer 1')],
    activeLayer: 0,
  };
}

export function cellIndex(doc: Doc, x: number, y: number): number {
  return y * doc.width + x;
}

export function inBounds(doc: Doc, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < doc.width && y < doc.height;
}

export function getTile(doc: Doc, layer: TileLayer, x: number, y: number): PackedTile {
  if (!inBounds(doc, x, y)) return EMPTY;
  return layer.data[cellIndex(doc, x, y)];
}

/**
 * Resizes the map, keeping existing tiles anchored at the top-left.
 * Returns new layer buffers rather than mutating, so history can snapshot.
 */
export function resizedLayerData(
  layer: TileLayer,
  oldW: number,
  oldH: number,
  newW: number,
  newH: number,
): Int32Array {
  const next = new Int32Array(newW * newH);
  next.fill(EMPTY);
  const copyW = Math.min(oldW, newW);
  const copyH = Math.min(oldH, newH);
  for (let y = 0; y < copyH; y++) {
    const from = y * oldW;
    next.set(layer.data.subarray(from, from + copyW), y * newW);
  }
  return next;
}

export function activeLayerOf(doc: Doc): Layer | null {
  return doc.layers[doc.activeLayer] ?? null;
}

/** True when the layer can currently accept tile edits. */
export function isEditable(layer: Layer | null): layer is TileLayer {
  return isTileLayer(layer) && !layer.locked && layer.visible;
}

/** True when a reference image is selected and free to be dragged. */
export function isMovableImage(layer: Layer | null): layer is ImageLayer {
  return isImageLayer(layer) && !layer.locked && layer.visible;
}

// --- Tileset helpers -------------------------------------------------------

export function sliceCount(ts: {
  imgW: number;
  imgH: number;
  tileW: number;
  tileH: number;
  margin: number;
  spacing: number;
}): { cols: number; rows: number; count: number } {
  const usableW = ts.imgW - ts.margin * 2 + ts.spacing;
  const usableH = ts.imgH - ts.margin * 2 + ts.spacing;
  const cols = Math.max(0, Math.floor(usableW / (ts.tileW + ts.spacing)));
  const rows = Math.max(0, Math.floor(usableH / (ts.tileH + ts.spacing)));
  return { cols, rows, count: cols * rows };
}

/** Pixel rect of one tile inside its tileset image. */
export function tileRect(ts: Tileset, index: number): { sx: number; sy: number } {
  const col = index % ts.cols;
  const row = Math.floor(index / ts.cols);
  return {
    sx: ts.margin + col * (ts.tileW + ts.spacing),
    sy: ts.margin + row * (ts.tileH + ts.spacing),
  };
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not decode image'));
    img.src = src;
  });
}

export async function makeTileset(
  src: string,
  name: string,
  tileW: number,
  tileH: number,
  margin = 0,
  spacing = 0,
): Promise<Tileset> {
  const image = await loadImage(src);
  const dims = { imgW: image.naturalWidth, imgH: image.naturalHeight, tileW, tileH, margin, spacing };
  const { cols, rows, count } = sliceCount(dims);
  return {
    id: uid('ts'),
    name,
    src,
    tileW,
    tileH,
    margin,
    spacing,
    image,
    imgW: image.naturalWidth,
    imgH: image.naturalHeight,
    cols,
    rows,
    count,
  };
}

/** Recomputes the slice grid after tileW/tileH/margin/spacing change. */
export function reslice(ts: Tileset): void {
  const { cols, rows, count } = sliceCount(ts);
  ts.cols = cols;
  ts.rows = rows;
  ts.count = count;
}
