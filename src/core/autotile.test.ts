import { beforeEach, describe, expect, it } from 'vitest';
import { artworkAutotiles, autotileSheetFields, buildAutotiles, guessFormat, sheetNumber, type AutotileBuild } from '../ai/formats';
import { createImage, fillRect, type RGBAImage } from '../ai/image';
import { env, fileExists, loadPng, repoPath, savePng } from '../test-support/png-node';
import { fakeRenderer, fakeTileset } from '../test-support/fakes';
import { Editor } from '../tools/edit';
import {
  E,
  FLOOR_AUTOTILE_TABLE,
  FLOOR_PREVIEW,
  N,
  NE,
  NW,
  S,
  SE,
  SHAPE_STRIDE,
  SW,
  W,
  WALL_AUTOTILE_TABLE,
  floorShape,
  wallShape,
  type Quarter,
} from './autotile';
import { createDoc, type TileLayer } from './doc';
import { Store } from './store';
import { EMPTY, indexOf, pack } from './tiles';

/**
 * The quarter each corner of a floor tile takes, worked out corner by
 * corner from the A2 layout. Independent of the published table, so the
 * two can be checked against each other.
 */
function cornerRule(mask: number): Quarter[] {
  const has = (bit: number) => !!(mask & bit);
  const corner = (v: boolean, h: boolean, d: boolean, pick: Record<'outer' | 'hEdge' | 'vEdge' | 'inner' | 'middle', Quarter>): Quarter =>
    !v && !h ? pick.outer : !v ? pick.hEdge : !h ? pick.vEdge : !d ? pick.inner : pick.middle;
  return [
    corner(has(N), has(W), has(NW), { outer: [0, 2], hEdge: [2, 2], vEdge: [0, 4], inner: [2, 0], middle: [2, 4] }),
    corner(has(N), has(E), has(NE), { outer: [3, 2], hEdge: [1, 2], vEdge: [3, 4], inner: [3, 0], middle: [1, 4] }),
    corner(has(S), has(W), has(SW), { outer: [0, 5], hEdge: [2, 5], vEdge: [0, 3], inner: [2, 1], middle: [2, 3] }),
    corner(has(S), has(E), has(SE), { outer: [3, 5], hEdge: [1, 5], vEdge: [3, 3], inner: [3, 1], middle: [1, 3] }),
  ];
}

describe('RPG Maker autotile rules', () => {
  it('picks the published floor shape whose pieces match every corner, for all 256 neighbourhoods', () => {
    for (let mask = 0; mask < 256; mask++) expect(FLOOR_AUTOTILE_TABLE[floorShape(mask)]).toEqual(cornerRule(mask));
  });

  it('reaches all 47 neighbour-driven floor shapes and never the preview', () => {
    const shapes = new Set(Array.from({ length: 256 }, (_, m) => floorShape(m)));
    expect(shapes.size).toBe(47);
    expect(shapes.has(FLOOR_PREVIEW)).toBe(false);
  });

  it('picks wall shapes from the four sides', () => {
    expect(wallShape(0)).toBe(15);
    expect(wallShape(N | E | S | W)).toBe(0);
    expect(wallShape(E | W)).toBe(2 | 8);
    for (let shape = 0; shape < 16; shape++) {
      const [tl, tr, bl, br] = WALL_AUTOTILE_TABLE[shape];
      expect(tl).toEqual([shape & 1 ? 0 : 2, shape & 2 ? 0 : 2]);
      expect(tr).toEqual([shape & 4 ? 3 : 1, shape & 2 ? 0 : 2]);
      expect(bl).toEqual([shape & 1 ? 0 : 2, shape & 8 ? 3 : 1]);
      expect(br).toEqual([shape & 4 ? 3 : 1, shape & 8 ? 3 : 1]);
    }
  });
});

