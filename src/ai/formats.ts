import {
  FLOOR_AUTOTILE_TABLE,
  FLOOR_PREVIEW,
  SHAPE_STRIDE,
  WALL_ALONE,
  WALL_AUTOTILE_TABLE,
  composeShape,
  type Pixels,
  type TerrainKind,
} from '../core/autotile';
import type { AutotileMaterial, AutotileSheet, Tileset } from '../core/doc';
import type { Rect, RGBAImage } from './image';

/**
 * Known tileset layouts, read by their specification rather than by looking.
 * RPG Maker MV/MZ (48 px) and VX Ace (32 px) "A" sheets are 16 cells wide:
 *
 *   A1  16 x 12  animated water and waterfalls
 *   A2  16 x 12  ground: 8 x 4 floor blocks of 2 x 3 cells
 *   A3  16 x 8   buildings: 8 x 4 roof and wall blocks of 2 x 2 cells
 *   A4  16 x 15  walls: three bands of 8 wall tops (2 x 3) over 8 wall sides (2 x 2)
 *   A5  8 x 16   plain tiles, one per cell
 */
export type FormatId = 'rpgmaker-a1' | 'rpgmaker-a2' | 'rpgmaker-a3' | 'rpgmaker-a4' | 'rpgmaker-a5';

export interface BlockSlot {
  index: number;
  role: AutotileMaterial['role'];
  kind: TerrainKind;
  rect: Rect;
  /** Slot index of the wall top or side that belongs with this one. */
  pair?: number;
}

export interface FormatGuess {
  format: FormatId;
  cell: number;
  slots: BlockSlot[];
  /** The file name says which sheet it is, rather than only its size. */
  byName: boolean;
  /** Whether Habitat can build terrain from it. */
  autotiles: boolean;
  note: string;
}

/** The RPG Maker sheet letter in a file name: "Tile_A2-1" is 2, "Outside_B" is null. */
export function sheetNumber(name: string): number | null {
  const m = /(?:^|[^a-z0-9])a([1-5])(?:[^0-9]|$)/i.exec(name);
  return m ? Number(m[1]) : null;
}

function blocks(cell: number, cols: number, rows: number, w: number, h: number, y0: number, role: BlockSlot['role'], kind: TerrainKind, start: number): BlockSlot[] {
  const out: BlockSlot[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      out.push({ index: start + out.length, role, kind, rect: { x: c * w * cell, y: y0 + r * h * cell, w: w * cell, h: h * cell } });
    }
  }
  return out;
}

/** Which layout a sheet follows, from its size and name, or null for none known. */
export function guessFormat(name: string, width: number, height: number): FormatGuess | null {
  const number = sheetNumber(name);
  const fits = (cols: number, rows: number) => {
    const cell = width / cols;
    return Number.isInteger(cell) && cell >= 8 && cell % 2 === 0 && height === rows * cell ? cell : 0;
  };
  const a16x12 = fits(16, 12);
  if (a16x12 && number === 1) {
    return { format: 'rpgmaker-a1', cell: a16x12, slots: [], byName: true, autotiles: false, note: 'RPG Maker A1 (animated water). Its animation frames are not supported yet, so it is not turned into terrain.' };
  }
  if (a16x12 && (number === 2 || number === null)) {
    return {
      format: 'rpgmaker-a2',
      cell: a16x12,
      slots: blocks(a16x12, 8, 4, 2, 3, 0, 'floor', 'floor', 0),
      byName: number === 2,
      autotiles: true,
      note: 'RPG Maker A2: 32 floor blocks of 2 x 3 cells. Upper left is the preview, upper right the inner corners, the lower four cells the edges, corners and middle.',
    };
  }
  const a16x8 = fits(16, 8);
  if (a16x8 && (number === 3 || number === null)) {
    return {
      format: 'rpgmaker-a3',
      cell: a16x8,
      slots: blocks(a16x8, 8, 4, 2, 2, 0, 'roof', 'wall', 0),
      byName: number === 3,
      autotiles: true,
      note: 'RPG Maker A3: 32 roof and building-wall blocks of 2 x 2 cells.',
    };
  }
  const a16x15 = fits(16, 15);
  if (a16x15 && (number === 4 || number === null)) {
    const slots: BlockSlot[] = [];
    for (let band = 0; band < 3; band++) {
      const tops = blocks(a16x15, 8, 1, 2, 3, band * 5 * a16x15, 'wall-top', 'floor', slots.length);
      const sides = blocks(a16x15, 8, 1, 2, 2, (band * 5 + 3) * a16x15, 'wall-side', 'wall', slots.length + 8);
      tops.forEach((t, i) => {
        t.pair = sides[i].index;
        sides[i].pair = t.index;
      });
      slots.push(...tops, ...sides);
    }
    return {
      format: 'rpgmaker-a4',
      cell: a16x15,
      slots,
      byName: number === 4,
      autotiles: true,
      note: 'RPG Maker A4: wall tops (2 x 3, floor rules) each paired with the wall face below it (2 x 2, wall rules).',
    };
  }
  const a8x16 = (() => {
    const cell = width / 8;
    return Number.isInteger(cell) && height === cell * 16 ? cell : 0;
  })();
  if (a8x16 && (number === 5 || number === null)) {
    return { format: 'rpgmaker-a5', cell: a8x16, slots: [], byName: number === 5, autotiles: false, note: 'RPG Maker A5: plain tiles, one per cell.' };
  }
  return null;
}

