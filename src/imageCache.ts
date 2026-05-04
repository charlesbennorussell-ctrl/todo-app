// IndexedDB-backed image cache. Reduces network round-trips for the DAM grid: the first time
// a Supabase URL is rendered, we fetch the WebP, stash the blob in IDB keyed by URL, then hand
// back an in-memory object URL. Subsequent renders hit the in-memory map and skip both the
// network and the IDB read entirely. Object URLs decode much faster than re-fetched HTTP
// responses, which is what was causing the hover-latency + scroll-stutter.

const DB_NAME = 'focus-images-cache';
const STORE = 'blobs';
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;
function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function idbGet(url: string): Promise<Blob | null> {
  return openDb().then((db) => new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(url);
    req.onsuccess = () => resolve((req.result as Blob | undefined) ?? null);
    req.onerror = () => resolve(null);
  })).catch(() => null);
}

function idbPut(url: string, blob: Blob): Promise<void> {
  return openDb().then((db) => new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(blob, url);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  })).catch(() => undefined);
}

function idbDelete(url: string): Promise<void> {
  return openDb().then((db) => new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(url);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  })).catch(() => undefined);
}

// In-memory map of remote URL → object URL. Object URLs are session-scoped (no need to
// persist) and dirt cheap to create from a cached blob.
const objectUrlCache = new Map<string, string>();
// In-flight fetches dedupe parallel calls for the same URL during initial paint.
const inFlight = new Map<string, Promise<string>>();

// Resolves a Supabase (or any HTTPS) image URL to a same-origin object URL backed by IDB.
// The returned promise is synchronous-fast on cache hits and only does network on the first
// view of a given URL per session.
export function getCachedImageUrl(remoteUrl: string): Promise<string> {
  if (!remoteUrl) return Promise.resolve('');
  if (!remoteUrl.startsWith('http')) return Promise.resolve(remoteUrl); // dataUrls / object URLs already
  const cached = objectUrlCache.get(remoteUrl);
  if (cached) return Promise.resolve(cached);
  const pending = inFlight.get(remoteUrl);
  if (pending) return pending;
  const p = (async () => {
    try {
      let blob = await idbGet(remoteUrl);
      if (!blob) {
        const resp = await fetch(remoteUrl, { cache: 'force-cache' });
        if (!resp.ok) return remoteUrl;
        blob = await resp.blob();
        idbPut(remoteUrl, blob);
      }
      const objUrl = URL.createObjectURL(blob);
      objectUrlCache.set(remoteUrl, objUrl);
      return objUrl;
    } catch {
      return remoteUrl;
    } finally {
      inFlight.delete(remoteUrl);
    }
  })();
  inFlight.set(remoteUrl, p);
  return p;
}

// Synchronous lookup — returns the cached object URL if we already have one in memory. Lets
// React render the cached source on first paint without an effect tick. Returns null when
// the URL hasn't been seen yet (caller should kick off getCachedImageUrl in an effect).
export function getCachedImageUrlSync(remoteUrl: string | undefined): string | null {
  if (!remoteUrl) return null;
  if (!remoteUrl.startsWith('http')) return remoteUrl;
  return objectUrlCache.get(remoteUrl) ?? null;
}

// Drop the cache entry when an image is deleted. Frees IDB and the object URL.
export function evictCachedImage(remoteUrl: string): void {
  if (!remoteUrl) return;
  const obj = objectUrlCache.get(remoteUrl);
  if (obj) {
    URL.revokeObjectURL(obj);
    objectUrlCache.delete(remoteUrl);
  }
  idbDelete(remoteUrl);
}
