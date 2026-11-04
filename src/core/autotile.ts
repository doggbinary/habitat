import type { Doc, TileLayer, Tileset } from './doc';
import { EMPTY, indexOf, pack, tilesetOf, type PackedTile } from './tiles';

/**
 * Autotiles: terrain whose every square is assembled from quarter-tile
 * pieces of one source block, chosen by which neighbours are the same
 * terrain. This is the RPG Maker MV/MZ scheme, taken from its published
 * tables rather than guessed: a floor block is 2 x 3 cells (4 x 6 quarters),
 * a wall or roof block is 2 x 2 cells (4 x 4 quarters).
 *
 * Quarter coordinates below are [column, row] in half-cell units inside
 * the source block, listed top-left, top-right, bottom-left, bottom-right.
 */
export type Quarter = [number, number];
export type ShapePieces = [Quarter, Quarter, Quarter, Quarter];

/** The 48 floor shapes. 0-46 follow from the neighbours; 47 is the block's preview cell. */
export const FLOOR_AUTOTILE_TABLE: ShapePieces[] = [
  [[2, 4], [1, 4], [2, 3], [1, 3]], [[2, 0], [1, 4], [2, 3], [1, 3]],
  [[2, 4], [3, 0], [2, 3], [1, 3]], [[2, 0], [3, 0], [2, 3], [1, 3]],
  [[2, 4], [1, 4], [2, 1], [1, 3]], [[2, 0], [1, 4], [2, 1], [1, 3]],
  [[2, 4], [3, 0], [2, 1], [1, 3]], [[2, 0], [3, 0], [2, 1], [1, 3]],
  [[2, 4], [1, 4], [2, 3], [3, 1]], [[2, 0], [1, 4], [2, 3], [3, 1]],
  [[2, 4], [3, 0], [2, 3], [3, 1]], [[2, 0], [3, 0], [2, 3], [3, 1]],
  [[2, 4], [1, 4], [2, 1], [3, 1]], [[2, 0], [1, 4], [2, 1], [3, 1]],
  [[2, 4], [3, 0], [2, 1], [3, 1]], [[2, 0], [3, 0], [2, 1], [3, 1]],
  [[0, 4], [1, 4], [0, 3], [1, 3]], [[0, 4], [3, 0], [0, 3], [1, 3]],
  [[0, 4], [1, 4], [0, 3], [3, 1]], [[0, 4], [3, 0], [0, 3], [3, 1]],
  [[2, 2], [1, 2], [2, 3], [1, 3]], [[2, 2], [1, 2], [2, 3], [3, 1]],
  [[2, 2], [1, 2], [2, 1], [1, 3]], [[2, 2], [1, 2], [2, 1], [3, 1]],
  [[2, 4], [3, 4], [2, 3], [3, 3]], [[2, 4], [3, 4], [2, 1], [3, 3]],
  [[2, 0], [3, 4], [2, 3], [3, 3]], [[2, 0], [3, 4], [2, 1], [3, 3]],
  [[2, 4], [1, 4], [2, 5], [1, 5]], [[2, 0], [1, 4], [2, 5], [1, 5]],
  [[2, 4], [3, 0], [2, 5], [1, 5]], [[2, 0], [3, 0], [2, 5], [1, 5]],
  [[0, 4], [3, 4], [0, 3], [3, 3]], [[2, 2], [1, 2], [2, 5], [1, 5]],
  [[0, 2], [1, 2], [0, 3], [1, 3]], [[0, 2], [1, 2], [0, 3], [3, 1]],
  [[2, 2], [3, 2], [2, 3], [3, 3]], [[2, 2], [3, 2], [2, 1], [3, 3]],
  [[2, 4], [3, 4], [2, 5], [3, 5]], [[2, 0], [3, 4], [2, 5], [3, 5]],
  [[0, 4], [1, 4], [0, 5], [1, 5]], [[0, 4], [3, 0], [0, 5], [1, 5]],
  [[0, 2], [3, 2], [0, 3], [3, 3]], [[0, 2], [1, 2], [0, 5], [1, 5]],
  [[0, 4], [3, 4], [0, 5], [3, 5]], [[2, 2], [3, 2], [2, 5], [3, 5]],
  [[0, 2], [3, 2], [0, 5], [3, 5]], [[0, 0], [1, 0], [0, 1], [1, 1]],
];

/** The 16 wall and roof shapes, by which of the four sides are open. */
export const WALL_AUTOTILE_TABLE: ShapePieces[] = [
  [[2, 2], [1, 2], [2, 1], [1, 1]], [[0, 2], [1, 2], [0, 1], [1, 1]],
  [[2, 0], [1, 0], [2, 1], [1, 1]], [[0, 0], [1, 0], [0, 1], [1, 1]],
  [[2, 2], [3, 2], [2, 1], [3, 1]], [[0, 2], [3, 2], [0, 1], [3, 1]],
  [[2, 0], [3, 0], [2, 1], [3, 1]], [[0, 0], [3, 0], [0, 1], [3, 1]],
  [[2, 2], [1, 2], [2, 3], [1, 3]], [[0, 2], [1, 2], [0, 3], [1, 3]],
  [[2, 0], [1, 0], [2, 3], [1, 3]], [[0, 0], [1, 0], [0, 3], [1, 3]],
  [[2, 2], [3, 2], [2, 3], [3, 3]], [[0, 2], [3, 2], [0, 3], [3, 3]],
  [[2, 0], [3, 0], [2, 3], [3, 3]], [[0, 0], [3, 0], [0, 3], [3, 3]],
];

/** The preview cell of a floor block: shown in the library, never chosen by neighbours. */
export const FLOOR_PREVIEW = 47;
/** A wall or roof standing alone. */
export const WALL_ALONE = 15;
/** Columns per material on an expanded autotile sheet: one per floor shape. */
export const SHAPE_STRIDE = 48;

