import {
  DIRECTIONS,
  DIRECTION_LABELS,
  activeReference,
  applyTemplate,
  frameIndex,
  framePixels,
  referenceImage,
  referencePlacement,
  type Character,
  type CharacterReference,
} from '../character/model';
import { characterThumb } from '../character/sheet';
import type { Studio } from '../character/studio';
import type { CharacterView } from '../character/view';
import type { Store } from '../core/store';
import { freeFolderName, removeFolder, renameFolder } from '../io/library';
import { pickFile, readFileAsDataUrl } from './dialogs';
import { button, clear, el } from './dom';
import { icon } from './icons';
import { confirmAction, openLibrary, promptName } from './library-browser';
import { STUDIO_TABS, recallTab, rememberTab, type StudioTab } from './studio-tabs';

/**
 * Everything around the sprite canvas, in three short tabs: which character
 * and how it walks, its layers and trace pictures, and its poses and frames.
 * Drawing tools and colour are in the sidebar on the canvas.
 */
export class CharacterPanel {
  readonly element: HTMLElement;

  private readonly previewCanvas: HTMLCanvasElement;
  private previewHandle = 0;
  private previewTick = 0;
  private previewLast = 0;
  private tab: StudioTab = recallTab();

  constructor(
    private readonly store: Store,
    private readonly studio: Studio,
    private readonly view: CharacterView,
    private readonly actions: { tryOnMap: () => void; importSheet: () => void },
  ) {
    this.previewCanvas = el('canvas', { class: 'sprite-preview' });
    this.element = el('div', { class: 'character-panel' });
    this.view.onPictureChanged = () => this.refresh();
    this.view.onLockedLayer = () => {
      const name = this.studio.layer?.name ?? 'This layer';
      this.store.toast(`${name} is locked. Unlock it in Layers to draw on it.`);
    };
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

    // Three short pages instead of one long scroll. Drawing tools and colour
    // live in the sidebar on the canvas.
    const tabs = el(
      'div',
      { class: 'dock-tabs studio-tabs', role: 'tablist' },
      STUDIO_TABS.map((tab) => {
        const active = tab.id === this.tab;
        const node = button(`dock-tab${active ? ' active' : ''}`, tab.label, () => {
          this.tab = tab.id;
          rememberTab(tab.id);
          this.refresh();
        }, [el('span', { text: tab.label })]);
        node.setAttribute('role', 'tab');
        node.setAttribute('aria-selected', String(active));
        return node;
      }),
    );
    const pages: Record<StudioTab, () => HTMLElement[]> = {
      character: () => [this.characterPager(character), this.previewSection(character), this.templateSection(character)],
      layers: () => [this.layersSection(character), this.traceSection(character)],
      frames: () => [this.framesSection(character)],
    };
    this.element.append(tabs, ...pages[this.tab]());
  }

  private createCharacter(withTemplate: boolean): void {
    const size = this.studio.lastSize ?? { tilesW: 2, tilesH: 2 };
    this.studio.addCharacter(this.store.doc.tileSize, size.tilesW, size.tilesH, withTemplate);
    this.view.fit();
    this.refresh();
  }

  // --- Sections ------------------------------------------------------------

  /** Opens a character from the library and makes it the one Play walks. */
  private openCharacter(index: number): void {
    if (index < 0 || index >= this.studio.characters.length) return;
    this.studio.activeCharacter = index;
    this.studio.frame = 0;
    this.studio.clearHistory();
    const picked = this.studio.character;
    if (picked) this.studio.rememberPlayed(picked);
    this.studio.emit();
    this.view.fit();
    this.refresh();
  }

