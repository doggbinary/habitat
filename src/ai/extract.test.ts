import { describe, expect, it } from 'vitest';
import { splitSheet } from '../core/assets';
import { loadPng, repoPath, readJson, env, fileExists } from '../test-support/png-node';
import { mergeAcrossRegions, parseDetection, planRegions, renderRegion } from './detect';
import { detectCellSize, findForeground, labelComponents } from './foreground';
import { createImage, fillRect, type Colour, type Rect, type RGBAImage } from './image';
import { auditCrops, assetImage, exportBundle, librarySheet, packAtlas } from './output';
import { claimBox, deleteSelected, mergeSelected, setKind } from './manual';
import { extractSheet } from './pipeline';
import { decodePng, encodePng, streamZlib } from './png';
import { competeForPixels, refine, type SheetAnalysis } from './refine';
import type { Proposal, TerrainProposal } from './types';
import { checkAssets, groupLeftovers, parseReinspection } from './verify';
import { buildRequest, configFromEnv, createVisionClient, replyText, VisionError } from './vision';

/*
 * Every test here runs on fixtures: drawn sheets, the CC0 starter pack, and
 * proposals written out by hand. No test calls a vision model; the live run
 * is in acceptance.live.test.ts and only runs with a key.
 */

function analyse(image: RGBAImage, cell: number | null = null): SheetAnalysis {
  const fg = findForeground(image);
  return { image, fg, comps: labelComponents(fg.mask, image.width, image.height), cell };
}

let n = 0;
function proposal(name: string, bbox: Rect, marks: number[] = [], extra: Partial<Proposal> = {}): Proposal {
  return { id: `t${++n}`, name, category: 'other', kind: 'object', bbox, marks, confidence: 0.9, source: 'model', region: 0, ...extra };
}

/** A filled blob with a dark one-pixel outline, the way pixel-art props are drawn. */
function blob(img: RGBAImage, cx: number, cy: number, rx: number, ry: number, fill: Colour, line: Colour = [20, 20, 30, 255]): void {
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      const d = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
      if (d > 1) continue;
      const edge = ((x - cx) / (rx - 1.2)) ** 2 + ((y - cy) / (ry - 1.2)) ** 2 > 1;
      if (x >= 0 && y >= 0 && x < img.width && y < img.height) img.data.set(edge ? line : fill, (y * img.width + x) * 4);
    }
  }
}

const pixelAt = (img: RGBAImage, x: number, y: number) => Array.from(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));

describe('PNG codec', () => {
  it('round-trips every byte, half-transparent pixels included', async () => {
    const img = createImage(7, 5);
    for (let i = 0; i < img.data.length; i++) img.data[i] = (i * 37) % 256;
    const back = await decodePng(await encodePng(img, streamZlib), streamZlib);
    expect(back.width).toBe(7);
    expect(Array.from(back.data)).toEqual(Array.from(img.data));
  });

  it('reads the starter sheets', async () => {
    const nature = await loadPng(repoPath('public/starter/ninja-adventure/nature.png'));
    expect([nature.width, nature.height]).toEqual([384, 336]);
  });
});

