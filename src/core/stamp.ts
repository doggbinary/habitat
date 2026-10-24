import { EMPTY, flagsOf, flipFlagsH, flipFlagsV, pack, rotateFlagsCW, tilesetOf, indexOf, type PackedTile } from './tiles';

/**
 * The brush payload: a rectangular block of tiles picked from the palette.
 * A single selected tile is just a 1x1 stamp, so every tool can treat the
 * brush uniformly.
 */
export interface Stamp {
  w: number;
  h: number;
  tiles: Int32Array;
}

export const EMPTY_STAMP: Stamp = { w: 0, h: 0, tiles: new Int32Array(0) };

export function singleStamp(tilesetIndex: number, tileIndex: number): Stamp {
  return { w: 1, h: 1, tiles: Int32Array.of(pack(tilesetIndex, tileIndex)) };
}

export function stampFromRegion(
  tilesetIndex: number,
  cols: number,
  x0: number,
  y0: number,
  w: number,
  h: number,
  count: number,
): Stamp {
  const tiles = new Int32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const index = (y0 + y) * cols + (x0 + x);
      tiles[y * w + x] = index < count ? pack(tilesetIndex, index) : EMPTY;
    }
  }
  return { w, h, tiles };
}

export function isEmptyStamp(stamp: Stamp): boolean {
  return stamp.w === 0 || stamp.h === 0;
}

function retag(tile: PackedTile, flags: number): PackedTile {
  return tile === EMPTY ? EMPTY : pack(tilesetOf(tile), indexOf(tile), flags);
}

export function flipStampH(stamp: Stamp): Stamp {
  const tiles = new Int32Array(stamp.w * stamp.h);
  for (let y = 0; y < stamp.h; y++) {
    for (let x = 0; x < stamp.w; x++) {
      const src = stamp.tiles[y * stamp.w + (stamp.w - 1 - x)];
      tiles[y * stamp.w + x] = retag(src, flipFlagsH(flagsOf(src)));
    }
  }
  return { w: stamp.w, h: stamp.h, tiles };
}

export function flipStampV(stamp: Stamp): Stamp {
  const tiles = new Int32Array(stamp.w * stamp.h);
  for (let y = 0; y < stamp.h; y++) {
    for (let x = 0; x < stamp.w; x++) {
      const src = stamp.tiles[(stamp.h - 1 - y) * stamp.w + x];
      tiles[y * stamp.w + x] = retag(src, flipFlagsV(flagsOf(src)));
    }
  }
  return { w: stamp.w, h: stamp.h, tiles };
}

/** Rotates the block clockwise, so the stamp's width and height swap. */
export function rotateStampCW(stamp: Stamp): Stamp {
  const w = stamp.h;
  const h = stamp.w;
  const tiles = new Int32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const src = stamp.tiles[(stamp.h - 1 - x) * stamp.w + y];
      tiles[y * w + x] = retag(src, rotateFlagsCW(flagsOf(src)));
    }
  }
  return { w, h, tiles };
}

/**
 * Tile of the stamp that belongs at an offset from the pattern origin,
 * repeating the block. Used when filling a region larger than the stamp.
 */
export function stampTileAt(stamp: Stamp, dx: number, dy: number): PackedTile {
  if (isEmptyStamp(stamp)) return EMPTY;
  const x = ((dx % stamp.w) + stamp.w) % stamp.w;
  const y = ((dy % stamp.h) + stamp.h) % stamp.h;
  return stamp.tiles[y * stamp.w + x];
}

/** Picks one tile at random, used by the scatter brush. */
export function randomTile(stamp: Stamp): PackedTile {
  if (isEmptyStamp(stamp)) return EMPTY;
  const filled: PackedTile[] = [];
  for (let i = 0; i < stamp.tiles.length; i++) {
    if (stamp.tiles[i] !== EMPTY) filled.push(stamp.tiles[i]);
  }
  if (filled.length === 0) return EMPTY;
  return filled[(Math.random() * filled.length) | 0];
}
