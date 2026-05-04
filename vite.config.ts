import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// `base` controls the public path the production build's asset URLs use.
// • Local dev (`npm run dev`): defaults to '/' — assets served from root.
// • GitHub Pages production build: the deploy.yml workflow sets VITE_BASE
//   to '/todo-app/' so every asset URL gets that prefix (Pages serves the
//   repo from a subpath like https://user.github.io/todo-app/).
// Falling back to '/' keeps `npm run build` working locally + in any other
// hosting environment without env vars.
export default defineConfig({
  base: process.env.VITE_BASE ?? '/',
  plugins: [react(), tailwindcss()],
});