describe('finding the drawing', () => {
  it('reads a transparent sheet from its alpha', () => {
    const img = createImage(20, 10);
    fillRect(img, { x: 2, y: 2, w: 4, h: 4 }, [200, 0, 0, 255]);
    const fg = findForeground(img);
    expect(fg.background).toBe('alpha');
    expect(fg.mask.reduce((a, b) => a + b, 0)).toBe(16);
  });

  it('removes a flat backdrop only where it reaches the edge, keeping the same colour inside a sprite', () => {
    const img = createImage(30, 30, [255, 255, 255, 255]);
    fillRect(img, { x: 5, y: 5, w: 10, h: 10 }, [10, 10, 10, 255]);
    fillRect(img, { x: 8, y: 8, w: 4, h: 4 }, [255, 255, 255, 255]); // a white eye, enclosed
    const fg = findForeground(img);
    expect(fg.background).toBe('colour');
    expect(fg.colour).toEqual([255, 255, 255]);
    expect(fg.mask[9 * 30 + 9]).toBe(1);
    expect(fg.mask[0]).toBe(0);
    expect(fg.mask.reduce((a, b) => a + b, 0)).toBe(100);
  });

  it('finds the cell size from the seams', async () => {
    const img = createImage(192, 96);
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < 4; c++) {
        const shade = 60 + ((r * 4 + c) * 23) % 150;
        fillRect(img, { x: c * 48, y: r * 48, w: 48, h: 48 }, [shade, 255 - shade, 90, 255]);
        for (let k = 0; k < 40; k++) img.data.set([shade + 8, 250 - shade, 95, 255], (((r * 48 + 7 + (k % 30)) * 192) + c * 48 + 5 + ((k * 7) % 38)) * 4);
      }
    }
    const fg = findForeground(img);
    expect(detectCellSize(img, fg.mask)).toBe(48);
  });
});

