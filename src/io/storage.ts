import { isNative } from './native';
import type { SerializedProject } from './project';

/**
 * Autosave lives in IndexedDB rather than localStorage: a project with a
 * couple of embedded tilesets runs to several megabytes, well past the
 * localStorage quota Safari enforces.
 *
 * In the iPad app everything is also a file in the app's Library folder.
 * iOS may clear a web view's storage when space runs low, but never that
 * folder, and it is backed up with the device. It is not shown in the Files
 * app: taking a file out of the app is what Export is for.
 *
 * Each saved thing has a key. The map from before there could be several
 * keeps the key `current` and its old file, so nothing has to be copied.
 */

const CURRENT_KEY = 'current';

function filePath(key: string): string {
  return key === CURRENT_KEY ? 'Projects/current.pfproj' : `Projects/${key}.json`;
}

async function writeFile(key: string, value: unknown): Promise<void> {
  const { Directory, Encoding, Filesystem } = await import('@capacitor/filesystem');
  const path = filePath(key);
  const temp = `${path}.tmp`;
  const options = { directory: Directory.Library, encoding: Encoding.UTF8 };
  // Written aside first, so a crash mid-save leaves the last good copy whole.
  await Filesystem.writeFile({ ...options, path: temp, data: JSON.stringify(value), recursive: true });
  await Filesystem.deleteFile({ directory: Directory.Library, path }).catch(() => {});
  await Filesystem.rename({ from: temp, to: path, directory: Directory.Library, toDirectory: Directory.Library });
}

async function readFile<T>(key: string): Promise<T | null> {
  const { Directory, Encoding, Filesystem } = await import('@capacitor/filesystem');
  const path = filePath(key);
  // The finished copy first; the one written aside if a save was cut short.
  for (const candidate of [path, `${path}.tmp`]) {
    try {
      const file = await Filesystem.readFile({ path: candidate, directory: Directory.Library, encoding: Encoding.UTF8 });
      return JSON.parse(String(file.data)) as T;
    } catch {
      /* missing or unreadable; try the next */
    }
  }
  return null;
}

async function deleteFile(key: string): Promise<void> {
  const { Directory, Filesystem } = await import('@capacitor/filesystem');
  const path = filePath(key);
  for (const candidate of [path, `${path}.tmp`]) {
    await Filesystem.deleteFile({ directory: Directory.Library, path: candidate }).catch(() => {});
  }
}

// From before the app was called Habitat. Renaming it would lose every saved map.
const DB_NAME = 'pixel-fusion';
const DB_VERSION = 1;
const STORE = 'projects';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB unavailable'));
  });
  return dbPromise;
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = run(tx.objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

export async function saveValue(key: string, value: unknown): Promise<void> {
  if (isNative()) {
    await writeFile(key, value);
    // The web view copy is a spare; the file is the one that counts.
    await withStore('readwrite', (store) => store.put(value, key)).catch(() => {});
    return;
  }
  await withStore('readwrite', (store) => store.put(value, key));
}

export async function loadValue<T>(key: string): Promise<T | null> {
  if (isNative()) {
    const fromFile = await readFile<T>(key).catch(() => null);
    if (fromFile) return fromFile;
  }
  try {
    const result = await withStore<T | undefined>('readonly', (store) => store.get(key));
    return result ?? null;
  } catch {
    // Private browsing and storage pressure can both make this throw. An
    // empty editor is a better outcome than a blank screen.
    return null;
  }
}

export async function deleteValue(key: string): Promise<void> {
  if (isNative()) await deleteFile(key).catch(() => {});
  try {
    await withStore('readwrite', (store) => store.delete(key));
  } catch {
    /* nothing useful to do if the store is unavailable */
  }
}

/** Where a map is kept. The first map ever saved keeps its original place. */
export function mapKey(id: string): string {
  return id === CURRENT_KEY ? CURRENT_KEY : `map-${id}`;
}

export const FIRST_MAP_ID = CURRENT_KEY;

export function saveProject(project: SerializedProject, id: string = CURRENT_KEY): Promise<void> {
  return saveValue(mapKey(id), project);
}

export function loadProject(id: string = CURRENT_KEY): Promise<SerializedProject | null> {
  return loadValue<SerializedProject>(mapKey(id));
}

export function clearProject(id: string = CURRENT_KEY): Promise<void> {
  return deleteValue(mapKey(id));
}

/**
 * Asks the browser to keep this site's storage even when space runs low.
 * Safari otherwise may clear a site's saved data, the map with it.
 */
export async function keepStorage(): Promise<void> {
  try {
    if (!isNative() && navigator.storage?.persist && !(await navigator.storage.persisted())) {
      await navigator.storage.persist();
    }
  } catch {
    /* not offered by every browser; saving still works */
  }
}

/**
 * Coalesces autosave requests. Saving serialises the whole document, so it is
 * deliberately lazy and never runs in the middle of a stroke.
 */
export function createAutosave(
  save: () => Promise<void>,
  delay = 1200,
  /** Told when a save fails, such as when the browser blocks storage, so the user is not left thinking work is kept. */
  onError: (error: unknown) => void = () => {},
): { schedule: () => void; flush: () => Promise<void> } {
  let timer: number | undefined;
  let pending = false;

  const run = async () => {
    pending = false;
    try {
      await save();
    } catch (error) {
      // The in-memory document is unaffected; the user just has to know.
      onError(error);
    }
  };

  return {
    schedule() {
      pending = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = window.setTimeout(run, delay);
    },
    async flush() {
      if (timer !== undefined) clearTimeout(timer);
      if (pending) await run();
    },
  };
}
