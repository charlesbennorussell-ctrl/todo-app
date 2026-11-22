// DEV ONLY. Stand-in for '@liveblocks/react' (the NON-suspense entry), aliased by
// dev/vite.mock.config.ts. Shares lb-mock.tsx's store and its simulated load, and implements
// what src/instant.ts uses: useRoom (a fake room), useStorage (null until loaded) and
// useMutation. Writes land in the in-memory store and nowhere else.
import { useCallback, useRef, useSyncExternalStore } from 'react';
import { __root, __storage, __subscribe, __isLoaded, __loadPromise } from './lb-mock';
export { LiveblocksProvider, RoomProvider, ClientSideSuspense } from './lb-mock';

const rootObject = {
  get: (key: string) => __root()[key],
  set: (key: string, value: unknown) => __storage.set(key, value),
  toImmutable: () => __root(),
};

const room = {
  getStorageSnapshot: () => (__isLoaded() ? rootObject : null),
  getStorage: () => __loadPromise().then(() => ({ root: rootObject })),
  batch: (fn: () => void) => fn(),
  subscribe: (_node: unknown, cb: () => void) => __subscribe(cb),
  getSelf: () => null,
  getOthers: () => [],
  updatePresence: () => {},
  reconnect: () => { console.log('[mock] reconnect()'); },
};

export function useRoom() { return room; }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useStorage<T>(selector: (root: any) => T): T | null {
  const cache = useRef<{ root: unknown; loaded: boolean; value: T | null } | null>(null);
  const get = () => {
    const r = __root();
    const loaded = __isLoaded();
    if (cache.current && cache.current.root === r && cache.current.loaded === loaded) return cache.current.value;
    const value = loaded ? selector(r) : null;
    cache.current = { root: r, loaded, value };
    return value;
  };
  return useSyncExternalStore(__subscribe, get, get);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useMutation<A extends unknown[], R>(cb: (ctx: any, ...args: A) => R, _deps?: unknown[]) {
  const ref = useRef(cb);
  ref.current = cb;
  return useCallback((...args: A) => {
    if (!__isLoaded()) throw new Error('[mock] mutation before Storage loaded');
    return ref.current({ storage: __storage }, ...args);
  }, []);
}
