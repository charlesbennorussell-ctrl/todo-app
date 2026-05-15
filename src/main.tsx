import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { LiveblocksProvider, RoomProvider, ClientSideSuspense } from '@liveblocks/react/suspense';
import App from './App';
import MobileApp from './MobileApp';
import './index.css';
import './liveblocks.config';
import { initialTasks, initialProjects, initialClients, initialPeople } from './data';

// Mobile-vs-desktop router. matchMedia is reactive — if the user rotates an
// iPad mid-session (or resizes a desktop browser into mobile-width), the app
// swaps shells. 767px is the standard Tailwind `md` breakpoint, matching the
// width where the desktop's 4-column layout starts feeling cramped.
const MOBILE_BREAKPOINT = '(max-width: 767px)';
function Shell() {
  const [isMobile, setIsMobile] = useState<boolean>(() => typeof window !== 'undefined' && window.matchMedia(MOBILE_BREAKPOINT).matches);
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_BREAKPOINT);
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return isMobile ? <MobileApp /> : <App />;
}

const publicApiKey = import.meta.env.VITE_LIVEBLOCKS_PUBLIC_KEY as string | undefined;
const roomId = (import.meta.env.VITE_ROOM_ID as string | undefined) || 'todo-app-v3';

const Loading = () => (
  <div style={{ minHeight: '100vh', background: '#282828', color: '#666', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'sans-serif' }}>
    Connecting…
  </div>
);

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
            <Shell />
          </ClientSideSuspense>
        </RoomProvider>
      </LiveblocksProvider>
    ) : (
      <Missing />
    )}
  </React.StrictMode>
);
