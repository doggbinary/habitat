/** A rectangle in map pixels. Edges are the art, not a padded square. */
export interface GuideBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface GuideLabel {
  x: number;
  y: number;
  text: string;
}

export interface GuideResult {
  /** How far to move the box so close edges meet. Zero when snapping is off. */
  dx: number;
  dy: number;
  vertical: number[];
  horizontal: number[];
  labels: GuideLabel[];
}

/** An edge this close to another, in map pixels, snaps so the two touch. */
export const GUIDE_SNAP = 8;

interface Edge {
  at: number;
  delta: number;
  line: number;
}

/**
 * Canva-style guides for one box being dragged.
 *
 * Edges and centres snap to nearby objects and to the map when they come
 * within a few pixels, so a fridge set beside an oven lands flush. Alignment
 * lines and the pixel gap to each neighbour are reported either way. Pass
 * `snap` false (a held modifier, or Magnet off) to show the lines without moving.
 */
export function smartGuides(
  box: GuideBox,
  others: GuideBox[],
  mapW: number,
  mapH: number,
  snap: boolean,
  threshold = GUIDE_SNAP,
  originX = 0,
  originY = 0,
): GuideResult {
  const targetsX = [originX, originX + mapW / 2, originX + mapW];
  const targetsY = [originY, originY + mapH / 2, originY + mapH];
  for (const other of others) {
    targetsX.push(other.left, (other.left + other.right) / 2, other.right);
    targetsY.push(other.top, (other.top + other.bottom) / 2, other.bottom);
  }
  const x = bestEdge([box.left, (box.left + box.right) / 2, box.right], targetsX, threshold);
  const y = bestEdge([box.top, (box.top + box.bottom) / 2, box.bottom], targetsY, threshold);
  const dx = snap && x ? x.delta : 0;
  const dy = snap && y ? y.delta : 0;
  const moved = shift(box, dx, dy);
  return {
    dx,
    dy,
    vertical: x && Math.abs(x.delta) <= threshold ? [x.line] : [],
    horizontal: y && Math.abs(y.delta) <= threshold ? [y.line] : [],
    labels: gapLabels(moved, others),
  };
}

/**
 * While resizing from the top-left, only the right and bottom edges move.
 * The closer one snaps, and the other follows so the picture stays proportional.
 * Returns the snapped width and height, or null when nothing is close.
 */
export function resizeSnap(
  box: GuideBox,
  others: GuideBox[],
  mapW: number,
  mapH: number,
  threshold = GUIDE_SNAP,
): { width: number; height: number; vertical: number[]; horizontal: number[] } | null {
  const width = box.right - box.left;
  const height = box.bottom - box.top;
  if (width <= 0 || height <= 0) return null;
  const targetsX = [0, mapW];
  const targetsY = [0, mapH];
  for (const other of others) {
    targetsX.push(other.left, other.right);
    targetsY.push(other.top, other.bottom);
  }
  let bestX: Edge | null = null;
  let bestY: Edge | null = null;
  for (const at of targetsX) {
    const delta = at - box.right;
    if (Math.abs(delta) <= threshold && (!bestX || Math.abs(delta) < Math.abs(bestX.delta))) bestX = { at, delta, line: at };
  }
  for (const at of targetsY) {
    const delta = at - box.bottom;
    if (Math.abs(delta) <= threshold && (!bestY || Math.abs(delta) < Math.abs(bestY.delta))) bestY = { at, delta, line: at };
  }
  const useX = bestX && (!bestY || Math.abs(bestX.delta) <= Math.abs(bestY.delta));
  if (useX && bestX) {
    const factor = (width + bestX.delta) / width;
    return { width: width + bestX.delta, height: height * factor, vertical: [bestX.line], horizontal: [] };
  }
  if (bestY) {
    const factor = (height + bestY.delta) / height;
    return { width: width * factor, height: height + bestY.delta, vertical: [], horizontal: [bestY.line] };
  }
  return null;
}

function bestEdge(sources: number[], targets: number[], threshold: number): Edge | null {
  let best: Edge | null = null;
  for (const source of sources) {
    for (const at of targets) {
      const delta = at - source;
      if (Math.abs(delta) > threshold) continue;
      if (!best || Math.abs(delta) < Math.abs(best.delta)) best = { at, delta, line: at };
    }
  }
  return best;
}

function shift(box: GuideBox, dx: number, dy: number): GuideBox {
  return { left: box.left + dx, top: box.top + dy, right: box.right + dx, bottom: box.bottom + dy };
}

/** Pixel gaps to the nearest object on each side, when the two actually face each other. */
function gapLabels(box: GuideBox, others: GuideBox[]): GuideLabel[] {
  const labels: GuideLabel[] = [];
  const overlapsY = (other: GuideBox) => Math.min(box.bottom, other.bottom) - Math.max(box.top, other.top) > 0;
  const overlapsX = (other: GuideBox) => Math.min(box.right, other.right) - Math.max(box.left, other.left) > 0;
  let left: GuideBox | null = null;
  let right: GuideBox | null = null;
  let above: GuideBox | null = null;
  let below: GuideBox | null = null;
  for (const other of others) {
    if (overlapsY(other) && other.right <= box.left && (!left || other.right > left.right)) left = other;
    if (overlapsY(other) && other.left >= box.right && (!right || other.left < right.left)) right = other;
    if (overlapsX(other) && other.bottom <= box.top && (!above || other.bottom > above.bottom)) above = other;
    if (overlapsX(other) && other.top >= box.bottom && (!below || other.top < below.top)) below = other;
  }
  const midY = (other: GuideBox) => (Math.max(box.top, other.top) + Math.min(box.bottom, other.bottom)) / 2;
  const midX = (other: GuideBox) => (Math.max(box.left, other.left) + Math.min(box.right, other.right)) / 2;
  if (left) {
    const gap = Math.round(box.left - left.right);
    if (gap > 0) labels.push({ x: (left.right + box.left) / 2, y: midY(left), text: String(gap) });
  }
  if (right) {
    const gap = Math.round(right.left - box.right);
    if (gap > 0) labels.push({ x: (box.right + right.left) / 2, y: midY(right), text: String(gap) });
  }
  if (above) {
    const gap = Math.round(box.top - above.bottom);
    if (gap > 0) labels.push({ x: midX(above), y: (above.bottom + box.top) / 2, text: String(gap) });
  }
  if (below) {
    const gap = Math.round(below.top - box.bottom);
    if (gap > 0) labels.push({ x: midX(below), y: (box.bottom + below.top) / 2, text: String(gap) });
  }
  return labels;
}
