import type { Doc } from '../core/doc';
import type { Camera } from '../core/store';

export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 32;

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

export function screenToWorld(cam: Camera, sx: number, sy: number): { x: number; y: number } {
  return { x: sx / cam.zoom + cam.x, y: sy / cam.zoom + cam.y };
}

export function worldToScreen(cam: Camera, wx: number, wy: number): { x: number; y: number } {
  return { x: (wx - cam.x) * cam.zoom, y: (wy - cam.y) * cam.zoom };
}

/** Map cell under a viewport point. May be outside the map bounds. */
export function screenToCell(cam: Camera, doc: Doc, sx: number, sy: number): { x: number; y: number } {
  const world = screenToWorld(cam, sx, sy);
  return {
    x: Math.floor(world.x / doc.tileSize),
    y: Math.floor(world.y / doc.tileSize),
  };
}

/** Zooms around a fixed viewport point, so pinch and scroll keep that point still. */
export function zoomAt(cam: Camera, sx: number, sy: number, nextZoom: number): void {
  const zoom = clampZoom(nextZoom);
  const before = screenToWorld(cam, sx, sy);
  cam.zoom = zoom;
  const after = screenToWorld(cam, sx, sy);
  cam.x += before.x - after.x;
  cam.y += before.y - after.y;
}

/** Centres the map in the viewport at a zoom that leaves a small margin. */
export function fitToView(cam: Camera, doc: Doc, viewW: number, viewH: number, padding = 48): void {
  const mapW = doc.width * doc.tileSize;
  const mapH = doc.height * doc.tileSize;
  if (mapW <= 0 || mapH <= 0 || viewW <= 0 || viewH <= 0) return;
  const zoom = clampZoom(Math.min((viewW - padding * 2) / mapW, (viewH - padding * 2) / mapH));
  cam.zoom = zoom;
  cam.x = mapW / 2 - viewW / 2 / zoom;
  cam.y = mapH / 2 - viewH / 2 / zoom;
}
