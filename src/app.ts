import {
  createDoc,
  createImageLayer,
  fitPlacement,
  isImageLayer,
  loadImage,
  makeTileset,
  type Doc,
} from './core/doc';
import { importSpriteSheet } from './character/import';
import { frameIndex } from './character/model';
import { Studio } from './character/studio';
import { CharacterView } from './character/view';
import { EMPTY_STAMP, singleStamp } from './core/stamp';
import { CharacterPanel } from './ui/character-panel';
import { Store } from './core/store';
import { bindKeyboard } from './input/keyboard';
import { PointerInput } from './input/pointer-input';
import {
  openExportDialog,
  openNewMapDialog,
  openSpriteSheetDialog,
  openTilesetDialog,
  pickFile,
  readFileAsDataUrl,
} from './ui/dialogs';
import { deserializeCharacters, deserializeProject, isProjectFile, serializeProject } from './io/project';
import { createAutosave, loadProject } from './io/storage';
import { fitToView, screenToCell } from './render/camera';
import { Renderer, type CharacterPreviewSource } from './render/renderer';
import { Editor } from './tools/edit';
import { el } from './ui/dom';
import { Shell } from './ui/shell';

export class App {
  private readonly store = new Store();
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: Renderer;
  private readonly editor: Editor;
  private readonly input: PointerInput;
  private readonly shell: Shell;
  private readonly autosave: ReturnType<typeof createAutosave>;
  private readonly studio = new Studio();
  private readonly characterView: CharacterView;
  private readonly characterPanel: CharacterPanel;

