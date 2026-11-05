import { describe, expect, it } from 'vitest';
import { applyShadeRamp, matchShift, shadeRampFromPixels, sharesMainHue, sharpenPixels } from './recolor';
import { rgbToHsv } from '../ui/color-wheel';

/** A row of grey pixels, each [value, alpha]. */
function row(...pixels: [number, number][]): Uint8ClampedArray {
  const data = new Uint8ClampedArray(pixels.length * 4);
  pixels.forEach(([v, a], i) => data.set([v, v, v, a], i * 4));
  return data;
}

describe('clarity', () => {
  it('pushes a pixel away from its neighbours, so edges between colours get crisper', () => {
    const data = row([100, 255], [150, 255], [100, 255]);
    sharpenPixels(data, 3, 1, 1);
    expect(data[4]).toBeGreaterThan(150);
    expect(data[0]).toBeLessThan(100);
  });

  it('leaves flat colour and see-through pixels alone, so outlines get no halo', () => {
    const flat = row([120, 255], [120, 255], [120, 255]);
    sharpenPixels(flat, 3, 1, 1);
    expect([...flat].filter((_, i) => i % 4 === 0)).toEqual([120, 120, 120]);

    const edge = row([0, 0], [80, 255], [80, 255]);
    sharpenPixels(edge, 3, 1, 1);
    expect(edge[4]).toBe(80);
  });

  it('does nothing at zero', () => {
    const data = row([10, 255], [200, 255]);
    sharpenPixels(data, 2, 1, 0);
    expect(data[0]).toBe(10);
    expect(data[4]).toBe(200);
  });
});

describe('matching a colour', () => {
  it('rotates the hue toward the other object and keeps a darker shade darker', () => {
    const shift = matchShift({ h: 30, s: 0.5, v: 0.8 }, { h: 200, s: 0.5, v: 0.8 });
    expect(shift.hueShift).toBe(170);
    expect(shift.saturation).toBe(1);
    expect(shift.brightness).toBe(1);
  });
});

/** One pixel, RGB plus alpha. */
function px(r: number, g: number, b: number, a = 255): number[] {
  return [r, g, b, a];
}

describe('shade ramps', () => {
  it('leaves grey metal and the black outline alone, and maps the colour by lightness', () => {
    // Dark blue, mid blue, light blue, a black outline, a grey knob.
    const data = new Uint8ClampedArray([
      ...px(10, 20, 80),
      ...px(40, 80, 180),
      ...px(150, 190, 240),
      ...px(8, 8, 10),
      ...px(170, 170, 172),
    ]);
    const green = new Uint8ClampedArray([
      ...px(10, 50, 20),
      ...px(40, 120, 50),
      ...px(160, 220, 170),
    ]);
    const ramp = shadeRampFromPixels(green, 3);
    expect(ramp.length).toBe(3);
    applyShadeRamp(data, ramp);

    const outline = [data[12], data[13], data[14]];
    const knob = [data[16], data[17], data[18]];
    expect(outline).toEqual([8, 8, 10]);
    expect(knob).toEqual([170, 170, 172]);

    const dark = rgbToHsv(data[0], data[1], data[2]);
    const mid = rgbToHsv(data[4], data[5], data[6]);
    const light = rgbToHsv(data[8], data[9], data[10]);
    expect(sharesMainHue(dark, 120)).toBe(true);
    expect(dark.v).toBeLessThan(mid.v);
    expect(mid.v).toBeLessThan(light.v);
    expect(light.v - dark.v).toBeGreaterThan(0.25);
  });
});
