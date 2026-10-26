import type { AssetRect, Doc, MapObject } from '../core/doc';
import { recolorToCanvas } from '../io/recolor';

/**
 * Recoloured artwork is expensive to compute and cheap to keep, so each
 * distinct recolour of each asset is rendered once. Bounded so a session of
 * dragging the colour wheel around cannot grow memory without limit.
 */
const recolorCache = new Map<string, HTMLCanvasElement>();
const MAX_CACHED = 400;

/** Copies an asset's rectangle out of its sheet. */
export function cropAsset(
  image: CanvasImageSource,
  rect: AssetRect,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = rect.w;
  canvas.height = rect.h;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(image, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
  }
  return canvas;
}

export function isRecolored(obj: MapObject): boolean {
  return (
    obj.hueShift !== 0 ||
    obj.saturation !== 1 ||
    obj.brightness !== 1 ||
    (obj.contrast ?? 1) !== 1 ||
    (obj.clarity ?? 0) !== 0
  );
}

interface Art {
  source: CanvasImageSource;
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/** The pixels to draw for an object: straight from its sheet, or recoloured. */
function artFor(doc: Doc, obj: MapObject): Art | null {
  const sheet = doc.tilesets.find((t) => t.id === obj.tilesetId);
  if (!sheet?.image) return null;
  const { rect } = obj;

  if (!isRecolored(obj)) {
    return { source: sheet.image, sx: rect.x, sy: rect.y, sw: rect.w, sh: rect.h };
  }

  const key = [
    sheet.id,
    rect.x,
    rect.y,
    rect.w,
    rect.h,
    obj.hueShift.toFixed(1),
    obj.saturation.toFixed(3),
    obj.brightness.toFixed(3),
    (obj.contrast ?? 1).toFixed(3),
    (obj.clarity ?? 0).toFixed(3),
  ].join(':');

  let canvas = recolorCache.get(key);
  if (!canvas) {
    canvas = recolorToCanvas(cropAsset(sheet.image, rect), {
      hueShift: obj.hueShift,
      saturation: obj.saturation,
      brightness: obj.brightness,
      contrast: obj.contrast ?? 1,
      clarity: obj.clarity ?? 0,
    });
    recolorCache.set(key, canvas);
    // Map iteration order is insertion order, so the first key is the oldest.
    if (recolorCache.size > MAX_CACHED) {
      const oldest = recolorCache.keys().next().value;
      if (oldest !== undefined) recolorCache.delete(oldest);
    }
  }
  return { source: canvas, sx: 0, sy: 0, sw: rect.w, sh: rect.h };
}

/**
 * Draws an object centred on its position.
 *
 * The transform is rotate-then-mirror in the object's own frame. Flipping
 * from the UI accounts for that (see `flipObject`), so "flip across" always
 * mirrors across the screen whatever way the object is turned.
 */
export function drawObject(
  ctx: CanvasRenderingContext2D,
  doc: Doc,
  obj: MapObject,
  originX: number,
  originY: number,
  zoom: number,
): void {
  const art = artFor(doc, obj);
  if (!art) return;

  const w = obj.rect.w * obj.scale * zoom;
  const h = obj.rect.h * obj.scale * zoom;

  ctx.save();
  ctx.translate(originX + obj.x * zoom, originY + obj.y * zoom);
  if (obj.rotation) ctx.rotate((obj.rotation * Math.PI) / 2);
  if (obj.flipX || obj.flipY) ctx.scale(obj.flipX ? -1 : 1, obj.flipY ? -1 : 1);
  ctx.drawImage(art.source, art.sx, art.sy, art.sw, art.sh, -w / 2, -h / 2, w, h);
  ctx.restore();
}
