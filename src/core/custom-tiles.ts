import { tileRect, uid, type Doc, type Tileset } from './doc';
import { indexOf, tilesetOf, type PackedTile } from './tiles';

/**
 * Edited tiles live in generated sheets.
 *
 * Recolouring one placed tile cannot change the source sheet without
 * recolouring every other copy of it, so the edited version is written into a
 * sheet of its own and the cell is pointed at that. The map data model stays
 * exactly as it was, which means undo, saving and export all keep working with
 * no special cases. As a bonus, the edited tiles show up as a page in the
 * palette, so a recoloured tree can be painted again.
 */

const COLUMNS = 16;

/** Copies one tile's raw, untransformed pixels into its own canvas. */
export function extractTile(doc: Doc, tile: PackedTile): HTMLCanvasElement | null {
  const ts = doc.tilesets[tilesetOf(tile)];
  if (!ts?.image) return null;
  const index = indexOf(tile);
  if (index >= ts.count) return null;

  const { sx, sy } = tileRect(ts, index);
  const canvas = document.createElement('canvas');
  canvas.width = ts.tileW;
  canvas.height = ts.tileH;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(ts.image, sx, sy, ts.tileW, ts.tileH, 0, 0, ts.tileW, ts.tileH);
  return canvas;
}

/**
 * Finds the generated sheet for a tile size, creating it when missing. Sheets
 * are kept per size because every tile in a sheet must share dimensions.
 */
export function ensureGeneratedSheet(doc: Doc, tileW: number, tileH: number): number {
  return ensureSheet(doc, 'Edited tiles', tileW, tileH);
}

/** The page of seamless floor squares made from shaped objects. */
export const MY_FLOORS = 'My floors';

export function ensureFloorSheet(doc: Doc, tileW: number, tileH: number): number {
  return ensureSheet(doc, MY_FLOORS, tileW, tileH);
}

function ensureSheet(doc: Doc, name: string, tileW: number, tileH: number): number {
  const existing = doc.tilesets.findIndex(
    (t) => t.generated && (t.name === MY_FLOORS) === (name === MY_FLOORS) && t.tileW === tileW && t.tileH === tileH,
  );
  if (existing !== -1) return existing;

  const canvas = document.createElement('canvas');
  canvas.width = COLUMNS * tileW;
  canvas.height = tileH;
  doc.tilesets.push({
    id: uid('ts'),
    name,
    src: canvas.toDataURL('image/png'),
    tileW,
    tileH,
    margin: 0,
    spacing: 0,
    image: canvas,
    imgW: canvas.width,
    imgH: canvas.height,
    cols: COLUMNS,
    rows: 1,
    count: 0,
    generated: true,
  });
  return doc.tilesets.length - 1;
}

/**
 * Returns the sheet's pixels as a canvas that can be drawn into. A sheet
 * reloaded from disk arrives as an image, so it is converted on first edit.
 */
function editableCanvas(ts: Tileset): HTMLCanvasElement {
  if (ts.image instanceof HTMLCanvasElement) return ts.image;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(ts.imgW, COLUMNS * ts.tileW);
  canvas.height = Math.max(ts.imgH, ts.tileH);
  const ctx = canvas.getContext('2d');
  if (ctx && ts.image) ctx.drawImage(ts.image, 0, 0);
  ts.image = canvas;
  return canvas;
}

/** Writes a tile into a slot, growing the sheet if the slot is past its end. */
export function writeGeneratedTile(ts: Tileset, index: number, tile: HTMLCanvasElement): void {
  const col = index % COLUMNS;
  const row = Math.floor(index / COLUMNS);
  const needH = (row + 1) * ts.tileH;

  let canvas = editableCanvas(ts);
  if (canvas.height < needH) {
    // Never grow in place: an undo snapshot may still hold the old canvas.
    const grown = document.createElement('canvas');
    grown.width = COLUMNS * ts.tileW;
    grown.height = needH;
    grown.getContext('2d')?.drawImage(canvas, 0, 0);
    canvas = grown;
  }

  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(col * ts.tileW, row * ts.tileH, ts.tileW, ts.tileH);
  ctx.drawImage(tile, col * ts.tileW, row * ts.tileH);

  ts.image = canvas;
  ts.imgW = canvas.width;
  ts.imgH = canvas.height;
  ts.cols = COLUMNS;
  ts.rows = Math.max(ts.rows, row + 1);
  ts.count = Math.max(ts.count, index + 1);
}

/**
 * Takes squares out of a generated sheet, closing the gaps. Returns each
 * old slot's new slot, or -1 for the ones removed.
 */
export function removeGeneratedTiles(ts: Tileset, indices: number[]): number[] {
  const gone = new Set(indices);
  const moved: number[] = [];
  const source = editableCanvas(ts);
  // A new canvas, as an undo snapshot may still hold the old one.
  const canvas = document.createElement('canvas');
  canvas.width = COLUMNS * ts.tileW;
  canvas.height = Math.max(1, Math.ceil((ts.count - gone.size) / COLUMNS)) * ts.tileH;
  const ctx = canvas.getContext('2d');
  let next = 0;
  for (let i = 0; i < ts.count; i++) {
    if (gone.has(i)) {
      moved.push(-1);
      continue;
    }
    ctx?.drawImage(
      source,
      (i % COLUMNS) * ts.tileW,
      Math.floor(i / COLUMNS) * ts.tileH,
      ts.tileW,
      ts.tileH,
      (next % COLUMNS) * ts.tileW,
      Math.floor(next / COLUMNS) * ts.tileH,
      ts.tileW,
      ts.tileH,
    );
    moved.push(next++);
  }
  ts.image = canvas;
  ts.imgW = canvas.width;
  ts.imgH = canvas.height;
  ts.rows = canvas.height / ts.tileH;
  ts.count = next;
  return moved;
}

/** Bakes the sheet's current pixels into `src`, so it survives a reload. */
export function persistGeneratedSheet(ts: Tileset): void {
  ts.src = editableCanvas(ts).toDataURL('image/png');
}