describe('refinement on the original pixels', () => {
  it('keeps a tree whose crown, trunk and a leaf are separate islands as one asset', () => {
    const img = createImage(60, 60);
    blob(img, 20, 15, 12, 10, [60, 160, 60, 255]);
    fillRect(img, { x: 18, y: 27, w: 5, h: 12 }, [110, 70, 30, 255]); // trunk, one pixel below the crown
    fillRect(img, { x: 35, y: 30, w: 2, h: 2 }, [60, 160, 60, 255]); // falling leaf
    const sheet = analyse(img);
    expect(sheet.comps.list.length).toBe(3);
    const crown = sheet.comps.labels[15 * 60 + 20];
    const trunk = sheet.comps.labels[30 * 60 + 20];
    const out = refine(sheet, [proposal('tree', { x: 8, y: 5, w: 25, h: 34 }, [crown, trunk])], []);
    expect(out.assets).toHaveLength(1);
    expect(out.leftovers).toEqual([]);
    expect(out.assets[0].rect).toEqual({ x: 8, y: 5, w: 29, h: 34 });
    expect(auditCrops(img, out.assets)).toEqual([]);
  });

  it('keeps two trees a pixel apart as two assets', () => {
    const img = createImage(60, 30);
    blob(img, 12, 14, 11, 12, [60, 160, 60, 255]);
    blob(img, 36, 14, 11, 12, [60, 160, 60, 255]);
    const sheet = analyse(img);
    const [a, b] = sheet.comps.list;
    const out = refine(sheet, [proposal('tree', a, [a.id]), proposal('tree', b, [b.id])], []);
    expect(out.assets).toHaveLength(2);
    expect(auditCrops(img, out.assets)).toEqual([]);
  });

  it('keeps a bench spanning three cells whole', () => {
    const img = createImage(96, 32);
    fillRect(img, { x: 4, y: 10, w: 88, h: 6 }, [150, 100, 50, 255]);
    fillRect(img, { x: 8, y: 16, w: 4, h: 10 }, [90, 60, 30, 255]);
    fillRect(img, { x: 84, y: 16, w: 4, h: 10 }, [90, 60, 30, 255]);
    const sheet = analyse(img, 32);
    const out = refine(sheet, [proposal('bench', { x: 4, y: 10, w: 88, h: 16 }, [1])], []);
    expect(out.assets).toHaveLength(1);
    expect(out.assets[0].rect).toEqual({ x: 4, y: 10, w: 88, h: 16 });
  });

  it('splits two touching bushes along their outlines, not along a straight line', () => {
    const img = createImage(70, 40);
    blob(img, 20, 20, 16, 14, [40, 150, 40, 255]);
    blob(img, 48, 20, 14, 12, [200, 80, 160, 255]);
    const truth = new Int8Array(70 * 40).fill(-1);
    // What each bush would be on its own, the left one drawn first and overlapped by the right.
    for (let y = 0; y < 40; y++) {
      for (let x = 0; x < 70; x++) {
        if (((x - 48) / 14) ** 2 + ((y - 20) / 12) ** 2 <= 1) truth[y * 70 + x] = 1;
        else if (((x - 20) / 16) ** 2 + ((y - 20) / 14) ** 2 <= 1) truth[y * 70 + x] = 0;
      }
    }
    const sheet = analyse(img);
    expect(sheet.comps.list).toHaveLength(1);
    // Rough boxes that overlap, the way a model reads them off a ruler.
    const out = refine(sheet, [proposal('bush', { x: 3, y: 5, w: 36, h: 31 }, [1]), proposal('flower bush', { x: 33, y: 7, w: 31, h: 27 }, [1])], []);
    expect(out.assets).toHaveLength(2);
    expect(out.splits).toEqual([[0, 1]]);
    let right = 0;
    let total = 0;
    out.assets.forEach((a, k) => {
      for (const i of a.pixels) {
        total++;
        if (truth[i] === k) right++;
      }
    });
    expect(right / total).toBeGreaterThan(0.97);
    expect(auditCrops(img, out.assets)).toEqual([]);
  });

  it('never gives a pixel to two assets, and leaves the neighbour out of the crop', () => {
    const img = createImage(40, 20);
    fillRect(img, { x: 0, y: 0, w: 20, h: 20 }, [255, 0, 0, 255]);
    fillRect(img, { x: 20, y: 0, w: 20, h: 20 }, [0, 0, 255, 255]);
    const sheet = analyse(img);
    const out = refine(sheet, [proposal('red', { x: 0, y: 0, w: 22, h: 20 }, [1]), proposal('blue', { x: 18, y: 0, w: 22, h: 20 }, [1])], []);
    expect(out.assets.map((a) => a.rect)).toEqual([
      { x: 0, y: 0, w: 20, h: 20 },
      { x: 20, y: 0, w: 20, h: 20 },
    ]);
    const red = assetImage(img, out.assets[0]);
    expect(pixelAt(red, 19, 5)).toEqual([255, 0, 0, 255]);
    expect(auditCrops(img, out.assets)).toEqual([]);
  });

  it('cuts terrain into one tile per cell, untrimmed, exactly as drawn', () => {
    const img = createImage(192, 144);
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < 4; c++) fillRect(img, { x: c * 48, y: r * 48, w: 48, h: 48 }, [40 + c * 30, 120 + r * 40, 60, 255]);
    }
    blob(img, 100, 120, 20, 18, [200, 200, 40, 255]); // a prop below the terrain block
    const sheet = analyse(img, 48);
    const terrain: TerrainProposal[] = [{ name: 'grass', category: 'terrain', bbox: { x: 2, y: 1, w: 190, h: 95 }, cell: 48, confidence: 0.9, region: 0 }];
    const prop = sheet.comps.list.find((c) => c.y > 96)!;
    const out = refine(sheet, [proposal('sun flower', prop, [prop.id])], terrain);
    const tiles = out.assets.filter((a) => a.kind === 'tile');
    expect(tiles).toHaveLength(8);
    expect(tiles.every((t) => t.rect.w === 48 && t.rect.h === 48 && t.rect.x % 48 === 0 && t.rect.y % 48 === 0)).toBe(true);
    expect(out.assets.filter((a) => a.kind === 'object')).toHaveLength(1);
    expect(auditCrops(img, out.assets)).toEqual([]);
  });

  it('folds a stray speck into the asset beside it and reports a larger unclaimed island', () => {
    const img = createImage(80, 40);
    blob(img, 15, 15, 12, 12, [200, 120, 20, 255]);
    fillRect(img, { x: 29, y: 10, w: 2, h: 2 }, [255, 255, 120, 255]);
    blob(img, 60, 20, 10, 10, [90, 90, 200, 255]);
    const sheet = analyse(img);
    const out = refine(sheet, [proposal('fountain', { x: 3, y: 3, w: 25, h: 25 }, [1])], []);
    expect(out.assets).toHaveLength(1);
    expect(out.assets[0].rect.x + out.assets[0].rect.w).toBe(31);
    expect(out.leftovers).toHaveLength(1);
    const unknown = groupLeftovers(sheet, out.leftovers, out.owner);
    expect(unknown).toHaveLength(1);
    expect(unknown[0].flags[0].code).toBe('unidentified');
  });

  it('drops a second proposal for pixels already taken, as a duplicate', () => {
    const img = createImage(30, 30);
    blob(img, 15, 15, 10, 10, [200, 120, 20, 255]);
    const sheet = analyse(img);
    const out = refine(sheet, [proposal('rock', { x: 5, y: 5, w: 21, h: 21 }, [1]), proposal('rock again', { x: 5, y: 5, w: 21, h: 21 }, [])], []);
    expect(out.assets).toHaveLength(1);
    expect(out.dropped[0].reason).toMatch(/duplicate/);
  });

  it('competition follows colour edges between seeds', () => {
    const img = createImage(10, 1);
    for (let x = 0; x < 10; x++) img.data.set(x < 7 ? [255, 0, 0, 255] : [0, 0, 255, 255], x * 4);
    const pixels = Int32Array.from({ length: 10 }, (_, i) => i);
    // Overlapping boxes: x 0..3 only in A, 8..9 only in B, 4..7 in both.
    const owners = competeForPixels(img, pixels, [{ x: 0, y: 0, w: 8, h: 1 }, { x: 4, y: 0, w: 6, h: 1 }]);
    expect(Array.from(owners)).toEqual([0, 0, 0, 0, 0, 0, 0, 1, 1, 1]);
  });
});

