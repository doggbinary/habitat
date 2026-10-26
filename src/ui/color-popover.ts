import { ColorWheel } from './color-wheel';
import { el } from './dom';

/**
 * The colour wheel on demand, anchored to whatever opened it.
 *
 * Keeping it behind a swatch is the whole point: a wheel large enough to aim
 * at with a Pencil is too large to leave on screen permanently, and picking a
 * colour is something you do between strokes rather than constantly.
 */
export function openColorPopover(options: {
  anchor: HTMLElement;
  initial: string;
  onChange: (hex: string) => void;
  onClose?: () => void;
  /** More controls, placed under the wheel's Brightness slider. */
  extra?: HTMLElement[];
}): void {
  const backdrop = el('div', { class: 'popover-backdrop' });
  const panel = el('div', { class: 'popover' });

  const wheel = new ColorWheel(options.initial, options.onChange);
  panel.append(wheel.element, ...(options.extra ?? []));
  backdrop.append(panel);
  document.body.append(backdrop);

  const close = () => {
    document.removeEventListener('keydown', onKey);
    backdrop.remove();
    options.onClose?.();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
  };
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('pointerdown', (e) => {
    if (e.target === backdrop) close();
  });

  // Sit under the anchor, nudged back on screen if that would overflow.
  const rect = options.anchor.getBoundingClientRect();
  wheel.layout();
  const width = panel.offsetWidth || 260;
  const height = panel.offsetHeight || 320;
  const margin = 10;

  let left = rect.left + rect.width / 2 - width / 2;
  left = Math.max(margin, Math.min(window.innerWidth - width - margin, left));

  // Prefer below the anchor; flip above when there is no room.
  let top = rect.bottom + 8;
  if (top + height > window.innerHeight - margin) top = Math.max(margin, rect.top - height - 8);

  panel.style.left = `${Math.round(left)}px`;
  panel.style.top = `${Math.round(top)}px`;
}
