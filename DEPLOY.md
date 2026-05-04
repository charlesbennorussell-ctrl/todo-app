# Deploy + Install Guide

This app ships in three forms simultaneously:
1. **Browser** — anyone with the URL, no install
2. **Mac** — `.dmg` installer
3. **Windows** — `.exe` / `.msi` installer

The Mac and Windows desktop apps are thin Tauri shells that load the same
hosted web build. **Code changes deploy live to all three surfaces with one
git push.** Reinstalling the desktop app is only needed for shell-level
changes (window size defaults, new native features), which is rare.

---

## One-time setup

### 1. Push the repo to GitHub
Whatever git remote you've got is fine. The actions workflow lives in
`.github/workflows/release.yml` and triggers on tag pushes.

### 2. Connect the repo to Vercel (free)
1. Sign in at https://vercel.com with your GitHub account
2. **Add New Project** → pick this repo → **Deploy** (no settings needed; Vercel detects Vite)
3. Copy the production URL Vercel gives you (something like
   `https://ctrl-project.vercel.app` or `https://ctrl-project-yourname.vercel.app`)

### 3. Point the desktop apps at that URL
Open `src-tauri/tauri.conf.json` and replace
```json
"url": "https://ctrl-project.vercel.app"
```
with the URL Vercel gave you. Commit + push.

That's it for one-time setup. Vercel auto-deploys on every push to `main`
from now on.

### 4. Generate icons (one-time)
Tauri needs a few icon formats per platform. With any 1024×1024 PNG handy:
```
npm install
npx @tauri-apps/cli icon path/to/your/icon.png
```
Commit the generated files in `src-tauri/icons/` and push.

---

## Releasing a new desktop version

When you want to ship a new desktop installer (rare — only needed if you
change the Tauri shell, the window size, native features, etc.):

1. Bump `version` in `src-tauri/tauri.conf.json` (e.g. `0.1.0` → `0.1.1`)
2. Bump `version` in `src-tauri/Cargo.toml` to match
3. Commit + push
4. Tag the commit and push the tag:
   ```
   git tag v0.1.1
   git push --tags
   ```
5. GitHub Actions builds Mac + Windows installers in ~10 min.
6. Visit `https://github.com/<you>/<repo>/releases/latest` — installers are
   attached to the release.

For **code changes only** (React, Tailwind, app behavior), skip everything
above — just push to main. Vercel rebuilds in ~30 seconds and the desktop
apps see it on next launch.

---

## Sending the app to your partner

Send them this URL:
```
https://github.com/<you>/<repo>/releases/latest
```

They:
1. Click the URL
2. Download `Ctrl-Project_*.dmg` (Mac) or `Ctrl-Project_*_x64-setup.exe` (Windows)
3. Install:
   - **Mac**: open the dmg, drag Ctrl-Project to Applications. First launch → right-click → Open (one-time, since the build isn't Apple-notarized).
   - **Windows**: run the installer. SmartScreen may warn → "More info" → "Run anyway".
4. Use it. Forever. **They never have to reinstall for code changes** — the
   app reloads from your Vercel URL on each launch.

If you ever push a new tag (shell update), they re-download from the same
URL. Same install, replaces the old one.

---

## Local development

You don't need Rust installed unless you want to test the desktop wrapper
locally. Either way:

### Browser-only dev (zero setup beyond `npm install`)
```
npm run dev
```
Opens at http://localhost:5173. Hot reload, dev tools, all the usual.
This is where you'll spend 99% of dev time.

### Desktop dev (optional, requires Rust + platform deps)
1. Install Rust: https://rustup.rs/
2. Install platform deps: https://tauri.app/start/prerequisites/
3. Run:
   ```
   npm run tauri:dev
   ```
   Opens a desktop window pointing at http://localhost:5173 (so you still
   get hot reload). Useful for testing window-chrome behavior.

### Building installers locally (optional)
```
npm run tauri:build
```
Cross-compilation isn't supported — you can only build the platform you're
on (so Windows from Windows, Mac from Mac). Use GitHub Actions for the other.

---

## What's where

| File / Path                        | Purpose                                        |
| ---------------------------------- | ---------------------------------------------- |
| `src/`                             | The React app (the actual product)             |
| `src-tauri/tauri.conf.json`        | Window size, hosted URL, bundle settings       |
| `src-tauri/src/lib.rs`             | The Rust shell entry (kept tiny)               |
| `src-tauri/icons/`                 | Platform icons (generate with `npx tauri icon`)|
| `.github/workflows/release.yml`    | Cross-platform installer builds on tag push    |
| `DEPLOY.md`                        | This file                                      |

---

## Cost summary

- **Vercel**: free tier covers this app
- **GitHub Actions**: free for public repos; for private, ~$0.04 per release
  build (5–10 min × $0.008/min for macOS, less for Windows). You'd hit any
  noticeable cost only if you tagged dozens of releases per month.
- **Apple Developer signing** ($99/yr): optional. Without it, Mac users see a
  one-time "right-click → Open" friction on first launch.
- **Windows code signing cert** (~$200/yr): optional. Without it, SmartScreen
  warns once per install.
