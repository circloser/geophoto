/* GeoPhoto Map Navigator — Service Worker
   Caches the app shell + CDN libraries (so the page opens offline) and runtime-
   caches map tiles as they are viewed, so areas you've already browsed stay
   available without a connection. */
const APP_CACHE = 'geophoto-app-v7';
const TILE_CACHE = 'geophoto-tiles-v1';

const APP_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  'https://cdn.tailwindcss.com',
  'https://cdn.jsdelivr.net/npm/exifr/dist/full.umd.js',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'
];

// Hosts whose responses are treated as map tiles (cache-first, long-lived).
const TILE_RE = /tile\.openstreetmap\.org|server\.arcgisonline\.com|\/MapServer\/tile\//;

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(APP_CACHE);
    // allSettled so one unreachable CDN doesn't abort the whole install.
    await Promise.allSettled(APP_ASSETS.map((u) => cache.add(u)));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== APP_CACHE && k !== TILE_CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = req.url;

  // Map tiles: cache-first, fall back to network, then cache the result.
  if (TILE_RE.test(url)) {
    e.respondWith((async () => {
      const cache = await caches.open(TILE_CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
        return res;
      } catch (err) {
        return hit || Response.error();
      }
    })());
    return;
  }

  // App shell + libraries: stale-while-revalidate.
  e.respondWith((async () => {
    const cached = await caches.match(req);
    const network = fetch(req).then((res) => {
      if (res && res.ok && (url.startsWith(self.location.origin) || res.type === 'cors')) {
        const copy = res.clone();
        caches.open(APP_CACHE).then((c) => c.put(req, copy));
      }
      return res;
    }).catch(() => cached);
    return cached || network;
  })());
});
