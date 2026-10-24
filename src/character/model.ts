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
  /** `DIRECTIONS.length * frameCount` frames, direction-major. */
  frames: Frame[];
  palette: string[];
  /** Milliseconds per frame when previewing. */
  frameMs: number;
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

function emptyFrame(w: number, h: number): Frame {
  return { id: uid('frame'), data: new Uint8ClampedArray(w * h * 4) };
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
  return {
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

  for (let d = 0; d < DIRECTIONS.length; d++) {
    const dir = DIRECTIONS[d];
    for (let f = 0; f < frameCount; f++) {
      const frame = character.frames[frameIndex(d, f, frameCount)];
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
}

/** Deep copy, used by undo snapshots. */
export function cloneCharacter(character: Character): Character {
  return {
    ...character,
    palette: [...character.palette],
    frames: character.frames.map((f) => ({ id: f.id, data: new Uint8ClampedArray(f.data) })),
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

  for (const frame of character.frames) {
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
