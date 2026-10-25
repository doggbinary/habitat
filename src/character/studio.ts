import {
  DIRECTIONS,
  applyTemplate,
  createCharacter,
  frameIndex,
  getPixel,
  hexToRgba,
  rgbaToHex,
  sameColor,
  setPixel,
  type Character,
  type Frame,
  type RGBA,
} from './model';

export type PixelTool = 'pencil' | 'eraser' | 'fill' | 'picker';

interface PixelEdit {
  frameId: string;
  before: Uint8ClampedArray;
  after: Uint8ClampedArray;
}

/** Frames are only a few kilobytes, so whole-frame snapshots are the simplest
 * correct undo and cost far less than tracking individual pixels. */
const MAX_HISTORY = 80;

type Listener = (immediate?: boolean) => void;

export class Studio {
  characters: Character[] = [];
  activeCharacter = 0;
  /** The character Play walks, remembered across reloads. */
  lastPlayedId: string | null = null;
  /** Index into `DIRECTIONS`. */
  direction = 0;
  frame = 0;

  tool: PixelTool = 'pencil';
  color = '#2b2139';
  /** Mirror edits across the vertical centre line. */
  mirrorX = false;
  /** Show the previous frame faintly behind this one. */
  onionSkin = true;
  playing = false;
  /** Pixel grid overlay, only drawn when zoomed in far enough to help. */
  showGrid = true;

  private undoStack: PixelEdit[] = [];
  private redoStack: PixelEdit[] = [];
  private strokeBefore: Uint8ClampedArray | null = null;

  private readonly listeners = new Set<Listener>();

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(immediate = false): void {
    for (const listener of [...this.listeners]) listener(immediate);
  }

  get character(): Character | null {
    return this.characters[this.activeCharacter] ?? null;
  }

  rememberPlayed(character: Character): void {
    if (this.lastPlayedId === character.id) return;
    this.lastPlayedId = character.id;
    this.emit(true);
  }

  get currentFrame(): Frame | null {
    const character = this.character;
    if (!character) return null;
    return character.frames[frameIndex(this.direction, this.frame, character.frameCount)] ?? null;
  }

  /** The frame shown behind the current one when onion skinning is on. */
  get onionFrame(): Frame | null {
    const character = this.character;
    if (!character || !this.onionSkin || character.frameCount < 2) return null;
    const previous = (this.frame - 1 + character.frameCount) % character.frameCount;
    return character.frames[frameIndex(this.direction, previous, character.frameCount)] ?? null;
  }

  addCharacter(tileSize: number, tilesW = 2, tilesH = 2, withTemplate = true): Character {
    const character = createCharacter(tileSize, tilesW, tilesH, 4, `Character ${this.characters.length + 1}`);
    if (withTemplate) applyTemplate(character);
    this.characters.push(character);
    this.activeCharacter = this.characters.length - 1;
    this.direction = 0;
    this.frame = 0;
    this.clearHistory();
    this.rememberPlayed(character);
    return character;
  }

  removeCharacter(index: number): void {
    const currentId = this.characters[this.activeCharacter]?.id;
    const removed = this.characters[index];
    this.characters.splice(index, 1);
    if (removed && this.lastPlayedId === removed.id) this.lastPlayedId = this.characters[0]?.id ?? null;
    const keepId = currentId !== removed?.id ? currentId : this.lastPlayedId;
    const kept = this.characters.findIndex((character) => character.id === keepId);
    this.activeCharacter = kept >= 0 ? kept : 0;
    this.clearHistory();
    this.emit(true);
  }

  select(direction: number, frame: number): void {
    this.direction = direction;
    this.frame = frame;
    this.emit();
  }

  // --- Editing -------------------------------------------------------------

  /** Captures the frame so the whole stroke becomes one undo step. */
  beginStroke(): void {
    const frame = this.currentFrame;
    if (!frame) return;
    this.strokeBefore = new Uint8ClampedArray(frame.data);
  }

  endStroke(): void {
    const before = this.strokeBefore;
    this.strokeBefore = null;
    const frame = this.currentFrame;
    if (!before || !frame) return;
    // Nothing actually changed, so do not clutter the history.
    if (equal(before, frame.data)) return;

    this.undoStack.push({ frameId: frame.id, before, after: new Uint8ClampedArray(frame.data) });
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack = [];
    this.emit();
  }

  private paintPixel(frame: Frame, w: number, h: number, x: number, y: number, color: RGBA): void {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    setPixel(frame, w, x, y, color);
    if (this.mirrorX) {
      const mx = w - 1 - x;
      if (mx !== x) setPixel(frame, w, mx, y, color);
    }
  }