const lum = (d: Uint8ClampedArray, i: number) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

/**
 * Whether a block's pieces belong together. Assembling the all-neighbours
 * middle puts quarters side by side that are not side by side on the sheet;
 * in a real autotile those new joins look like the sheet's own joins at the
 * same half-cell lines. Returns the colour jump across the new joins over
 * the jump across the sheet's own lines: near 1 for a real autotile, high
 * when the quarters were never meant to meet. Panel floors with a line every
 * half cell have strong own joins too, so they still come out near 1.
 */
export function joinRatio(image: RGBAImage, slot: BlockSlot, cell: number): number {
  const half = cell / 2;
  const d = image.data;
  const at = (x: number, y: number) => (y * image.width + x) * 4;
  const diff = (a: number, b: number) => Math.abs(d[a] - d[b]) + Math.abs(d[a + 1] - d[b + 1]) + Math.abs(d[a + 2] - d[b + 2]);
  const table = slot.kind === 'floor' ? FLOOR_AUTOTILE_TABLE : WALL_AUTOTILE_TABLE;
  const middle = composeShape(image, slot.rect, cell, table[0]);
  const m = middle.data;
  const mAt = (x: number, y: number) => (y * cell + x) * 4;
  const mDiff = (a: number, b: number) => Math.abs(m[a] - m[b]) + Math.abs(m[a + 1] - m[b + 1]) + Math.abs(m[a + 2] - m[b + 2]);
  // The middle's quarters come from columns 1-2 and, for floors, rows 3-4
  // (walls: rows 1-2) of the block.
  const top = slot.rect.y + (slot.kind === 'floor' ? 3 : 1) * half;
  const left = slot.rect.x + half;
  let own = 0;
  let made = 0;
  let contrast = 0;
  for (let t = 0; t < cell; t++) {
    own += diff(at(left + half - 1, top + t), at(left + half, top + t)) + diff(at(left + t, top + half - 1), at(left + t, top + half));
    made += mDiff(mAt(half - 1, t), mAt(half, t)) + mDiff(mAt(t, half - 1), mAt(t, half));
    contrast += mDiff(mAt(t, 0), mAt(Math.min(cell - 1, t + 1), 0));
  }
  // Some texture is so smooth its own lines barely change; judge against its general grain then.
  const floor = Math.max(own, (contrast / cell) * cell * 0.5, cell * 2);
  return made / floor;
}

/** Share of a finished tile that is solid. */
export function solidShare(tile: Pixels): number {
  let solid = 0;
  for (let i = 3; i < tile.data.length; i += 4) if (tile.data[i] > 200) solid++;
  return solid / (tile.width * tile.height);
}

