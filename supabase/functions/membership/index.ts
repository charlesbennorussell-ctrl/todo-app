// Supabase Edge Function: membership operations (everything except the
// Liveblocks token hot path, which lives in ../liveblocks-auth).
//
// Actions (POST {action, ...}):
//   invite-create   admin JWT      → mint an invite link; the RAW token is
//                                    returned exactly once, only its SHA-256
//                                    hash is stored.
//   invite-info     no auth        → {inviterName, invitedName} for a valid
//                                    token, so the invite screen can greet
//                                    ("Benno invited you to Ctrl-Project").
//   invite-redeem   no auth        → the token IS the credential. Creates the
//                                    Supabase user server-side (public signups
//                                    are DISABLED — this is the only door) and
//                                    joins them atomically via redeem_invite_tx.
//   reset-password  admin JWT      → set a temp password for a member (there
//                                    is no email infra, so self-serve reset
//                                    cannot exist; admin does it in person).
//
// Role/access edits, revocation, and member removal are plain supabase-js
// table updates under RLS (admin policies + column-guard trigger) — no action
// here. DEPLOY:
//   supabase functions deploy membership --no-verify-jwt
//   (invite-info / invite-redeem are pre-auth by design; admin actions verify
//   the JWT manually below.)

import { createClient, SupabaseClient } from 'npm:@supabase/supabase-js@2';

const ALLOWED_ORIGINS = new Set([
  'https://charlesbennorussell-ctrl.github.io',
  'http://localhost:5173',
]);

const APP_URL = 'https://charlesbennorussell-ctrl.github.io/todo-app/';

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

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomToken(): string {
  // 32 random bytes, base64url — unguessable, URL-safe, no padding.
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Verify the caller's JWT and require an ADMIN members row. Returns the user
// id or a Response to bounce back.
async function requireAdmin(req: Request, service: SupabaseClient, cors: Record<string, string>): Promise<string | Response> {
  const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!jwt) return json({ error: 'not signed in' }, 401, cors);
  const { data, error } = await service.auth.getUser(jwt);
  if (error || !data?.user) return json({ error: 'session invalid' }, 401, cors);
  const { data: member } = await service
    .from('members')
    .select('role, removed_at')
    .eq('user_id', data.user.id)
    .maybeSingle();
  if (!member || member.removed_at || member.role !== 'admin') {
    return json({ error: 'admin only' }, 403, cors);
  }
  return data.user.id;
}