  /** Every character, in folders, like the asset library. */
  openLibrary(): void {
    const studio = this.studio;
    const indexOf = (id: string) => studio.characters.findIndex((c) => c.id === id);
    const saved = () => {
      studio.emit(true);
      this.view.fit();
      this.refresh();
    };
    openLibrary({
      title: 'Characters',
      noun: 'character',
      items: () =>
        studio.characters.map((c, i) => ({
          id: c.id,
          name: c.name,
          folder: c.folder,
          note: `${c.tilesW} x ${c.tilesH} tiles`,
          current: i === studio.activeCharacter,
          thumb: () => characterThumb(c),
        })),
      folders: () => studio.folders,
      open: (id) => this.openCharacter(indexOf(id)),
      rename: (id, name) => {
        const c = studio.characters[indexOf(id)];
        if (c) c.name = name;
        saved();
      },
      duplicate: (id) => {
        studio.duplicate(indexOf(id));
        saved();
      },
      move: (id, folder) => {
        const c = studio.characters[indexOf(id)];
        if (!c) return;
        if (folder) c.folder = folder;
        else delete c.folder;
        saved();
      },
      remove: (id) => {
        const index = indexOf(id);
        if (index >= 0) studio.removeCharacter(index);
        saved();
      },
      addFolder: (name) => {
        studio.folders.push(freeFolderName(studio.folders, name));
        saved();
      },
      renameFolder: (from, to) => {
        renameFolder(studio.folders, studio.characters, from, to);
        saved();
      },
      removeFolder: (name) => {
        removeFolder(studio.folders, studio.characters, name);
        saved();
      },
      create: {
        label: 'New character',
        run: (folder) => {
          this.createCharacter(true);
          const made = studio.character;
          if (made && folder) {
            made.folder = folder;
            studio.emit(true);
          }
        },
      },
    });
  }

  private characterPager(character: Character): HTMLElement {
    const total = this.studio.characters.length;
    const index = this.studio.activeCharacter;

    // The name opens the library rather than a text box: on iPad a text box
    // brings up the keyboard over everything.
    const thumb = characterThumb(character);
    const open = button('character-switch', 'Your characters', () => this.openLibrary(), [
      thumb,
      el('span', { class: 'character-switch-text' }, [
        el('span', { text: character.name }),
        el('span', {
          class: 'muted',
          text: `${character.folder ? `${character.folder} · ` : ''}${total === 1 ? '1 character' : `${total} characters`}`,
        }),
      ]),
      icon('chevronDown', 18),
    ]);

    return section('Character', [
      el('div', { class: 'character-header' }, [
        open,
        button('icon-btn', 'Rename this character', () => {
          promptName('Rename character', character.name, (name) => {
            character.name = name;
            this.studio.emit(true);
            this.refresh();
          });
        }, [icon('pencilEdit', 18)]),
      ]),
      el('div', { class: 'layer-actions' }, [
        button('icon-btn', 'New character', () => this.createCharacter(true), [icon('plus', 18)]),
        button('icon-btn', 'Duplicate: start a new character from this one', () => {
          this.studio.duplicate(index);
          this.view.fit();
          this.refresh();
          this.store.toast(`Copied ${character.name}. Draw over the copy.`);
        }, [icon('copy', 18)]),
        button('icon-btn', 'Import a sprite sheet', () => this.actions.importSheet(), [icon('upload', 18)]),
        button('icon-btn danger', 'Delete character', () => {
          confirmAction(`Delete ${character.name}?`, 'This character is gone for good.', 'Delete', () => {
            this.studio.removeCharacter(index);
            this.view.fit();
            this.refresh();
          });
        }, [icon('trash', 18)]),
      ]),
    ]);
  }

