/**
 * Cache-first service worker so the editor opens offline once it has been
 * loaded. The cache name carries a build stamp, which Vite rewrites on every
 * production build, so a new deploy evicts the old assets instead of serving
 * a half-updated mix.
 */
const CACHE = 'habitat-v6';

self.addEventListener('install', (event) => {
  // The app shell is tiny; everything else is picked up on first use.
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(['./', './index.html', './manifest.webmanifest'])),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Navigations fall back to the cached shell so a reload works with no
  // network at all; the router is entirely client side.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('./index.html').then((hit) => hit ?? Response.error())),
    );
    return;
  }

  // The app shell and the library list have to come from the network, or a
  // reload keeps the previous version forever and new packs never appear.
  // Pictures can stay cached.
  const fresh =
    request.mode === 'navigate' ||
    request.destination === 'script' ||
    request.destination === 'style' ||
    request.destination === 'worker' ||
    request.cache === 'no-cache' ||
    request.cache === 'reload' ||
    url.pathname.endsWith('.json') ||
    url.pathname.endsWith('/sw.js');
  if (fresh) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            void caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() =>
          caches.match(request).then((hit) => hit ?? (request.mode === 'navigate' ? caches.match('./index.html') : Promise.reject())),
        ),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((hit) => {
      if (hit) return hit;
      return fetch(request).then((response) => {
        if (response.ok && response.type === 'basic') {
          const copy = response.clone();
          void caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    }),
  );
});
