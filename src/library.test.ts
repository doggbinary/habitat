import { describe, expect, it } from 'vitest';
import { isLibrarySheet, isSampleMap, librarySheetName } from './library';

describe('object-sheet library', () => {
  it('keeps object pages and numbered furniture pages', () => {
    expect(isLibrarySheet(['Nature Park'], 'tile-B-01.png')).toBe(true);
    expect(isLibrarySheet(['living room'], '1.png')).toBe(true);
    expect(librarySheetName(['Nature Park'], 'tile-B-01.png')).toBe('Nature Park 1');
    expect(librarySheetName(['living room'], '1.png')).toBe('living room 1');
    expect(librarySheetName(['Autumn Forest', 'cafe'], 'tile-B-10.png')).toBe('Autumn Forest cafe 10');
  });

  it('leaves out ground grids, wall grids, and duplicate folders', () => {
    expect(isLibrarySheet(['Modern Suburb Neighborhood'], 'Tile_A2-1 (2).png')).toBe(false);
    expect(isLibrarySheet(['Modern Suburb Neighborhood'], 'Auto-tile-A4-Walls-1.png')).toBe(false);
    expect(isLibrarySheet(['office(1)'], 'tile-B-01.png')).toBe(false);
    expect(isLibrarySheet(['restaurant', 'restaurant(2)'], '1.png')).toBe(false);
  });

  it('recognises a finished scene, where one asset covers the page', () => {
    expect(isSampleMap(1000, 1000, [{ w: 900, h: 800 }])).toBe(true);
    expect(isSampleMap(1000, 1000, [{ w: 80, h: 40 }, { w: 30, h: 30 }])).toBe(false);
  });
});
