import { MAX_MAP_SIZE, MIN_MAP_SIZE, checkGrid, rescaleGrid } from '../core/doc';
import { lineUpObjects } from '../tools/objects';
import type { Store } from '../core/store';
import type { Editor } from '../tools/edit';
import { button, clear, el } from './dom';

interface MapPanelActions {
  newMap: () => void;
  newMapFromPicture: () => void;
  openProject: () => void;
}

/** Map dimensions plus the display and input preferences. */
export class MapPanel {
  readonly element: HTMLElement;

  constructor(
    private readonly store: Store,
    private readonly editor: Editor,
    private readonly actions: MapPanelActions,
  ) {
    this.element = el('div', { class: 'map-panel' });
  }

  refresh(): void {
    clear(this.element);
    const doc = this.store.doc;

    const name = el('input', { class: 'input', type: 'text', value: doc.name });
    name.addEventListener('change', () => {
      const next = name.value.trim() || 'Untitled map';
      name.value = next;
      this.editor.structural('Rename map', () => {
        doc.name = next;
      });
    });

    const width = this.numberField(doc.width);
    const height = this.numberField(doc.height);
    const apply = button('btn full', 'Resize map', () => {
      const w = clampSize(Number(width.value));
      const h = clampSize(Number(height.value));
      width.value = String(w);
      height.value = String(h);
      this.editor.resizeMap(w, h);
    }, [el('span', { text: 'Resize map' })]);

    const tileSize = this.numberField(doc.tileSize, 1, 256);
    tileSize.addEventListener('change', () => {
      const next = Math.max(1, Math.min(256, Math.round(Number(tileSize.value) || doc.tileSize)));
      tileSize.value = String(next);
      // Objects and pictures scale with the squares, so nothing drifts off the grid.
      this.editor.structural('Change grid size', () => rescaleGrid(doc, next));
      this.refresh();
    });

    const background = el('input', { class: 'color', type: 'color', value: doc.background });
    background.addEventListener('change', () => {
      this.editor.structural('Change background', () => {
        doc.background = background.value;
      });
    });

    this.element.append(
      section('Start a map', [
        button('btn primary full', 'New map from picture', () => this.actions.newMapFromPicture(), [
          el('span', { text: 'New map from picture' }),
        ]),
        el('p', {
          class: 'hint',
          text: 'Pick a drawing of a map. It becomes a locked background 32 squares wide, lined up with the grid, so floors and objects land on its squares.',
        }),
        button('btn subtle full', 'New blank map', () => this.actions.newMap(), [el('span', { text: 'New blank map' })]),
        button('btn subtle full', 'Open project file', () => this.actions.openProject(), [
          el('span', { text: 'Open project file' }),
        ]),
      ]),
      section('Map', [
        field('Name', name),
        el('div', { class: 'grid-2' }, [field('Width', width), field('Height', height)]),
        el('p', { class: 'hint', text: 'Tiles are kept from the top-left corner when you resize.' }),
        apply,
        field('Grid size (px)', tileSize),
        el('p', {
          class: 'hint',
          text: 'Art drawn on this square size shows pixel for pixel; other art is shrunk or stretched. Objects and pictures scale with the grid.',
        }),
        field('Background', background),
        this.switchRow('Dim inactive layers', this.store.settings.highlightActiveLayer, (on) => {
          this.store.settings.highlightActiveLayer = on;
          this.store.emit('doc');
        }),
      ]),
      this.gridCheckSection(),
      section('Pencil and fingers', [
        el('div', { class: 'gesture-help' }, [
          gesture('Apple Pencil', 'Does the tool: paint, erase, box tiles, grab assets'),
          gesture('Tap an object in the library', 'Then tap the map to place it. Each tap adds another'),
          gesture('One finger', 'Pans. Tap an object to select it, then drag it on the grid'),
          gesture('Corner handle', 'Drag it to grow or shrink by whole squares, one asset or a whole selection'),
          gesture('Select box', 'Box several objects, then Group, Ungroup, Duplicate or Delete them together'),
          gesture('Two fingers', 'Pinch to zoom, drag to pan'),
          gesture('Two-finger tap', 'Undo'),
          gesture('Three-finger tap', 'Redo'),
        ]),
      ]),
      section('Credits', [
        el('p', {
          class: 'hint',
          text: 'Starter art: Ninja Adventure by Pixel-Boy and AAA, released under CC0. pixel-boy.itch.io/ninja-adventure-asset-pack',
        }),
      ]),
    );
  }

