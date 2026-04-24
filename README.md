# Port from Figma Make → local / Claude Code

## One-time setup
```bash
cp /path/to/make/src/app/App.tsx port/src/App.tsx
```

Then edit the SVG import line at the top of `src/App.tsx`:
```ts
// from
import arrowPaths from "../imports/Container/svg-hzx9ujz7s0";
// to
import arrowPaths from "./imports/svg-hzx9ujz7s0";
```

There are no `figma:asset` imports in the current App, so nothing else to rewire.

## Run it
```bash
cd port
pnpm install
pnpm dev
```

## Open in Claude Code
```bash
cd port
claude
```
Then: "Continue building the Things-inspired todo app; dev server is running."

## Swap the fonts
`src/index.css` stubs the three Figma fonts as Helvetica/Arial aliases. For the real look, either:
- drop `.woff2` files under `public/fonts/` and replace the `@font-face` blocks with real `url()` references, or
- swap to comparable web fonts (Inter, Space Grotesk, etc.) and rename the `font-['...']` class strings in App.tsx.
