import type { AssetFolder, AssetRef } from '../ui/packs';
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
  /**
   * Decoded image. Rebuilt from `src` on load, never serialised. A canvas for
   * generated sheets, which grow as tiles are added to them.
   */
  image: HTMLImageElement | HTMLCanvasElement | null;
  imgW: number;
  imgH: number;
  cols: number;
  rows: number;
  count: number;
  /**
   * True for sheets the editor creates itself to hold edited tiles, such as a
   * single recoloured tree. Their slot count is authoritative rather than
   * derived from the image size, because the image grows ahead of use.
   */
  generated?: boolean;
  /**
   * How the sheet divides into draggable assets. `grid` cuts it into equal
   * tiles, which suits ground. `objects` finds each separate thing by where
   * the transparent background splits them, so a tree is one asset rather
   * than the six squares it happens to cover.
   */
  splitMode?: 'grid' | 'objects';
  /** Detected asset rectangles, used when `splitMode` is `objects`. */
  assets?: AssetRect[];
  /** Which detector produced `assets`, so an improved one can redo them. */
  assetsVersion?: number;
  /** Set once the user merges, splits or deletes assets by hand. */
  assetsEdited?: boolean;
  /**
   * A page of whole objects only, such as houses whose solid roofs would
   * otherwise read as floor squares. Nothing on it is split off as ground.
   */
  propsOnly?: boolean;
  /**
   * Places in `assets` that are a square of ground rather than a prop:
   * grass, water, brick, pavement. These are what the Ground page gathers.
   */
  groundAssets?: number[];
  /**
   * Rectangles of ground squares drawn to sit together, in sheet pixels.
   * Painting any of their squares continues the whole patch.
   */
  groundBlocks?: AssetRect[];
  /**
   * Set on expanded path sheets. Tile index `row * pathStride + role` is one
   * shape of that ground, so painting can swap in the piece that meets its
   * neighbours.
   */
  pathStride?: number;
}

/** A rectangle of a sheet image, in source pixels. */
export interface AssetRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * One placed asset. Unlike a tile it is not locked to the grid's size or
 * orientation: it can be scaled, turned, mirrored and recoloured on its own.
 */
