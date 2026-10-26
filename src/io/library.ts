import type { Character } from '../character/model';
import { deserializeCharacter, serializeCharacter, type SerializedCharacter } from './project';

/**
 * The things kept beside the open map: every character, shared by all maps,
 * and the list of maps with their folders. Both are small next to a map, so
 * each is one saved value.
 */

export const CHARACTERS_KEY = 'characters';
export const MAPS_KEY = 'maps';

export interface CharacterLibraryFile {
  format: 'habitat-characters';
  version: 1;
  characters: SerializedCharacter[];
  folders: string[];
  lastPlayedId?: string;
  lastSize?: { tilesW: number; tilesH: number };
}

export interface CharacterLibrary {
  characters: Character[];
  folders: string[];
  lastPlayedId: string | null;
  lastSize: { tilesW: number; tilesH: number } | null;
}

export function serializeCharacterLibrary(library: CharacterLibrary): CharacterLibraryFile {
  return {
    format: 'habitat-characters',
    version: 1,
    characters: library.characters.map(serializeCharacter),
    folders: [...library.folders],
    ...(library.lastPlayedId ? { lastPlayedId: library.lastPlayedId } : {}),
    ...(library.lastSize ? { lastSize: { ...library.lastSize } } : {}),
  };
}

export function isCharacterLibrary(value: unknown): value is CharacterLibraryFile {
  return !!value && typeof value === 'object' && (value as CharacterLibraryFile).format === 'habitat-characters';
}

export function readCharacterLibrary(file: CharacterLibraryFile): CharacterLibrary {
  const characters: Character[] = [];
  for (const raw of Array.isArray(file.characters) ? file.characters : []) {
    try {
      characters.push(deserializeCharacter(raw));
    } catch {
      /* one damaged character must not cost the rest */
    }
  }
  const folders = uniqueNames([
    ...(Array.isArray(file.folders) ? file.folders.filter((f): f is string => typeof f === 'string') : []),
    ...characters.flatMap((c) => (c.folder ? [c.folder] : [])),
  ]);
  const size = file.lastSize;
  return {
    characters,
    folders,
    lastPlayedId: typeof file.lastPlayedId === 'string' ? file.lastPlayedId : null,
    lastSize: size && Number.isFinite(size.tilesW) && Number.isFinite(size.tilesH) ? { ...size } : null,
  };
}

/** Adds characters not already in the library, by id. Returns how many were new. */
export function mergeCharacters(into: Character[], incoming: Character[]): number {
  const have = new Set(into.map((c) => c.id));
  let added = 0;
  for (const character of incoming) {
    if (have.has(character.id)) continue;
    into.push(character);
    have.add(character.id);
    added += 1;
  }
  return added;
}

// --- Folders ---------------------------------------------------------------

function uniqueNames(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    const clean = name.trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

/** A folder name not already taken: "Town", then "Town 2". */
export function freeFolderName(folders: string[], wanted: string): string {
  const base = wanted.trim() || 'New folder';
  if (!folders.includes(base)) return base;
  let n = 2;
  while (folders.includes(`${base} ${n}`)) n += 1;
  return `${base} ${n}`;
}

/** Renames a folder and moves everything in it along. Returns the name it ended up with. */
export function renameFolder(folders: string[], items: { folder?: string }[], from: string, to: string): string {
  const index = folders.indexOf(from);
  if (index < 0) return from;
  const others = folders.filter((f) => f !== from);
  const next = freeFolderName(others, to);
  folders[index] = next;
  for (const item of items) if (item.folder === from) item.folder = next;
  return next;
}

/** Takes a folder away; what was in it stays, outside any folder. */
export function removeFolder(folders: string[], items: { folder?: string }[], name: string): void {
  const index = folders.indexOf(name);
  if (index >= 0) folders.splice(index, 1);
  for (const item of items) if (item.folder === name) delete item.folder;
}

// --- Maps ------------------------------------------------------------------

export interface MapEntry {
  id: string;
  name: string;
  folder?: string;
  /** When it was last saved, in milliseconds. */
  updated: number;
  /** A small picture of the map, as a data URL. */
  thumb?: string;
}

export interface MapIndex {
  format: 'habitat-maps';
  version: 1;
  maps: MapEntry[];
  folders: string[];
  /** The map open when the app was last used. */
  openId: string;
}

export function isMapIndex(value: unknown): value is MapIndex {
  return !!value && typeof value === 'object' && (value as MapIndex).format === 'habitat-maps' && Array.isArray((value as MapIndex).maps);
}

export function createMapIndex(first: MapEntry): MapIndex {
  return { format: 'habitat-maps', version: 1, maps: [first], folders: [], openId: first.id };
}

/** Repairs a saved index: drops broken entries and makes sure the open map is listed. */
export function readMapIndex(raw: MapIndex): MapIndex {
  const maps = raw.maps.filter(
    (m): m is MapEntry => !!m && typeof m.id === 'string' && !!m.id && typeof m.name === 'string',
  );
  const folders = uniqueNames([
    ...(Array.isArray(raw.folders) ? raw.folders.filter((f): f is string => typeof f === 'string') : []),
    ...maps.flatMap((m) => (m.folder ? [m.folder] : [])),
  ]);
  const openId = maps.some((m) => m.id === raw.openId) ? raw.openId : (maps[0]?.id ?? '');
  return { format: 'habitat-maps', version: 1, maps, folders, openId };
}
