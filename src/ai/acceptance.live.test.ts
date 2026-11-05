import { describe, expect, it } from 'vitest';
import { env, fileExists, loadPng, processEnv, repoPath, savePng, saveText } from '../test-support/png-node';
import { auditCrops, exportBundle } from './output';
import { renderOverlay } from './overlay';
import { extractSheet } from './pipeline';
import { streamZlib } from './png';
import { configFromEnv, createVisionClient } from './vision';
import { buildAutotiles, guessFormat } from './formats';
import { nameMaterials } from './autotile-naming';

/*
 * Live acceptance against a real vision model. Off unless both a key and
 * HABITAT_VISION_LIVE=1 are set, so ordinary test runs never spend money:
 *
 *   HABITAT_VISION_LIVE=1 OPENAI_API_KEY=sk-... npm run test:ai-live
 *
 * HABITAT_VISION_PROVIDER / HABITAT_VISION_MODEL pick the model,
 * HABITAT_TERRAIN_SHEET points at an RPG Maker A2 sheet (Tile_A2-1), and overlays and
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

  it.skipIf(!fileExists(env('HABITAT_TERRAIN_SHEET')))('recognises the A2 sheet by its format and names its 28 materials with the model', { timeout: 5 * 60_000 }, async () => {
    const image = await loadPng(env('HABITAT_TERRAIN_SHEET')!);
    const guess = guessFormat('Tile_A2-1 (2)', image.width, image.height)!;
    expect(guess.format).toBe('rpgmaker-a2');
    const { names, looks } = await nameMaterials(createVisionClient(config!), image, guess, streamZlib);
    const build = buildAutotiles(image, guess, 'Tile_A2-1 (2)', names);
    console.log(build.sheet.materials.map((m, i) => `${m.name} (${looks[build.slotOf[i]] ?? '?'}): ${m.edge.style}`).join('\n'));
    expect(build.sheet.materials).toHaveLength(28);
    expect(names.filter(Boolean).length).toBeGreaterThanOrEqual(20);
  });
});
