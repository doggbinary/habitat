import { zipBytes, type ZipEntry } from '../io/zip';
import { createImage, type Rect, type RGBAImage } from './image';
import { encodePng, type Zlib } from './png';
import type { ExtractedAsset, ExtractionResult } from './types';

/**
 * An asset's own pixels, copied byte for byte from the original sheet into
 * its box. Pixels in the box that belong to a neighbour, or to nothing, are
 * left fully transparent.
 */
export function assetImage(sheet: RGBAImage, asset: ExtractedAsset): RGBAImage {
  const out = createImage(asset.rect.w, asset.rect.h);
  for (const i of asset.pixels) {
    const x = i % sheet.width;
    const y = (i - x) / sheet.width;
    const lx = x - asset.rect.x;
    const ly = y - asset.rect.y;
    out.data.set(sheet.data.subarray(i * 4, i * 4 + 4), (ly * out.width + lx) * 4);
  }
  return out;
}

/** Problems found when checking extracted crops against the sheet they came from. */
export interface CropProblem {
  asset: string;
  problem: string;
}

/**
 * Pixel-level audit of an extraction: every asset pixel must equal the
 * original at its source position, everything else in its box must be
 * transparent, the box must be tight around its pixels (tiles keep their
 * cell), and no sheet pixel may belong to two assets.
 */
export function auditCrops(sheet: RGBAImage, assets: ExtractedAsset[], crops?: RGBAImage[]): CropProblem[] {
  const problems: CropProblem[] = [];
  const seen = new Int32Array(sheet.width * sheet.height).fill(-1);
  assets.forEach((asset, k) => {
    const crop = crops?.[k] ?? assetImage(sheet, asset);
    const { rect } = asset;
    if (crop.width !== rect.w || crop.height !== rect.h) problems.push({ asset: asset.name, problem: `crop is ${crop.width}x${crop.height}, box is ${rect.w}x${rect.h}` });
    const mine = new Uint8Array(rect.w * rect.h);
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -1;
    let y1 = -1;
    for (const i of asset.pixels) {
      if (seen[i] !== -1) problems.push({ asset: asset.name, problem: `pixel ${i % sheet.width},${Math.floor(i / sheet.width)} also belongs to "${assets[seen[i]].name}"` });
      seen[i] = k;
      const x = i % sheet.width;
      const y = (i - x) / sheet.width;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
      const lx = x - rect.x;
      const ly = y - rect.y;
      if (lx < 0 || ly < 0 || lx >= rect.w || ly >= rect.h) {
        problems.push({ asset: asset.name, problem: `pixel ${x},${y} lies outside its box` });
        continue;
      }
      mine[ly * rect.w + lx] = 1;
      for (let c = 0; c < 4; c++) {
        if (crop.data[(ly * rect.w + lx) * 4 + c] !== sheet.data[i * 4 + c]) {
          problems.push({ asset: asset.name, problem: `pixel ${x},${y} differs from the original` });
          break;
        }
      }
    }
    for (let j = 0; j < mine.length; j++) {
      if (!mine[j] && crop.data[j * 4 + 3] !== 0) {
        problems.push({ asset: asset.name, problem: `pixel ${rect.x + (j % rect.w)},${rect.y + Math.floor(j / rect.w)} is not the asset's but is not transparent` });
        break;
      }
    }
    if (asset.kind !== 'tile' && asset.pixels.length > 0 && (x0 !== rect.x || y0 !== rect.y || x1 !== rect.x + rect.w - 1 || y1 !== rect.y + rect.h - 1)) {
      problems.push({ asset: asset.name, problem: 'box has empty padding around the pixels' });
    }
  });
  return problems;
}

export interface Atlas {
  image: RGBAImage;
  /** Where each asset sits in the atlas, in the same order as the assets. */
  placements: Rect[];
  /** Tile size the atlas grid uses; tiles sit exactly on it so they paint as floor. */
  cell: number;
}

/** Gap between packed objects, so no drawing ever samples its neighbour. */
const PAD = 2;

/**
 * Packs assets into one sheet: tiles first on an exact grid (so the editor
 * can paint them as floor squares), then objects shelf-packed below,
 * tallest first.
 */
