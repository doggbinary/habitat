import { button, el } from './dom';
import { icon } from './icons';
import { openModal, type ModalHandle } from './modal';

/** A finger held this long on a card opens its menu. */
const HOLD_MS = 350;
/** Movement that turns a press into a scroll. */
const SLOP = 10;

export interface LibraryItem {
  id: string;
  name: string;
  folder?: string;
  note?: string;
  /** The one open now, marked so it is easy to find. */
  current?: boolean;
  thumb?: () => HTMLElement | null;
}

export interface LibrarySource {
  title: string;
  /** One of the things listed, for labels: "character", "map". */
  noun: string;
  items: () => LibraryItem[];
  folders: () => string[];
  open: (id: string) => void;
  rename: (id: string, name: string) => void;
  duplicate?: (id: string) => void;
  move: (id: string, folder: string | undefined) => void;
  remove: (id: string) => void;
  addFolder: (name: string) => void;
  renameFolder: (from: string, to: string) => void;
  /** Its contents move out to the top level; nothing in it is deleted. */
  removeFolder: (name: string) => void;
  exportFolder?: (name: string) => void;
  /** Makes a new one, inside the folder being looked at. */
  create?: { label: string; run: (folder: string | undefined) => void };
  /** Shown under the grid, such as why a new map needs Pro. */
  footnote?: () => string | null;
}

/** Asks for a name in a small dialog, so the keyboard covers nothing that matters. */
export function promptName(title: string, initial: string, onConfirm: (name: string) => void, label = 'Save'): void {
  const input = el('input', { class: 'input', type: 'text', value: initial });
  const submit = () => {
    const name = input.value.trim();
    if (!name) return false;
    onConfirm(name);
    return true;
  };
  const handle = openModal({
    title,
    body: el('div', { class: 'dialog-body' }, [input]),
    actions: [{ label: 'Cancel' }, { label, variant: 'primary', onSelect: submit }],
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && submit()) handle.close();
  });
  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
}

export function confirmAction(title: string, text: string, label: string, run: () => void): void {
  openModal({
    title,
    body: el('div', { class: 'dialog-body' }, [el('p', { text })]),
    actions: [{ label: 'Cancel' }, { label, variant: 'danger', onSelect: run }],
  });
}

/**
 * Press and hold (or right click) for a menu; a plain tap runs `onTap`.
 * The lift itself counts as the tap, because iPad can drop the click.
 */
function holdable(node: HTMLElement, onTap: () => void, onHold: () => void): void {
  let timer = 0;
  let start = { x: 0, y: 0 };
  let held = false;
  let moved = false;
  const cancel = () => {
    if (timer) window.clearTimeout(timer);
    timer = 0;
  };
  node.addEventListener('pointerdown', (e) => {
    // A press on the card's own menu is a press on that button, not a hold.
    if ((e.target as Element | null)?.closest?.('.library-menu')) return;
    held = false;
    moved = false;
    start = { x: e.clientX, y: e.clientY };
    cancel();
    timer = window.setTimeout(() => {
      timer = 0;
      held = true;
      onHold();
    }, HOLD_MS);
  });
  node.addEventListener('pointermove', (e) => {
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) <= SLOP) return;
    moved = true;
    cancel();
  });
  node.addEventListener('pointercancel', () => {
    moved = true;
    cancel();
  });
  node.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    cancel();
    held = true;
    onHold();
  });
  node.addEventListener('pointerup', (e) => {
    cancel();
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (held || moved) return;
    onTap();
  });
}

/**
 * Everything of one kind in a grid of cards, with folders. Tap a card to
 * open it; press and hold for Rename, Duplicate, Move and Delete. Folders
 * are cards too: tap to go in, hold to rename, export or remove them.
 */
