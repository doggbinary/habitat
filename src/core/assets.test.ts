import { describe, expect, it } from 'vitest';
import {
  deleteAssets,
  detectAssetsInMask,
  assetsInImage,
  splitSheet,
  findGround,
  isGroundSheetName,
  sheetIsAllTiles,
  assetIsGround,
  mergeAssets,
  type SheetGrid,
  type TileGrid,
} from './assets';

/** A sheet built from ASCII art: `#` is opaque, anything else transparent. */
function sheet(rows: string[]): { alpha: Uint8Array; w: number; h: number } {
  const h = rows.length;
  const w = rows[0].length;
  const alpha = new Uint8Array(w * h);
  rows.forEach((row, y) => [...row].forEach((ch, x) => (alpha[y * w + x] = ch === '#' ? 255 : 0)));
  return { alpha, w, h };
}

/** A w x h sheet with solid blocks at the given rects. */
function blocks(w: number, h: number, rects: [number, number, number, number][]) {
  const alpha = new Uint8Array(w * h);
  for (const [x0, y0, bw, bh] of rects) {
    for (let y = y0; y < y0 + bh; y++) for (let x = x0; x < x0 + bw; x++) alpha[y * w + x] = 255;
  }
  return alpha;
}

const tile: TileGrid = { w: 48, h: 48, margin: 0, spacing: 0 };

describe('finding props on a sheet', () => {
  it('finds each separate prop whole, fitted to its pixels', () => {
    const s = sheet([
      '..........',
      '.##....##.',
      '.##....##.',
      '..........',
      '....###...',
      '....###...',
    ]);
    expect(detectAssetsInMask(s.alpha, s.w, s.h, { minArea: 1 })).toEqual([
      { x: 1, y: 1, w: 2, h: 2 },
      { x: 7, y: 1, w: 2, h: 2 },
      { x: 4, y: 4, w: 3, h: 2 },
    ]);
  });

  it('keeps props a single pixel apart separate', () => {
    // The regression that fused stacked trees into one tall blob: sheets pack
    // separate props this close, so nothing may bridge the gap between them.
    const alpha = blocks(200, 200, [
      [0, 0, 96, 96],
      [0, 97, 96, 96],
    ]);
    expect(detectAssetsInMask(alpha, 200, 200, { tile })).toEqual([
      { x: 0, y: 0, w: 96, h: 96 },
      { x: 0, y: 97, w: 96, h: 96 },
    ]);
  });

  it('never cuts a large prop into grid squares', () => {
    // One 5x5-tile fountain: big, but a single piece of art.
    const alpha = blocks(400, 400, [[10, 10, 240, 240], [300, 300, 20, 20]]);
    expect(detectAssetsInMask(alpha, 400, 400, { tile })).toContainEqual({ x: 10, y: 10, w: 240, h: 240 });
  });

  it('drops specks too small to be a prop', () => {
    const alpha = blocks(200, 200, [[0, 0, 2, 2], [100, 100, 40, 40]]);
    expect(detectAssetsInMask(alpha, 200, 200, { tile, minArea: 16 })).toEqual([{ x: 100, y: 100, w: 40, h: 40 }]);
  });

  it('lists props in reading order, row by row', () => {
    const alpha = blocks(200, 200, [
      [100, 0, 40, 40],
      [0, 0, 40, 40],
      [0, 100, 40, 40],
    ]);
    expect(detectAssetsInMask(alpha, 200, 200, { tile }).map((r) => [r.x, r.y])).toEqual([
      [0, 0],
      [100, 0],
      [0, 100],
    ]);
  });
});