  /** Drawing layers, top first as in most drawing apps. Each has every frame of the walk. */
  private layersSection(character: Character): HTMLElement {
    const studio = this.studio;
    const after = () => {
      this.view.requestDraw();
      this.refresh();
    };
    // Every row: show or hide, the name (tap to draw on it), lock. The rarer
    // actions only appear under the layer you are on, so the list stays calm.
    const rows = character.layers
      .map((layer, index) => {
        const active = index === character.activeLayer;
        const pick = button('layer-row-name', `Draw on ${layer.name}`, () => {
          studio.selectLayer(index);
          after();
        }, [el('span', { text: layer.name })]);
        const row = el('div', { class: `layer-row${active ? ' active' : ''}${layer.locked ? ' locked' : ''}` }, [
          button('icon-btn', layer.visible ? 'Hide this layer' : 'Show this layer', () => {
            studio.toggleLayer(index);
            after();
          }, [icon(layer.visible ? 'eye' : 'eyeOff', 18)]),
          pick,
          button(`icon-btn${layer.locked ? ' active' : ''}`, layer.locked ? 'Unlock: draw on this layer again' : 'Lock: keep this layer safe', () => {
            studio.lockLayer(index, !layer.locked);
            after();
          }, [icon(layer.locked ? 'lock' : 'unlock', 18)]),
        ]);
        if (!active) return [row];
        const percent = Math.round((layer.opacity ?? 1) * 100);
        const fade = el('input', { class: 'slider', type: 'range', min: 0, max: 100, step: 5, value: percent });
        const fadeReadout = el('span', { class: 'slider-value', text: `${percent}%` });
        fade.addEventListener('input', () => {
          const value = Number(fade.value);
          if (value >= 100) delete layer.opacity;
          else layer.opacity = value / 100;
          fadeReadout.textContent = `${value}%`;
          this.view.requestDraw();
        });
        fade.addEventListener('change', () => studio.emit(true));
        const opacity = el('label', { class: 'field layer-opacity' }, [
          el('span', { class: 'field-label', text: 'Opacity' }),
          el('div', { class: 'slider-row' }, [fade, fadeReadout]),
        ]);
        const actions = el('div', { class: 'layer-row-actions' }, [
          button('chip', 'Rename this layer', () => {
            promptName('Rename layer', layer.name, (name) => {
              layer.name = name;
              studio.emit(true);
              after();
            });
          }, [icon('pencilEdit', 15), el('span', { class: 'chip-text', text: 'Rename' })]),
          button('chip', 'Move up, in front', () => {
            studio.moveLayer(index, 1);
            after();
          }, [icon('chevronUp', 15), el('span', { class: 'chip-text', text: 'Up' })]),
          button('chip', 'Move down, behind', () => {
            studio.moveLayer(index, -1);
            after();
          }, [icon('chevronDown', 15), el('span', { class: 'chip-text', text: 'Down' })]),
          character.layers.length > 1
            ? button('chip danger', 'Delete this layer', () => {
                confirmAction(`Delete ${layer.name}?`, 'Everything drawn on this layer goes with it.', 'Delete', () => {
                  studio.removeLayer(index);
                  after();
                });
              }, [icon('trash', 15), el('span', { class: 'chip-text', text: 'Delete' })])
            : null,
        ]);
        return [row, opacity, actions];
      })
      .reverse()
      .flat();

    return section('Layers', [
      el('p', { class: 'hint', text: 'Tap a layer to draw on it. Lock it to keep it safe.' }),
      el('div', { class: 'layer-list' }, rows),
      button('btn subtle full', 'Add a layer above this one', () => {
        studio.addLayer();
        after();
      }, [icon('plus', 16), el('span', { text: 'Add layer' })]),
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
        // Behind the pixels, top picture first, so the thumbnail matches the canvas.
        ctx.globalCompositeOperation = 'destination-over';
        for (const reference of [...character.references].reverse()) {
          const picture = reference.visible ? referenceImage(reference, () => this.refreshOnce()) : null;
          if (!picture) continue;
          const at = referencePlacement(picture.naturalWidth, picture.naturalHeight, character.w, character.h, reference);
          ctx.globalAlpha = reference.opacity;
          ctx.drawImage(picture, at.x, at.y, at.w, at.h);
        }
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
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
        text: 'Frames 1 and 3 stand; 2 and 4 are steps.',
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
      el('p', { class: 'hint', text: 'Map size, and 3x bigger.' }),
      el('label', { class: 'field' }, [
        el('span', { class: 'field-label', text: 'Step speed' }),
        el('div', { class: 'slider-row' }, [speed, readout]),
      ]),
      button('btn primary full', 'Try it on the map', () => this.actions.tryOnMap(), [
        el('span', { text: 'Try it on the map' }),
      ]),
    ]);
  }

