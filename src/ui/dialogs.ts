import { guessLayout, sheetGeometry, type SheetLayout } from '../character/import';
import { DIRECTIONS, DIRECTION_LABELS, type Character } from '../character/model';
import { MAX_MAP_SIZE, MIN_MAP_SIZE, loadImage, sliceCount } from '../core/doc';
import type { Store } from '../core/store';
import {
  buildMapJson,
  buildSpriteSheetJson,
  renderPng,
  renderSpriteSheet,
  renderTilesetSheet,
  saveFile,
  slugify,
} from '../io/export';
import { serializeProject } from '../io/project';
import { el } from './dom';
import { openModal } from './modal';

export interface TilesetSpec {
  src: string;
  name: string;
  tileW: number;
  tileH: number;
  margin: number;
  spacing: number;
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read file'));
    reader.readAsDataURL(file);
  });
}

export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = el('input', { type: 'file', accept });
    input.style.display = 'none';
    // Safari needs the input in the document for the picker to open reliably.
    document.body.append(input);
    let settled = false;
    const finish = (file: File | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(file);
    };
    input.addEventListener('change', () => finish(input.files?.[0] ?? null));
    // There is no cancel event in older Safari, so fall back to focus return.
    input.addEventListener('cancel', () => finish(null));
    window.addEventListener('focus', () => setTimeout(() => finish(input.files?.[0] ?? null), 400), {
      once: true,
    });
    input.click();
  });
}

function numberInput(value: number, min: number, max: number): HTMLInputElement {
  const input = el('input', { class: 'input', type: 'number', min, max, step: 1, value });
  input.inputMode = 'numeric';
  return input;
}

function field(label: string, control: HTMLElement): HTMLElement {
  return el('label', { class: 'field' }, [el('span', { class: 'field-label', text: label }), control]);
}

/**
 * Import or retune a tileset. The preview redraws the slice grid as the
 * numbers change, which is the only reliable way to tell whether a sheet uses
 * margins or spacing without counting pixels by hand.
 */
