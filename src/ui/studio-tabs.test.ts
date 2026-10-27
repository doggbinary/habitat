import { describe, expect, it } from 'vitest';
import { recallTab, rememberTab } from './studio-tabs';

function memory() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

describe('studio panel tabs', () => {
  it('opens on Character the first time, then on the tab you last used', () => {
    const store = memory();
    expect(recallTab(store)).toBe('character');
    rememberTab('layers', store);
    expect(recallTab(store)).toBe('layers');
  });

  it('ignores a saved tab that no longer exists', () => {
    const store = memory();
    store.setItem('habitat-studio-tab', 'tools');
    expect(recallTab(store)).toBe('character');
  });
});
