import type { AssetRect } from '../core/doc';

/** One picture the vision cut found on a sheet. */
export interface CutPiece extends AssetRect {
  /** A repeating floor or wall square, painted with the brush rather than placed. */
  floor: boolean;
}

/**
 * Reads the boxes a vision model returned for a sheet of `imgW` by `imgH`.
 * Pixels, 0–1 fractions, and 0–1000 grids are all accepted. A box around the
 * whole sheet is dropped: that is a failed cut, not an object.
 */
export function parseCutReply(raw: string, imgW: number, imgH: number): CutPiece[] {
  const data = extractJson(raw);
  const list = piecesOf(data);
  if (!list) return [];

  const numbers: number[] = [];
  for (const item of list) {
    const box = boxOf(item);
    if (!box) continue;
    numbers.push(box.x, box.y, box.w, box.h);
  }
  const norm = normalization(numbers, imgW, imgH);

  const pieces: CutPiece[] = [];
  const sheetArea = imgW * imgH;
  for (const item of list) {
    const box = boxOf(item);
    if (!box) continue;
    const rect = clampRect(scaleBox(box, norm, imgW, imgH), imgW, imgH);
    if (!rect || rect.w < 2 || rect.h < 2) continue;
    if (rect.w * rect.h > sheetArea * 0.9) continue;
    pieces.push({ ...rect, floor: isFloor(item) });
  }
  pieces.sort((a, b) => a.y - b.y || a.x - b.x);
  return dedupe(pieces);
}

function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const text = (fenced?.[1] ?? raw).trim();
  const obj = text.indexOf('{');
  const arr = text.indexOf('[');
  const start = obj === -1 ? arr : arr === -1 ? obj : Math.min(obj, arr);
  if (start === -1) throw new Error('The reply had no boxes');
  const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  if (end <= start) throw new Error('The reply had no boxes');
  return JSON.parse(text.slice(start, end + 1)) as unknown;
}

function piecesOf(data: unknown): unknown[] | null {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  for (const key of ['pieces', 'tiles', 'boxes', 'assets', 'objects']) {
    if (Array.isArray(record[key])) return record[key];
  }
  return null;
}

interface RawBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

function boxOf(item: unknown): RawBox | null {
  if (!item || typeof item !== 'object') return null;
  const record = item as Record<string, unknown>;
  const x = num(record.x ?? record.left);
  const y = num(record.y ?? record.top);
  const w = num(record.w ?? record.width);
  const h = num(record.h ?? record.height);
  if (x === null || y === null || w === null || h === null) return null;
  if (w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}

function num(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** How to turn the model's numbers into pixels of this image. */
function normalization(values: number[], imgW: number, imgH: number): 'unit' | 'grid' | 'pixel' {
  const max = values.reduce((m, n) => Math.max(m, n), 0);
  if (max <= 1.5) return 'unit';
  if (max <= 1000 && Math.max(imgW, imgH) > 1100) return 'grid';
  return 'pixel';
}

function scaleBox(box: RawBox, norm: 'unit' | 'grid' | 'pixel', imgW: number, imgH: number): AssetRect {
  const sx = norm === 'unit' ? imgW : norm === 'grid' ? imgW / 1000 : 1;
  const sy = norm === 'unit' ? imgH : norm === 'grid' ? imgH / 1000 : 1;
  return { x: box.x * sx, y: box.y * sy, w: box.w * sx, h: box.h * sy };
}

function clampRect(rect: AssetRect, imgW: number, imgH: number): AssetRect | null {
  const x = Math.max(0, Math.min(imgW - 1, Math.round(rect.x)));
  const y = Math.max(0, Math.min(imgH - 1, Math.round(rect.y)));
  const w = Math.round(rect.w);
  const h = Math.round(rect.h);
  const right = Math.min(imgW, x + w);
  const bottom = Math.min(imgH, y + h);
  const keptW = right - x;
  const keptH = bottom - y;
  // A box that mostly falls off the sheet was a bad coordinate, not a sliver of art.
  if (keptW < 2 || keptH < 2 || keptW * keptH < w * h * 0.5) return null;
  return { x, y, w: keptW, h: keptH };
}

function isFloor(item: unknown): boolean {
  if (!item || typeof item !== 'object') return false;
  const record = item as Record<string, unknown>;
  if (record.floor === true || record.ground === true) return true;
  const kind = String(record.kind ?? record.type ?? record.role ?? '').toLowerCase();
  return kind === 'floor' || kind === 'ground' || kind === 'terrain' || kind === 'wall';
}

/** Drops a box that sits almost entirely inside an earlier one of the same kind. */
function dedupe(pieces: CutPiece[]): CutPiece[] {
  const kept: CutPiece[] = [];
  for (const piece of pieces) {
    const inside = kept.some((other) => other.floor === piece.floor && covers(other, piece));
    if (!inside) kept.push(piece);
  }
  return kept;
}

function covers(outer: AssetRect, inner: AssetRect): boolean {
  const x1 = Math.max(outer.x, inner.x);
  const y1 = Math.max(outer.y, inner.y);
  const x2 = Math.min(outer.x + outer.w, inner.x + inner.w);
  const y2 = Math.min(outer.y + outer.h, inner.y + inner.h);
  const overlap = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return overlap >= inner.w * inner.h * 0.85;
}