describe('verification', () => {
  it('flags touching splits, boxes that disagree, and small pieces beside a bigger object', () => {
    const img = createImage(80, 40);
    blob(img, 20, 20, 16, 14, [40, 150, 40, 255]);
    blob(img, 48, 20, 14, 12, [200, 80, 160, 255]);
    fillRect(img, { x: 63, y: 30, w: 3, h: 3 }, [200, 80, 160, 255]);
    const sheet = analyse(img);
    const out = refine(
      sheet,
      [
        proposal('bush', { x: 3, y: 5, w: 36, h: 31 }, [1]),
        proposal('flower bush', { x: 50, y: 7, w: 5, h: 5 }, [1]),
        proposal('petal', { x: 63, y: 30, w: 3, h: 3 }, [2]),
      ],
      [],
    );
    checkAssets(sheet, out.assets, out.splits, { modelUsed: true });
    const codes = (name: string) => out.assets.find((a) => a.name === name)!.flags.map((f) => f.code);
    expect(codes('bush')).toContain('touching-split');
    expect(codes('flower bush')).toContain('beyond-box');
    expect(codes('petal')).toContain('possible-split');
    expect(out.assets.find((a) => a.name === 'flower bush')!.needsReview).toBe(true);
  });

  it('flags animation frames that change size or skip a number', () => {
    const img = createImage(100, 20);
    for (let k = 0; k < 4; k++) fillRect(img, { x: k * 25, y: 2, w: k === 2 ? 20 : 12, h: 12 }, [200, 50, 50, 255]);
    const sheet = analyse(img);
    const frames = [0, 1, 2, 4].map((f, k) =>
      proposal(`torch ${f}`, sheet.comps.list[k], [sheet.comps.list[k].id], { kind: 'frame', animation: { group: 'torch', frame: f } }),
    );
    const out = refine(sheet, frames, []);
    checkAssets(sheet, out.assets, out.splits, { modelUsed: true });
    expect(out.assets[2].flags.map((f) => f.code)).toContain('animation-size');
    expect(out.assets[3].flags.map((f) => f.code)).toContain('animation-gap');
  });

  it('reads a second inspection verdict', () => {
    const reply = parseReinspection({ verdict: 'split', parts: [{ name: 'a', category: 'rock', bbox: [0, 0, 5, 5] }, { bbox: [9, 9, 2, 2] }], confidence: 2 }, { w: 20, h: 20 });
    expect(reply?.verdict).toBe('split');
    expect(reply?.parts.map((p) => p.bbox)).toEqual([
      { x: 0, y: 0, w: 5, h: 5 },
      { x: 2, y: 2, w: 7, h: 7 },
    ]);
    expect(reply?.confidence).toBe(1);
    expect(parseReinspection({ verdict: 'maybe' }, { w: 20, h: 20 })).toBeNull();
  });
});

