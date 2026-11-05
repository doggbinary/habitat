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

/**
 * A copy kept on this machine, so a new tunnel address — a new browser
 * origin with an empty IndexedDB — can open the same maps.
 */
export interface StoredCopy<T> {
  savedAt: number;
  value: T;
}

/**
 * Which copy to open, and whether the other side needs updating.
 *
 * A browser that already has a map from before this mirror existed keeps
 * that map. It is uploaded only when the server has nothing, so a newer
 * server copy cannot wipe the one remaining original.
 */
export function chooseSaved<T>(
  local: T | null,
  localAt: number | null,
  remote: StoredCopy<T> | null,
  now = Date.now(),
): { value: T | null; adoptRemote: boolean; publishLocal: boolean; savedAt: number } {
  if (local == null && remote == null) return { value: null, adoptRemote: false, publishLocal: false, savedAt: 0 };
  if (local == null && remote) return { value: remote.value, adoptRemote: true, publishLocal: false, savedAt: remote.savedAt };
  if (local != null && localAt == null) {
    if (!remote) return { value: local, adoptRemote: false, publishLocal: true, savedAt: now };
    return { value: local, adoptRemote: false, publishLocal: false, savedAt: 0 };
  }
  if (local != null && remote == null) return { value: local, adoptRemote: false, publishLocal: true, savedAt: localAt ?? now };
  if (local != null && remote) {
    const at = localAt ?? 0;
    if (remote.savedAt > at) return { value: remote.value, adoptRemote: true, publishLocal: false, savedAt: remote.savedAt };
    if (at > remote.savedAt) return { value: local, adoptRemote: false, publishLocal: true, savedAt: at };
    return { value: local, adoptRemote: false, publishLocal: false, savedAt: at };
  }
  return { value: null, adoptRemote: false, publishLocal: false, savedAt: 0 };
}

const STAMP_PREFIX = 'habitat-saved-at:';

function rememberSavedAt(key: string, savedAt: number): void {
  try {
    localStorage.setItem(STAMP_PREFIX + key, String(savedAt));
  } catch {
    /* a blocked localStorage still leaves the copy in IndexedDB */
  }
}

function rememberedSavedAt(key: string): number | null {
  try {
    const raw = localStorage.getItem(STAMP_PREFIX + key);
    if (raw == null) return null;
    const at = Number(raw);
    return Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}

function forgetSavedAt(key: string): void {
  try {
    localStorage.removeItem(STAMP_PREFIX + key);
  } catch {
    /* the value itself is already gone */
  }
}

async function readLocal<T>(key: string): Promise<T | null> {
  const result = await withStore<T | undefined>('readonly', (store) => store.get(key));
  return result ?? null;
}

async function writeLocal(key: string, value: unknown): Promise<void> {
  await withStore('readwrite', (store) => store.put(value, key));
}

async function readServer<T>(key: string): Promise<StoredCopy<T> | null> {
  const response = await fetch(`/api/habitat/value/${encodeURIComponent(key)}`, { cache: 'no-store' });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Could not read the saved map (${response.status})`);
  const body = (await response.json()) as { savedAt?: unknown; value?: T };
  if (!body || !('value' in body)) return null;
  const savedAt = typeof body.savedAt === 'number' && Number.isFinite(body.savedAt) ? body.savedAt : 0;
  return { savedAt, value: body.value as T };
}

async function writeServer(key: string, value: unknown, savedAt: number): Promise<void> {
  const response = await fetch(`/api/habitat/value/${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ savedAt, value }),
  });
  if (!response.ok) throw new Error(`Could not store the map on this machine (${response.status})`);
}

async function deleteServer(key: string): Promise<void> {
  const response = await fetch(`/api/habitat/value/${encodeURIComponent(key)}`, { method: 'DELETE' });
  if (!response.ok && response.status !== 404) throw new Error(`Could not remove the stored map (${response.status})`);
}

export async function saveValue(key: string, value: unknown): Promise<void> {
  if (isNative()) {
    await writeFile(key, value);
    // The web view copy is a spare; the file is the one that counts.
    await withStore('readwrite', (store) => store.put(value, key)).catch(() => {});
    return;
  }
  const savedAt = Date.now();
  const [local, remote] = await Promise.all([
    writeLocal(key, value).then(() => null, (error: unknown) => error),
    writeServer(key, value, savedAt).then(() => null, (error: unknown) => error),
  ]);
  if (local == null) rememberSavedAt(key, savedAt);
  // The browser copy is not enough: the next tunnel address starts empty.
  if (remote != null) throw remote;
}

export async function loadValue<T>(key: string): Promise<T | null> {
  if (isNative()) {
    const fromFile = await readFile<T>(key).catch(() => null);
    if (fromFile) return fromFile;
  }
  let local: T | null = null;
  try {
    local = await readLocal<T>(key);
  } catch {
    // Private browsing and storage pressure can both make this throw.
    local = null;
  }
  let remote: StoredCopy<T> | null = null;
  try {
    remote = await readServer<T>(key);
  } catch {
    remote = null;
  }
  const chosen = chooseSaved(local, local == null ? null : rememberedSavedAt(key), remote);
  if (chosen.adoptRemote && chosen.value != null) {
    await writeLocal(key, chosen.value).catch(() => {});
    rememberSavedAt(key, chosen.savedAt);
  } else if (chosen.publishLocal && chosen.value != null) {
    await writeServer(key, chosen.value, chosen.savedAt).then(() => rememberSavedAt(key, chosen.savedAt), () => {});
  }
  return chosen.value;
}

export async function deleteValue(key: string): Promise<void> {
  if (isNative()) await deleteFile(key).catch(() => {});
  forgetSavedAt(key);
  try {
    await withStore('readwrite', (store) => store.delete(key));
  } catch {
    /* nothing useful to do if the store is unavailable */
  }
  if (!isNative()) await deleteServer(key).catch(() => {});
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
