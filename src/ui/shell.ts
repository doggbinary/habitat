import type { PixelTool, Studio } from '../character/studio';
import type { CharacterView } from '../character/view';
import { flipStampH, flipStampV, rotateStampCW, type Stamp } from '../core/stamp';
import type { Shape, Store, ToolId } from '../core/store';
import { clampZoom, zoomAt } from '../render/camera';
import type { Renderer } from '../render/renderer';
import type { Editor } from '../tools/edit';
import type { ObjectTools } from '../tools/objects';
import type { CharacterPanel } from './character-panel';
import { button, clear, el } from './dom';
import { icon, type IconName } from './icons';
import { LayersPanel } from './layers';
import { MapPanel } from './map-panel';
import { PalettePanel, type PaletteActions } from './palette';

export interface ShellActions {
  addTileset: () => void;
  editTileset: (index: number) => void;
  removeTileset: (index: number) => void;
  tapAsset: PaletteActions['tapAsset'];
  dragStart: PaletteActions['dragStart'];
  dragMove: PaletteActions['dragMove'];
  dragEnd: PaletteActions['dragEnd'];
  editAssets: PaletteActions['editAssets'];
  setPinned: PaletteActions['setPinned'];
  fileAssets: PaletteActions['fileAssets'];
  removeFolder: PaletteActions['removeFolder'];
  recolorObject: (anchor: HTMLElement) => void;
  recolorHeldTiles: (anchor: HTMLElement) => void;
  addImageLayer: () => void;
  replaceImage: (index: number) => void;
  newMap: () => void;
  openProject: () => void;
  exportMap: () => void;
  fitToView: () => void;
  playTest: () => void;
}

type TabId = 'tiles' | 'layers' | 'map';
export type Mode = 'map' | 'character';

/** Pixel tools, shown in the rail while the character studio is open. */
const PIXEL_TOOLS: { id: PixelTool; icon: IconName; label: string; key: string }[] = [
  { id: 'pencil', icon: 'brush', label: 'Draw', key: 'B' },
  { id: 'eraser', icon: 'eraser', label: 'Erase', key: 'E' },
  { id: 'fill', icon: 'fill', label: 'Fill', key: 'G' },
  { id: 'picker', icon: 'picker', label: 'Pick', key: 'I' },
];

const TOOLS: { id: ToolId; icon: IconName; label: string; key: string }[] = [
  { id: 'brush', icon: 'brush', label: 'Brush', key: 'B' },
  { id: 'eraser', icon: 'eraser', label: 'Eraser', key: 'E' },
  { id: 'fill', icon: 'fill', label: 'Fill', key: 'G' },
  { id: 'rect', icon: 'rect', label: 'Rectangle', key: 'R' },
  { id: 'line', icon: 'line', label: 'Line', key: 'L' },
  { id: 'select', icon: 'select', label: 'Select', key: 'V' },
  { id: 'picker', icon: 'picker', label: 'Pick tile', key: 'I' },
  { id: 'pan', icon: 'pan', label: 'Pan', key: 'H' },
];

const ERASER_SHAPES: { id: Shape; icon: IconName; label: string }[] = [
  { id: 'brush', icon: 'brush', label: 'Freehand' },
  { id: 'rect', icon: 'rect', label: 'Rectangle' },
  { id: 'line', icon: 'line', label: 'Line' },
  { id: 'fill', icon: 'fill', label: 'Connected area' },
];

export class Shell {
  readonly palette: PalettePanel;
  private readonly layersPanel: LayersPanel;
  private readonly mapPanel: MapPanel;

  private readonly toolRail: HTMLElement;
  private readonly topActions: HTMLElement;
  private readonly optionsBar: HTMLElement;
  private readonly status: HTMLElement;
  private readonly dock: HTMLElement;
  private readonly dockBody: HTMLElement;
  private readonly tabBar: HTMLElement;
  private readonly title: HTMLElement;
  private readonly toastNode: HTMLElement;

  private tab: TabId = 'tiles';
  private dockOpen = true;
  private toastTimer: number | undefined;
  private mode: Mode = 'map';
  private readonly modeBar: HTMLElement;