  constructor(root: HTMLElement) {
    this.canvas = el('canvas', { class: 'map-canvas' });
    this.renderer = new Renderer(this.canvas, this.store);
    this.editor = new Editor(this.store, this.renderer);
    this.input = new PointerInput(this.canvas, this.store, this.editor, this.renderer);

    this.characterView = new CharacterView(this.studio, this.store.settings);
    this.characterPanel = new CharacterPanel(this.store, this.studio, this.characterView, {
      tryOnMap: () => this.tryCharacterOnMap(),
      importSheet: () => this.importSpriteSheet(),
    });

    this.shell = new Shell(root, this.canvas, this.store, this.editor, this.renderer, {
      addTileset: () => this.addTileset(),
      editTileset: (index) => this.editTileset(index),
      removeTileset: (index) => this.confirmRemoveTileset(index),
      addImageLayer: () => void this.addImageLayer(),
      replaceImage: (index) => void this.replaceImage(index),
      newMap: () => this.newMap(),
      openProject: () => void this.openProject(),
      exportMap: () => openExportDialog(this.store, this.studio.characters),
      fitToView: () => this.fit(),
    }, this.studio, this.characterView, this.characterPanel);

    this.autosave = createAutosave(() => serializeProject(this.store.doc, this.studio.characters));

    this.store.on('doc', () => {
      this.renderer.requestDraw();
      this.autosave.schedule();
    });
    this.store.on('structure', () => this.autosave.schedule());
    // Sprite edits live outside the document, so the studio schedules its own.
    this.studio.on(() => this.autosave.schedule());

    bindKeyboard({
      store: this.store,
      renderer: this.renderer,
      input: this.input,
      shell: this.shell,
      fitToView: () => this.fit(),
    });

    this.renderer.setCharacterSource(() => this.characterFrame());
    this.animatePreview();

    this.observeSize();

    // Flush before the tab goes away: `visibilitychange` is the only event
    // iOS Safari reliably delivers when an app is swiped away.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void this.autosave.flush();
    });
    window.addEventListener('pagehide', () => void this.autosave.flush());
  }

  private observeSize(): void {
    const update = () => {
      this.input.refreshRect();
      this.renderer.resize();
      this.characterView.resize();
    };
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(update).observe(this.canvas);
    }
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', () => setTimeout(update, 150));
  }

  async start(): Promise<void> {
    const saved = await loadProject();
    if (saved && isProjectFile(saved)) {
      try {
        const doc = await deserializeProject(saved);
        this.studio.characters = deserializeCharacters(saved);
        this.studio.activeCharacter = 0;
        this.studio.clearHistory();
        this.adoptDoc(doc);
      } catch {
        this.adoptDoc(createDoc());
      }
    } else {
      this.adoptDoc(createDoc());
    }

    this.renderer.resize();
    this.fit();

    // A brand-new project has nothing to paint with, so send the user
    // straight to the import step.
    if (this.store.doc.tilesets.length === 0) this.addTileset();
  }

  /** Installs a document and resets everything derived from the old one. */
  private adoptDoc(doc: Doc): void {
    this.store.doc = doc;
    this.store.history.clear();
    this.store.activeTileset = 0;
    this.store.setStamp(EMPTY_STAMP);
    this.store.hover = null;
    this.store.preview = null;
    this.renderer.invalidateAll();
    this.store.restructured();

    if (doc.tilesets.length > 0) this.selectFirstTile();
  }

  private selectFirstTile(): void {
    const tileset = this.store.doc.tilesets[this.store.activeTileset];
    if (!tileset || tileset.count === 0) return;
    this.store.setStamp(singleStamp(this.store.activeTileset, 0), { x: 0, y: 0, w: 1, h: 1 });
  }

  /** Brings an existing character sheet into the studio as a new character. */
  private importSpriteSheet(): void {
    openSpriteSheetDialog({
      tileSize: this.store.doc.tileSize,
      onConfirm: (image, layout, name) => {
        try {
          const character = importSpriteSheet(image, layout, this.store.doc.tileSize, name);
          this.studio.characters.push(character);
          this.studio.activeCharacter = this.studio.characters.length - 1;
          this.studio.direction = 0;
          this.studio.frame = 0;
          this.studio.clearHistory();
          this.studio.emit();
          this.shell.setMode('character');
          this.characterView.fit();
          this.store.toast(`Imported ${name}`);
        } catch {
          this.store.toast('That sheet could not be imported');
        }
      },
    });
  }

  // --- Character scale preview --------------------------------------------

  private previewTick = 0;
  private previewLast = 0;
  private readonly previewScratch = document.createElement('canvas');

  /** Renders the character's current walk frame into a reusable canvas. */
  private characterFrame(): CharacterPreviewSource | null {
    const character = this.studio.character;
    if (!character) return null;
    const frame = character.frames[frameIndex(this.studio.direction, this.previewTick, character.frameCount)];
    if (!frame) return null;

    const scratch = this.previewScratch;
    if (scratch.width !== character.w || scratch.height !== character.h) {
      scratch.width = character.w;
      scratch.height = character.h;
    }
    const ctx = scratch.getContext('2d');
    if (!ctx) return null;
    const image = ctx.createImageData(character.w, character.h);
    image.data.set(frame.data);
    ctx.putImageData(image, 0, 0);
    return { canvas: scratch, w: character.w, h: character.h };
  }

  /** Steps the preview's walk cycle, but only while it is actually on screen. */
  private animatePreview(): void {
    const step = (now: number) => {
      requestAnimationFrame(step);
      const preview = this.store.characterPreview;
      const character = this.studio.character;
      if (!preview.enabled || !preview.animate || !character) return;
      if (now - this.previewLast < character.frameMs) return;
      this.previewLast = now;
      this.previewTick = (this.previewTick + 1) % character.frameCount;
      this.renderer.requestDraw();
    };
    requestAnimationFrame(step);
  }

  /** Drops the character onto the middle of the current view and shows the map. */
  tryCharacterOnMap(): void {
    if (!this.studio.character) return;
    const centre = screenToCell(
      this.store.camera,
      this.store.doc,
      this.renderer.viewW / 2,
      this.renderer.viewH / 2,
    );
    const preview = this.store.characterPreview;
    preview.tx = Math.max(0, Math.min(this.store.doc.width - 1, centre.x));
    preview.ty = Math.max(0, Math.min(this.store.doc.height - 1, centre.y));
    preview.enabled = true;
    preview.placing = true;
    this.shell.setMode('map');
    this.store.toast('Tap the map to move your character');
    this.renderer.requestDraw();
  }

  private fit(): void {
    fitToView(this.store.camera, this.store.doc, this.renderer.viewW, this.renderer.viewH);
    this.store.emit('view');
    this.renderer.requestDraw();
  }

  // --- Actions -------------------------------------------------------------

  private addTileset(): void {
    openTilesetDialog({
      title: 'Import tileset',
      defaultTileSize: this.store.doc.tileSize,
      onConfirm: async (spec) => {
        try {
          const tileset = await makeTileset(spec.src, spec.name, spec.tileW, spec.tileH, spec.margin, spec.spacing);
          this.editor.addTileset(tileset);
          this.store.activeTileset = this.store.doc.tilesets.length - 1;
          this.selectFirstTile();
          this.shell.openTab('tiles');
          this.store.toast(`${tileset.name} added — ${tileset.count} tiles`);
        } catch {
          this.store.toast('That image could not be imported');
        }
      },
    });
  }

  private editTileset(index: number): void {
    const existing = this.store.doc.tilesets[index];
    if (!existing) return;
    openTilesetDialog({
      title: 'Tileset settings',
      confirmLabel: 'Save changes',
      defaultTileSize: this.store.doc.tileSize,
      initial: existing,
      onConfirm: async (spec) => {
        try {
          const tileset = await makeTileset(spec.src, spec.name, spec.tileW, spec.tileH, spec.margin, spec.spacing);
          this.editor.replaceTileset(index, tileset);
          this.store.toast('Tileset updated');
        } catch {
          this.store.toast('That image could not be read');
        }
      },
    });
  }

  private confirmRemoveTileset(index: number): void {
    const tileset = this.store.doc.tilesets[index];
    if (!tileset) return;
    this.editor.removeTileset(index);
    this.store.activeTileset = Math.max(0, Math.min(this.store.activeTileset, this.store.doc.tilesets.length - 1));
    this.store.setStamp(EMPTY_STAMP);
    this.store.toast(`Removed ${tileset.name}`);
  }

  /**
   * Brings in a picture to trace over. It lands sized to the map so it lines
   * up with the grid straight away, and faded back so tiles painted on top of
   * it stay readable.
   */
  private async addImageLayer(): Promise<void> {
    const file = await pickFile('image/*');
    if (!file) return;
    try {
      const src = await readFileAsDataUrl(file);
      const image = await loadImage(src);
      const name = file.name.replace(/\.[^.]+$/, '') || 'Reference';
      const placement = fitPlacement(this.store.doc, image.naturalWidth, image.naturalHeight);
      this.editor.addImageLayer(createImageLayer(src, image, name, placement));
      this.shell.openTab('layers');
      this.store.toast('Reference image added — drag it to position it');
    } catch {
      this.store.toast('That image could not be loaded');
    }
  }

  /** Swaps the picture on an existing reference layer, keeping its placement. */
  private async replaceImage(index: number): Promise<void> {
    const layer = this.store.doc.layers[index];
    if (!isImageLayer(layer)) return;
    const file = await pickFile('image/*');
    if (!file) return;
    try {
      const src = await readFileAsDataUrl(file);
      const image = await loadImage(src);
      this.editor.structural('Replace reference image', () => {
        layer.src = src;
        layer.image = image;
        layer.naturalW = image.naturalWidth;
        layer.naturalH = image.naturalHeight;
      });
      this.store.toast('Reference image replaced');
    } catch {
      this.store.toast('That image could not be loaded');
    }
  }

  private newMap(): void {
    openNewMapDialog({
      defaults: {
        width: this.store.doc.width,
        height: this.store.doc.height,
        tileSize: this.store.doc.tileSize,
      },
      onConfirm: ({ width, height, tileSize, name }) => {
        const doc = createDoc(width, height, tileSize);
        doc.name = name;
        // Carry the tilesets over: starting a new map almost always means
        // another map in the same game.
        doc.tilesets = this.store.doc.tilesets;
        this.adoptDoc(doc);
        this.fit();
      },
    });
  }

  private async openProject(): Promise<void> {
    const file = await pickFile('application/json,.json');
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!isProjectFile(parsed)) {
        this.store.toast('That is not a Pixel Fusion project file');
        return;
      }
      const doc = await deserializeProject(parsed);
      this.studio.characters = deserializeCharacters(parsed);
      this.studio.activeCharacter = 0;
      this.studio.clearHistory();
      this.adoptDoc(doc);
      this.fit();
      const extra = this.studio.characters.length;
      this.store.toast(
        extra > 0
          ? `Opened ${this.store.doc.name} with ${extra} character${extra === 1 ? '' : 's'}`
          : `Opened ${this.store.doc.name}`,
      );
    } catch {
      this.store.toast('That file could not be opened');
    }
  }
}
