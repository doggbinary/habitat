/**
 * A placed tile is packed into a single int32 so map layers can live in
 * `Int32Array`s. Layout, low bit first:
 *
 *   bits  0-15  tile index inside its tileset   (0 - 65535)
 *   bits 16-23  tileset index in `doc.tilesets`  (0 - 255)
 *   bits 24-26  transform flags
 *
 * `EMPTY` is -1 so a zeroed array is never mistaken for "tile 0 of tileset 0".
 */

export const EMPTY = -1;

export const FLIP_H = 1 << 0;
export const FLIP_V = 1 << 1;
export const ROT_90 = 1 << 2;

export type PackedTile = number;

export function pack(tilesetIndex: number, tileIndex: number, flags = 0): PackedTile {
  return ((flags & 0b111) << 24) | ((tilesetIndex & 0xff) << 16) | (tileIndex & 0xffff);
}

export function tilesetOf(t: PackedTile): number {
  return (t >> 16) & 0xff;
}

export function indexOf(t: PackedTile): number {
  return t & 0xffff;
}

export function flagsOf(t: PackedTile): number {
  return (t >> 24) & 0b111;
}

export function withFlags(t: PackedTile, flags: number): PackedTile {
  return t === EMPTY ? EMPTY : pack(tilesetOf(t), indexOf(t), flags);
}

/** Two tiles are "the same brush" when they point at the same art, ignoring transform. */
export function sameArt(a: PackedTile, b: PackedTile): boolean {
  if (a === EMPTY || b === EMPTY) return a === b;
  return (a & 0x00ffffff) === (b & 0x00ffffff);
}

/**
 * Applies a horizontal flip to an already-transformed tile.
 *
 * Flags encode one of eight orientations (3 bits: H, V, and a 90 degree turn),
 * so flipping is not simply toggling a bit once a rotation is in play - after a
 * quarter turn the horizontal and vertical axes have traded places.
 */
export function flipFlagsH(flags: number): number {
  return flags & ROT_90 ? flags ^ FLIP_V : flags ^ FLIP_H;
}

export function flipFlagsV(flags: number): number {
  return flags & ROT_90 ? flags ^ FLIP_H : flags ^ FLIP_V;
}

/**
 * Rotates by 90 degrees clockwise within the 8-orientation group.
 *
 * The renderer draws a tile as `rotate(ROT_90) * scale(FLIP_H, FLIP_V)`. Adding
 * another quarter turn to an already-rotated tile gives a half turn, which is
 * the same as mirroring both axes with no rotation left over.
 */
export function rotateFlagsCW(flags: number): number {
  if (!(flags & ROT_90)) return flags | ROT_90;
  return (flags & ~ROT_90) ^ (FLIP_H | FLIP_V);
}
