import { button, el } from './dom';
import { icon } from './icons';

export interface ModalAction {
  label: string;
  variant?: 'primary' | 'danger' | 'subtle';
  /** Return false to keep the dialog open, e.g. when validation fails. */
  onSelect?: () => boolean | void | Promise<boolean | void>;
}

export interface ModalHandle {
  close: () => void;
  element: HTMLElement;
}

/**
 * Centred sheet with a scrollable body. Kept inside the safe area so the
 * action row never lands under the iPad's home indicator.
 */
export function openModal(options: {
  title: string;
  body: HTMLElement;
  actions: ModalAction[];
  onClose?: () => void;
  wide?: boolean;
}): ModalHandle {
  const backdrop = el('div', { class: 'modal-backdrop' });

  const close = () => {
    document.removeEventListener('keydown', onKey);
    backdrop.remove();
    options.onClose?.();
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  document.addEventListener('keydown', onKey);

  const footer = el(
    'div',
    { class: 'modal-actions' },
    options.actions.map((action) =>
      button(`btn ${action.variant ?? 'subtle'}`, action.label, () => {
        void Promise.resolve(action.onSelect?.()).then((keepOpen) => {
          if (keepOpen !== false) close();
        });
      }, [el('span', { text: action.label })]),
    ),
  );

  const dialog = el('div', { class: `modal${options.wide ? ' wide' : ''}`, role: 'dialog' }, [
    el('header', { class: 'modal-header' }, [
      el('h2', { text: options.title }),
      button('icon-btn', 'Close', close, [icon('close', 20)]),
    ]),
    el('div', { class: 'modal-body' }, [options.body]),
    footer,
  ]);

  backdrop.append(dialog);
  // A tap on the dimmed area dismisses, but a drag that ends there (from
  // inside the dialog) should not.
  backdrop.addEventListener('pointerdown', (e) => {
    if (e.target === backdrop) close();
  });

  document.body.append(backdrop);
  return { close, element: dialog };
}
