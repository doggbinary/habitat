import { uid } from '../core/doc';

/**
 * A character is a small grid of pixel frames: one row per facing direction,
 * one column per step of the walk cycle. Everything is sized in map tiles, so
 * a character drawn here is guaranteed to sit correctly on the map.
 */

export const DIRECTIONS = ['down', 'left', 'right', 'up'] as const;
export type Direction = (typeof DIRECTIONS)[number];

export const DIRECTION_LABELS: Record<Direction, string> = {
  down: 'Facing you',
  left: 'Walking left',
  right: 'Walking right',
  up: 'Facing away',
};

export interface Frame {
  id: string;
  /** RGBA bytes, `w * h * 4`. */
  data: Uint8ClampedArray;
}

export interface Character {
  id: string;
  name: string;
  /** Footprint in map tiles. */
  tilesW: number;
  tilesH: number;
  /** Pixel size, always `tiles * tileSize`. */
  w: number;
  h: number;
  /** Steps per direction in the walk cycle. */
  frameCount: number;
  /**
   * `DIRECTIONS.length * frameCount` frames, direction-major: every visible
   * layer flattened, which is what Play, export and previews show. Drawing
   * happens on `layers`; `composeFrames` brings this up to date.
   */
  frames: Frame[];
  /** Drawing layers, bottom first, each with its own frames laid out like `frames`. */
  layers: CharacterLayer[];
  /** Index into `layers` of the one being drawn on. */
  activeLayer: number;
  palette: string[];
  /** Milliseconds per frame when previewing. */
  frameMs: number;
  /** Pictures to trace over, bottom first. They are never part of the sprite Play walks. */
  references: CharacterReference[];
  /** Index into `references` of the one the panel and fingers move. */
  activeReference: number;
  /** Folder in the character library, absent when it is loose. */
  folder?: string;
}

export interface CharacterLayer {
  id: string;
  name: string;
  visible: boolean;
  frames: Frame[];
}

export interface CharacterReference {
  /** Data URL, so the picture saves with the project. */
  src: string;
  opacity: number;
  visible: boolean;
  /** Size against the picture's fitted size, 1 when absent. */
  scale?: number;
  /** Nudge from the fitted position, in sprite pixels. */
  x?: number;
  y?: number;
  /** When locked, fingers draw. Unlocked, a finger drags the picture and two pinch it. */
  locked?: boolean;
  /** Loaded from `src`; not saved. */
  image?: HTMLImageElement;
}

/** The traced picture the panel and fingers act on, if there is any. */
export function activeReference(character: Character): CharacterReference | null {
  return character.references[character.activeReference] ?? character.references[character.references.length - 1] ?? null;
}

/** The decoded picture for a reference, created on first use. */
export function referenceImage(reference: CharacterReference, onLoad: () => void): HTMLImageElement | null {
  if (!reference.image || reference.image.getAttribute('src') !== reference.src) {
    const image = new Image();
    image.src = reference.src;
    reference.image = image;
  }
  const image = reference.image;
  if (image.complete && image.naturalWidth > 0) return image;
  image.addEventListener('load', onLoad, { once: true });
  return null;
}

/**
 * Where a picture sits inside the sprite box. By default it is as large as
 * fits, centred, standing on the bottom; its own size and nudge then grow it
 * from that bottom-centre point and move it.
 */
export function referencePlacement(
  imageW: number,
  imageH: number,
  boxW: number,
  boxH: number,
  adjust: Pick<CharacterReference, 'scale' | 'x' | 'y'> = {},
): { x: number; y: number; w: number; h: number } {
  const fit = Math.min(boxW / Math.max(1, imageW), boxH / Math.max(1, imageH));
  const scale = fit * (adjust.scale ?? 1);
  const w = imageW * scale;
  const h = imageH * scale;
  return { x: (boxW - w) / 2 + (adjust.x ?? 0), y: boxH - h + (adjust.y ?? 0), w, h };
}

