import {
  STARTER_TILE,
  createDoc,
  createImageLayer,
  exactPlacement,
  fitPlacement,
  pictureMapSize,
  upgradeTileSize,
  isImageLayer,
  loadImage,
  makeTileset,
  uid,
  type AssetRect,
  type Doc,
  type Tileset,
} from './core/doc';
import { packOf, sameAsset, type AssetRef } from './ui/packs';
import {
  DETECT_VERSION,
  assetIsGround,
  assetsOf,
  detectSheetSplit,
  editSheetAssets,
  tileIndexOf,
  type AssetEdit,
} from './core/assets';
import { clearShadows, clearWhiteBackdrop } from './core/background';
import { dropTilesets, isFloorSheet } from './core/path-merge';
import { isSampleMap, type LibraryEntry } from './library';
import { dominantColor, recolorToCanvas } from './io/recolor';
import { ensureGeneratedSheet, extractTile, persistGeneratedSheet, writeGeneratedTile } from './core/custom-tiles';
import { isSolid } from './core/seamless';
import { cropAsset } from './render/object-draw';
import { gridScale, ObjectTools } from './tools/objects';
import { openColorPopover } from './ui/color-popover';
import { hexToHsv, hsvToHex } from './ui/color-wheel';
import { importSpriteSheet } from './character/import';
import { frameIndex, framePixels } from './character/model';
import { addCharacterArt } from './character/sheet';
import { Studio } from './character/studio';
import { CharacterView } from './character/view';
import { EMPTY_STAMP, singleStamp } from './core/stamp';
import { EMPTY, flagsOf, indexOf, pack, tilesetOf, withFlags, type PackedTile } from './core/tiles';
import { openAssetMenu } from './ui/asset-menu';
import { CharacterPanel } from './ui/character-panel';
import { showCoach } from './ui/coach';
import { openProScreen } from './ui/pro-screen';
import { isPro } from './pro';
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
import { deserializeCharacters, deserializeProject, isProjectFile, serializeProject, type SerializedProject } from './io/project';
import { createAutosave, loadProject } from './io/storage';
import { fitToView, screenToCell, screenToWorld } from './render/camera';
import { Renderer, type CharacterPreviewSource } from './render/renderer';
import { Editor } from './tools/edit';
import { button, el } from './ui/dom';
import { openModal } from './ui/modal';
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
/**
 * Puts a zoomed page back to its normal size. iPad browsers have no call for
 * this, but they re-apply the viewport limits when the tag changes, which
 * zooms the page back out to fit.
 */
function resetPageZoom(): void {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (!meta) return;
  const original = meta.content;
  meta.content = 'width=device-width, initial-scale=1.0, maximum-scale=1.0, minimum-scale=1.0, user-scalable=no';
  requestAnimationFrame(() => {
    meta.content = original;
  });
}

function detectInto(sheet: Tileset): void {
  // Shadows go first, so no asset's box is stretched to take one in. The
  // detector reads a white backdrop itself, so it sees the picture first.
  clearSheetShadows(sheet);
  const split = detectSheetSplit(sheet);
  sheet.assets = split.assets;
  sheet.groundAssets = split.ground;
  sheet.groundBlocks = split.patches;
  sheet.assetsVersion = DETECT_VERSION;
  sheet.splitMode = 'objects';
  clearSheetBackdrop(sheet);
}

/** Runs a pixel edit over a pack's sheet, keeping the result only when it changed something. */
function editSheetPixels(sheet: Tileset, edit: (rgba: Uint8ClampedArray, w: number, h: number) => boolean): void {
  const image = sheet.image;
  if (!image || sheet.generated) return;
  const canvas = document.createElement('canvas');
  canvas.width = sheet.imgW;
  canvas.height = sheet.imgH;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return;
  ctx.drawImage(image, 0, 0);
  const pixels = ctx.getImageData(0, 0, sheet.imgW, sheet.imgH);
  if (!edit(pixels.data, sheet.imgW, sheet.imgH)) return;
  ctx.putImageData(pixels, 0, 0);
  sheet.image = canvas;
}