export function packAtlas(sheet: RGBAImage, assets: ExtractedAsset[], cellHint: number | null): Atlas {
  const tiles = assets.map((a, i) => ({ a, i })).filter(({ a }) => a.kind === 'tile');
  const cell = tiles.length ? tiles[0].a.rect.w : (cellHint ?? 48);
  const objects = assets
    .map((a, i) => ({ a, i }))
    .filter(({ a }) => a.kind !== 'tile')
    .sort((p, q) => q.a.rect.h - p.a.rect.h || q.a.rect.w - p.a.rect.w);
  const widest = Math.max(0, ...objects.map(({ a }) => a.rect.w + PAD));
  const area = assets.reduce((n, a) => n + (a.rect.w + PAD) * (a.rect.h + PAD), 0);
  const width = Math.max(widest, cell * Math.max(1, Math.min(16, tiles.length)), Math.ceil(Math.sqrt(area) / cell) * cell, cell);
  const cols = Math.max(1, Math.floor(width / cell));

  const placements: Rect[] = new Array(assets.length);
  tiles.forEach(({ a, i }, n) => {
    placements[i] = { x: (n % cols) * cell, y: Math.floor(n / cols) * cell, w: a.rect.w, h: a.rect.h };
  });
  let y = Math.ceil(tiles.length / cols) * cell;
  let x = 0;
  let shelf = 0;
  for (const { a, i } of objects) {
    if (x + a.rect.w > width) {
      y += shelf + PAD;
      x = 0;
      shelf = 0;
    }
    placements[i] = { x, y, w: a.rect.w, h: a.rect.h };
    x += a.rect.w + PAD;
    shelf = Math.max(shelf, a.rect.h);
  }
  const height = Math.max(cell, y + shelf);
  const image = createImage(width, height);
  assets.forEach((a, i) => {
    const crop = assetImage(sheet, a);
    const p = placements[i];
    for (let row = 0; row < crop.height; row++) {
      image.data.set(crop.data.subarray(row * crop.width * 4, (row + 1) * crop.width * 4), ((p.y + row) * width + p.x) * 4);
    }
  });
  return { image, placements, cell };
}

export function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'asset';
}

/** Everything known about each asset, for game engines and for review. */
export function metadata(result: ExtractionResult, atlas: Atlas, files: string[]) {
  return {
    format: 'habitat-ai-extract',
    version: 1,
    sheet: { name: result.sheetName, width: result.width, height: result.height, cell: result.cell, background: result.background },
    model: result.model,
    stats: result.stats,
    atlas: { file: 'atlas.png', width: atlas.image.width, height: atlas.image.height, cell: atlas.cell },
    assets: result.assets.map((a, i) => ({
      id: a.id,
      name: a.name,
      category: a.category,
      kind: a.kind,
      file: files[i],
      width: a.rect.w,
      height: a.rect.h,
      source: { ...a.rect },
      atlas: { ...atlas.placements[i] },
      anchor: { ...a.anchor },
      pixels: a.pixels.length,
      confidence: a.confidence,
      needsReview: a.needsReview,
      flags: a.flags.map((f) => ({ ...f })),
      ...(a.animation ? { animation: { ...a.animation } } : {}),
      origin: a.source,
    })),
    log: result.log,
  };
}

/** Individual PNGs by category, the packed atlas and its JSON, in one zip. */
export async function exportBundle(sheet: RGBAImage, result: ExtractionResult, zlib: Zlib): Promise<{ zip: Uint8Array; atlas: Atlas; json: ReturnType<typeof metadata> }> {
  const atlas = packAtlas(sheet, result.assets, result.cell);
  const used = new Set<string>();
  const files = result.assets.map((a) => {
    let file = `assets/${a.category}/${slug(a.name)}.png`;
    for (let n = 2; used.has(file); n++) file = `assets/${a.category}/${slug(a.name)}-${n}.png`;
    used.add(file);
    return file;
  });
  const json = metadata(result, atlas, files);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < result.assets.length; i++) {
    entries.push({ name: files[i], data: await encodePng(assetImage(sheet, result.assets[i]), zlib) });
  }
  entries.push({ name: 'atlas.png', data: await encodePng(atlas.image, zlib) });
  entries.push({ name: 'atlas.json', data: new TextEncoder().encode(JSON.stringify(json, null, 2)) });
  return { zip: zipBytes(entries), atlas, json };
}