describe('the irregular object sheet (Ninja Adventure nature, CC0)', () => {
  type Entry = { url: string; assets?: Rect[] };
  const boxes = () =>
    readJson<Entry[]>(repoPath('public/starter/manifest.json'))
      .find((e) => e.url.endsWith('nature.png'))!
      .assets!.filter((r) => r.w > 0 && r.h > 0);

  it('pins hand-laid boxes to exact, disjoint, tight crops that match the original pixel for pixel', async () => {
    const img = await loadPng(repoPath('public/starter/ninja-adventure/nature.png'));
    const sheet = analyse(img, 16);
    const proposals = boxes().map((r, i) => proposal(`asset ${i}`, r));
    const out = refine(sheet, proposals, []);
    expect(out.assets.length + out.dropped.length).toBe(proposals.length);
    expect(out.assets.length).toBeGreaterThanOrEqual(60);
    // The hand-laid list misses some objects; those come back as unclaimed islands, never silently lost.
    expect(out.leftovers.length).toBeGreaterThan(0);
    expect(auditCrops(img, out.assets)).toEqual([]);
    for (const a of out.assets) {
      // Each crop sits within a few pixels of the box it was asked for.
      expect(a.rect.x).toBeGreaterThanOrEqual(a.modelBox!.x - 3);
      expect(a.rect.y).toBeGreaterThanOrEqual(a.modelBox!.y - 3);
      expect(a.rect.x + a.rect.w).toBeLessThanOrEqual(a.modelBox!.x + a.modelBox!.w + 3);
      expect(a.rect.y + a.rect.h).toBeLessThanOrEqual(a.modelBox!.y + a.modelBox!.h + 3);
    }
  });

  it('runs end to end without a model, marked as pixel analysis only, and exports exact files', async () => {
    const img = await loadPng(repoPath('public/starter/ninja-adventure/nature.png'));
    const { result } = await extractSheet({ name: 'nature', image: img, zlib: streamZlib, client: null, cellHint: 16 });
    expect(result.model).toBeNull();
    expect(result.assets.length).toBeGreaterThan(60);
    expect(result.assets.every((a) => a.flags.some((f) => f.code === 'no-model') && a.confidence <= 0.5)).toBe(true);
    expect(auditCrops(img, result.assets)).toEqual([]);

    const bundle = await exportBundle(img, result, streamZlib);
    expect(bundle.json.assets).toHaveLength(result.assets.length);
    // The atlas holds every asset's exact pixels where the JSON says.
    for (let k = 0; k < result.assets.length; k++) {
      const p = bundle.atlas.placements[k];
      const crop = assetImage(img, result.assets[k]);
      for (let y = 0; y < p.h; y += 3) {
        for (let x = 0; x < p.w; x += 3) expect(pixelAt(bundle.atlas.image, p.x + x, p.y + y)).toEqual(pixelAt(crop, x, y));
      }
    }
  });
});