  /** Paints one cell with the active tool. Returns false when nothing happened. */
  paint(x: number, y: number): boolean {
    const character = this.character;
    const frame = this.currentFrame;
    if (!character || !frame) return false;
    const { w, h } = character;
    if (x < 0 || y < 0 || x >= w || y >= h) return false;

    if (this.tool === 'picker') {
      const picked = getPixel(frame, w, x, y);
      if (picked[3] === 0) return false;
      this.color = rgbaToHex(picked[0], picked[1], picked[2]);
      this.tool = 'pencil';
      this.emit();
      return true;
    }

    if (this.tool === 'fill') {
      this.floodFill(frame, w, h, x, y);
      return true;
    }

    const color: RGBA = this.tool === 'eraser' ? [0, 0, 0, 0] : hexToRgba(this.color);
    this.paintPixel(frame, w, h, x, y, color);
    return true;
  }

  /** Joins two samples so a fast stroke leaves no gaps. */
  paintLine(x0: number, y0: number, x1: number, y1: number): void {
    let x = x0;
    let y = y0;
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.paint(x, y);
      if (x === x1 && y === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y += sy;
      }
    }
  }

  private floodFill(frame: Frame, w: number, h: number, x: number, y: number): void {
    const target = getPixel(frame, w, x, y);
    const replacement: RGBA = this.tool === 'eraser' ? [0, 0, 0, 0] : hexToRgba(this.color);
    if (sameColor(target, replacement)) return;

    const seen = new Uint8Array(w * h);
    const stack = [y * w + x];
    seen[stack[0]] = 1;

    while (stack.length > 0) {
      const index = stack.pop()!;
      const cx = index % w;
      const cy = (index / w) | 0;
      // Mirroring a fill would fight itself, so write directly here.
      setPixel(frame, w, cx, cy, replacement);

      const push = (nx: number, ny: number) => {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) return;
        const ni = ny * w + nx;
        if (seen[ni]) return;
        if (!sameColor(getPixel(frame, w, nx, ny), target)) return;
        seen[ni] = 1;
        stack.push(ni);
      };
      push(cx + 1, cy);
      push(cx - 1, cy);
      push(cx, cy + 1);
      push(cx, cy - 1);
    }
  }

  clearFrame(): void {
    const frame = this.currentFrame;
    if (!frame) return;
    this.beginStroke();
    frame.data.fill(0);
    this.endStroke();
  }

  /** Copies the current frame onto every other step of this direction. */
  copyToAllFrames(): void {
    const character = this.character;
    const source = this.currentFrame;
    if (!character || !source) return;
    for (let f = 0; f < character.frameCount; f++) {
      if (f === this.frame) continue;
      const target = character.frames[frameIndex(this.direction, f, character.frameCount)];
      this.undoStack.push({
        frameId: target.id,
        before: new Uint8ClampedArray(target.data),
        after: new Uint8ClampedArray(source.data),
      });
      target.data.set(source.data);
    }
    this.redoStack = [];
    this.emit();
  }

  /** Mirrors the current frame onto the opposite facing, flipped. */
  mirrorToOppositeDirection(): void {
    const character = this.character;
    const source = this.currentFrame;
    if (!character || !source) return;
    const dir = DIRECTIONS[this.direction];
    const oppositeName = dir === 'left' ? 'right' : dir === 'right' ? 'left' : null;
    if (!oppositeName) return;

    const opposite = DIRECTIONS.indexOf(oppositeName);
    const target = character.frames[frameIndex(opposite, this.frame, character.frameCount)];
    const { w, h } = character;
    const before = new Uint8ClampedArray(target.data);

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const from = (y * w + x) * 4;
        const to = (y * w + (w - 1 - x)) * 4;
        target.data[to] = source.data[from];
        target.data[to + 1] = source.data[from + 1];
        target.data[to + 2] = source.data[from + 2];
        target.data[to + 3] = source.data[from + 3];
      }
    }

    this.undoStack.push({ frameId: target.id, before, after: new Uint8ClampedArray(target.data) });
    this.redoStack = [];
    this.emit();
  }

  // --- History -------------------------------------------------------------

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  clearHistory(): void {
    this.undoStack = [];
    this.redoStack = [];
  }

  private frameById(id: string): Frame | null {
    for (const character of this.characters) {
      const found = character.frames.find((f) => f.id === id);
      if (found) return found;
    }
    return null;
  }

  undo(): void {
    const entry = this.undoStack.pop();
    if (!entry) return;
    this.frameById(entry.frameId)?.data.set(entry.before);
    this.redoStack.push(entry);
    this.emit();
  }

  redo(): void {
    const entry = this.redoStack.pop();
    if (!entry) return;
    this.frameById(entry.frameId)?.data.set(entry.after);
    this.undoStack.push(entry);
    this.emit();
  }
}

function equal(a: Uint8ClampedArray, b: Uint8ClampedArray): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