describe('recognising sheet layouts', () => {
  it('reads the sheet letter from RPG Maker file names', () => {
    expect(sheetNumber('Tile_A2-1 (2)')).toBe(2);
    expect(sheetNumber('Outside_A4')).toBe(4);
    expect(sheetNumber('Outside_B')).toBeNull();
    expect(sheetNumber('Area51')).toBeNull();
  });

  it('knows A2, A3, A4 and A5 by size, at 48 and 32 px', () => {
    expect(guessFormat('Tile_A2-1 (2)', 768, 576)).toMatchObject({ format: 'rpgmaker-a2', cell: 48, byName: true, autotiles: true });
    expect(guessFormat('ground', 512, 384)).toMatchObject({ format: 'rpgmaker-a2', cell: 32, byName: false });
    expect(guessFormat('roofs', 768, 384)!.slots).toHaveLength(32);
    const a4 = guessFormat('Inside_A4', 768, 720)!;
    expect(a4.slots.filter((s) => s.role === 'wall-top')).toHaveLength(24);
    expect(a4.slots.filter((s) => s.role === 'wall-side')).toHaveLength(24);
    const top = a4.slots.find((s) => s.role === 'wall-top')!;
    expect(a4.slots[top.pair!]).toMatchObject({ role: 'wall-side', rect: { x: top.rect.x, y: top.rect.y + 3 * 48 } });
    expect(guessFormat('Inside_A5', 384, 768)).toMatchObject({ format: 'rpgmaker-a5', autotiles: false });
  });

  it('does not build terrain from animated A1 water, and knows nothing of other sizes', () => {
    expect(guessFormat('World_A1', 768, 576)).toMatchObject({ format: 'rpgmaker-a1', autotiles: false });
    expect(guessFormat('Tile_A2', 700, 576)).toBeNull();
    expect(guessFormat('nature', 384, 336)).toBeNull();
  });

  it('flags blocks whose pieces do not belong together instead of trusting them', async () => {
    // Object art forced into the A2 layout: its quarters were never drawn to meet.
    const houses = await loadPng(repoPath('public/starter/ninja-adventure/houses.png'));
    const sheet = createImage(768, 576);
    for (let y = 0; y < houses.height; y++) sheet.data.set(houses.data.subarray(y * houses.width * 4, (y + 1) * houses.width * 4), y * 768 * 4);
    const build = buildAutotiles(sheet, guessFormat('x', 768, 576)!, 'houses');
    expect(build.sheet.confidence).toBeLessThan(0.3);
    expect(build.sheet.materials.every((m) => m.flags.length > 0)).toBe(true);
  });
});

// --- The user's A2 sheet ------------------------------------------------------

const A2_PATH = env('HABITAT_A2_SHEET') ?? env('HABITAT_TERRAIN_SHEET');
const haveA2 = fileExists(A2_PATH);

