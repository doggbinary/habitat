import {
  DIRECTIONS,
  DIRECTION_LABELS,
  applyTemplate,
  frameIndex,
  framePixels,
  referenceImage,
  referencePlacement,
  type Character,
} from '../character/model';
import type { PixelTool, Studio } from '../character/studio';
import type { CharacterView } from '../character/view';
import type { Store } from '../core/store';
import { openColorPopover } from './color-popover';
import { pickFile, readFileAsDataUrl } from './dialogs';
import { button, clear, el } from './dom';
import { icon, type IconName } from './icons';

const TOOLS: { id: PixelTool; icon: IconName; label: string }[] = [
  { id: 'pencil', icon: 'brush', label: 'Draw' },
  { id: 'eraser', icon: 'eraser', label: 'Erase' },
  { id: 'fill', icon: 'fill', label: 'Fill' },
  { id: 'picker', icon: 'picker', label: 'Pick colour' },
];

/**
 * Everything around the sprite canvas: which character, which pose, what
 * colour, and a live preview of the walk cycle.
 *
 * The layout puts colour and frames nearest the canvas because those are what
 * you touch constantly; sizing and template actions sit at the bottom.
 */
export class CharacterPanel {
  readonly element: HTMLElement;

  private readonly previewCanvas: HTMLCanvasElement;
  private previewHandle = 0;
  private previewTick = 0;
  private previewLast = 0;

  constructor(
    private readonly store: Store,
    private readonly studio: Studio,
    private readonly view: CharacterView,
    private readonly actions: { tryOnMap: () => void; importSheet: () => void },
  ) {
    this.previewCanvas = el('canvas', { class: 'sprite-preview' });
    this.element = el('div', { class: 'character-panel' });
    this.startPreview();
  }

  refresh(): void {
    clear(this.element);
    const character = this.studio.character;

    if (!character) {
      this.element.append(
        el('div', { class: 'panel-empty' }, [
          icon('pencilTip', 34),
          el('p', { text: 'No character yet' }),
          el('p', {
            class: 'muted',
            text: 'Start from a ready-made body you can edit, sized to match your map tiles.',
          }),
          button('btn primary', 'Create a character', () => this.createCharacter(true), [
            el('span', { text: 'Create a character' }),
          ]),
          button('btn subtle', 'Import a sprite sheet', () => this.actions.importSheet(), [
            el('span', { text: 'Import a sprite sheet' }),
          ]),
          button('btn subtle', 'Start from a blank canvas', () => this.createCharacter(false), [
            el('span', { text: 'Start from a blank canvas' }),
          ]),
        ]),
      );
      return;
    }

    this.element.append(
      this.characterPager(character),
      this.toolsSection(),
      this.paletteSection(character),
      this.framesSection(character),
      this.traceSection(character),
      this.previewSection(character),
      this.templateSection(character),
    );
  }

  private createCharacter(withTemplate: boolean): void {
    const size = this.studio.lastSize ?? { tilesW: 2, tilesH: 2 };
    this.studio.addCharacter(this.store.doc.tileSize, size.tilesW, size.tilesH, withTemplate);
    this.view.fit();
    this.refresh();
  }

  // --- Sections ------------------------------------------------------------

  private characterPager(character: Character): HTMLElement {
    const total = this.studio.characters.length;
    const index = this.studio.activeCharacter;

    const name = el('input', { class: 'input', type: 'text', value: character.name });
    name.addEventListener('change', () => {
      character.name = name.value.trim() || character.name;
      this.studio.emit();
    });

    const go = (next: number) => {
      this.studio.activeCharacter = ((next % total) + total) % total;
      this.studio.frame = 0;
      this.studio.clearHistory();
      const picked = this.studio.character;
      if (picked) this.studio.rememberPlayed(picked);
      this.view.fit();
      this.refresh();
    };

    const prev = button('icon-btn', 'Previous character', () => go(index - 1), [icon('chevronLeft', 20)]);
    const next = button('icon-btn', 'Next character', () => go(index + 1), [icon('chevronRight', 20)]);
    prev.disabled = total < 2;
    next.disabled = total < 2;

    return section('Character', [
      el('div', { class: 'palette-pager' }, [prev, name, next]),
      el('div', { class: 'palette-meta' }, [
        el('span', { text: total > 1 ? `${index + 1} of ${total}` : '' }),
        el('span', { class: 'muted', text: `${character.w} x ${character.h} px` }),
      ]),
      el('div', { class: 'layer-actions' }, [
        button('icon-btn', 'New character', () => this.createCharacter(true), [icon('plus', 18)]),
        button('icon-btn', 'Import a sprite sheet', () => this.actions.importSheet(), [icon('upload', 18)]),
        button('icon-btn danger', 'Delete character', () => {
          this.studio.removeCharacter(index);
          this.view.fit();
          this.refresh();
        }, [icon('trash', 18)]),
      ]),
    ]);
  }

