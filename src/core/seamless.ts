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

/** The smallest piece of texture worth repeating. */
const MIN_PIECE = 12;

/**
 * A floor square that repeats without seams, made from the middle of a
 * shaped object such as a dirt plot with rounded corners and an outline.
 * The middle is cut out clear of the rim, and the piece's left and top
 * edges are woven, pixel by pixel, into what lies just past its right and
 * bottom edges, so the last column runs straight on into the first. An
 * object too small to hold a whole square, such as a dirt pile, gives a
 * half, third or quarter square, repeated to fill it.
 * Null when the object has no solid middle at all.
 */
export function seamlessFloor(
  rgba: Uint8ClampedArray,
  width: number,
  rect: AssetRect,
  tile: number,
): Uint8ClampedArray | null {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const smallest = MIN_PIECE + Math.ceil(MIN_PIECE / 4) + RIM * 2;
  let size = Math.min(rect.w, rect.h);
  let x0 = 0;
  let y0 = 0;
  for (; size >= smallest; size--) {
    x0 = Math.round(cx - size / 2);
    y0 = Math.round(cy - size / 2);
    if (solidSquare(rgba, width, x0, y0, size)) break;
  }
  const inner = size - RIM * 2;
  // The biggest whole fraction of a square that fits with room to weave its edges.
  const piece = [1, 2, 3, 4]
    .map((n) => tile / n)
    .find((p) => Number.isInteger(p) && p >= MIN_PIECE && inner - p >= Math.min(BLEND, Math.ceil(p / 4)));
  if (piece === undefined) return null;

  const blend = Math.min(BLEND, inner - piece);
  const ox = x0 + RIM + Math.floor((inner - piece - blend) / 2);
  const oy = y0 + RIM + Math.floor((inner - piece - blend) / 2);
  const out = new Uint8ClampedArray(tile * tile * 4);
  for (let y = 0; y < tile; y++) {
    for (let x = 0; x < tile; x++) {
      const px = x % piece;
      const py = y % piece;
      const sx = px < blend && BAYER[(py % 4) * 4 + (px % 4)] >= px / blend ? px + piece : px;
      const sy = py < blend && BAYER[(px % 4) * 4 + (py % 4)] >= py / blend ? py + piece : py;
      const from = ((oy + sy) * width + ox + sx) * 4;
      out.set(rgba.subarray(from, from + 4), (y * tile + x) * 4);
    }
  }
  return out;
}