export function openTilesetDialog(options: {
  title: string;
  confirmLabel?: string;
  initial?: Partial<TilesetSpec>;
  defaultTileSize: number;
  onConfirm: (spec: TilesetSpec) => void;
}): void {
  let src = options.initial?.src ?? '';
  let image: HTMLImageElement | null = null;

  const name = el('input', { class: 'input', type: 'text', value: options.initial?.name ?? '' });
  const tileW = numberInput(options.initial?.tileW ?? options.defaultTileSize, 1, 512);
  const tileH = numberInput(options.initial?.tileH ?? options.defaultTileSize, 1, 512);
  const margin = numberInput(options.initial?.margin ?? 0, 0, 512);
  const spacing = numberInput(options.initial?.spacing ?? 0, 0, 512);

  const canvas = el('canvas', { class: 'tileset-preview' });
  const summary = el('p', { class: 'hint', text: 'Choose an image to begin.' });
  const chooseLabel = el('span', { text: src ? 'Replace image' : 'Choose image' });

  const choose = el(
    'button',
    {
      class: 'btn subtle full',
      type: 'button',
      on: {
        click: async () => {
          const file = await pickFile('image/*');
          if (!file) return;
          src = await readFileAsDataUrl(file);
          if (!name.value.trim()) name.value = file.name.replace(/\.[^.]+$/, '');
          chooseLabel.textContent = 'Replace image';
          await refresh();
        },
      },
    },
    [chooseLabel],
  );

  const redrawPreview = () => {
    if (!image) return;
    const box = 320;
    const scale = Math.min(box / image.naturalWidth, box / image.naturalHeight, 4);
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    canvas.width = width;
    canvas.height = height;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingEnabled = scale < 1;
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(image, 0, 0, width, height);

    const tw = Math.max(1, Number(tileW.value) || 1);
    const th = Math.max(1, Number(tileH.value) || 1);
    const m = Math.max(0, Number(margin.value) || 0);
    const s = Math.max(0, Number(spacing.value) || 0);
    const { cols, rows, count } = sliceCount({
      imgW: image.naturalWidth,
      imgH: image.naturalHeight,
      tileW: tw,
      tileH: th,
      margin: m,
      spacing: s,
    });

    ctx.strokeStyle = 'rgba(126,160,255,0.85)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let col = 0; col <= cols; col++) {
      const x = Math.round((m + col * (tw + s) - (col === cols ? s : 0)) * scale) + 0.5;
      ctx.moveTo(x, Math.round(m * scale));
      ctx.lineTo(x, Math.round((m + rows * (th + s) - s) * scale));
    }
    for (let row = 0; row <= rows; row++) {
      const y = Math.round((m + row * (th + s) - (row === rows ? s : 0)) * scale) + 0.5;
      ctx.moveTo(Math.round(m * scale), y);
      ctx.lineTo(Math.round((m + cols * (tw + s) - s) * scale), y);
    }
    ctx.stroke();

    summary.textContent =
      count > 0
        ? `${image.naturalWidth} x ${image.naturalHeight} px — ${cols} x ${rows} grid, ${count} tiles`
        : 'No whole tiles fit with these numbers.';
  };

  const refresh = async () => {
    if (!src) return;
    try {
      image = await loadImage(src);
      redrawPreview();
    } catch {
      summary.textContent = 'That image could not be read.';
      image = null;
    }
  };

  for (const input of [tileW, tileH, margin, spacing]) {
    input.addEventListener('input', redrawPreview);
  }

  const body = el('div', { class: 'dialog-body' }, [
    choose,
    el('div', { class: 'preview-wrap' }, [canvas]),
    summary,
    field('Name', name),
    el('div', { class: 'grid-2' }, [field('Tile width', tileW), field('Tile height', tileH)]),
    el('div', { class: 'grid-2' }, [field('Margin', margin), field('Spacing', spacing)]),
    el('p', {
      class: 'hint',
      text: 'Margin is the border around the whole sheet. Spacing is the gap between neighbouring tiles.',
    }),
  ]);

  const modal = openModal({
    title: options.title,
    body,
    actions: [
      { label: 'Cancel' },
      {
        label: options.confirmLabel ?? 'Add tileset',
        variant: 'primary',
        onSelect: () => {
          if (!src || !image) {
            summary.textContent = 'Choose an image first.';
            return false;
          }
          const spec: TilesetSpec = {
            src,
            name: name.value.trim() || 'Tileset',
            tileW: Math.max(1, Number(tileW.value) || 1),
            tileH: Math.max(1, Number(tileH.value) || 1),
            margin: Math.max(0, Number(margin.value) || 0),
            spacing: Math.max(0, Number(spacing.value) || 0),
          };
          const { count } = sliceCount({
            imgW: image.naturalWidth,
            imgH: image.naturalHeight,
            ...spec,
          });
          if (count === 0) {
            summary.textContent = 'No whole tiles fit with these numbers.';
            return false;
          }
          options.onConfirm(spec);
          return true;
        },
      },
    ],
  });

  // Dropping an image onto the dialog is the quickest path on a desktop.
  modal.element.addEventListener('dragover', (e) => e.preventDefault());
  modal.element.addEventListener('drop', async (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (!file || !file.type.startsWith('image/')) return;
    src = await readFileAsDataUrl(file);
    if (!name.value.trim()) name.value = file.name.replace(/\.[^.]+$/, '');
    chooseLabel.textContent = 'Replace image';
    await refresh();
  });

  void refresh();
}

/**
 * Imports an existing character sheet. The preview draws the slice grid and
 * labels each row with the facing it will become, so a wrong row order is
 * obvious before anything is imported rather than after.
 */
