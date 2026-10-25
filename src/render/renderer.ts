import { isMovableImage, type Doc, type ImageLayer, type MapObject, type TileLayer } from '../core/doc';
import { HANDLE_RADIUS, objectHandlePoint, objectScreenRect } from '../tools/objects';
import { drawObject } from './object-draw';
import { isEmptyStamp, stampTileAt } from '../core/stamp';
import type { Store } from '../core/store';
import { EMPTY } from '../core/tiles';
import { lineCells, normalizeRect } from '../tools/geometry';
import { handleScreenRect, imageScreenRect } from '../tools/image-transform';
import { LayerCache } from './layer-cache';
import { drawTile } from './tile-draw';

/**
 * Layers larger than this in either axis are drawn tile-by-tile instead of
 * through an offscreen cache. iOS refuses very large canvases and the memory
 * cost is not worth it for maps that big.
 */
const MAX_CACHE_DIM = 4096;

const COLOR_BACKDROP = '#0e0f13';
const COLOR_GRID = 'rgba(255, 255, 255, 0.07)';
const COLOR_GRID_MAJOR = 'rgba(255, 255, 255, 0.14)';
const COLOR_BORDER = 'rgba(126, 160, 255, 0.55)';
const COLOR_CURSOR = 'rgba(126, 160, 255, 0.95)';
const COLOR_ERASE = 'rgba(255, 110, 110, 0.95)';
const COLOR_IMAGE = 'rgba(126, 231, 184, 0.95)';
const COLOR_SELECT = 'rgba(255, 214, 102, 0.95)';

/** A ready-to-draw frame of the character being previewed on the map. */
export interface CharacterPreviewSource {
  canvas: HTMLCanvasElement;
  w: number;
  h: number;
}

