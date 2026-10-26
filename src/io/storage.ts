import { isNative } from './native';
import type { SerializedProject } from './project';

/**
 * Autosave lives in IndexedDB rather than localStorage: a project with a
 * couple of embedded tilesets runs to several megabytes, well past the
 * localStorage quota Safari enforces.
 *
 * In the iPad app the project is also a file in the app's Library folder.
 * iOS may clear a web view's storage when space runs low, but never that
 * folder, and it is backed up with the device. It is not shown in the Files
 * app: taking a file out of the app is what Export is for.
 */

const PROJECT_FILE = 'Projects/current.pfproj';
const PROJECT_TEMP = 'Projects/current.pfproj.tmp';

async function writeProjectFile(project: SerializedProject): Promise<void> {
  const { Directory, Encoding, Filesystem } = await import('@capacitor/filesystem');
  const options = { directory: Directory.Library, encoding: Encoding.UTF8 };
  // Written aside first, so a crash mid-save leaves the last good copy whole.
  await Filesystem.writeFile({ ...options, path: PROJECT_TEMP, data: JSON.stringify(project), recursive: true });
  await Filesystem.deleteFile({ directory: Directory.Library, path: PROJECT_FILE }).catch(() => {});
  await Filesystem.rename({ from: PROJECT_TEMP, to: PROJECT_FILE, directory: Directory.Library, toDirectory: Directory.Library });
}

async function readProjectFile(): Promise<SerializedProject | null> {
  const { Directory, Encoding, Filesystem } = await import('@capacitor/filesystem');
  // The finished copy first; the one written aside if a save was cut short.
  for (const path of [PROJECT_FILE, PROJECT_TEMP]) {
    try {
      const file = await Filesystem.readFile({ path, directory: Directory.Library, encoding: Encoding.UTF8 });
      return JSON.parse(String(file.data)) as SerializedProject;
    } catch {
      /* missing or unreadable; try the next */
    }
  }
  return null;
}

// From before the app was called Habitat. Renaming it would lose every saved map.
const DB_NAME = 'pixel-fusion';
const DB_VERSION = 1;
const STORE = 'projects';
const CURRENT_KEY = 'current';

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

export async function saveProject(project: SerializedProject): Promise<void> {
  if (isNative()) {
    await writeProjectFile(project);
    // The web view copy is a spare; the file is the one that counts.
    await withStore('readwrite', (store) => store.put(project, CURRENT_KEY)).catch(() => {});
    return;
  }
  await withStore('readwrite', (store) => store.put(project, CURRENT_KEY));
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

export async function loadProject(): Promise<SerializedProject | null> {
  if (isNative()) {
    const fromFile = await readProjectFile().catch(() => null);
    if (fromFile) return fromFile;
  }
  try {
    const result = await withStore<SerializedProject | undefined>('readonly', (store) =>
      store.get(CURRENT_KEY),
    );
    return result ?? null;
  } catch {
    // Private browsing and storage pressure can both make this throw. An
    // empty editor is a better outcome than a blank screen.
    return null;
  }
}

export async function clearProject(): Promise<void> {
  try {
    await withStore('readwrite', (store) => store.delete(CURRENT_KEY));
  } catch {
    /* nothing useful to do if the store is unavailable */
  }
}

/**
 * Coalesces autosave requests. Saving serialises the whole document, so it is
 * deliberately lazy and never runs in the middle of a stroke.
 */
export function createAutosave(
  serialize: () => SerializedProject,
  delay = 1200,
  /** Told when a save fails, such as when the browser blocks storage, so the user is not left thinking work is kept. */
  onError: (error: unknown) => void = () => {},
): { schedule: () => void; flush: () => Promise<void> } {
  let timer: number | undefined;
  let pending = false;

  const run = async () => {
    pending = false;
    try {
      await saveProject(serialize());
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
