const CACHE_PREFIX = "quest-control-shell-";
const CACHE_NAME = `${CACHE_PREFIX}2`;
const SHELL = ["/", "/manifest.webmanifest", "/icons/quest-control-192.png", "/icons/quest-control-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.mode !== "navigate" || url.origin !== self.location.origin) return;
  event.respondWith(fetch(event.request).catch(() => caches.match("/")));
});
