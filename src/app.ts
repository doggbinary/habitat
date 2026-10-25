import {
  createDoc,
  createImageLayer,
  fitPlacement,
  isImageLayer,
  loadImage,
  makeTileset,
  uid,
  type AssetRect,
  type Doc,
  type Tileset,
} from './core/doc';
import { sameAsset, type AssetRef } from './ui/packs';
import { DETECT_VERSION, assetIsGround, assetsOf, deleteAssets, detectSheetSplit, mergeAssets, tileIndexOf } from './core/assets';
import { PATH_STRIDE, expandPathSheet, isRawPathSheet } from './core/autotile';
import { applyTilesetMerge, pathMergePlan } from './core/path-merge';
import { isSampleMap, type LibraryEntry } from './library';
import { dominantColor, recolorToCanvas } from './io/recolor';
import { ensureGeneratedSheet, extractTile, persistGeneratedSheet, writeGeneratedTile } from './core/custom-tiles';
import { cropAsset } from './render/object-draw';
import { ObjectTools } from './tools/objects';
import { openColorPopover } from './ui/color-popover';
import { hexToHsv, hsvToHex } from './ui/color-wheel';
import { importSpriteSheet } from './character/import';
import { frameIndex } from './character/model';
import { Studio } from './character/studio';
import { CharacterView } from './character/view';
import { EMPTY_STAMP, singleStamp } from './core/stamp';
import { EMPTY, flagsOf, indexOf, pack, tilesetOf, withFlags, type PackedTile } from './core/tiles';
import { openAssetMenu } from './ui/asset-menu';
import { CharacterPanel } from './ui/character-panel';
import { Store } from './core/store';
import { bindKeyboard } from './input/keyboard';
import { PointerInput } from './input/pointer-input';
import { PlayMode } from './play/play-mode';
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
import { fitToView, screenToCell, screenToWorld } from './render/camera';
import { Renderer, type CharacterPreviewSource } from './render/renderer';
import { Editor } from './tools/edit';
import { el } from './ui/dom';
import { Shell } from './ui/shell';

/**
 * True when a sheet's assets need finding: never found, or found by an older
 * detector. Hand-edited sheets are never redone over the user's changes.
 */
function needsDetection(sheet: Tileset): boolean {
  if (sheet.generated || !sheet.image) return false;
  if (!sheet.assets) return true;
  return !sheet.assetsEdited && (sheet.assetsVersion ?? 0) < DETECT_VERSION;
}

/** Finds a sheet's assets and stamps them with the detector that found them. */
function detectInto(sheet: Tileset): void {
  if (sheet.image && isRawPathSheet(sheet.name, sheet.imgW, sheet.imgH, sheet.tileW)) {
    expandPaths(sheet);
    return;
  }
  const split = detectSheetSplit(sheet);
  sheet.assets = split.assets;
  sheet.groundAssets = split.ground;
  sheet.assetsVersion = DETECT_VERSION;
  sheet.splitMode = 'objects';
}

/** Rebuilds a ground page into pieces whose edges meet. */
function expandPaths(sheet: Tileset): void {
  const image = sheet.image;
  if (!image) return;
  const canvas = document.createElement('canvas');
  canvas.width = sheet.imgW;
  canvas.height = sheet.imgH;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return;
  ctx.drawImage(image, 0, 0);
  const src = ctx.getImageData(0, 0, sheet.imgW, sheet.imgH).data;
  const expanded = expandPathSheet(src, sheet.imgW, sheet.imgH, sheet.tileW);
  const next = document.createElement('canvas');
  next.width = expanded.width;
  next.height = expanded.height;
  const out = next.getContext('2d');
  if (!out) return;
  const pixels = new Uint8ClampedArray(expanded.width * expanded.height * 4);
  pixels.set(expanded.rgba);
  out.putImageData(new ImageData(pixels, expanded.width, expanded.height), 0, 0);
  sheet.image = next;
  sheet.imgW = expanded.width;
  sheet.imgH = expanded.height;
  sheet.cols = expanded.cols;
  sheet.rows = expanded.rows;
  sheet.count = expanded.cols * expanded.rows;
  sheet.margin = 0;
  sheet.spacing = 0;
  sheet.assets = expanded.assets;
  sheet.pathStride = PATH_STRIDE;
  sheet.assetsVersion = DETECT_VERSION;
  sheet.splitMode = 'objects';
}