/** Neighbour bits, clockwise from north. */
export const N = 1;
export const NE = 2;
export const E = 4;
export const SE = 8;
export const S = 16;
export const SW = 32;
export const W = 64;
export const NW = 128;

/**
 * The floor shape for a set of same-terrain neighbours. Sides decide edges;
 * a missing diagonal only matters (as an inner corner) when both sides next
 * to it are present.
 */
export function floorShape(mask: number): number {
  const n = !!(mask & N);
  const e = !!(mask & E);
  const s = !!(mask & S);
  const w = !!(mask & W);
  const tl = n && w && !(mask & NW);
  const tr = n && e && !(mask & NE);
  const bl = s && w && !(mask & SW);
  const br = s && e && !(mask & SE);
  const open = (n ? 0 : 1) + (e ? 0 : 1) + (s ? 0 : 1) + (w ? 0 : 1);
  const b = (v: boolean, bit: number) => (v ? bit : 0);
  if (open === 0) return b(tl, 1) | b(tr, 2) | b(bl, 4) | b(br, 8);
  if (open === 1) {
    if (!w) return 16 + b(tr, 1) + b(br, 2);
    if (!n) return 20 + b(br, 1) + b(bl, 2);
    if (!e) return 24 + b(bl, 1) + b(tl, 2);
    return 28 + b(tl, 1) + b(tr, 2);
  }
  if (open === 2) {
    if (!w && !e) return 32;
    if (!n && !s) return 33;
    if (!n && !w) return 34 + b(br, 1);
    if (!n && !e) return 36 + b(bl, 1);
    if (!s && !e) return 38 + b(tl, 1);
    return 40 + b(tr, 1);
  }
  if (open === 3) {
    if (s) return 42;
    if (e) return 43;
    if (n) return 44;
    return 45;
  }
  return 46;
}

/** The wall shape: 1 left open, 2 top open, 4 right open, 8 bottom open. */
export function wallShape(mask: number): number {
  return (mask & W ? 0 : 1) | (mask & N ? 0 : 2) | (mask & E ? 0 : 4) | (mask & S ? 0 : 8);
}

/** Straight RGBA pixels, enough for composing without a canvas. */
export interface Pixels {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/**
 * Assembles one finished cell from four quarters of a source block, copying
 * pixels exactly. `block` is the block's top-left corner on the source.
 */
export function composeShape(source: Pixels, block: { x: number; y: number }, cell: number, pieces: ShapePieces): Pixels {
  const half = cell / 2;
  const out: Pixels = { width: cell, height: cell, data: new Uint8ClampedArray(cell * cell * 4) };
  pieces.forEach(([qx, qy], k) => {
    const dx = (k % 2) * half;
    const dy = Math.floor(k / 2) * half;
    for (let y = 0; y < half; y++) {
      const sy = block.y + qy * half + y;
      const from = (sy * source.width + block.x + qx * half) * 4;
      out.data.set(source.data.subarray(from, from + half * 4), ((dy + y) * cell + dx) * 4);
    }
  });
  return out;
}

// --- Painting --------------------------------------------------------------

export type TerrainKind = 'floor' | 'wall';

/** What the editor needs to know about one material on an expanded autotile sheet. */
export interface AutotileMaterialInfo {
  name: string;
  kind: TerrainKind;
}

/** The material a painted tile belongs to, or null when it is not an autotile. */
export function terrainOf(doc: Doc, tile: PackedTile): { sheet: number; row: number; kind: TerrainKind } | null {
  if (tile === EMPTY) return null;
  const sheet = tilesetOf(tile);
  const tileset: Tileset | undefined = doc.tilesets[sheet];
  const materials = tileset?.autotile?.materials;
  if (!tileset?.pathStride || !materials) return null;
  const row = Math.floor(indexOf(tile) / tileset.pathStride);
  const material = materials[row];
  return material ? { sheet, row, kind: material.kind } : null;
}

/** Whether two tiles are the same terrain, or the same tile when neither is terrain. */
export function sameTerrain(doc: Doc, a: PackedTile, b: PackedTile): boolean {
  const ta = terrainOf(doc, a);
  const tb = terrainOf(doc, b);
  if (!ta || !tb) return a === b;
  return ta.sheet === tb.sheet && ta.row === tb.row;
}

/**
 * The tile a cell should show given its neighbours, or null when the cell
 * is not terrain. Off the map counts as the same terrain, so a floor
 * painted to the map's edge runs off it without a border, as in RPG Maker.
 */
export function shapedTile(doc: Doc, layer: TileLayer, x: number, y: number): PackedTile | null {
  if (x < 0 || y < 0 || x >= doc.width || y >= doc.height) return null;
  const tile = layer.data[y * doc.width + x];
  const terrain = terrainOf(doc, tile);
  if (!terrain) return null;
  const same = (dx: number, dy: number) => {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= doc.width || ny >= doc.height) return true;
    const other = terrainOf(doc, layer.data[ny * doc.width + nx]);
    return !!other && other.sheet === terrain.sheet && other.row === terrain.row;
  };
  const mask =
    (same(0, -1) ? N : 0) |
    (same(1, -1) ? NE : 0) |
    (same(1, 0) ? E : 0) |
    (same(1, 1) ? SE : 0) |
    (same(0, 1) ? S : 0) |
    (same(-1, 1) ? SW : 0) |
    (same(-1, 0) ? W : 0) |
    (same(-1, -1) ? NW : 0);
  const shape = terrain.kind === 'floor' ? floorShape(mask) : wallShape(mask);
  const stride = doc.tilesets[terrain.sheet].pathStride!;
  return pack(terrain.sheet, terrain.row * stride + shape);
}