  constructor(
    root: HTMLElement,
    canvas: HTMLCanvasElement,
    private readonly store: Store,
    private readonly editor: Editor,
    private readonly renderer: Renderer,
    private readonly actions: ShellActions,
    private readonly studio: Studio,
    private readonly characterView: CharacterView,
    private readonly characterPanel: CharacterPanel,
    private readonly objects: ObjectTools,
  ) {
    this.palette = new PalettePanel(store, {
      addTileset: actions.addTileset,
      editTileset: actions.editTileset,
      removeTileset: actions.removeTileset,
      tapAsset: actions.tapAsset,
      dragStart: actions.dragStart,
      dragMove: actions.dragMove,
      dragEnd: actions.dragEnd,
      editAssets: actions.editAssets,
      setPinned: actions.setPinned,
      fileAssets: actions.fileAssets,
      removeFolder: actions.removeFolder,
    });
    this.layersPanel = new LayersPanel(store, editor, {
      addImageLayer: actions.addImageLayer,
      replaceImage: actions.replaceImage,
    });
    this.mapPanel = new MapPanel(store, editor, actions);

    this.toolRail = el('nav', { class: 'tool-rail', aria: { label: 'Tools' } });
    this.topActions = el('div', { class: 'top-actions' });
    this.optionsBar = el('div', { class: 'options-bar' });
    this.status = el('div', { class: 'status-bar' });
    this.dockBody = el('div', { class: 'dock-body' });
    this.tabBar = el('div', { class: 'dock-tabs', role: 'tablist' });
    this.title = el('button', { class: 'map-title', type: 'button' });
    this.toastNode = el('div', { class: 'toast' });

    this.dock = el('aside', { class: 'dock' }, [this.tabBar, this.dockBody]);

    this.modeBar = el('div', { class: 'mode-bar', role: 'tablist' });

    const canvasArea = el('div', { class: 'canvas-area' }, [
      canvas,
      characterView.canvas,
      this.optionsBar,
      this.status,
    ]);

    root.append(
      el('div', { class: 'app' }, [
        el('header', { class: 'topbar' }, [
          el('div', { class: 'brand' }, [icon('pencilTip', 20), el('span', { text: 'Pixel Fusion' })]),
          this.modeBar,
          this.title,
          this.topActions,
        ]),
        el('div', { class: 'workspace' }, [this.toolRail, canvasArea, this.dock]),
        this.toastNode,
      ]),
    );

    this.title.addEventListener('click', () => this.openTab('map'));

    this.buildModeBar();
    this.buildTabs();
    this.openTab('tiles');
    this.setMode('map');
    this.refreshChrome();

    store.on('ui', () => this.refreshChrome());
    store.on('view', () => this.refreshStatus());
    store.on('structure', () => this.refreshPanels());
    store.on('toast', (message) => this.toast(String(message)));
    // The studio owns its own state, so mirror its changes into the chrome.
    studio.on(() => {
      if (this.mode !== 'character') return;
      // The whole chrome, not just the rail: the bottom bar and size readout
      // depend on whether a character exists, which is exactly what changes
      // when one is created or deleted.
      this.refreshChrome();
    });
  }

  // --- Chrome --------------------------------------------------------------

  private buildModeBar(): void {
    clear(this.modeBar);
    const modes: { id: Mode; label: string; icon: IconName }[] = [
      { id: 'map', label: 'Map', icon: 'grid' },
      { id: 'character', label: 'Character', icon: 'pencilTip' },
    ];
    for (const mode of modes) {
      const active = this.mode === mode.id;
      const node = button(`mode-btn${active ? ' active' : ''}`, mode.label, () => this.setMode(mode.id), [
        icon(mode.icon, 17),
        el('span', { text: mode.label }),
      ]);
      node.setAttribute('role', 'tab');
      node.setAttribute('aria-selected', String(active));
      this.modeBar.append(node);
    }
  }

  get currentMode(): Mode {
    return this.mode;
  }

