# Ctrl-Project (repo: `todo-app`)

A collaborative todo + project planner. Product name is **Ctrl-Project**; the GitHub repo is
**`todo-app`** (`https://github.com/charlesbennorussell-ctrl/todo-app`). That repo name is
load-bearing — see "Deploy" below before you rename anything.

Stack: React 18 + TypeScript + Vite 5 + Tailwind 4, Liveblocks for realtime storage,
Supabase for image blobs, Tauri 2 for the desktop shell, dnd-kit for all drag/drop.

## The three surfaces

All three load the **same deployed URL**: `https://charlesbennorussell-ctrl.github.io/todo-app/`

1. **Desktop app** (Tauri, Windows/macOS) — a thin native shell whose main window's `url` is
   the hosted site (`src-tauri/tauri.conf.json`). It does not bundle the frontend.
2. **PIP quick-view** — a second always-on-top Tauri window at
   `.../todo-app/?pip=1` (hardcoded as `PIP_URL` in `src-tauri/src/lib.rs:15`). Toggled by a
   global shortcut; default **Ctrl+Space**, user-customizable from Settings and persisted in
   `pip-shortcut.txt` in the app config dir. The web side renders only the three focus day
   columns when `?pip` is present.
3. **iPhone PWA** — "Add to Home Screen" against the same URL.
   `public/manifest.webmanifest` has `start_url` / `scope` of `/todo-app/`; `index.html`
   hardcodes `/todo-app/icons/icon-192.png` and `/todo-app/manifest.webmanifest`.

Consequence: **a code push updates all three at once.** Rebuilding/reinstalling the desktop
app is only needed for shell-level changes (native features, window sizing, the PIP URL).

URL overrides for testing (parsed in `src/main.tsx`): `?mobile=1`, `?desktop=1`, `?pip`,
`?debug=1` (debug overlay, `src/App.tsx:161`).

## Architecture map

| Path | What it is |
| --- | --- |
| `src/main.tsx` | Entry point. `LiveblocksProvider` → `RoomProvider` (room id + `initialStorage`) → Suspense. Contains the **Shell router** (`<768px` → `MobileApp`, else `App`) and the **connection-recovery logic**. |
| `src/App.tsx` | The entire desktop app, ~11.6k lines. See landmarks below. |
| `src/MobileApp.tsx` | iPhone shell (~885 lines). Imports `computeCalendarDistribution`, `TaskCheckbox`, `AssigneeBadge`, `Arrowhead`, `makeCpCompare` from `App.tsx` so both surfaces render the same data the same way. |
| `src/data.ts` | Domain types (`Task`, `Project`, `Client`, `Person`, `ListId`, `SectionId`, `AppMode`), seed data, `todayISO()` / `formatDeadline()` / `isLateDeadline()`. |
| `src/liveblocks.config.ts` | Declares the global `Liveblocks.Storage` / `Presence` / `UserMeta` shapes. |
| `src/backup.ts` | Local IndexedDB backup of Storage. Two slots only — `live` (~5 min refresh) and `daily` — both overwritten in place. No history. |
| `src/supabase.ts`, `src/imageCache.ts`, `src/lightroom.ts` | Image upload/hosting, blob cache, Adobe Lightroom import. |
| `src-tauri/src/lib.rs` | Tauri shell: PIP window, global shortcut registration, autostart, close-hides-instead-of-quits, Windows sizing helper. |
| `.github/workflows/deploy.yml` | Pages deploy on push to master. |
| `.env.production` | Committed. Publishable Liveblocks/Supabase/Adobe client keys (safe by design — the security boundary is Supabase RLS). |
| `.env.local` | **Gitignored.** Local overrides, incl. `VITE_ROOM_ID` room pin. |

`README.md` and `DEPLOY.md` are stale (they describe a Figma Make port and a Vercel deploy
that no longer exist). Trust this file and the workflow, not those.

### `src/App.tsx` landmarks

Approximate — grep to confirm before editing, the file moves.