  private toolsSection(): HTMLElement {
    const tools = TOOLS.map((tool) => {
      const active = this.studio.tool === tool.id;
      const node = button(`chip${active ? ' active' : ''}`, tool.label, () => {
        this.studio.tool = tool.id;
        // Choosing a tool means drawing, not moving the traced picture.
        this.studio.movingReference = false;
        this.refresh();
      }, [icon(tool.icon, 17), el('span', { class: 'chip-text', text: tool.label })]);
      node.setAttribute('aria-pressed', String(active));
      return node;
    });

    const toggles = [
      this.toggleChip('flipH', 'Symmetry', this.studio.mirrorX, 'Draws the same stroke on both sides', () => {
        this.studio.mirrorX = !this.studio.mirrorX;
        this.view.requestDraw();
        this.refresh();
      }),
      this.toggleChip('layers', 'Onion skin', this.studio.onionSkin, 'Shows the previous frame faintly behind', () => {
        this.studio.onionSkin = !this.studio.onionSkin;
        this.view.requestDraw();
        this.refresh();
      }),
      this.toggleChip('grid', 'Pixel grid', this.studio.showGrid, '', () => {
        this.studio.showGrid = !this.studio.showGrid;
        this.view.requestDraw();
        this.refresh();
      }),
    ];

    return section('Tools', [
      el('div', { class: 'chip-row' }, tools),
      ...(this.studio.tool === 'pencil' || this.studio.tool === 'eraser' ? [this.brushSizeRow()] : []),
      el('div', { class: 'chip-row' }, toggles),
    ]);
  }

  /** Square brush sizes for the pencil and the eraser, each remembered on its own. */
  private brushSizeRow(): HTMLElement {
    const current = this.studio.brushSize;
    const label = this.studio.tool === 'eraser' ? 'Eraser size' : 'Pencil size';
    const step = (by: number) => {
      this.studio.brushSize = current + by;
      this.view.requestDraw();
      this.refresh();
    };
    const smaller = button('icon-btn', `Smaller ${label.toLowerCase()}`, () => step(-1), [icon('minus', 18)]);
    const bigger = button('icon-btn', `Bigger ${label.toLowerCase()}`, () => step(1), [icon('plus', 18)]);
    smaller.disabled = current <= 1;
    bigger.disabled = current >= 16;
    const presets = [1, 2, 4, 8].map((size) =>
      button(`chip${size === current ? ' active' : ''}`, `${size} px`, () => {
        this.studio.brushSize = size;
        this.view.requestDraw();
        this.refresh();
      }, [el('span', { class: 'chip-text', text: `${size}` })]),
    );
    return el('div', { class: 'brush-size-row' }, [
      el('span', { class: 'field-label', text: label }),
      el('div', { class: 'chip-row' }, [smaller, el('span', { class: 'slider-value', text: `${current} px` }), bigger, ...presets]),
    ]);
  }

  private toggleChip(
    name: IconName,
    label: string,
    active: boolean,
    hint: string,
    onPress: () => void,
  ): HTMLElement {
    const node = button(`chip${active ? ' active' : ''}`, hint || label, onPress, [
      icon(name, 17),
      el('span', { class: 'chip-text', text: label }),
    ]);
    node.setAttribute('aria-pressed', String(active));
    return node;
  }

