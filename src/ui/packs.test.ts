import { describe, expect, it } from 'vitest';
import { packNames, packOf, sameAsset } from './packs';

describe('asset packs', () => {
  it('groups numbered pages of one pack, and every floor page together', () => {
    expect(packOf('Nature Park 1')).toBe('Nature Park');
    expect(packOf('Floors 12')).toBe('Floors');
    expect(packOf('Paths 3')).toBe('Floors');
    expect(packOf('living room 3')).toBe('living room');
    expect(packNames(['Nature Park 2', 'Floors 2', 'Nature Park 1', 'Floors 1'])).toEqual(['Floors', 'Nature Park']);
  });

  it('tells one sticker from another by its sheet and its place on it', () => {
    const rect = { x: 0, y: 0, w: 16, h: 16 };
    expect(sameAsset({ tilesetId: 'a', rect }, { tilesetId: 'a', rect: { ...rect } })).toBe(true);
    expect(sameAsset({ tilesetId: 'a', rect }, { tilesetId: 'b', rect: { ...rect } })).toBe(false);
    expect(sameAsset({ tilesetId: 'a', rect }, { tilesetId: 'a', rect: { ...rect, x: 16 } })).toBe(false);
  });

  it('keeps every pack, so no sheet becomes unreachable', () => {
    const sheets = ['Floors 1', 'modern city 1', 'modern city 2', 'living room 1'];
    const names = packNames(sheets);
    expect(names).toEqual(['Floors', 'living room', 'modern city']);
    for (const sheet of sheets) expect(names).toContain(packOf(sheet));
  });
});
