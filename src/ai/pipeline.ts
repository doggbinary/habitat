import { splitSheet } from '../core/assets';
import {
  DETECT_SYSTEM,
  detectPrompt,
  mergeAcrossRegions,
  mergeTerrain,
  nextProposalId,
  parseDetection,
  planRegions,
  renderRegion,
} from './detect';
import { detectCellSize, findForeground, gridLineScore, labelComponents } from './foreground';
import { encodePng, type Zlib } from './png';
import { refine, type Refined, type SheetAnalysis } from './refine';
import type { ExtractedAsset, ExtractionResult, Proposal, TerrainProposal } from './types';
import {
  REINSPECT_SYSTEM,
  applyReinspection,
  checkAssets,
  groupLeftovers,
  parseReinspection,
  reinspectPrompt,
  reinspectionQueue,
  renderReinspection,
} from './verify';
import { extractJson, VisionError, type VisionClient, type VisionRequest } from './vision';
import type { RGBAImage } from './image';

export type Stage = 'analyse' | 'detect' | 'refine' | 'verify' | 'reinspect' | 'done';

export interface ExtractOptions {
  name: string;
  image: RGBAImage;
  zlib: Zlib;
  /** The vision model. Null runs pixel analysis only, which is labelled as such everywhere. */
  client: VisionClient | null;
  /** The sheet's own cell size when known (from the import dialog or the library). */
  cellHint?: number;
  /** Most assets sent back for a second look in one run. */
  maxReinspections?: number;
  /** Model calls in flight at once. */
  concurrency?: number;
  onProgress?: (stage: Stage, message: string) => void;
  signal?: AbortSignal;
}

export interface Extraction {
  result: ExtractionResult;
  refined: Refined;
  sheet: SheetAnalysis;
}

async function inPool<T, R>(items: T[], limit: number, run: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await run(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Asks for JSON, and asks once more if the reply was not JSON. */
async function askJson(client: VisionClient, request: VisionRequest, signal?: AbortSignal): Promise<unknown> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const text = await client.complete(
      attempt === 0 ? request : { ...request, prompt: `${request.prompt}\n\nYour previous reply was not valid JSON. Reply with the JSON object only.` },
    );
    const json = extractJson(text);
    if (json) return json;
  }
  throw new VisionError(`${client.label} did not reply with JSON, so nothing was changed.`, 'empty');
}

/** The library detector's boxes, as proposals, for a run with no model. */
function pixelProposals(sheet: SheetAnalysis): { proposals: Proposal[]; terrain: TerrainProposal[] } {
  const { image } = sheet;
  const cell = sheet.cell ?? 48;
  const grid = { w: cell, h: cell, margin: 0, spacing: 0, cols: Math.floor(image.width / cell), rows: Math.floor(image.height / cell) };
  const split = splitSheet(new Uint8ClampedArray(image.data), image.width, image.height, grid, false);
  const ground = new Set(split.ground);
  const proposals: Proposal[] = [];
  const terrain: TerrainProposal[] = [];
  split.assets.forEach((rect, i) => {
    if (ground.has(i)) terrain.push({ name: 'ground', category: 'terrain', bbox: rect, cell, confidence: 0.5, region: -1 });
    else
      proposals.push({ id: nextProposalId(), name: 'asset', category: 'other', kind: 'object', bbox: rect, marks: [], confidence: 0.5, source: 'pixels', region: -1 });
  });
  return { proposals, terrain };
}

/** Reading order, floor tiles first, then unique names so every asset can be told apart. */
function finish(assets: ExtractedAsset[]): ExtractedAsset[] {
  const order = (a: ExtractedAsset, b: ExtractedAsset) =>
    (a.kind === 'tile' ? 0 : 1) - (b.kind === 'tile' ? 0 : 1) || a.rect.y - b.rect.y || a.rect.x - b.rect.x;
  const sorted = [...assets].sort(order);
  const counts = new Map<string, number>();
  for (const a of sorted) counts.set(a.name, (counts.get(a.name) ?? 0) + 1);
  const seen = new Map<string, number>();
  for (const a of sorted) {
    if ((counts.get(a.name) ?? 0) < 2) continue;
    const n = (seen.get(a.name) ?? 0) + 1;
    seen.set(a.name, n);
    a.name = `${a.name} ${n}`;
  }
  return sorted;
}