  private paletteSection(character: Character): HTMLElement {
    const swatches = character.palette.map((hex) => {
      const active = this.studio.color.toLowerCase() === hex.toLowerCase();
      const node = el('button', {
        class: `swatch${active ? ' active' : ''}`,
        type: 'button',
        title: hex,
        style: { background: hex },
        on: {
          click: () => {
            this.studio.color = hex;
            // Choosing a colour means you intend to paint with it.
            if (this.studio.tool === 'eraser' || this.studio.tool === 'picker') this.studio.tool = 'pencil';
            this.refresh();
          },
        },
      });
      return node;
    });

    // The current colour doubles as the button that opens the wheel, so the
    // picker stays out of the way until it is wanted.
    const current = el('button', {
      class: 'current-color',
      type: 'button',
      title: 'Open the colour wheel',
      style: { background: this.studio.color },
    });
    current.addEventListener('click', () => {
      openColorPopover({
        anchor: current,
        initial: this.studio.color,
        onChange: (hex) => {
          this.studio.color = hex;
          if (this.studio.tool !== 'pencil') this.studio.tool = 'pencil';
          current.style.background = hex;
        },
        onClose: () => {
          // Mixing a colour you then drew with is worth keeping.
          if (!character.palette.includes(this.studio.color)) character.palette.push(this.studio.color);
          this.refresh();
        },
      });
    });

    return section('Colour', [
      el('div', { class: 'color-row' }, [
        current,
        el('div', { class: 'color-row-text' }, [
          el('span', { text: this.studio.color.toUpperCase() }),
          el('span', { class: 'hint', text: 'Tap to open the wheel' }),
        ]),
      ]),
      el('div', { class: 'swatches' }, swatches),
    ]);
  }

  private framesSection(character: Character): HTMLElement {
    const dirs = DIRECTIONS.map((dir, index) => {
      const active = this.studio.direction === index;
      const node = button(`chip${active ? ' active' : ''}`, DIRECTION_LABELS[dir], () => {
        this.studio.select(index, this.studio.frame);
        this.view.requestDraw();
        this.refresh();
      }, [el('span', { class: 'chip-text', text: dir })]);
      node.setAttribute('aria-pressed', String(active));
      return node;
    });

    const strip = el('div', { class: 'frame-strip' });
    for (let f = 0; f < character.frameCount; f++) {
      const active = this.studio.frame === f;
      const thumb = el('canvas', { class: `frame-thumb${active ? ' active' : ''}` });
      thumb.width = character.w;
      thumb.height = character.h;
      const ctx = thumb.getContext('2d');
      if (ctx) {
        const image = ctx.createImageData(character.w, character.h);
        const frame = character.frames[frameIndex(this.studio.direction, f, character.frameCount)];
        if (frame) image.data.set(framePixels(frame.data, character.w, character.h));
        ctx.putImageData(image, 0, 0);
        const reference = character.reference;
        const picture = reference?.visible ? referenceImage(reference, () => this.refreshOnce()) : null;
        if (reference && picture) {
          // Behind the pixels, so the thumbnail matches the canvas.
          const at = referencePlacement(picture.naturalWidth, picture.naturalHeight, character.w, character.h, reference);
          ctx.globalCompositeOperation = 'destination-over';
          ctx.globalAlpha = reference.opacity;
          ctx.drawImage(picture, at.x, at.y, at.w, at.h);
          ctx.globalAlpha = 1;
          ctx.globalCompositeOperation = 'source-over';
        }
      }
      thumb.addEventListener('click', () => {
        this.studio.select(this.studio.direction, f);
        this.view.requestDraw();
        this.refresh();
      });
      strip.append(el('div', { class: 'frame-cell' }, [thumb, el('span', { text: String(f + 1) })]));
    }

    const dir = DIRECTIONS[this.studio.direction];
    const sideways = dir === 'left' || dir === 'right';

    return section('Pose', [
      el('div', { class: 'chip-row' }, dirs),
      el('p', {
        class: 'hint',
        text: 'Frames 1 and 3 stand still; 2 and 4 are the two steps. Onion skin shows the frame before this one.',
      }),
      strip,
      el('div', { class: 'layer-actions' }, [
        button('btn subtle', 'Copy to all frames', () => {
          this.studio.copyToAllFrames();
          this.refresh();
        }, [el('span', { text: 'Copy to all frames' })]),
        sideways
          ? button('btn subtle', 'Mirror to the other side', () => {
              this.studio.mirrorToOppositeDirection();
              this.refresh();
            }, [el('span', { text: `Mirror to ${dir === 'left' ? 'right' : 'left'}` })])
          : null,
        button('btn subtle', 'Clear this frame', () => {
          this.studio.clearFrame();
          this.view.requestDraw();
          this.refresh();
        }, [el('span', { text: 'Clear frame' })]),
      ]),
    ]);
  }

