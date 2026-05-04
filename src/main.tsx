import React from 'react';
import ReactDOM from 'react-dom/client';
import { LiveblocksProvider, RoomProvider, ClientSideSuspense } from '@liveblocks/react/suspense';
import App from './App';
import './index.css';
import './liveblocks.config';
import { initialTasks, initialProjects, initialClients, initialPeople } from './data';

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
          }}
        >
          <ClientSideSuspense fallback={<Loading />}>
            <App />
          </ClientSideSuspense>
        </RoomProvider>
      </LiveblocksProvider>
    ) : (
      <Missing />
    )}
  </React.StrictMode>
);