export function openLibrary(source: LibrarySource): ModalHandle & { refresh: () => void } {
  let folder: string | undefined;
  const body = el('div', { class: 'library' });
  const plural = `${source.noun}s`;

  const menu = (anchor: HTMLElement, entries: (HTMLElement | null)[]) => {
    body.querySelector('.library-menu')?.remove();
    const node = el('div', { class: 'library-menu' }, entries);
    anchor.append(node);
  };
  const closeMenu = () => body.querySelector('.library-menu')?.remove();

  const moveMenu = (item: LibraryItem) => {
    const choices = [
      ...(item.folder ? [{ label: 'Out of the folder', value: undefined as string | undefined }] : []),
      ...source.folders().filter((f) => f !== item.folder).map((f) => ({ label: f, value: f as string | undefined })),
    ];
    const list = el('div', { class: 'library-move' }, [
      ...choices.map((choice) =>
        button('btn subtle full', `Move to ${choice.label}`, () => {
          source.move(item.id, choice.value);
          picker.close();
          render();
        }, [icon(choice.value ? 'folder' : 'upload', 16), el('span', { text: choice.label })]),
      ),
      button('btn subtle full', 'New folder', () => {
        picker.close();
        promptName('New folder', 'New folder', (name) => {
          source.addFolder(name);
          source.move(item.id, name);
          render();
        }, 'Create');
      }, [icon('plus', 16), el('span', { text: 'New folder…' })]),
    ]);
    const picker = openModal({ title: `Move ${item.name}`, body: list, actions: [{ label: 'Cancel' }] });
  };

  const itemCard = (item: LibraryItem) => {
    const thumb = item.thumb?.() ?? el('div', { class: 'library-thumb-empty' }, [icon('image', 28)]);
    const card = el('div', { class: `library-card${item.current ? ' current' : ''}` }, [
      el('div', { class: 'library-thumb' }, [thumb]),
      el('span', { class: 'library-name', text: item.name }),
      el('span', { class: 'library-note', text: item.current ? 'Open now' : (item.note ?? '') }),
    ]);
    holdable(
      card,
      () => {
        if (body.querySelector('.library-menu')) {
          closeMenu();
          return;
        }
        handle.close();
        source.open(item.id);
      },
      () =>
        menu(card, [
          button('chip', `Rename this ${source.noun}`, () => {
            closeMenu();
            promptName(`Rename ${source.noun}`, item.name, (name) => {
              source.rename(item.id, name);
              render();
            });
          }, [el('span', { text: 'Rename' })]),
          source.duplicate
            ? button('chip', `Make a copy of this ${source.noun}`, () => {
                closeMenu();
                source.duplicate!(item.id);
                render();
              }, [icon('copy', 16), el('span', { text: 'Duplicate' })])
            : null,
          button('chip', 'Move to a folder', () => {
            closeMenu();
            moveMenu(item);
          }, [icon('folder', 16), el('span', { text: 'Move' })]),
          button('chip danger', `Delete this ${source.noun}`, () => {
            closeMenu();
            confirmAction(`Delete ${item.name}?`, `This ${source.noun} is gone for good.`, 'Delete', () => {
              source.remove(item.id);
              render();
            });
          }, [icon('trash', 16), el('span', { text: 'Delete' })]),
        ]),
    );
    return card;
  };

  const folderCard = (name: string, count: number) => {
    const card = el('div', { class: 'library-card folder' }, [
      el('div', { class: 'library-thumb' }, [icon('folder', 40)]),
      el('span', { class: 'library-name', text: name }),
      el('span', { class: 'library-note', text: count === 1 ? `1 ${source.noun}` : `${count} ${plural}` }),
    ]);
    holdable(
      card,
      () => {
        if (body.querySelector('.library-menu')) {
          closeMenu();
          return;
        }
        folder = name;
        render();
      },
      () =>
        menu(card, [
          button('chip', 'Rename this folder', () => {
            closeMenu();
            promptName('Rename folder', name, (next) => {
              source.renameFolder(name, next);
              render();
            });
          }, [el('span', { text: 'Rename' })]),
          source.exportFolder
            ? button('chip', `Export every ${source.noun} in this folder`, () => {
                closeMenu();
                source.exportFolder!(name);
              }, [icon('download', 16), el('span', { text: 'Export' })])
            : null,
          button('chip danger', 'Remove this folder', () => {
            closeMenu();
            confirmAction(`Remove ${name}?`, `The folder goes; the ${plural} in it stay, outside any folder.`, 'Remove', () => {
              source.removeFolder(name);
              render();
            });
          }, [icon('trash', 16), el('span', { text: 'Remove folder' })]),
        ]),
    );
    return card;
  };

  const render = () => {
    const items = source.items();
    const grid = el('div', { class: 'library-grid' });
    if (folder === undefined) {
      for (const name of source.folders()) {
        grid.append(folderCard(name, items.filter((item) => item.folder === name).length));
      }
    }
    const shown = items.filter((item) => item.folder === folder);
    for (const item of shown) grid.append(itemCard(item));

    const head = el('div', { class: 'library-head' }, [
      folder !== undefined
        ? button('btn subtle', `Back to all ${plural}`, () => {
            folder = undefined;
            render();
          }, [icon('chevronLeft', 16), el('span', { text: folder })])
        : el('span', { class: 'hint', text: `Tap to open. Press and hold to rename, copy, move or delete.` }),
      el('div', { class: 'library-head-actions' }, [
        folder === undefined
          ? button('btn subtle', 'New folder', () => {
              promptName('New folder', 'New folder', (name) => {
                source.addFolder(name);
                render();
              }, 'Create');
            }, [icon('folder', 16), el('span', { text: 'New folder' })])
          : source.exportFolder
            ? button('btn subtle', `Export every ${source.noun} in this folder`, () => source.exportFolder!(folder!), [
                icon('download', 16),
                el('span', { text: 'Export folder' }),
              ])
            : null,
        source.create
          ? button('btn primary', source.create.label, () => {
              handle.close();
              source.create!.run(folder);
            }, [icon('plus', 16), el('span', { text: source.create.label })])
          : null,
      ]),
    ]);

    const empty =
      grid.childElementCount === 0
        ? el('p', { class: 'hint library-empty', text: folder !== undefined ? `No ${plural} in this folder yet.` : `No ${plural} yet.` })
        : null;
    const note = source.footnote?.();
    body.replaceChildren(head, empty ?? grid, ...(note ? [el('p', { class: 'hint', text: note })] : []));
  };

  render();
  const handle = openModal({ title: source.title, body, actions: [{ label: 'Close' }], wide: true });
  return { ...handle, refresh: render };
}