/**
 * The whole extraction: look at the sheet, pin every asset to its exact
 * pixels, check the result and look again where it is doubtful.
 */
export async function extractSheet(options: ExtractOptions): Promise<Extraction> {
  const { image, client, zlib } = options;
  const progress = options.onProgress ?? (() => {});
  const log: string[] = [];
  const say = (stage: Stage, message: string) => {
    log.push(message);
    progress(stage, message);
  };
  const stats: ExtractionResult['stats'] = {
    regions: 0,
    modelCalls: 0,
    proposals: 0,
    terrainBlocks: 0,
    reinspected: 0,
    corrected: 0,
    dropped: 0,
    unassignedPixels: 0,
  };

  // Stage 0: what is drawing and what is background, on the original pixels.
  const fg = findForeground(image);
  const comps = labelComponents(fg.mask, image.width, image.height);
  const cell = detectCellSize(image, fg.mask, options.cellHint);
  const sheet: SheetAnalysis = { image, fg, comps, cell };
  say(
    'analyse',
    `Read ${image.width} x ${image.height} px: background by ${fg.background === 'colour' ? `flat colour rgb(${fg.colour!.join(', ')})` : fg.background}, ` +
      `${comps.list.length} separate islands of pixels, grid ${cell ? `${cell} px` : 'not found'}.`,
  );

  // Stage 1: visual understanding.
  let proposals: Proposal[];
  let terrain: TerrainProposal[];
  if (client) {
    const regions = planRegions(image.width, image.height, cell);
    stats.regions = regions.length;
    say('detect', `${client.label} is looking at ${regions.length} ${regions.length === 1 ? 'view' : 'overlapping views'} at full detail.`);
    let done = 0;
    const replies = await inPool(regions, options.concurrency ?? 3, async (region) => {
      const views = renderRegion(image, comps, region, cell);
      const json = await askJson(
        client,
        {
          system: DETECT_SYSTEM,
          prompt: detectPrompt(region, regions.length, { w: image.width, h: image.height }, cell),
          images: [
            { label: 'Picture A, the art:', png: await encodePng(views.clean, zlib) },
            { label: 'Picture B, numbered marks:', png: await encodePng(views.marked, zlib) },
          ],
        },
        options.signal,
      );
      stats.modelCalls++;
      done++;
      const parsed = parseDetection(json, region, views.marks, { w: image.width, h: image.height });
      progress('detect', `View ${done} of ${regions.length}: ${parsed.proposals.length} assets, ${parsed.terrain.length} terrain blocks.`);
      return parsed;
    });
    proposals = mergeAcrossRegions(replies.flatMap((r) => r.proposals));
    terrain = mergeTerrain(replies.flatMap((r) => r.terrain));
    const skipped = replies.reduce((n, r) => n + r.skipped, 0);
    // A terrain cell size the pixels do not bear out is replaced by the one they do.
    for (const block of terrain) {
      if (cell && block.cell !== cell && gridLineScore(image, fg.mask, block.cell) < 1.1) {
        say('detect', `"${block.name}": the model said ${block.cell} px cells, but the seams are every ${cell} px; using ${cell} px.`);
        block.cell = cell;
      }
    }
    say('detect', `The model proposed ${proposals.length} assets and ${terrain.length} terrain blocks${skipped ? ` (${skipped} malformed entries ignored)` : ''}.`);
  } else {
    ({ proposals, terrain } = pixelProposals(sheet));
    say('detect', `No vision model: using pixel analysis only (${proposals.length} islands, ${terrain.length} ground cells). Every result is marked for review.`);
  }
  stats.proposals = proposals.length;
  stats.terrainBlocks = terrain.length;

  // Stage 2: pixel-perfect refinement on the original sheet.
  const refined = refine(sheet, proposals, terrain);
  say('refine', `Pinned ${refined.assets.length} assets to exact pixels; ${refined.leftovers.length} islands left unaccounted for, ${refined.dropped.length} proposals dropped.`);
  for (const d of refined.dropped) log.push(`Dropped "${d.name}": ${d.reason}.`);

  // Stage 3: verification, and a second look at whatever is doubtful.
  const unidentified = groupLeftovers(sheet, refined.leftovers, refined.owner);
  for (const a of unidentified) {
    for (const i of a.pixels) refined.owner[i] = refined.assets.length;
    refined.assets.push(a);
  }
  const splitIds = refined.splits.map(([a, b]) => [refined.assets[a].id, refined.assets[b].id] as const);
  const splitPairs = (): [number, number][] =>
    splitIds.flatMap(([a, b]) => {
      const ia = refined.assets.findIndex((x) => x.id === a);
      const ib = refined.assets.findIndex((x) => x.id === b);
      return ia >= 0 && ib >= 0 ? [[ia, ib] as [number, number]] : [];
    });
  const settled = new Set<string>();
  checkAssets(sheet, refined.assets, splitPairs(), { modelUsed: !!client, settled });
  const flagged = refined.assets.filter((a) => a.needsReview).length;
  say('verify', `Checked every asset: ${flagged} need a closer look${unidentified.length ? `, including ${unidentified.length} unidentified` : ''}.`);

  if (client) {
    const queue = reinspectionQueue(refined.assets, options.maxReinspections ?? 16);
    if (queue.length) say('reinspect', `Sending ${queue.length} doubtful assets back to ${client.label} for a second inspection.`);
    const looks = await inPool(queue, options.concurrency ?? 3, async (asset) => {
      const view = renderReinspection(sheet, refined.assets, asset, refined.owner);
      const json = await askJson(
        client,
        {
          system: REINSPECT_SYSTEM,
          prompt: reinspectPrompt(asset, view),
          images: [
            { label: 'Picture A, the art:', png: await encodePng(view.clean, zlib) },
            { label: 'Picture B, the extraction:', png: await encodePng(view.marked, zlib) },
          ],
          maxTokens: 2048,
        },
        options.signal,
      );
      stats.modelCalls++;
      return { asset, view, reply: parseReinspection(json, { w: image.width, h: image.height }) };
    });
    for (const { asset, view, reply } of looks) {
      stats.reinspected++;
      if (!reply) {
        log.push(`Second inspection of "${asset.name}" gave no usable verdict; it stays flagged.`);
        continue;
      }
      const before = refined.dropped.length;
      const { settled: ids, note } = applyReinspection(sheet, refined, asset.id, view, reply);
      ids.forEach((id) => settled.add(id));
      if (reply.verdict !== 'keep') stats.corrected++;
      if (refined.dropped.length > before) stats.dropped++;
      log.push(`Second inspection: ${note}.`);
    }
    if (queue.length) {
      checkAssets(sheet, refined.assets, splitPairs(), { modelUsed: true, settled });
      say('reinspect', `After the second inspection ${refined.assets.filter((a) => a.needsReview).length} assets still need review.`);
    }
  }

  // Unclaimed pixels are reported, never silently lost.
  let unassigned = 0;
  for (let i = 0; i < fg.mask.length; i++) if (fg.mask[i] && refined.owner[i] === -1) unassigned++;
  stats.unassignedPixels = unassigned;
  stats.dropped = refined.dropped.length;

  refined.assets = finish(refined.assets);
  refined.owner.fill(-1);
  refined.assets.forEach((a, k) => {
    for (const i of a.pixels) refined.owner[i] = k;
  });
  const tiles = refined.assets.filter((a) => a.kind === 'tile').length;
  say(
    'done',
    `Done: ${refined.assets.length} assets (${tiles} tiles, ${refined.assets.length - tiles} objects), ` +
      `${refined.assets.filter((a) => a.needsReview).length} flagged for review, ${unassigned} drawn pixels unassigned.`,
  );

  return {
    result: {
      sheetName: options.name,
      width: image.width,
      height: image.height,
      cell,
      background: fg.background,
      assets: refined.assets,
      stats,
      log,
      model: client?.label ?? null,
    },
    refined,
    sheet,
  };
}