export const REFERENCE_MIN_SCALE = 0.2;
export const REFERENCE_MAX_SCALE = 4;

/**
 * The picture's size and nudge after a pinch, in sprite pixels: the point of
 * the picture that was between the fingers stays between them as they move
 * apart, together, or across the canvas.
 */
export function pinchReference(
  imageW: number,
  imageH: number,
  boxW: number,
  boxH: number,
  start: Pick<CharacterReference, 'scale' | 'x' | 'y'>,
  from: { x: number; y: number },
  to: { x: number; y: number },
  factor: number,
): { scale: number; x: number; y: number } {
  const before = referencePlacement(imageW, imageH, boxW, boxH, start);
  const wanted = (start.scale ?? 1) * (Number.isFinite(factor) && factor > 0 ? factor : 1);
  const scale = Math.max(REFERENCE_MIN_SCALE, Math.min(REFERENCE_MAX_SCALE, wanted));
  const after = referencePlacement(imageW, imageH, boxW, boxH, { scale });
  const u = before.w > 0 ? (from.x - before.x) / before.w : 0.5;
  const v = before.h > 0 ? (from.y - before.y) / before.h : 1;
  return {
    scale,
    x: to.x - u * after.w - (boxW - after.w) / 2,
    y: to.y - v * after.h - (boxH - after.h),
  };
}

/**
 * A deliberately small starter palette. Limited palettes are most of what
 * makes pixel art read well, and picking from sixteen considered colours is
 * far easier than facing a colour wheel.
 */
export const STARTER_PALETTE = [
  '#2b2139', // outline, near-black plum rather than pure black
  '#584c6e',
  '#9a8fae',
  '#f6f2e8', // white
  '#ffd9b3', // skin highlight
  '#f0b183', // skin
  '#c98b60', // skin shadow
  '#8c5a33', // hair light
  '#6b4226', // hair
  '#4a7fd4', // shirt
  '#35589b', // shirt shadow
  '#3b3f58', // trousers
  '#2a2d40', // trousers shadow
  '#d9544d', // red
  '#5fae5f', // green
  '#e8c15a', // yellow
];

export function frameIndex(dir: number, frame: number, frameCount: number): number {
  return dir * frameCount + frame;
}

/** Canvas sizes offered in the studio, in tiles across by tiles tall. */
export const CANVAS_PRESETS: readonly { tilesW: number; tilesH: number }[] = [
  { tilesW: 1, tilesH: 2 },
  { tilesW: 2, tilesH: 2 },
  { tilesW: 2, tilesH: 3 },
  { tilesW: 3, tilesH: 3 },
  { tilesW: 3, tilesH: 4 },
];

/** A frame's pixels at exactly w by h. A short or long buffer cannot throw a blit. */
export function framePixels(data: Uint8ClampedArray, w: number, h: number): Uint8ClampedArray {
  const expected = w * h * 4;
  if (data.length === expected) return data;
  const fixed = new Uint8ClampedArray(expected);
  fixed.set(data.subarray(0, Math.min(data.length, expected)));
  return fixed;
}

function emptyFrame(w: number, h: number): Frame {
  return { id: uid('frame'), data: new Uint8ClampedArray(w * h * 4) };
}

function copyFrames(frames: Frame[]): Frame[] {
  return frames.map((f) => ({ id: uid('frame'), data: new Uint8ClampedArray(f.data) }));
}

export function createLayer(character: Pick<Character, 'w' | 'h' | 'frameCount'>, name: string): CharacterLayer {
  const frames: Frame[] = [];
  for (let i = 0; i < DIRECTIONS.length * character.frameCount; i++) frames.push(emptyFrame(character.w, character.h));
  return { id: uid('layer'), name, visible: true, frames };
}

/**
 * A character from flattened frames alone, as sprite sheets and older saves
 * provide: those frames become its one layer.
 */