describe.skipIf(!haveA2)('Tile_A2-1 (2): the RPG Maker A2 test sheet', () => {
  let image: RGBAImage;
  let build: AutotileBuild;

  beforeEach(async () => {
    image ??= await loadPng(A2_PATH!);
    build ??= buildAutotiles(image, guessFormat('Tile_A2-1 (2)', image.width, image.height)!, 'Tile_A2-1 (2)');
  });

  it('is read as 28 floor materials from 2 x 3 cell blocks, not 168 tiles or 28 giant objects', () => {
    expect(build.sheet.format).toBe('rpgmaker-a2');
    expect(build.sheet.materials).toHaveLength(28);
    expect(build.empty).toBe(4);
    expect(build.sheet.materials.every((m) => m.kind === 'floor' && m.source.w === 96 && m.source.h === 144)).toBe(true);
    expect(build.sheet.confidence).toBeGreaterThanOrEqual(0.9);
    expect(build.sheet.materials.filter((m) => m.flags.length > 0)).toHaveLength(0);
  });

  it('assembles every shape of every material from exact source quarters', () => {
    const { atlas } = build;
    const half = 24;
    build.sheet.materials.forEach((m, row) => {
      FLOOR_AUTOTILE_TABLE.forEach((pieces, shape) => {
        pieces.forEach(([qx, qy], k) => {
          for (let y = 0; y < half; y++) {
            for (let x = 0; x < half; x++) {
              const from = ((m.source.y + qy * half + y) * image.width + m.source.x + qx * half + x) * 4;
              const to = ((row * 48 + Math.floor(k / 2) * half + y) * atlas.width + shape * 48 + (k % 2) * half + x) * 4;
              for (let c = 0; c < 4; c++) if (atlas.data[to + c] !== image.data[from + c]) throw new Error(`${m.name} shape ${shape} quarter ${k} differs at ${x},${y}`);
            }
          }
        });
      });
    });
  });

  it('keeps the preview cell exactly as drawn for the library', () => {
    const m = build.sheet.materials[0];
    for (let y = 0; y < 48; y++) {
      for (let x = 0; x < 48; x++) {
        const a = ((0 * 48 + y) * build.atlas.width + FLOOR_PREVIEW * 48 + x) * 4;
        const b = ((m.source.y + y) * image.width + m.source.x + x) * 4;
        expect(Array.from(build.atlas.data.subarray(a, a + 4))).toEqual(Array.from(image.data.subarray(b, b + 4)));
      }
    }
  });

  it('finds A2-style blocks by their artwork on a sheet of no known size, and rejects object art', async () => {
    const houses = await loadPng(repoPath('public/starter/ninja-adventure/houses.png'));
    const odd = createImage(480, 336);
    const copy = (src: RGBAImage, sx: number, sy: number, w: number, h: number, dx: number, dy: number) => {
      for (let y = 0; y < h; y++) odd.data.set(src.data.subarray(((sy + y) * src.width + sx) * 4, ((sy + y) * src.width + sx + w) * 4), ((dy + y) * odd.width + dx) * 4);
    };
    copy(image, 96, 144, 96, 144, 0, 0);
    copy(houses, 0, 0, 96, 144, 144, 0);
    const found = artworkAutotiles(odd, 48, [
      { x: 0, y: 0, w: 96, h: 144 },
      { x: 144, y: 0, w: 96, h: 144 },
      { x: 288, y: 0, w: 96, h: 96 },
    ]);
    expect(found?.slots.map((s) => s.rect.x)).toEqual([0]);
    expect(found?.byName).toBe(false);
  });

  it('reads the dark south faces as edge pieces of a floor, not as separate raised tiles', () => {
    const styles = build.sheet.materials.map((m) => m.edge.style);
    expect(styles.every((s) => ['seamless', 'border', 'raised-lip', 'cutout'].includes(s))).toBe(true);
    for (const m of build.sheet.materials.filter((x) => x.edge.style === 'raised-lip')) {
      expect(m.edge.depth.s).toBeGreaterThan(m.edge.depth.n);
      expect(m.edge.note).toMatch(/edge pieces/);
    }
  });
});

// --- Painting ------------------------------------------------------------------

