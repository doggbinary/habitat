import { button, el } from './dom';

const SEEN_KEY = 'pf-coach-seen';

const STEPS = [
  {
    title: 'The Pencil draws',
    text: 'Open Assets, tap a ground square and paint with the Pencil. Tap a house or a tree, then tap the map to place it.',
  },
  {
    title: 'A finger moves things',
    text: 'One finger moves the map and drags what you placed. Pinch to zoom. Two fingers tap to undo, three to redo.',
  },
  {
    title: 'Press Play and walk in',
    text: 'Walk the Boy up the path with the stick and through the house door. Draw your own character any time in Character.',
  },
];

/**
 * Three short cards on a first launch, then never again. The last one
 * offers Play straight away, because walking through the door is the point.
 */
export function showCoach(options: { play: () => void }): void {
  try {
    if (localStorage.getItem(SEEN_KEY)) return;
  } catch {
    /* without storage the coach simply shows each time */
  }
  let step = 0;
  const title = el('h3', { class: 'coach-title' });
  const text = el('p', { class: 'coach-text' });
  const count = el('span', { class: 'coach-count' });
  const next = button('btn primary', 'Next', () => go(step + 1), [el('span', { text: 'Next' })]);
  const card = el('div', { class: 'coach', role: 'dialog' }, [
    count,
    title,
    text,
    el('div', { class: 'coach-actions' }, [button('btn subtle', 'Skip', () => done(), [el('span', { text: 'Skip' })]), next]),
  ]);

  const done = () => {
    card.remove();
    try {
      localStorage.setItem(SEEN_KEY, '1');
    } catch {
      /* shown again next time, which is harmless */
    }
  };

  const go = (to: number) => {
    if (to >= STEPS.length) {
      done();
      options.play();
      return;
    }
    step = to;
    title.textContent = STEPS[step].title;
    text.textContent = STEPS[step].text;
    count.textContent = `${step + 1} of ${STEPS.length}`;
    const last = step === STEPS.length - 1;
    next.textContent = last ? 'Play now' : 'Next';
    next.title = last ? 'Play now' : 'Next';
  };

  go(0);
  document.body.append(card);
}
