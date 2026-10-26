import { describe, expect, it } from 'vitest';
import { createCharacter } from '../character/model';
import {
  createMapIndex,
  freeFolderName,
  mergeCharacters,
  readCharacterLibrary,
  readMapIndex,
  removeFolder,
  renameFolder,
  serializeCharacterLibrary,
  type MapIndex,
} from './library';
import { zipBytes } from './zip';

describe('character library', () => {
  it('saves every character with its folder, and the folders', () => {
    const hero = createCharacter(16, 1, 2, 4, 'Hero');
    hero.folder = 'Town';
    const cat = createCharacter(16, 1, 1, 4, 'Cat');
    const file = JSON.parse(
      JSON.stringify(
        serializeCharacterLibrary({ characters: [hero, cat], folders: ['Town', 'Forest'], lastPlayedId: cat.id, lastSize: null }),
      ),
    );
    const back = readCharacterLibrary(file);
    expect(back.characters.map((c) => c.name)).toEqual(['Hero', 'Cat']);
    expect(back.characters[0].folder).toBe('Town');
    expect(back.folders).toEqual(['Town', 'Forest']);
    expect(back.lastPlayedId).toBe(cat.id);
  });

  it('takes in characters from a map once, never twice', () => {
    const hero = createCharacter(16, 1, 1, 4, 'Hero');
    const library = [hero];
    expect(mergeCharacters(library, [hero, createCharacter(16, 1, 1, 4, 'New')])).toBe(1);
    expect(library.map((c) => c.name)).toEqual(['Hero', 'New']);
  });
});

describe('folders', () => {
  it('never makes two folders with the same name', () => {
    expect(freeFolderName(['Town', 'Town 2'], 'Town')).toBe('Town 3');
    expect(freeFolderName([], '  ')).toBe('New folder');
  });

  it('renames a folder and everything in it follows', () => {
    const folders = ['Town', 'Forest'];
    const items: { folder?: string }[] = [{ folder: 'Town' }, { folder: 'Forest' }, {}];
    expect(renameFolder(folders, items, 'Town', 'Village')).toBe('Village');
    expect(folders).toEqual(['Village', 'Forest']);
    expect(items[0].folder).toBe('Village');
  });

  it('removing a folder keeps what was in it', () => {
    const folders = ['Town'];
    const items: { folder?: string }[] = [{ folder: 'Town' }];
    removeFolder(folders, items, 'Town');
    expect(folders).toEqual([]);
    expect(items).toEqual([{}]);
  });
});

describe('map list', () => {
  it('starts with the map there already was', () => {
    const index = createMapIndex({ id: 'current', name: 'Spring Creek', updated: 1 });
    expect(index.openId).toBe('current');
    expect(index.maps).toHaveLength(1);
  });

  it('repairs a damaged list: drops broken entries and opens one that exists', () => {
    const raw = {
      format: 'habitat-maps',
      version: 1,
      maps: [{ id: 'a', name: 'A', updated: 1, folder: 'Island' }, { name: 'no id' }, null],
      folders: [],
      openId: 'gone',
    } as unknown as MapIndex;
    const index = readMapIndex(raw);
    expect(index.maps.map((m) => m.id)).toEqual(['a']);
    expect(index.openId).toBe('a');
    // A folder only named on a map still shows up.
    expect(index.folders).toEqual(['Island']);
  });
});

describe('zip', () => {
  it('writes files a zip reader can find, with correct checksums', () => {
    const data = new TextEncoder().encode('hello');
    const bytes = zipBytes([{ name: 'town/a.txt', data }]);
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    // CRC-32 of "hello".
    expect(view.getUint32(14, true)).toBe(0x3610a686);
    const end = bytes.length - 22;
    expect(view.getUint32(end, true)).toBe(0x06054b50);
    expect(view.getUint16(end + 10, true)).toBe(1);
    const name = new TextDecoder().decode(bytes.subarray(30, 30 + 'town/a.txt'.length));
    expect(name).toBe('town/a.txt');
  });
});
