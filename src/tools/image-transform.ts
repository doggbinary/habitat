import type { Doc, ImageLayer } from '../core/doc';
import type { Camera } from '../core/store';
import { worldToScreen } from '../render/camera';

/** Side of the square scale grip, in CSS pixels. Sized for a fingertip. */
export const HANDLE_SIZE = 30;

/** Never let a reference image collapse to nothing while being scaled. */
const MIN_SIDE = 8;

export interface ScreenRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function imageScreenRect(camera: Camera, layer: ImageLayer): ScreenRect {
  const topLeft = worldToScreen(camera, layer.x, layer.y);
  return { x: topLeft.x, y: topLeft.y, w: layer.w * camera.zoom, h: layer.h * camera.zoom };
}

/** Grip at the bottom-right corner, straddling the edge so it stays grabbable. */
export function handleScreenRect(camera: Camera, layer: ImageLayer): ScreenRect {
  const rect = imageScreenRect(camera, layer);
  return {
    x: rect.x + rect.w - HANDLE_SIZE / 2,
    y: rect.y + rect.h - HANDLE_SIZE / 2,
    w: HANDLE_SIZE,
    h: HANDLE_SIZE,
  };
}

export function hitsHandle(camera: Camera, layer: ImageLayer, sx: number, sy: number): boolean {
  const handle = handleScreenRect(camera, layer);
  return sx >= handle.x && sy >= handle.y && sx <= handle.x + handle.w && sy <= handle.y + handle.h;
}

/**
 * Uniform scale from the top-left corner, driven by where the grip was
 * dragged. The pointer is projected onto the rectangle's diagonal rather than
 * following one axis, which keeps the corner under the finger whichever way
 * the drag wanders.
 */
export function scaleFromHandle(
  start: { x: number; y: number; w: number; h: number },
  worldX: number,
  worldY: number,
): { w: number; h: number } {
  const dx = worldX - start.x;
  const dy = worldY - start.y;
  const denominator = start.w * start.w + start.h * start.h;
  if (denominator <= 0) return { w: start.w, h: start.h };
  const scale = (dx * start.w + dy * start.h) / denominator;
  const minScale = Math.max(MIN_SIDE / start.w, MIN_SIDE / start.h);
  const clamped = Math.max(minScale, scale);
  return { w: start.w * clamped, h: start.h * clamped };
}

/** Rounds a placement onto the tile grid, used by the snap toggle. */
export function snapPlacement(
  doc: Doc,
  placement: { x: number; y: number; w: number; h: number },
  includeSize: boolean,
): { x: number; y: number; w: number; h: number } {
  const size = doc.tileSize;
  const next = {
    x: Math.round(placement.x / size) * size,
    y: Math.round(placement.y / size) * size,
    w: placement.w,
    h: placement.h,
  };
  if (includeSize) {
    next.w = Math.max(size, Math.round(placement.w / size) * size);
    next.h = Math.max(size, Math.round(placement.h / size) * size);
  }
  return next;
}
