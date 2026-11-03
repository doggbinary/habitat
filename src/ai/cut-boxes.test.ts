import { describe, expect, it } from 'vitest';
import { parseCutReply } from './cut-boxes';

describe('parseCutReply', () => {
  it('reads pixel boxes, including ones wrapped in a code fence', () => {
    const raw = '```json\n{"pieces":[{"x":10,"y":20,"w":48,"h":64,"floor":false},{"x":80,"y":20,"w":16,"h":16,"floor":true}]}\n```';
    expect(parseCutReply(raw, 256, 256)).toEqual([
      { x: 10, y: 20, w: 48, h: 64, floor: false },
      { x: 80, y: 20, w: 16, h: 16, floor: true },
    ]);
  });

  it('scales 0 to 1 fractions up to the image', () => {
    const raw = '{"tiles":[{"x":0.25,"y":0.5,"w":0.5,"h":0.25,"kind":"floor"}]}';
    expect(parseCutReply(raw, 200, 100)).toEqual([{ x: 50, y: 50, w: 100, h: 25, floor: true }]);
  });

  it('scales a 0 to 1000 grid when the image is larger than that', () => {
    const raw = '{"boxes":[{"left":0,"top":500,"width":1000,"height":500}]}';
    expect(parseCutReply(raw, 2000, 1000)).toEqual([{ x: 0, y: 500, w: 2000, h: 500, floor: false }]);
  });

  it('drops a box around the whole sheet and anything that falls outside', () => {
    const raw = '{"pieces":[{"x":0,"y":0,"w":400,"h":400},{"x":10,"y":10,"w":32,"h":32},{"x":390,"y":390,"w":40,"h":40}]}';
    expect(parseCutReply(raw, 400, 400)).toEqual([{ x: 10, y: 10, w: 32, h: 32, floor: false }]);
  });

  it('rejects a reply with no boxes', () => {
    expect(() => parseCutReply('I could not see any tiles.', 100, 100)).toThrow(/no boxes/);
  });
});
