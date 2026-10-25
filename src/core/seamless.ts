import type { AssetRect } from './doc';

/** A pixel at least this opaque is painted. */
const SOLID = 24;
/** The outline and shading round a shaped object's edge are skipped by this much. */
const RIM = 6;
/** Width of the band where a square's opposite edges are woven into each other. */
const BLEND = 12;

/** 4 x 4 ordered dither thresholds, so the weave keeps the art's own pixels and colours. */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);

function solidSquare(rgba: Uint8ClampedArray, width: number, x0: number, y0: number, size: number): boolean {
  for (let y = y0; y < y0 + size; y++) {
    for (let x = x0; x < x0 + size; x++) if (rgba[(y * width + x) * 4 + 3] <= SOLID) return false;
  }
  return true;
}

/** Whether every pixel of a sheet rectangle is painted: art that already fills its squares. */
export function isSolid(rgba: Uint8ClampedArray, width: number, rect: AssetRect): boolean {
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) if (rgba[(y * width + x) * 4 + 3] <= SOLID) return false;
  }
  return true;
}

/**
 * A floor square that repeats without seams, made from the middle of a
 * shaped object such as a dirt plot with rounded corners and an outline.
 * The middle is cut out clear of the rim, and the square's left and top
 * edges are woven, pixel by pixel, into what lies just past its right and
 * bottom edges, so the last column runs straight on into the first.
 * Null when the object has no solid middle big enough for a square.
 */
export function seamlessFloor(
  rgba: Uint8ClampedArray,
  width: number,
  rect: AssetRect,
  tile: number,
): Uint8ClampedArray | null {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  let size = Math.min(rect.w, rect.h);
  let x0 = 0;
  let y0 = 0;
  for (; size >= tile; size--) {
    x0 = Math.round(cx - size / 2);
    y0 = Math.round(cy - size / 2);
    if (solidSquare(rgba, width, x0, y0, size)) break;
  }
  const inner = size - RIM * 2;
  if (inner < tile) return null;

  const blend = Math.min(BLEND, inner - tile);
  const ox = x0 + RIM + Math.floor((inner - tile - blend) / 2);
  const oy = y0 + RIM + Math.floor((inner - tile - blend) / 2);
  const out = new Uint8ClampedArray(tile * tile * 4);
  for (let y = 0; y < tile; y++) {
    for (let x = 0; x < tile; x++) {
      const sx = x < blend && BAYER[(y % 4) * 4 + (x % 4)] >= x / blend ? x + tile : x;
      const sy = y < blend && BAYER[(x % 4) * 4 + (y % 4)] >= y / blend ? y + tile : y;
      const from = ((oy + sy) * width + ox + sx) * 4;
      out.set(rgba.subarray(from, from + 4), (y * tile + x) * 4);
    }
  }
  return out;
}