export function openSpriteSheetDialog(options: {
  tileSize: number;
  onConfirm: (image: HTMLImageElement, layout: SheetLayout, name: string) => void;
}): void {
  let image: HTMLImageElement | null = null;

  const name = el('input', { class: 'input', type: 'text', value: '' });
  const frameW = numberInput(32, 1, 512);
  const frameH = numberInput(32, 1, 512);
  const columns = numberInput(4, 1, 32);
  const margin = numberInput(0, 0, 512);
  const spacing = numberInput(0, 0, 512);

  // Which sheet row supplies each facing. This is the part that varies most
  // between tools, so it is adjustable rather than assumed.
  const rowPickers = DIRECTIONS.map((dir, i) => {
    const input = numberInput(i, 0, 63);
    return { dir, input };
  });

  const canvas = el('canvas', { class: 'tileset-preview' });
  const summary = el('p', { class: 'hint', text: 'Choose a sprite sheet to begin.' });
  const chooseLabel = el('span', { text: 'Choose sprite sheet' });

  const layoutNow = (): SheetLayout => ({
    frameW: Math.max(1, Number(frameW.value) || 1),
    frameH: Math.max(1, Number(frameH.value) || 1),
    margin: Math.max(0, Number(margin.value) || 0),
    spacing: Math.max(0, Number(spacing.value) || 0),
    columns: Math.max(1, Number(columns.value) || 1),
    rows: Object.fromEntries(rowPickers.map((p) => [p.dir, Number(p.input.value) || 0])) as SheetLayout['rows'],
  });

  const redraw = () => {
    if (!image) return;
    const layout = layoutNow();
    const box = 340;
    const scale = Math.min(box / image.naturalWidth, box / image.naturalHeight, 4);
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    canvas.width = width;
    canvas.height = height;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingEnabled = scale < 1;
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(image, 0, 0, width, height);

    const geometry = sheetGeometry(image.naturalWidth, image.naturalHeight, layout);

    ctx.strokeStyle = 'rgba(126,160,255,0.85)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let c = 0; c <= geometry.cols; c++) {
      const x = Math.round((layout.margin + c * (layout.frameW + layout.spacing)) * scale) + 0.5;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
    }
    for (let r = 0; r <= geometry.rows; r++) {
      const y = Math.round((layout.margin + r * (layout.frameH + layout.spacing)) * scale) + 0.5;
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
    }
    ctx.stroke();

    // Label the rows that will be used.
    ctx.font = '11px -apple-system, system-ui, sans-serif';
    ctx.textBaseline = 'top';
    for (const picker of rowPickers) {
      const row = Number(picker.input.value) || 0;
      if (row < 0 || row >= geometry.rows) continue;
      const y = (layout.margin + row * (layout.frameH + layout.spacing)) * scale;
      ctx.fillStyle = 'rgba(14,15,19,0.78)';
      ctx.fillRect(1, y + 1, 46, 14);
      ctx.fillStyle = '#7ee7b8';
      ctx.fillText(picker.dir, 4, y + 3);
    }

    const usedRows = rowPickers.filter((p) => {
      const r = Number(p.input.value) || 0;
      return r >= 0 && r < geometry.rows;
    }).length;
    const tilesW = Math.max(1, Math.round(layout.frameW / options.tileSize));
    const tilesH = Math.max(1, Math.round(layout.frameH / options.tileSize));
    summary.textContent =
      geometry.cols === 0 || geometry.rows === 0
        ? 'No whole frames fit with these numbers.'
        : `${geometry.cols} x ${geometry.rows} grid · using ${layout.columns} frames from ${usedRows} of 4 rows · ${tilesW} x ${tilesH} tiles on your map`;
  };

  const loadFrom = async (src: string, suggested: string) => {
    try {
      image = await loadImage(src);
      if (!name.value.trim()) name.value = suggested;
      const guess = guessLayout(image.naturalWidth, image.naturalHeight);
      frameW.value = String(guess.frameW);
      frameH.value = String(guess.frameH);
      columns.value = String(guess.columns);
      chooseLabel.textContent = 'Replace sheet';
      redraw();
    } catch {
      summary.textContent = 'That image could not be read.';
      image = null;
    }
  };

  const choose = el(
    'button',
    {
      class: 'btn subtle full',
      type: 'button',
      on: {
        click: async () => {
          const file = await pickFile('image/*');
          if (!file) return;
          await loadFrom(await readFileAsDataUrl(file), file.name.replace(/\.[^.]+$/, ''));
        },
      },
    },
    [chooseLabel],
  );

  for (const input of [frameW, frameH, columns, margin, spacing, ...rowPickers.map((p) => p.input)]) {
    input.addEventListener('input', redraw);
  }

  const body = el('div', { class: 'dialog-body' }, [
    choose,
    el('div', { class: 'preview-wrap' }, [canvas]),
    summary,
    field('Name', name),
    el('div', { class: 'grid-2' }, [field('Frame width', frameW), field('Frame height', frameH)]),
    field('Frames per direction', columns),
    el('div', { class: 'grid-2' }, [field('Margin', margin), field('Spacing', spacing)]),
    el('h4', { class: 'panel-title', text: 'Which row is which facing' }),
    el('p', { class: 'hint', text: 'Rows are numbered from 0 at the top. The preview labels them.' }),
    el(
      'div',
      { class: 'grid-2' },
      rowPickers.map((p) => field(DIRECTION_LABELS[p.dir], p.input)),
    ),
  ]);

  openModal({
    title: 'Import sprite sheet',
    wide: true,
    body,
    actions: [
      { label: 'Cancel' },
      {
        label: 'Import',
        variant: 'primary',
        onSelect: () => {
          if (!image) {
            summary.textContent = 'Choose a sprite sheet first.';
            return false;
          }
          const layout = layoutNow();
          const geometry = sheetGeometry(image.naturalWidth, image.naturalHeight, layout);
          if (geometry.cols === 0 || geometry.rows === 0) {
            summary.textContent = 'No whole frames fit with these numbers.';
            return false;
          }
          options.onConfirm(image, layout, name.value.trim() || 'Imported character');
          return true;
        },
      },
    ],
  });
}

