import type { Doc } from '../core/doc';
import type { Camera } from '../core/store';

export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 32;

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** Device pixels per CSS pixel the canvas is drawn at. Capped like the renderer. */
export function viewPixelRatio(): number {
  const ratio = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  return Math.min(2, ratio);
}

/**
 * Whether one art pixel covers a whole number of screen pixels. Only then can
 * pixel art be drawn without smoothing and without rows coming out uneven.
 */
export function isCrispZoom(zoom: number, ratio = viewPixelRatio()): boolean {
  const device = zoom * ratio;
  return device >= 1 - 1e-6 && Math.abs(device - Math.round(device)) < 1e-3;
}

/** The nearest zoom at which art pixels land on whole screen pixels. */
export function snapZoom(zoom: number, ratio = viewPixelRatio()): number {
  const device = zoom * ratio;
  // Zoomed far out the whole picture is shrunk, so it is smoothed instead.
  if (device < 0.85) return clampZoom(zoom);
  return clampZoom(Math.max(1, Math.round(device)) / ratio);
}

/** One step in or out for the zoom buttons, always landing on a sharp zoom. */
export function stepZoom(zoom: number, direction: 1 | -1, ratio = viewPixelRatio()): number {
  const device = zoom * ratio;
  if (direction > 0) {
    if (device < 1 - 1e-6) return clampZoom(Math.min(1, device * 1.4) / ratio);
    return clampZoom(Math.max(Math.floor(device + 1e-6) + 1, Math.round(device * 1.25)) / ratio);
  }
  if (device <= 1 + 1e-6) return clampZoom(device / 1.4 / ratio);
  return clampZoom(Math.max(1, Math.min(Math.ceil(device - 1e-6) - 1, Math.round(device / 1.25))) / ratio);
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

/** Centres the map in the viewport at a sharp zoom that leaves a small margin. */
export function fitToView(cam: Camera, doc: Doc, viewW: number, viewH: number, padding = 48): void {
  const mapW = doc.width * doc.tileSize;
  const mapH = doc.height * doc.tileSize;
  if (mapW <= 0 || mapH <= 0 || viewW <= 0 || viewH <= 0) return;
  const ratio = viewPixelRatio();
  let zoom = clampZoom(Math.min((viewW - padding * 2) / mapW, (viewH - padding * 2) / mapH));
  const device = zoom * ratio;
  // Round down to a sharp zoom so the whole map still fits.
  if (device >= 1) zoom = Math.floor(device) / ratio;
  else if (device >= 0.85) zoom = 1 / ratio;
  cam.zoom = zoom;
  cam.x = mapW / 2 - viewW / 2 / zoom;
  cam.y = mapH / 2 - viewH / 2 / zoom;
}
