import { describe, expect, it } from 'vitest';
import { snapAlign, type AlignBox } from './align';

const other: AlignBox = { left: 0, right: 40, cx: 20, top: 0, bottom: 20, cy: 10 };

describe('alignment guides', () => {
  it('snaps a centre onto another asset and reports that line', () => {
    const snapped = snapAlign(20, 10, 22, 100, [other], 6);
    expect(snapped.x).toBe(20);
    expect(snapped.y).toBe(100);
    expect(snapped.vertical).toContain(20);
    expect(snapped.horizontal).toEqual([]);
  });

  it('snaps an edge to an edge', () => {
    const snapped = snapAlign(20, 10, 48, 40, [other], 6);
    expect(snapped.x).toBe(50);
    expect(snapped.vertical).toContain(40);
  });

  it('leaves a distant asset where it is', () => {
    const snapped = snapAlign(20, 10, 200, 200, [other], 6);
    expect(snapped).toMatchObject({ x: 200, y: 200, vertical: [], horizontal: [] });
  });

  it('lines up horizontally and vertically at the same time', () => {
    const snapped = snapAlign(20, 10, 22, 12, [other], 6);
    expect(snapped.x).toBe(20);
    expect(snapped.y).toBe(10);
    expect(snapped.vertical.length).toBeGreaterThan(0);
    expect(snapped.horizontal.length).toBeGreaterThan(0);
  });
});