export function openNewMapDialog(options: {
  defaults: { width: number; height: number; tileSize: number };
  onConfirm: (value: { width: number; height: number; tileSize: number; name: string }) => void;
}): void {
  const name = el('input', { class: 'input', type: 'text', value: 'Untitled map' });
  const width = numberInput(options.defaults.width, MIN_MAP_SIZE, MAX_MAP_SIZE);
  const height = numberInput(options.defaults.height, MIN_MAP_SIZE, MAX_MAP_SIZE);
  const tileSize = numberInput(options.defaults.tileSize, 1, 256);

  openModal({
    title: 'New map',
    body: el('div', { class: 'dialog-body' }, [
      field('Name', name),
      el('div', { class: 'grid-2' }, [field('Width in tiles', width), field('Height in tiles', height)]),
      field('Grid size (px)', tileSize),
      el('p', { class: 'hint', text: 'This replaces the map you have open. Export it first if you want to keep it.' }),
    ]),
    actions: [
      { label: 'Cancel' },
      {
        label: 'Create',
        variant: 'primary',
        onSelect: () =>
          void options.onConfirm({
            name: name.value.trim() || 'Untitled map',
            width: clamp(Number(width.value), MIN_MAP_SIZE, MAX_MAP_SIZE),
            height: clamp(Number(height.value), MIN_MAP_SIZE, MAX_MAP_SIZE),
            tileSize: clamp(Number(tileSize.value), 1, 256),
          }),
      },
    ],
  });
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}

