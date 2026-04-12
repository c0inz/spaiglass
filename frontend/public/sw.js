/**
 * SpAIglass service worker — minimal network-first strategy.
 *
 * The SW exists primarily to satisfy the PWA installability requirement.
 * All API calls and WebSocket traffic go straight to the network. Static
 * assets (JS/CSS chunks) are cached on first load so the app shell can
 * paint even if the device momentarily loses connectivity.
 */

const CACHE_NAME = "spaiglass-v1";

// Cache the app shell on install so subsequent loads are instant.
self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // Purge old caches from previous versions.
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((n) => n !== CACHE_NAME)
          .map((n) => caches.delete(n)),
      ),
    ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Never cache API calls, WebSocket upgrades, or chrome-extension requests.
  if (
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/ws") ||
    event.request.method !== "GET" ||
    url.protocol === "chrome-extension:"
  ) {
    return;
  }

  // Static assets (hashed filenames) — cache-first, they're immutable.
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.match(event.request).then(
        (cached) =>
          cached ||
          fetch(event.request).then((response) => {
            if (response.ok) {
              const clone = response.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
            }
            return response;
          }),
      ),
    );
    return;
  }

  // Everything else (HTML, icons) — network-first with cache fallback.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request)),
  );
});
