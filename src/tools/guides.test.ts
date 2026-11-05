import { describe, expect, it } from 'vitest';
import { resizeSnap, smartGuides, type GuideBox } from './guides';

const oven: GuideBox = { left: 0, top: 0, right: 64, bottom: 80 };
const fridge: GuideBox = { left: 68, top: 2, right: 120, bottom: 82 };

describe('smart guides', () => {
  it('snaps a fridge so its edge touches the oven', () => {
    const guide = smartGuides(fridge, [oven], 320, 320, true);
    expect(guide.dx).toBe(-4);
    expect(fridge.left + guide.dx).toBe(oven.right);
    expect(guide.vertical).toEqual([64]);
  });

  it('shows the pixel gap and does not move when snapping is off', () => {
    const guide = smartGuides(fridge, [oven], 320, 320, false);
    expect(guide.dx).toBe(0);
    expect(guide.vertical).toEqual([64]);
    expect(guide.labels.some((label) => label.text === '4')).toBe(true);
  });

  it('snaps a resized edge onto the neighbour and keeps the proportions', () => {
    const box: GuideBox = { left: 30, top: 0, right: 60, bottom: 40 };
    const snapped = resizeSnap(box, [oven], 320, 320);
    expect(snapped).not.toBeNull();
    expect(snapped!.width).toBe(34);
    expect(snapped!.height).toBeCloseTo(40 * (34 / 30));
  });
});