/** Export sheet: image, engine-ready map data, and a reopenable project file. */
export function openExportDialog(store: Store, characters: Character[] = [], lastPlayedId: string | null = null): void {
  const doc = store.doc;
  const base = slugify(doc.name);

  const scale = el('select', { class: 'select' });
  for (const value of [1, 2, 4, 8]) {
    const option = el('option', { value: String(value), text: `${value}x (${doc.tileSize * value} px tiles)` });
    if (value === 1) option.selected = true;
    scale.append(option);
  }

  const opaque = el('input', { type: 'checkbox', id: 'export-opaque' });
  const visibleOnly = el('input', { type: 'checkbox', id: 'export-visible', checked: true });
  const includeImages = el('input', { type: 'checkbox', id: 'export-images' });
  const hasImages = doc.layers.some((l) => l.kind === 'image');
  const status = el('p', { class: 'hint', text: '' });

  const run = async (label: string, task: () => Promise<void>) => {
    status.textContent = `${label}...`;
    try {
      await task();
      status.textContent = `${label} done.`;
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : 'Export failed.';
    }
  };

  const row = (title: string, description: string, actionLabel: string, onPress: () => void) =>
    el('div', { class: 'export-row' }, [
      el('div', { class: 'export-text' }, [
        el('span', { class: 'export-title', text: title }),
        el('span', { class: 'hint', text: description }),
      ]),
      el(
        'button',
        { class: 'btn subtle', type: 'button', on: { click: onPress } },
        [el('span', { text: actionLabel })],
      ),
    ]);

  const body = el('div', { class: 'dialog-body' }, [
    el('div', { class: 'field' }, [
      el('span', { class: 'field-label', text: 'Image scale' }),
      scale,
    ]),
    el('label', { class: 'checkbox', for: 'export-opaque' }, [
      opaque,
      el('span', { text: 'Fill the background colour' }),
    ]),
    el('label', { class: 'checkbox', for: 'export-visible' }, [
      visibleOnly,
      el('span', { text: 'Only visible layers' }),
    ]),
    hasImages
      ? el('label', { class: 'checkbox', for: 'export-images' }, [
          includeImages,
          el('span', { text: 'Include reference images' }),
        ])
      : null,

    row('Map image', 'Flattened PNG of the whole map.', 'PNG', () =>
      void run('Rendering PNG', async () => {
        const blob = await renderPng(doc, {
          scale: Number(scale.value),
          opaque: opaque.checked,
          visibleOnly: visibleOnly.checked,
          includeImages: includeImages.checked,
        });
        await saveFile(blob, `${base}.png`);
      }),
    ),
    row('Map data', 'Tile positions per layer, ready for Unity, Godot or Phaser.', 'JSON', () =>
      void run('Writing map data', async () => {
        const blob = new Blob([buildMapJson(doc)], { type: 'application/json' });
        await saveFile(blob, `${base}-map.json`);
      }),
    ),
    row('Tileset image', 'The spritesheet this map refers to.', 'PNG', () =>
      void run('Exporting tileset', async () => {
        const blob = await renderTilesetSheet(doc);
        if (!blob) throw new Error('This map has no tileset yet.');
        await saveFile(blob, `${base}-tileset.png`);
      }),
    ),
    ...characters.map((character) => {
      const name = slugify(character.name);
      return row(
        `Character: ${character.name}`,
        `Sprite sheet, ${character.frameCount} frames across x 4 directions down.`,
        'PNG',
        () =>
          void run(`Exporting ${character.name}`, async () => {
            const factor = Number(scale.value);
            const sheet = await renderSpriteSheet(character, factor);
            await saveFile(sheet, `${name}-sheet.png`);
            const meta = new Blob([buildSpriteSheetJson(character, factor)], { type: 'application/json' });
            await saveFile(meta, `${name}-sheet.json`);
          }),
      );
    }),

    row('Project file', 'Everything, so you can reopen and keep editing.', 'Save', () =>
      void run('Saving project', async () => {
        const blob = new Blob([JSON.stringify(serializeProject(doc, characters, lastPlayedId))], {
          type: 'application/json',
        });
        await saveFile(blob, `${base}.habitat.json`);
      }),
    ),
    status,
  ]);

  openModal({ title: 'Export', body, actions: [{ label: 'Done', variant: 'primary' }] });
}