describe('rejoining detached scraps', () => {
  it('folds a tiny scrap hugging a big prop into it', () => {
    // A swing frame with a small seat shadow 2px below it.
    const alpha = blocks(200, 200, [[20, 20, 100, 60], [60, 82, 10, 4]]);
    expect(detectAssetsInMask(alpha, 200, 200, { tile })).toEqual([{ x: 20, y: 20, w: 100, h: 66 }]);
  });

  it('leaves a chair beside a table as its own prop', () => {
    // 15x15 is a real prop, not a scrap, even right next to something bigger.
    const alpha = blocks(200, 200, [[20, 20, 60, 60], [82, 40, 15, 15]]);
    expect(detectAssetsInMask(alpha, 200, 200, { tile })).toHaveLength(2);
  });

  it('leaves a scrap alone when nothing big is close enough', () => {
    const alpha = blocks(200, 200, [[20, 20, 60, 60], [100, 100, 8, 8]]);
    expect(detectAssetsInMask(alpha, 200, 200, { tile })).toHaveLength(2);
  });

  it('never lets two small props swallow each other', () => {
    // Two pebbles side by side: neither is big enough to be the other's parent.
    const alpha = blocks(200, 200, [[20, 20, 8, 8], [30, 20, 8, 8]]);
    expect(detectAssetsInMask(alpha, 200, 200, { tile })).toHaveLength(2);
  });
});

describe('fixing detection by hand', () => {
  const a = { x: 0, y: 0, w: 10, h: 10 };
  const b = { x: 20, y: 5, w: 10, h: 20 };
  const c = { x: 50, y: 50, w: 5, h: 5 };

  it('merging covers every picked asset and takes the first one’s place', () => {
    expect(mergeAssets([a, b, c], [2, 0])).toEqual([{ x: 0, y: 0, w: 55, h: 55 }, b]);
  });

  it('merging needs at least two assets', () => {
    expect(mergeAssets([a, b], [1])).toEqual([a, b]);
  });

  it('deleting removes only the picked assets', () => {
    expect(deleteAssets([a, b, c], [1])).toEqual([a, c]);
  });
});

