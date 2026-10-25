import {
  fitPlacement,
  isImageLayer,
  isObjectLayer,
  type ImageLayer,
  type Layer,
  type ObjectLayer,
  type TileLayer,
} from '../core/doc';
import type { Store } from '../core/store';
import type { Editor } from '../tools/edit';
import { snapPlacement } from '../tools/image-transform';
import { button, clear, el } from './dom';
import { icon } from './icons';

export interface LayersActions {
  addImageLayer: () => void;
  replaceImage: (index: number) => void;
}

/**
 * Layer stack, listed top-first so the order on screen matches the order on
 * the map. Visibility and lock are one tap away because they are what you
 * reach for constantly while drawing; everything rarer lives in the footer,
 * which changes to suit whichever kind of layer is selected.
 */
export class LayersPanel {
  readonly element: HTMLElement;
  private readonly list: HTMLElement;
  private readonly footer: HTMLElement;

  constructor(
    private readonly store: Store,
    private readonly editor: Editor,
    private readonly actions: LayersActions,
  ) {
    this.list = el('div', { class: 'layer-list' });
    this.footer = el('div', { class: 'layer-footer' });
    this.element = el('div', { class: 'layers' }, [this.list, this.footer]);
  }

  refresh(): void {
    this.buildList();
    this.buildFooter();
  }

  private buildList(): void {
    clear(this.list);
    const doc = this.store.doc;

    for (let index = doc.layers.length - 1; index >= 0; index--) {
      const layer = doc.layers[index];
      const active = index === doc.activeLayer;

      const name = el('input', { class: 'layer-name', type: 'text', value: layer.name });
      name.addEventListener('change', () => {
        const next = name.value.trim();
        if (!next) {
          name.value = layer.name;
          return;
        }
        this.editor.structural('Rename layer', () => {
          layer.name = next;
        });
      });
      // Tapping the field selects the layer too, so you never have to aim twice.
      name.addEventListener('focus', () => this.select(index));

      const row = el(
        'div',
        {
          class: `layer-row${active ? ' active' : ''}${layer.visible ? '' : ' hidden-layer'}`,
          on: { pointerdown: () => this.select(index) },
        },
        [
          button(
            `icon-btn flat${layer.visible ? '' : ' muted-btn'}`,
            layer.visible ? 'Hide layer' : 'Show layer',
            () => {
              this.editor.structural('Toggle visibility', () => {
                layer.visible = !layer.visible;
              });
            },
            [icon(layer.visible ? 'eye' : 'eyeOff', 18)],
          ),
          // A small badge marks reference images so the stack reads at a glance.
          isImageLayer(layer)
            ? el('span', { class: 'layer-badge', title: 'Reference image' }, [icon('image', 15)])
            : isObjectLayer(layer)
              ? el('span', { class: 'layer-badge objects', title: 'Placed objects' }, [icon('select', 15)])
              : null,
          name,
          button(
            `icon-btn flat${layer.locked ? ' active' : ''}`,
            layer.locked ? 'Unlock layer' : 'Lock layer',
            () => {
              this.editor.structural('Toggle lock', () => {
                layer.locked = !layer.locked;
              });
            },
            [icon(layer.locked ? 'lock' : 'unlock', 18)],
          ),
        ],
      );

      this.list.append(row);
    }
  }

  private select(index: number): void {
    if (this.store.doc.activeLayer === index) return;
    this.store.doc.activeLayer = index;
    this.store.restructured();
  }

  private buildFooter(): void {
    clear(this.footer);
    const doc = this.store.doc;
    const index = doc.activeLayer;
    const layer = doc.layers[index];

    this.footer.append(
      button('btn full', 'Add an object layer for props', () => this.editor.addObjectLayer(), [
        icon('plus', 16),
        el('span', { text: 'Object layer' }),
      ]),
    );
    this.footer.append(
      el('div', { class: 'layer-actions' }, [
        button('icon-btn', 'Add tile layer', () => this.editor.addLayer(), [icon('plus', 18)]),
        button('icon-btn', 'Add reference image', () => this.actions.addImageLayer(), [icon('image', 18)]),
        button('icon-btn', 'Duplicate layer', () => this.editor.duplicateLayer(index), [icon('copy', 18)]),
        button('icon-btn', 'Move layer up', () => this.editor.moveLayer(index, 1), [icon('chevronUp', 18)]),
        button('icon-btn', 'Move layer down', () => this.editor.moveLayer(index, -1), [icon('chevronDown', 18)]),
        button('icon-btn danger', 'Delete layer', () => this.editor.removeLayer(index), [icon('trash', 18)]),
      ]),
    );

    if (!layer) return;
    this.footer.append(this.opacityField(layer));

    if (isImageLayer(layer)) this.buildImageControls(layer, index);
    else if (isObjectLayer(layer)) this.buildObjectControls(layer);
    else this.buildTileControls(layer, index);
  }

  /** Object layers hold placed props; editing happens on the map itself. */
  private buildObjectControls(layer: ObjectLayer): void {
    const count = layer.objects.length;
    this.footer.append(
      el('p', {
        class: 'hint',
        text:
          count === 0
            ? 'No objects yet. Drag a prop from the Tiles panel onto the map to place one here.'
            : `${count} object${count === 1 ? '' : 's'}. Tap one on the map to move, resize, turn or recolour it. Later objects sit in front.`,
      }),
    );
  }

