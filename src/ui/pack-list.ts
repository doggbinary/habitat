import { button, el } from './dom';
import { icon } from './icons';
import { openModal } from './modal';

export interface PackRow {
  name: string;
  pages: number;
  pinned: boolean;
}

/** A finger held this long on a pack opens its menu. */
const HOLD_MS = 220;
/** Movement that turns a press into a scroll of the list. */
const SLOP = 10;

/**
 * Every pack in one list. A tap opens the pack; press and hold (or a right
 * click) shows Pin and Delete for it, so a pack is managed where it is found.
 */
export function openPackList(options: {
  packs: PackRow[];
  current: string;
  onPick: (pack: string) => void;
  onPin: (pack: string, pinned: boolean) => void;
  onDelete: (pack: string) => void;
}): void {
  const list = el('div', { class: 'pack-list' });
  let menuFor: HTMLElement | null = null;

  const closeMenu = () => {
    menuFor?.querySelector('.pack-menu')?.remove();
    menuFor?.classList.remove('holding');
    menuFor = null;
  };

  const openMenu = (row: HTMLElement, pack: PackRow) => {
    closeMenu();
    menuFor = row;
    row.classList.add('holding');
    row.append(
      el('div', { class: 'pack-menu' }, [
        button('chip', pack.pinned ? 'List this pack in order again' : 'List this pack first', () => {
          handle.close();
          options.onPin(pack.name, !pack.pinned);
        }, [icon('star', 16), el('span', { text: pack.pinned ? 'Unpin pack' : 'Pin pack' })]),
        button('chip danger', 'Delete every page of this pack', () => {
          handle.close();
          options.onDelete(pack.name);
        }, [icon('trash', 16), el('span', { text: 'Delete pack' })]),
      ]),
    );
  };

  for (const pack of options.packs) {
    const row = el('div', { class: `pack-row${pack.name === options.current ? ' active' : ''}` });
    const label = el('div', { class: 'pack-label' }, [
      pack.pinned ? icon('star', 16) : null,
      el('span', { class: 'pack-name', text: pack.name }),
      el('span', { class: 'muted', text: pack.pages === 1 ? '1 page' : `${pack.pages} pages` }),
    ]);
    row.append(label);

    let timer = 0;
    let start = { x: 0, y: 0 };
    let held = false;
    let moved = false;
    const cancel = () => {
      if (timer) window.clearTimeout(timer);
      timer = 0;
    };
    label.addEventListener('pointerdown', (e) => {
      held = false;
      moved = false;
      start = { x: e.clientX, y: e.clientY };
      cancel();
      timer = window.setTimeout(() => {
        timer = 0;
        held = true;
        openMenu(row, pack);
      }, HOLD_MS);
    });
    label.addEventListener('pointermove', (e) => {
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) <= SLOP) return;
      moved = true;
      cancel();
    });
    label.addEventListener('pointercancel', () => {
      moved = true;
      cancel();
    });
    label.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      cancel();
      held = true;
      openMenu(row, pack);
    });
    // iPad can drop the click after a tap, so the lift itself picks the pack.
    label.addEventListener('pointerup', (e) => {
      cancel();
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      // The press that opened the menu must not also open the pack, and a
      // swipe through the list is a scroll.
      if (held || moved) return;
      if (menuFor) {
        closeMenu();
        return;
      }
      handle.close();
      options.onPick(pack.name);
    });
    list.append(row);
  }

  const handle = openModal({
    title: 'Packs',
    body: el('div', {}, [el('p', { class: 'hint', text: 'Press and hold a pack to pin it to the top or delete it.' }), list]),
    actions: [{ label: 'Close' }],
  });
}