  /**
   * Routes a tool shortcut to whichever toolset is on screen, so B always
   * means "draw" whether you are painting tiles or pixels.
   */
  selectToolByKey(key: string): boolean {
    if (this.mode === 'character') {
      const tool = PIXEL_TOOLS.find((t) => t.key.toLowerCase() === key);
      if (!tool) return false;
      this.studio.tool = tool.id;
      this.studio.emit();
      this.refreshPanels();
      return true;
    }
    const tool = TOOLS.find((t) => t.key.toLowerCase() === key);
    if (!tool) return false;
    this.store.setTool(tool.id);
    return true;
  }

  setMode(mode: Mode): void {
    if (mode !== 'map') this.editor.commitSelection();
    this.mode = mode;
    const character = mode === 'character';
    this.renderer.canvas.classList.toggle('inactive', character);
    this.characterView.canvas.classList.toggle('inactive', !character);

    this.buildModeBar();
    this.buildTabs();
    this.refreshPanelBody();
    this.refreshChrome();

    // Both canvases are laid out by CSS, so whichever just appeared needs to
    // measure itself before its first paint.
    requestAnimationFrame(() => {
      if (character) {
        this.characterView.resize();
        if (this.studio.characters.length > 0) this.characterView.fit();
      } else {
        this.renderer.resize();
      }
    });
  }

  private buildToolRail(): void {
    clear(this.toolRail);

    if (this.mode === 'character') {
      for (const tool of PIXEL_TOOLS) {
        const active = this.studio.tool === tool.id;
        const node = button(
          `tool-btn${active ? ' active' : ''}`,
          `${tool.label} (${tool.key})`,
          () => {
            this.studio.tool = tool.id;
            this.studio.emit();
            this.refreshPanels();
          },
          [icon(tool.icon, 23), el('span', { class: 'tool-label', text: tool.label })],
        );
        node.setAttribute('aria-pressed', String(active));
        this.toolRail.append(node);
      }
      return;
    }

    for (const tool of TOOLS) {
      const active = this.store.tool === tool.id;
      const node = button(
        `tool-btn${active ? ' active' : ''}`,
        `${tool.label} (${tool.key})`,
        () => this.store.setTool(tool.id),
        [icon(tool.icon, 23), el('span', { class: 'tool-label', text: tool.label })],
      );
      node.setAttribute('aria-pressed', String(active));
      this.toolRail.append(node);
    }
  }

  private buildTopActions(): void {
    clear(this.topActions);
    const character = this.mode === 'character';

    const canUndo = character ? this.studio.canUndo : this.store.history.canUndo;
    const canRedo = character ? this.studio.canRedo : this.store.history.canRedo;

    const undo = button('icon-btn', 'Undo', () => this.undo(), [icon('undo', 20)]);
    undo.disabled = !canUndo;
    const redo = button('icon-btn', 'Redo', () => this.redo(), [icon('redo', 20)]);
    redo.disabled = !canRedo;

    if (!character) {
      const { undoLabel, redoLabel } = this.store.history;
      if (undoLabel) undo.title = `Undo ${undoLabel.toLowerCase()}`;
      if (redoLabel) redo.title = `Redo ${redoLabel.toLowerCase()}`;
    }

    const selectedAsset = !character && this.objects.selected();
    const heldTiles = !character && this.store.selection;
    if (selectedAsset || heldTiles) {
      this.topActions.append(
        button('top-delete', 'Delete', () => {
          if (this.objects.selected()) this.objects.remove();
          else this.editor.deleteSelection();
        }, [icon('trash', 18), el('span', { text: 'Delete' })]),
      );
    }

    this.topActions.append(
      undo,
      redo,
      el('div', { class: 'divider' }),
      button('icon-btn', 'Zoom out', () => this.nudgeZoom(1 / 1.4), [icon('zoomOut', 20)]),
      button('icon-btn', 'Zoom in', () => this.nudgeZoom(1.4), [icon('zoomIn', 20)]),
      button('icon-btn', character ? 'Fit sprite to screen' : 'Fit map to screen', () => {
        if (character) this.characterView.fit();
        else this.actions.fitToView();
      }, [icon('fit', 20)]),
      el('div', { class: 'divider' }),
      button('icon-btn', 'Export', () => this.actions.exportMap(), [icon('download', 20)]),
      button('icon-btn dock-toggle', 'Show or hide the side panel', () => this.toggleDock(), [
        icon('layers', 20),
      ]),
    );
  }

