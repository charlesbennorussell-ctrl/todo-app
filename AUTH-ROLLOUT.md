# Auth rollout runbook

The auth code ships **dark** (flag off, `VITE_AUTH_ENABLED` unset) — deploys are
zero-behavior-change until the cutover below. Do the cutover in ONE sitting:
the dangerous window is "new auth build deployed but old pk key still valid",
where a stale device replaying a whole-array LWW write can silently erase work.

## STATUS (2026-08-13)

The ORIGINAL Supabase project (klfbowcuchphysnzioar, "Ctrl-Projects") was
PURGED by the free-tier lifecycle (paused ~7 idle days → deleted ~90 days
later) — its domain no longer resolves and its account is unrecoverable.
Everything now lives on the NEW project `ogbtppqysksooinmftpj` under the
account Benno controls. Casualty: all 142 focus-image blobs; recovery =
Settings → Debug → Maintenance → "Recover images" on each device (re-uploads
from the local image cache; idempotent, run everywhere to top up).

DONE (provisioned 2026-08-13 via Management API + CLI): membership schema +
RLS + triggers; liveblocks-auth / membership / lr-proxy functions deployed;
signups disabled; Site URL + redirect allowlist set; focus-images bucket +
policies; Benno seeded as admin (B, all projects); invite lifecycle tested
end-to-end (create → info → redeem → single-use enforced); sign-in + gate +
auth-failure screens verified in dev against the real backend.

REMAINING: Liveblocks secret key (below) → set secret + verify room join →
sandbox invite rehearsal in-app → Phase 3 cutover → "Recover images" on
Benno's + Pawel's devices → optional Google OAuth client.

## Phase 0 — remaining one-time setup

1. ~~Supabase CLI access~~ DONE (access token).
2. **Liveblocks secret key**: liveblocks.io dashboard → project (the one the
   `pk_dev_fTXyt…` key belongs to — must be the SAME project or the room data
   won't be reachable) → API keys → copy the `sk_dev_…` secret key.
3. **Google OAuth client** (Google Cloud Console → APIs & Services → Credentials):
   - Create OAuth client ID → type "Web application".
   - Authorized redirect URI: `https://ogbtppqysksooinmftpj.supabase.co/auth/v1/callback`
   - Consent screen: External, app name "Ctrl-Project", your email; publish it
     (leaving it in Testing mode expires refresh tokens after 7 days).
   - Copy Client ID + Client Secret.
4. *(Optional, later)* Apple Sign-In needs a paid Apple Developer account —
   deferred; the button is flag-hidden.

## Phase 1 — provision backend (Claude drives, no user action)

```bash
supabase db push                                   # members/invites schema + RLS + redeem_invite_tx
supabase secrets set LIVEBLOCKS_SECRET_KEY=sk_dev_…
supabase functions deploy liveblocks-auth --no-verify-jwt
supabase functions deploy membership --no-verify-jwt
```

Management API config (Claude scripts these against the access token):
- Auth: **disable public signups** (`disable_signup: true`) — accounts exist
  only via invite redemption / admin seed.
- Site URL: `https://charlesbennorussell-ctrl.github.io/todo-app/`
- Additional redirect URLs: `https://charlesbennorussell-ctrl.github.io/todo-app/**`,
  `http://localhost:5173/**`
- Google provider: enable, paste Client ID + Secret from Phase 0.3.

Seed the admin (service role, SQL editor or Claude via CLI):

```sql
-- after creating Benno's auth user server-side:
--   auth.admin.createUser({ email: 'charlesbennorussell@gmail.com',
--     password: '<temp — change in Settings→Account>', email_confirm: true })
insert into public.members (user_id, email, display_name, role, person_short, project_access)
values ('<benno-user-id>', 'charlesbennorussell@gmail.com', 'Benno', 'admin', 'B', '{"mode":"all"}');
```

## Phase 2 — verify on the sandbox (no live-room exposure)

1. Local dev: uncomment `VITE_AUTH_ENABLED=1` in `.env.local` (room stays
   pinned to `todo-app-sandbox-dev`).
2. Sign in as Benno (password, then Google — confirms identity auto-linking).
3. Settings → Members: create a throwaway invite, open it in a private window,
   join as a fake member, check access filtering, remove the member.
4. Test the failure screens: sign out; stop nothing (server up) — then break
   the function name in devtools to see AuthTrouble + Export local backup.

## Phase 3 — cutover (ONE sitting, ~20 minutes)

1. **Download a JSON backup** (Settings → Debug → Local Backup → Download).
2. Get all three users' devices onto the current build & then CLOSED
   (Liveblocks dashboard shows active room connections — wait for zero).
3. Set `VITE_AUTH_ENABLED=1` in `.env.production`, bump version, push, wait
   for Pages, verify `version.json`.
4. Open the app → SignIn → sign in as Benno → confirm data renders.
5. **Immediately revoke the pk key**: Liveblocks dashboard → API keys →
   delete/roll `pk_dev_fTXyt…`. Also delete `VITE_LIVEBLOCKS_PUBLIC_KEY` from
   `.env.production` (next deploy) — the key in git history is dead once rolled.
6. Invite Pawel (Members → + → all projects, initial P) — send link via
   iMessage. Then Delaney whenever.
7. Tauri note: the installed desktop app loads the remote URL, so it gets the
   auth build automatically; Benno signs in with email+password there
   (Google is webview-blocked by Google policy).

## Break-glass recovery

- **Locked out (paused project / broken function)**: every pre-auth screen has
  "Export local backup" (reads IndexedDB directly). Supabase dashboard →
  restore project; or SQL editor → check `members` row exists for your user id.
- **Lost admin**: SQL editor →
  `update members set role='admin', removed_at=null where email='…';`
- **Roll back the cutover**: set `VITE_AUTH_ENABLED=` (empty) +
  re-enable/recreate a Liveblocks public key, redeploy. Room data is never
  touched by any of this — auth is entirely a gate in front of it.

## Known v1 limitations (phase-2 hardening candidates)

- Per-project access + personal privacy are enforced client-side against a
  server-verified identity. True server-side isolation = split personal lists
  into per-user Liveblocks rooms (`ctrl:user:{id}`), project scoping = room
  per project. Schema already fits (`project_access` jsonb unchanged).
- Members' short renames must go through Members UI (Postgres is the source of
  truth); the in-app People short editor still exists for non-member People.
- iOS PWA: invite links open in Safari — the invitee joins there, then signs
  in once inside the installed PWA (documented on the invite screen copy).