describe('telling ground from props', () => {
  /** A 6 x 4 grid of 10px cells. */
  const grid: SheetGrid = { w: 10, h: 10, margin: 0, spacing: 0, cols: 6, rows: 4 };
  const W = 60;
  const H = 40;
  const cell = (col: number, row: number): [number, number, number, number] => [col * 10, row * 10, 10, 10];
  const groundAt = (cells: Uint8Array) =>
    [...cells].flatMap((v, i) => (v ? [`${i % grid.cols},${Math.floor(i / grid.cols)}`] : []));

  it('counts a run of solid cells as ground, but not one solid cell on its own', () => {
    const alpha = blocks(W, H, [cell(0, 0), cell(1, 0), cell(2, 0), cell(4, 2)]);
    expect(groundAt(findGround(alpha, W, H, grid).cells)).toEqual(['0,0', '1,0', '2,0']);
  });

  it('carries a floor on into a partly filled cell across a solid edge, like a path border', () => {
    // Floor along the top; below its first cell, a border filling the top half.
    const alpha = blocks(W, H, [cell(0, 0), cell(1, 0), [0, 10, 10, 5]]);
    expect(groundAt(findGround(alpha, W, H, grid).cells)).toContain('0,1');
  });

  it('does not let a prop that merely touches a floor become ground', () => {
    // A pole 2px wide standing on the floor's lower edge.
    const alpha = blocks(W, H, [cell(0, 0), cell(1, 0), [14, 10, 2, 10]]);
    expect(groundAt(findGround(alpha, W, H, grid).cells)).not.toContain('1,1');
  });

  it('is not fooled by a floor whose art spills a pixel past the grid line', () => {
    // The floor's bottom row of pixels lands in the cell below, above a small pot.
    const alpha = blocks(W, H, [cell(0, 0), cell(1, 0), [0, 10, 10, 1], [3, 14, 4, 6]]);
    expect(groundAt(findGround(alpha, W, H, grid).cells)).not.toContain('0,1');
  });

  it('counts legs hanging from a counter as part of it', () => {
    // A counter's front edge with two legs below, open in the middle.
    const alpha = blocks(W, H, [cell(0, 0), cell(1, 0), [0, 10, 10, 1], [0, 11, 2, 9], [8, 11, 2, 9]]);
    expect(groundAt(findGround(alpha, W, H, grid).cells)).toContain('0,1');
  });

  it('only reaches one cell out from a floor, so it cannot creep across a sheet', () => {
    // A border below the floor, and another border below that one.
    const alpha = blocks(W, H, [cell(0, 0), cell(1, 0), [0, 10, 10, 5], [0, 20, 10, 5]]);
    expect(groundAt(findGround(alpha, W, H, grid).cells)).not.toContain('0,2');
  });

  it('also offers small solid runs as props, since they are usually things like a fridge', () => {
    const alpha = blocks(W, H, [cell(5, 0), cell(5, 1), cell(0, 3), cell(1, 3), cell(2, 3), cell(3, 3)]);
    expect(findGround(alpha, W, H, grid).props).toEqual([{ x: 50, y: 0, w: 10, h: 20 }]);
  });

  it('treats every drawn cell of a ground sheet as ground, transparent edges and all', () => {
    const alpha = blocks(W, H, [cell(0, 0), [12, 2, 3, 3]]);
    expect(groundAt(findGround(alpha, W, H, grid, true).cells)).toEqual(['0,0', '1,0']);
  });

  it('finds a prop standing beside a floor on its own, instead of fused with the floor', () => {
    // A 3-cell floor with a bush pressed right up against its end.
    const alpha = blocks(W, H, [cell(0, 0), cell(1, 0), cell(2, 0), cell(3, 0), [40, 2, 8, 8]]);
    const ground = findGround(alpha, W, H, grid);
    expect(detectAssetsInMask(alpha, W, H, { minArea: 1, ground })).toEqual([{ x: 40, y: 2, w: 8, h: 8 }]);
  });

  /** An RGBA sheet where each listed cell is filled with one flat colour. */
  const painted = (cells: [number, number, number][]) => {
    const rgba = new Uint8ClampedArray(W * H * 4);
    for (const [col, row, shade] of cells) {
      for (let y = row * 10; y < row * 10 + 10; y++) {
        for (let x = col * 10; x < col * 10 + 10; x++) rgba.set([shade, shade, shade, 255], (y * W + x) * 4);
      }
    }
    return rgba;
  };

  /**
   * A drawing, as opposed to ground: solid, but every square of it is
   * different, the way a facade's windows, doors and roof differ.
   */
  const drawing = (col: number, row: number, cols: number, rows: number, base: number) => {
    const cells: [number, number, number][] = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) cells.push([col + c, row + r, base + (r * cols + c) * 17]);
    }
    return cells;
  };

  it('keeps a solid building as one asset instead of cutting it into squares', () => {
    expect(assetsInImage(painted(drawing(0, 0, 2, 2, 40)), W, H, grid, false)).toEqual([
      { x: 0, y: 0, w: 20, h: 20 },
    ]);
  });

  it('keeps two drawings apart when the background shows between them', () => {
    const rgba = painted([[0, 0, 60], [3, 0, 200]]);
    expect(assetsInImage(rgba, W, H, grid, false)).toEqual([
      { x: 0, y: 0, w: 10, h: 10 },
      { x: 30, y: 0, w: 10, h: 10 },
    ]);
  });

  it('cuts two touching drawings apart at the line where the picture changes', () => {
    // A dark building beside a pale one, with no gap between them.
    const rgba = painted([...drawing(0, 0, 2, 2, 30), ...drawing(2, 0, 2, 2, 190)]);
    expect(assetsInImage(rgba, W, H, grid, false)).toEqual([
      { x: 0, y: 0, w: 20, h: 20 },
      { x: 20, y: 0, w: 20, h: 20 },
    ]);
  });

  it('calls a texture that repeats ground, and offers it a square at a time', () => {
    // The same shade over and over is grass or paving, not a drawing.
    const cells: [number, number, number][] = [];
    for (let c = 0; c < 4; c++) cells.push([c, 0, 120], [c, 1, 120]);
    const { assets, ground } = splitSheet(painted(cells), W, H, grid, false);
    expect(assets).toHaveLength(8);
    expect(ground).toHaveLength(8);
    expect(assets.every((a) => a.w === 10 && a.h === 10)).toBe(true);
  });

  it('leaves a drawing out of the ground, however solid it is', () => {
    const { ground } = splitSheet(painted(drawing(0, 0, 2, 2, 40)), W, H, grid, false);
    expect(ground).toEqual([]);
  });

  it('reads sheet kinds from RPG Maker style names', () => {
    expect(isGroundSheetName('Tile_A2-1 (2)')).toBe(true);
    expect(isGroundSheetName('Auto-tile-A4-walls-3')).toBe(true);
    expect(isGroundSheetName('tile-B-01')).toBe(false);
    expect(isGroundSheetName('1')).toBe(false);
    expect(isGroundSheetName('Area 51')).toBe(false);
    expect(sheetIsAllTiles('Nature Park 1')).toBe(false);
  });

  it('does not call a few leftover pixels in a square a floor tile', () => {
    // Four grass squares, and a square holding only a sliver of the same grass.
    const cells: [number, number, number][] = [];
    for (let c = 0; c < 4; c++) cells.push([c, 0, 120]);
    const rgba = painted(cells);
    for (let x = 0; x < 10; x++) rgba.set([120, 120, 120, 255], (10 * W + x) * 4);
    const { assets, ground } = splitSheet(rgba, W, H, grid, false);
    expect(ground.map((i) => assets[i]).some((a) => a.y === 10)).toBe(false);
  });

  it('treats a unique floor tile next to repeating ground as ground too', () => {
    // Four grass squares and a slightly darker one beside them, like a
    // parking line or a crosswalk sitting in the same paving.
    const cells: [number, number, number][] = [];
    for (let c = 0; c < 4; c++) cells.push([c, 0, 120]);
    cells.push([0, 1, 128]);
    const { ground } = splitSheet(painted(cells), W, H, grid, false);
    expect(ground.length).toBeGreaterThanOrEqual(4);
  });

  it('cuts two props that only kiss at a grid line, like benches in a row', () => {
    const rgba = new Uint8ClampedArray(W * H * 4);
    const fill = (x0: number, y0: number, bw: number, bh: number, shade: number) => {
      for (let y = y0; y < y0 + bh; y++) {
        for (let x = x0; x < x0 + bw; x++) rgba.set([shade, shade, shade, 255], (y * W + x) * 4);
      }
    };
    fill(0, 0, 9, 10, 50);
    fill(11, 0, 9, 10, 200);
    // They only share two pixels on the grid line, the way packed benches do.
    rgba.set([50, 50, 50, 255], (4 * W + 9) * 4);
    rgba.set([200, 200, 200, 255], (4 * W + 10) * 4);
    const assets = assetsInImage(rgba, W, H, grid, false);
    expect(assets.length).toBeGreaterThanOrEqual(2);
    expect(assets.some((a) => a.x < 10 && a.x + a.w <= 10)).toBe(true);
    expect(assets.some((a) => a.x >= 10)).toBe(true);
  });

  it('keeps a two-cell stall whole when the picture continues across the join', () => {
    // Horizontal stripes that match across the seam: an awning or a table.
    const rgba = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < 10; y++) {
      const shade = y < 5 ? 40 : 210;
      for (let x = 0; x < 20; x++) rgba.set([shade, shade, shade, 255], (y * W + x) * 4);
    }
    expect(assetsInImage(rgba, W, H, grid, false)).toEqual([{ x: 0, y: 0, w: 20, h: 10 }]);
  });

  it('drops a leftover white rectangle after punching a painted background', () => {
    const rgba = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < rgba.length; i += 4) rgba.set([255, 255, 255, 255], i);
    const fill = (x0: number, y0: number, bw: number, bh: number, shade: number) => {
      for (let y = y0; y < y0 + bh; y++) {
        for (let x = x0; x < x0 + bw; x++) rgba.set([shade, shade, shade, 255], (y * W + x) * 4);
      }
    };
    fill(2, 2, 8, 8, 40);
    fill(20, 2, 8, 8, 200);
    // Just below the punch threshold, so it survives as an island and
    // has to be recognised as leftover void rather than a prop.
    fill(2, 20, 6, 6, 242);
    const assets = assetsInImage(rgba, W, H, grid, false);
    expect(assets).toEqual([
      { x: 2, y: 2, w: 8, h: 8 },
      { x: 20, y: 2, w: 8, h: 8 },
    ]);
  });

  it('splits props painted on solid white instead of treating the page as one asset', () => {
    const rgba = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < rgba.length; i += 4) rgba.set([255, 255, 255, 255], i);
    const fill = (x0: number, y0: number, bw: number, bh: number, shade: number) => {
      for (let y = y0; y < y0 + bh; y++) {
        for (let x = x0; x < x0 + bw; x++) rgba.set([shade, shade, shade, 255], (y * W + x) * 4);
      }
    };
    fill(2, 2, 8, 8, 40);
    fill(20, 2, 8, 8, 200);
    expect(assetsInImage(rgba, W, H, grid, false)).toEqual([
      { x: 2, y: 2, w: 8, h: 8 },
      { x: 20, y: 2, w: 8, h: 8 },
    ]);
  });

  it('knows which library stickers are floor squares', () => {
    const sheet = {
      name: 'modern city 5',
      groundAssets: [3, 7],
      pathStride: undefined,
    } as import('./doc').Tileset;
    expect(assetIsGround(sheet, 3)).toBe(true);
    expect(assetIsGround(sheet, 0)).toBe(false);
  });
});

