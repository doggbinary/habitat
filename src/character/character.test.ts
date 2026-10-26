import { describe, expect, it } from 'vitest';
import { guessLayout, sheetGeometry } from './import';
import {
  DIRECTIONS,
  applyTemplate,
  createCharacter,
  frameIndex,
  getPixel,
  referencePlacement,
  resizeCharacter,
  type Character,
  type Frame,
} from './model';
import { Studio } from './studio';

const opaqueCount = (frame: Frame) => {
  let n = 0;
  for (let i = 3; i < frame.data.length; i += 4) if (frame.data[i] > 0) n += 1;
  return n;
};

/** Lowest row holding any opaque pixel, i.e. where the feet are. */
function footRow(c: Character, frame: Frame): number {
  for (let y = c.h - 1; y >= 0; y--) {
    for (let x = 0; x < c.w; x++) if (getPixel(frame, c.w, x, y)[3] > 0) return y;
  }
  return -1;
}

describe('the starter template', () => {
  it('draws a body in every frame of every direction', () => {
    const c = createCharacter(16);
    applyTemplate(c);
    for (const frame of c.frames) expect(opaqueCount(frame)).toBeGreaterThan(40);
  });

  it('gives the walk steps a different pose from standing', () => {
    const c = createCharacter(16);
    applyTemplate(c);
    const stand = c.frames[frameIndex(0, 0, c.frameCount)];
    const step = c.frames[frameIndex(0, 1, c.frameCount)];
    expect([...step.data]).not.toEqual([...stand.data]);
  });

  it('works at other sprite sizes, not just 32px', () => {
    for (const tile of [8, 16, 32]) {
      const c = createCharacter(tile);
      expect(() => applyTemplate(c)).not.toThrow();
      expect(opaqueCount(c.frames[0])).toBeGreaterThan(0);
    }
  });
});

describe('the traced picture', () => {
  it('fits by default, then grows from its bottom centre and moves by its nudge', () => {
    // A square picture in a 32 x 64 sprite fits at 32 x 32, standing on the bottom.
    expect(referencePlacement(100, 100, 32, 64)).toEqual({ x: 0, y: 32, w: 32, h: 32 });
    expect(referencePlacement(100, 100, 32, 64, { scale: 2 })).toEqual({ x: -16, y: 0, w: 64, h: 64 });
    expect(referencePlacement(100, 100, 32, 64, { scale: 0.5, x: 3, y: -2 })).toEqual({ x: 11, y: 46, w: 16, h: 16 });
  });
});

describe('resizing a character', () => {
  it('keeps the feet on the bottom edge and the body centred', () => {
    const c = createCharacter(16, 2, 2);
    applyTemplate(c);
    const gapBefore = c.h - 1 - footRow(c, c.frames[0]);

    resizeCharacter(c, 16, 3, 3);

    expect(c.w).toBe(48);
    expect(c.h).toBe(48);
    expect(c.frames[0].data.length).toBe(48 * 48 * 4);
    // Feet stay the same distance from the new bottom edge, so the character
    // still stands on its tile rather than floating above it.
    expect(c.h - 1 - footRow(c, c.frames[0])).toBe(gapBefore);
  });
});

