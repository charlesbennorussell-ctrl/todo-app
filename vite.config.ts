import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync } from 'node:fs';

// `base` controls the public path the production build's asset URLs use.
// • Local dev (`npm run dev`): defaults to '/' — assets served from root.
// • GitHub Pages production build: the deploy.yml workflow sets VITE_BASE
//   to '/todo-app/' so every asset URL gets that prefix (Pages serves the
//   repo from a subpath like https://user.github.io/todo-app/).
// Falling back to '/' keeps `npm run build` working locally + in any other
// hosting environment without env vars.

// Read the version straight from package.json so we don't have to keep two
// sources in sync — bump package.json and the about-page label updates on
// the next build. BUILD_TIME stamps the moment the bundle was built so the
// user can tell at a glance whether the running webview is the freshly-
// deployed build or a stale one cached in their tab.
const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));

export default defineConfig({
  base: process.env.VITE_BASE ?? '/',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  plugins: [react(), tailwindcss()],
});