/** Makes a sheet's painted-on white backdrop transparent, so objects sit on the map. */
function clearSheetBackdrop(sheet: Tileset): void {
  editSheetPixels(sheet, clearWhiteBackdrop);
}

/** Takes the drop shadows out from under a pack's objects. */
function clearSheetShadows(sheet: Tileset): void {
  editSheetPixels(sheet, clearShadows);
}

function sheetPixels(sheet: Tileset): ImageData | null {
  if (!sheet.image) return null;
  const canvas = document.createElement('canvas');
  canvas.width = sheet.imgW;
  canvas.height = sheet.imgH;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(sheet.image, 0, 0);
  return ctx.getImageData(0, 0, sheet.imgW, sheet.imgH);
}

/** Whether an asset is whole grid squares painted edge to edge, so it can be painted as it is. */
function fillsItsSquares(sheet: Tileset, pixels: ImageData, rect: AssetRect): boolean {
  const stepX = sheet.tileW + sheet.spacing;
  const stepY = sheet.tileH + sheet.spacing;
  const aligned =
    (rect.x - sheet.margin) % stepX === 0 &&
    (rect.y - sheet.margin) % stepY === 0 &&
    (rect.w + sheet.spacing) % stepX === 0 &&
    (rect.h + sheet.spacing) % stepY === 0;
  return aligned && isSolid(pixels.data, sheet.imgW, rect);
}

/** Squares across and down a brand-new map: a small village on the starter pack's 16 px grid. */
const STARTER_MAP = { width: 40, height: 30 };

/** A list of library pages, or none when the list is missing or unreadable. */
async function readLibraryList(path: string): Promise<LibraryEntry[]> {
  try {
    // Always ask the server: a cached list would hide packs added since.
    const response = await fetch(new URL(path, document.baseURI), { cache: 'no-cache' });
    if (!response.ok) return [];
    const entries = (await response.json()) as unknown;
    return Array.isArray(entries) ? (entries as LibraryEntry[]) : [];
  } catch {
    return [];
  }
}