export class Renderer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly caches = new Map<string, LayerCache>();
  private characterSource: (() => CharacterPreviewSource | null) | null = null;
  private frame = 0;
  private dpr = 1;
  /** Viewport size in CSS pixels. */
  viewW = 0;
  viewH = 0;

  constructor(
    readonly canvas: HTMLCanvasElement,
    private readonly store: Store,
  ) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('2D canvas is unavailable');
    this.ctx = ctx;
  }

  private cacheFor(layer: TileLayer): LayerCache {
    let cache = this.caches.get(layer.id);
    if (!cache) {
      cache = new LayerCache();
      this.caches.set(layer.id, cache);
    }
    return cache;
  }

  /** Call when a single cell of a layer changed. */
  markCell(layerId: string, x: number, y: number): void {
    this.caches.get(layerId)?.markCell(x, y);
  }

  markRect(layerId: string, x0: number, y0: number, x1: number, y1: number): void {
    this.caches.get(layerId)?.markRect(x0, y0, x1, y1);
  }

  /** Call after undo, layer changes, resize, or a tileset swap. */
  invalidateAll(): void {
    for (const cache of this.caches.values()) cache.markAll();
    this.pruneCaches();
  }

  private pruneCaches(): void {
    const live = new Set(this.store.doc.layers.map((l) => l.id));
    for (const id of [...this.caches.keys()]) {
      if (!live.has(id)) this.caches.delete(id);
    }
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    // Cap DPR at 2: a 3x buffer on a large iPad canvas costs fill rate without
    // any visible gain for pixel art.
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    this.viewW = rect.width;
    this.viewH = rect.height;
    this.dpr = dpr;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.draw();
  }

  /** Coalesces repaint requests into one per animation frame. */
  requestDraw(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  draw(): void {
    const { ctx, store } = this;
    const { doc, camera } = store;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = COLOR_BACKDROP;
    ctx.fillRect(0, 0, this.viewW, this.viewH);

    const mapW = doc.width * doc.tileSize;
    const mapH = doc.height * doc.tileSize;
    const zoom = camera.zoom;

    // Map surface.
    const originX = (0 - camera.x) * zoom;
    const originY = (0 - camera.y) * zoom;
    ctx.fillStyle = doc.background;
    ctx.fillRect(originX, originY, mapW * zoom, mapH * zoom);

    // Minification reads better with smoothing; magnified pixel art must not
    // be interpolated or it turns to mush.
    ctx.imageSmoothingEnabled = zoom < 1;

    this.drawLayers(doc, originX, originY, zoom);

    ctx.imageSmoothingEnabled = false;

    if (store.settings.showGrid) this.drawGrid(doc, originX, originY, zoom);

    ctx.strokeStyle = COLOR_BORDER;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(originX - 0.5, originY - 0.5, mapW * zoom + 1, mapH * zoom + 1);

    this.drawCharacterPreview(doc, originX, originY, zoom);
    this.drawHeldBlock(doc, originX, originY, zoom);
    this.drawDragPreview(doc, originX, originY, zoom);
    this.drawObjectSelection();
    this.drawAlignLines();

    // A selected reference image takes over the canvas interaction, so show
    // its handles instead of a brush cursor that would not do anything.
    const active = doc.layers[doc.activeLayer];
    if (isMovableImage(active)) this.drawImageHandles(active);
    else this.drawCursor(doc, originX, originY, zoom);
  }

  /**
   * Supplies the current character frame for the on-map scale preview. The
   * renderer stays ignorant of the studio; it just asks for a picture.
   */
  setCharacterSource(source: (() => CharacterPreviewSource | null) | null): void {
    this.characterSource = source;
  }

  /**
   * Draws the character standing on its tile, feet on the bottom edge and
   * centred across its footprint. This is the whole point of the feature: to
   * see whether the sprite reads at the same scale as the tiles around it.
   */
  private drawCharacterPreview(doc: Doc, originX: number, originY: number, zoom: number): void {
    const preview = this.store.characterPreview;
    if (!preview.enabled || !this.characterSource) return;
    const source = this.characterSource();
    if (!source) return;

    const { ctx } = this;
    const cell = doc.tileSize * zoom;
    const tilesW = source.w / doc.tileSize;
    // Centre horizontally over the tile, and stand on its bottom edge.
    const x = originX + (preview.tx - (tilesW - 1) / 2) * cell;
    const y = originY + (preview.ty + 1) * cell - source.h * zoom;

    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(source.canvas, x, y, source.w * zoom, source.h * zoom);

    // Footprint marker, so it is obvious which tile it occupies.
    ctx.strokeStyle = preview.placing ? COLOR_IMAGE : 'rgba(126, 231, 184, 0.5)';
    ctx.lineWidth = preview.placing ? 2 : 1;
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(originX + preview.tx * cell, originY + preview.ty * cell, cell, cell);
    ctx.setLineDash([]);
  }

  private drawLayers(doc: Doc, originX: number, originY: number, zoom: number): void {
    const { ctx, store } = this;
    const cacheable = doc.width * doc.tileSize <= MAX_CACHE_DIM && doc.height * doc.tileSize <= MAX_CACHE_DIM;

    for (let i = 0; i < doc.layers.length; i++) {
      const layer = doc.layers[i];
      if (!layer.visible) continue;

      let alpha = layer.opacity;
      if (store.settings.highlightActiveLayer && i !== doc.activeLayer) alpha *= 0.3;
      if (alpha <= 0) continue;

      ctx.globalAlpha = alpha;
      if (layer.kind === 'image') {
        this.drawImageLayer(layer, originX, originY, zoom);
      } else if (layer.kind === 'objects') {
        // Objects move constantly while being arranged, so they are drawn
        // fresh each frame rather than baked into a cache that would need
        // rebuilding on every nudge.
        ctx.imageSmoothingEnabled = false;
        for (const obj of layer.objects) drawObject(ctx, doc, obj, originX, originY, zoom);
        ctx.imageSmoothingEnabled = zoom < 1;
      } else if (cacheable) {
        const cache = this.cacheFor(layer);
        cache.sync(doc, layer);
        ctx.drawImage(
          cache.canvas,
          originX,
          originY,
          cache.canvas.width * zoom,
          cache.canvas.height * zoom,
        );
      } else {
        this.drawLayerDirect(doc, layer, originX, originY, zoom);
      }
      ctx.globalAlpha = 1;
    }
  }

  private drawImageLayer(layer: ImageLayer, originX: number, originY: number, zoom: number): void {
    if (!layer.image) return;
    const { ctx } = this;
    // Reference art is usually a photo or a mockup rather than pixel art, so
    // it gets smoothing regardless of the zoom level.
    const previous = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(
      layer.image,
      originX + layer.x * zoom,
      originY + layer.y * zoom,
      layer.w * zoom,
      layer.h * zoom,
    );
    ctx.imageSmoothingEnabled = previous;
  }

  /** Pink Canva-style lines while an asset is lining up with another. */
  private drawAlignLines(): void {
    const lines = this.store.alignLines;
    if (!lines || !this.store.settings.alignGuides) return;
    const { ctx, store } = this;
    const { camera } = store;
    ctx.save();
    ctx.strokeStyle = '#ff4f9a';
    ctx.lineWidth = 1;
    for (const x of lines.vertical) {
      const sx = (x - camera.x) * camera.zoom;
      ctx.beginPath();
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, this.viewH);
      ctx.stroke();
    }
    for (const y of lines.horizontal) {
      const sy = (y - camera.y) * camera.zoom;
      ctx.beginPath();
      ctx.moveTo(0, sy);
      ctx.lineTo(this.viewW, sy);
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * Outline and resize grip for the selected asset. The grip is the one thing
   * a Pencil can resize with, since a Pencil cannot pinch.
   */
  private drawObjectSelection(): void {
    const group = this.store.selectedGroup;
    const ids = group.length > 0 ? group : this.store.selectedObject ? [this.store.selectedObject] : [];
    if (ids.length === 0) return;
    for (const sel of ids) {
      const layer = this.store.doc.layers.find((l) => l.id === sel.layerId);
      if (layer?.kind !== 'objects') continue;
      const obj = layer.objects.find((o) => o.id === sel.objectId);
      if (obj) this.strokeObject(obj);
    }
  }

  private strokeObject(obj: import('../core/doc').MapObject): void {
    const { ctx } = this;
    const r = objectScreenRect(this.store.camera, obj);

    ctx.save();
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 4;
    ctx.strokeRect(r.x - 1, r.y - 1, r.w + 2, r.h + 2);
    ctx.strokeStyle = obj.locked ? '#ffb020' : COLOR_SELECT;
    ctx.lineWidth = 2;
    ctx.setLineDash(obj.locked ? [] : [7, 5]);
    ctx.strokeRect(r.x - 1, r.y - 1, r.w + 2, r.h + 2);
    ctx.setLineDash([]);

    if (obj.locked) {
      ctx.restore();
      return;
    }

    const handle = objectHandlePoint(this.store.camera, obj);
    ctx.beginPath();
    ctx.arc(handle.x, handle.y, HANDLE_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = COLOR_SELECT;
    ctx.fill();
    ctx.strokeStyle = '#10131c';
    ctx.lineWidth = 2;
    ctx.stroke();
    // A diagonal arrow on the grip says "resize" without a label.
    ctx.beginPath();
    ctx.moveTo(handle.x - 4, handle.y - 4);
    ctx.lineTo(handle.x + 4, handle.y + 4);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Painted tiles picked up with the select tool. Drawn above every layer
   * with a soft shadow, so they read as held above the map, not part of it.
   */
  private drawHeldBlock(doc: Doc, originX: number, originY: number, zoom: number): void {
    const selection = this.store.selection;
    if (!selection) return;
    const { ctx } = this;
    const cell = doc.tileSize * zoom;

    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = 10 * Math.min(2, zoom);
    ctx.shadowOffsetY = 3 * Math.min(2, zoom);
    for (let y = 0; y < selection.h; y++) {
      for (let x = 0; x < selection.w; x++) {
        const tile = selection.tiles[y * selection.w + x];
        if (tile === EMPTY) continue;
        drawTile(ctx, doc, tile, originX + (selection.x + x) * cell, originY + (selection.y + y) * cell, cell);
      }
    }
    ctx.restore();

    const x = originX + selection.x * cell;
    const y = originY + selection.y * cell;
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 4;
    ctx.strokeRect(x, y, selection.w * cell, selection.h * cell);
    ctx.strokeStyle = COLOR_SELECT;
    ctx.lineWidth = 2;
    ctx.setLineDash([7, 5]);
    ctx.strokeRect(x, y, selection.w * cell, selection.h * cell);
    ctx.setLineDash([]);
  }

  /** The asset being dragged out of the library, shown where it would land. */
  private drawDragPreview(doc: Doc, originX: number, originY: number, zoom: number): void {
    const drag = this.store.drag;
    if (!drag?.world) return;
    const sheet = doc.tilesets.find((t) => t.id === drag.tilesetId);
    const scale = sheet && sheet.tileW > 0 ? doc.tileSize / sheet.tileW : 1;
    const preview: MapObject = {
      id: 'drag-preview',
      tilesetId: drag.tilesetId,
      rect: drag.rect,
      x: drag.world.x,
      y: drag.world.y,
      scale,
      rotation: 0,
      flipX: false,
      flipY: false,
      hueShift: 0,
      saturation: 1,
      brightness: 1,
    };
    const { ctx } = this;
    ctx.globalAlpha = 0.72;
    ctx.imageSmoothingEnabled = false;
    drawObject(ctx, doc, preview, originX, originY, zoom);
    ctx.globalAlpha = 1;
  }

  /** Dashed outline and corner grip for the selected reference image. */
  private drawImageHandles(layer: ImageLayer): void {
    const { ctx, store } = this;
    const rect = imageScreenRect(store.camera, layer);
    const handle = handleScreenRect(store.camera, layer);

    ctx.save();
    ctx.setLineDash([7, 5]);
    ctx.strokeStyle = COLOR_IMAGE;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
    ctx.setLineDash([]);

    ctx.fillStyle = COLOR_IMAGE;
    ctx.strokeStyle = '#10131c';
    ctx.lineWidth = 2;
    const radius = 7;
    const cx = handle.x + handle.w / 2;
    const cy = handle.y + handle.h / 2;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  /** Fallback path for maps too large to cache: draw only the visible cells. */
  private drawLayerDirect(doc: Doc, layer: TileLayer, originX: number, originY: number, zoom: number): void {
    const { ctx } = this;
    const cell = doc.tileSize * zoom;
    const x0 = Math.max(0, Math.floor(-originX / cell));
    const y0 = Math.max(0, Math.floor(-originY / cell));
    const x1 = Math.min(doc.width - 1, Math.ceil((this.viewW - originX) / cell));
    const y1 = Math.min(doc.height - 1, Math.ceil((this.viewH - originY) / cell));

    for (let y = y0; y <= y1; y++) {
      const row = y * doc.width;
      for (let x = x0; x <= x1; x++) {
        const tile = layer.data[row + x];
        if (tile === EMPTY) continue;
        drawTile(ctx, doc, tile, originX + x * cell, originY + y * cell, cell);
      }
    }
  }

  private drawGrid(doc: Doc, originX: number, originY: number, zoom: number): void {
    const { ctx } = this;
    const cell = doc.tileSize * zoom;
    // Below a few pixels per cell the grid is pure moire, so step it up to
    // every 4th or 16th line instead of hiding it entirely.
    let step = 1;
    while (cell * step < 6) step *= 4;
    if (cell * step < 3) return;

    const x0 = Math.max(0, Math.floor(-originX / cell));
    const y0 = Math.max(0, Math.floor(-originY / cell));
    const x1 = Math.min(doc.width, Math.ceil((this.viewW - originX) / cell));
    const y1 = Math.min(doc.height, Math.ceil((this.viewH - originY) / cell));

    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = Math.ceil(x0 / step) * step; x <= x1; x += step) {
      const px = Math.round(originX + x * cell) + 0.5;
      ctx.moveTo(px, Math.max(originY, 0));
      ctx.lineTo(px, Math.min(originY + doc.height * cell, this.viewH));
    }
    for (let y = Math.ceil(y0 / step) * step; y <= y1; y += step) {
      const py = Math.round(originY + y * cell) + 0.5;
      ctx.moveTo(Math.max(originX, 0), py);
      ctx.lineTo(Math.min(originX + doc.width * cell, this.viewW), py);
    }
    ctx.strokeStyle = step > 1 ? COLOR_GRID_MAJOR : COLOR_GRID;
    ctx.stroke();
  }

  /**
   * Ghost of what the current tool is about to do: a translucent stamp for the
   * painting tools, an outline for the destructive or sampling ones.
   */
  private drawCursor(doc: Doc, originX: number, originY: number, zoom: number): void {
    const { ctx, store } = this;
    const cell = doc.tileSize * zoom;
    const tool = store.tool;
    if (tool === 'pan') return;

    const preview = store.preview;
    const hover = store.hover;

    const erasing = tool === 'eraser';

    if (tool === 'select') {
      if (!preview) return;
      const r = normalizeRect(preview);
      ctx.strokeStyle = COLOR_SELECT;
      ctx.lineWidth = 2;
      ctx.setLineDash([7, 5]);
      ctx.strokeRect(originX + r.x0 * cell, originY + r.y0 * cell, (r.x1 - r.x0 + 1) * cell, (r.y1 - r.y0 + 1) * cell);
      ctx.setLineDash([]);
      return;
    }

    if (preview && (tool === 'rect' || tool === 'line')) {
      const r = normalizeRect(preview);
      if (!erasing) {
        ctx.globalAlpha = 0.6;
        if (tool === 'rect') {
          for (let y = r.y0; y <= r.y1; y++) {
            for (let x = r.x0; x <= r.x1; x++) {
              this.drawPreviewTile(doc, stampTileAt(store.stamp, x - r.x0, y - r.y0), x, y, originX, originY, cell);
            }
          }
        } else {
          for (const c of lineCells(preview.x0, preview.y0, preview.x1, preview.y1)) {
            this.drawStampAnchored(doc, c.x, c.y, originX, originY, cell);
          }
        }
        ctx.globalAlpha = 1;
      }

      ctx.strokeStyle = erasing ? COLOR_ERASE : COLOR_CURSOR;
      ctx.lineWidth = 2;
      ctx.strokeRect(
        originX + r.x0 * cell,
        originY + r.y0 * cell,
        (r.x1 - r.x0 + 1) * cell,
        (r.y1 - r.y0 + 1) * cell,
      );
      return;
    }

    if (!hover) return;

    if (tool === 'brush' || tool === 'fill') {
      ctx.globalAlpha = 0.55;
      this.drawStampAnchored(doc, hover.x, hover.y, originX, originY, cell);
      ctx.globalAlpha = 1;
    }

    const paints = tool === 'brush' || tool === 'rect' || tool === 'line';
    const w = paints ? Math.max(1, store.stamp.w) : 1;
    const h = paints ? Math.max(1, store.stamp.h) : 1;

    ctx.strokeStyle = erasing ? COLOR_ERASE : COLOR_CURSOR;
    ctx.lineWidth = 2;
    ctx.strokeRect(originX + hover.x * cell, originY + hover.y * cell, w * cell, h * cell);
  }

  /** Draws the whole stamp block with its top-left corner on a cell. */
  private drawStampAnchored(
    doc: Doc,
    cx: number,
    cy: number,
    originX: number,
    originY: number,
    cell: number,
  ): void {
    const stamp = this.store.stamp;
    if (isEmptyStamp(stamp)) return;
    for (let y = 0; y < stamp.h; y++) {
      for (let x = 0; x < stamp.w; x++) {
        this.drawPreviewTile(doc, stamp.tiles[y * stamp.w + x], cx + x, cy + y, originX, originY, cell);
      }
    }
  }

  private drawPreviewTile(
    doc: Doc,
    tile: number,
    gx: number,
    gy: number,
    originX: number,
    originY: number,
    cell: number,
  ): void {
    if (tile === EMPTY) return;
    if (gx < 0 || gy < 0 || gx >= doc.width || gy >= doc.height) return;
    drawTile(this.ctx, doc, tile, originX + gx * cell, originY + gy * cell, cell);
  }
}
