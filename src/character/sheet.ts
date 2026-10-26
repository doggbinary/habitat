import { uid, type AssetRect, type Doc, type Tileset } from '../core/doc';
import { frameIndex, framePixels, type Character, type Frame } from './model';

/** The asset page that holds characters stuck onto the map. */
export const CHARACTERS_SHEET = 'Characters';

const inked = (frame: Frame | undefined): frame is Frame =>
  !!frame && frame.data.some((value, index) => (index & 3) === 3 && value > 0);

/** The pose a character stands in on the map: facing you, standing still. */
export function standingFrame(character: Character): Frame | undefined {
  const front = character.frames[frameIndex(0, 0, character.frameCount)];
  return inked(front) ? front : (character.frames.find(inked) ?? front);
}

/** The standing pose as a small picture, for lists of characters. */
export function characterThumb(character: Character): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = character.w;
  canvas.height = character.h;
  const frame = standingFrame(character);
  const ctx = canvas.getContext('2d');
  if (ctx && frame) {
    const image = ctx.createImageData(character.w, character.h);
    image.data.set(framePixels(frame.data, character.w, character.h));
    ctx.putImageData(image, 0, 0);
  }
  return canvas;
}

/**
 * Puts a character's standing pose on the Characters page and returns where.
 *
 * The page only ever grows to the right, so characters already on the map keep
 * pointing at the picture they were placed with, even after the character is
 * redrawn. The same pose is reused rather than copied again.
 */
export function addCharacterArt(doc: Doc, character: Character): { tilesetId: string; rect: AssetRect } | null {
  const frame = standingFrame(character);
  if (!frame) return null;
  const { w, h } = character;
  const pixels = framePixels(frame.data, w, h);

  let sheet = doc.tilesets.find((t) => t.name === CHARACTERS_SHEET && !t.generated && t.splitMode === 'objects');
  const oldW = sheet?.image ? sheet.imgW : 0;
  const oldH = sheet?.image ? sheet.imgH : 0;

  if (sheet?.image) {
    const existing = (sheet.assets ?? []).find((rect) => rect.w === w && rect.h === h && samePixels(sheet!, rect, pixels));
    if (existing) return { tilesetId: sheet.id, rect: { ...existing } };
  }

  // A new canvas rather than drawing into the old one: an undo snapshot may
  // still hold the old image.
  const canvas = document.createElement('canvas');
  canvas.width = oldW + w;
  canvas.height = Math.max(oldH, h);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = false;
  if (sheet?.image) ctx.drawImage(sheet.image, 0, 0);
  const image = ctx.createImageData(w, h);
  image.data.set(pixels);
  ctx.putImageData(image, oldW, 0);

  const rect = { x: oldW, y: 0, w, h };
  const src = canvas.toDataURL('image/png');
  if (!sheet) {
    sheet = {
      id: uid('ts'),
      name: CHARACTERS_SHEET,
      src,
      tileW: doc.tileSize,
      tileH: doc.tileSize,
      margin: 0,
      spacing: 0,
      image: canvas,
      imgW: canvas.width,
      imgH: canvas.height,
      cols: Math.max(1, Math.floor(canvas.width / doc.tileSize)),
      rows: Math.max(1, Math.floor(canvas.height / doc.tileSize)),
      count: 0,
      splitMode: 'objects',
      assets: [rect],
      assetsEdited: true,
    } satisfies Tileset;
    doc.tilesets.push(sheet);
  } else {
    sheet.src = src;
    sheet.image = canvas;
    sheet.imgW = canvas.width;
    sheet.imgH = canvas.height;
    sheet.cols = Math.max(1, Math.floor(canvas.width / sheet.tileW));
    sheet.rows = Math.max(1, Math.floor(canvas.height / sheet.tileH));
    sheet.assets = [...(sheet.assets ?? []), rect];
    sheet.assetsEdited = true;
  }
  return { tilesetId: sheet.id, rect };
}

function samePixels(sheet: Tileset, rect: AssetRect, pixels: Uint8ClampedArray): boolean {
  if (!sheet.image) return false;
  const canvas = document.createElement('canvas');
  canvas.width = rect.w;
  canvas.height = rect.h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return false;
  ctx.drawImage(sheet.image, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
  const have = ctx.getImageData(0, 0, rect.w, rect.h).data;
  if (have.length !== pixels.length) return false;
  for (let i = 0; i < have.length; i++) if (have[i] !== pixels[i]) return false;
  return true;
}