describe('hand corrections', () => {
  it('merge, draw a box, change kind and delete, keeping every crop exact', () => {
    const img = createImage(96, 48);
    fillRect(img, { x: 0, y: 0, w: 48, h: 48 }, [90, 160, 70, 255]);
    blob(img, 70, 14, 10, 10, [200, 60, 60, 255]);
    blob(img, 70, 36, 8, 8, [60, 60, 200, 255]);
    const sheet = analyse(img, 48);
    const [, top, bottom] = sheet.comps.list;
    const out = refine(sheet, [proposal('a', top, [top.id]), proposal('b', bottom, [bottom.id])], [
      { name: 'grass', category: 'terrain', bbox: { x: 0, y: 0, w: 48, h: 48 }, cell: 48, confidence: 0.9, region: 0 },
    ]);
    expect(out.assets.map((a) => a.kind)).toEqual(['tile', 'object', 'object']);
    const merged = mergeSelected(sheet, out, [out.assets[1].id, out.assets[2].id])!;
    expect(merged.rect).toEqual({ x: top.x, y: top.y, w: Math.max(top.x + top.w, bottom.x + bottom.w) - top.x, h: bottom.y + bottom.h - top.y });
    const carved = claimBox(sheet, out, { x: 0, y: 0, w: 10, h: 10 }, 'flower')!;
    expect(carved.pixels.length).toBe(100);
    expect(out.assets.find((a) => a.kind === 'tile')!.pixels.length).toBe(48 * 48 - 100);
    expect(auditCrops(img, out.assets)).toEqual([]);
    expect(setKind(sheet, out, carved.id, 'tile')).toBe(true);
    expect(out.assets.find((a) => a.id === carved.id)!.rect).toEqual({ x: 0, y: 0, w: 48, h: 48 });
    expect(setKind(sheet, out, merged.id, 'tile')).toBe(true);
    expect(out.assets.find((a) => a.id === merged.id)!.rect).toEqual({ x: 48, y: 0, w: 48, h: 48 });
    expect(auditCrops(img, out.assets)).toEqual([]);
    expect(deleteSelected(out, [merged.id])).toBe(1);
    expect(out.owner[14 * 96 + 70]).toBe(-1);
  });

  it('turns an extraction into a library sheet whose tiles sit on the grid', () => {
    const img = createImage(96, 48);
    fillRect(img, { x: 0, y: 0, w: 96, h: 48 }, [90, 160, 70, 255]);
    const sheet = analyse(img, 48);
    const out = refine(sheet, [], [{ name: 'grass', category: 'terrain', bbox: { x: 0, y: 0, w: 96, h: 48 }, cell: 48, confidence: 0.9, region: 0 }]);
    const result = { sheetName: 's', width: 96, height: 48, cell: 48, background: 'none' as const, assets: out.assets, stats: {} as never, log: [], model: null };
    const atlas = packAtlas(img, out.assets, 48);
    const lib = librarySheet(result, atlas);
    expect(lib.groundAssets).toEqual([0, 1]);
    expect(lib.propsOnly).toBe(false);
    expect(lib.aiAssets[1].source).toEqual({ x: 48, y: 0, w: 48, h: 48 });
    expect(lib.assets.every((r) => r.x % 48 === 0 && r.y % 48 === 0)).toBe(true);
  });
});

describe('the user’s 48 px terrain sheet', () => {
  const path = env('HABITAT_TERRAIN_SHEET');

  it.skipIf(!fileExists(path))('cuts every drawn 48 px cell into its own exact tile', async () => {
    const img = await loadPng(path!);
    const sheet = analyse(img, 48);
    const terrain: TerrainProposal[] = [{ name: 'ground', category: 'terrain', bbox: { x: 0, y: 0, w: img.width, h: img.height }, cell: 48, confidence: 0.9, region: 0 }];
    const out = refine(sheet, [], terrain);
    expect(detectCellSize(img, sheet.fg.mask)).toBe(48);
    expect(out.assets).toHaveLength(168);
    expect(auditCrops(img, out.assets)).toEqual([]);
    for (const tile of out.assets) {
      const crop = assetImage(img, tile);
      for (let y = 0; y < 48; y++) for (let x = 0; x < 48; x++) expect(pixelAt(crop, x, y)).toEqual(pixelAt(img, tile.rect.x + x, tile.rect.y + y));
    }
    const atlas = packAtlas(img, out.assets, 48);
    expect(atlas.placements.every((p) => p.x % 48 === 0 && p.y % 48 === 0)).toBe(true);
  });
});

