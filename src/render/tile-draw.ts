import { tileIsGround } from '../core/assets';
import { tileRect, type Doc, type Tileset } from '../core/doc';
import { EMPTY, FLIP_H, FLIP_V, ROT_90, flagsOf, indexOf, tilesetOf, type PackedTile } from '../core/tiles';
import { imageEdgeInset, imagePixels, nearestScale, NO_INSET } from './floor-edges';

/** A 1:1 sprite the browser cannot resample. Reused so a stroke does not allocate per tile. */
let sprite: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null = null;

function spriteCanvas(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  if (typeof document === 'undefined') return null;
  if (!sprite) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    sprite = { canvas, ctx };
  }
  if (sprite.canvas.width !== w || sprite.canvas.height !== h) {
    sprite.canvas.width = w;
    sprite.canvas.height = h;
  }
  return sprite;
}

/**
 * Draws the source rectangle at the destination size by point sampling.
 * drawImage would let the browser average the pixels whenever the sizes differ,
 * which is what turns a sharp floor swatch soft once it is placed.
 */
function drawSampled(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement | HTMLCanvasElement,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
): void {
  ctx.imageSmoothingEnabled = false;
  if (sw === dw && sh === dh) {
    ctx.drawImage(image, sx, sy, sw, sh, dx, dy, dw, dh);
    return;
  }
  const src = imagePixels(image);
  const holder = spriteCanvas(dw, dh);
  if (!src || !holder) {
    ctx.drawImage(image, sx, sy, sw, sh, dx, dy, dw, dh);
    return;
  }
  const scaled = nearestScale(src.data, src.width, sx, sy, sw, sh, dw, dh);
  const raster = holder.ctx.createImageData(dw, dh);
  raster.data.set(scaled);
  holder.ctx.putImageData(raster, 0, 0);
  ctx.drawImage(holder.canvas, dx, dy, dw, dh);
}

/**
 * Draws one packed tile into a `size x size` cell, honouring its transform
 * flags. The transform must stay in sync with `rotateFlagsCW` in core/tiles.
 */
export function drawTile(
  ctx: CanvasRenderingContext2D,
  doc: Doc,
  tile: PackedTile,
  dx: number,
  dy: number,
  size: number,
): void {
  if (tile === EMPTY) return;
  const ts: Tileset | undefined = doc.tilesets[tilesetOf(tile)];
  if (!ts || !ts.image) return;
  const index = indexOf(tile);
  if (index >= ts.count) return;

  const { sx, sy } = tileRect(ts, index);
  const flags = flagsOf(tile);
  // A sheet outline around a floor square is not part of the texture.
  const inset = !ts.pathStride && !ts.autotile && tileIsGround(ts, index) ? imageEdgeInset(ts.image, sx, sy, ts.tileW, ts.tileH) : NO_INSET;
  const srcX = sx + inset.left;
  const srcY = sy + inset.top;
  const srcW = ts.tileW - inset.left - inset.right;
  const srcH = ts.tileH - inset.top - inset.bottom;

  if (flags === 0) {
    drawSampled(ctx, ts.image, srcX, srcY, srcW, srcH, dx, dy, size, size);
    return;
  }

  ctx.save();
  ctx.translate(dx + size / 2, dy + size / 2);
  if (flags & ROT_90) ctx.rotate(Math.PI / 2);
  ctx.scale(flags & FLIP_H ? -1 : 1, flags & FLIP_V ? -1 : 1);
  drawSampled(ctx, ts.image, srcX, srcY, srcW, srcH, -size / 2, -size / 2, size, size);
  ctx.restore();
}