function drawnShare(image: RGBAImage, rect: Rect): number {
  let drawn = 0;
  for (let y = rect.y; y < rect.y + rect.h; y++) for (let x = rect.x; x < rect.x + rect.w; x++) if (image.data[(y * image.width + x) * 4 + 3] > 24) drawn++;
  return drawn / (rect.w * rect.h);
}

/**
 * How each side of a lone tile is drawn: how many pixels in from the edge
 * the picture stays different from its middle (darker, lighter or see-through).
 */
export function edgeProfile(tile: Pixels): AutotileMaterial['edge'] {
  const { width: c, data } = tile;
  let mid = 0;
  let midN = 0;
  for (let y = c / 4; y < (3 * c) / 4; y++) {
    for (let x = c / 4; x < (3 * c) / 4; x++) {
      mid += lum(data, (y * c + x) * 4);
      midN++;
    }
  }
  mid /= midN;
  let cutout = false;
  const lineStats = (side: 'n' | 'e' | 's' | 'w', d: number) => {
    let sum = 0;
    let n = 0;
    let clear = 0;
    for (let t = c / 4; t < (3 * c) / 4; t++) {
      const x = side === 'w' ? d : side === 'e' ? c - 1 - d : t;
      const y = side === 'n' ? d : side === 's' ? c - 1 - d : t;
      const i = (y * c + x) * 4;
      if (data[i + 3] < 128) clear++;
      else {
        sum += lum(data, i);
        n++;
      }
    }
    return { mean: n ? sum / n : mid, clear: clear / (c / 2) };
  };
  const depthOf = (side: 'n' | 'e' | 's' | 'w') => {
    let depth = 0;
    for (let d = 0; d < c / 3; d++) {
      const { mean, clear } = lineStats(side, d);
      if (clear > 0.5) cutout = true;
      if (clear > 0.5 || Math.abs(mean - mid) > Math.max(10, mid * 0.12)) depth = d + 1;
      else break;
    }
    return depth;
  };
  const depth = { n: depthOf('n'), e: depthOf('e'), s: depthOf('s'), w: depthOf('w') };
  const southDarker = lineStats('s', 0).mean < mid * 0.85;
  const max = Math.max(depth.n, depth.e, depth.s, depth.w);
  let style: AutotileMaterial['edge']['style'];
  let note: string;
  if (max <= 1) {
    style = 'seamless';
    note = 'No drawn border: the edges are the same texture as the middle.';
  } else if (depth.s >= depth.n + 3 && southDarker) {
    style = 'raised-lip';
    note = `The south edge carries a ${depth.s} px darker face against ${depth.n} px at the north, so the floor reads as raised. In this format that face is part of the floor's edge pieces, not a separate wall tile.`;
  } else if (cutout) {
    style = 'cutout';
    note = 'The edges fade to transparency, so it sits on top of whatever is painted below.';
  } else {
    style = 'border';
    note = `A drawn border about ${max} px deep on every side; flat, not raised.`;
  }
  return { style, depth, note };
}

/** A plain colour word for a material when no model names it. */
export function colourName(tile: Pixels): string {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i < tile.data.length; i += 4) {
    if (tile.data[i + 3] < 128) continue;
    r += tile.data[i];
    g += tile.data[i + 1];
    b += tile.data[i + 2];
    n++;
  }
  if (!n) return 'clear';
  [r, g, b] = [r / n / 255, g / n / 255, b / n / 255];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const s = max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
  if (s < 0.15) return l > 0.8 ? 'white' : l > 0.55 ? 'light grey' : l > 0.3 ? 'grey' : 'dark grey';
  let hue = max === r ? ((g - b) / (max - min)) % 6 : max === g ? (b - r) / (max - min) + 2 : (r - g) / (max - min) + 4;
  hue = (hue * 60 + 360) % 360;
  if (hue < 15 || hue >= 340) return l < 0.35 ? 'dark red' : 'red';
  if (hue < 45) return l < 0.45 ? 'brown' : l > 0.75 ? 'cream' : 'orange';
  if (hue < 70) return l > 0.75 ? 'cream' : l > 0.55 ? 'sand' : 'ochre';
  if (hue < 165) return l < 0.3 ? 'dark green' : 'green';
  if (hue < 200) return 'teal';
  if (hue < 260) return 'blue';
  if (hue < 300) return 'purple';
  return 'pink';
}

