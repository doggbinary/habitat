import type { PixelTool, Studio } from '../character/studio';
import { openColorPopover, openPopover } from './color-popover';
import { button, el } from './dom';
import { icon, type IconName } from './icons';

const HOLD_MS = 500;
const MAX_BRUSH = 16;

const TOOLS: { id: PixelTool; icon: IconName; label: string }[] = [
  { id: 'pencil', icon: 'brush', label: 'Draw' },
  { id: 'eraser', icon: 'eraser', label: 'Erase' },
  { id: 'fill', icon: 'fill', label: 'Fill' },
  { id: 'picker', icon: 'picker', label: 'Pick' },
];

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

export interface StudioBarActions {
  /** Redraw the canvas only, for live slider changes. */
  redraw: () => void;
  /** Something changed: redraw the canvas and anything showing the same state. */
  changed: () => void;
  undo: () => void;
  redo: () => void;
  exitFullScreen: () => void;
}

/**
 * Everything you reach for while drawing, down the left edge of the canvas:
 * the four tools, the colour, the palette and the size. In full screen it
 * also carries undo, redo, the frame arrows and the way back out, since
 * nothing else is on screen.
 */
export class StudioBar {
  readonly element: HTMLElement;
  private closePopover: (() => void) | null = null;
  private fullScreen = false;

  constructor(
    private readonly studio: Studio,
    private readonly actions: StudioBarActions,
  ) {
    this.element = el('div', { class: 'studio-bar', aria: { label: 'Drawing tools' } });
  }

  setVisible(visible: boolean, fullScreen = false): void {
    this.element.hidden = !visible;
    this.fullScreen = fullScreen;
    if (!visible) this.closePopover?.();
  }

  refresh(): void {
    const studio = this.studio;
    const tools = TOOLS.map((tool) => {
      const active = studio.tool === tool.id;
      const node = button(`studio-bar-btn${active ? ' active' : ''}`, tool.label, () => {
        studio.tool = tool.id;
        this.actions.changed();
      }, [icon(tool.icon, 22), el('span', { text: tool.label })]);
      node.setAttribute('aria-pressed', String(active));
      return node;
    });

    const swatch = el('span', { class: 'studio-bar-swatch', style: { background: studio.color } });
    const color: HTMLButtonElement = button('studio-bar-btn', 'Colour: open the colour wheel', () => {
      openColorPopover({
        anchor: color,
        initial: studio.color,
        onChange: (hex) => {
          studio.color = hex;
          if (studio.tool !== 'pencil') studio.tool = 'pencil';
          swatch.style.background = hex;
        },
        onClose: () => this.actions.changed(),
      });
    }, [swatch, el('span', { text: 'Colour' })]);

    const palette = button('studio-bar-btn', 'Palette', () => this.openPalette(palette), [
      icon('palette', 22),
      el('span', { text: 'Palette' }),
    ]);

    // Size belongs to whichever of Draw or Erase is chosen.
    const sizedTool: 'pencil' | 'eraser' = studio.tool === 'eraser' ? 'eraser' : 'pencil';
    const size = sizedTool === 'eraser' ? studio.eraserSize : studio.pencilSize;
    const sizeLabel = sizedTool === 'eraser' ? 'Eraser size' : 'Brush size';
    const sizeButton: HTMLButtonElement = button('studio-bar-btn', sizeLabel, () => {
      if (studio.tool !== 'pencil' && studio.tool !== 'eraser') studio.tool = 'pencil';
      this.openSize(sizeButton, sizedTool, sizeLabel);
    }, [el('span', { class: 'studio-bar-size', text: String(size) }), el('span', { text: 'Size' })]);

    const parts: HTMLElement[] = [...tools, el('div', { class: 'studio-bar-divider' }), color, palette, sizeButton];

    if (this.fullScreen) {
      const undo = button('studio-bar-btn', 'Undo', () => this.actions.undo(), [icon('undo', 22), el('span', { text: 'Undo' })]);
      undo.disabled = !studio.canUndo;
      const redo = button('studio-bar-btn', 'Redo', () => this.actions.redo(), [icon('redo', 22), el('span', { text: 'Redo' })]);
      redo.disabled = !studio.canRedo;
      parts.push(el('div', { class: 'studio-bar-divider' }), undo, redo);

      const count = studio.character?.frameCount ?? 0;
      if (count > 1) {
        const step = (by: number) => {
          studio.stepFrame(by);
          this.actions.changed();
        };
        parts.push(
          el('div', { class: 'studio-bar-divider' }),
          el('div', { class: 'studio-bar-frames' }, [
            button('icon-btn', 'Previous frame', () => step(-1), [icon('chevronLeft', 18)]),
            button('icon-btn', 'Next frame', () => step(1), [icon('chevronRight', 18)]),
          ]),
          el('span', { class: 'studio-bar-note', text: `Frame ${studio.frame + 1} of ${count}` }),
        );
      }
      parts.push(
        el('div', { class: 'studio-bar-divider' }),
        button('studio-bar-btn', 'Exit full screen', () => this.actions.exitFullScreen(), [
          icon('shrink', 22),
          el('span', { text: 'Exit' }),
        ]),
      );
    }

    this.element.replaceChildren(...parts);
  }

  private openPalette(anchor: HTMLElement): void {
    const body = el('div', { class: 'studio-palette' });
    const fill = () => {
      body.replaceChildren(
        el('div', { class: 'popover-title', text: 'Palette' }),
        paletteGrid(this.studio, () => {
          this.actions.changed();
          fill();
        }),
        el('p', { class: 'hint', text: 'Tap + to keep your colour. Hold a colour to remove it.' }),
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
      this.actions.redraw();
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
        this.actions.changed();
      },
    });
  }
}
