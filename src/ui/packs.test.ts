import { describe, expect, it } from 'vitest';
import { packNames, packOf, sameAsset } from './packs';

describe('asset folders', () => {
  it('groups numbered pages of one pack, and every Paths page together', () => {
    expect(packOf('Nature Park 1')).toBe('Nature Park');
    expect(packOf('Paths 12')).toBe('Paths');
    expect(packOf('living room 3')).toBe('living room');
    expect(packNames(['Nature Park 2', 'Paths 2', 'Nature Park 1', 'Paths 1'])).toEqual([
      'Paths',
      'Nature Park',
    ]);
  });

  it('treats the same sticker as the same, wherever it was pinned from', () => {
    const rect = { x: 1, y: 2, w: 3, h: 4 };
    expect(sameAsset({ tilesetId: 'a', rect }, { tilesetId: 'a', rect: { ...rect } })).toBe(true);
    expect(sameAsset({ tilesetId: 'a', rect }, { tilesetId: 'b', rect })).toBe(false);
  });
});