describe('drawing in the studio', () => {
  function studio(): Studio {
    const s = new Studio();
    s.addCharacter(16, 2, 2, false);
    s.color = '#ff0000';
    return s;
  }

  it('paints and erases a square the size of the brush, each tool keeping its own size', () => {
    const s = studio();
    s.pencilSize = 3;
    s.paint(10, 10);
    expect(opaqueCount(s.currentFrame!)).toBe(9);
    expect(getPixel(s.currentFrame!, 32, 9, 9)[3]).toBe(255);
    expect(getPixel(s.currentFrame!, 32, 11, 11)[3]).toBe(255);

    s.tool = 'eraser';
    expect(s.brushSize).toBe(3);
    s.brushSize = 2;
    s.paint(10, 10);
    // A 2 px eraser at (10, 10) clears 10..11 on both axes.
    expect(opaqueCount(s.currentFrame!)).toBe(5);
    s.tool = 'pencil';
    expect(s.brushSize).toBe(3);
  });

  it('a big brush at the edge paints only what is on the canvas', () => {
    const s = studio();
    s.pencilSize = 4;
    s.paint(0, 0);
    expect(opaqueCount(s.currentFrame!)).toBe(9);
  });

  it('symmetry paints the mirrored pixel too', () => {
    const s = studio();
    s.mirrorX = true;
    s.paint(3, 5);
    const frame = s.currentFrame!;
    expect(getPixel(frame, 32, 3, 5)).toEqual([255, 0, 0, 255]);
    expect(getPixel(frame, 32, 28, 5)).toEqual([255, 0, 0, 255]);
  });

  it('a stroke is undone in one step', () => {
    const s = studio();
    s.beginStroke();
    s.paintLine(0, 0, 10, 0);
    s.endStroke();
    expect(opaqueCount(s.currentFrame!)).toBe(11);
    s.undo();
    expect(opaqueCount(s.currentFrame!)).toBe(0);
    s.redo();
    expect(opaqueCount(s.currentFrame!)).toBe(11);
  });

  it('a stroke that changed nothing adds no undo step', () => {
    const s = studio();
    s.tool = 'eraser';
    s.beginStroke();
    s.paint(1, 1);
    s.endStroke();
    expect(s.canUndo).toBe(false);
  });

  it('fill stays inside the outline it starts in', () => {
    const s = studio();
    // A box outline from (2,2) to (6,6).
    s.color = '#000000';
    s.beginStroke();
    s.paintLine(2, 2, 6, 2);
    s.paintLine(6, 2, 6, 6);
    s.paintLine(6, 6, 2, 6);
    s.paintLine(2, 6, 2, 2);
    s.endStroke();

    s.color = '#00ff00';
    s.tool = 'fill';
    s.beginStroke();
    s.paint(4, 4);
    s.endStroke();

    const frame = s.currentFrame!;
    expect(getPixel(frame, 32, 4, 4)).toEqual([0, 255, 0, 255]);
    expect(getPixel(frame, 32, 10, 10)[3]).toBe(0);
  });

  it('picking a colour hands back the pencil', () => {
    const s = studio();
    s.paint(0, 0);
    s.color = '#123456';
    s.tool = 'picker';
    s.paint(0, 0);
    expect(s.color).toBe('#ff0000');
    expect(s.tool).toBe('pencil');
  });

  it('mirroring to the other side flips the pose horizontally', () => {
    const s = studio();
    s.select(DIRECTIONS.indexOf('left'), 0);
    s.paint(1, 3);
    s.mirrorToOppositeDirection();
    const c = s.character!;
    const right = c.frames[frameIndex(DIRECTIONS.indexOf('right'), 0, c.frameCount)];
    expect(getPixel(right, 32, 30, 3)).toEqual([255, 0, 0, 255]);
  });
});

describe('importing a sprite sheet', () => {
  it('counts whole cells, allowing for margin and spacing', () => {
    expect(sheetGeometry(128, 128, { frameW: 32, frameH: 32, margin: 0, spacing: 0 })).toEqual({ cols: 4, rows: 4 });
    // 2px margin, 1px gaps: 2 + 3x32 + 2x1 = 100, leaving no room for a fourth.
    expect(sheetGeometry(103, 103, { frameW: 32, frameH: 32, margin: 2, spacing: 1 })).toEqual({ cols: 3, rows: 3 });
  });

  it('guesses four rows of cells for a typical walk sheet', () => {
    const guess = guessLayout(128, 192);
    expect(guess.frameH).toBe(48);
    expect(128 % guess.columns).toBe(0);
  });
});