  undo(): void {
    if (this.mode === 'character') {
      this.studio.undo();
      this.characterView.requestDraw();
      this.refreshPanels();
    } else {
      this.editor.undo();
    }
  }

  redo(): void {
    if (this.mode === 'character') {
      this.studio.redo();
      this.characterView.requestDraw();
      this.refreshPanels();
    } else {
      this.editor.redo();
    }
  }

  private buildOptionsBar(): void {
    clear(this.optionsBar);
    const store = this.store;
    const chips: HTMLElement[] = [];

    // A selected asset owns the bar: every control here acts on it, and
    // nothing else is relevant until you tap away.
    const found = this.mode === 'map' ? this.objects.selected() : null;
    if (found) {
      // Built directly rather than through `selectionChip`, which rebuilds the
      // bar on click and would detach this button before the colour popover
      // could anchor to it.
      const recolor: HTMLButtonElement = button('chip', 'Recolour', () => this.actions.recolorObject(recolor), [
        icon('palette', 17),
      ]);
      const locked = !!found.obj.locked;
      const guard = (node: HTMLButtonElement) => {
        node.disabled = locked;
        return node;
      };
      // Several assets picked at once can be joined, so they move as one.
      const picked = this.store.selectedGroup.length;
      const grouping =
        picked > 1
          ? this.selectionChip('layers', 'Group', () => this.objects.groupSelected(), '', `Group ${picked}`)
          : found.obj.groupId
            ? this.selectionChip('layers', 'Ungroup', () => this.objects.ungroupSelected(), '', 'Ungroup')
            : null;

      this.optionsBar.append(
        this.chipToggle(locked ? 'lock' : 'unlock', locked ? 'Unlock' : 'Lock', locked, () => this.objects.toggleLock()),
        ...(grouping ? [grouping] : []),
        guard(this.selectionChip('trash', 'Delete', () => this.objects.remove(), 'danger', 'Delete')),
        this.chipToggle('grid', 'Guides', this.store.settings.alignGuides, () => {
          this.store.settings.alignGuides = !this.store.settings.alignGuides;
          if (!this.store.settings.alignGuides) this.store.alignLines = null;
          this.refreshChrome();
          this.renderer.requestDraw();
        }),
        el('div', { class: 'divider vertical' }),
        el('span', { class: 'chip-label', text: `${Math.round(found.obj.scale * 100)}%` }),
        el('div', { class: 'divider vertical' }),
        guard(this.selectionChip('rotate', 'Rotate', () => this.objects.rotate())),
        guard(this.selectionChip('flipH', 'Flip across', () => this.objects.flipAcross())),
        guard(this.selectionChip('flipV', 'Flip down', () => this.objects.flipDown())),
        guard(recolor),
        el('div', { class: 'divider vertical' }),
        this.orderGroup(locked),
        el('div', { class: 'divider vertical' }),
        guard(this.selectionChip('copy', 'Duplicate', () => this.objects.duplicate())),
      );
      return;
    }

    // Held tiles own the bar the same way, until they are set down.
    const held = this.mode === 'map' ? store.selection : null;
    // Laid out like the asset bar, so ground and props are worked the same way.
    if (held) {
      const layer = store.doc.layers.find((l) => l.id === held.layerId);
      const recolor: HTMLButtonElement = button('chip', 'Recolour', () => this.actions.recolorHeldTiles(recolor), [
        icon('palette', 17),
      ]);
      const order = el('div', { class: 'order-group', role: 'group' }, [
        this.selectionChip('sendBackward', 'Send behind, onto the layer below', () => this.editor.moveSelectionDepth(-1), 'order-chip', 'Backward'),
        this.selectionChip('bringForward', 'Bring in front, onto the layer above', () => this.editor.moveSelectionDepth(1), 'order-chip', 'Forward'),
      ]);
      order.setAttribute('aria-label', 'Order');
      this.optionsBar.append(
        el('span', { class: 'chip-label', text: `${held.w} x ${held.h} · ${layer?.name ?? 'layer'}` }),
        el('div', { class: 'divider vertical' }),
        this.selectionChip('rotate', 'Rotate', () => this.editor.transformSelection('rotate')),
        this.selectionChip('flipH', 'Flip across', () => this.editor.transformSelection('flipH')),
        this.selectionChip('flipV', 'Flip down', () => this.editor.transformSelection('flipV')),
        recolor,
        el('div', { class: 'divider vertical' }),
        order,
        el('div', { class: 'divider vertical' }),
        this.selectionChip('copy', 'Duplicate', () => this.editor.duplicateSelection()),
        this.selectionChip('trash', 'Delete', () => this.editor.deleteSelection(), 'danger', 'Delete'),
        button('chip primary-chip', 'Done', () => {
          this.editor.commitSelection();
          this.refreshChrome();
        }, [icon('check', 17), el('span', { class: 'chip-text', text: 'Done' })]),
      );
      return;
    }

    if (this.mode === 'map' && store.tool === 'select') {
      this.optionsBar.append(
        el('span', { class: 'chip-label', text: 'Draw a box around painted tiles to pick them up' }),
      );
      return;
    }

    if (this.mode === 'character') {
      chips.push(
        el('span', { class: 'chip-label', text: this.studio.character ? 'Pencil draws · fingers pan' : 'No character yet' }),
        el('div', { class: 'divider vertical' }),
        this.chipToggle('flipH', 'Symmetry', this.studio.mirrorX, () => {
          this.studio.mirrorX = !this.studio.mirrorX;
          this.characterView.requestDraw();
          this.refreshPanels();
        }),
        this.chipToggle('layers', 'Onion skin', this.studio.onionSkin, () => {
          this.studio.onionSkin = !this.studio.onionSkin;
          this.characterView.requestDraw();
          this.refreshPanels();
        }),
      );
      this.optionsBar.append(...chips);
      return;
    }

    if (store.tool === 'eraser') {
      chips.push(el('span', { class: 'chip-label', text: 'Erase' }));
      for (const shape of ERASER_SHAPES) {
        const active = store.eraserShape === shape.id;
        chips.push(
          button(`chip${active ? ' active' : ''}`, shape.label, () => {
            store.eraserShape = shape.id;
            store.emit('ui');
          }, [icon(shape.icon, 17)]),
        );
      }
    } else {
      const stamp = store.stamp;
      const text =
        stamp.w === 0
          ? 'No tile selected'
          : stamp.w === 1 && stamp.h === 1
            ? '1 tile'
            : `${stamp.w} x ${stamp.h} tiles`;
      chips.push(el('span', { class: 'chip-label', text }));

      // Orientation belongs next to the canvas: you decide which way a tile
      // faces while placing it, not while browsing the sheet.
      if (stamp.w > 0) {
        chips.push(
          el('div', { class: 'divider vertical' }),
          this.transformChip('flipH', 'Flip across', () => flipStampH(store.stamp)),
          this.transformChip('flipV', 'Flip down', () => flipStampV(store.stamp)),
          this.transformChip('rotate', 'Rotate', () => rotateStampCW(store.stamp)),
        );
      }
    }

    // Only offer the scale preview once there is a character to show.
    if (this.studio.character) {
      const preview = store.characterPreview;
      chips.push(
        el('div', { class: 'divider vertical' }),
        this.chipToggle('pencilTip', 'Character', preview.enabled, () => {
          preview.enabled = !preview.enabled;
          if (!preview.enabled) preview.placing = false;
          this.refreshChrome();
          this.renderer.requestDraw();
        }),
      );
      if (preview.enabled) {
        chips.push(
          this.chipToggle('pan', 'Move it', preview.placing, () => {
            preview.placing = !preview.placing;
            this.refreshChrome();
            this.renderer.requestDraw();
          }),
        );
      }
      chips.push(
        button('chip play-chip', 'Walk around your map full screen', () => this.actions.playTest(), [
          icon('play', 17),
          el('span', { class: 'chip-text', text: 'Play' }),
        ]),
      );
    }

    chips.push(el('div', { class: 'divider vertical' }));
    chips.push(
      this.chipToggle('grid', 'Grid', store.settings.showGrid, () => {
        store.settings.showGrid = !store.settings.showGrid;
        store.emit('ui');
        store.emit('doc');
      }),
      this.chipToggle('pencilTip', 'Finger paints paths', store.settings.fingerDraws, () => {
        store.settings.fingerDraws = !store.settings.fingerDraws;
        store.emit('ui');
      }),
    );

    this.optionsBar.append(...chips);
  }

