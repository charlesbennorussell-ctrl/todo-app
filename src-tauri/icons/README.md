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