/** A labelled percentage slider for the asset colour popover, applied live as it moves. */
function toneSlider(
  label: string,
  min: number,
  max: number,
  value: number,
  onInput: (value: number) => void,
): HTMLElement {
  const slider = el('input', { class: 'slider', type: 'range', min, max, step: 5, value });
  const readout = el('span', { class: 'slider-value', text: `${value}%` });
  slider.addEventListener('input', () => {
    readout.textContent = `${slider.value}%`;
    onInput(Number(slider.value));
  });
  return el('label', { class: 'field tone-field' }, [
    el('span', { class: 'field-label', text: label }),
    el('div', { class: 'slider-row' }, [slider, readout]),
  ]);
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

    this.characterView = new CharacterView(this.studio);
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
      pinPack: (pack, pinned) => this.pinPack(pack, pinned),
      removePack: (pack) => this.removePack(pack),
      recolorObject: (anchor) => this.recolorObject(anchor),
      recolorHeldTiles: (anchor) => this.recolorHeldTiles(anchor),
      addImageLayer: () => void this.addImageLayer(),
      replaceImage: (index) => void this.replaceImage(index),
      newMap: () => this.newMap(),
      newMapFromPicture: () => void this.newMapFromPicture(),
      openProject: () => void this.openProject(),
      exportMap: () => {
        this.editor.commitSelection();
        // Export is what Pro unlocks; everything else in the app is free.
        const open = () => openExportDialog(this.store, this.studio.characters, this.studio.lastPlayedId);
        void isPro().then((pro) => {
          if (pro) open();
          else openProScreen({ unlocked: open, toast: (message) => this.store.toast(message) });
        });
      },
      fitToView: () => this.fit(),
      playTest: () => this.startPlayTest(),
    }, this.studio, this.characterView, this.characterPanel, this.objects);

    // Tiles held up with the select tool are saved where they float, so
    // closing the app mid-move never loses them.
    this.autosave = createAutosave(() =>
      serializeProject(
        this.editor.settledDoc(),
        this.studio.characters,
        this.studio.lastPlayedId,
        this.studio.lastSize,
        this.store.characterPreview.enabled
          ? { x: this.store.characterPreview.tx, y: this.store.characterPreview.ty }
          : null,
      ),
    );

    // Held tiles belong to the select tool; picking up any other tool sets them down.
    this.store.on('ui', () => {
      const tool = this.store.tool;
      if (this.store.selection && tool !== 'select') this.editor.commitSelection();
    });

    this.store.on('doc', () => {
      this.renderer.requestDraw();
      this.autosave.schedule();
    });
    this.store.on('structure', () => this.autosave.schedule());
    // Sprite edits live outside the document, so the studio schedules its own.
    this.studio.on((immediate) => {
      this.autosave.schedule();
      if (immediate) void this.autosave.flush();
    });

    bindKeyboard({
      store: this.store,
      renderer: this.renderer,
      input: this.input,
      shell: this.shell,
      fitToView: () => this.fit(),
    });

    this.input.onDoubleTap = (cell, x, y) => this.openAssetMenuAt(cell, x, y);
    this.input.characterAt = (wx, wy) => {
      const box = this.characterBox();
      return !!box && wx >= box.x && wx < box.x + box.w && wy >= box.y && wy < box.y + box.h;
    };
    this.input.onCharacterTap = (x, y) => this.openCharacterMenu(x, y);
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
      const observer = new ResizeObserver(update);
      observer.observe(this.canvas);
      // The sprite canvas is locked to fit its space, so it must re-fit whenever
      // that space changes, including the panel opening while it is on screen.
      observer.observe(this.characterView.canvas);
    }
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', () => setTimeout(update, 150));
    // iPad browsers ignore user-scalable=no, so a pinch on a canvas that does
    // not zoom itself would zoom the whole page and strand the editor. Zooming
    // the page in is blocked; zooming back out is always allowed.
    const zoomed = () => (window.visualViewport?.scale ?? 1) > 1.01;
    document.addEventListener('gesturestart', (e) => {
      if (!zoomed()) e.preventDefault();
    }, { passive: false });
    document.addEventListener('gesturechange', (e) => {
      const scale = (e as Event & { scale?: number }).scale ?? 1;
      if (!zoomed() || scale > 1) e.preventDefault();
    }, { passive: false });
    // The browser restores page zoom on reload, which is how the app ends up
    // opening zoomed in. Snap back whenever the page is found zoomed.
    window.visualViewport?.addEventListener('resize', () => {
      if (zoomed()) resetPageZoom();
    });
    if (zoomed()) resetPageZoom();
  }

  async start(): Promise<void> {
    // `?map=name` opens a map published with the site, so one link is enough
    // to hand someone a finished map on a tablet. The library still loads
    // afterwards: that link must not leave the rest of the packs missing.
    const wanted = new URLSearchParams(location.search).get('map');
    const opened = wanted ? await this.openPublishedMap(wanted) : false;

    if (!opened) {
      const saved = await loadProject();
      if (saved && isProjectFile(saved)) {
        try {
          const doc = await deserializeProject(saved);
          this.adoptCharacters(saved);
          this.adoptDoc(doc);
        } catch {
          this.adoptDoc(createDoc(STARTER_MAP.width, STARTER_MAP.height, STARTER_TILE));
        }
      } else if (!(await this.openSampleVillage())) {
        this.adoptDoc(createDoc(STARTER_MAP.width, STARTER_MAP.height, STARTER_TILE));
      }
    }

    this.renderer.resize();
    this.fit();

    // Old projects keep their sheets; redo them in the background so the
    // iPad is not frozen while every page is split again.
    await this.refreshStaleAssets();

    const added = await this.loadObjectLibrary();
    if (added > 0) this.store.restructured();
    // A brand-new project has nothing to paint with, so send the user
    // straight to the import step.
    if (this.store.doc.tilesets.length === 0) this.addTileset();
  }

  /**
   * A first launch opens on a small village whose house door leads into a
   * room, with a character on the path, so Play works before anything is
   * drawn. The coach then walks through the three things to try.
   */
  private async openSampleVillage(): Promise<boolean> {
    try {
      const response = await fetch(new URL('starter/sample-village.pfproj', document.baseURI));
      if (!response.ok) return false;
      const data = (await response.json()) as unknown;
      if (!isProjectFile(data)) return false;
      const doc = await deserializeProject(data);
      this.adoptDoc(doc);
      this.adoptCharacters(data);
      showCoach({ play: () => this.startPlayTest() });
      return true;
    } catch {
      return false;
    }
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
      this.adoptCharacters(data);
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
    // The starter pack ships in every build. The wider library only exists
    // in the web build, so a missing list is normal and skipped.
    const entries = [...(await readLibraryList('starter/manifest.json')), ...(await readLibraryList('library/manifest.json'))];
    if (entries.length === 0) return 0;

    const skipKey = `pf-library-skip-${DETECT_VERSION}`;
    let skipped = new Set<string>();
    try {
      const stored = JSON.parse(localStorage.getItem(skipKey) ?? '[]') as unknown;
      if (Array.isArray(stored)) skipped = new Set(stored.filter((name) => typeof name === 'string'));
    } catch {
      /* a blocked localStorage just means scene pages are checked again */
    }

    const have = new Set([...this.store.doc.tilesets.map((sheet) => sheet.name), ...this.store.doc.removedSheets]);
    let added = this.applyLibraryHints(entries);
    let opened = this.store.doc.tilesets.length === 0;
    for (const entry of entries) {
      if (have.has(entry.name) || skipped.has(entry.name)) continue;
      this.store.toast(`Loading ${entry.name}`);
      await new Promise((resolve) => setTimeout(resolve, 0));
      try {
        const tile = typeof entry.tile === 'number' && entry.tile > 0 ? entry.tile : 48;
        const tileset = await makeTileset(new URL(entry.url, document.baseURI).href, entry.name, tile, tile);
        if (entry.props) tileset.propsOnly = true;
        if (Array.isArray(entry.assets) && entry.assets.length > 0) {
          // A page laid out by hand lists its pictures; guessing could only cut them up.
          tileset.splitMode = 'objects';
          tileset.assets = entry.assets.map((rect) => ({ ...rect }));
          tileset.groundAssets = [];
          tileset.assetsEdited = true;
          tileset.assetsVersion = DETECT_VERSION;
          clearSheetShadows(tileset);
          clearSheetBackdrop(tileset);
        } else {
          detectInto(tileset);
        }
        if (!entry.assets?.length && isSampleMap(tileset.imgW, tileset.imgH, tileset.assets ?? [])) {
          skipped.add(entry.name);
          continue;
        }
        have.add(entry.name);
        // Painted squares remember their sheet by position, so a new page
        // only ever goes on the end; anywhere else would move every map.
        this.store.doc.tilesets.push(tileset);
        added += 1;
        // Show each page as it lands so the iPad is not empty for minutes.
        if (opened) {
          opened = false;
          this.store.activeTileset = 0;
          this.selectFirstTile();
          this.shell.openTab('tiles');
        }
        this.store.emit('library');
      } catch {
        /* one unreadable page should not drop the rest */
      }
    }
    try {
      localStorage.setItem(skipKey, JSON.stringify([...skipped]));
    } catch {
      /* the pages still loaded for this visit */
    }
    if (added === 0) return 0;
    this.store.toast(`${added} asset ${added === 1 ? 'page' : 'pages'} ready`);
    return added;
  }

  /**
   * Pages saved in the project before the library said they hold whole
   * objects, or listed their picture boxes, are split again to match. A page
   * the user has edited by hand keeps their edits.
   */
  private applyLibraryHints(entries: LibraryEntry[]): number {
    let changed = 0;
    for (const entry of entries) {
      const sheet = this.store.doc.tilesets.find((t) => t.name === entry.name);
      if (!sheet?.image) continue;
      const boxes = Array.isArray(entry.assets) && entry.assets.length > 0 ? entry.assets : null;
      if (boxes) {
        const same =
          sheet.assets?.length === boxes.length &&
          sheet.assets.every((a, i) => a.x === boxes[i].x && a.y === boxes[i].y && a.w === boxes[i].w && a.h === boxes[i].h);
        if (same) continue;
        sheet.splitMode = 'objects';
        sheet.assets = boxes.map((rect) => ({ ...rect }));
        sheet.groundAssets = [];
        sheet.groundBlocks = [];
        sheet.assetsEdited = true;
        sheet.assetsVersion = DETECT_VERSION;
        sheet.propsOnly = !!entry.props;
        changed += 1;
        continue;
      }
      if (entry.props && !sheet.propsOnly && !sheet.assetsEdited) {
        sheet.propsOnly = true;
        detectInto(sheet);
        changed += 1;
      }
    }
    return changed;
  }

  /**
   * Re-splits sheets found by an older detector, one page at a time so the
   * editor stays usable on a tablet while that runs.
   */
  private async refreshStaleAssets(): Promise<void> {
    const stale = this.store.doc.tilesets.filter((sheet) => needsDetection(sheet));
    if (stale.length === 0) return;
    for (const sheet of stale) {
      this.store.toast(`Updating ${sheet.name}`);
      await new Promise((resolve) => setTimeout(resolve, 0));
      try {
        detectInto(sheet);
      } catch {
        /* one bad sheet must not block the rest */
      }
      this.store.emit('library');
    }
    this.store.restructured();
  }

  /** Installs a document and resets everything derived from the old one. */
  private adoptDoc(doc: Doc): void {
    // Floor pages are gone from the app. Older maps lose them here, along with
    // anything painted from them; every other square keeps its picture.
    dropTilesets(doc, isFloorSheet);
    // Object pages that need a newer detector are redone after the first
    // paint, not here.
    for (const sheet of doc.tilesets) {
      clearSheetShadows(sheet);
      clearSheetBackdrop(sheet);
    }
    // Maps made with 16 px squares shrank every library tile to a third,
    // which is what warped the pixels. They move onto the art's own size.
    const upgraded = upgradeTileSize(doc);

    this.store.doc = doc;
    if (upgraded) this.store.toast('Map squares are now 48 px, so the art shows pixel for pixel');
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
          this.studio.rememberPlayed(character);
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
    image.data.set(framePixels(frame.data, character.w, character.h));
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

  /** Restores saved characters and which one Play should walk. */
  private adoptCharacters(data: SerializedProject): void {
    this.studio.characters = deserializeCharacters(data);
    const id = data.lastPlayedCharacter;
    const index = this.studio.characters.findIndex((character) => character.id === id);
    this.studio.activeCharacter = index >= 0 ? index : 0;
    this.studio.lastPlayedId = this.studio.characters[this.studio.activeCharacter]?.id ?? null;
    const size = data.lastCharacterSize;
    this.studio.lastSize =
      size && Number.isFinite(size.tilesW) && Number.isFinite(size.tilesH)
        ? { tilesW: size.tilesW, tilesH: size.tilesH }
        : null;
    this.studio.clearHistory();
    this.studio.emit();
    this.characterPanel.refresh();
    this.characterView.fit();
    // The character goes back where it was left standing on the map.
    const at = data.characterAt;
    const preview = this.store.characterPreview;
    preview.enabled = !!at && Number.isFinite(at.x) && Number.isFinite(at.y) && this.studio.characters.length > 0;
    if (at && preview.enabled) {
      preview.tx = at.x;
      preview.ty = at.y;
    }
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
    this.studio.rememberPlayed(character);
    this.autosave.schedule();
    void this.autosave.flush();
    const preview = this.store.characterPreview;
    const tile = preview.enabled
      ? { x: preview.tx, y: preview.ty }
      : screenToCell(this.store.camera, this.store.doc, this.renderer.viewW / 2, this.renderer.viewH / 2);

    new PlayMode(this.store, this.objects, character, tile, (end) => {
      // The character stays where you walked it, so the map picks up from there.
      preview.tx = end.x;
      preview.ty = end.y;
      preview.enabled = true;
      preview.placing = false;
      this.renderer.resize();
      this.renderer.requestDraw();
      this.store.emit('ui');
    });
  }

  /** The box the standing character covers, in world pixels. */
  private characterBox(): { x: number; y: number; w: number; h: number } | null {
    const character = this.studio.character;
    const preview = this.store.characterPreview;
    if (!character || !preview.enabled) return null;
    const tile = this.store.doc.tileSize;
    const tilesW = character.w / tile;
    return {
      x: (preview.tx - (tilesW - 1) / 2) * tile,
      y: (preview.ty + 1) * tile - character.h,
      w: character.w,
      h: character.h,
    };
  }

  /** Tapping the character on the map: stick any character there as an asset, move it, or play. */
  private openCharacterMenu(clientX: number, clientY: number): void {
    document.querySelector('.size-menu')?.remove();
    const preview = this.store.characterPreview;
    const menu = el('div', { class: 'size-menu', role: 'menu' });
    const close = () => {
      menu.remove();
      document.removeEventListener('pointerdown', outside, true);
    };
    const outside = (e: Event) => {
      if (!menu.contains(e.target as Node)) close();
    };
    const item = (label: string, note: string, run: () => void) => {
      const node = button('size-menu-item', label, () => {
        close();
        run();
      }, [el('span', { class: 'size-menu-tiles', text: label }), note ? el('span', { class: 'size-menu-px', text: note }) : null]);
      node.setAttribute('role', 'menuitem');
      return node;
    };

    menu.append(el('div', { class: 'size-menu-title', text: 'Stick on the map' }));
    this.studio.characters.forEach((character, index) => {
      const current = index === this.studio.activeCharacter;
      menu.append(
        item(character.name, current ? 'Playing' : `${character.tilesW} x ${character.tilesH}`, () =>
          this.stickCharacter(index, preview.tx, preview.ty),
        ),
      );
    });
    menu.append(
      el('div', { class: 'size-menu-title', text: 'Your character' }),
      item('Play from here', '', () => this.startPlayTest()),
      item('Move', '', () => {
        preview.placing = true;
        this.store.toast('Tap the map to move your character');
        this.store.emit('ui');
      }),
      item('Hide', '', () => {
        preview.enabled = false;
        preview.placing = false;
        this.renderer.requestDraw();
        this.store.emit('ui');
      }),
    );

    document.body.append(menu);
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    menu.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, clientX - width / 2))}px`;
    menu.style.top = `${Math.max(8, Math.min(window.innerHeight - height - 8, clientY + 12))}px`;
    // Wait for this press to finish, or it would count as a press outside.
    setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
  }

  /** Places a character's standing pose as an asset, feet on the given square. */
  private stickCharacter(index: number, tx: number, ty: number): void {
    const character = this.studio.characters[index];
    if (!character) return;
    const art = addCharacterArt(this.store.doc, character);
    if (!art) {
      this.store.toast('Draw something first: that character is empty');
      return;
    }
    const tile = this.store.doc.tileSize;
    this.objects.place(art.tilesetId, art.rect, (tx + 0.5) * tile, (ty + 1) * tile - art.rect.h / 2);
    this.renderer.invalidateAll();
    this.store.restructured();
    this.store.toast(`${character.name} is on the map. Find them in Assets under Characters.`);
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
  private editAssets(sheetIndex: number, op: AssetEdit, indices: number[]): void {
    const sheet = this.store.doc.tilesets[sheetIndex];
    if (!sheet || indices.length === 0) return;
    if (!sheet.assets) return;

    // A shaped object, such as a dirt plot with rounded corners, would paint
    // its corners and outline into every square, so it stays an object.
    if (op === 'toGround') {
      const pixels = sheetPixels(sheet);
      const rects = sheet.assets;
      const shaped = pixels ? indices.filter((i) => !fillsItsSquares(sheet, pixels, rects[i])) : [];
      if (shaped.length > 0) {
        indices = indices.filter((i) => !shaped.includes(i));
        if (indices.length === 0) {
          this.store.toast('Only whole, solid squares can be a floor. This stays an object you place.');
          return;
        }
      }
    }

    const next = editSheetAssets(sheet, op, indices);
    if (op === 'merge' && next.assets === sheet.assets) return;
    const label = {
      merge: 'Merge assets',
      delete: 'Delete assets',
      toGround: 'Make floor',
      toObjects: 'Not a floor',
    }[op];
    this.editor.structural(label, () => {
      sheet.assets = next.assets;
      sheet.groundAssets = next.ground;
      sheet.groundBlocks = next.patches;
      sheet.assetsEdited = true;
    });
    this.store.libraryPick = null;
    if (op === 'toGround') this.store.toast('Now a floor square, first on this page. Paint it with the brush or rectangle.');
    else if (op === 'toObjects') this.store.toast('Back to an object you place');
    else this.store.toast(`${label}: ${next.assets.length} left`);
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
   * A tap on an asset. A ground square becomes the brush's paint. Anything
   * else is armed on the brush: each tap on the map places a copy. Only the
   * brush places, so the brush is picked up for it.
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
      this.store.toast('Painting ground. Draw with the Pencil, or use Rectangle to fill an area.');
      return;
    }

    this.store.setTool('brush');
    this.shell.palette.draw();
    this.store.toast('Tap the map to place it. Each tap adds another.');
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
      const base = sheet && sheet.tileW > 0 ? this.store.doc.tileSize / sheet.tileW : 1;
      const scale = gridScale(drag.rect.w, drag.rect.h, base, this.store.doc.tileSize);
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
    const objs = this.objects.recolorable();
    if (objs.length === 0) return;
    const doc = this.store.doc;

    // One strip of every asset's art, so the wheel starts on the colour of
    // the selection as a whole and every asset shifts by the same amount.
    const crops = objs.flatMap((obj) => {
      const sheet = doc.tilesets.find((t) => t.id === obj.tilesetId);
      return sheet?.image ? [cropAsset(sheet.image, obj.rect)] : [];
    });
    if (crops.length === 0) return;
    const strip = document.createElement('canvas');
    strip.width = crops.reduce((sum, c) => sum + c.width, 0);
    strip.height = Math.max(...crops.map((c) => c.height));
    const ctx = strip.getContext('2d');
    let offset = 0;
    for (const crop of crops) {
      ctx?.drawImage(crop, offset, 0);
      offset += crop.width;
    }
    const base = dominantColor(strip);
    const first = objs[0];
    const startColor =
      objs.length === 1
        ? hsvToHex({
            h: (((base.h + first.hueShift) % 360) + 360) % 360,
            s: Math.min(1, base.s * first.saturation),
            v: Math.min(1, base.v * first.brightness),
          })
        : hsvToHex(base);

    const contrast = toneSlider('Contrast', 50, 200, Math.round((first.contrast ?? 1) * 100), (value) => {
      for (const obj of objs) this.objects.setTone(obj, { contrast: value / 100 });
    });
    const clarity = toneSlider('Clarity', 0, 100, Math.round((first.clarity ?? 0) * 100), (value) => {
      for (const obj of objs) this.objects.setTone(obj, { clarity: value / 100 });
    });

    this.objects.beginGesture();
    openColorPopover({
      anchor,
      initial: startColor,
      onChange: (hex) => {
        const target = hexToHsv(hex);
        const color = {
          hueShift: target.h - base.h,
          saturation: base.s > 0.02 ? target.s / base.s : 1,
          brightness: base.v > 0.02 ? target.v / base.v : 1,
        };
        for (const obj of objs) this.objects.setColor(obj, color);
      },
      onClose: () => this.objects.endGesture(objs.length > 1 ? `Recolour ${objs.length}` : 'Recolour'),
      extra: [contrast, clarity],
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
    this.editor.removeTilesets([index]);
    this.store.activeTileset = Math.max(0, Math.min(this.store.activeTileset, this.store.doc.tilesets.length - 1));
    this.store.setStamp(EMPTY_STAMP);
    this.store.toast(`Removed ${tileset.name}`);
  }

  /** Takes every page of a pack out of the map, after asking. */
  private removePack(pack: string): void {
    const doc = this.store.doc;
    const indices = doc.tilesets.flatMap((sheet, i) => (packOf(sheet.name) === pack ? [i] : []));
    if (indices.length === 0) return;
    const pages = indices.length === 1 ? '1 page' : `${indices.length} pages`;
    if (!window.confirm(`Delete the ${pack} pack (${pages})? Anything placed from it comes off the map. Undo brings it back.`)) {
      return;
    }
    this.editor.removeTilesets(indices, 'Delete pack');
    this.store.activeTileset = Math.max(0, Math.min(this.store.activeTileset, doc.tilesets.length - 1));
    this.store.libraryPick = null;
    this.store.setStamp(EMPTY_STAMP);
    this.store.toast(`Deleted ${pack}`);
  }

  /** Lists a pack first in the pack list, or puts it back in order. */
  private pinPack(pack: string, pinned: boolean): void {
    const doc = this.store.doc;
    this.editor.structural(pinned ? 'Pin pack' : 'Unpin pack', () => {
      doc.pinnedPacks = pinned ? [...doc.pinnedPacks.filter((p) => p !== pack), pack] : doc.pinnedPacks.filter((p) => p !== pack);
    });
    this.store.toast(pinned ? `Pinned ${pack}` : `Unpinned ${pack}`);
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

  /** Asks first, since a new map replaces the one that is open. */
  private newMapFromPicture(): void {
    openModal({
      title: 'New map from picture',
      body: el('div', { class: 'dialog-body' }, [
        el('p', {
          text: 'Choose a drawing of a map. It becomes a locked background, 32 squares wide and as tall as its shape needs, with each of its squares on a grid square.',
        }),
        el('p', { class: 'hint', text: 'This replaces the map you have open. Export it first if you want to keep it.' }),
      ]),
      actions: [
        { label: 'Cancel' },
        // The file picker has to open straight from the tap, or iPadOS blocks it.
        { label: 'Choose picture', variant: 'primary', onSelect: () => void this.buildPictureMap() },
      ],
    });
  }

  /**
   * A map sized to a picture, with the picture as its locked background.
   * The picture is redrawn once at the map's exact pixel size, so every
   * square it was drawn on lands on a grid square and it draws pixel for
   * pixel instead of being stretched on every frame.
   */
  private async buildPictureMap(): Promise<void> {
    const file = await pickFile('image/*');
    if (!file) return;
    try {
      const image = await loadImage(await readFileAsDataUrl(file));
      const { width, height } = pictureMapSize(image.naturalWidth, image.naturalHeight);
      const doc = createDoc(width, height, this.store.doc.tileSize);
      doc.name = file.name.replace(/\.[^.]+$/, '') || 'Picture map';
      doc.tilesets = this.store.doc.tilesets;
      doc.pins = this.store.doc.pins;
      doc.folders = this.store.doc.folders;

      const placement = exactPlacement(doc);
      const canvas = document.createElement('canvas');
      canvas.width = placement.w;
      canvas.height = placement.h;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('2D canvas is unavailable');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(image, 0, 0, placement.w, placement.h);
      const src = canvas.toDataURL('image/png');
      const baked = await loadImage(src);

      const background = createImageLayer(src, baked, 'Background', placement);
      background.opacity = 1;
      background.locked = true;
      const floors = doc.layers[0];
      floors.name = 'Floors';
      doc.layers = [background, floors];
      doc.activeLayer = 1;

      this.adoptDoc(doc);
      this.fit();
      this.store.toast(`${doc.name}: ${width} x ${height} squares. Paint floors and add objects on top.`);
    } catch {
      this.store.toast('That picture could not be used');
    }
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
      this.adoptCharacters(parsed);
      this.adoptDoc(doc);
      this.fit();
      void this.refreshStaleAssets();
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
