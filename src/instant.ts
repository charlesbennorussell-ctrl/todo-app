// INSTANT LAUNCH — the phone opens on its last-synced copy of the room and hands over to live
// data the moment the room answers. main.tsx decides WHEN this path is taken; this module is the
// data layer that makes it safe.
//
// Why: a cold launch used to wait on five network steps IN SEQUENCE before drawing anything —
// the app download, the Supabase session, the members query, a Liveblocks token from an edge
// function that cold-starts, then the room's whole Storage. On a phone that was ~12 s of black
// screen every time iOS had evicted the app.
//
// READING — useStorage(selector) is a drop-in for Liveblocks' hook:
//   • live            → Liveblocks' own (non-suspense) useStorage: exactly the old behaviour;
//   • before that     → the selector applied to the saved snapshot;
//   • no snapshot     → suspends until live (first launch on a device, and always on the
//                       desktop, which never primes one) — exactly what the suspense hook did.
// "Live" flips only once Storage has loaded AND every edit made in the meantime has been
// replayed into it, so the screen never shows live data minus your own edits.
//
// WRITING — useMutation(cb, deps) is a drop-in too. Live: the real mutation. Before: the callback
// runs against the snapshot, so the screen updates at once, and is QUEUED; when Storage loads the
// queue replays against the live root, in order, in one batch.
//
// THE RULE THAT MAKES REPLAY SAFE: every mutation in this app reads the CURRENT value inside the
// callback (storage.get → modify → storage.set). A queued "complete task X" therefore re-applies
// to whatever the room holds by then; it never writes the snapshot's copy of the array back. The
// room is whole-array last-writer-wins, so a callback that set a value computed OUTSIDE itself
// (from rendered state) would silently overwrite newer data on replay. Never add one.
//
// Replays run with Date.now() pinned to the moment of the original call, so an id minted inside
// a callback (useAddClient's `client-${Date.now()}`) comes out identical to the one the caller
// already received and used.
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { useRoom, useStorage as useLbStorage, useMutation as useLbMutation } from '@liveblocks/react';

type Root = Record<string, unknown>;
type MutationCtx = {
  storage: { get: (key: string) => unknown; set: (key: string, value: unknown) => void };
  self: unknown;
  others: unknown;
  setMyPresence: (patch: unknown) => void;
};
type Pending = { cb: (ctx: MutationCtx, ...args: unknown[]) => unknown; args: unknown[]; at: number };

// ── Module state (one room per page) ────────────────────────────────────────────────────────
let snapRoot: Root | null = null;
let pending: Pending[] = [];
let live = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
let resolveLive: () => void = () => {};
const livePromise = new Promise<void>((resolve) => { resolveLive = resolve; });

/** Seed the snapshot the UI renders from until the room is live. */
export function primeSnapshot(root: Root): void { snapRoot = root; emit(); }
export function hasSnapshot(): boolean { return snapRoot !== null; }
export function isLive(): boolean { return live; }
export function pendingCount(): number { return pending.length; }
/** Resolves once live (Storage loaded, queued edits replayed). */
export function whenLive(): Promise<void> { return livePromise; }

const getLive = () => live;
export function useIsLive(): boolean { return useSyncExternalStore(subscribe, getLive, getLive); }

function withPinnedNow<T>(at: number, fn: () => T): T {
  const realNow = Date.now;
  Date.now = () => at;
  try { return fn(); } finally { Date.now = realNow; }
}

// ── Hooks ───────────────────────────────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useStorage<T>(selector: (root: any) => T): T {
  const liveValue = useLbStorage(selector as never) as T | null;
  const isLiveNow = useSyncExternalStore(subscribe, getLive, getLive);
  // useSyncExternalStore needs a stable result while the snapshot is unchanged.
  const cache = useRef<{ root: Root | null; value: T } | null>(null);
  const getSnap = () => {
    if (cache.current && cache.current.root === snapRoot) return cache.current.value;
    const value = snapRoot ? selector(snapRoot) : (undefined as T);
    cache.current = { root: snapRoot, value };
    return value;
  };
  const snapValue = useSyncExternalStore(subscribe, getSnap, getSnap);
  if (isLiveNow) return liveValue as T;
  if (snapRoot) return snapValue;
  // Nothing saved to show: behave like the suspense hook did.
  throw livePromise;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useMutation<A extends unknown[], R>(cb: (ctx: any, ...args: A) => R, deps: unknown[]): (...args: A) => R {
  const real = useLbMutation(cb as never, deps) as unknown as (...args: A) => R;
  const cbRef = useRef(cb);
  cbRef.current = cb;
  return useCallback((...args: A): R => {
    if (live) return real(...args);
    const at = Date.now();
    const fn = cbRef.current as unknown as Pending['cb'];
    pending.push({ cb: fn, args, at });
    let result = undefined as R;
    if (snapRoot) {
      let draft = snapRoot;
      const ctx: MutationCtx = {
        storage: { get: (k) => draft[k], set: (k, v) => { draft = { ...draft, [k]: v }; } },
        self: null, others: [], setMyPresence: () => {},
      };
      try { result = withPinnedNow(at, () => fn(ctx, ...args)) as R; } catch (e) { console.error('[instant] optimistic apply failed', e); }
      snapRoot = draft;
    }
    emit();
    return result;
  }, [real]);
}