export function characterFromFrames(
  base: Omit<Character, 'layers' | 'activeLayer' | 'references' | 'activeReference'> &
    Partial<Pick<Character, 'references' | 'activeReference'>>,
): Character {
  return {
    ...base,
    layers: [{ id: uid('layer'), name: 'Layer 1', visible: true, frames: copyFrames(base.frames) }],
    activeLayer: 0,
    references: base.references ?? [],
    activeReference: base.activeReference ?? 0,
  };
}

export function createCharacter(
  tileSize: number,
  tilesW = 2,
  tilesH = 2,
  frameCount = 4,
  name = 'New character',
): Character {
  const w = tilesW * tileSize;
  const h = tilesH * tileSize;
  const frames: Frame[] = [];
  for (let i = 0; i < DIRECTIONS.length * frameCount; i++) frames.push(emptyFrame(w, h));
  return characterFromFrames({
    id: uid('char'),
    name,
    tilesW,
    tilesH,
    w,
    h,
    frameCount,
    frames,
    palette: [...STARTER_PALETTE],
    frameMs: 140,
  });
}

/**
 * Flattens the visible layers into `frames`, every frame or just one.
 * Layers stack bottom first; a pixel partly see-through blends with what is
 * under it.
 */
export function composeFrames(character: Character, only?: number): void {
  const count = character.frames.length;
  const size = character.w * character.h * 4;
  for (let index = 0; index < count; index++) {
    if (only !== undefined && index !== only) continue;
    const out = character.frames[index];
    if (out.data.length !== size) out.data = new Uint8ClampedArray(size);
    out.data.fill(0);
    for (const layer of character.layers) {
      if (!layer.visible) continue;
      const src = layer.frames[index]?.data;
      if (!src) continue;
      for (let i = 0; i < size; i += 4) {
        const a = src[i + 3];
        if (a === 0) continue;
        if (a === 255 || out.data[i + 3] === 0) {
          out.data[i] = src[i];
          out.data[i + 1] = src[i + 1];
          out.data[i + 2] = src[i + 2];
          out.data[i + 3] = a;
          continue;
        }
        const sa = a / 255;
        const da = out.data[i + 3] / 255;
        const oa = sa + da * (1 - sa);
        for (let c = 0; c < 3; c++) {
          out.data[i + c] = Math.round((src[i + c] * sa + out.data[i + c] * da * (1 - sa)) / oa);
        }
        out.data[i + 3] = Math.round(oa * 255);
      }
    }
  }
}

/** A separate copy to carry on from: new ids, same pixels, layers and pictures. */
export function duplicateCharacter(character: Character, name = `${character.name} copy`): Character {
  return {
    ...character,
    id: uid('char'),
    name,
    palette: [...character.palette],
    frames: copyFrames(character.frames),
    layers: character.layers.map((layer) => ({ ...layer, id: uid('layer'), frames: copyFrames(layer.frames) })),
    references: character.references.map(({ image, ...reference }) => {
      void image;
      return { ...reference };
    }),
  };
}

// --- Pixel helpers ---------------------------------------------------------

export type RGBA = [number, number, number, number];

export function hexToRgba(hex: string, alpha = 255): RGBA {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
    alpha,
  ];
}

