// DEV ONLY. An in-memory stand-in for '@liveblocks/react/suspense', swapped in by
// dev/vite.mock.config.ts so the REAL desktop App (and MobileApp) can run on fake data with no
// room, no auth and no network. Implements exactly what the app imports: useStorage,
// useMutation, useUndo, useRedo — plus pass-through providers in case an entry imports them.
// Writes land in this module's `root` and nowhere else.
import { useCallback, useRef, useSyncExternalStore, type ReactNode } from 'react';

type Root = Record<string, unknown>;
let root: Root = {};
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const __subscribe = subscribe;

// Simulated room LOAD, for testing the instant-launch path (src/instant.ts). Loaded by default;
// __delayLoad(ms) — or __delayLoad(null) for "until __finishLoad() is called" — makes Storage
// unavailable until then: the suspense hooks below suspend, the plain ones (lb-mock-plain.tsx)
// return null, exactly like Liveblocks before the room answers.
let loaded = true;
let resolveLoad: () => void = () => {};
let loadPromise: Promise<void> = Promise.resolve();
export function __delayLoad(ms: number | null) {
  loaded = false;
  loadPromise = new Promise<void>((r) => { resolveLoad = r; });
  if (ms != null) window.setTimeout(() => __finishLoad(), ms);
}
export function __finishLoad() { if (loaded) return; loaded = true; resolveLoad(); emit(); }
export function __isLoaded() { return loaded; }
export function __loadPromise() { return loadPromise; }

/** Replace the whole store (the page seeds it before mounting the app). */
export function __seed(next: Root) { root = next; emit(); }
/** Read the store (exposed on window by the page for console checks). */
export function __root(): Root { return root; }

const storage = {
  get: (key: string) => root[key],
  set: (key: string, value: unknown) => { root = { ...root, [key]: value }; emit(); },
};
export const __storage = storage;

export function useStorage<T>(selector: (root: any) => T): T {
  if (!loaded) throw loadPromise;
  // useSyncExternalStore needs a stable snapshot while the store is unchanged; selectors may
  // build fresh objects, so cache per store identity.
  const cache = useRef<{ root: Root; value: T } | null>(null);
  const get = () => {
    if (cache.current && cache.current.root === root) return cache.current.value;
    const value = selector(root);
    cache.current = { root, value };
    return value;
  };
  return useSyncExternalStore(subscribe, get, get);
}

export function useMutation<A extends unknown[], R>(cb: (ctx: { storage: typeof storage }, ...args: A) => R, _deps?: unknown[]) {
  const ref = useRef(cb);
  ref.current = cb;
  return useCallback((...args: A) => ref.current({ storage }, ...args), []);
}

export function useUndo() { return () => { /* no history in the mock */ }; }
export function useRedo() { return () => { /* no history in the mock */ }; }

type PassProps = { children?: ReactNode | (() => ReactNode) };
const Pass = ({ children }: PassProps) => <>{typeof children === 'function' ? (children as () => ReactNode)() : children}</>;
export const LiveblocksProvider = Pass;
export const RoomProvider = Pass;
export const ClientSideSuspense = Pass;
