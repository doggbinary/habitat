import { App } from './app';
import { configureNativeShell, isNative } from './io/native';
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

/**
 * Offline support for the web build: once cached, the editor keeps working
 * with no network at all.
 *
 * The native app skips this entirely. Its assets are already inside the
 * bundle, so a service worker would add a second, staler cache on top of
 * files that can never change without an App Store update.
 */
if ('serviceWorker' in navigator && import.meta.env.PROD && !isNative()) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('./sw.js').catch(() => {
      /* offline support is a bonus, not a requirement */
    });
  });
}

if (isNative()) void configureNativeShell();
