/*
 * EmuTrack service worker.
 * Caches the application shell for offline access to the interface and the
 * locally stored configuration. Release checks always go to the network and
 * are never cached (cross-origin requests are left untouched entirely).
 *
 * All paths are resolved relative to the service worker's scope, so the app
 * works both at a domain root and on a sub-path such as
 * https://<user>.github.io/<repo>/ (GitHub Pages project sites).
 */
const VERSION = 'emutrack-v7'
const ROOT = new URL('./', self.registration.scope || self.location.href)
// Path prefix of hashed build assets, correct for both domain-root and
// sub-path deployments (e.g. /emutrack/_next/static/ on GitHub Pages).
const STATIC_PREFIX = ROOT.pathname.replace(/\/$/, '') + '/_next/static/'
// Request destinations that are safe to cache. Data requests made with
// fetch() (destination 'empty', e.g. /api/release-proxy) are excluded so
// release lookups always hit the network and are never served from cache.
const STATIC_DESTINATIONS = new Set([
  'script',
  'style',
  'image',
  'font',
  'manifest',
  'audio',
  'video',
  'worker',
])
const PRECACHE = [
  ROOT.href,
  new URL('manifest.webmanifest', ROOT).href,
  new URL('icon-192.png', ROOT).href,
  new URL('icon-512.png', ROOT).href,
  new URL('maskable-512.png', ROOT).href,
  new URL('apple-touch-icon.png', ROOT).href,
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return

  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return // never intercept GitHub API / release downloads

  // Navigations: network-first with cache fallback (offline app shell).
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone()
          caches.open(VERSION).then((cache) => cache.put(req, copy)).catch(() => {})
          return res
        })
        .catch(() =>
          caches
            .match(req)
            .then((cached) => cached ?? caches.match(ROOT.href))
            .then(
              (cached) =>
                cached ??
                new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } })
            )
        )
    )
    return
  }

  // Same-origin static assets only: stale-while-revalidate. API/data
  // requests (destination 'empty') are never intercepted — release checks
  // must always reach the network, and a cached API answer would hide
  // outages and serve stale releases.
  if (!STATIC_DESTINATIONS.has(req.destination) && !url.pathname.startsWith(STATIC_PREFIX)) {
    return
  }
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone()
            caches.open(VERSION).then((cache) => cache.put(req, copy)).catch(() => {})
          }
          return res
        })
        .catch(() => cached)
      return cached ?? network
    })
  )
})
