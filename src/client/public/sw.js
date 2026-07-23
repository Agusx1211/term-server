const LEGACY_CACHE_PREFIX = "workbox-precache";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(cleanUpLegacyWorker());
});

async function cleanUpLegacyWorker() {
  const cacheNames = await caches.keys();
  const legacyCaches = cacheNames.filter((name) => name.startsWith(LEGACY_CACHE_PREFIX));
  await Promise.all(legacyCaches.map((name) => caches.delete(name)));
  await self.clients.claim();

  if (!legacyCaches.length) return;
  const windows = await self.clients.matchAll({ type: "window" });
  for (const client of windows) {
    void client.navigate(client.url).catch(() => {
      // A client can disappear while the replacement worker activates.
    });
  }
}

self.addEventListener("fetch", (event) => {
  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request));
  }
});
