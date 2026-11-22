// Ctrl-Project service worker — PHONE launch speed. Registered by main.tsx only for the phone
// shell in a production build, never inside the desktop (Tauri) app.
//
// What it does: serves the app's own files from the device so a cold launch downloads nothing.
//   • The page (index.html): the copy saved on the device, at once. The network copy is fetched
//     in the background and saved — together with every bundle it references, BEFORE the page
//     itself is swapped — for the next launch. A deploy therefore reaches the phone one launch
//     later on its own, or immediately through MobileApp's self-update, which navigates with
//     ?rv= — and ?rv= always goes to the network.
//   • Hashed bundles (/assets/), fonts, icons: from the device; fetched once, kept until a newer
//     page stops referencing them.
//   • Everything else — version.json, Supabase, Liveblocks, any other origin — is untouched.
//
// KILL SWITCH: if this ever misbehaves, deploy a sw.js whose install handler calls
// self.skipWaiting() and whose activate handler deletes every 'ctrl-' cache and calls
// self.registration.unregister(). Phones pick it up on their next launch (registration uses
// updateViaCache: 'none', so this file itself is never served from a cache).
const V = 1;
const SHELL = `ctrl-shell-v${V}`;
const ASSETS = `ctrl-assets-v${V}`;
const SCOPE = self.registration.scope;               // e.g. https://host/todo-app/
const SCOPE_PATH = new URL(SCOPE).pathname;          // e.g. /todo-app/
const INDEX = SCOPE;                                 // one cache key for the page, whatever the query

self.addEventListener('install', (event) => {
  self.skipWaiting();
  // Save the current page and its bundles now, so the very next launch is already local.
  event.waitUntil(refreshShell().catch(() => {}));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('ctrl-') && k !== SHELL && k !== ASSETS).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

/** Bundles a page references (Vite writes them as src/href="…/assets/…"). */
function assetUrls(html) {
  return [...html.matchAll(/(?:src|href)="([^"]*\/assets\/[^"]+)"/g)].map((m) => new URL(m[1], INDEX).href);
}

/** Make `html` the saved page: cache its bundles first, then the page, then drop stale bundles. */
async function adoptShell(html) {
  const urls = assetUrls(html);
  const assets = await caches.open(ASSETS);
  for (const u of urls) {
    if (await assets.match(u)) continue;
    const res = await fetch(u, { credentials: 'same-origin' });
    // Never save a page whose bundle we failed to get — that page could not run offline.
    if (!res.ok) throw new Error(`asset ${res.status}: ${u}`);
    await assets.put(u, res);
  }
  const shell = await caches.open(SHELL);
  await shell.put(INDEX, new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
  const keep = new Set(urls);
  for (const req of await assets.keys()) {
    if (req.url.includes('/assets/') && !keep.has(req.url)) await assets.delete(req);
  }
}

async function refreshShell() {
  const res = await fetch(INDEX, { cache: 'no-store', credentials: 'same-origin' });
  if (!res.ok) return;
  await adoptShell(await res.text());
}

async function servePage(event, url) {
  const shell = await caches.open(SHELL);
  const cached = await shell.match(INDEX);
  // A self-update navigation must see the new page, not the saved one.
  if (cached && !url.searchParams.has('rv')) {
    event.waitUntil(refreshShell().catch(() => {}));
    return cached;
  }
  try {
    const res = await fetch(url.href, { cache: 'no-store', credentials: 'same-origin' });
    if (res.ok) {
      const copy = res.clone();
      event.waitUntil(copy.text().then(adoptShell).catch(() => {}));
    }
    return res;
  } catch (e) {
    if (cached) return cached;
    throw e;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(ASSETS);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok && res.type === 'basic') await cache.put(request, res.clone());
  return res;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(SCOPE_PATH)) return;
  const rel = url.pathname.slice(SCOPE_PATH.length);
  if (req.mode === 'navigate') {
    if (rel === '' || rel === 'index.html') event.respondWith(servePage(event, url));
    return;
  }
  if (rel.startsWith('assets/') || rel.startsWith('fonts/') || rel.startsWith('icons/')) {
    event.respondWith(cacheFirst(req));
  }
  // version.json, sw.js, the manifest and everything else: straight to the network.
});
