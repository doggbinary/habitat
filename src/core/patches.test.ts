import { describe, expect, it } from 'vitest';
import { editSheetAssets, groundPatches, patchTileAt, type SheetGrid } from './assets';
import { createDoc, type TileLayer } from './doc';
import { Store } from './store';
import { indexOf, pack } from './tiles';
import { fakeRenderer, fakeTileset } from '../test-support/fakes';
import { Editor } from '../tools/edit';

/** A sheet 4 squares by 2 of 8 px squares, each a flat colour. */
function sheetOf(colours: number[][]): { rgba: Uint8ClampedArray; w: number; h: number; grid: SheetGrid } {
  const cols = 4;
  const rows = 2;
  const size = 8;
  const w = cols * size;
  const h = rows * size;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = colours[Math.floor(y / size) * cols + Math.floor(x / size)];
      rgba.set([r, g, b, 255], (y * w + x) * 4);
    }
  }
  return { rgba, w, h, grid: { w: size, h: size, margin: 0, spacing: 0, cols, rows } };
}

describe('ground patches', () => {
  it('groups squares that look alike into one patch, apart from different ground', () => {
    const grass = [60, 140, 60];
    const grass2 = [64, 136, 58];
    const dirt = [150, 110, 70];
    const s = sheetOf([grass, grass2, grass, dirt, grass2, grass, grass2, dirt]);
    const terrain = new Uint8Array(8).fill(1);
    const patches = groundPatches(s.rgba, s.w, s.h, s.grid, terrain);
    expect(patches).toContainEqual({ x: 0, y: 0, w: 24, h: 16 });
    expect(patches).toContainEqual({ x: 24, y: 0, w: 8, h: 16 });
  });

  it('paints each map square with the patch square that falls there', () => {
    const sheet = fakeTileset('floor', 16);
    sheet.cols = 4;
    sheet.rows = 4;
    sheet.count = 16;
    sheet.groundBlocks = [{ x: 16, y: 16, w: 48, h: 32 }];
    // Square (1,1) is the patch's top-left; at map (0,0) it stays itself.
    expect(patchTileAt(sheet, 5, 0, 0)).toBe(5);
    expect(patchTileAt(sheet, 5, 1, 0)).toBe(6);
    expect(patchTileAt(sheet, 5, 2, 1)).toBe(11);
    expect(patchTileAt(sheet, 5, 3, 2)).toBe(5);
    // A square outside every patch is left alone.
    expect(patchTileAt(sheet, 0, 3, 3)).toBe(0);
  });

  it('moves a 2 by 2 asset to paths as four squares in one patch, and back again', () => {
    const sheet = fakeTileset('lawn', 16);
    sheet.cols = 4;
    sheet.rows = 4;
    sheet.count = 16;
    sheet.assets = [
      { x: 0, y: 0, w: 10, h: 12 },
      { x: 16, y: 16, w: 32, h: 32 },
    ];
    sheet.groundAssets = [];
    const moved = editSheetAssets(sheet, 'toGround', [1]);
    expect(moved.assets).toHaveLength(5);
    expect(moved.ground).toHaveLength(4);
    expect(moved.patches).toEqual([{ x: 16, y: 16, w: 32, h: 32 }]);

    Object.assign(sheet, { assets: moved.assets, groundAssets: moved.ground, groundBlocks: moved.patches });
    const back = editSheetAssets(sheet, 'toObjects', [moved.ground[0]]);
    expect(back.ground).toEqual([]);
    expect(back.patches).toEqual([]);
    expect(back.assets).toContainEqual({ x: 16, y: 16, w: 32, h: 32 });
    expect(back.assets).toHaveLength(2);
  });

  it('keeps ground squares marked through merge and delete', () => {
    const sheet = fakeTileset('mix', 16);
    sheet.cols = 4;
    sheet.rows = 1;
    sheet.count = 4;
    sheet.assets = [
      { x: 0, y: 0, w: 8, h: 8 },
      { x: 16, y: 0, w: 16, h: 16 },
      { x: 34, y: 0, w: 6, h: 6 },
      { x: 48, y: 0, w: 16, h: 16 },
    ];
    sheet.groundAssets = [1, 3];
    const deleted = editSheetAssets(sheet, 'delete', [0]);
    expect(deleted.ground.map((i) => deleted.assets[i])).toEqual([sheet.assets[1], sheet.assets[3]]);
    const merged = editSheetAssets(sheet, 'merge', [0, 2]);
    expect(merged.ground.map((i) => merged.assets[i])).toEqual([sheet.assets[1], sheet.assets[3]]);
  });

  it('paints exactly the picked square, never its neighbours in the patch', () => {
    const store = new Store();
    store.doc = createDoc(6, 6, 16);
    const sheet = fakeTileset('floor', 16);
    sheet.cols = 3;
    sheet.rows = 3;
    sheet.count = 9;
    sheet.groundBlocks = [{ x: 0, y: 0, w: 48, h: 48 }];
    store.doc.tilesets = [sheet];
    store.stamp = { w: 1, h: 1, tiles: Int32Array.of(pack(0, 4)) };
    const editor = new Editor(store, fakeRenderer);
    editor.beginStroke('Rectangle');
    editor.fillRect({ x0: 0, y0: 0, x1: 2, y1: 2 }, false);
    editor.endStroke();
    const layer = store.doc.layers[0] as TileLayer;
    const painted = [0, 1, 2].flatMap((y) => [0, 1, 2].map((x) => indexOf(layer.data[y * 6 + x])));
    expect(painted).toEqual([4, 4, 4, 4, 4, 4, 4, 4, 4]);
  });
});
