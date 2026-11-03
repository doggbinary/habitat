import { autoCutAsset, cutAsset, type CutPoint } from '../core/cut';
import type { AssetRect, Tileset } from '../core/doc';
import { button, el } from './dom';
import { openModal } from './modal';

/**
 * Cuts one asset that detection joined to its neighbour.
 *
 * The picture is shown large. A stroke across it becomes a straight cut,
 * sliding onto a colour change when one sits close by. Auto does the same
 * look with no stroke. Nothing is written until Cut.
 */

const PIECE_COLORS = ['#7ee787', '#79c0ff', '#ffa657', '#d2a8ff', '#ff7b72', '#ffd666'];

export function openCutter(options: { tileset: Tileset; assetIndex: number; onApply: (pieces: AssetRect[]) => void }): void {
  const { tileset } = options;
  const rect = tileset.assets?.[options.assetIndex];
  const pixels = rect && tileset.image ? readSheet(tileset) : null;
  if (!rect || !pixels || !tileset.image) return;

  const grid = { w: tileset.tileW, h: tileset.tileH, margin: tileset.margin, spacing: tileset.spacing };
  const image = tileset.image;
  const maxW = Math.min(620, Math.max(240, window.innerWidth - 80));
  const maxH = Math.min(380, Math.max(160, window.innerHeight - 220));
  const scale = Math.max(1, Math.min(10, Math.floor(Math.min(maxW / rect.w, maxH / rect.h))));

  const canvas = el('canvas', { class: 'cutter-canvas' });
  canvas.width = rect.w * scale;
  canvas.height = rect.h * scale;
  canvas.style.width = `${canvas.width}px`;
  canvas.style.height = `${canvas.height}px`;
  const ctx = canvas.getContext('2d');

  const status = el('p', { class: 'hint', text: 'Draw across the join. The line settles on a colour change when one is close.' });
  let strokes: CutPoint[][] = [];
  let drawing: CutPoint[] | null = null;
  /** Set when Auto ran and the user has not drawn since. */
  let autoPieces: AssetRect[] | null = null;

  const shown = (): AssetRect[] => {
    const all = drawing ? [...strokes, drawing] : strokes;
    if (all.length > 0) return cutAsset(pixels.rgba, pixels.alpha, tileset.imgW, rect, all);
    if (autoPieces && autoPieces.length > 1) return autoPieces;
    return [rect];
  };

  const paint = () => {
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, rect.x, rect.y, rect.w, rect.h, 0, 0, canvas.width, canvas.height);

    const pieces = shown();
    if (pieces.length > 1) {
      pieces.forEach((piece, i) => {
        ctx.strokeStyle = PIECE_COLORS[i % PIECE_COLORS.length];
        ctx.lineWidth = Math.max(1, Math.round(scale / 4));
        const x = (piece.x - rect.x) * scale;
        const y = (piece.y - rect.y) * scale;
        ctx.strokeRect(x + 0.5, y + 0.5, piece.w * scale - 1, piece.h * scale - 1);
      });
    }

    ctx.strokeStyle = '#ff5d73';
    ctx.lineWidth = Math.max(1, scale / 3);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const stroke of drawing ? [...strokes, drawing] : strokes) {
      if (stroke.length === 0) continue;
      ctx.beginPath();
      stroke.forEach((point, i) => {
        const x = (point.x - rect.x) * scale;
        const y = (point.y - rect.y) * scale;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }
  };

  const pointOf = (e: PointerEvent): CutPoint => {
    const bounds = canvas.getBoundingClientRect();
    const x = rect.x + ((e.clientX - bounds.left) / bounds.width) * rect.w;
    const y = rect.y + ((e.clientY - bounds.top) / bounds.height) * rect.h;
    return {
      x: Math.min(rect.x + rect.w - 1, Math.max(rect.x, x)),
      y: Math.min(rect.y + rect.h - 1, Math.max(rect.y, y)),
    };
  };

  const pushPoint = (stroke: CutPoint[], point: CutPoint) => {
    const last = stroke[stroke.length - 1];
    if (last && Math.round(last.x) === Math.round(point.x) && Math.round(last.y) === Math.round(point.y)) return;
    stroke.push(point);
  };

  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    autoPieces = null;
    drawing = [];
    pushPoint(drawing, pointOf(e));
    refresh();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    e.preventDefault();
    const events = e.getCoalescedEvents?.() ?? [e];
    for (const event of events) pushPoint(drawing, pointOf(event));
    refresh();
  });

  const finish = (e: PointerEvent) => {
    if (!drawing) return;
    pushPoint(drawing, pointOf(e));
    if (drawing.length >= 2) strokes.push(drawing);
    drawing = null;
    refresh();
  };
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', () => {
    drawing = null;
    refresh();
  });

  const undo = button('chip', 'Undo the last line', () => {
    if (strokes.length > 0) strokes.pop();
    else autoPieces = null;
    refresh();
  }, [el('span', { text: 'Undo' })]);

  const clearAll = button('chip', 'Remove every line', () => {
    strokes = [];
    autoPieces = null;
    refresh();
  }, [el('span', { text: 'Clear' })]);

  const auto = button('chip', 'Split where pictures already separate, or where the colour jumps on a grid line', () => {
    strokes = [];
    drawing = null;
    autoPieces = autoCutAsset(pixels.rgba, pixels.alpha, tileset.imgW, rect, grid);
    refresh();
  }, [el('span', { text: 'Auto' })]);

  const body = el('div', { class: 'cutter dialog-body' }, [
    status,
    el('div', { class: 'preview-wrap cutter-stage' }, [canvas]),
    el('div', { class: 'chip-row' }, [auto, undo, clearAll]),
  ]);

  const handle = openModal({
    title: 'Cut',
    wide: true,
    body,
    actions: [
      { label: 'Cancel' },
      {
        label: 'Cut',
        variant: 'primary',
        onSelect: () => {
          const pieces = shown();
          if (pieces.length < 2) return false;
          options.onApply(pieces);
        },
      },
    ],
  });

  const apply = handle.element.querySelector('.modal-actions .btn.primary');

  function refresh(): void {
    const pieces = shown();
    if (apply instanceof HTMLButtonElement) apply.disabled = pieces.length < 2;
    undo.disabled = strokes.length === 0 && !autoPieces;
    clearAll.disabled = strokes.length === 0 && !autoPieces;
    if (pieces.length > 1) {
      status.textContent =
        strokes.length > 0 ? `${pieces.length} pieces. Cut keeps each one.` : `Auto found ${pieces.length} pieces.`;
    } else if (autoPieces) {
      status.textContent = 'Nothing here will split on its own. Draw across the join.';
    } else {
      status.textContent = 'Draw across the join. The line settles on a colour change when one is close.';
    }
    paint();
  }

  refresh();
}

function readSheet(tileset: Tileset): { rgba: Uint8ClampedArray; alpha: Uint8Array } | null {
  if (!tileset.image || tileset.imgW <= 0 || tileset.imgH <= 0) return null;
  const canvas = document.createElement('canvas');
  canvas.width = tileset.imgW;
  canvas.height = tileset.imgH;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(tileset.image, 0, 0);
  const rgba = ctx.getImageData(0, 0, tileset.imgW, tileset.imgH).data;
  const alpha = new Uint8Array(tileset.imgW * tileset.imgH);
  for (let i = 0; i < alpha.length; i++) alpha[i] = rgba[i * 4 + 3];
  return { rgba, alpha };
}
