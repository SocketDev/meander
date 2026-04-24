/* ------------------------------------------------------------------
 * Meander service worker — cache-first for same-origin static
 * assets, network-first for the rendered HTML pages so deploys
 * are picked up on the next revisit.
 *
 * Versioning:
 *   CACHE_VERSION is a placeholder replaced at generate time so
 *   every build produces different SW bytes; the browser's
 *   update check detects the change, fires `install` + `activate`,
 *   and the activate handler prunes the old cache.
 *
 *   Fallback literal 'dev' keeps file-serve working in dev mode
 *   before the build step runs.
 * ------------------------------------------------------------------ */

const CACHE_VERSION = "__MEANDER_CACHE_VERSION__";
const CACHE_NAME = `mdr-cache-${CACHE_VERSION}`;

/* Derive base path from the SW's own scope so the same file works
 * at the origin root (/) or under any subdirectory (e.g. GitHub
 * Pages' /<repo>/). */
const BASE_PATH = self.location.pathname.replace(/\/[^/]*$/, "");

/* Minimal precache — just the walkthrough stylesheet. Everything
 * else is cached lazily on first request via the fetch handler's
 * cache-first path. This keeps first-install cost small (a few
 * KB) while still giving the reader offline-replay of anything
 * they've visited. */
const PRECACHE = [`${BASE_PATH}/walkthrough.css`];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      /* Individual `add` with catch so a missing asset doesn't
       * abort the whole install. Atomic `addAll` would roll back
       * the entire cache on a single 404. */
      Promise.all(PRECACHE.map((url) => cache.add(url).catch(() => null))),
    ),
  );
  /* Activate immediately so the new worker starts serving without
   * waiting for all clients to navigate away. */
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith("mdr-cache-") && k !== CACHE_NAME)
            .map((k) => caches.delete(k)),
        ),
      ),
  );
  /* Take over uncontrolled pages — on first install there's no
   * prior SW, so this is the only way existing tabs opt into
   * caching. */
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  /* Only cache GETs; POST/PUT/DELETE bypass the SW so mutations
   * hit the network. */
  if (request.method !== "GET") {
    return;
  }
  const url = new URL(request.url);
  /* Same-origin only. Cross-origin (hljs CDN, any API backend)
   * goes straight to the network — we don't want to cache API
   * responses behind our version key. */
  if (url.origin !== self.location.origin) {
    return;
  }
  /* Skip common API paths explicitly. */
  if (url.pathname.startsWith("/api/")) {
    return;
  }

  /* Navigations (top-level HTML) are network-first. Stale HTML
   * is the worst cache-miss mode — the page ships pointing at
   * asset URLs that may have moved between deploys. Fall back
   * to cache only on offline. */
  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request));
    return;
  }

  event.respondWith(cacheFirst(request));
});

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);
    if (cached) {
      return cached;
    }
    throw new Error("offline and no cached copy");
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  const networkFetch = fetch(request)
    .then((response) => {
      /* Only cache 2xx — don't poison the cache with 500s / 404s
       * from a transient backend glitch. Fire-and-forget `put`
       * with a catch so quota errors don't surface. */
      if (response.ok) {
        cache.put(request, response.clone()).catch(() => {});
      }
      return response;
    })
    .catch(() => null);
  if (cached) {
    return cached;
  }
  const fresh = await networkFetch;
  return fresh ?? Response.error();
}
