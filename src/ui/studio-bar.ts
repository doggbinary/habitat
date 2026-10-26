import type { Studio } from '../character/studio';
import { openColorPopover, openPopover } from './color-popover';
import { button, el } from './dom';
import { icon } from './icons';

const HOLD_MS = 500;
const MAX_BRUSH = 16;

/**
 * The character's palette, Procreate style: tap a swatch to paint with it,
 * tap + to stamp the current colour in, press and hold a swatch to remove it.
 */
export function paletteGrid(studio: Studio, changed: () => void): HTMLElement {
  const character = studio.character;
  const grid = el('div', { class: 'swatches' });
  if (!character) return grid;

  character.palette.forEach((hex, index) => {
    const active = studio.color.toLowerCase() === hex.toLowerCase();
    const node = el('button', {
      class: `swatch${active ? ' active' : ''}`,
      type: 'button',
      title: `${hex.toUpperCase()}, press and hold to remove`,
      style: { background: hex },
    });
    let timer: number | undefined;
    let held = false;
    node.addEventListener('pointerdown', () => {
      held = false;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        held = true;
        studio.removeSwatch(index);
        changed();
      }, HOLD_MS);
    });
    const cancel = () => window.clearTimeout(timer);
    node.addEventListener('pointerleave', cancel);
    node.addEventListener('pointercancel', cancel);
    node.addEventListener('pointerup', () => {
      cancel();
      if (held) return;
      studio.color = hex;
      // Choosing a colour means you intend to paint with it.
      if (studio.tool === 'eraser' || studio.tool === 'picker') studio.tool = 'pencil';
      changed();
    });
    node.addEventListener('contextmenu', (e) => e.preventDefault());
    grid.append(node);
  });

  const stamp = button('swatch swatch-add', 'Add the current colour to the palette', () => {
    studio.stampColor();
    changed();
  }, [icon('plus', 18)]);
  stamp.style.setProperty('--stamp', studio.color);
  grid.append(stamp);
  return grid;
}

/**
 * The studio's everyday controls, floating top right of the canvas while the
 * side panel is hidden, so drawing full screen loses nothing you reach for.
 */
export class StudioBar {
  readonly element: HTMLElement;
  private closePopover: (() => void) | null = null;

  constructor(
    private readonly studio: Studio,
    private readonly redraw: () => void,
    /** Something changed: redraw the canvas and anything showing the same state. */
    private readonly changed: () => void,
  ) {
    this.element = el('div', { class: 'studio-bar', aria: { label: 'Studio controls' } });
  }

  setVisible(visible: boolean): void {
    this.element.hidden = !visible;
    if (!visible) this.closePopover?.();
  }

  refresh(): void {
    const studio = this.studio;
    const color = el('button', {
      class: 'current-color studio-bar-color',
      type: 'button',
      title: 'Open the colour wheel',
      style: { background: studio.color },
    });
    color.addEventListener('click', () => {
      openColorPopover({
        anchor: color,
        initial: studio.color,
        onChange: (hex) => {
          studio.color = hex;
          if (studio.tool !== 'pencil') studio.tool = 'pencil';
          color.style.background = hex;
        },
        onClose: () => this.changed(),
      });
    });

    const palette = button('icon-btn', 'Open the palette', () => this.openPalette(palette), [icon('palette', 20)]);

    const brush = this.sizeButton('pencil', 'brush', 'Brush size');
    const eraser = this.sizeButton('eraser', 'eraser', 'Eraser size');

    this.element.replaceChildren(color, palette, brush, eraser);
  }

  private sizeButton(tool: 'pencil' | 'eraser', name: 'brush' | 'eraser', label: string): HTMLElement {
    const studio = this.studio;
    const size = tool === 'eraser' ? studio.eraserSize : studio.pencilSize;
    const active = studio.tool === tool;
    const node = button(`icon-btn studio-bar-tool${active ? ' active' : ''}`, label, () => {
      studio.tool = tool;
      // Open first: the refresh that follows replaces this button.
      this.openSize(node, tool, label);
      this.changed();
    }, [icon(name, 20), el('span', { class: 'studio-bar-size', text: String(size) })]);
    node.setAttribute('aria-pressed', String(active));
    return node;
  }

  private openPalette(anchor: HTMLElement): void {
    const body = el('div', { class: 'studio-palette' });
    const fill = () => {
      body.replaceChildren(
        el('div', { class: 'popover-title', text: 'Palette' }),
        paletteGrid(this.studio, () => {
          this.changed();
          fill();
        }),
        el('p', { class: 'hint', text: 'Tap + to add the colour you are using. Press and hold a colour to remove it.' }),
      );
    };
    fill();
    this.closePopover?.();
    this.closePopover = openPopover({ anchor, content: [body], onClose: () => (this.closePopover = null) });
  }

  private openSize(anchor: HTMLElement, tool: 'pencil' | 'eraser', label: string): void {
    const studio = this.studio;
    const read = () => (tool === 'eraser' ? studio.eraserSize : studio.pencilSize);
    const value = el('span', { class: 'slider-value', text: `${read()} px` });
    const slider = el('input', {
      class: 'slider',
      type: 'range',
      min: '1',
      max: String(MAX_BRUSH),
      step: '1',
      value: String(read()),
      aria: { label },
    });
    slider.addEventListener('input', () => {
      const next = Math.max(1, Math.min(MAX_BRUSH, Math.round(Number(slider.value)) || 1));
      if (tool === 'eraser') studio.eraserSize = next;
      else studio.pencilSize = next;
      value.textContent = `${next} px`;
      this.redraw();
    });
    this.closePopover?.();
    this.closePopover = openPopover({
      anchor,
      className: 'size-popover',
      content: [
        el('div', { class: 'slider-row' }, [el('span', { class: 'field-label', text: label }), value]),
        slider,
      ],
      onClose: () => {
        this.closePopover = null;
        this.changed();
      },
    });
  }
}
