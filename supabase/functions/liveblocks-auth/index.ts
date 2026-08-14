// Supabase Edge Function: Liveblocks token minting (the auth hot path).
//
// Replaces the public pk_dev_* key (which let ANYONE join the room) with real
// per-user access tokens. The client's authEndpoint callback POSTs here with
// the caller's Supabase session token; we verify it, require a live members
// row, and mint a Liveblocks access token scoped to EXACT room ids — never a
// wildcard, so a typo'd VITE_ROOM_ID can't authorize creating a junk room.
//
// Error contract (the client depends on this — see src/auth.ts):
//   403 {error:'forbidden', reason} → Liveblocks client STOPS retrying.
//     Returned for signed-out, non-member, and removed-member callers.
//   5xx → transient; the client callback converts repeat failures into a
//     visible error screen instead of letting the Suspense fallback hang
//     into its 10s cache-wipe.
//
// DEPLOY:
//   supabase functions deploy liveblocks-auth --no-verify-jwt
//   (JWT is verified MANUALLY below so that we can return Liveblocks' exact
//   {error:'forbidden'} body instead of the platform's generic 401 envelope.)
// SECRETS:
//   supabase secrets set LIVEBLOCKS_SECRET_KEY=sk_dev_...   (Liveblocks dashboard)

import { createClient } from 'npm:@supabase/supabase-js@2';
import { Liveblocks } from 'npm:@liveblocks/node@2';

// Same origin story as lr-proxy: the Tauri shell loads the GitHub Pages URL,
// so it needs no extra entry; the PWA is the same origin too.
const ALLOWED_ORIGINS = new Set([
  'https://charlesbennorussell-ctrl.github.io',
  'http://localhost:5173',
]);

// The ONLY rooms this app may touch. Members get the live room; admins also
// get the dev sandbox (dev clients pin VITE_ROOM_ID to it via .env.local).
const LIVE_ROOM = 'todo-app-v3';
const SANDBOX_ROOM = 'todo-app-sandbox-dev';

function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = origin && ALLOWED_ORIGINS.has(origin) ? origin : 'https://charlesbennorussell-ctrl.github.io';
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, apikey',
    'Access-Control-Max-Age': '86400',
  };
}

function json(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  const cors = corsHeaders(req.headers.get('Origin'));
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405, cors);

  const secretKey = Deno.env.get('LIVEBLOCKS_SECRET_KEY');
  if (!secretKey) return json({ error: 'server misconfigured: no Liveblocks key' }, 500, cors);

  // ── Verify the Supabase session ──────────────────────────────────────────
  const authHeader = req.headers.get('Authorization') || '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '');
  if (!jwt) return json({ error: 'forbidden', reason: 'not signed in' }, 403, cors);

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
  const { data: userData, error: userErr } = await supabase.auth.getUser(jwt);
  if (userErr || !userData?.user) {
    return json({ error: 'forbidden', reason: 'session invalid or expired' }, 403, cors);
  }
  const user = userData.user;

  // ── Require a live membership ────────────────────────────────────────────
  const { data: member, error: memberErr } = await supabase
    .from('members')
    .select('user_id, display_name, role, person_short, project_access, removed_at')
    .eq('user_id', user.id)
    .maybeSingle();
  if (memberErr) return json({ error: 'membership lookup failed', detail: memberErr.message }, 500, cors);
  if (!member || member.removed_at) {
    return json({ error: 'forbidden', reason: 'no workspace membership' }, 403, cors);
  }

  // ── Check the requested room against this member's grantable set ─────────
  // The client names the room it wants. If it isn't grantable (e.g. a
  // non-admin running a sandbox-pinned dev build), a 200 token that silently
  // LACKS the room would make the join fail with authHealth 'ok' — which the
  // client's stall recovery then misdiagnoses as a corrupt cache. A 403
  // forbidden body fails fast and honestly instead.
  let requestedRoom: string | undefined;
  try {
    const body = await req.json();
    if (body && typeof body.room === 'string' && body.room) requestedRoom = body.room;
  } catch { /* no body — grant the default set */ }
  const grantable = member.role === 'admin' ? [LIVE_ROOM, SANDBOX_ROOM] : [LIVE_ROOM];
  if (requestedRoom && !grantable.includes(requestedRoom)) {
    return json({ error: 'forbidden', reason: `no access to room ${requestedRoom}` }, 403, cors);
  }

  // ── Mint the Liveblocks access token ─────────────────────────────────────
  // userInfo rides inside the token and becomes UserMeta.info on every other
  // client — real names in presence for free.
  try {
    const liveblocks = new Liveblocks({ secret: secretKey });
    const session = liveblocks.prepareSession(user.id, {
      userInfo: {
        name: member.display_name,
        short: member.person_short,
        role: member.role,
      },
    });
    for (const room of grantable) session.allow(room, session.FULL_ACCESS);
    const { status, body } = await session.authorize();
    return new Response(body, { status, headers: { ...cors, 'Content-Type': 'application/json' } });
  } catch (e) {
    return json({ error: 'token minting failed', detail: (e as Error).message }, 502, cors);
  }
});
