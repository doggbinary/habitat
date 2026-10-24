import type { SerializedProject } from './project';

/**
 * Autosave lives in IndexedDB rather than localStorage: a project with a
 * couple of embedded tilesets runs to several megabytes, well past the
 * localStorage quota Safari enforces.
 */

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
  await withStore('readwrite', (store) => store.put(project, CURRENT_KEY));
}

export async function loadProject(): Promise<SerializedProject | null> {
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
): { schedule: () => void; flush: () => Promise<void> } {
  let timer: number | undefined;
  let pending = false;

  const run = async () => {
    pending = false;
    try {
      await saveProject(serialize());
    } catch {
      /* out of quota or storage blocked; the in-memory document is unaffected */
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