  /** A picture behind the pixels to trace over, like a reference image on the map. */
  private traceSection(character: Character): HTMLElement {
    const reference = activeReference(character);
    /** A new picture on top, or a new file in place of the chosen one. */
    const importPicture = async (replace: boolean) => {
      const file = await pickFile('image/*');
      if (!file) return;
      try {
        const src = await readFileAsDataUrl(file);
        if (replace && reference) {
          reference.src = src;
          delete reference.image;
        } else {
          character.references.push({ src, opacity: reference?.opacity ?? 0.5, visible: true });
          character.activeReference = character.references.length - 1;
        }
        this.studio.emit(true);
        this.view.requestDraw();
        this.refresh();
      } catch {
        this.store.toast('That picture could not be loaded');
      }
    };

    const addButton = button('btn subtle full', 'Add a picture to trace over', () => void importPicture(false), [
      icon('image', 16),
      el('span', { text: 'Add a picture' }),
    ]);

    if (!reference) {
      return section('Pictures behind', [
        el('p', { class: 'hint', text: 'Add a drawing or photo to trace over. It is never part of your character.' }),
        addButton,
      ]);
    }

    const after = () => {
      this.studio.emit(true);
      this.view.requestDraw();
      this.refresh();
    };
    // Top picture first, like the layers above. Every row: thumbnail, show or
    // hide, lock. The chosen one opens its controls underneath.
    const rows = character.references
      .map((picture, index) => {
        const active = index === character.activeReference;
        const thumb = el('span', { class: 'picture-thumb' });
        thumb.style.backgroundImage = `url("${picture.src}")`;
        const row = el('div', { class: `layer-row picture-row${active ? ' active' : ''}` }, [
          button('icon-btn', picture.visible ? 'Hide this picture' : 'Show this picture', () => {
            picture.visible = !picture.visible;
            after();
          }, [icon(picture.visible ? 'eye' : 'eyeOff', 18)]),
          button('layer-row-name', `Picture ${index + 1}: tap to adjust it`, () => {
            character.activeReference = index;
            after();
          }, [thumb, el('span', { text: `Picture ${index + 1}` })]),
          button(
            `icon-btn${picture.locked ? ' active' : ''}`,
            picture.locked ? 'Unlock: move and size it with a finger' : 'Lock: keep it still so a finger draws',
            () => {
              picture.locked = !picture.locked;
              character.activeReference = index;
              after();
            },
            [icon(picture.locked ? 'lock' : 'unlock', 18)],
          ),
        ]);
        return active ? [row, this.pictureControls(character, picture, () => void importPicture(true))] : [row];
      })
      .reverse()
      .flat();

    return section('Pictures behind', [
      el('p', { class: 'hint', text: 'Unlocked pictures move with a finger. Lock one to draw over it.' }),
      el('div', { class: 'layer-list' }, rows),
      addButton,
    ]);
  }

  /** Fade, size and the rest, for the picture chosen in the list. */
  private pictureControls(character: Character, reference: CharacterReference, replace: () => void): HTMLElement {
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

    return el('div', { class: 'picture-controls' }, [
      el('label', { class: 'field' }, [
        el('span', { class: 'field-label', text: 'Fade' }),
        el('div', { class: 'slider-row' }, [opacity, readout]),
      ]),
      el('label', { class: 'field' }, [
        el('span', { class: 'field-label', text: 'Size' }),
        el('div', { class: 'slider-row' }, [size, sizeReadout]),
      ]),
      el('div', { class: 'chip-row' }, [
        button('chip', 'Put the picture back to its fitted size and place', () => {
          delete reference.scale;
          delete reference.x;
          delete reference.y;
          this.studio.emit();
          this.view.requestDraw();
          this.refresh();
        }, [el('span', { class: 'chip-text', text: 'Reset size' })]),
        button('chip', 'Replace the picture', replace, [
          icon('image', 17),
          el('span', { class: 'chip-text', text: 'Replace' }),
        ]),
        button('chip danger', 'Remove the picture', () => {
          character.references.splice(character.references.indexOf(reference), 1);
          character.activeReference = Math.max(0, Math.min(character.activeReference, character.references.length - 1));
          this.studio.emit(true);
          this.view.requestDraw();
          this.refresh();
        }, [icon('trash', 17), el('span', { class: 'chip-text', text: 'Remove' })]),
      ]),
    ]);
  }

  private templateSection(character: Character): HTMLElement {
    return section('Start over', [
      el('p', { class: 'hint', text: 'Change the canvas size with the size button under the canvas.' }),
      button('btn subtle full', 'Start over from the template', () => {
        confirmAction('Start over?', 'This layer goes back to the starter body on every frame.', 'Start over', () => {
          applyTemplate(character);
          this.studio.clearHistory();
          this.studio.emit(true);
          this.view.requestDraw();
          this.refresh();
        });
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