export interface AutotileBuild {
  sheet: AutotileSheet;
  /** One material per row, one shape per column, `SHAPE_STRIDE` columns wide. */
  atlas: Pixels;
  /** Slot index on the source sheet for each material row. */
  slotOf: number[];
  /** Blocks that were empty and skipped. */
  empty: number;
}

/** Above this, a block's assembled joins are too strong for its pieces to belong together. */
export const SEAM_LIMIT = 2.2;
/** ...unless the rest of its sheet is clearly autotiles and it stays below this. */
export const SEAM_SOFT_LIMIT = 3.5;

/**
 * Builds working terrain from a recognised sheet: every shape of every
 * material assembled from exact source quarters, plus what the pixels say
 * about each block. Empty blocks are skipped; blocks whose middle does not
 * tile are kept but flagged, never silently trusted.
 */
export function buildAutotiles(image: RGBAImage, guess: FormatGuess, sourceName: string, names?: (string | undefined)[]): AutotileBuild {
  const cell = guess.cell;
  const live = guess.slots.filter((slot) => drawnShare(image, slot.rect) > 0.05);
  const rowOfSlot = new Map(live.map((slot, row) => [slot.index, row]));
  const atlas: Pixels = { width: SHAPE_STRIDE * cell, height: Math.max(1, live.length) * cell, data: new Uint8ClampedArray(SHAPE_STRIDE * cell * Math.max(1, live.length) * cell * 4) };
  const put = (tile: Pixels, col: number, row: number) => {
    for (let y = 0; y < cell; y++) atlas.data.set(tile.data.subarray(y * cell * 4, (y + 1) * cell * 4), ((row * cell + y) * atlas.width + col * cell) * 4);
  };
  const counts = new Map<string, number>();
  const ratios = live.map((slot) => joinRatio(image, slot, cell));
  // A block is judged with its sheet: on a sheet whose blocks clearly behave
  // as autotiles, a block with softer joins is accepted with less confidence.
  const sheetShare = ratios.length ? ratios.filter((r) => r <= SEAM_LIMIT).length / ratios.length : 0;
  const materials: AutotileMaterial[] = live.map((slot, row) => {
    const table = slot.kind === 'floor' ? FLOOR_AUTOTILE_TABLE : WALL_AUTOTILE_TABLE;
    table.forEach((pieces, shape) => put(composeShape(image, slot.rect, cell, pieces), shape, row));
    const alone = composeShape(image, slot.rect, cell, table[slot.kind === 'floor' ? 46 : WALL_ALONE]);
    if (slot.kind === 'wall') put(alone, FLOOR_PREVIEW, row);
    const middle = composeShape(image, slot.rect, cell, table[0]);
    const seam = ratios[row];
    const solid = solidShare(middle);
    const soft = seam > SEAM_LIMIT && seam <= SEAM_SOFT_LIMIT && sheetShare >= 0.8;
    const flags: string[] = [];
    if (seam > SEAM_LIMIT && !soft) flags.push(`Its pieces do not join up (assembled joins ${seam.toFixed(1)}x stronger than the sheet's own); this block may not be an autotile.`);
    if (solid < 0.9) flags.push(`Its middle is only ${Math.round(solid * 100)}% solid; a floor's middle should be solid.`);
    const edge = slot.kind === 'floor' ? edgeProfile(alone) : { style: 'border' as const, depth: { n: 0, e: 0, s: 0, w: 0 }, note: 'Wall and roof pieces: edges follow the 16-shape wall rules.' };
    const word = slot.role === 'floor' ? 'floor' : slot.role === 'roof' ? 'roof' : slot.role === 'wall-top' ? 'wall top' : 'wall face';
    const given = names?.[slot.index]?.trim();
    let name = given || `${colourName(middle)} ${word}`;
    const seen = (counts.get(name) ?? 0) + 1;
    counts.set(name, seen);
    if (seen > 1) name = `${name} ${seen}`;
    const pairRow = slot.pair !== undefined ? rowOfSlot.get(slot.pair) : undefined;
    return {
      name,
      kind: slot.kind,
      role: slot.role,
      source: { ...slot.rect },
      ...(pairRow !== undefined ? { pair: pairRow } : {}),
      edge,
      confidence: flags.length ? 0.4 : soft ? 0.7 : seam > 1.6 ? 0.8 : 0.95,
      flags,
    };
  });
  const passed = materials.filter((m) => m.flags.length === 0).length;
  const confidence = materials.length ? passed / materials.length : 0;
  const notes = [guess.note];
  if (!guess.byName) notes.push('Recognised from the sheet size and confirmed by checking that each block tiles.');
  if (confidence < 0.7) notes.push('Fewer than 70% of blocks behave like autotiles: check that this really is an RPG Maker sheet.');
  return {
    sheet: { format: guess.format as AutotileSheet['format'], cell, materials, sourceName, confidence, notes },
    atlas,
    slotOf: live.map((s) => s.index),
    empty: guess.slots.length - live.length,
  };
}

