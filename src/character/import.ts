import { uid } from '../core/doc';
import {
  DIRECTIONS,
  STARTER_PALETTE,
  rgbaToHex,
  type Character,
  type Direction,
  type Frame,
} from './model';

/**
 * Brings an existing sprite sheet into the studio.
 *
 * Sheets in the wild are almost always a grid of equal cells with one row per
 * facing and one column per animation step, but the *order* of the rows varies
 * between tools, so the caller says which row means which direction.
 */
export interface SheetLayout {
  frameW: number;
  frameH: number;
  /** Border around the whole sheet. */
  margin: number;
  /** Gap between neighbouring cells. */
  spacing: number;
  /** Animation steps per direction. */
  columns: number;
  /** Sheet row index for each facing. */
  rows: Record<Direction, number>;
}

export interface SheetGeometry {
  cols: number;
  rows: number;
}

/** How many whole cells fit in an image at a given layout. */
export function sheetGeometry(
  imgW: number,
  imgH: number,
  layout: Pick<SheetLayout, 'frameW' | 'frameH' | 'margin' | 'spacing'>,
): SheetGeometry {
  const usableW = imgW - layout.margin * 2 + layout.spacing;
  const usableH = imgH - layout.margin * 2 + layout.spacing;
  return {
    cols: Math.max(0, Math.floor(usableW / (layout.frameW + layout.spacing))),
    rows: Math.max(0, Math.floor(usableH / (layout.frameH + layout.spacing))),
  };
}

/**
 * Guesses a sensible layout, which is right often enough to save the fiddly
 * part. Sheets are usually laid out as 4 rows of equal cells, so dividing the
 * height by four and looking for a square-ish cell gets close.
 */
export function guessLayout(imgW: number, imgH: number): { frameW: number; frameH: number; columns: number } {
  const frameH = Math.max(1, Math.round(imgH / DIRECTIONS.length));
  // Prefer a column count that divides the width evenly and yields a cell
  // close to the row height, which is what a square-ish character looks like.
  let best = { columns: 4, score: Number.POSITIVE_INFINITY };
  for (let columns = 1; columns <= 16; columns++) {
    if (imgW % columns !== 0) continue;
    const frameW = imgW / columns;
    const score = Math.abs(frameW / frameH - 0.75);
    if (score < best.score) best = { columns, score };
  }
  return { frameW: Math.round(imgW / best.columns), frameH, columns: best.columns };
}

/** Reads one cell out of the sheet as raw RGBA. */
function readCell(
  ctx: CanvasRenderingContext2D,
  layout: SheetLayout,
  col: number,
  row: number,
): Uint8ClampedArray {
  const sx = layout.margin + col * (layout.frameW + layout.spacing);
  const sy = layout.margin + row * (layout.frameH + layout.spacing);
  return ctx.getImageData(sx, sy, layout.frameW, layout.frameH).data;
}

/**
 * Builds a character from a sheet. The character's tile footprint is derived
 * from the frame size so it lands on the map at the scale it was drawn for.
 */
export function importSpriteSheet(
  image: HTMLImageElement,
  layout: SheetLayout,
  tileSize: number,
  name: string,
): Character {
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D canvas is unavailable');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(image, 0, 0);

  const geometry = sheetGeometry(image.naturalWidth, image.naturalHeight, layout);
  const frames: Frame[] = [];
  const blank = new Uint8ClampedArray(layout.frameW * layout.frameH * 4);

  for (const direction of DIRECTIONS) {
    const row = layout.rows[direction];
    for (let col = 0; col < layout.columns; col++) {
      // A sheet with fewer cells than requested gets transparent padding
      // rather than failing the whole import.
      const inside = row >= 0 && row < geometry.rows && col < geometry.cols;
      frames.push({
        id: uid('frame'),
        data: inside ? new Uint8ClampedArray(readCell(ctx, layout, col, row)) : new Uint8ClampedArray(blank),
      });
    }
  }

  return {
    id: uid('char'),
    name,
    // Round up: a sprite taller than its tiles still occupies whole tiles.
    tilesW: Math.max(1, Math.round(layout.frameW / tileSize)),
    tilesH: Math.max(1, Math.round(layout.frameH / tileSize)),
    w: layout.frameW,
    h: layout.frameH,
    frameCount: layout.columns,
    frames,
    palette: paletteFrom(frames, layout.frameW * layout.frameH),
    frameMs: 140,
  };
}

/**
 * Pulls the most-used colours out of the imported art so the palette matches
 * the sheet, which matters if you want to touch it up without re-picking
 * every shade by eye.
 */
function paletteFrom(frames: Frame[], pixelsPerFrame: number): string[] {
  const counts = new Map<string, number>();
  for (const frame of frames) {
    for (let i = 0; i < pixelsPerFrame; i++) {
      const o = i * 4;
      if (frame.data[o + 3] < 128) continue;
      const hex = rgbaToHex(frame.data[o], frame.data[o + 1], frame.data[o + 2]);
      counts.set(hex, (counts.get(hex) ?? 0) + 1);
    }
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([hex]) => hex);
  if (sorted.length === 0) return [...STARTER_PALETTE];
  // Keep it to a workable swatch count, topped up from the starter set.
  const palette = sorted.slice(0, 24);
  for (const hex of STARTER_PALETTE) {
    if (palette.length >= 24) break;
    if (!palette.includes(hex)) palette.push(hex);
  }
  return palette;
}