  /**
   * Why tiles or objects look uneven: art drawn on a different square size
   * than the map is stretched, and objects off the grid sit between squares.
   * Each problem comes with the button that fixes it.
   */
  private gridCheckSection(): HTMLElement {
    const doc = this.store.doc;
    const check = checkGrid(doc);
    const items: HTMLElement[] = [];

    if (check.mismatched.length === 0) {
      items.push(el('p', { class: 'hint', text: `All the art on this map is drawn on ${doc.tileSize} px squares, so it shows pixel for pixel.` }));
    } else {
      const names = check.mismatched.slice(0, 3).map((m) => `${m.name} (${m.tileW} px)`).join(', ');
      const more = check.mismatched.length > 3 ? ` and ${check.mismatched.length - 3} more` : '';
      items.push(
        el('p', {
          class: 'hint',
          text: `This map uses ${doc.tileSize} px squares, but ${names}${more} ${check.mismatched.length === 1 ? 'is' : 'are'} drawn on other sizes, so those tiles are stretched or shrunk and their pixels look uneven.`,
        }),
      );
      if (check.suggested) {
        const size = check.suggested;
        items.push(
          button('btn primary full', `Switch the map to ${size} px squares`, () => {
            this.editor.structural('Change grid size', () => rescaleGrid(doc, size));
            this.store.toast(`The map is on ${size} px squares now. Undo puts it back.`);
            this.refresh();
          }, [el('span', { text: `Switch the map to ${size} px squares` })]),
          el('p', { class: 'hint', text: `Most of this map's art is drawn at ${size} px. Every tile stays in its square; objects scale with the grid.` }),
        );
      }
    }

    if (check.offGrid > 0) {
      items.push(
        el('p', {
          class: 'hint',
          text: `${check.offGrid} object${check.offGrid === 1 ? ' is' : 's are'} not centred in ${check.offGrid === 1 ? 'its' : 'their'} squares.`,
        }),
        button('btn subtle full', 'Line objects up with the grid', () => {
          let moved = 0;
          this.editor.structural('Line up objects', () => {
            moved = lineUpObjects(doc);
          });
          this.store.toast(`Lined up ${moved} object${moved === 1 ? '' : 's'}. Locked ones stay where they are.`);
          this.refresh();
        }, [el('span', { text: 'Line objects up with the grid' })]),
      );
    } else {
      items.push(el('p', { class: 'hint', text: 'Every object sits centred in its squares.' }));
    }

    return section('Check the grid', items);
  }

  private numberField(value: number, min = MIN_MAP_SIZE, max = MAX_MAP_SIZE): HTMLInputElement {
    // `inputMode` matters on iPad: it brings up the number pad instead of the
    // full keyboard, which would otherwise cover half the canvas.
    const input = el('input', { class: 'input', type: 'number', min, max, step: 1, value });
    input.inputMode = 'numeric';
    return input;
  }

  private switchRow(
    label: string,
    value: boolean,
    onChange: (on: boolean) => void,
    hint?: string,
  ): HTMLElement {
    const input = el('input', { type: 'checkbox', checked: value });
    input.addEventListener('change', () => onChange(input.checked));
    return el('label', { class: 'switch-row' }, [
      el('div', { class: 'switch-text' }, [
        el('span', { text: label }),
        hint ? el('span', { class: 'hint', text: hint }) : null,
      ]),
      el('span', { class: 'switch' }, [input, el('span', { class: 'switch-track' })]),
    ]);
  }
}

function clampSize(value: number): number {
  if (!Number.isFinite(value)) return MIN_MAP_SIZE;
  return Math.max(MIN_MAP_SIZE, Math.min(MAX_MAP_SIZE, Math.round(value)));
}

function section(title: string, children: (Node | null)[]): HTMLElement {
  return el('section', { class: 'panel-section' }, [
    el('h3', { class: 'panel-title', text: title }),
    ...children,
  ]);
}

function field(label: string, control: HTMLElement): HTMLElement {
  return el('label', { class: 'field' }, [el('span', { class: 'field-label', text: label }), control]);
}

function gesture(action: string, meaning: string): HTMLElement {
  return el('div', { class: 'gesture-row' }, [
    el('span', { class: 'gesture-action', text: action }),
    el('span', { class: 'gesture-meaning', text: meaning }),
  ]);
}
