import {
  DIRECTIONS,
  applyTemplate,
  composeFrames,
  createCharacter,
  createLayer,
  duplicateCharacter,
  type CharacterLayer,
  frameIndex,
  getPixel,
  hexToRgba,
  resizeCharacter,
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
  /** Folders in the character library, in the order they were made. */
  folders: string[] = [];
  activeCharacter = 0;
  /** The character Play walks, remembered across reloads. */
  lastPlayedId: string | null = null;
  /** Canvas size, in tiles, the last time a stroke changed any pixels. */
  lastSize: { tilesW: number; tilesH: number } | null = null;
  /** Index into `DIRECTIONS`. */
  direction = 0;
  frame = 0;

  tool: PixelTool = 'pencil';
  /** Square brush sizes in pixels. The eraser starts bigger: clearing is rarely one pixel at a time. */
  pencilSize = 1;
  eraserSize = 3;
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

  /** Tells listeners something changed, after flattening the open character's layers. */
  emit(immediate = false): void {
    const character = this.character;
    if (character) composeFrames(character);
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

  get layer(): CharacterLayer | null {
    const character = this.character;
    if (!character) return null;
    return character.layers[character.activeLayer] ?? character.layers[0] ?? null;
  }

  /** The frame being drawn on: this pose, on the chosen layer. */
  get currentFrame(): Frame | null {
    const character = this.character;
    const layer = this.layer;
    if (!character || !layer) return null;
    return layer.frames[frameIndex(this.direction, this.frame, character.frameCount)] ?? null;
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

  /** Starts a new character from a copy of one, layers, pictures and all, and opens it. */
  duplicate(index = this.activeCharacter): Character | null {
    const source = this.characters[index];
    if (!source) return null;
    const copy = duplicateCharacter(source);
    this.characters.splice(index + 1, 0, copy);
    this.activeCharacter = index + 1;
    this.clearHistory();
    this.emit(true);
    return copy;
  }

  // --- Layers --------------------------------------------------------------

  addLayer(): void {
    const character = this.character;
    if (!character) return;
    const layer = createLayer(character, `Layer ${character.layers.length + 1}`);
    character.layers.splice(character.activeLayer + 1, 0, layer);
    character.activeLayer += 1;
    this.emit(true);
  }

  selectLayer(index: number): void {
    const character = this.character;
    if (!character || index < 0 || index >= character.layers.length) return;
    character.activeLayer = index;
    this.emit();
  }

  /** The last layer stays: a character always has something to draw on. */
  removeLayer(index: number): void {
    const character = this.character;
    if (!character || character.layers.length < 2) return;
    character.layers.splice(index, 1);
    character.activeLayer = Math.max(0, Math.min(character.layers.length - 1, character.activeLayer - (index <= character.activeLayer ? 1 : 0)));
    this.emit(true);
  }

  /** Moves a layer up (+1, in front) or down (-1, behind), keeping it chosen. */
  moveLayer(index: number, by: number): void {
    const character = this.character;
    const to = index + by;
    if (!character || to < 0 || to >= character.layers.length) return;
    const [layer] = character.layers.splice(index, 1);
    character.layers.splice(to, 0, layer);
    if (character.activeLayer === index) character.activeLayer = to;
    else if (character.activeLayer === to) character.activeLayer = index;
    this.emit(true);
  }

  toggleLayer(index: number): void {
    const layer = this.character?.layers[index];
    if (!layer) return;
    layer.visible = !layer.visible;
    this.emit();
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

  /** Moves to the next (or, with -1, previous) frame of this direction, wrapping around. */
  stepFrame(by: number): void {
    const count = this.character?.frameCount ?? 0;
    if (count < 2) return;
    this.select(this.direction, (((this.frame + by) % count) + count) % count);
  }

  /** Stamps the current colour into the palette. Returns false when it is already there. */
  stampColor(): boolean {
    const character = this.character;
    if (!character) return false;
    const hex = this.color.toLowerCase();
    if (character.palette.some((swatch) => swatch.toLowerCase() === hex)) return false;
    character.palette.push(this.color);
    this.emit();
    return true;
  }

  removeSwatch(index: number): void {
    const character = this.character;
    if (!character || index < 0 || index >= character.palette.length) return;
    character.palette.splice(index, 1);
    this.emit();
  }

  // --- Editing -------------------------------------------------------------

  /** Captures the frame so the whole stroke becomes one undo step. */
  beginStroke(): void {
    const frame = this.currentFrame;
    if (!frame) return;
    this.strokeBefore = new Uint8ClampedArray(frame.data);
  }

  /**
   * Takes back the stroke in progress, as if it never happened, without
   * touching the undo history: strokes finished earlier always stay.
   */
  cancelStroke(): void {
    const before = this.strokeBefore;
    this.strokeBefore = null;
    const frame = this.currentFrame;
    if (!before || !frame) return;
    frame.data.set(before);
    this.emit();
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
    const character = this.character;
    if (character) this.lastSize = { tilesW: character.tilesW, tilesH: character.tilesH };
    this.emit();
  }

  /** Changes the open character's canvas, keeping the art centred on its feet. */
  resizeCanvas(tileSize: number, tilesW: number, tilesH: number): void {
    const character = this.character;
    if (!character) return;
    resizeCharacter(character, tileSize, tilesW, tilesH);
    this.clearHistory();
    this.emit(true);
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
      // What you see, across every layer, even mid-stroke.
      const index = frameIndex(this.direction, this.frame, character.frameCount);
      composeFrames(character, index);
      const shown = character.frames[index] ?? frame;
      const picked = getPixel(shown, w, x, y);
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

    const erasing = this.tool === 'eraser';
    const color: RGBA = erasing ? [0, 0, 0, 0] : hexToRgba(this.color);
    // A square brush centred on the touched pixel, leaning up and left for even sizes.
    const size = this.brushSize;
    const from = Math.floor((size - 1) / 2);
    for (let dy = 0; dy < size; dy++) {
      for (let dx = 0; dx < size; dx++) this.paintPixel(frame, w, h, x - from + dx, y - from + dy, color);
    }
    return true;
  }

  /** The square size the active tool paints, 1 for tools without one. */
  get brushSize(): number {
    if (this.tool === 'eraser') return this.eraserSize;
    if (this.tool === 'pencil') return this.pencilSize;
    return 1;
  }

  set brushSize(size: number) {
    const next = Math.max(1, Math.min(16, Math.round(size)));
    if (this.tool === 'eraser') this.eraserSize = next;
    else if (this.tool === 'pencil') this.pencilSize = next;
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
    const layer = this.layer!;
    for (let f = 0; f < character.frameCount; f++) {
      if (f === this.frame) continue;
      const target = layer.frames[frameIndex(this.direction, f, character.frameCount)];
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
    const target = this.layer!.frames[frameIndex(opposite, this.frame, character.frameCount)];
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
      for (const layer of character.layers) {
        const found = layer.frames.find((f) => f.id === id);
        if (found) return found;
      }
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
