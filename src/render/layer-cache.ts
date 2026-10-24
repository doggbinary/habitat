import type { Doc, TileLayer } from '../core/doc';
import { drawTile } from './tile-draw';

/**
 * Keeps a layer pre-rendered at native resolution (one tile = `doc.tileSize`
 * pixels) so a frame costs one scaled `drawImage` per layer instead of one per
 * visible tile. Edits mark a dirty rect in cell coordinates and only those
 * cells are repainted, which keeps a brush stroke cheap even on a large map.
 */
export class LayerCache {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private cols = 0;
  private rows = 0;
  private tileSize = 0;
  private dirty: { x0: number; y0: number; x1: number; y1: number } | null = null;

  constructor() {
    this.canvas = document.createElement('canvas');
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas is unavailable');
    this.ctx = ctx;
  }

  markAll(): void {
    this.dirty = { x0: 0, y0: 0, x1: this.cols - 1, y1: this.rows - 1 };
  }

  markCell(x: number, y: number): void {
    if (!this.dirty) {
      this.dirty = { x0: x, y0: y, x1: x, y1: y };
      return;
    }
    if (x < this.dirty.x0) this.dirty.x0 = x;
    if (y < this.dirty.y0) this.dirty.y0 = y;
    if (x > this.dirty.x1) this.dirty.x1 = x;
    if (y > this.dirty.y1) this.dirty.y1 = y;
  }

  markRect(x0: number, y0: number, x1: number, y1: number): void {
    this.markCell(Math.min(x0, x1), Math.min(y0, y1));
    this.markCell(Math.max(x0, x1), Math.max(y0, y1));
  }

  /** Repaints any dirty cells, resizing the backing canvas if the map changed. */
  sync(doc: Doc, layer: TileLayer): void {
    const needsResize =
      this.cols !== doc.width || this.rows !== doc.height || this.tileSize !== doc.tileSize;
    if (needsResize) {
      this.cols = doc.width;
      this.rows = doc.height;
      this.tileSize = doc.tileSize;
      this.canvas.width = doc.width * doc.tileSize;
      this.canvas.height = doc.height * doc.tileSize;
      this.markAll();
    }
    if (!this.dirty) return;

    const { x0, y0, x1, y1 } = this.dirty;
    this.dirty = null;

    const left = Math.max(0, x0);
    const top = Math.max(0, y0);
    const right = Math.min(doc.width - 1, x1);
    const bottom = Math.min(doc.height - 1, y1);
    if (right < left || bottom < top) return;

    const size = doc.tileSize;
    const ctx = this.ctx;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(left * size, top * size, (right - left + 1) * size, (bottom - top + 1) * size);

    for (let y = top; y <= bottom; y++) {
      const rowStart = y * doc.width;
      for (let x = left; x <= right; x++) {
        drawTile(ctx, doc, layer.data[rowStart + x], x * size, y * size, size);
      }
    }
  }
}
