import { DIRECTIONS, frameIndex, type Character } from '../character/model';
import type { Doc } from '../core/doc';
import { drawTile } from '../render/tile-draw';
import { EMPTY, flagsOf, indexOf, tilesetOf } from '../core/tiles';

/**
 * Hands a file to the user. On iPadOS the share sheet is the only route into
 * Files or another app, so it is preferred when available and the anchor
 * download is the desktop fallback.
 */
export async function saveFile(blob: Blob, filename: string): Promise<'shared' | 'downloaded'> {
  const file = new File([blob], filename, { type: blob.type });
  if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
      return 'shared';
    } catch (error) {
      // A cancelled share sheet is a deliberate choice, not a failure.
      if (error instanceof DOMException && error.name === 'AbortError') return 'shared';
    }
  }

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return 'downloaded';
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Could not encode PNG'));
    }, 'image/png');
  });
}

export interface PngOptions {
  scale: number;
  /** Fill the background colour instead of leaving it transparent. */
  opaque: boolean;
  /** Skip hidden layers, matching what is on screen. */
  visibleOnly: boolean;
  /** Reference images are tracing aids, so they are left out by default. */
  includeImages: boolean;
}

export async function renderPng(doc: Doc, options: PngOptions): Promise<Blob> {
  const size = doc.tileSize * options.scale;
  const canvas = document.createElement('canvas');
  canvas.width = doc.width * size;
  canvas.height = doc.height * size;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas is unavailable');
  ctx.imageSmoothingEnabled = false;

  if (options.opaque) {
    ctx.fillStyle = doc.background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  for (const layer of doc.layers) {
    if (options.visibleOnly && !layer.visible) continue;
    ctx.globalAlpha = layer.opacity;

    if (layer.kind === 'image') {
      if (!options.includeImages || !layer.image) continue;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(
        layer.image,
        layer.x * options.scale,
        layer.y * options.scale,
        layer.w * options.scale,
        layer.h * options.scale,
      );
      ctx.imageSmoothingEnabled = false;
      continue;
    }

    for (let y = 0; y < doc.height; y++) {
      const row = y * doc.width;
      for (let x = 0; x < doc.width; x++) {
        const tile = layer.data[row + x];
        if (tile === EMPTY) continue;
        drawTile(ctx, doc, tile, x * size, y * size, size);
      }
    }
  }
  ctx.globalAlpha = 1;

  return canvasToBlob(canvas);
}

/**
 * Map data in the layout Sprite Fusion emits, which its Unity, Godot and
 * Phaser importers already understand. Layers are listed bottom-first, the
 * same order they are drawn.
 *
 * `tileset` is an extension, present only when a project uses more than one
 * spritesheet; single-tileset exports stay byte-identical to the original
 * shape so existing importers keep working.
 *
 * Reference images are omitted: they are something to trace over, not part of
 * the map an engine should load.
 */
export function buildMapJson(doc: Doc): string {
  const multiple = doc.tilesets.length > 1;

  const layers = doc.layers.flatMap((layer) => {
    if (layer.kind !== 'tiles') return [];
    const tiles: Record<string, unknown>[] = [];
    for (let y = 0; y < doc.height; y++) {
      const row = y * doc.width;
      for (let x = 0; x < doc.width; x++) {
        const tile = layer.data[row + x];
        if (tile === EMPTY) continue;
        const entry: Record<string, unknown> = { id: String(indexOf(tile)), x, y };
        const flags = flagsOf(tile);
        if (flags !== 0) entry.flags = flags;
        if (multiple) entry.tileset = doc.tilesets[tilesetOf(tile)]?.name ?? tilesetOf(tile);
        tiles.push(entry);
      }
    }
    return [{ name: layer.name, tiles, collider: layer.collider }];
  });

  const payload: Record<string, unknown> = {
    tileSize: doc.tileSize,
    mapWidth: doc.width,
    mapHeight: doc.height,
    layers,
  };
  if (multiple) {
    payload.tilesets = doc.tilesets.map((t) => ({
      name: t.name,
      tileWidth: t.tileW,
      tileHeight: t.tileH,
      columns: t.cols,
      count: t.count,
    }));
  }
  return JSON.stringify(payload, null, 2);
}

/** Packs the tilesets a project uses into one PNG strip for engine import. */
export async function renderTilesetSheet(doc: Doc): Promise<Blob | null> {
  const usable = doc.tilesets.filter((t) => t.image);
  if (usable.length === 0) return null;
  if (usable.length === 1) {
    const response = await fetch(usable[0].src);
    return response.blob();
  }

  const width = Math.max(...usable.map((t) => t.imgW));
  const height = usable.reduce((sum, t) => sum + t.imgH, 0);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = false;

  let y = 0;
  for (const tileset of usable) {
    if (tileset.image) ctx.drawImage(tileset.image, 0, y);
    y += tileset.imgH;
  }
  return canvasToBlob(canvas);
}

/**
 * Lays a character out as a sprite sheet: one row per facing, one column per
 * walk frame. That grid is what every engine's sprite importer expects, and
 * the accompanying JSON spells out the layout so nothing has to be guessed.
 */
export async function renderSpriteSheet(character: Character, scale = 1): Promise<Blob> {
  const cols = character.frameCount;
  const rows = DIRECTIONS.length;
  const canvas = document.createElement('canvas');
  canvas.width = character.w * cols * scale;
  canvas.height = character.h * rows * scale;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas is unavailable');
  ctx.imageSmoothingEnabled = false;

  const scratch = document.createElement('canvas');
  scratch.width = character.w;
  scratch.height = character.h;
  const scratchCtx = scratch.getContext('2d');
  if (!scratchCtx) throw new Error('2D canvas is unavailable');

  for (let dir = 0; dir < rows; dir++) {
    for (let f = 0; f < cols; f++) {
      const frame = character.frames[frameIndex(dir, f, character.frameCount)];
      if (!frame) continue;
      const image = scratchCtx.createImageData(character.w, character.h);
      image.data.set(frame.data);
      scratchCtx.putImageData(image, 0, 0);
      ctx.drawImage(
        scratch,
        f * character.w * scale,
        dir * character.h * scale,
        character.w * scale,
        character.h * scale,
      );
    }
  }

  return canvasToBlob(canvas);
}

export function buildSpriteSheetJson(character: Character, scale = 1): string {
  return JSON.stringify(
    {
      name: character.name,
      frameWidth: character.w * scale,
      frameHeight: character.h * scale,
      columns: character.frameCount,
      rows: DIRECTIONS.length,
      /** Row order, top to bottom. */
      directions: [...DIRECTIONS],
      tilesWide: character.tilesW,
      tilesTall: character.tilesH,
      frameMs: character.frameMs,
    },
    null,
    2,
  );
}

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'map';
}
