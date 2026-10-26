import { describe, expect, it, vi } from 'vitest';
import { createDoc } from '../core/doc';
import { serializeProject } from './project';
import { createAutosave, saveProject } from './storage';

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
