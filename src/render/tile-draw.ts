import { tileRect, type Doc, type Tileset } from '../core/doc';
import { EMPTY, FLIP_H, FLIP_V, ROT_90, flagsOf, indexOf, tilesetOf, type PackedTile } from '../core/tiles';

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

  if (flags === 0) {
    ctx.drawImage(ts.image, sx, sy, ts.tileW, ts.tileH, dx, dy, size, size);
    return;
  }

  ctx.save();
  ctx.translate(dx + size / 2, dy + size / 2);
  if (flags & ROT_90) ctx.rotate(Math.PI / 2);
  ctx.scale(flags & FLIP_H ? -1 : 1, flags & FLIP_V ? -1 : 1);
  ctx.drawImage(ts.image, sx, sy, ts.tileW, ts.tileH, -size / 2, -size / 2, size, size);
  ctx.restore();
}