describe.skipIf(!haveA2)('painting A2 floors in the editor', () => {
  let store: Store;
  let editor: Editor;
  let layer: TileLayer;
  let build: AutotileBuild;
  const SHEET = 1;

  beforeEach(async () => {
    const image = await loadPng(A2_PATH!);
    build = buildAutotiles(image, guessFormat('Tile_A2-1 (2)', image.width, image.height)!, 'Tile_A2-1 (2)');
    store = new Store();
    // Room around everything drawn, since the map's edge counts as more floor.
    store.doc = createDoc(14, 12, 48);
    const terrain = { ...fakeTileset('terrain', 48), ...autotileSheetFields(build), cols: SHAPE_STRIDE, count: SHAPE_STRIDE * build.sheet.materials.length };
    store.doc.tilesets = [fakeTileset('a', 48), terrain];
    editor = new Editor(store, fakeRenderer);
    layer = store.doc.layers[0] as TileLayer;
  });

  /** The brush a tap on a material in the library gives: its preview cell. */
  const material = (row: number) => pack(SHEET, row * SHAPE_STRIDE + FLOOR_PREVIEW);
  const brush = (row: number) => {
    store.stamp = { w: 1, h: 1, tiles: Int32Array.of(material(row)) };
  };
  const shapeAt = (x: number, y: number) => {
    const t = layer.data[y * store.doc.width + x];
    return t === EMPTY ? null : indexOf(t) % SHAPE_STRIDE;
  };
  const rowAt = (x: number, y: number) => Math.floor(indexOf(layer.data[y * store.doc.width + x]) / SHAPE_STRIDE);
  const stroke = (cells: [number, number][], row = 0) => {
    brush(row);
    editor.beginStroke('Paint');
    for (const [x, y] of cells) editor.paintStamp(x, y);
    editor.endStroke();
  };
  const grid = (x0: number, y0: number, w: number, h: number) => {
    const out: (number | null)[][] = [];
    for (let y = y0; y < y0 + h; y++) out.push(Array.from({ length: w }, (_, i) => shapeAt(x0 + i, y)));
    return out;
  };

  it('one isolated tile gets all four outer corners', () => {
    stroke([[5, 5]]);
    expect(shapeAt(5, 5)).toBe(46);
  });

  it('a large rectangle gets outer corners, edges and a seamless middle', () => {
    editor.beginStroke('Rectangle');
    brush(0);
    editor.fillRect({ x0: 2, y0: 2, x1: 7, y1: 6 }, false);
    editor.endStroke();
    expect(grid(2, 2, 6, 5)).toEqual([
      [34, 20, 20, 20, 20, 36],
      [16, 0, 0, 0, 0, 24],
      [16, 0, 0, 0, 0, 24],
      [16, 0, 0, 0, 0, 24],
      [40, 28, 28, 28, 28, 38],
    ]);
  });

  it('a narrow pathway gets end caps and straight runs both ways', () => {
    stroke([[2, 2], [3, 2], [4, 2], [5, 2]]);
    expect(grid(2, 2, 4, 1)).toEqual([[43, 33, 33, 45]]);
    stroke([[9, 2], [9, 3], [9, 4]]);
    expect(grid(9, 2, 1, 3)).toEqual([[42], [32], [44]]);
  });

  it('an L-shaped pathway turns with an inner corner on the inside of the bend', () => {
    stroke([[2, 2], [2, 3], [2, 4], [3, 4], [4, 4]]);
    expect(grid(2, 2, 3, 3)).toEqual([
      [42, null, null],
      [32, null, null],
      [41, 33, 45],
    ]);
    // Shape 41's top-right quarter is the inner-corner piece from the upper-right cell.
    expect(FLOOR_AUTOTILE_TABLE[41][1]).toEqual([3, 0]);
  });

  it('an area with a hole in it gets inner corners and edges around the gap', () => {
    editor.beginStroke('Rectangle');
    brush(0);
    editor.fillRect({ x0: 2, y0: 2, x1: 6, y1: 6 }, false);
    editor.endStroke();
    editor.beginStroke('Erase');
    editor.erase(4, 4);
    editor.endStroke();
    expect(grid(2, 2, 5, 5)).toEqual([
      [34, 20, 20, 20, 36],
      [16, 8, 28, 4, 24],
      [16, 24, null, 16, 24],
      [16, 2, 20, 1, 24],
      [40, 28, 28, 28, 38],
    ]);
  });

  it('an irregular blob reshapes as it grows and as pieces are erased', () => {
    stroke([[3, 3], [4, 3], [4, 4], [5, 4], [5, 5], [3, 5]]);
    // The lone cell at (3, 5) only touches the blob corner to corner: it stays separate.
    expect(shapeAt(3, 5)).toBe(46);
    stroke([[4, 5]]);
    expect(shapeAt(3, 5)).toBe(43);
    const painted = (): [number, number][] =>
      [[3, 3], [4, 3], [4, 4], [5, 4], [5, 5], [3, 5], [4, 5]].filter(([x, y]) => shapeAt(x, y) !== null) as [number, number][];
    for (const [x, y] of painted()) expect(shapeAt(x, y)).toBe(floorShapeOfMap(x, y));
    editor.beginStroke('Erase');
    editor.erase(4, 4);
    editor.endStroke();
    expect(painted()).toHaveLength(6);
    for (const [x, y] of painted()) expect(shapeAt(x, y)).toBe(floorShapeOfMap(x, y));
  });

  it('keeps two materials apart: each borders where the other begins', () => {
    stroke([[2, 2], [3, 2]], 0);
    stroke([[4, 2]], 5);
    expect([shapeAt(2, 2), shapeAt(3, 2), shapeAt(4, 2)]).toEqual([43, 45, 46]);
    expect([rowAt(2, 2), rowAt(4, 2)]).toEqual([0, 5]);
  });

  it('undo puts the neighbours’ shapes back as they were', () => {
    stroke([[2, 2], [3, 2]]);
    stroke([[4, 2]]);
    expect(grid(2, 2, 3, 1)).toEqual([[43, 33, 45]]);
    editor.undo();
    expect(grid(2, 2, 3, 1)).toEqual([[43, 45, null]]);
    editor.redo();
    expect(grid(2, 2, 3, 1)).toEqual([[43, 33, 45]]);
  });

  it('flood fill treats differently shaped cells of one floor as one area', () => {
    editor.beginStroke('Rectangle');
    brush(0);
    editor.fillRect({ x0: 2, y0: 2, x1: 5, y1: 5 }, false);
    editor.endStroke();
    brush(3);
    editor.beginStroke('Fill');
    editor.floodFill(3, 3, false);
    editor.endStroke();
    for (let y = 2; y <= 5; y++) for (let x = 2; x <= 5; x++) expect(rowAt(x, y)).toBe(3);
    expect(shapeAt(2, 2)).toBe(34);
  });

  /** The expected shape at a cell, from the map as it stands. */
  function floorShapeOfMap(x: number, y: number): number {
    const same = (dx: number, dy: number) => {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= store.doc.width || ny >= store.doc.height) return true;
      return layer.data[ny * store.doc.width + nx] !== EMPTY;
    };
    const mask =
      (same(0, -1) ? N : 0) | (same(1, -1) ? NE : 0) | (same(1, 0) ? E : 0) | (same(1, 1) ? SE : 0) |
      (same(0, 1) ? S : 0) | (same(-1, 1) ? SW : 0) | (same(-1, 0) ? W : 0) | (same(-1, -1) ? NW : 0);
    return floorShape(mask);
  }

  it('renders the test scenarios from the real sheet for review', async () => {
    const out = env('HABITAT_AUTOTILE_OUT');
    if (!out) return;
    const scenes: [string, () => void][] = [
      ['isolated', () => stroke([[1, 1]])],
      ['rectangle', () => { brush(16); editor.beginStroke('R'); editor.fillRect({ x0: 1, y0: 1, x1: 6, y1: 4 }, false); editor.endStroke(); }],
      ['pathway', () => stroke([[1, 2], [2, 2], [3, 2], [4, 2], [5, 2], [6, 2]], 8)],
      ['l-shape', () => stroke([[1, 1], [1, 2], [1, 3], [1, 4], [2, 4], [3, 4], [4, 4], [5, 4]], 24)],
      ['irregular', () => stroke([[2, 1], [3, 1], [1, 2], [2, 2], [3, 2], [4, 2], [2, 3], [3, 3], [4, 3], [5, 3], [3, 4], [4, 4]], 20)],
      ['gaps', () => { brush(26); editor.beginStroke('R'); editor.fillRect({ x0: 1, y0: 1, x1: 6, y1: 5 }, false); editor.erase(3, 3); editor.erase(4, 2); editor.endStroke(); }],
    ];
    for (const [name, draw] of scenes) {
      layer.data.fill(EMPTY);
      draw();
      await savePng(`${out}/${name}.png`, renderLayer(build, layer, 8, 7));
    }
  });

  function renderLayer(b: AutotileBuild, l: TileLayer, w: number, h: number): RGBAImage {
    const img = createImage(w * 48, h * 48, [32, 34, 40, 255]);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if ((x + y) % 2) fillRect(img, { x: x * 48, y: y * 48, w: 48, h: 48 }, [40, 42, 50, 255]);
        const t = l.data[y * store.doc.width + x];
        if (t === EMPTY) continue;
        const i = indexOf(t);
        const sx = (i % SHAPE_STRIDE) * 48;
        const sy = Math.floor(i / SHAPE_STRIDE) * 48;
        for (let yy = 0; yy < 48; yy++) {
          for (let xx = 0; xx < 48; xx++) {
            const from = ((sy + yy) * b.atlas.width + sx + xx) * 4;
            if (b.atlas.data[from + 3] === 0) continue;
            img.data.set(b.atlas.data.subarray(from, from + 4), ((y * 48 + yy) * img.width + x * 48 + xx) * 4);
          }
        }
      }
    }
    return img;
  }
});