/**
 * The fields that make an editor sheet out of a build: one library entry
 * per material (its preview), all of them ground, and the shape stride the
 * painter uses to swap shapes.
 */
export function autotileSheetFields(build: AutotileBuild): Pick<Tileset, 'pathStride' | 'assets' | 'groundAssets' | 'autotile' | 'splitMode'> {
  const cell = build.sheet.cell;
  const assets = build.sheet.materials.map((_, row) => ({ x: FLOOR_PREVIEW * cell, y: row * cell, w: cell, h: cell }));
  return {
    pathStride: SHAPE_STRIDE,
    splitMode: 'objects',
    assets,
    groundAssets: assets.map((_, i) => i),
    autotile: build.sheet,
  };
}

/**
 * Terrain blocks found by looking, on a sheet with no known layout. A block
 * of exactly 2 x 3 cells whose pieces join up under the A2 rules is offered
 * as an A2-style material; it is flagged, since nothing but the artwork
 * says it is one.
 */
export function artworkAutotiles(image: RGBAImage, cell: number, blocks: Rect[]): FormatGuess | null {
  if (cell % 2 !== 0) return null;
  const slots: BlockSlot[] = [];
  for (const b of blocks) {
    if (b.w !== 2 * cell || b.h !== 3 * cell || b.x % cell || b.y % cell) continue;
    if (b.x + b.w > image.width || b.y + b.h > image.height) continue;
    const slot: BlockSlot = { index: slots.length, role: 'floor', kind: 'floor', rect: { ...b } };
    const middle = composeShape(image, b, cell, FLOOR_AUTOTILE_TABLE[0]);
    if (solidShare(middle) >= 0.9 && joinRatio(image, slot, cell) <= SEAM_LIMIT) slots.push(slot);
  }
  if (slots.length === 0) return null;
  return {
    format: 'rpgmaker-a2',
    cell,
    slots,
    byName: false,
    autotiles: true,
    note: `Found by looking: ${slots.length} block${slots.length === 1 ? '' : 's'} of 2 x 3 cells whose pieces join up like RPG Maker A2 floors. Built with the A2 rules; check them before relying on them.`,
  };
}

/** Marks every material of a build found from artwork rather than a known layout. */
export function flagArtworkBuild(build: AutotileBuild): AutotileBuild {
  for (const m of build.sheet.materials) {
    m.confidence = Math.min(m.confidence, 0.6);
    m.flags.push('Found from the artwork, not from a known sheet format: check its edges and corners.');
  }
  build.sheet.confidence = Math.min(build.sheet.confidence, 0.6);
  return build;
}
