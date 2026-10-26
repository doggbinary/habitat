import { buyPro, proPrice, restorePro, type PurchaseOutcome } from '../pro';
import { button, el } from './dom';
import { openModal, type ModalHandle } from './modal';

const UNLOCKS = [
  'The map as a PNG',
  'The tileset as a PNG',
  'Character sprite sheets',
  'Map data for Unity, Godot and Phaser',
  'The project file, to reopen anywhere',
];

/**
 * Shown when Export is tapped in the free app. Everything else stays free,
 * so the screen only has to say what taking a file out costs, once.
 */
export function openProScreen(options: { unlocked: () => void; toast: (message: string) => void }): void {
  const price = el('span', { text: '$14.99' });
  const status = el('p', { class: 'hint pro-status', text: '' });
  let handle: ModalHandle | null = null;
  let busy = false;

  const settle = (outcome: PurchaseOutcome, restoring: boolean) => {
    busy = false;
    if (outcome === 'owned') {
      handle?.close();
      options.toast(restoring ? 'Pro restored. Export is unlocked.' : 'Thank you! Export is unlocked.');
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

  const buy = button('btn primary pro-buy', 'Unlock Export', () => {
    if (busy) return;
    busy = true;
    status.textContent = 'Opening the App Store...';
    void buyPro().then((outcome) => settle(outcome, false));
  }, [el('span', { text: 'Unlock Export for ' }), price]);

  const restore = button('btn subtle', 'Restore purchase', () => {
    if (busy) return;
    busy = true;
    status.textContent = 'Checking your purchases...';
    void restorePro().then((outcome) => settle(outcome, true));
  }, [el('span', { text: 'Restore purchase' })]);

  const body = el('div', { class: 'dialog-body pro-screen' }, [
    el('p', { class: 'pro-pitch', text: 'Free to build and walk. One purchase to keep a copy you can take anywhere.' }),
    el('ul', { class: 'pro-list' }, UNLOCKS.map((line) => el('li', { text: line }))),
    el('p', { class: 'hint', text: 'Pay once, keep it. No subscription, no trial timer. Building, saving and Play stay free.' }),
    buy,
    restore,
    status,
  ]);

  handle = openModal({ title: 'Export with Pixel Fusion Pro', body, actions: [{ label: 'Not now' }] });
  void proPrice().then((value) => {
    price.textContent = value;
  });
}
