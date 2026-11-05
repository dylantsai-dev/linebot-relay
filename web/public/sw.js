/* ディランボット 三代目 — console service worker */
const CACHE = '三代目-shell-v1';
const PRECACHE = ['/console/', '/console/index.html', '/console/manifest.webmanifest', '/console/icon-192.png', '/console/icon-512.png', '/console/favicon.svg', '/console/apple-touch-icon.png'];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(PRECACHE.map(url => cache.add(url).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // API / streams / webhooks: always network
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/hook') || url.pathname.startsWith('/webhook') || url.pathname === '/health' || url.pathname === '/sessions') return;
  if (!url.pathname.startsWith('/console')) return;

  // Navigations: network first, fall back to cached shell
  if (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')) {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE);
        cache.put('/console/index.html', fresh.clone()).catch(() => {});
        return fresh;
      } catch {
        return (await caches.match('/console/index.html')) || (await caches.match('/console/')) || Response.error();
      }
    })());
    return;
  }

  // Static assets under /console/: stale-while-revalidate
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req);
    const network = fetch(req).then(res => {
      if (res.ok) cache.put(req, res.clone()).catch(() => {});
      return res;
    }).catch(() => cached);
    return cached || network;
  })());
});
