/** The three short pages of the Character studio's panel. */
export type StudioTab = 'character' | 'layers' | 'frames';

export const STUDIO_TABS: { id: StudioTab; label: string }[] = [
  { id: 'character', label: 'Character' },
  { id: 'layers', label: 'Layers' },
  { id: 'frames', label: 'Frames' },
];

const KEY = 'habitat-studio-tab';

type TabStorage = Pick<Storage, 'getItem' | 'setItem'>;

function storage(): TabStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** The tab you were last on, or Character the first time. */
export function recallTab(store: TabStorage | null = storage()): StudioTab {
  try {
    const saved = store?.getItem(KEY);
    return STUDIO_TABS.some((tab) => tab.id === saved) ? (saved as StudioTab) : 'character';
  } catch {
    return 'character';
  }
}

export function rememberTab(tab: StudioTab, store: TabStorage | null = storage()): void {
  try {
    store?.setItem(KEY, tab);
  } catch {
    /* private browsing: it is just forgotten */
  }
}
