import { App } from './app';
import { configureNativeShell, isNative } from './io/native';
import './style.css';

const root = document.getElementById('app');
if (!root) throw new Error('Missing #app root element');

const app = new App(root);
void app.start();

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
    // The query keeps an already-installed worker from handing back its own
    // cached copy of this file, which would freeze the app on an old version.
    void navigator.serviceWorker.register('./sw.js?v=3').catch(() => {
      /* offline support is a bonus, not a requirement */
    });
  });
}

if (isNative()) void configureNativeShell();
