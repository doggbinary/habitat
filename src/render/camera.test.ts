import { describe, expect, it } from 'vitest';
import { crispLayerBlit, isCrispZoom, snapCanvasSize, snapZoom, stepZoom } from './camera';

describe('sharp zoom', () => {
  it('knows when art pixels land on whole screen pixels', () => {
    expect(isCrispZoom(1, 2)).toBe(true);
    expect(isCrispZoom(0.5, 2)).toBe(true);
    expect(isCrispZoom(1.5, 2)).toBe(true);
    expect(isCrispZoom(1.66, 2)).toBe(false);
    expect(isCrispZoom(0.3, 2)).toBe(false);
  });

  it('settles a pinch onto the nearest sharp zoom', () => {
    expect(snapZoom(1.66, 2)).toBe(1.5);
    expect(snapZoom(0.47, 2)).toBe(0.5);
    expect(snapZoom(2.3, 1)).toBe(2);
    // Zoomed far out it is left alone and smoothed.
    expect(snapZoom(0.2, 2)).toBe(0.2);
  });

  it('copies a sharp layer at a whole number of device pixels', () => {
    expect(crispLayerBlit(10.2, -3.4, 1.5, 2)).toEqual({ dx: 20, dy: -7, scale: 3 });
    expect(crispLayerBlit(0, 0, 4, 2).scale).toBe(8);
  });

  it('sizes the canvas so the browser does not resample it', () => {
    const snapped = snapCanvasSize(390.4, 200.2, 2);
    expect(snapped.bufW / snapped.viewW).toBe(2);
    expect(snapped.bufH / snapped.viewH).toBe(2);
  });

  it('steps the zoom buttons from one sharp zoom to the next', () => {
    expect(stepZoom(1, 1, 2)).toBe(1.5);
    expect(stepZoom(1.5, -1, 2)).toBe(1);
    expect(isCrispZoom(stepZoom(4, 1, 2), 2)).toBe(true);
    expect(isCrispZoom(stepZoom(4, -1, 2), 2)).toBe(true);
    expect(stepZoom(0.5, -1, 2)).toBeLessThan(0.5);
  });
});