| Lines | Region |
| --- | --- |
| 1–275 | Shell constants (`TOUCH_DEVICE`, `PIP_MODE`, `IS_TAURI`), Tauri titlebar, debug overlay |
| 276–512 | `CustomScroll` (custom overflow container — native `scrollTo({behavior:'smooth'})` is a no-op inside it) |
| 628–820 | Shared primitives: `TopHeader`, `TaskCheckbox` (exported), `MilestoneToggle`, `AssigneeBadge`, `Arrowhead` |
| 820–917 | `MOTION` / `SPACING` vocabulary, `Displaced` |
| 918–1614 | `SortableTaskItem` — the task card |
| 1615–2050 | Section headers, sticky overlay, drop rows, tray, `BottomBar` |
| 2052–2390 | `DateRangePicker`, `AddModal`, `TrashConfirmModal` |
| 2391–3140 | Focus DAM (reference image gallery): viewer, tiles, groups, folders |
| 3140–3585 | Project-view drop zones, `EditableText`, settings primitives, `HeaderAddMenu` |
| 3585–3819 | `ProjectViewMode` |
| 3820–4470 | Calendar layer: date helpers, `CardDateMenu`, droppables, `MilestoneCardView`, `makeCpCompare` (4039), `roundRobinByProject`, `queueOrder`, **`computeCalendarDistribution` (4119)**, `CalendarCard` |
| 4468–4868 | `WeekCalendarMode` |
| 4869–5282 | `BackupSection`, `SettingsMode` |
| 5455–5513 | **`useStorageList` / `useStorageRecord`** — the only write path into Liveblocks Storage |
| 5522–5845 | `TaskQuickEdit` (right-side panel; double-click = edit, right-click = quick) |
| 5846+ | `export default function App()` |
| 5846–6320 | State, localStorage-backed settings, version-check poll, dnd-kit sensors |
| 6330–6620 | Task mutations (`toggleTask`, `rescheduleTaskTo`, sentence-case pipeline, …) |
| 6642–7100 | Focus storage: briefs, subtasks, images, folders |
| 7824–8100 | `handleDragStart` / `handleDragOver` / `handleDragEnd` |
| 9138 | `renderColumn(listId, filterProjectId?, filterClientId?)` |
| 9664 | `<DndContext>` — start of the render tree |
| 9738 / 9753 / 9773 / 9797 / 11207 | Mode branches: dashboard / projectView / calendar / **focus (also the PIP branch: `PIP_MODE \|\| mode === 'focus'`)** / settings |

## Data safety (read this before running anything)

Liveblocks Storage is the source of truth for tasks/projects/clients/people and all `focus*`
records. There is no server-side database of your own.

**Every write is a whole-array (or whole-Record) last-writer-wins `storage.set`.**
See `useStorageList` at `src/App.tsx:5457` — it reads the current array, applies an updater,
and sets the entire array back. Two clients writing concurrently do not merge; the later
write wins and silently discards the other's changes.

Therefore:

- **Live room: `todo-app-v3`. Dev sandbox room: `todo-app-sandbox-dev`.**
- The room id comes from `VITE_ROOM_ID`, falling back to `'todo-app-v3'`
  (`src/main.tsx:32`). `.env.local` pins `VITE_ROOM_ID=todo-app-sandbox-dev` and carries a
  comment saying never to remove it. **Do not remove or edit that line.** Deleting `.env.local`
  or clearing that variable points `npm run dev` straight at the user's live data.
- Never open two dev clients on the live room, and never run a script that writes to it.
- **`.env.local` also applies to local production builds.** Vite loads `.env.local` in every
  mode, so `npx vite build` on this machine bakes the **sandbox** room into `dist/`
  (verified: `grep todo-app-sandbox-dev dist/assets/*.js` hits). Only the CI build gets the
  live room, because `.env.local` is gitignored and absent on the runner. **Never publish a
  locally-built `dist/` by hand** — always let the workflow build it.
- **Concurrent-connection cap.** The Liveblocks free tier limits simultaneous connections per
  room. Too many windows (main app + PIP + browser tabs + phone) and new clients hang on
  "Connecting…". `src/main.tsx` sniffs Liveblocks' "concurrent connections" `console.error`
  and shows a "close your other windows" screen. It deliberately **does not reload** in that
  state — each reload opens another connection and makes it worse. Keep that behavior.
