import { describe, expect, it, vi } from 'vitest';
import { createDoc } from '../core/doc';
import { serializeProject } from './project';
import { chooseSaved, createAutosave, saveProject } from './storage';

describe('which copy of a map to open', () => {
  const room = { name: 'room' };
  const other = { name: 'other' };

  it('uses the server when this address has nothing saved', () => {
    const chosen = chooseSaved(null, null, { savedAt: 10, value: room });
    expect(chosen.value).toEqual(room);
    expect(chosen.adoptRemote).toBe(true);
    expect(chosen.publishLocal).toBe(false);
  });

  it('keeps a map that was already in the browser and does not overwrite the server with it', () => {
    const chosen = chooseSaved(room, null, { savedAt: 10, value: other });
    expect(chosen.value).toEqual(room);
    expect(chosen.adoptRemote).toBe(false);
    expect(chosen.publishLocal).toBe(false);
  });

  it('uploads a browser map when the server has no copy yet', () => {
    const chosen = chooseSaved(room, null, null, 40);
    expect(chosen.value).toEqual(room);
    expect(chosen.publishLocal).toBe(true);
    expect(chosen.savedAt).toBe(40);
  });

  it('keeps the newer of the two stamped copies', () => {
    const newerServer = chooseSaved(room, 5, { savedAt: 9, value: other });
    expect(newerServer.value).toEqual(other);
    expect(newerServer.adoptRemote).toBe(true);
    const newerBrowser = chooseSaved(room, 12, { savedAt: 9, value: other });
    expect(newerBrowser.value).toEqual(room);
    expect(newerBrowser.publishLocal).toBe(true);
  });
});

describe('autosave', () => {
  it('says so when a save fails, instead of losing work quietly', async () => {
    // Node has no IndexedDB, which is exactly a browser that blocks storage.
    vi.stubGlobal('window', globalThis);
    const failed = vi.fn();
    const autosave = createAutosave(() => saveProject(serializeProject(createDoc(2, 2, 16))), 1200, failed);
    autosave.schedule();
    await autosave.flush();
    expect(failed).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});