  /** A chip acting on the floating selection; refreshes the bar afterwards. */
  /**
   * Front-to-back order for the selected asset, labelled the way Canva does
   * it. A direction greys out when nothing overlaps on that side, because
   * moving past assets elsewhere on the map would change nothing you can see.
   */
  private orderGroup(locked = false): HTMLElement {
    const canBack = !locked && this.objects.canReorder(-1);
    const canFront = !locked && this.objects.canReorder(1);
    const chip = (name: IconName, text: string, label: string, enabled: boolean, run: () => void) => {
      const node = this.selectionChip(name, label, run, 'order-chip', text);
      node.disabled = !enabled;
      return node;
    };
    const group = el('div', { class: 'order-group', role: 'group' }, [
      chip('toBack', 'To back', 'Send to back, behind everything it overlaps', canBack, () => this.objects.sendToBack()),
      chip('sendBackward', 'Backward', 'Send backward one step', canBack, () => this.objects.sendBackward()),
      chip('bringForward', 'Forward', 'Bring forward one step', canFront, () => this.objects.bringForward()),
      chip('toFront', 'To front', 'Bring to front, in front of everything it overlaps', canFront, () =>
        this.objects.bringToFront(),
      ),
    ]);
    group.setAttribute('aria-label', 'Order');
    return group;
  }