/** A small grayscale copy, so two sheets of the same floors compare as the same picture. */
function thumbnail(image: CanvasImageSource, w: number, h: number): Uint8Array | null {
  const tw = 32;
  const th = 24;
  const canvas = document.createElement('canvas');
  canvas.width = tw;
  canvas.height = th;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx || w === 0 || h === 0) return null;
  ctx.drawImage(image, 0, 0, w, h, 0, 0, tw, th);
  const data = ctx.getImageData(0, 0, tw, th).data;
  const gray = new Uint8Array(tw * th);
  for (let i = 0; i < gray.length; i++) gray[i] = (data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2]) / 3;
  return gray;
}

/** Takes every repeated ground page out of a project, keeping one of each picture. */
function collapseDuplicatePaths(doc: Doc): void {
  const sheets = doc.tilesets.map((sheet) => ({
    id: sheet.id,
    name: sheet.name,
    src: sheet.src,
    thumb: sheet.image ? thumbnail(sheet.image, sheet.imgW, sheet.imgH) : null,
  }));
  applyTilesetMerge(doc, pathMergePlan(sheets));
}

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
  private readonly objects: ObjectTools;

  constructor(root: HTMLElement) {
    this.canvas = el('canvas', { class: 'map-canvas' });
    this.renderer = new Renderer(this.canvas, this.store);
    this.editor = new Editor(this.store, this.renderer);
    this.objects = new ObjectTools(this.store, this.renderer);
    this.input = new PointerInput(this.canvas, this.store, this.editor, this.renderer, this.objects);

    this.characterView = new CharacterView(this.studio, this.store.settings);
    this.characterPanel = new CharacterPanel(this.store, this.studio, this.characterView, {
      tryOnMap: () => this.tryCharacterOnMap(),
      importSheet: () => this.importSpriteSheet(),
    });

    this.shell = new Shell(root, this.canvas, this.store, this.editor, this.renderer, {
      addTileset: () => this.addTileset(),
      editTileset: (index) => this.editTileset(index),
      removeTileset: (index) => this.confirmRemoveTileset(index),
      tapAsset: (sheet, asset) => this.tapAsset(sheet, asset),
      dragStart: (tilesetId, rect) => this.dragStart(tilesetId, rect),
      dragMove: (x, y) => this.dragMove(x, y),
      dragEnd: (x, y, dropped) => this.dragEnd(x, y, dropped),
      editAssets: (sheet, op, indices) => this.editAssets(sheet, op, indices),
      setPinned: (refs, pinned) => this.setPinned(refs, pinned),
      fileAssets: (folderId, name, refs) => this.fileAssets(folderId, name, refs),
      removeFolder: (folderId) => this.removeFolder(folderId),
      recolorObject: (anchor) => this.recolorObject(anchor),
      recolorHeldTiles: (anchor) => this.recolorHeldTiles(anchor),
      addImageLayer: () => void this.addImageLayer(),
      replaceImage: (index) => void this.replaceImage(index),
      newMap: () => this.newMap(),
      openProject: () => void this.openProject(),
      exportMap: () => {
        this.editor.commitSelection();
        openExportDialog(this.store, this.studio.characters);
      },
      fitToView: () => this.fit(),
      playTest: () => this.startPlayTest(),
    }, this.studio, this.characterView, this.characterPanel, this.objects);

    // Tiles held up with the select tool are saved where they float, so
    // closing the app mid-move never loses them.
    this.autosave = createAutosave(() => serializeProject(this.editor.settledDoc(), this.studio.characters));

    // Held tiles belong to the select tool; picking up any other tool sets them down.
    this.store.on('ui', () => {
      const tool = this.store.tool;
      if (this.store.selection && tool !== 'select' && tool !== 'pan') this.editor.commitSelection();
    });

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

    this.input.onDoubleTap = (cell, x, y) => this.openAssetMenuAt(cell, x, y);
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
    // `?map=name` opens a map published with the site, so one link is enough
    // to hand someone a finished map on a tablet.
    const wanted = new URLSearchParams(location.search).get('map');
    if (wanted && (await this.openPublishedMap(wanted))) return;

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

    const added = await this.loadObjectLibrary();
    // Packs repeat ground pages, so a freshly loaded library is merged down
    // before it is ever shown.
    if (added > 0) {
      collapseDuplicatePaths(this.store.doc);
      this.store.restructured();
    }
    // A brand-new project has nothing to paint with, so send the user
    // straight to the import step.
    if (this.store.doc.tilesets.length === 0) this.addTileset();
    else if (added > 0) this.shell.openTab('tiles');
  }

  /**
   * Opens a map published alongside the site. The name is used as a file
   * name, so anything with a slash or a dot in it is refused rather than
   * being allowed to reach for another part of the server.
   */
  private async openPublishedMap(name: string): Promise<boolean> {
    if (!/^[a-z0-9-]+$/i.test(name)) return false;
    try {
      const response = await fetch(new URL(`maps/${name}.pfproj`, document.baseURI));
      if (!response.ok) return false;
      const data = (await response.json()) as unknown;
      if (!isProjectFile(data)) return false;
      const doc = await deserializeProject(data);
      this.studio.characters = deserializeCharacters(data);
      this.studio.activeCharacter = 0;
      this.studio.clearHistory();
      this.adoptDoc(doc);
      this.renderer.resize();
      this.fit();
      this.store.toast(`Opened ${doc.name}`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Pulls in the object pages served from this computer: houses, lamps,
   * furniture. Ground grids and finished scene pictures are left out. Pages
   * already in the project are not added again.
   */
  private async loadObjectLibrary(): Promise<number> {
    let entries: LibraryEntry[];
    try {
      const response = await fetch(new URL('library/manifest.json', document.baseURI));
      if (!response.ok) return 0;
      entries = (await response.json()) as LibraryEntry[];
    } catch {
      return 0;
    }
    if (!Array.isArray(entries) || entries.length === 0) return 0;

    const skipKey = `pf-library-skip-${DETECT_VERSION}`;
    let skipped = new Set<string>();
    try {
      const stored = JSON.parse(localStorage.getItem(skipKey) ?? '[]') as unknown;
      if (Array.isArray(stored)) skipped = new Set(stored.filter((name) => typeof name === 'string'));
    } catch {
      /* a blocked localStorage just means scene pages are checked again */
    }

    const have = new Set(this.store.doc.tilesets.map((sheet) => sheet.name));
    const fresh: Tileset[] = [];
    for (const entry of entries) {
      if (have.has(entry.name) || skipped.has(entry.name)) continue;
      this.store.toast(`Loading ${entry.name}`);
      await new Promise((resolve) => setTimeout(resolve, 0));
      try {
        const tileset = await makeTileset(new URL(entry.url, document.baseURI).href, entry.name, 48, 48);
        detectInto(tileset);
        if (isSampleMap(tileset.imgW, tileset.imgH, tileset.assets ?? [])) {
          skipped.add(entry.name);
          continue;
        }
        fresh.push(tileset);
        have.add(entry.name);
      } catch {
        /* one unreadable page should not drop the rest */
      }
    }
    try {
      localStorage.setItem(skipKey, JSON.stringify([...skipped]));
    } catch {
      /* the pages still loaded for this visit */
    }
    if (fresh.length === 0) return 0;

    const empty = this.store.doc.tilesets.length === 0;
    const paths = fresh.filter((sheet) => /^paths \d+$/i.test(sheet.name));
    const others = fresh.filter((sheet) => !/^paths \d+$/i.test(sheet.name));
    this.editor.structural('Add asset library', () => {
      // Path pages sit at the front of the list. Shift the selection with
      // them so the page someone was already on stays open.
      this.store.doc.tilesets.unshift(...paths);
      this.store.activeTileset += paths.length;
      this.store.doc.tilesets.push(...others);
    });
    if (empty) {
      const firstPaths = this.store.doc.tilesets.findIndex((sheet) => sheet.name === 'Paths 1');
      this.store.activeTileset = firstPaths >= 0 ? firstPaths : 0;
      this.selectFirstTile();
    }
    this.store.toast(`${fresh.length} asset ${fresh.length === 1 ? 'page' : 'pages'} ready`);
    return fresh.length;
  }

  /** Installs a document and resets everything derived from the old one. */
  private adoptDoc(doc: Doc): void {
    // Every sheet is a list of whole assets now, including sheets saved when
    // there was a separate ground view, or by an older detector. Placed
    // assets keep the rectangle they were placed with, so the map is unchanged.
    collapseDuplicatePaths(doc);
    for (const sheet of doc.tilesets) {
      // Path pages are expanded every load: the saved file keeps the original
      // ground picture, and the pieces are built from it.
      if (sheet.image && isRawPathSheet(sheet.name, sheet.imgW, sheet.imgH, sheet.tileW)) expandPaths(sheet);
      else if (needsDetection(sheet)) detectInto(sheet);
    }

    this.store.doc = doc;
    this.store.history.clear();
    this.store.activeTileset = 0;
    this.store.setStamp(EMPTY_STAMP);
    this.store.hover = null;
    this.store.preview = null;
    // Anything held belonged to the previous map.
    this.store.selection = null;
    this.renderer.invalidateAll();
    this.store.restructured();

    if (doc.tilesets.length > 0) this.selectFirstTile();
  }

  /** Starts the brush on the sheet's first floor square, if it has any. */
  private selectFirstTile(): void {
    const tileset = this.store.doc.tilesets[this.store.activeTileset];
    if (!tileset) return;
    for (const rect of assetsOf(tileset)) {
      const tile = tileIndexOf(tileset, rect);
      if (tile === -1) continue;
      this.store.setStamp(singleStamp(this.store.activeTileset, tile));
      return;
    }
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

  /**
   * Full-screen play test. Starts the character wherever the scale preview is
   * standing, so what you were looking at is where you begin.
   */
  startPlayTest(): void {
    this.editor.commitSelection();
    const character = this.studio.character;
    if (!character) {
      this.store.toast('Make a character first');
      return;
    }
    const preview = this.store.characterPreview;
    const tile = preview.enabled
      ? { x: preview.tx, y: preview.ty }
      : screenToCell(this.store.camera, this.store.doc, this.renderer.viewW / 2, this.renderer.viewH / 2);

    new PlayMode(this.store.doc, character, tile, () => {
      // Returning from the test should not look like anything moved.
      this.renderer.resize();
      this.renderer.requestDraw();
    });
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
          detectInto(tileset);
          this.editor.addTileset(tileset);
          this.store.activeTileset = this.store.doc.tilesets.length - 1;
          this.selectFirstTile();
          this.shell.openTab('tiles');
          this.store.toast(`${tileset.name} added: ${tileset.assets!.length} assets`);
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
          // A new grid or image changes what the assets are.
          detectInto(tileset);
          this.editor.replaceTileset(index, tileset);
          this.store.toast('Tileset updated');
        } catch {
          this.store.toast('That image could not be read');
        }
      },
    });
  }

  // --- The asset library ---------------------------------------------------

  /** World point under a screen position, or null when it is off the map view. */
  private worldUnder(clientX: number, clientY: number): { x: number; y: number } | null {
    const rect = this.canvas.getBoundingClientRect();
    const inside =
      clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
    if (!inside) return null;
    return screenToWorld(this.store.camera, clientX - rect.left, clientY - rect.top);
  }

  /**
   * Applies a hand correction to a sheet's assets. The sheet is then marked
   * as edited, so a future detector never redoes it over the user's changes.
   */
  private editAssets(sheetIndex: number, op: 'merge' | 'delete', indices: number[]): void {
    const sheet = this.store.doc.tilesets[sheetIndex];
    const current = sheet?.assets;
    if (!sheet || !current || indices.length === 0) return;

    const next = op === 'merge' ? mergeAssets(current, indices) : deleteAssets(current, indices);
    if (next === current) return;
    const label = op === 'merge' ? 'Merge assets' : 'Delete assets';
    this.editor.structural(label, () => {
      sheet.assets = next;
      sheet.assetsEdited = true;
      // The places recorded as ground no longer line up with the new list.
      sheet.groundAssets = undefined;
    });
    this.store.libraryPick = null;
    this.store.toast(`${label}: ${next.length} left`);
  }

  /** Puts stickers on the Pinned page, or takes them off it. */
  private setPinned(refs: AssetRef[], pinned: boolean): void {
    if (refs.length === 0) return;
    const doc = this.store.doc;
    this.editor.structural(pinned ? 'Pin assets' : 'Unpin assets', () => {
      doc.pins = pinned
        ? [...doc.pins, ...refs.filter((ref) => !doc.pins.some((pin) => sameAsset(pin, ref)))]
        : doc.pins.filter((pin) => !refs.some((ref) => sameAsset(pin, ref)));
    });
    this.store.toast(pinned ? `Pinned ${refs.length}` : `Unpinned ${refs.length}`);
  }

  /** Sets what a folder holds, making it first if it is a new one. */
  private fileAssets(folderId: string | null, name: string, refs: AssetRef[]): void {
    const doc = this.store.doc;
    this.editor.structural(folderId ? 'Edit folder' : 'New folder', () => {
      const folder = doc.folders.find((f) => f.id === folderId);
      if (folder) {
        folder.name = name;
        folder.assets = refs;
      } else {
        doc.folders = [...doc.folders, { id: uid('folder'), name, assets: refs }];
      }
    });
    this.store.toast(folderId ? `${name}: ${refs.length}` : `Filed ${refs.length} in ${name}`);
  }

  private removeFolder(folderId: string): void {
    const doc = this.store.doc;
    const folder = doc.folders.find((f) => f.id === folderId);
    if (!folder) return;
    this.editor.structural('Delete folder', () => {
      doc.folders = doc.folders.filter((f) => f.id !== folderId);
    });
    this.store.toast(`Deleted ${folder.name}`);
  }

  /**
   * A tap on an asset. A floor square becomes the brush so a finger can
   * paint paths. Anything else is added to the middle of the view, selected
   * and ready to move — and the brush is put away, so the next finger on
   * the map pans or drags that asset instead of drawing.
   */
  private tapAsset(sheetIndex: number, assetIndex: number): void {
    const sheet = this.store.doc.tilesets[sheetIndex];
    if (!sheet) return;
    const rect = assetsOf(sheet)[assetIndex];
    if (!rect) return;
    this.store.libraryPick = { tilesetId: sheet.id, index: assetIndex };

    const tile = tileIndexOf(sheet, rect);
    if (tile !== -1 && assetIsGround(sheet, assetIndex)) {
      this.store.setTool('brush');
      this.store.setStamp(singleStamp(sheetIndex, tile), null);
      this.shell.palette.draw();
      this.store.toast('Painting paths. A finger now draws this square.');
      return;
    }

    const centre = screenToWorld(this.store.camera, this.renderer.viewW / 2, this.renderer.viewH / 2);
    this.objects.place(sheet.id, rect, centre.x, centre.y);
    this.store.setTool('select');
    this.shell.palette.draw();
    this.store.toast('Added. Drag it into place, or pinch to resize.');
  }

  private dragStart(tilesetId: string, rect: AssetRect): void {
    this.store.drag = { tilesetId, rect, world: null };
  }

  private dragMove(clientX: number, clientY: number): void {
    const drag = this.store.drag;
    if (!drag) return;
    const at = this.worldUnder(clientX, clientY);
    if (!at) {
      drag.world = null;
      this.store.alignLines = null;
    } else {
      const sheet = this.store.doc.tilesets.find((t) => t.id === drag.tilesetId);
      const scale = sheet && sheet.tileW > 0 ? this.store.doc.tileSize / sheet.tileW : 1;
      drag.world = this.objects.aligned(drag.rect.w * scale, drag.rect.h * scale, at.x, at.y);
    }
    this.renderer.requestDraw();
  }

  private dragEnd(clientX: number, clientY: number, dropped: boolean): void {
    const drag = this.store.drag;
    this.store.drag = null;
    this.store.alignLines = null;
    this.renderer.requestDraw();
    if (!drag || !dropped) return;
    const at = this.worldUnder(clientX, clientY);
    // Released somewhere other than the map: treat it as changing your mind.
    if (!at) return;
    this.objects.place(drag.tilesetId, drag.rect, at.x, at.y);
  }

  /**
   * Opens the colour wheel for a block of ground tiles held with the select
   * tool. Each different tile in the block gets a recoloured copy in the
   * edited-tiles sheet, so other copies of it on the map stay as they were.
   * The whole block shifts relative to its own overall colour, the same way
   * a prop does, so its shades move together. Nothing reaches the map until
   * the block is set down, so setting it down is the undo step.
   */
  private recolorHeldTiles(anchor: HTMLElement): void {
    const held = this.store.selection;
    if (!held) return;
    const doc = this.store.doc;
    const originals = held.tiles.slice();

    const arts = new Map<PackedTile, HTMLCanvasElement>();
    for (const tile of originals) {
      if (tile === EMPTY) continue;
      const art = withFlags(tile, 0);
      if (arts.has(art)) continue;
      const canvas = extractTile(doc, art);
      if (canvas) arts.set(art, canvas);
    }
    if (arts.size === 0) return;

    // One strip of every distinct tile, so the base colour reflects the block.
    const pieces = [...arts.values()];
    const strip = document.createElement('canvas');
    strip.width = pieces.reduce((sum, c) => sum + c.width, 0);
    strip.height = Math.max(...pieces.map((c) => c.height));
    const ctx = strip.getContext('2d');
    let offset = 0;
    for (const c of pieces) {
      ctx?.drawImage(c, offset, 0);
      offset += c.width;
    }
    const base = dominantColor(strip);

    const recoloured = new Map<PackedTile, PackedTile>();
    const touched = new Set<number>();
    openColorPopover({
      anchor,
      initial: hsvToHex(base),
      onChange: (hex) => {
        const target = hexToHsv(hex);
        const shift = {
          hueShift: target.h - base.h,
          saturation: base.s > 0.02 ? target.s / base.s : 1,
          brightness: base.v > 0.02 ? target.v / base.v : 1,
        };
        for (const [art, canvas] of arts) {
          let next = recoloured.get(art);
          if (next === undefined) {
            const sheet = ensureGeneratedSheet(doc, canvas.width, canvas.height);
            next = pack(sheet, doc.tilesets[sheet].count, 0);
            recoloured.set(art, next);
          }
          touched.add(tilesetOf(next));
          writeGeneratedTile(doc.tilesets[tilesetOf(next)], indexOf(next), recolorToCanvas(canvas, shift));
        }
        // The block may have been set down while the wheel was open.
        if (this.store.selection !== held) return;
        held.tiles = originals.map((tile) =>
          tile === EMPTY ? EMPTY : withFlags(recoloured.get(withFlags(tile, 0)) ?? tile, flagsOf(tile)),
        );
        this.renderer.requestDraw();
      },
      onClose: () => {
        for (const sheet of touched) persistGeneratedSheet(doc.tilesets[sheet]);
        if (touched.size > 0) this.store.restructured();
      },
    });
  }

  /**
   * Opens the colour wheel for the selected asset. The wheel starts on the
   * asset's own colour, and moving it is applied as a change relative to that,
   * so every shade shifts together rather than flattening to one colour.
   */
  private recolorObject(anchor: HTMLElement): void {
    const found = this.objects.selected();
    if (!found) return;
    const { obj } = found;
    const sheet = this.store.doc.tilesets.find((t) => t.id === obj.tilesetId);
    if (!sheet?.image) return;

    const base = dominantColor(cropAsset(sheet.image, obj.rect));
    const startColor = hsvToHex({
      h: (((base.h + obj.hueShift) % 360) + 360) % 360,
      s: Math.min(1, base.s * obj.saturation),
      v: Math.min(1, base.v * obj.brightness),
    });

    this.objects.beginGesture();
    openColorPopover({
      anchor,
      initial: startColor,
      onChange: (hex) => {
        const target = hexToHsv(hex);
        this.objects.setColor(obj, {
          hueShift: target.h - base.h,
          saturation: base.s > 0.02 ? target.s / base.s : 1,
          brightness: base.v > 0.02 ? target.v / base.v : 1,
        });
      },
      onClose: () => this.objects.endGesture('Recolour'),
    });
  }

  // --- Per-tile menu -------------------------------------------------------

  /**
   * Opens the menu for whatever tile you can see at a cell. That is the
   * topmost visible tile layer with something there, not necessarily the
   * active one, because you double-tapped what you were looking at.
   */
  private openAssetMenuAt(cell: { x: number; y: number }, clientX: number, clientY: number): void {
    const doc = this.store.doc;
    if (cell.x < 0 || cell.y < 0 || cell.x >= doc.width || cell.y >= doc.height) return;

    for (let i = doc.layers.length - 1; i >= 0; i--) {
      const layer = doc.layers[i];
      if (!layer.visible || layer.kind !== 'tiles') continue;
      if (layer.data[cell.y * doc.width + cell.x] === EMPTY) continue;
      if (layer.locked) {
        this.store.toast(`${layer.name} is locked`);
        return;
      }
      openAssetMenu({ store: this.store, renderer: this.renderer, layer, cell, clientX, clientY });
      return;
    }
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
