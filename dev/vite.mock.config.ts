// DEV ONLY. Serves the real app on fake data: http://localhost:5199/dev/app.html
//   node node_modules/vite/bin/vite.js --config dev/vite.mock.config.ts
// '@liveblocks/react/suspense' is aliased to dev/lb-mock.tsx (an in-memory store), and envDir
// points at a folder with no .env files, so no VITE_* keys load: Supabase stays null and nothing
// in this page can reach the network, the live room or the sandbox room.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

export default defineConfig({
  root: resolve(__dirname, '..'),
  envDir: resolve(__dirname, 'no-env'),
  define: {
    __APP_VERSION__: JSON.stringify('mock'),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      { find: /^@liveblocks\/react\/suspense$/, replacement: resolve(__dirname, 'lb-mock.tsx') },
      // The plain entry — src/instant.ts reads through it.
      { find: /^@liveblocks\/react$/, replacement: resolve(__dirname, 'lb-mock-plain.tsx') },
    ],
  },
  server: { port: 5199, strictPort: true },
});