- A wedged "Connecting…" for other reasons auto-clears the local cache **once** per session
  and reloads (`RECOVER_MS = 10000`). `clearLocalCache()` protects any IndexedDB whose name
  matches `/backup/i` — the `ctrl-project-backups` store is the user's safety net, not a
  cache. Do not widen that wipe.
- `useStorageRecord` has wipe-protection: it refuses a write that turns a non-empty Record
  into `{}`. Keep it.
- Backups (`src/backup.ts`) cover Liveblocks Storage only. Supabase image **blobs** are not in
  the JSON, only their URLs.

## Build and verify

```
npx vite build      # the definitive check — must pass
npm run dev         # local dev server on :5173 (sandbox room)
```

`npm run typecheck` (`tsc -b`) currently reports **14 pre-existing baseline errors** and is
not a gate. Most cascade from Liveblocks rejecting the `Storage` type as non-LSON (the
`Record<string, …>` members), which poisons `main.tsx` and `MobileApp.tsx` storage reads.
A handful are genuine dead references in `App.tsx` (`addSiblingTask`, `ResolvedTarget`) inside
code paths that no longer render. Use `tsc -b --force` and compare the error count against 14;
your change is clean if the count did not go up and no new file appears.

Note also: `liveblocks.config.ts` does not declare `focusImageFolders`, although `main.tsx`
seeds it and `useStorageRecord` reads/writes it. That mismatch is known.

The dev-server launch config lives in `.claude/launch.json` (`todo-app`, port 5173).

## Deploy

```
# bump "version" in package.json
git add -A
git commit -m "vX.Y.Z — short description"
git push origin master
```

`.github/workflows/deploy.yml` then builds with `VITE_BASE=/todo-app/` and publishes to
GitHub Pages (~2 min). `vite.config.ts` reads the version out of `package.json`, defines
`__APP_VERSION__` / `__BUILD_TIME__`, and writes `dist/version.json`; the running app polls
that file every 3 minutes and shows a "new version available" banner when the deployed
`buildTime` is newer than the one compiled into the running bundle. Bumping the version is
what makes that banner meaningful — do not skip it.

**Warning: the repo name, `VITE_BASE`, and the Pages URL are one coupled fact.**
`https://charlesbennorussell-ctrl.github.io/todo-app/` is hardcoded in
`src-tauri/tauri.conf.json` (main window), `src-tauri/src/lib.rs` (`PIP_URL`),
`index.html` (icon + manifest links), and `public/manifest.webmanifest`
(`start_url`/`scope`) — and `VITE_BASE=/todo-app/` in the workflow prefixes every asset URL.
Renaming the repo, changing the Pages path, or changing `VITE_BASE` breaks the installed
desktop app, the PIP window, and the installed iPhone PWA simultaneously, and the desktop
fix requires shipping a new installer. If it must change, all five places change together.

Desktop installers are a separate, rare release: bump `version` in `src-tauri/tauri.conf.json`
(currently 0.2.53, intentionally behind `package.json`) and `src-tauri/Cargo.toml`, then push
a tag — `.github/workflows/release.yml` builds them.

## Platform gotchas

### Windows window sizing

Do **not** size the main window through Tauri's or tao's APIs, and do not trust the webview's
`innerWidth`. On this machine DPI bookkeeping is corrupted: in-process sizing requests land as
physical-at-scale-1, and the in-process sensors read back the same virtualized lie, so any
closed-loop correction is blind.

The mechanism that actually works (`src-tauri/src/lib.rs:242–286`, `#[cfg(windows)]`) spawns a
hidden **external** PowerShell helper that is DPI-aware as its own process and runs
`GetWindowRect` / `SetWindowPos` against the window's HWND — width 1579 (the user's measured
preference), full work-area height, centered, re-asserted every 700 ms for ~7 s, then exits.

Note the earlier in-process Win32 watchdog thread immediately below it is **dead code**
(`#[cfg(any())]` at line 287) — it is kept as documentation of a failed approach. Do not
"re-enable" it; it re-asserts its own mangled size forever.

### iOS / MobileApp touch traps

`MobileApp.tsx` documents these at the top; the ones that will bite you:

