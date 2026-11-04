import type { RGBAImage } from '../ai/image';
import { claimBox, deleteSelected, mergeSelected, approve, rename, setKind } from '../ai/manual';
import { assetImage, exportBundle } from '../ai/output';
import { renderOverlay } from '../ai/overlay';
import { extractSheet, type Extraction, type Stage } from '../ai/pipeline';
import { streamZlib } from '../ai/png';
import { loadVisionSettings, resolveVision, saveVisionSettings, type ResolvedVision } from '../ai/settings';
import { CATEGORIES, type Category, type ExtractedAsset } from '../ai/types';
import { createVisionClient, DEFAULT_MODELS, describeConfig, NO_KEY_MESSAGE, PROVIDERS, VisionError, type ProviderId } from '../ai/vision';
import { artworkAutotiles, buildAutotiles, flagArtworkBuild, guessFormat, type AutotileBuild, type FormatGuess } from '../ai/formats';
import { nameMaterials } from '../ai/autotile-naming';
import { FLOOR_PREVIEW } from '../core/autotile';
import { button, clear, el } from './dom';
import { openModal } from './modal';

export interface ExtractSource {
  name: string;
  image: RGBAImage;
  /** The sheet's cell size, when the import dialog or library knows it. */
  cellHint?: number;
  /** How the pixels were read; anything but the PNG itself is noted on the result. */
  decodedBy: 'png' | 'browser';
  /** The original file, kept with terrain built from it. */
  sourceSrc?: string;
}

export interface ExtractHooks {
  addToLibrary: (extraction: Extraction) => Promise<void>;
  addAutotiles: (build: AutotileBuild) => Promise<void>;
  saveZip: (bytes: Uint8Array, filename: string) => Promise<void>;
  toast: (message: string) => void;
}

type Filter = 'all' | 'review' | 'tiles' | 'objects';

/** A model's terrain box snapped to whole cells. */
function snapBlock(r: { x: number; y: number; w: number; h: number }, cell: number) {
  const x = Math.round(r.x / cell) * cell;
  const y = Math.round(r.y / cell) * cell;
  return { x, y, w: Math.round((r.x + r.w) / cell) * cell - x, h: Math.round((r.y + r.h) / cell) * cell - y };
}

function toCanvas(img: RGBAImage, className = ''): HTMLCanvasElement {
  const canvas = el('canvas', { class: className });
  canvas.width = Math.max(1, img.width);
  canvas.height = Math.max(1, img.height);
  const ctx = canvas.getContext('2d');
  if (ctx && img.width > 0 && img.height > 0) ctx.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  return canvas;
}

const STAGES: { id: Stage; label: string }[] = [
  { id: 'analyse', label: 'Read pixels' },
  { id: 'detect', label: 'Vision model' },
  { id: 'refine', label: 'Pixel refinement' },
  { id: 'verify', label: 'Verification' },
  { id: 'reinspect', label: 'Second inspection' },
  { id: 'done', label: 'Ready' },
];

/**
 * AI Extract: looks at a sheet with a vision model, pins every asset to
 * its exact pixels, checks the result, and shows it for review before it
 * goes into the library.
 */