describe('pages that are one solid picture', () => {
  /** A fully opaque RGBA sheet filled with one colour. */
  const page = (w: number, h: number, shade: [number, number, number]) => {
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < rgba.length; i += 4) rgba.set([...shade, 255], i);
    return rgba;
  };
  const paint = (rgba: Uint8ClampedArray, W: number, x0: number, y0: number, bw: number, bh: number, c: [number, number, number]) => {
    for (let y = y0; y < y0 + bh; y++) for (let x = x0; x < x0 + bw; x++) rgba.set([...c, 255], (y * W + x) * 4);
  };
  const grid48 = (w: number, h: number): SheetGrid => ({ w: 48, h: 48, margin: 0, spacing: 0, cols: w / 48, rows: h / 48 });

  it('keeps wall pieces separated by dark divider lines instead of dropping the page', () => {
    const W = 192;
    const H = 96;
    const rgba = page(W, H, [10, 10, 10]);
    const colours: [number, number, number][] = [[200, 180, 150], [120, 120, 130], [180, 60, 50], [140, 190, 210]];
    colours.forEach((c, i) => paint(rgba, W, i * 48 + 2, 2, 44, 92, c));
    const { assets } = splitSheet(rgba, W, H, grid48(W, H), false);
    expect(assets).toHaveLength(4);
    expect(assets.every((a) => a.w === 44 && a.h === 92)).toBe(true);
  });

  it('lifts props off a flat white panel on an otherwise solid page', () => {
    const W = 384;
    const H = 192;
    const rgba = page(W, H, [70, 120, 60]);
    paint(rgba, W, 192, 0, 192, 192, [255, 255, 255]);
    for (let y = 0; y < H; y++) for (let x = 0; x < 192; x++) if ((x + y) % 7 === 0) rgba.set([60, 140, 200, 255], (y * W + x) * 4);
    paint(rgba, W, 210, 20, 40, 60, [40, 110, 40]);
    paint(rgba, W, 300, 110, 50, 50, [120, 120, 120]);
    const { assets } = splitSheet(rgba, W, H, grid48(W, H), false);
    expect(assets).toContainEqual({ x: 210, y: 20, w: 40, h: 60 });
    expect(assets).toContainEqual({ x: 300, y: 110, w: 50, h: 50 });
  });

  it('cuts a solid wall of touching 96 px drawings at their own size, not into quarters', () => {
    const W = 384;
    const H = 192;
    const rgba = page(W, H, [0, 0, 0]);
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < 4; c++) {
        const x0 = c * 96;
        const y0 = r * 96;
        paint(rgba, W, x0, y0, 96, 96, [60, 60, 70]);
        paint(rgba, W, x0 + 2, y0 + 2, 92, 92, [150 + c * 20, 150, 160 - r * 40]);
        // Detail like a real appliance, mirrored so the line through the middle matches itself.
        for (let y = y0 + 8; y < y0 + 88; y += 6) paint(rgba, W, x0 + 8, y, 80, 2, [40 + c * 30, 80 + r * 60, 90]);
        paint(rgba, W, x0 + 20, y0 + 30, 16, 16, [250, 220, 40]);
        paint(rgba, W, x0 + 60, y0 + 30, 16, 16, [250, 220, 40]);
      }
    }
    const { assets } = splitSheet(rgba, W, H, grid48(W, H), false);
    expect(assets).toHaveLength(8);
    expect(assets.every((a) => a.w === 96 && a.h === 96)).toBe(true);
  });

  it('makes every square of a page of floor tiles paintable, shoreline squares included', () => {
    const W = 128;
    const H = 128;
    const rgba = page(W, H, [250, 240, 200]);
    paint(rgba, W, 96, 0, 32, 128, [0, 200, 190]);
    // A curving shore through the third column: sand on one side, sea on the other.
    for (let y = 0; y < H; y++) {
      const edge = 64 + Math.round(16 + 12 * Math.sin(y / 14));
      for (let x = 64; x < 96; x++) {
        const c: [number, number, number] = x < edge - 3 ? [250, 240, 200] : x < edge ? [255, 255, 255] : [40, 220, 210];
        rgba.set([...c, 255], (y * W + x) * 4);
      }
    }
    const grid32: SheetGrid = { w: 32, h: 32, margin: 0, spacing: 0, cols: 4, rows: 4 };
    const { assets, ground } = splitSheet(rgba, W, H, grid32, false);
    expect(assets).toHaveLength(16);
    expect(ground).toHaveLength(16);
    expect(assets.every((a) => a.w === 32 && a.h === 32)).toBe(true);
  });

  it('keeps a tall cliff whole beside drawings that repeat at a third of its height', () => {
    const W = 288;
    const H = 192;
    const rgba = page(W, H, [0, 0, 0]);
    // Rock with an outline and cracks, smooth across its middle like a real cliff face.
    paint(rgba, W, 0, 0, 96, 192, [50, 30, 30]);
    for (let y = 2; y < H - 2; y++) {
      for (let x = 2; x < 94; x++) {
        const crack = Math.abs(y - 96) > 8 && y % 12 < 2 && (x >> 3) % 2 === 0;
        rgba.set(crack ? [90, 50, 50, 255] : [150 + (y >> 3), 100 + (y >> 4), 90, 255], (y * W + x) * 4);
      }
    }
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < 2; c++) {
        const x0 = 96 + c * 96;
        const y0 = r * 96;
        paint(rgba, W, x0, y0, 96, 96, [60, 60, 70]);
        paint(rgba, W, x0 + 2, y0 + 2, 92, 92, [120 + c * 50, 170, 160 - r * 40]);
        for (let y = y0 + 8; y < y0 + 88; y += 6) paint(rgba, W, x0 + 8, y, 80, 2, [40 + c * 30, 80 + r * 60, 90]);
      }
    }
    const grid32: SheetGrid = { w: 32, h: 32, margin: 0, spacing: 0, cols: W / 32, rows: H / 32 };
    const { assets } = splitSheet(rgba, W, H, grid32, false);
    expect(assets).toContainEqual({ x: 0, y: 0, w: 96, h: 192 });
    expect(assets.filter((a) => a.x >= 96)).toHaveLength(4);
  });
});

