/// <reference types="vite/client" />

// Build-time replacements set by `define` in vite.config.ts. Vite swaps these
// with literals (string-quoted JSON) during the build, so they're real
// constants in the bundled JS — no runtime cost.
declare const __APP_VERSION__: string;
declare const __BUILD_TIME__: string;