  /** Opacity is the one control every layer kind shares. */
  private opacityField(layer: Layer): HTMLElement {
    const slider = el('input', {
      class: 'slider',
      type: 'range',
      min: 0,
      max: 100,
      step: 1,
      value: Math.round(layer.opacity * 100),
    });
    const readout = el('span', { class: 'slider-value', text: `${Math.round(layer.opacity * 100)}%` });

    // Dragging fires continuously, so repaint live but record one undo step
    // when the user lets go.
    slider.addEventListener('input', () => {
      layer.opacity = Number(slider.value) / 100;
      readout.textContent = `${slider.value}%`;
      this.store.emit('doc');
    });
    slider.addEventListener('change', () => {
      this.editor.structural('Layer opacity', () => {
        layer.opacity = Number(slider.value) / 100;
      });
    });

    return el('label', { class: 'field' }, [
      el('span', { class: 'field-label', text: 'Opacity' }),
      el('div', { class: 'slider-row' }, [slider, readout]),
    ]);
  }

  private buildTileControls(layer: TileLayer, index: number): void {
    const collider = el('input', { type: 'checkbox', id: 'layer-collider', checked: layer.collider });
    collider.addEventListener('change', () => {
      this.editor.structural('Toggle collider', () => {
        layer.collider = collider.checked;
      });
    });

    this.footer.append(
      el('label', { class: 'checkbox', for: 'layer-collider' }, [
        collider,
        el('span', { text: 'Collision layer' }),
        el('span', { class: 'hint', text: 'Marked as a collider in the exported map data' }),
      ]),
      button('btn subtle full', 'Merge into layer below', () => this.editor.mergeDown(index), [
        el('span', { text: 'Merge into layer below' }),
      ]),
      button('btn subtle full', 'Clear this layer', () => this.editor.clearLayer(index), [
        el('span', { text: 'Clear this layer' }),
      ]),
    );
  }

  private buildImageControls(layer: ImageLayer, index: number): void {
    const doc = this.store.doc;

    const fields = {
      x: this.placementField(layer, 'x'),
      y: this.placementField(layer, 'y'),
      w: this.placementField(layer, 'w'),
      h: this.placementField(layer, 'h'),
    };

    const apply = (next: { x: number; y: number; w: number; h: number }, label: string) => {
      this.editor.setImagePlacement(layer, next, label);
      this.refresh();
    };

    const snap = el('input', { type: 'checkbox', id: 'image-snap', checked: this.store.settings.snapImageToGrid });
    snap.addEventListener('change', () => {
      this.store.settings.snapImageToGrid = snap.checked;
      this.store.emit('ui');
    });

    this.footer.append(
      el('p', {
        class: 'hint',
        text: layer.locked
          ? 'This image is locked. Unlock it above to move or resize it.'
          : 'Drag anywhere on the map with your Pencil to move it, or drag the round handle at its corner to resize.',
      }),
      el('div', { class: 'grid-2' }, [
        labelled('X', fields.x),
        labelled('Y', fields.y),
        labelled('Width', fields.w),
        labelled('Height', fields.h),
      ]),
      el('p', { class: 'hint', text: `Measured in map pixels. One tile is ${doc.tileSize} px.` }),
      el('label', { class: 'checkbox', for: 'image-snap' }, [
        snap,
        el('span', { text: 'Snap to the tile grid' }),
      ]),
      el('div', { class: 'layer-actions' }, [
        button('btn subtle', 'Fit to map', () => {
          apply(fitPlacement(doc, layer.naturalW, layer.naturalH), 'Fit image to map');
        }, [el('span', { text: 'Fit to map' })]),
        button('btn subtle', 'Actual size', () => {
          // Back to one image pixel per map pixel, keeping the top-left corner.
          apply({ x: layer.x, y: layer.y, w: layer.naturalW, h: layer.naturalH }, 'Reset image size');
        }, [el('span', { text: 'Actual size' })]),
        button('btn subtle', 'Snap now', () => {
          apply(snapPlacement(doc, layer, true), 'Snap image to grid');
        }, [el('span', { text: 'Snap now' })]),
      ]),
      button('btn subtle full', 'Replace image', () => this.actions.replaceImage(index), [
        el('span', { text: 'Replace image' }),
      ]),
    );
  }

  /** One numeric placement input, committed on change as a single undo step. */
  private placementField(layer: ImageLayer, key: 'x' | 'y' | 'w' | 'h'): HTMLInputElement {
    const input = el('input', { class: 'input', type: 'number', step: 1, value: Math.round(layer[key]) });
    input.inputMode = 'numeric';
    input.addEventListener('change', () => {
      const value = Number(input.value);
      if (!Number.isFinite(value)) {
        input.value = String(Math.round(layer[key]));
        return;
      }
      const next = { x: layer.x, y: layer.y, w: layer.w, h: layer.h };
      // Width and height must stay positive or the image inverts.
      next[key] = key === 'w' || key === 'h' ? Math.max(1, value) : value;
      this.editor.setImagePlacement(layer, next, 'Place reference image');
      this.refresh();
    });
    return input;
  }
}

function labelled(label: string, control: HTMLElement): HTMLElement {
  return el('label', { class: 'field' }, [el('span', { class: 'field-label', text: label }), control]);
}
