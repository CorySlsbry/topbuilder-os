// Offline shell for the field app. Network-first for pages/API (fresh when
// online), cache fallback for the /field shell + static assets when not.
// Cost DATA is handled by the outbox in the page, not here — the worker only
// keeps the shell loadable with no signal.
const SHELL_CACHE = "tb-shell-v1";
const SHELL_URLS = ["/field", "/manifest.webmanifest", "/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_URLS)),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // never interfere with writes
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // API reads: network only (the pages have their own offline fallbacks).
  if (url.pathname.startsWith("/api/")) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        // Keep the shell fresh whenever we're online.
        const copy = res.clone();
        caches.open(SHELL_CACHE).then((cache) => {
          if (res.ok) void cache.put(req, copy);
        });
        return res;
      })
      .catch(async () => {
        const cached = await caches.match(req);
        if (cached) return cached;
        // Any uncached page falls back to the field shell.
        const shell = await caches.match("/field");
        return shell ?? Response.error();
      }),
  );
});