// ── Going live ──────────────────────────────────────────────────────────────────────────────
// useRoom's last overload (allowOutsideRoom) admits null; inside RoomProvider it never is.
type RoomLike = NonNullable<ReturnType<typeof useRoom>>;

function goLive(room: RoomLike): void {
  if (live) return;
  const root = room.getStorageSnapshot();
  if (!root) return;
  const queue = pending;
  pending = [];
  if (queue.length) {
    room.batch(() => {
      for (const p of queue) {
        const ctx: MutationCtx = {
          storage: root as unknown as MutationCtx['storage'],
          self: room.getSelf(),
          others: room.getOthers(),
          setMyPresence: (patch) => room.updatePresence(patch as never),
        };
        try { withPinnedNow(p.at, () => p.cb(ctx, ...p.args)); } catch (e) { console.error('[instant] replay failed', e); }
      }
    });
  }
  live = true;
  emit();
  resolveLive();
}

/**
 * Mount once inside RoomProvider, OUTSIDE any Suspense boundary. Flips the app live when Storage
 * loads (replaying queued edits first) and — given a persistKey — keeps this device's snapshot
 * fresh: once on load, then debounced on every change, and immediately when the app is hidden
 * (iOS may kill a backgrounded app without another chance).
 */
export function LiveBridge({ persistKey }: { persistKey: { roomId: string; userId: string } | null }) {
  const room = useRoom();
  const roomId = persistKey?.roomId;
  const userId = persistKey?.userId;
  useEffect(() => {
    let cancelled = false;
    let unsub: (() => void) | null = null;
    let timer = 0;
    const save = () => {
      timer = 0;
      const r = room.getStorageSnapshot();
      if (!r || !roomId || !userId) return;
      // (Cast: this room's Storage type doesn't satisfy Liveblocks' LSON constraint, which
      // strips LiveObject's methods from the inferred type. The runtime object has them.)
      const root = (r as unknown as { toImmutable: () => Root }).toImmutable();
      void writeSnapshot({ v: 1, roomId, userId, savedAt: Date.now(), root }).catch(() => {});
    };
    const schedule = () => { if (!timer) timer = window.setTimeout(save, 1200); };
    const onHide = () => {
      if (document.visibilityState !== 'hidden' || !live) return;
      if (timer) window.clearTimeout(timer);
      save();
    };
    void room.getStorage().then(({ root }) => {
      if (cancelled) return;
      goLive(room);
      if (!roomId || !userId) return;
      save();
      unsub = room.subscribe(root as never, schedule, { isDeep: true });
    });
    if (roomId && userId) {
      document.addEventListener('visibilitychange', onHide);
      window.addEventListener('pagehide', onHide);
    }
    return () => {
      cancelled = true;
      unsub?.();
      if (timer) window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onHide);
    };
  }, [room, roomId, userId]);
  return null;
}

/** Ask the room to reconnect now (the phone's "Offline" label). */
export function useReconnect(): () => void {
  const room = useRoom();
  return useCallback(() => room.reconnect(), [room]);
}

// ── The snapshot store (IndexedDB) ──────────────────────────────────────────────────────────
// A CACHE, not a backup: main.tsx's clearLocalCache() deletes it with the other caches, which is
// right — the room is the source of truth. (The backup store is `ctrl-project-backups`, which
// nothing here touches.)
type Snapshot = { v: 1; roomId: string; userId: string; savedAt: number; root: Root };
const DB_NAME = 'ctrl-room-cache';
const STORE = 'snapshots';
let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
    req.onsuccess = () => {
      const db = req.result;
      // Another tab deleting the db (clearLocalCache) must not leave us holding a dead handle.
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => { dbPromise = null; reject(req.error); };
    req.onblocked = () => { dbPromise = null; reject(new Error('indexedDB blocked')); };
  });
  return dbPromise;
}

async function readSnapshot(roomId: string): Promise<Snapshot | null> {
  const db = await openDb();
  return new Promise<Snapshot | null>((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(roomId);
    req.onsuccess = () => resolve((req.result as Snapshot | undefined) ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function writeSnapshot(s: Snapshot): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(s, s.roomId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** Forget every saved snapshot — on sign-out or lost access, so the next person sees nothing. */
export async function clearSnapshots(): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
    });
  } catch { /* nothing saved, or IndexedDB unavailable */ }
}

/**
 * Load this user's snapshot of `roomId` and prime the store with it. Gives up after `timeoutMs`
 * — IndexedDB on iOS occasionally hangs on open, and the old path is always there to fall back on.
 */
export async function bootFromSnapshot(roomId: string, userId: string, timeoutMs = 500): Promise<boolean> {
  try {
    const snap = await Promise.race([
      readSnapshot(roomId),
      new Promise<null>((resolve) => window.setTimeout(() => resolve(null), timeoutMs)),
    ]);
    if (!snap || snap.v !== 1 || snap.roomId !== roomId || snap.userId !== userId || !snap.root) return false;
    primeSnapshot(snap.root);
    return true;
  } catch {
    return false;
  }
}