describe('looking at the sheet', () => {
  it('views a small sheet once, enlarged, and a large one in overlapping windows', () => {
    expect(planRegions(384, 336, 16)).toEqual([{ index: 0, rect: { x: 0, y: 0, w: 384, h: 336 }, scale: 3 }]);
    const big = planRegions(1536, 1024, 48);
    expect(big.length).toBeGreaterThan(4);
    expect(big.every((r) => r.scale >= 2)).toBe(true);
    for (let x = 0; x < 1536; x += 7) for (let y = 0; y < 1024; y += 7) expect(big.some((r) => x >= r.rect.x && x < r.rect.x + r.rect.w && y >= r.rect.y && y < r.rect.y + r.rect.h)).toBe(true);
  });

  it('numbers every island it shows', async () => {
    const img = await loadPng(repoPath('public/starter/ninja-adventure/nature.png'));
    const sheet = analyse(img, 16);
    const [region] = planRegions(img.width, img.height, 16);
    const views = renderRegion(img, sheet.comps, region, 16);
    expect(views.clean.width).toBe(384 * 3 + 26);
    expect(views.marks.length).toBe(sheet.comps.list.filter((c) => c.area >= 6).length);
  });

  it('reads a detection reply, ignoring marks that were not shown and malformed entries', () => {
    const region = { index: 0, rect: { x: 0, y: 0, w: 100, h: 100 }, scale: 4 };
    const parsed = parseDetection(
      {
        assets: [
          { name: 'Oak', category: 'TREE', kind: 'object', marks: [1, 2, 99], bbox: [10, 10, 40, 60], confidence: 0.8 },
          { name: 'torch', category: 'decoration', marks: [3], bbox: [50, 0, 60, 20], animation: { group: 'torch', frame: 1 } },
          { name: 'nothing' },
        ],
        terrain: [{ name: 'grass', bbox: [0, 60, 96, 100], cell: 48 }, { name: 'bad', bbox: [0, 0, 1, 1] }],
      },
      region,
      [1, 2, 3],
      { w: 100, h: 100 },
    );
    expect(parsed.proposals.map((p) => [p.name, p.category, p.kind, p.marks])).toEqual([
      ['Oak', 'tree', 'object', [1, 2]],
      ['torch', 'decoration', 'frame', [3]],
    ]);
    expect(parsed.proposals[0].bbox).toEqual({ x: 10, y: 10, w: 30, h: 50 });
    expect(parsed.terrain).toHaveLength(1);
    expect(parsed.skipped).toBe(2);
  });

  it('joins one asset seen from two overlapping views, but not two assets splitting one island in a view', () => {
    const a = proposal('tree', { x: 0, y: 0, w: 30, h: 40 }, [5, 6], { region: 0 });
    const b = proposal('tree', { x: 0, y: 2, w: 30, h: 38 }, [5, 6], { region: 1 });
    const c = proposal('bench', { x: 30, y: 0, w: 30, h: 20 }, [5], { region: 0 });
    const merged = mergeAcrossRegions([a, b, c]);
    expect(merged).toHaveLength(2);
    expect(merged.find((p) => p.name === 'tree')!.bbox).toEqual({ x: 0, y: 0, w: 30, h: 40 });
  });
});

