import {
  ensureGeneratedSheet,
  extractTile,
  persistGeneratedSheet,
  writeGeneratedTile,
} from '../core/custom-tiles';
import { cellIndex, type TileLayer } from '../core/doc';
import { snapshot } from '../core/history';
import type { Store } from '../core/store';
import { EMPTY, flagsOf, flipFlagsH, flipFlagsV, pack, rotateFlagsCW, type PackedTile } from '../core/tiles';
import { dominantColor, recolorToCanvas } from '../io/recolor';
import type { Renderer } from '../render/renderer';
import { drawTile } from '../render/tile-draw';
import { ColorWheel, hexToHsv, hsvToHex } from './color-wheel';
import { button, el } from './dom';
import { icon } from './icons';

/**
 * The per-tile menu, opened by double-tapping a placed tile.
 *
 * Everything here edits that one cell. Recolouring writes a new tile into a
 * generated sheet and points the cell at it, so every other copy of the
 * original stays untouched. Changes apply live; tapping away keeps them, and
 * the whole visit is a single undo step.
 */
export function openAssetMenu(options: {
  store: Store;
  renderer: Renderer;
  layer: TileLayer;
  cell: { x: number; y: number };
  clientX: number;
  clientY: number;
}): void {
  const { store, renderer, layer, cell } = options;
  const doc = store.doc;
  const index = cellIndex(doc, cell.x, cell.y);
  const original: PackedTile = layer.data[index];
  if (original === EMPTY) return;

  const base = extractTile(doc, original);
  if (!base) return;

  const before = snapshot(doc);
  const baseColor = dominantColor(base);

  let flags = flagsOf(original);
  /** Where the recoloured version lives, allocated on first colour change. */
  let sheetIndex: number | null = null;
  let slot: number | null = null;
  /** The tile the cell shows, ignoring flags. */
  let art: PackedTile = original;
  let changed = false;

  const preview = el('canvas', { class: 'asset-preview' });

  const apply = (next: PackedTile) => {
    layer.data[index] = next;
    renderer.markCell(layer.id, cell.x, cell.y);
    renderer.requestDraw();
    drawPreview();
  };

  const current = (): PackedTile => {
    if (art === EMPTY) return EMPTY;
    return pack((art >> 16) & 0xff, art & 0xffff, flags);
  };

  const drawPreview = () => {
    const size = 96;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    preview.width = size * dpr;
    preview.height = size * dpr;
    preview.style.width = `${size}px`;
    preview.style.height = `${size}px`;
    const ctx = preview.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    ctx.imageSmoothingEnabled = false;
    const tile = layer.data[index];
    if (tile !== EMPTY) drawTile(ctx, doc, tile, 0, 0, size);
  };

  const wheel = new ColorWheel(hsvToHex(baseColor), (hex) => {
    const target = hexToHsv(hex);
    // Express the target as a change relative to the tile's own colour, so
    // every shade in it moves together instead of collapsing to one colour.
    const recoloured = recolorToCanvas(base, {
      hueShift: target.h - baseColor.h,
      saturation: baseColor.s > 0.02 ? target.s / baseColor.s : 1,
      brightness: baseColor.v > 0.02 ? target.v / baseColor.v : 1,
    });

    if (sheetIndex === null || slot === null) {
      sheetIndex = ensureGeneratedSheet(doc, base.width, base.height);
      slot = doc.tilesets[sheetIndex].count;
    }
    writeGeneratedTile(doc.tilesets[sheetIndex], slot, recoloured);
    art = pack(sheetIndex, slot, 0);
    changed = true;
    apply(current());
  });

  const transform = (next: number) => {
    flags = next;
    changed = true;
    apply(current());
  };

  const backdrop = el('div', { class: 'popover-backdrop' });
  const panel = el('div', { class: 'popover asset-menu' }, [
    el('div', { class: 'asset-head' }, [
      preview,
      el('div', { class: 'asset-actions' }, [
        button('icon-btn', 'Flip across', () => transform(flipFlagsH(flags)), [icon('flipH', 20)]),
        button('icon-btn', 'Flip down', () => transform(flipFlagsV(flags)), [icon('flipV', 20)]),
        button('icon-btn', 'Rotate', () => transform(rotateFlagsCW(flags)), [icon('rotate', 20)]),
        button('icon-btn danger', 'Delete this tile', () => {
          art = EMPTY;
          changed = true;
          apply(EMPTY);
          close(true);
        }, [icon('trash', 20)]),
      ]),
    ]),
    el('p', { class: 'hint', text: 'Drag on the wheel to change hue and saturation.' }),
    wheel.element,
    el('div', { class: 'asset-footer' }, [
      button('btn subtle', 'Reset this tile', () => {
        flags = flagsOf(original);
        art = original;
        changed = false;
        apply(original);
        wheel.setColor(hsvToHex(baseColor));
      }, [el('span', { text: 'Reset' })]),
      button('btn primary', 'Done', () => close(true), [el('span', { text: 'Done' })]),
    ]),
  ]);
  backdrop.append(panel);
  document.body.append(backdrop);

  function close(keep: boolean): void {
    document.removeEventListener('keydown', onKey);
    backdrop.remove();

    if (!keep || !changed) {
      layer.data[index] = original;
      // Previewing a colour may have created the edited-tiles sheet or taken
      // a slot in it. Nothing is being kept, so put the sheets back too, or a
      // stray sheet would appear with no undo step to remove it.
      if (sheetIndex !== null) {
        doc.tilesets = before.tilesets.map((t) => ({ ...t }));
        store.restructured();
      }
      renderer.markCell(layer.id, cell.x, cell.y);
      renderer.requestDraw();
      return;
    }

    if (sheetIndex !== null) persistGeneratedSheet(doc.tilesets[sheetIndex]);
    store.history.commitSnapshot(art === EMPTY ? 'Delete tile' : 'Edit tile', before);
    renderer.invalidateAll();
    store.restructured();
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close(true);
  };
  document.addEventListener('keydown', onKey);
  // Tapping away keeps the edit. Reset is there for changing your mind.
  backdrop.addEventListener('pointerdown', (e) => {
    if (e.target === backdrop) close(true);
  });

  drawPreview();
  position(panel, wheel, options.clientX, options.clientY);
}

/** Places the menu beside the tap, nudged back on screen if it would overflow. */
function position(panel: HTMLElement, wheel: ColorWheel, x: number, y: number): void {
  wheel.layout();
  const margin = 10;
  const width = panel.offsetWidth || 280;
  const height = panel.offsetHeight || 460;

  // Prefer the side with more room, so the tile itself stays visible.
  let left = x + 24;
  if (left + width > window.innerWidth - margin) left = x - width - 24;
  left = Math.max(margin, Math.min(window.innerWidth - width - margin, left));
  const top = Math.max(margin, Math.min(window.innerHeight - height - margin, y - height / 2));

  panel.style.left = `${Math.round(left)}px`;
  panel.style.top = `${Math.round(top)}px`;
}
