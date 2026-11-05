import { MAX_MAP_SIZE, MIN_MAP_SIZE, mapOrigin, type Doc } from '../core/doc';
import type { Camera } from '../core/store';

/** An edge or corner of the map. */
export type MapHandle = 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se';

const HANDLES: MapHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/**
 * How many squares a dragged edge becomes.
 * Snap lands on the nearest whole square. Even keeps both sides an even count.
 * With snap off, the count is however many whole squares the finger has crossed.
 */
export function quantizeSquares(raw: number, snap: boolean, even: boolean): number {
  if (!Number.isFinite(raw)) return even ? 2 : MIN_MAP_SIZE;
  let n = snap ? Math.round(raw) : Math.floor(raw);
  n = Math.max(MIN_MAP_SIZE, Math.min(MAX_MAP_SIZE, n));
  if (!even) return n;
  n -= n % 2;
  if (n < 2) n = 2;
  if (n > MAX_MAP_SIZE) n = MAX_MAP_SIZE - (MAX_MAP_SIZE % 2);
  return n;
}

export interface ResizePlan {
  w: number;
  h: number;
  /** Columns inserted on the left. Negative when the left edge moves right. */
  shiftX: number;
  /** Rows inserted on the top. */
  shiftY: number;
}

/**
 * The size to give the map so the dragged edge follows the pointer.
 * The opposite edge stays put, which is what keeps existing squares in place.
 */
export function resizePlan(
  start: { w: number; h: number; originCol: number; originRow: number },
  handle: MapHandle,
  world: { x: number; y: number },
  tile: number,
  snap: boolean,
  even: boolean,
): ResizePlan {
  const left = start.originCol * tile;
  const top = start.originRow * tile;
  const right = left + start.w * tile;
  const bottom = top + start.h * tile;
  let w = start.w;
  let h = start.h;
  let shiftX = 0;
  let shiftY = 0;
  if (handle.includes('e')) w = quantizeSquares((world.x - left) / tile, snap, even);
  if (handle.includes('w')) {
    w = quantizeSquares((right - world.x) / tile, snap, even);
    shiftX = w - start.w;
  }
  if (handle.includes('s')) h = quantizeSquares((world.y - top) / tile, snap, even);
  if (handle.includes('n')) {
    h = quantizeSquares((bottom - world.y) / tile, snap, even);
    shiftY = h - start.h;
  }
  return { w, h, shiftX, shiftY };
}

/** Screen position of every handle, in CSS pixels. */
export function mapHandlePoints(doc: Doc, camera: Camera): { handle: MapHandle; x: number; y: number }[] {
  const origin = mapOrigin(doc);
  const left = (origin.x - camera.x) * camera.zoom;
  const top = (origin.y - camera.y) * camera.zoom;
  const right = left + doc.width * doc.tileSize * camera.zoom;
  const bottom = top + doc.height * doc.tileSize * camera.zoom;
  const mx = (left + right) / 2;
  const my = (top + bottom) / 2;
  const at: Record<MapHandle, { x: number; y: number }> = {
    nw: { x: left, y: top },
    n: { x: mx, y: top },
    ne: { x: right, y: top },
    e: { x: right, y: my },
    se: { x: right, y: bottom },
    s: { x: mx, y: bottom },
    sw: { x: left, y: bottom },
    w: { x: left, y: my },
  };
  return HANDLES.map((handle) => ({ handle, ...at[handle] }));
}

/** The handle under a fingertip, or null. Corners win when a finger could mean either. */
export function hitMapHandle(x: number, y: number, doc: Doc, camera: Camera, radius = 28): MapHandle | null {
  let best: MapHandle | null = null;
  let bestD = radius;
  for (const point of mapHandlePoints(doc, camera)) {
    const d = Math.hypot(x - point.x, y - point.y);
    const corner = point.handle.length === 2;
    // A corner is the more specific target, so it wins a tie with an edge.
    if (d < bestD || (d === bestD && corner)) {
      best = point.handle;
      bestD = d;
    }
  }
  return best;
}
