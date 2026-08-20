# Icons

Tauri needs a few icon formats per platform. The simplest way to generate
them all from a single source PNG (1024×1024 recommended) is:

```
npx @tauri-apps/cli icon path/to/source.png
```

Run that once. It writes:
- `32x32.png`
- `128x128.png`
- `128x128@2x.png`
- `icon.icns` (macOS)
- `icon.ico` (Windows)
- `icon.png`

Commit the generated files, then push. The GitHub Actions workflow uses them
on every build.

If you don't have a custom icon yet, any 1024×1024 PNG works as a placeholder.
You can swap in real branding later by re-running the command and committing
the new files.

## Regenerating from new artwork

`scripts/build-icons.mjs` owns the web set and writes the square master this
directory's `tauri icon` command then consumes:

```
node scripts/build-icons.mjs <artwork.png>
npx tauri icon src-tauri/icons/icon-source-1024.png
```

`icon-source-1024.png` is the committed source of truth — trimmed to the
artwork's content, recentred, and framed. Regenerate from the original render
when there is one; regenerating from this master is safe too (re-trimming an
already-trimmed image is a no-op).

The favicon.ico at `public/favicon.ico` is not produced by either command; see
the commit that introduced this note for the one-off script.

Do NOT run `scripts/make-icon-transparent.mjs` on the current artwork. It punches
out near-white pixels — right for a mark on a white card, fatal for a mark that
is itself near-white.
