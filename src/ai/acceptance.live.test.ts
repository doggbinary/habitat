import { describe, expect, it } from 'vitest';
import { env, fileExists, loadPng, processEnv, repoPath, savePng, saveText } from '../test-support/png-node';
import { auditCrops, exportBundle } from './output';
import { renderOverlay } from './overlay';
import { extractSheet } from './pipeline';
import { streamZlib } from './png';
import { configFromEnv, createVisionClient } from './vision';

/*
 * Live acceptance against a real vision model. Off unless both a key and
 * HABITAT_VISION_LIVE=1 are set, so ordinary test runs never spend money:
 *
 *   HABITAT_VISION_LIVE=1 OPENAI_API_KEY=sk-... npm run test:ai-live
 *
 * HABITAT_VISION_PROVIDER / HABITAT_VISION_MODEL pick the model,
 * HABITAT_TERRAIN_SHEET points at a 48 px terrain sheet, and overlays and
 * reports are written to HABITAT_EXTRACT_OUT (default /tmp/habitat-ai-extract).
 */
const config = (() => {
  if (env('HABITAT_VISION_LIVE') !== '1') return null;
  try {
    return configFromEnv(processEnv());
  } catch {
    return null;
  }
})();
const out = env('HABITAT_EXTRACT_OUT') ?? '/tmp/habitat-ai-extract';

async function run(name: string, path: string, cellHint?: number) {
  const image = await loadPng(path);
  const extraction = await extractSheet({
    name,
    image,
    zlib: streamZlib,
    client: createVisionClient(config!),
    cellHint,
    onProgress: (_, message) => console.log(`[${name}] ${message}`),
  });
  const { result } = extraction;
  await savePng(`${out}/${name}-overlay.png`, renderOverlay(image, result.assets, 2));
  const bundle = await exportBundle(image, result, streamZlib);
  saveText(`${out}/${name}-atlas.json`, JSON.stringify(bundle.json, null, 2));
  await savePng(`${out}/${name}-atlas.png`, bundle.atlas.image);
  return { image, result };
}

describe.skipIf(!config)('live vision acceptance (HABITAT_VISION_LIVE=1 and an API key)', () => {
  it('extracts the irregular object sheet without a grid or selection boxes', { timeout: 15 * 60_000 }, async () => {
    const { image, result } = await run('nature', repoPath('public/starter/ninja-adventure/nature.png'));
    expect(auditCrops(image, result.assets)).toEqual([]);
    const objects = result.assets.filter((a) => a.kind !== 'tile');
    expect(objects.length).toBeGreaterThan(50);
    expect(objects.some((a) => a.category === 'tree')).toBe(true);
    expect(objects.some((a) => a.category === 'rock')).toBe(true);
    expect(result.stats.unassignedPixels).toBeLessThan(image.width * image.height * 0.01);
  });

  it.skipIf(!fileExists(env('HABITAT_TERRAIN_SHEET')))('cuts every repeated ground tile of the terrain sheet separately', { timeout: 15 * 60_000 }, async () => {
    const { image, result } = await run('terrain', env('HABITAT_TERRAIN_SHEET')!);
    expect(auditCrops(image, result.assets)).toEqual([]);
    const tiles = result.assets.filter((a) => a.kind === 'tile');
    expect(tiles.every((t) => t.rect.w === 48 && t.rect.x % 48 === 0 && t.rect.y % 48 === 0)).toBe(true);
    expect(tiles.length).toBe(168);
  });
});