export interface MapObject {
  id: string;
  /** Sheet the artwork comes from. By id, so removing other sheets is safe. */
  tilesetId: string;
  /** The artwork's rectangle within that sheet, captured at placement. */
  rect: AssetRect;
  /** Centre position in world pixels. */
  x: number;
  y: number;
  scale: number;
  /** Quarter turns clockwise, 0 to 3. Pixel art only stays crisp at 90 degrees. */
  rotation: number;
  flipX: boolean;
  flipY: boolean;
  /** Recolour, relative to the artwork as drawn. */
  hueShift: number;
  saturation: number;
  brightness: number;
  /** Spread of light and dark, 1 leaves it alone. Absent in older files. */
  contrast?: number;
  /** Sharpening between neighbouring pixels, 0 to 1. Absent in older files. */
  clarity?: number;
  /** Stops the character on the squares it covers, wherever it is moved or sized to. */
  blocks?: boolean;
  /** Where walking through this object's doorway leads, in world pixels. */
  door?: { x: number; y: number };
  /** When set, the asset stays where it was dropped until it is unlocked. */
  locked?: boolean;
  /** Assets that share an id move and select together. */
  groupId?: string;
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

/**
 * Free-placed assets. Order within `objects` is depth: later objects draw in
 * front, which is how "bring forward" and "send backward" work.
 */
export interface ObjectLayer extends LayerBase {
  kind: 'objects';
  objects: MapObject[];
}

export type Layer = TileLayer | ImageLayer | ObjectLayer;

export function isTileLayer(layer: Layer | null | undefined): layer is TileLayer {
  return !!layer && layer.kind === 'tiles';
}

export function isImageLayer(layer: Layer | null | undefined): layer is ImageLayer {
  return !!layer && layer.kind === 'image';
}

export function isObjectLayer(layer: Layer | null | undefined): layer is ObjectLayer {
  return !!layer && layer.kind === 'objects';
}

export function createObjectLayer(name = 'Objects'): ObjectLayer {
  return {
    kind: 'objects',
    id: uid('layer'),
    name,
    visible: true,
    locked: false,
    opacity: 1,
    objects: [],
  };
}

/** On-screen footprint of an object in world pixels, after turning and scaling. */
export function objectSize(obj: MapObject): { w: number; h: number } {
  const w = obj.rect.w * obj.scale;
  const h = obj.rect.h * obj.scale;
  return obj.rotation % 2 === 1 ? { w: h, h: w } : { w, h };
}

export interface Doc {
  name: string;
  width: number;
  height: number;
  tileSize: number;
  background: string;
  tilesets: Tileset[];
  /** Stickers kept on the Pinned page, at the top of the asset library. */
  pins: AssetRef[];
  /** Groups of stickers the user filed together. */
  folders: AssetFolder[];
  /** Library pages the user removed, so loading the library does not bring them back. */
  removedSheets: string[];
  /** Packs listed first in the pack list, in the order they were pinned. */
  pinnedPacks: string[];
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
  // A picture shaped like the map fills it edge to edge, so its squares land
  // on the grid lines rather than a few pixels off.
  if (Math.abs(naturalW / naturalH - mapW / mapH) < 0.02 * (mapW / mapH)) return exactPlacement(doc);
  const scale = Math.min(mapW / naturalW, mapH / naturalH);
  const w = naturalW * scale;
  const h = naturalH * scale;
  return { x: (mapW - w) / 2, y: (mapH - h) / 2, w, h };
}

/**
 * The size the asset library is drawn at. A map square this big shows that
 * art pixel for pixel; any other size has to shrink or stretch it.
 */
export const ART_TILE = 48;

/** Square size of the starter pack (Ninja Adventure), which new maps start on. */
export const STARTER_TILE = 16;

/**
 * Moves a map made with small squares onto the library's own square size.
 * Every painted cell stays where it is; placed assets and pictures are
 * scaled with the squares so the map looks the same, only sharper.
 * Returns false when the map is already at that size or cannot be scaled
 * by a whole number.
 */
export function upgradeTileSize(doc: Doc): boolean {
  if (doc.tileSize >= ART_TILE || ART_TILE % doc.tileSize !== 0) return false;
  if (!doc.tilesets.some((sheet) => !sheet.generated && sheet.tileW === ART_TILE)) return false;
  // A map whose own art is drawn on its square size, such as the starter
  // pack on 16 px, is already pixel for pixel.
  if (doc.tilesets.some((sheet) => !sheet.generated && sheet.tileW === doc.tileSize)) return false;
  const k = ART_TILE / doc.tileSize;
  doc.tileSize = ART_TILE;
  for (const layer of doc.layers) {
    if (layer.kind === 'objects') {
      for (const obj of layer.objects) {
        obj.x *= k;
        obj.y *= k;
        obj.scale *= k;
      }
    } else if (layer.kind === 'image') {
      layer.x *= k;
      layer.y *= k;
      layer.w *= k;
      layer.h *= k;
    }
  }
  return true;
}

/** Squares across a map made from a picture. Its height follows the picture. */
export const PICTURE_MAP_COLUMNS = 32;

/** Map size, in squares, for a picture so it fills the map without stretching. */
export function pictureMapSize(naturalW: number, naturalH: number): { width: number; height: number } {
  const width = PICTURE_MAP_COLUMNS;
  const height = naturalW > 0 ? Math.max(1, Math.round((width * naturalH) / naturalW)) : width;
  return { width, height };
}

/**
 * Placement that fills the map exactly, square edge to square edge. A picture
 * drawn on a grid of its own then has its squares on the map's grid lines.
 */
export function exactPlacement(doc: Doc): { x: number; y: number; w: number; h: number } {
  return { x: 0, y: 0, w: doc.width * doc.tileSize, h: doc.height * doc.tileSize };
}

export function createDoc(width = 32, height = 32, tileSize = ART_TILE): Doc {
  return {
    name: 'Untitled map',
    width,
    height,
    tileSize,
    background: '#1b1d24',
    tilesets: [],
    pins: [],
    folders: [],
    removedSheets: [],
    pinnedPacks: [],
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
