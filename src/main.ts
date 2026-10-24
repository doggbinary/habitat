import { App } from './app';
import './style.css';

const root = document.getElementById('app');
if (!root) throw new Error('Missing #app root element');

const app = new App(root);
void app.start();

/**
 * Safari zooms the whole document on a two-finger pinch over page chrome,
 * which would fight the editor's own pinch-to-zoom. Double-tap zoom is handled
 * in CSS with `touch-action: manipulation` so taps still register normally.
 */
for (const name of ['gesturestart', 'gesturechange']) {
  document.addEventListener(name, (e) => e.preventDefault(), { passive: false });
}

// Offline support: the editor is fully local, so once it is cached it keeps
// working with no network at all.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('./sw.js').catch(() => {
      /* offline support is a bonus, not a requirement */
    });
  });
}