  private selectionChip(name: IconName, label: string, run: () => void, variant = '', text = ''): HTMLButtonElement {
    return button(`chip ${variant}`.trim(), label, () => {
      run();
      this.refreshChrome();
      this.renderer.requestDraw();
    }, text ? [icon(name, 17), el('span', { class: 'chip-text', text })] : [icon(name, 17)]);
  }

  /**
   * Re-orients the brush. Rotating a block also swaps its width and height,
   * so the palette marquee is cleared: it no longer describes the brush.
   */
  private transformChip(name: IconName, label: string, transform: () => Stamp): HTMLElement {
    return button('chip', label, () => {
      const next = transform();
      const selection =
        next.w === this.store.stamp.w && next.h === this.store.stamp.h ? this.store.paletteSelection : null;
      this.store.setStamp(next, selection);
      this.renderer.requestDraw();
    }, [icon(name, 17)]);
  }

  private chipToggle(name: IconName, label: string, active: boolean, onPress: () => void): HTMLElement {
    const node = button(`chip${active ? ' active' : ''}`, label, onPress, [
      icon(name, 17),
      el('span', { class: 'chip-text', text: label }),
    ]);
    node.setAttribute('aria-pressed', String(active));
    return node;
  }

  private nudgeZoom(factor: number): void {
    if (this.mode === 'character') {
      const rect = this.characterView.canvas.getBoundingClientRect();
      this.characterView.zoom = Math.max(1, Math.min(64, this.characterView.zoom * factor));
      // Re-centre rather than anchoring, since the buttons have no cursor.
      const character = this.studio.character;
      if (character) {
        this.characterView.offsetX = Math.round((rect.width - character.w * this.characterView.zoom) / 2);
        this.characterView.offsetY = Math.round((rect.height - character.h * this.characterView.zoom) / 2);
      }
      this.characterView.requestDraw();
      return;
    }
    const camera = this.store.camera;
    zoomAt(camera, this.renderer.viewW / 2, this.renderer.viewH / 2, clampZoom(camera.zoom * factor));
    this.store.emit('view');
    this.renderer.requestDraw();
  }