describe('vision providers', () => {
  it('says plainly that a key is needed when none is set', () => {
    expect(() => configFromEnv({})).toThrow(/OPENAI_API_KEY/);
    try {
      configFromEnv({});
    } catch (error) {
      expect((error as VisionError).code).toBe('no-key');
    }
    expect(() => createVisionClient({ provider: 'openai', model: 'gpt-4.1' })).toThrow(VisionError);
  });

  it('picks the provider from the environment', () => {
    expect(configFromEnv({ ANTHROPIC_API_KEY: 'k' })).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-4-5', apiKey: 'k' });
    expect(configFromEnv({ OPENAI_API_KEY: 'a', GEMINI_API_KEY: 'b', HABITAT_VISION_PROVIDER: 'gemini', HABITAT_VISION_MODEL: 'gemini-x' })).toMatchObject({
      provider: 'gemini',
      model: 'gemini-x',
      apiKey: 'b',
    });
    expect(() => configFromEnv({ HABITAT_VISION_PROVIDER: 'nope', OPENAI_API_KEY: 'a' })).toThrow(/must be one of/);
  });

  it('builds each provider’s real request shape with the images attached', () => {
    const request = { system: 'sys', prompt: 'go', images: [{ label: 'A', png: new Uint8Array([1, 2, 3]) }] };
    const openai = buildRequest({ provider: 'openai', model: 'm', apiKey: 'k' }, request);
    expect(openai.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(JSON.stringify(openai.body)).toContain('data:image/png;base64,AQID');
    const anthropic = buildRequest({ provider: 'anthropic', model: 'm', apiKey: 'k' }, request);
    expect(anthropic.url).toBe('https://api.anthropic.com/v1/messages');
    expect(anthropic.headers['x-api-key']).toBe('k');
    const gemini = buildRequest({ provider: 'gemini', model: 'g', apiKey: 'k' }, request);
    expect(gemini.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/g:generateContent');
    expect(JSON.stringify(gemini.body)).toContain('"inlineData"');
    expect(replyText('anthropic', { content: [{ type: 'text', text: '{}' }] })).toBe('{}');
  });

  it('stops the whole run with the no-key message rather than producing anything', async () => {
    const img = createImage(20, 20);
    fillRect(img, { x: 2, y: 2, w: 8, h: 8 }, [200, 0, 0, 255]);
    const client = createVisionClient({ provider: 'openai', model: 'm', proxyUrl: 'http://local/api/vision/complete' }, async () =>
      new Response(JSON.stringify({ code: 'no-key', error: { message: 'none' } }), { status: 503 }),
    );
    await expect(extractSheet({ name: 's', image: img, zlib: streamZlib, client })).rejects.toMatchObject({ code: 'no-key' });
  });

  it('reports a rejected key as such', async () => {
    const client = createVisionClient({ provider: 'openai', model: 'm', apiKey: 'bad' }, async () =>
      new Response(JSON.stringify({ error: { message: 'Incorrect API key' } }), { status: 401 }),
    );
    await expect(client.complete({ system: '', prompt: '', images: [] })).rejects.toMatchObject({ code: 'auth' });
  });
});

describe('the existing library slicer is unchanged', () => {
  // Counts from the detector before AI Extract existed: assets, ground squares.
  const expected: Record<string, [number, number, boolean]> = {
    ground: [221, 213, false],
    'ground-details': [44, 0, false],
    water: [38, 3, false],
    nature: [99, 0, true],
    village: [82, 0, false],
    houses: [94, 0, false],
    'interior-floors': [149, 143, false],
    'interior-walls': [62, 40, false],
  };
  for (const [name, [assets, ground, propsOnly]] of Object.entries(expected)) {
    it(`still splits ${name} the same way`, async () => {
      const img = await loadPng(repoPath(`public/starter/ninja-adventure/${name}.png`));
      const grid = { w: 16, h: 16, margin: 0, spacing: 0, cols: Math.floor(img.width / 16), rows: Math.floor(img.height / 16) };
      const split = splitSheet(new Uint8ClampedArray(img.data), img.width, img.height, grid, false, propsOnly);
      expect([split.assets.length, split.ground.length]).toEqual([assets, ground]);
    });
  }
});
