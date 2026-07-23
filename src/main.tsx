import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { LiveblocksProvider, RoomProvider, ClientSideSuspense } from '@liveblocks/react/suspense';
import App from './App';
import './index.css';
import './liveblocks.config';
import { initialTasks, initialProjects, initialClients, initialPeople } from './data';

const publicApiKey = import.meta.env.VITE_LIVEBLOCKS_PUBLIC_KEY as string | undefined;
const roomId = (import.meta.env.VITE_ROOM_ID as string | undefined) || 'todo-app-v3';

// Wipe the browser's local CACHES only: the Liveblocks offline room cache + the `focus-images-cache`
// blob store. Both are caches — the room's source of truth is the Liveblocks server and images
// re-fetch from Supabase — so dropping them just forces a clean re-sync, never losing real data.
// CRITICAL: the `ctrl-project-backups` IndexedDB store is the user's local BACKUP safety net, NOT a
// cache — it must survive a reset (it's exactly what you'd restore from if the room were lost). Any
// db whose name mentions "backup" is protected. localStorage (focus-image binaries + settings) is
// likewise left untouched.
const PROTECTED_DB = /backup/i;
async function clearLocalCache(): Promise<void> {
  const names = new Set<string>(['focus-images-cache']);
  try {
    if (typeof indexedDB !== 'undefined' && indexedDB.databases) {
      const dbs = await indexedDB.databases();
      dbs.forEach((d) => { if (d.name) names.add(d.name); });
    }
  } catch { /* enumeration unsupported — fall back to the known cache name */ }
  await Promise.all([...names]
    .filter((name) => !PROTECTED_DB.test(name))
    .map((name) => new Promise<void>((resolve) => {
      try {
        const req = indexedDB.deleteDatabase(name);
        req.onsuccess = req.onerror = req.onblocked = () => resolve();
      } catch { resolve(); }
    })));
}

// Auto-recovery for a wedged "Connecting…". The Suspense fallback below stays mounted the whole
// time the Liveblocks room is connecting; if it's STILL up after RECOVER_MS the handshake has
// stalled (classic cause: the disk filled and the webview couldn't write its local cache, leaving
// it corrupt). We then auto-reset the local cache once and reload. A per-session attempt counter
// guards against a reload loop — after the one automatic reset we stop and surface a manual button
// rather than reloading forever.
const RECOVER_MS = 10000;
const ATTEMPT_KEY = 'lb-recover-attempts';

// Liveblocks logs "Max number of concurrent connections per room exceeded" to console.error when the
// room's live-connection cap is hit (too many windows/tabs on the same room at once). Detect it so
// the recovery screen can tell the user to CLOSE other windows — NOT reload, because every reload
// opens another connection and keeps the cap saturated (the auto-recovery was making it worse).
let concurrencyLimited = false;
if (typeof console !== 'undefined') {
  const origError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    try { if (args.some((a) => typeof a === 'string' && /concurrent connections/i.test(a))) concurrencyLimited = true; } catch { /* ignore */ }
    origError(...args);
  };
}

const Loading = () => {
  const [phase, setPhase] = useState<'connecting' | 'stuck' | 'concurrency'>('connecting');
  useEffect(() => {
    // Watch for the concurrency-limit error the moment it appears → switch to the "close windows"
    // message and STOP (never reload — that just opens another connection).
    const poll = window.setInterval(() => { if (concurrencyLimited) setPhase('concurrency'); }, 1200);
    const t = window.setTimeout(async () => {
      if (concurrencyLimited) { setPhase('concurrency'); return; }
      const attempts = Number(sessionStorage.getItem(ATTEMPT_KEY) || '0');
      if (attempts >= 1) { setPhase('stuck'); return; } // already auto-reset once → hand off to manual
      sessionStorage.setItem(ATTEMPT_KEY, '1');
      await clearLocalCache();
      window.location.reload();
    }, RECOVER_MS);
    return () => { window.clearInterval(poll); window.clearTimeout(t); };
  }, []);
  const manualReset = async () => { await clearLocalCache(); window.location.reload(); };
  const btn: React.CSSProperties = { marginTop: 2, padding: '8px 16px', background: '#7363FF', color: 'white', border: 'none', borderRadius: 6, fontSize: 13, cursor: 'pointer' };
  return (
    <div style={{ minHeight: '100vh', background: '#282828', color: '#666', display: 'flex', flexDirection: 'column', gap: 14, alignItems: 'center', justifyContent: 'center', fontFamily: 'sans-serif', padding: 40, textAlign: 'center' }}>
      {phase === 'concurrency' ? (
        <>
          <div style={{ fontSize: 15, color: '#ccc' }}>Too many windows connected</div>
          <div style={{ fontSize: 13, color: '#7a7a7a', maxWidth: 360, lineHeight: 1.5 }}>
            This room hit its live-connection limit. Close your other Ctrl-Project windows — the main app, the PIP quick-view, and any browser tabs — wait about a minute, then Retry. Your tasks are safe on the server; reloading won't help (it just opens another connection).
          </div>
          <button onClick={() => window.location.reload()} style={btn}>Retry</button>
        </>
      ) : phase === 'stuck' ? (
        <>
          <div style={{ fontSize: 15, color: '#ccc' }}>Still can't connect</div>
          <div style={{ fontSize: 13, color: '#7a7a7a', maxWidth: 340, lineHeight: 1.5 }}>
            Usually a dropped network or low disk space. Resetting the local cache is safe — your tasks live on the server.
          </div>
          <button onClick={manualReset} style={btn}>Reset local data &amp; reload</button>
        </>
      ) : (
        'Connecting…'
      )}
    </div>
  );
};

// Renders only once the room is connected. Clears the recovery counter so a fresh stall later in
// the same session still earns the full auto-reset treatment.
const Connected = () => {
  useEffect(() => { try { sessionStorage.removeItem(ATTEMPT_KEY); } catch { /* ignore */ } }, []);
  return <App />;
};

const Missing = () => (
  <div style={{ minHeight: '100vh', background: '#282828', color: 'white', padding: 40, fontFamily: 'sans-serif' }}>
    <h2>Missing Liveblocks key</h2>
    <p>Set <code>VITE_LIVEBLOCKS_PUBLIC_KEY</code> in <code>.env.local</code> and restart the dev server.</p>
  </div>
);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {publicApiKey ? (
      <LiveblocksProvider publicApiKey={publicApiKey}>
        <RoomProvider
          id={roomId}
          initialPresence={{ cursor: null }}
          initialStorage={{
            tasks: initialTasks,
            projects: initialProjects,
            clients: initialClients,
            people: initialPeople,
            // Focus-mode storage is metadata-only. Image binaries live in browser
            // localStorage to keep each Liveblocks key under the per-value size cap.
            focusBriefs: {},
            focusSubtasks: {},
            focusImages: {},
            focusReferences: {},
            // Image-folder definitions per bucket. Bucket key = projectKey, taskKey,
            // or `wip:${projectKey}`. Each entry is an ordered list of folders.
            // Images carry an optional `folderId` that points into this list — null /
            // missing = root of the bucket.
            focusImageFolders: {},
          }}
        >
          <ClientSideSuspense fallback={<Loading />}>
            <Connected />
          </ClientSideSuspense>
        </RoomProvider>
      </LiveblocksProvider>
    ) : (
      <Missing />
    )}
  </React.StrictMode>
);