  // --- Dock ----------------------------------------------------------------

  private buildTabs(): void {
    clear(this.tabBar);
    // The studio is a single panel, so it needs no tab strip.
    this.tabBar.style.display = this.mode === 'character' ? 'none' : '';
    if (this.mode === 'character') return;

    const tabs: { id: TabId; label: string; icon: IconName }[] = [
      { id: 'tiles', label: 'Assets', icon: 'tiles' },
      { id: 'layers', label: 'Layers', icon: 'layers' },
      { id: 'map', label: 'Map', icon: 'settings' },
    ];
    for (const tab of tabs) {
      const active = this.tab === tab.id;
      const node = button(`dock-tab${active ? ' active' : ''}`, tab.label, () => this.openTab(tab.id), [
        icon(tab.icon, 18),
        el('span', { text: tab.label }),
      ]);
      node.setAttribute('role', 'tab');
      node.setAttribute('aria-selected', String(active));
      this.tabBar.append(node);
    }
  }

  openTab(tab: TabId): void {
    this.tab = tab;
    if (this.mode !== 'map') this.setMode('map');
    if (!this.dockOpen) this.toggleDock(true);
    this.refreshPanelBody();
    this.buildTabs();
  }

  /** Fills the dock with whatever the current mode and tab call for. */
  private refreshPanelBody(): void {
    clear(this.dockBody);

    if (this.mode === 'character') {
      this.dockBody.append(this.characterPanel.element);
      this.characterPanel.refresh();
      return;
    }

    if (this.tab === 'tiles') {
      this.dockBody.append(this.palette.element);
      // The palette sizes itself to the panel, which only has a width once
      // it is in the document.
      requestAnimationFrame(() => this.palette.layout());
    } else if (this.tab === 'layers') {
      this.dockBody.append(this.layersPanel.element);
      this.layersPanel.refresh();
    } else {
      this.dockBody.append(this.mapPanel.element);
      this.mapPanel.refresh();
    }
  }

  toggleDock(force?: boolean): void {
    this.dockOpen = force ?? !this.dockOpen;
    this.dock.classList.toggle('collapsed', !this.dockOpen);
    // The canvas changed size, so the renderer needs new dimensions.
    requestAnimationFrame(() => {
      this.renderer.resize();
      if (this.tab === 'tiles') this.palette.layout();
    });
  }

  // --- Refresh -------------------------------------------------------------

  refreshChrome(): void {
    this.buildToolRail();
    this.buildTopActions();
    this.buildOptionsBar();
    this.title.textContent =
      this.mode === 'character' ? (this.studio.character?.name ?? 'Character studio') : this.store.doc.name;
    this.refreshStatus();
  }

  refreshPanels(): void {
    if (this.mode === 'character') {
      this.characterPanel.refresh();
      this.refreshChrome();
      return;
    }
    if (this.tab === 'layers') this.layersPanel.refresh();
    else if (this.tab === 'map') this.mapPanel.refresh();
    else this.palette.layout();
    this.refreshChrome();
  }

  refreshStatus(): void {
    clear(this.status);
    if (this.mode === 'character') {
      const character = this.studio.character;
      if (!character) return;
      this.status.append(
        el('span', { text: `${character.w} x ${character.h} px` }),
        el('span', { class: 'divider vertical' }),
        el('span', { text: `${character.tilesW} x ${character.tilesH} tiles` }),
      );
      return;
    }
    const { hover, camera, doc } = this.store;
    this.status.append(
      el('span', { text: hover ? `${hover.x}, ${hover.y}` : `${doc.width} x ${doc.height}` }),
      el('span', { class: 'divider vertical' }),
      el('span', { text: `${Math.round(camera.zoom * 100)}%` }),
    );
  }

  toast(message: string): void {
    this.toastNode.textContent = message;
    this.toastNode.classList.add('visible');
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastNode.classList.remove('visible'), 1700);
  }
}