- **dnd-kit listener spread clobbers `onTouchStart`.** `listeners` from `useSortable` includes
  the TouchSensor's own `onTouchStart` activator. Spreading `{...listeners}` and then declaring
  your own `onTouchStart` silently kills long-press dragging on real devices. Destructure and
  compose by hand — `const { onTouchStart: dndTouchStart, ...restListeners } = listeners` then
  call `dndTouchStart?.(e)` from your handler (`MobileApp.tsx:192–207`).
- **The tap window must be shorter than the TouchSensor delay.** Sensor is
  `TouchSensor, { activationConstraint: { delay: 250, tolerance: 10 } }`. Tap detection is
  ≤10px **and ≤230ms** so a held finger can never register as both a tap and a drag.
- **Synthetic click delay.** iOS fires a synthetic click 0–300ms after `touchend`. A
  module-level `lastTouchAt` stamp (capture-phase `touchend` listener) suppresses any click
  within 700ms of a touch. Bottom sheets need the same guard or they close on the click that
  opened them.
- No opacity fades on the drag source (use an inline visibility swap), no `will-change` on
  rows that transform during drags, and `DragOverlay` measures the source rect itself because
  the TouchSensor can beat dnd-kit's measuring.
- Text inputs commit on **blur and on `input`** — iOS predictive text fires no `keydown`.

## Domain conventions

- **Sections** (`SectionId`): `inbox` | `today` | `tomorrow` | `next`.
- **Lists / categories** (`ListId`): `dashboard` | `work` | `projects` | `admin` | `personal`.
  The board renders `LISTS = ['work','projects','admin','personal']`; `dashboard` was removed
  from the main board but survives for PIP (`renderColumn('dashboard')`) and as an `AppMode`.
- **2-stage checkbox**: pending → started → completed → pending. `started`/`startedAt` are the
  middle tier; `completed`/`completedAt` the last. Sort is 3-tier (pending 0 → started 1 →
  completed 2), and a freshly-toggled task is held in place for ~15s (the `*At` stamps) so a
  misclick can be undone before the row visibly sinks.
- **Milestones** are `task.type === 'scheduled'` (vs `'todo'`), rendered in accent purple, and
  dimmed to `#4f4290` once the deadline is past.
- **Personal privacy**: `isPrivateTask = (t) => t.list === 'personal' || t.clientId === PERSONAL_CLIENT_ID`
  (`App.tsx:3917`). Private tasks are scoped to their assignees — they never appear on anyone
  else's dashboard, list, or project view, and render with the hollow (stroke) assignee badge.
- **`computeCalendarDistribution(tasks, todayAnchor, horizonDays, listOrder, projects, clients, sortByCP, tasksPerDay, queueCap)`**
  (`App.tsx:4119`) is the single shared engine that spreads tasks across day columns. It backs
  the week Calendar (`horizon 84`, uncapped), the Focus day columns (`horizon 9, 60, 30`), and
  the mobile Focus panes (same args as Focus). Change it and all three change — that is the
  point; do not fork per-surface copies.
- **Day rollover is 4 AM, not midnight.** `todayISO()` subtracts 4 hours before extracting the
  date. Anything done between 00:00 and 03:59 counts as the previous day. Use `todayISO()`
  everywhere; do not reach for `new Date()` directly for day comparisons.
- **Soft delete**: `trashed` / `trashedAt` hide a task everywhere but Settings → Trash, where
  it can be revived. `revivedAt` keeps a just-revived task visible for 10 minutes regardless of
  filters. Blank tasks (title never filled) are auto-removed 3 minutes after `createdAt`.
- **Focus mode keys**: briefs/subtasks/images/references are stored under a `projectKey` (all
  tasks in a project share the brief) or a `taskKey` (notes/images pinned to one task). Image
  binaries live in Supabase; Liveblocks holds metadata + URL only (legacy `dataUrl` and
  `localStorage` paths remain for pre-migration rooms).
- Settings that are per-device (task order, list sequence, case mode, card rows, sort-by-CP,
  current user) live in `localStorage`, not in Storage. `MobileApp` reads the same keys so both
  surfaces agree.
