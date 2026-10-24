import { describe, expect, it } from 'vitest';
import { createDoc, type TileLayer } from './doc';
import { History, Stroke, snapshot } from './history';
import { EMPTY, pack } from './tiles';

const layer0 = (doc: ReturnType<typeof createDoc>) => doc.layers[0] as TileLayer;

describe('Stroke', () => {
  it('keeps the first before and the last after for a repainted cell', () => {
    const stroke = new Stroke('L', 'Paint');
    stroke.record(5, EMPTY, pack(0, 1));
    stroke.record(5, pack(0, 1), pack(0, 2));
    const entry = stroke.toEntry()!;
    expect([...entry.indices]).toEqual([5]);
    expect(entry.before[0]).toBe(EMPTY);
    expect(entry.after[0]).toBe(pack(0, 2));
  });

  it('drops cells that ended where they started', () => {
    const stroke = new Stroke('L', 'Paint');
    stroke.record(1, EMPTY, pack(0, 1));
    stroke.record(1, pack(0, 1), EMPTY);
    expect(stroke.toEntry()).toBeNull();
  });
});

describe('History', () => {
  function setup() {
    const doc = createDoc(4, 4, 16);
    const history = new History(() => doc);
    return { doc, history, layer: layer0(doc) };
  }

  it('undoes and redoes a painted stroke', () => {
    const { history, layer } = setup();
    const stroke = new Stroke(layer.id, 'Paint');
    stroke.record(0, EMPTY, pack(0, 3));
    layer.data[0] = pack(0, 3);
    history.commitStroke(stroke);

    history.undo();
    expect(layer.data[0]).toBe(EMPTY);
    history.redo();
    expect(layer.data[0]).toBe(pack(0, 3));
  });

  it('forgets redo once something new is done', () => {
    const { history, layer } = setup();
    const a = new Stroke(layer.id, 'A');
    a.record(0, EMPTY, pack(0, 1));
    history.commitStroke(a);
    history.undo();
    expect(history.canRedo).toBe(true);

    const b = new Stroke(layer.id, 'B');
    b.record(1, EMPTY, pack(0, 2));
    history.commitStroke(b);
    expect(history.canRedo).toBe(false);
  });

  it('records a structural change as one undoable step', () => {
    const { doc, history } = setup();
    history.transact('Rename', () => {
      doc.name = 'Changed';
    });
    history.undo();
    expect(doc.name).toBe('Untitled map');
    history.redo();
    expect(doc.name).toBe('Changed');
  });

  it('snapshots deeply enough that later edits cannot leak into history', () => {
    const { doc, layer } = setup();
    const snap = snapshot(doc);
    layer.data[0] = pack(0, 9);
    expect((snap.layers[0] as TileLayer).data[0]).toBe(EMPTY);
  });

  it('survives undoing a stroke whose layer has since been deleted', () => {
    const { doc, history, layer } = setup();
    const stroke = new Stroke(layer.id, 'Paint');
    stroke.record(0, EMPTY, pack(0, 1));
    history.commitStroke(stroke);
    doc.layers = [];
    expect(() => history.undo()).not.toThrow();
  });
});