  private previewSection(character: Character): HTMLElement {
    const speed = el('input', {
      class: 'slider',
      type: 'range',
      min: 60,
      max: 400,
      step: 10,
      value: character.frameMs,
    });
    const readout = el('span', { class: 'slider-value', text: `${character.frameMs}ms` });
    speed.addEventListener('input', () => {
      character.frameMs = Number(speed.value);
      readout.textContent = `${speed.value}ms`;
    });

    return section('Preview', [
      el('div', { class: 'preview-row' }, [this.previewCanvas]),
      el('p', { class: 'hint', text: 'Shown at the size it will appear on your map, and at 3x.' }),
      el('label', { class: 'field' }, [
        el('span', { class: 'field-label', text: 'Step speed' }),
        el('div', { class: 'slider-row' }, [speed, readout]),
      ]),
      button('btn primary full', 'Try it on the map', () => this.actions.tryOnMap(), [
        el('span', { text: 'Try it on the map' }),
      ]),
      el('p', {
        class: 'hint',
        text: 'Drops the character onto your map next to real tiles, so you can see whether it reads at the right size.',
      }),
    ]);
  }

  /** A picture behind the pixels to trace over, like a reference image on the map. */
  private traceSection(character: Character): HTMLElement {
    const reference = character.reference;
    const importPicture = async () => {
      const file = await pickFile('image/*');
      if (!file) return;
      try {
        const src = await readFileAsDataUrl(file);
        character.reference = { src, opacity: reference?.opacity ?? 0.5, visible: true };
        this.studio.emit(true);
        this.view.requestDraw();
        this.refresh();
      } catch {
        this.store.toast('That picture could not be loaded');
      }
    };

    if (!reference) {
      return section('Trace a picture', [
        el('p', {
          class: 'hint',
          text: 'Put a drawing or photo behind the pixels and draw over it. It stays in place on every pose and is not part of the character.',
        }),
        button('btn full', 'Import a picture to trace', () => void importPicture(), [
          icon('image', 16),
          el('span', { text: 'Import a picture' }),
        ]),
      ]);
    }

    const opacity = el('input', {
      class: 'slider',
      type: 'range',
      min: 5,
      max: 100,
      step: 5,
      value: Math.round(reference.opacity * 100),
    });
    const readout = el('span', { class: 'slider-value', text: `${Math.round(reference.opacity * 100)}%` });
    opacity.addEventListener('input', () => {
      reference.opacity = Number(opacity.value) / 100;
      readout.textContent = `${opacity.value}%`;
      this.view.requestDraw();
    });
    opacity.addEventListener('change', () => this.studio.emit());

    // Size against the fitted picture: smaller to trace a detail, bigger to fill the canvas.
    const percent = Math.round((reference.scale ?? 1) * 100);
    const size = el('input', { class: 'slider', type: 'range', min: 20, max: 400, step: 5, value: percent });
    const sizeReadout = el('span', { class: 'slider-value', text: `${percent}%` });
    size.addEventListener('input', () => {
      reference.scale = Number(size.value) / 100;
      sizeReadout.textContent = `${size.value}%`;
      this.view.requestDraw();
    });
    size.addEventListener('change', () => this.studio.emit());

    const moving = this.studio.movingReference;
    return section('Trace a picture', [
      el('label', { class: 'field' }, [
        el('span', { class: 'field-label', text: 'Fade' }),
        el('div', { class: 'slider-row' }, [opacity, readout]),
      ]),
      el('label', { class: 'field' }, [
        el('span', { class: 'field-label', text: 'Size' }),
        el('div', { class: 'slider-row' }, [size, sizeReadout]),
      ]),
      el('div', { class: 'chip-row' }, [
        this.toggleChip('move', moving ? 'Moving picture' : 'Move picture', moving, 'Drag on the canvas to move the picture instead of drawing', () => {
          this.studio.movingReference = !this.studio.movingReference;
          this.refresh();
        }),
        button('chip', 'Put the picture back to its fitted size and place', () => {
          delete reference.scale;
          delete reference.x;
          delete reference.y;
          this.studio.emit();
          this.view.requestDraw();
          this.refresh();
        }, [el('span', { class: 'chip-text', text: 'Reset size' })]),
      ]),
      ...(moving ? [el('p', { class: 'hint', text: 'Drag on the canvas to move the picture. Tap Moving picture again to draw.' })] : []),
      el('div', { class: 'chip-row' }, [
        this.toggleChip(reference.visible ? 'eye' : 'eyeOff', reference.visible ? 'Showing' : 'Hidden', reference.visible, 'Show or hide the picture', () => {
          reference.visible = !reference.visible;
          this.studio.emit();
          this.view.requestDraw();
          this.refresh();
        }),
        button('chip', 'Replace the picture', () => void importPicture(), [
          icon('image', 17),
          el('span', { class: 'chip-text', text: 'Replace' }),
        ]),
        button('chip danger', 'Remove the picture', () => {
          delete character.reference;
          this.studio.movingReference = false;
          this.studio.emit(true);
          this.view.requestDraw();
          this.refresh();
        }, [icon('trash', 17), el('span', { class: 'chip-text', text: 'Remove' })]),
      ]),
    ]);
  }

