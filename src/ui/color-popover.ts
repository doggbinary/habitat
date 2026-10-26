import { ColorWheel } from './color-wheel';
import { el } from './dom';

/**
 * A small panel anchored under whatever opened it, closed by tapping beside
 * it or pressing Escape. Returns a function that closes it.
 */
export function openPopover(options: {
  anchor: HTMLElement;
  content: HTMLElement[];
  onClose?: () => void;
  /** Runs once the panel is in the page, before it is measured. */
  onMount?: () => void;
  className?: string;
}): () => void {
  const backdrop = el('div', { class: 'popover-backdrop' });
  const panel = el('div', { class: `popover${options.className ? ` ${options.className}` : ''}` });
  panel.append(...options.content);
  backdrop.append(panel);
  document.body.append(backdrop);

  let open = true;
  const close = () => {
    if (!open) return;
    open = false;
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
  options.onMount?.();
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
  return close;
}

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
  const wheel = new ColorWheel(options.initial, options.onChange);
  openPopover({
    anchor: options.anchor,
    content: [wheel.element, ...(options.extra ?? [])],
    onClose: options.onClose,
    onMount: () => wheel.layout(),
  });
}