export function openAiExtract(source: ExtractSource, hooks: ExtractHooks): void {
  const body = el('div', { class: 'ai-extract' });
  let extraction: Extraction | null = null;
  let abort: AbortController | null = null;
  const selected = new Set<string>();
  let filter: Filter = 'all';
  let drawing = false;

  const modal = openModal({
    title: `AI Extract: ${source.name}`,
    body,
    wide: true,
    actions: [{ label: 'Close', onSelect: () => abort?.abort() }],
    onClose: () => abort?.abort(),
  });
  modal.element.classList.add('ai-wide');

  // --- Before a run: the model and the start buttons ----------------------

  const guess = guessFormat(source.name, source.image.width, source.image.height);
  let terrain: AutotileBuild | null = guess?.autotiles ? buildAutotiles(source.image, guess, source.name) : null;
  let asAssets = !terrain;

  const showSetup = async (error?: string) => {
    if (terrain && !asAssets) {
      void showTerrain(guess!, error);
      return;
    }
    clear(body);
    const footer = modal.element.querySelector('.modal-actions')!;
    clear(footer);
    footer.append(button('btn subtle', 'Close', () => modal.close(), [el('span', { text: 'Close' })]));
    const status = el('p', { class: 'ai-status', text: 'Checking for a vision model…' });
    const errorLine = error ? el('p', { class: 'ai-error', text: error }) : null;
    const settingsBox = el('div', { class: 'ai-settings' });
    const start = button('btn primary', 'Look at the sheet with the vision model and extract every asset', () => void run(true), [el('span', { text: 'AI Extract' })]);
    const pixelsOnly = button('btn subtle', 'Use pixel analysis only. Nothing is sent anywhere, and every asset is marked for review.', () => void run(false), [
      el('span', { text: 'Pixel analysis only' }),
    ]);
    const settingsButton = button('btn subtle', 'Choose the provider, model and API key', () => {
      settingsBox.hidden = !settingsBox.hidden;
    }, [el('span', { text: 'Model settings' })]);
    body.append(
      el('div', { class: 'ai-intro' }, [
        el('p', {
          text: `${source.image.width} x ${source.image.height} px sheet. The vision model inspects it in enlarged, overlapping views and says which pixels form each asset; every crop is then cut from the original PNG pixel for pixel and checked.`,
        }),
        source.decodedBy === 'browser' ? el('p', { class: 'hint', text: 'This picture is not a PNG, so its pixels were read by the browser.' }) : null,
      ]),
      status,
      ...(errorLine ? [errorLine] : []),
      el('div', { class: 'ai-row' }, [start, pixelsOnly, el('div', { class: 'spacer' }), settingsButton]),
      settingsBox,
    );
    if (guess && !guess.autotiles) body.insertBefore(el('p', { class: 'ai-status', text: guess.note }), status);
    if (terrain) {
      body.insertBefore(
        button('btn subtle', 'Go back to reading this sheet as connected terrain', () => {
          asAssets = false;
          void showSetup();
        }, [el('span', { text: 'Back to terrain' })]),
        status,
      );
    }
    buildSettings(settingsBox, () => void showSetup());

    const { resolved, server } = await resolveVision();
    if (resolved) {
      status.textContent = `Vision model: ${describeConfig(resolved.config)} (${resolved.where === 'server' ? 'key held by the local server' : 'key saved in this browser'}).`;
      settingsBox.hidden = true;
    } else {
      status.textContent = NO_KEY_MESSAGE;
      status.classList.add('ai-error');
      start.disabled = true;
      settingsBox.hidden = false;
      if (server?.error && server.error !== NO_KEY_MESSAGE) status.textContent += ` (Local server: ${server.error})`;
    }
  };

  const buildSettings = (box: HTMLElement, saved: () => void) => {
    const current = loadVisionSettings();
    const provider = el('select', { class: 'select' }, PROVIDERS.map((p) => el('option', { value: p.id, text: p.label }))) as HTMLSelectElement;
    provider.value = current.provider;
    const model = el('input', { class: 'input', value: current.model, placeholder: 'model name' }) as HTMLInputElement;
    const key = el('input', { class: 'input', type: 'password', value: current.apiKey, placeholder: 'API key' }) as HTMLInputElement;
    key.autocomplete = 'off';
    const base = el('input', { class: 'input', value: current.baseUrl, placeholder: 'https://… (only for OpenAI-compatible endpoints)' }) as HTMLInputElement;
    provider.addEventListener('change', () => {
      model.value = DEFAULT_MODELS[provider.value as ProviderId] || model.value;
    });
    const field = (label: string, input: HTMLElement) => el('label', { class: 'field' }, [el('span', { class: 'field-label', text: label }), input]);
    clear(box);
    box.append(
      el('div', { class: 'grid-2' }, [field('Provider', provider), field('Model', model)]),
      field('API key', key),
      field('Base URL', base),
      el('p', {
        class: 'hint',
        text: 'The key stays in this browser and is sent only to the provider you choose. Leave it empty to use a key from the local server instead (OPENAI_API_KEY, ANTHROPIC_API_KEY or GEMINI_API_KEY when running npm run dev or npm run full).',
      }),
      el('div', { class: 'ai-row' }, [
        button('btn primary', 'Save model settings', () => {
          saveVisionSettings({ provider: provider.value as ProviderId, model: model.value, apiKey: key.value, baseUrl: base.value });
          hooks.toast('Model settings saved');
          saved();
        }, [el('span', { text: 'Save' })]),
        button('btn subtle', 'Forget the saved key', () => {
          saveVisionSettings({ provider: provider.value as ProviderId, model: model.value, apiKey: '', baseUrl: base.value });
          hooks.toast('Key removed from this browser');
          saved();
        }, [el('span', { text: 'Remove key' })]),
      ]),
    );
  };

  // --- A recognised terrain sheet ---------------------------------------

  const tileOf = (build: AutotileBuild, row: number, shape: number): RGBAImage => {
    const c = build.sheet.cell;
    const out = { width: c, height: c, data: new Uint8ClampedArray(c * c * 4) };
    for (let y = 0; y < c; y++) {
      const from = ((row * c + y) * build.atlas.width + shape * c) * 4;
      out.data.set(build.atlas.data.subarray(from, from + c * 4), y * c * 4);
    }
    return out;
  };

  /** A small patch painted by the rules: what the material looks like on a map. */
  const sample = (build: AutotileBuild, row: number): RGBAImage => {
    const c = build.sheet.cell;
    const floor = build.sheet.materials[row].kind === 'floor';
    const layout = floor
      ? [
          [34, 20, 36, -1],
          [16, 0, 24, -1],
          [40, 28, 38, 46],
        ]
      : [
          [3, 2, 6, -1],
          [9, 8, 12, 15],
        ];
    const out = { width: 4 * c, height: layout.length * c, data: new Uint8ClampedArray(4 * c * layout.length * c * 4) };
    layout.forEach((cells, y) =>
      cells.forEach((shape, x) => {
        if (shape < 0) return;
        const tile = tileOf(build, row, shape);
        for (let yy = 0; yy < c; yy++) out.data.set(tile.data.subarray(yy * c * 4, (yy + 1) * c * 4), ((y * c + yy) * out.width + x * c) * 4);
      }),
    );
    return out;
  };

  const showTerrain = async (g: FormatGuess, error?: string) => {
    const build = terrain!;
    clear(body);
    const sheet = build.sheet;
    const verified = sheet.materials.filter((m) => m.flags.length === 0).length;
    const label = g.format.replace('rpgmaker-', 'RPG Maker ').replace(/a(\d)$/, 'A$1');
    const { resolved } = await resolveVision();
    const nameButton = button('btn subtle', 'Ask the vision model what each material is', () => void nameWithModel(), [
      el('span', { text: resolved ? `Name with ${describeConfig(resolved.config)}` : 'Name with a vision model' }),
    ]);
    nameButton.disabled = !resolved;
    const nameWithModel = async () => {
      if (!resolved) return;
      nameButton.disabled = true;
      hooks.toast('Asking the model to name each material…');
      try {
        const { names } = await nameMaterials(createVisionClient(resolved.config), source.image, g, streamZlib);
        terrain = buildAutotiles(source.image, g, source.name, names);
        void showTerrain(g);
      } catch (e) {
        void showTerrain(g, e instanceof Error ? e.message : 'The model could not be reached.');
      }
    };
    body.append(
      el('div', { class: 'ai-status' }, [
        el('strong', { text: `Recognised: ${label}${g.byName ? ' (from the file name and size)' : ' (from the size)'}` }),
        el('p', { text: g.note }),
        ...sheet.notes.slice(1).map((n) => el('p', { class: 'hint', text: n })),
      ]),
      ...(error ? [el('p', { class: 'ai-status ai-error', text: error })] : []),
      el('div', { class: 'ai-summary' }, [
        el('span', { class: 'ai-pill', text: `${sheet.materials.length} terrain materials` }),
        el('span', { class: `ai-pill${verified < sheet.materials.length ? ' warn' : ''}`, text: `${verified} of ${sheet.materials.length} verified as autotiles` }),
        el('span', { class: 'ai-pill muted', text: `${build.empty} empty blocks skipped` }),
        el('span', { class: 'ai-pill muted', text: `${sheet.cell} px cells, ${sheet.cell / 2} px pieces` }),
      ]),
      el('p', {
        class: 'hint',
        text: 'Each block becomes one material. Its pieces are assembled by the format’s own rules into every edge, corner and inner corner, and painting picks the right one from the neighbours.',
      }),
      el('div', { class: 'ai-row' }, [
        nameButton,
        el('div', { class: 'spacer' }),
        button('btn subtle', 'Ignore the format and extract the pictures on this sheet as separate assets', () => {
          asAssets = true;
          void showSetup();
        }, [el('span', { text: 'Treat as separate assets instead' })]),
      ]),
      el(
        'div',
        { class: 'ai-terrain' },
        sheet.materials.map((m, row) => {
          const name = el('input', { class: 'input ai-name', value: m.name }) as HTMLInputElement;
          name.addEventListener('change', () => {
            if (name.value.trim()) m.name = name.value.trim().slice(0, 40);
          });
          const role = { floor: 'floor', 'wall-top': 'wall top', 'wall-side': 'wall face', roof: 'roof' }[m.role];
          return el('div', { class: `ai-item ai-material${m.flags.length ? ' review' : ''}` }, [
            el('figure', {}, [toCanvas(tileOf(build, row, m.kind === 'floor' ? FLOOR_PREVIEW : 15), 'ai-thumb'), el('figcaption', { text: 'preview' })]),
            el('figure', {}, [toCanvas(sample(build, row), 'ai-sample'), el('figcaption', { text: 'painted' })]),
            el('div', { class: 'ai-meta' }, [
              name,
              el('div', {
                class: 'muted',
                text: `${role} · block at ${m.source.x}, ${m.source.y} · ${Math.round(m.confidence * 100)}%${m.pair !== undefined ? ` · goes with ${sheet.materials[m.pair]?.name}` : ''}`,
              }),
              el('div', { class: 'ai-flag info', text: m.edge.note }),
              ...m.flags.map((f) => el('div', { class: 'ai-flag warn', text: f })),
            ]),
          ]);
        }),
      ),
    );
    const footer = modal.element.querySelector('.modal-actions')!;
    clear(footer);
    footer.append(
      button('btn subtle', 'Close without adding', () => modal.close(), [el('span', { text: 'Close' })]),
      button('btn primary', 'Add these materials to the library as terrain you paint', () => {
        void hooks.addAutotiles(build).then(() => modal.close());
      }, [el('span', { text: `Add ${sheet.materials.length} terrain materials` })]),
    );
  };

  // --- The run -----------------------------------------------------------

  const run = async (useModel: boolean) => {
    let resolved: ResolvedVision | null = null;
    if (useModel) {
      resolved = (await resolveVision()).resolved;
      if (!resolved) {
        void showSetup(NO_KEY_MESSAGE);
        return;
      }
    }
    clear(body);
    abort = new AbortController();
    const steps = new Map<Stage, HTMLElement>();
    const stepper = el(
      'ol',
      { class: 'ai-steps' },
      STAGES.filter((s) => useModel || (s.id !== 'reinspect')).map((s) => {
        const item = el('li', { text: s.label });
        steps.set(s.id, item);
        return item;
      }),
    );
    const log = el('ul', { class: 'ai-log' });
    body.append(stepper, log);
    let reached = 0;
    const order = STAGES.map((s) => s.id);
    try {
      const client = resolved ? createVisionClient(resolved.config) : null;
      extraction = await extractSheet({
        name: source.name,
        image: source.image,
        zlib: streamZlib,
        client,
        cellHint: source.cellHint,
        signal: abort.signal,
        onProgress: (stage, message) => {
          reached = Math.max(reached, order.indexOf(stage));
          steps.forEach((item, id) => {
            item.classList.toggle('done', order.indexOf(id) < reached || stage === 'done');
            item.classList.toggle('active', id === stage && stage !== 'done');
          });
          log.append(el('li', { text: message }));
          log.scrollTop = log.scrollHeight;
        },
      });
      if (source.decodedBy === 'browser') extraction.result.log.unshift('Pixels were read by the browser, not from PNG data.');
      showResults();
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      const message = error instanceof VisionError || error instanceof Error ? error.message : 'Extraction failed.';
      void showSetup(`Nothing was extracted: ${message}`);
    } finally {
      abort = null;
    }
  };

  // --- Review ------------------------------------------------------------

  const assets = () => extraction?.refined.assets ?? [];
  const visible = () =>
    assets().filter((a) =>
      filter === 'review' ? a.needsReview : filter === 'tiles' ? a.kind === 'tile' : filter === 'objects' ? a.kind !== 'tile' : true,
    );

  let overlayScale = 2;
  const overlayWrap = el('div', { class: 'ai-overlay' });
  const listBox = el('div', { class: 'ai-list' });
  const summary = el('div', { class: 'ai-summary' });
  const tools = el('div', { class: 'ai-row ai-tools' });

  const showResults = () => {
    if (!extraction) return;
    clear(body);
    const { width, height } = extraction.result;
    overlayScale = Math.max(2, Math.min(4, Math.floor(1600 / Math.max(width, height))));
    body.append(summary, tools, el('div', { class: 'ai-review' }, [overlayWrap, listBox]));
    // Blocks the model called terrain may be autotiles even on a sheet of no known format.
    const cell = extraction.result.cell;
    const found = cell ? artworkAutotiles(source.image, cell, extraction.terrain.map((t) => snapBlock(t.bbox, cell))) : null;
    if (found) {
      body.insertBefore(
        el('div', { class: 'ai-status' }, [
          el('p', { text: found.note }),
          button('btn subtle', 'Add these blocks as connected terrain materials as well', () => {
            void hooks.addAutotiles(flagArtworkBuild(buildAutotiles(source.image, found, `${source.name} terrain`))).then(() => hooks.toast('Terrain added; it is flagged for checking.'));
          }, [el('span', { text: `Add ${found.slots.length} as terrain` })]),
        ]),
        summary,
      );
    }
    const footer = modal.element.querySelector('.modal-actions')!;
    clear(footer);
    footer.append(
      button('btn subtle', 'Run the extraction again', () => void showSetup(), [el('span', { text: 'Start over' })]),
      button('btn subtle', 'Download every asset as a PNG, plus a packed atlas and JSON metadata', () => void exportZip(), [el('span', { text: 'Export ZIP' })]),
      button('btn primary', 'Put these assets in the asset library, ready to place on the map', () => void addToLibrary(), [el('span', { text: 'Add to library' })]),
    );
    refresh();
  };

  const refresh = () => {
    if (!extraction) return;
    const list = assets();
    for (const id of [...selected]) if (!list.some((a) => a.id === id)) selected.delete(id);
    const tiles = list.filter((a) => a.kind === 'tile').length;
    const review = list.filter((a) => a.needsReview).length;
    const s = extraction.result.stats;
    clear(summary);
    summary.append(
      el('span', { class: 'ai-pill', text: `${list.length} assets` }),
      el('span', { class: 'ai-pill', text: `${tiles} tiles` }),
      el('span', { class: 'ai-pill', text: `${list.length - tiles} objects` }),
      el('span', { class: `ai-pill${review ? ' warn' : ''}`, text: `${review} need review` }),
      el('span', { class: 'ai-pill muted', text: extraction.result.model ? `${extraction.result.model}, ${s.modelCalls} calls, ${s.reinspected} re-inspected` : 'pixel analysis only' }),
      ...(s.unassignedPixels ? [el('span', { class: 'ai-pill warn', text: `${s.unassignedPixels} px unassigned` })] : []),
    );
    buildTools();
    drawOverlay();
    buildList();
  };

  const buildTools = () => {
    clear(tools);
    const filterChip = (id: Filter, label: string) =>
      button(`chip${filter === id ? ' active' : ''}`, `Show ${label.toLowerCase()}`, () => {
        filter = id;
        refresh();
      }, [el('span', { text: label })]);
    const picked = [...selected];
    const one = picked.length === 1 ? assets().find((a) => a.id === picked[0]) : undefined;
    const act = (label: string, title: string, enabled: boolean, run: () => void, extra = '') => {
      const b = button(`chip${extra}`, title, () => {
        run();
        refresh();
      }, [el('span', { text: label })]);
      b.disabled = !enabled;
      return b;
    };
    const sheet = extraction!.sheet;
    const refined = extraction!.refined;
    tools.append(
      filterChip('all', 'All'),
      filterChip('review', 'Needs review'),
      filterChip('tiles', 'Tiles'),
      filterChip('objects', 'Objects'),
      el('div', { class: 'spacer' }),
      act('Approve', 'Mark the selected assets as checked', picked.length > 0, () => picked.forEach((id) => approve(refined, id))),
      act('Merge', 'Join the selected assets into one', picked.length > 1, () => {
        const merged = mergeSelected(sheet, refined, picked);
        selected.clear();
        if (merged) selected.add(merged.id);
      }),
      act(one?.kind === 'tile' ? 'Make object' : 'Make tile', 'Switch between a floor tile and a placed object', !!one, () => {
        if (!setKind(sheet, refined, one!.id, one!.kind === 'tile' ? 'object' : 'tile')) hooks.toast('Only something that fits in one grid cell can be a tile.');
      }),
      act(drawing ? 'Drawing…' : 'Draw box', 'Drag a box on the sheet: every drawn pixel inside becomes a new asset', true, () => {
        drawing = !drawing;
      }, drawing ? ' active' : ''),
      act('Delete', 'Remove the selected assets', picked.length > 0, () => {
        deleteSelected(refined, picked);
        selected.clear();
      }, ' danger'),
    );
  };

  const drawOverlay = () => {
    if (!extraction) return;
    const { sheet, refined } = extraction;
    const view = renderOverlay(sheet.image, refined.assets, overlayScale);
    const canvas = toCanvas(view, 'ai-overlay-canvas');
    const ctx = canvas.getContext('2d')!;
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#ffffff';
    for (const a of refined.assets) {
      if (!selected.has(a.id)) continue;
      ctx.strokeRect(a.rect.x * overlayScale - 3, a.rect.y * overlayScale - 3, a.rect.w * overlayScale + 6, a.rect.h * overlayScale + 6);
    }
    const band = el('div', { class: 'ai-band' });
    band.hidden = true;
    clear(overlayWrap);
    overlayWrap.append(el('div', { class: 'ai-overlay-stage' }, [canvas, band]), el('p', { class: 'hint', text: 'Each outline is one asset, traced on its exact pixels. Red dashes mark assets that need review. Tap an asset to select it.' }));

    const toSheet = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      return {
        x: Math.floor(((e.clientX - r.left) / r.width) * sheet.image.width),
        y: Math.floor(((e.clientY - r.top) / r.height) * sheet.image.height),
      };
    };
    let from: { x: number; y: number } | null = null;
    canvas.addEventListener('pointerdown', (e) => {
      const p = toSheet(e);
      if (drawing) {
        from = p;
        canvas.setPointerCapture(e.pointerId);
        return;
      }
      const owner = refined.owner[p.y * sheet.image.width + p.x];
      const hit = owner >= 0 ? refined.assets[owner] : null;
      if (!e.shiftKey && !e.metaKey) selected.clear();
      if (hit) {
        if (selected.has(hit.id)) selected.delete(hit.id);
        else selected.add(hit.id);
        listBox.querySelector(`[data-id="${hit.id}"]`)?.scrollIntoView({ block: 'nearest' });
      }
      refresh();
    });
    const boxFrom = (a: { x: number; y: number }, b: { x: number; y: number }) => ({
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      w: Math.abs(b.x - a.x) + 1,
      h: Math.abs(b.y - a.y) + 1,
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!from) return;
      const box = boxFrom(from, toSheet(e));
      const k = canvas.getBoundingClientRect().width / sheet.image.width;
      band.hidden = false;
      Object.assign(band.style, { left: `${box.x * k}px`, top: `${box.y * k}px`, width: `${box.w * k}px`, height: `${box.h * k}px` });
    });
    canvas.addEventListener('pointerup', (e) => {
      if (!from) return;
      const box = boxFrom(from, toSheet(e));
      from = null;
      band.hidden = true;
      const made = claimBox(sheet, refined, box);
      if (!made) hooks.toast('Nothing is drawn inside that box.');
      else {
        selected.clear();
        selected.add(made.id);
      }
      drawing = false;
      refresh();
    });
  };

  const buildList = () => {
    if (!extraction) return;
    const { sheet, refined } = extraction;
    clear(listBox);
    const rows = visible();
    if (rows.length === 0) listBox.append(el('p', { class: 'muted', text: 'Nothing to show here.' }));
    for (const a of rows) listBox.append(row(a, sheet.image, refined));
  };

  const row = (a: ExtractedAsset, image: RGBAImage, refined: Extraction['refined']) => {
    const original = toCanvas(cropRect(image, a), 'ai-thumb');
    const extracted = toCanvas(assetImage(image, a), 'ai-thumb checker');
    const name = el('input', { class: 'input ai-name', value: a.name }) as HTMLInputElement;
    name.addEventListener('change', () => rename(refined, a.id, name.value));
    const category = el('select', { class: 'select ai-cat' }, CATEGORIES.map((c) => el('option', { value: c, text: c }))) as HTMLSelectElement;
    category.value = a.category;
    category.addEventListener('change', () => rename(refined, a.id, a.name, category.value as Category));
    const check = el('input', { type: 'checkbox', checked: selected.has(a.id) }) as HTMLInputElement;
    check.addEventListener('change', () => {
      if (check.checked) selected.add(a.id);
      else selected.delete(a.id);
      refresh();
    });
    const issues = a.flags.filter((f) => f.severity !== 'info');
    const notes = a.flags.filter((f) => f.severity === 'info');
    return el('div', { class: `ai-item${a.needsReview ? ' review' : ''}${selected.has(a.id) ? ' selected' : ''}`, dataset: { id: a.id } }, [
      check,
      el('figure', {}, [original, el('figcaption', { text: 'sheet' })]),
      el('figure', {}, [extracted, el('figcaption', { text: 'extracted' })]),
      el('div', { class: 'ai-meta' }, [
        el('div', { class: 'ai-row' }, [name, category]),
        el('div', {
          class: 'muted',
          text: `${a.kind} · ${a.rect.w} x ${a.rect.h} px at ${a.rect.x}, ${a.rect.y} · anchor ${a.anchor.x}, ${a.anchor.y} · ${Math.round(a.confidence * 100)}%${a.animation ? ` · ${a.animation.group} frame ${a.animation.frame}` : ''}`,
        }),
        ...issues.map((f) => el('div', { class: `ai-flag ${f.severity}`, text: f.message })),
        ...notes.slice(0, 2).map((f) => el('div', { class: 'ai-flag info', text: f.message })),
      ]),
    ]);
  };

  /** The asset's box on the sheet as drawn, neighbours and all, for comparison. */
  const cropRect = (image: RGBAImage, a: ExtractedAsset): RGBAImage => {
    const out = { width: a.rect.w, height: a.rect.h, data: new Uint8ClampedArray(a.rect.w * a.rect.h * 4) };
    for (let y = 0; y < a.rect.h; y++) {
      const from = ((a.rect.y + y) * image.width + a.rect.x) * 4;
      out.data.set(image.data.subarray(from, from + a.rect.w * 4), y * a.rect.w * 4);
    }
    return out;
  };

  const exportZip = async () => {
    if (!extraction) return;
    const bundle = await exportBundle(extraction.sheet.image, { ...extraction.result, assets: assets() }, streamZlib);
    await hooks.saveZip(bundle.zip, `${source.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'sheet'}-assets.zip`);
  };

  const addToLibrary = async () => {
    if (!extraction) return;
    const left = assets().filter((a) => a.needsReview).length;
    extraction.result.assets = assets();
    await hooks.addToLibrary(extraction);
    if (left) hooks.toast(`${left} assets were added still marked for review.`);
    modal.close();
  };

  void showSetup();
}