export function rgbaToHex(r: number, g: number, b: number): string {
  const part = (v: number) => v.toString(16).padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`;
}

export function setPixel(frame: Frame, w: number, x: number, y: number, color: RGBA): void {
  const i = (y * w + x) * 4;
  frame.data[i] = color[0];
  frame.data[i + 1] = color[1];
  frame.data[i + 2] = color[2];
  frame.data[i + 3] = color[3];
}

export function getPixel(frame: Frame, w: number, x: number, y: number): RGBA {
  const i = (y * w + x) * 4;
  return [frame.data[i], frame.data[i + 1], frame.data[i + 2], frame.data[i + 3]];
}

export function sameColor(a: RGBA, b: RGBA): boolean {
  // Fully transparent pixels match regardless of their stale RGB values.
  if (a[3] === 0 && b[3] === 0) return true;
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

function fillRect(
  frame: Frame,
  w: number,
  x: number,
  y: number,
  rw: number,
  rh: number,
  color: RGBA,
  bounds: { w: number; h: number },
): void {
  for (let yy = y; yy < y + rh; yy++) {
    for (let xx = x; xx < x + rw; xx++) {
      if (xx < 0 || yy < 0 || xx >= bounds.w || yy >= bounds.h) continue;
      setPixel(frame, w, xx, yy, color);
    }
  }
}

/**
 * Draws a simple humanoid into every frame as a starting point.
 *
 * The point is that you never face an empty canvas: there is a body with the
 * right proportions standing in the right place, and the work becomes editing
 * rather than inventing. Proportions scale with the canvas, so this works for
 * a 16px sprite or a 64px one.
 */
export function applyTemplate(character: Character): void {
  const { w, h, frameCount } = character;
  const p = character.palette;

  const outline = hexToRgba(p[0]);
  const skin = hexToRgba(p[5]);
  const skinShade = hexToRgba(p[6]);
  const hair = hexToRgba(p[8]);
  const hairLight = hexToRgba(p[7]);
  const shirt = hexToRgba(p[9]);
  const shirtShade = hexToRgba(p[10]);
  const trousers = hexToRgba(p[11]);
  const shoes = hexToRgba(p[12]);
  const white = hexToRgba(p[3]);

  const bounds = { w, h };
  // Proportions as fractions of the canvas, so any sprite size works.
  const unit = h / 32;
  const px = (n: number) => Math.round(n * unit);

  const cx = Math.floor(w / 2);
  const headW = px(10);
  const headH = px(10);
  const headX = cx - Math.floor(headW / 2);
  const headY = px(3);
  const bodyY = headY + headH;
  const bodyH = px(9);
  const bodyW = px(10);
  const bodyX = cx - Math.floor(bodyW / 2);
  const legY = bodyY + bodyH;
  const legH = h - legY - px(1);
  const armW = px(3);
  const layer = character.layers[character.activeLayer] ?? character.layers[0];
  if (!layer) return;

  for (let d = 0; d < DIRECTIONS.length; d++) {
    const dir = DIRECTIONS[d];
    for (let f = 0; f < frameCount; f++) {
      const frame = layer.frames[frameIndex(d, f, frameCount)];
      frame.data.fill(0);

      // Frames 0 and 2 stand; 1 and 3 are the two opposite steps. That gives a
      // readable cycle from only two drawn poses.
      const step = f % 2 === 0 ? 0 : f === 1 ? 1 : -1;

      // Legs first, so the body overlaps them cleanly.
      const legW = px(4);
      const leftLegX = cx - legW;
      const rightLegX = cx;
      const lift = px(1);
      fillRect(frame, w, leftLegX, legY + (step > 0 ? lift : 0), legW, legH - (step > 0 ? lift : 0), trousers, bounds);
      fillRect(frame, w, rightLegX, legY + (step < 0 ? lift : 0), legW, legH - (step < 0 ? lift : 0), trousers, bounds);
      // Shoes.
      fillRect(frame, w, leftLegX, h - px(2) - (step > 0 ? lift : 0), legW, px(2), shoes, bounds);
      fillRect(frame, w, rightLegX, h - px(2) - (step < 0 ? lift : 0), legW, px(2), shoes, bounds);

      // Torso.
      fillRect(frame, w, bodyX, bodyY, bodyW, bodyH, shirt, bounds);
      fillRect(frame, w, bodyX, bodyY + bodyH - px(2), bodyW, px(2), shirtShade, bounds);

      // Arms swing opposite the legs.
      const armY = bodyY + px(1);
      const armH = px(6);
      fillRect(frame, w, bodyX - armW, armY - (step < 0 ? lift : 0), armW, armH, shirt, bounds);
      fillRect(frame, w, bodyX + bodyW, armY - (step > 0 ? lift : 0), armW, armH, shirt, bounds);
      // Hands.
      fillRect(frame, w, bodyX - armW, armY + armH - (step < 0 ? lift : 0), armW, px(2), skin, bounds);
      fillRect(frame, w, bodyX + bodyW, armY + armH - (step > 0 ? lift : 0), armW, px(2), skin, bounds);

      // Head.
      fillRect(frame, w, headX, headY, headW, headH, skin, bounds);
      fillRect(frame, w, headX, headY + headH - px(1), headW, px(1), skinShade, bounds);

      // Hair: a full cap from behind, a fringe from the front and sides.
      const hairH = dir === 'up' ? headH : px(4);
      fillRect(frame, w, headX, headY, headW, hairH, hair, bounds);
      fillRect(frame, w, headX, headY, headW, px(1), hairLight, bounds);
      if (dir === 'left') fillRect(frame, w, headX, headY, px(2), headH - px(2), hair, bounds);
      if (dir === 'right') fillRect(frame, w, headX + headW - px(2), headY, px(2), headH - px(2), hair, bounds);

      // Eyes, except from behind.
      if (dir !== 'up') {
        const eyeY = headY + px(5);
        const eyeW = px(2);
        const eyeH = px(2);
        if (dir === 'down') {
          fillRect(frame, w, headX + px(2), eyeY, eyeW, eyeH, white, bounds);
          fillRect(frame, w, headX + headW - px(4), eyeY, eyeW, eyeH, white, bounds);
          fillRect(frame, w, headX + px(2), eyeY, px(1), eyeH, outline, bounds);
          fillRect(frame, w, headX + headW - px(4), eyeY, px(1), eyeH, outline, bounds);
        } else if (dir === 'left') {
          fillRect(frame, w, headX + px(2), eyeY, eyeW, eyeH, outline, bounds);
        } else {
          fillRect(frame, w, headX + headW - px(4), eyeY, eyeW, eyeH, outline, bounds);
        }
      }
    }
  }
  composeFrames(character);
}

/** Deep copy, used by undo snapshots. */
export function cloneCharacter(character: Character): Character {
  const copy = (frames: Frame[]) => frames.map((f) => ({ id: f.id, data: new Uint8ClampedArray(f.data) }));
  return {
    ...character,
    palette: [...character.palette],
    frames: copy(character.frames),
    layers: character.layers.map((layer) => ({ ...layer, frames: copy(layer.frames) })),
    references: character.references.map((reference) => ({ ...reference })),
  };
}

/**
 * Resizes the sprite canvas, keeping the art centred horizontally and anchored
 * to the feet, which is what you want when a character turns out too small to
 * read on the map.
 */
export function resizeCharacter(character: Character, tileSize: number, tilesW: number, tilesH: number): void {
  const nextW = tilesW * tileSize;
  const nextH = tilesH * tileSize;
  if (nextW === character.w && nextH === character.h) return;

  const dx = Math.round((nextW - character.w) / 2);
  const dy = nextH - character.h;

  for (const frame of [...character.frames, ...character.layers.flatMap((layer) => layer.frames)]) {
    const next = new Uint8ClampedArray(nextW * nextH * 4);
    for (let y = 0; y < character.h; y++) {
      const ty = y + dy;
      if (ty < 0 || ty >= nextH) continue;
      for (let x = 0; x < character.w; x++) {
        const tx = x + dx;
        if (tx < 0 || tx >= nextW) continue;
        const from = (y * character.w + x) * 4;
        const to = (ty * nextW + tx) * 4;
        next[to] = frame.data[from];
        next[to + 1] = frame.data[from + 1];
        next[to + 2] = frame.data[from + 2];
        next[to + 3] = frame.data[from + 3];
      }
    }
    frame.data = next;
  }

  character.tilesW = tilesW;
  character.tilesH = tilesH;
  character.w = nextW;
  character.h = nextH;
}
