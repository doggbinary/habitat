import { buyPro, proPrice, restorePro, type PurchaseOutcome } from '../pro';
import { button, el } from './dom';
import { openModal, type ModalHandle } from './modal';

const UNLOCKS = [
  'As many maps as you like, in folders',
  'The map as a PNG',
  'The tileset as a PNG',
  'Character sprite sheets',
  'Map data for Unity, Godot and Phaser',
  'The project file, to reopen anywhere',
  'A whole folder of maps as one zip',
];

/**
 * Shown when Export, or a second map, is tapped in the free app. Building,
 * one map, characters and Play stay free, so the screen only has to say
 * what Pro adds, once.
 */
export function openProScreen(options: {
  unlocked: () => void;
  toast: (message: string) => void;
  /** Why it opened, said first: "Make more maps with Habitat Pro". */
  title?: string;
}): void {
  const price = el('span', { text: '$14.99' });
  const status = el('p', { class: 'hint pro-status', text: '' });
  let handle: ModalHandle | null = null;
  let busy = false;

  const settle = (outcome: PurchaseOutcome, restoring: boolean) => {
    busy = false;
    if (outcome === 'owned') {
      handle?.close();
      options.toast(restoring ? 'Pro restored. Everything is unlocked.' : 'Thank you! Everything is unlocked.');
      options.unlocked();
      return;
    }
    status.textContent =
      outcome === 'cancelled'
        ? ''
        : outcome === 'unavailable'
          ? 'The App Store is not reachable right now. Try again in a moment.'
          : restoring
            ? 'No earlier purchase was found for this Apple ID.'
            : 'The purchase did not go through. You have not been charged.';
  };

  const buy = button('btn primary pro-buy', 'Unlock Habitat Pro', () => {
    if (busy) return;
    busy = true;
    status.textContent = 'Opening the App Store...';
    void buyPro().then((outcome) => settle(outcome, false));
  }, [el('span', { text: 'Unlock Pro for ' }), price]);

  const restore = button('btn subtle', 'Restore purchase', () => {
    if (busy) return;
    busy = true;
    status.textContent = 'Checking your purchases...';
    void restorePro().then((outcome) => settle(outcome, true));
  }, [el('span', { text: 'Restore purchase' })]);

  const body = el('div', { class: 'dialog-body pro-screen' }, [
    el('p', { class: 'pro-pitch', text: 'Free to build and walk. One purchase to keep a copy you can take anywhere.' }),
    el('ul', { class: 'pro-list' }, UNLOCKS.map((line) => el('li', { text: line }))),
    el('p', { class: 'hint', text: 'Pay once, keep it. No subscription, no trial timer. One map, characters and Play stay free.' }),
    buy,
    restore,
    status,
  ]);

  handle = openModal({ title: options.title ?? 'Export with Habitat Pro', body, actions: [{ label: 'Not now' }] });
  void proPrice().then((value) => {
    price.textContent = value;
  });
}