Deno.serve(async (req: Request) => {
  const cors = corsHeaders(req.headers.get('Origin'));
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405, cors);

  const service = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid JSON body' }, 400, cors);
  }
  const action = String(body.action || '');

  // ── invite-create (admin) ────────────────────────────────────────────────
  if (action === 'invite-create') {
    const adminOrBounce = await requireAdmin(req, service, cors);
    if (adminOrBounce instanceof Response) return adminOrBounce;

    const invitedName = String(body.invitedName || '').trim();
    const personShort = String(body.personShort || '').trim() || (invitedName ? invitedName[0].toUpperCase() : '');
    const role = body.role === 'admin' ? 'admin' : 'member';
    const projectAccess = (body.projectAccess && typeof body.projectAccess === 'object')
      ? body.projectAccess
      : { mode: 'all' };
    if (!invitedName) return json({ error: 'invitedName required' }, 400, cors);
    if (!personShort) return json({ error: 'personShort required' }, 400, cors);

    // A short colliding with any member (including removed/tombstoned ones)
    // or any live invite must be rejected here, with a readable message —
    // the DB indexes are the backstop, not the UX. ILIKE treats % _ \ as
    // pattern syntax, so escape them for an exact case-insensitive match,
    // and surface query errors instead of letting a failed check read as
    // "short available".
    const shortPattern = personShort.replace(/[\\%_]/g, '\\$&');
    const { data: shortTaken, error: shortErr } = await service
      .from('members').select('user_id').ilike('person_short', shortPattern).maybeSingle();
    if (shortErr) return json({ error: `could not check initial availability: ${shortErr.message}` }, 500, cors);
    if (shortTaken) return json({ error: `initial "${personShort}" is already taken` }, 409, cors);

    const raw = randomToken();
    const tokenHash = await sha256Hex(raw);
    const { data: invite, error } = await service.from('invites').insert({
      token_hash: tokenHash,
      created_by: adminOrBounce,
      invited_email: body.invitedEmail ? String(body.invitedEmail).toLowerCase() : null,
      role,
      person_short: personShort,
      project_access: projectAccess,
      // metadata for the invite screen greeting; stored on the row so info
      // lookups never need a join back through the raw token.
    }).select('id, expires_at').single();
    if (error) {
      const friendly = /invites_person_short_live_key/.test(error.message)
        ? `a live invite already promises the initial "${personShort}" — revoke it first`
        : error.message;
      return json({ error: friendly }, 409, cors);
    }

    return json({
      inviteId: invite.id,
      link: `${APP_URL}?invite=${raw}`,
      token: raw,
      expiresAt: invite.expires_at,
      invitedName,
      personShort,
    }, 200, cors);
  }

  // ── invite-info (pre-auth) ───────────────────────────────────────────────
  if (action === 'invite-info') {
    const token = String(body.token || '');
    if (!token) return json({ error: 'token required' }, 400, cors);
    const tokenHash = await sha256Hex(token);
    const { data: inv } = await service
      .from('invites')
      .select('created_by, invited_email, person_short, expires_at, revoked_at, use_count, max_uses')
      .eq('token_hash', tokenHash)
      .maybeSingle();
    if (!inv) return json({ valid: false, reason: 'invite not found' }, 200, cors);
    if (inv.revoked_at) return json({ valid: false, reason: 'invite was revoked' }, 200, cors);
    if (new Date(inv.expires_at) < new Date()) return json({ valid: false, reason: 'invite expired' }, 200, cors);
    if (inv.use_count >= inv.max_uses) return json({ valid: false, reason: 'invite already used' }, 200, cors);
    const { data: inviter } = await service
      .from('members').select('display_name').eq('user_id', inv.created_by).maybeSingle();
    return json({
      valid: true,
      inviterName: inviter?.display_name || 'The admin',
      invitedEmail: inv.invited_email,
      personShort: inv.person_short,
    }, 200, cors);
  }

  // ── invite-redeem ────────────────────────────────────────────────────────
  // Two modes:
  //   Pre-auth (no JWT): the token is the credential; creates the account
  //     server-side with the supplied email+password. The normal invite path.
  //   Authed (JWT): joins the EXISTING signed-in user (e.g. someone who got
  //     in via Google before redeeming, or the NoAccess paste field). No
  //     account creation, no password needed.
  if (action === 'invite-redeem') {
    const token = String(body.token || '');
    if (!token) return json({ error: 'token required' }, 400, cors);
    const tokenHash = await sha256Hex(token);

    // Authed mode?
    const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (jwt) {
      const { data: authed, error: authedErr } = await service.auth.getUser(jwt);
      if (!authedErr && authed?.user) {
        const u = authed.user;
        const authedName = String(body.displayName || u.user_metadata?.display_name || u.user_metadata?.full_name || u.email?.split('@')[0] || 'Member').trim();
        const { data: rows, error: txErr } = await service.rpc('redeem_invite_tx', {
          p_token_hash: tokenHash,
          p_user_id: u.id,
          p_email: (u.email || '').toLowerCase(),
          p_display_name: authedName,
        });
        const result = Array.isArray(rows) ? rows[0] : rows;
        if (txErr || !result?.ok) {
          return json({ error: result?.reason || txErr?.message || 'redemption failed' }, 403, cors);
        }
        return json({ ok: true, personShort: result.person_short, role: result.role, displayName: authedName }, 200, cors);
      }
      // fall through to pre-auth mode if the JWT was stale
    }

    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const displayName = String(body.displayName || '').trim();
    if (!email || !displayName) return json({ error: 'token, email, and displayName required' }, 400, cors);
    if (password.length < 6) return json({ error: 'password must be at least 6 characters' }, 400, cors);

    // Fast pre-check so we don't create an auth user against a dead invite.
    const { data: pre } = await service
      .from('invites')
      .select('revoked_at, expires_at, use_count, max_uses')
      .eq('token_hash', tokenHash)
      .maybeSingle();
    if (!pre) return json({ error: 'invite not found' }, 403, cors);
    if (pre.revoked_at) return json({ error: 'invite was revoked' }, 403, cors);
    if (new Date(pre.expires_at) < new Date()) return json({ error: 'invite expired' }, 403, cors);
    if (pre.use_count >= pre.max_uses) return json({ error: 'invite already used' }, 403, cors);

    // Create the auth account (public signups are disabled — this service-role
    // call is the only way accounts come to exist). email_confirm: true marks
    // the address verified so a later "Continue with Google" with the same
    // email auto-links to THIS account instead of minting a stray second one.
    //
    // SECURITY: every createUser failure returns ONE generic message. The
    // previous design verified the typed password against an existing account
    // here — that made this pre-auth endpoint an account-existence oracle
    // (GoTrue's login deliberately hides whether an email exists; this leaked
    // it) and a non-consuming password probe. If the invitee already has an
    // account, the supported path is: sign in normally → NoAccess screen →
    // paste the invite → authed redeem. The generic copy points there without
    // confirming anything about this specific email.
    const { data: created, error: createErr } = await service.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { display_name: displayName },
    });
    if (createErr) {
      return json({
        error: 'could not create the account — if you already have one, sign in first and then paste the invite link on the "no access" screen',
      }, 409, cors);
    }
    const userId = created.user.id;
    const createdHere = true;

    // Atomic join.
    const { data: rows, error: txErr } = await service.rpc('redeem_invite_tx', {
      p_token_hash: tokenHash,
      p_user_id: userId,
      p_email: email,
      p_display_name: displayName,
    });
    const result = Array.isArray(rows) ? rows[0] : rows;
    if (txErr || !result?.ok) {
      // Compensate: don't leave a dangling account we just created that can
      // never join (it would block this email from a clean future invite).
      if (createdHere) await service.auth.admin.deleteUser(userId).catch(() => {});
      return json({ error: result?.reason || txErr?.message || 'redemption failed' }, 403, cors);
    }

    return json({
      ok: true,
      personShort: result.person_short,
      role: result.role,
      displayName,
    }, 200, cors);
  }

  // ── reset-password (admin) ───────────────────────────────────────────────
  if (action === 'reset-password') {
    const adminOrBounce = await requireAdmin(req, service, cors);
    if (adminOrBounce instanceof Response) return adminOrBounce;
    const targetUserId = String(body.userId || '');
    const newPassword = String(body.password || '');
    if (!targetUserId) return json({ error: 'userId required' }, 400, cors);
    if (newPassword.length < 6) return json({ error: 'password must be at least 6 characters' }, 400, cors);
    // Only members of THIS workspace can be reset here — this is not a
    // general-purpose account-admin endpoint.
    const { data: target } = await service
      .from('members').select('user_id').eq('user_id', targetUserId).maybeSingle();
    if (!target) return json({ error: 'not a member of this workspace' }, 404, cors);
    const { error } = await service.auth.admin.updateUserById(targetUserId, { password: newPassword });
    if (error) return json({ error: error.message }, 500, cors);
    return json({ ok: true }, 200, cors);
  }

  return json({ error: `unknown action: ${action}` }, 400, cors);
});