  private templateSection(character: Character): HTMLElement {
    return section('Start over', [
      el('p', {
        class: 'hint',
        text: 'Change the canvas size from the size shown on the bottom right of the canvas.',
      }),
      button('btn subtle full', 'Start over from the template', () => {
        if (!confirm('Replace every frame of this character with the starter body?')) return;
        applyTemplate(character);
        this.studio.clearHistory();
        this.view.requestDraw();
        this.refresh();
      }, [el('span', { text: 'Start over from the template' })]),
    ]);
  }

  // --- Animated preview ----------------------------------------------------

  private startPreview(): void {
    const step = (now: number) => {
      this.previewHandle = requestAnimationFrame(step);
      const character = this.studio.character;
      if (!character) return;
      if (now - this.previewLast >= character.frameMs) {
        this.previewLast = now;
        this.previewTick = (this.previewTick + 1) % character.frameCount;
      }
      this.drawPreview(character);
    };
    this.previewHandle = requestAnimationFrame(step);
  }

  /** Draws the walk cycle at map scale beside a magnified copy. */
  private drawPreview(character: Character): void {
    const canvas = this.previewCanvas;
    const big = 3;
    const gap = 16;
    const width = character.w + gap + character.w * big;
    const height = Math.max(character.h, character.h * big);

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (canvas.width !== Math.round(width * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.imageSmoothingEnabled = false;

    const frame = character.frames[frameIndex(this.studio.direction, this.previewTick, character.frameCount)];
    if (!frame) return;

    const scratch = document.createElement('canvas');
    scratch.width = character.w;
    scratch.height = character.h;
    const sctx = scratch.getContext('2d');
    if (!sctx) return;
    const image = sctx.createImageData(character.w, character.h);
    image.data.set(framePixels(frame.data, character.w, character.h));
    sctx.putImageData(image, 0, 0);

    ctx.drawImage(scratch, 0, height - character.h, character.w, character.h);
    ctx.drawImage(scratch, character.w + gap, 0, character.w * big, character.h * big);
  }

  private refreshQueued = false;

  /** Several thumbnails wait on the same picture; rebuild once when it arrives. */
  private refreshOnce(): void {
    if (this.refreshQueued) return;
    this.refreshQueued = true;
    requestAnimationFrame(() => {
      this.refreshQueued = false;
      this.refresh();
    });
  }

  destroy(): void {
    if (this.previewHandle) cancelAnimationFrame(this.previewHandle);
  }
}

function section(title: string, children: (Node | null)[]): HTMLElement {
  return el('section', { class: 'panel-section' }, [
    el('h3', { class: 'panel-title', text: title }),
    ...children,
  ]);
}
