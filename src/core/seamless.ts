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
 * A floor square that repeats without seams, made from a shaped object such
 * as a dirt plot with rounded corners and an outline. A plot with a solid
 * middle as big as a square gives that middle, cut clear of the rim, with
 * its left and top edges woven, pixel by pixel, into what lies just past its
 * right and bottom edges, so the last column runs straight on into the
 * first. Anything smaller, such as a dirt pile, is pieced together from
 * blocks of the whole object instead. Null when the object has nowhere solid
 * enough to take from.
 */
export function seamlessFloor(
  rgba: Uint8ClampedArray,
  width: number,
  rect: AssetRect,
  tile: number,
): Uint8ClampedArray | null {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const need = tile + RIM * 2;
  let size = Math.min(rect.w, rect.h);
  let x0 = 0;
  let y0 = 0;
  for (; size >= need; size--) {
    x0 = Math.round(cx - size / 2);
    y0 = Math.round(cy - size / 2);
    if (solidSquare(rgba, width, x0, y0, size)) break;
  }
  if (size < need) return quiltFloor(rgba, width, rect, tile);

  const inner = size - RIM * 2;
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

/** Side of the blocks a small object's floor is pieced from. */
const BLOCK = 8;
/** The thin outline round a small object, never taken. */
const OUTLINE = 2;
/** Blocks tried for each place; the best fitting one is kept. */
const TRIES = 200;

/**
 * Pieces a floor square together from blocks lifted from anywhere solid in
 * the object, clear of its outline, so it keeps the object's own colours and
 * clumps rather than a pale scrap of its middle repeated. Each block is the
 * one, of a handful tried, whose edges best match the blocks already beside
 * it, counting round the square's edges too, so the square repeats as
 * smoothly as it reads inside.
 */
function quiltFloor(rgba: Uint8ClampedArray, width: number, rect: AssetRect, tile: number): Uint8ClampedArray | null {
  const across = tile / BLOCK;
  if (!Number.isInteger(across)) return null;
  const reach = BLOCK + OUTLINE * 2;
  const spots: number[] = [];
  for (let y = rect.y; y + reach <= rect.y + rect.h; y++) {
    for (let x = rect.x; x + reach <= rect.x + rect.w; x++) {
      if (solidSquare(rgba, width, x, y, reach)) spots.push((y + OUTLINE) * width + x + OUTLINE);
    }
  }
  if (spots.length === 0) return null;

  // The same object always gives the same square.
  let seed = (rect.x * 73856093) ^ (rect.y * 19349663) ^ (rect.w * 83492791);
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const diff = (a: number, b: number) =>
    Math.abs(rgba[a * 4] - rgba[b * 4]) + Math.abs(rgba[a * 4 + 1] - rgba[b * 4 + 1]) + Math.abs(rgba[a * 4 + 2] - rgba[b * 4 + 2]);
  // How badly a block's edge meets a neighbour's facing edge.
  const meet = (block: number, other: number | undefined, side: 'left' | 'right' | 'top' | 'bottom') => {
    if (other === undefined) return 0;
    let cost = 0;
    for (let k = 0; k < BLOCK; k++) {
      if (side === 'left') cost += diff(block + k * width, other + k * width + BLOCK - 1);
      else if (side === 'right') cost += diff(block + k * width + BLOCK - 1, other + k * width);
      else if (side === 'top') cost += diff(block + k, other + (BLOCK - 1) * width + k);
      else cost += diff(block + (BLOCK - 1) * width + k, other + k);
    }
    return cost;
  };

  const chosen: number[] = [];
  for (let by = 0; by < across; by++) {
    for (let bx = 0; bx < across; bx++) {
      const left = bx > 0 ? chosen[by * across + bx - 1] : undefined;
      const top = by > 0 ? chosen[(by - 1) * across + bx] : undefined;
      // The last column and row also meet the first, round the square's edge.
      const right = bx === across - 1 ? chosen[by * across] : undefined;
      const bottom = by === across - 1 ? chosen[bx] : undefined;
      let best = spots[0];
      let bestCost = Number.POSITIVE_INFINITY;
      for (let t = 0; t < TRIES; t++) {
        const spot = spots[Math.floor(random() * spots.length)];
        const cost =
          meet(spot, left, 'left') + meet(spot, top, 'top') + meet(spot, right, 'right') + meet(spot, bottom, 'bottom');
        if (cost < bestCost) {
          bestCost = cost;
          best = spot;
        }
      }
      chosen.push(best);
    }
  }
  // The blocks round the square's edge meet the far side as well, which the
  // first sweep could only half see; once every place is filled they are
  // chosen again against all four neighbours. The middle keeps its first
  // pick, which leaves the pile's clumps in rather than the smoothest blocks.
  const at = (bx: number, by: number) => chosen[((by + across) % across) * across + ((bx + across) % across)];
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < chosen.length; i++) {
      const bx = i % across;
      const by = Math.floor(i / across);
      if (bx > 0 && bx < across - 1 && by > 0 && by < across - 1) continue;
      const cost = (spot: number) =>
        meet(spot, at(bx - 1, by), 'left') +
        meet(spot, at(bx + 1, by), 'right') +
        meet(spot, at(bx, by - 1), 'top') +
        meet(spot, at(bx, by + 1), 'bottom');
      let bestCost = cost(chosen[i]);
      for (let t = 0; t < TRIES; t++) {
        const spot = spots[Math.floor(random() * spots.length)];
        const c = cost(spot);
        if (c < bestCost) {
          bestCost = c;
          chosen[i] = spot;
        }
      }
    }
  }

  const out = new Uint8ClampedArray(tile * tile * 4);
  chosen.forEach((spot, i) => {
    const ox = (i % across) * BLOCK;
    const oy = Math.floor(i / across) * BLOCK;
    for (let y = 0; y < BLOCK; y++) {
      for (let x = 0; x < BLOCK; x++) {
        const from = (spot + y * width + x) * 4;
        out.set(rgba.subarray(from, from + 4), ((oy + y) * tile + ox + x) * 4);
      }
    }
  });

  // A small pile reads as the colour of all of it, shaded rim included, and
  // its middle is paler than that; the floor takes the pile's overall colour.
  const whole = [0, 0, 0];
  let painted = 0;
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      const at = (y * width + x) * 4;
      if (rgba[at + 3] <= SOLID) continue;
      for (let c = 0; c < 3; c++) whole[c] += rgba[at + c];
      painted += 1;
    }
  }
  const floor = [0, 0, 0];
  for (let i = 0; i < tile * tile; i++) for (let c = 0; c < 3; c++) floor[c] += out[i * 4 + c];
  const scale = floor.map((sum, c) => (sum > 0 ? whole[c] / painted / (sum / (tile * tile)) : 1));
  for (let i = 0; i < tile * tile; i++) for (let c = 0; c < 3; c++) out[i * 4 + c] = Math.round(out[i * 4 + c] * scale[c]);
  return out;
}
