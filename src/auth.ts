// Authentication + membership core (v0.4.0).
//
// Everything auth-shaped that isn't UI lives here: the Supabase session,
// the workspace membership row, the Liveblocks authEndpoint callback, invite
// API helpers, and the auth-health store that keeps auth failures from being
// mistaken for the storage stalls that main.tsx's auto-recovery wipes caches
// over.
//
// Auth model (see supabase/functions/membership/index.ts for the server side):
//   - Public signups are DISABLED in Supabase. Accounts exist only via invite
//     redemption (server-side createUser) or the deploy-time admin seed.
//   - Every account has a password (set at redemption) — Google OAuth is a
//     sign-in convenience on web/PWA that auto-links by verified email, and
//     is hidden in the Tauri shell where Google blocks embedded webviews.
//   - Liveblocks tokens are minted per-user by the liveblocks-auth edge
//     function; membership + per-project access live in Postgres.

import { createContext, useContext } from 'react';
import { supabase } from './supabase';

// ---------------------------------------------------------------------------
// Constants

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
export const FUNCTIONS_URL = SUPABASE_URL ? `${SUPABASE_URL}/functions/v1` : undefined;

// Clean base URL for OAuth redirects — origin + Vite base path, NO query and
// NO hash. Redirecting to location.href would need every query-combination
// allowlisted in Supabase; a miss silently falls back to the Site URL.
export const APP_BASE_URL = typeof window !== 'undefined'
  ? `${window.location.origin}${import.meta.env.BASE_URL || '/'}`
  : '/';

// Tauri's WebView2 cannot run Google OAuth (403 disallowed_useragent) — the
// sign-in screen hides the Google button there. withGlobalTauri:true makes
// the detection trivial.
export const IS_TAURI = typeof window !== 'undefined' &&
  ('__TAURI__' in window || '__TAURI_INTERNALS__' in window);

// ---------------------------------------------------------------------------
// Types

export interface Membership {
  user_id: string;
  email: string;
  display_name: string;
  role: 'admin' | 'member';
  person_short: string;
  project_access: { mode: 'all' } | { mode: 'selected'; projectIds: string[] };
  removed_at: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Auth health store
//
// The Liveblocks authEndpoint callback reports here. main.tsx's Loading
// fallback consults getAuthHealth() before its 10s auto-recovery: an auth
// outage must show an auth error screen, never wipe local caches (wiping is
// only the right medicine when the ROOM cache is the thing that's stuck).

export type AuthHealth =
  | { status: 'unknown' }
  | { status: 'ok' }
  | { status: 'forbidden'; detail: string }   // 403 — membership revoked / signed out
  | { status: 'unreachable'; detail: string }; // network / 5xx / paused project

let authHealth: AuthHealth = { status: 'unknown' };
const healthListeners = new Set<(h: AuthHealth) => void>();

function setAuthHealth(h: AuthHealth): void {
  authHealth = h;
  healthListeners.forEach((l) => l(h));
}

export function getAuthHealth(): AuthHealth {
  return authHealth;
}

export function onAuthHealth(listener: (h: AuthHealth) => void): () => void {
  healthListeners.add(listener);
  return () => healthListeners.delete(listener);
}

// ---------------------------------------------------------------------------
// Liveblocks authEndpoint
//
// Contract (verified against Liveblocks client docs):
//   - RETURN {error:'forbidden', reason} → client disconnects, stops retrying.
//   - THROW → treated as transient, client retries with backoff.
// So: 403s are RETURNED (revoked members disconnect cleanly), network/5xx
// THROW (a cold-started function deserves a retry) — but both report to the
// health store so the UI can surface a real screen instead of spinning.

export async function liveblocksAuthEndpoint(room?: string): Promise<{ token: string } | { error: string; reason: string }> {
  if (!supabase || !FUNCTIONS_URL) {
    setAuthHealth({ status: 'unreachable', detail: 'Supabase not configured' });
    throw new Error('Supabase not configured');
  }
  // getSession() refreshes an expired token — never capture the token in a
  // closure; a mounted room re-auths ~hourly and a stale JWT would 401 forever.
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    setAuthHealth({ status: 'forbidden', detail: 'signed out' });
    return { error: 'forbidden', reason: 'signed out' };
  }
  let res: Response;
  try {
    res = await fetch(`${FUNCTIONS_URL}/liveblocks-auth`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ room }),
    });
  } catch (e) {
    setAuthHealth({ status: 'unreachable', detail: (e as Error).message });
    throw e;
  }
  if (res.status === 403) {
    const body = await res.json().catch(() => ({ error: 'forbidden', reason: 'access denied' })) as { error?: string; reason?: string };
    setAuthHealth({ status: 'forbidden', detail: String(body.reason || 'access denied') });
    return { error: body.error || 'forbidden', reason: body.reason || 'access denied' };
  }
  if (!res.ok) {
    setAuthHealth({ status: 'unreachable', detail: `auth service ${res.status}` });
    throw new Error(`liveblocks-auth failed: ${res.status}`);
  }
  setAuthHealth({ status: 'ok' });
  return await res.json() as { token: string };
}

// ---------------------------------------------------------------------------
// Membership

// Last-known-good membership, so an OFFLINE app start can still open the room
// from the Liveblocks local cache instead of dead-ending on an error screen.
// Display-convenience only: a revoked member's Liveblocks token mint still
// 403s server-side the moment the network is back.
const MEMBERSHIP_CACHE_KEY = 'ctrl-membership-cache';
function readMembershipCache(userId: string): Membership | null {
  try {
    const raw = window.localStorage.getItem(MEMBERSHIP_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Membership;
    return parsed.user_id === userId ? parsed : null;
  } catch { return null; }
}
export function clearMembershipCache(): void {
  try { window.localStorage.removeItem(MEMBERSHIP_CACHE_KEY); } catch { /* ignore */ }
}

// Distinguishes the three outcomes the gate must not conflate: a member row,
// genuinely no membership, and "the query itself failed" (project paused,
// offline) — the last one must NEVER render as "you don't have access".
// On query failure, a cached membership for the same user downgrades the
// error to a working (stale-identity) session.
export async function fetchMembership(userId: string): Promise<
  { kind: 'member'; member: Membership; stale?: boolean } | { kind: 'none' } | { kind: 'error'; detail: string }
> {
  if (!supabase) return { kind: 'error', detail: 'Supabase not configured' };
  const { data, error } = await supabase
    .from('members')
    .select('user_id, email, display_name, role, person_short, project_access, removed_at, created_at')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    const cached = readMembershipCache(userId);
    if (cached) return { kind: 'member', member: cached, stale: true };
    return { kind: 'error', detail: error.message };
  }
  if (!data || data.removed_at) {
    clearMembershipCache();
    return { kind: 'none' };
  }
  try { window.localStorage.setItem(MEMBERSHIP_CACHE_KEY, JSON.stringify(data)); } catch { /* ignore */ }
  return { kind: 'member', member: data as Membership };
}

// Throws on query failure — silently returning [] made the Members UI show
// "Loading members…" forever on any offline moment or paused project.
export async function fetchAllMembers(): Promise<Membership[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('members')
    .select('user_id, email, display_name, role, person_short, project_access, removed_at, created_at')
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  return (data as Membership[] | null) ?? [];
}

// ---------------------------------------------------------------------------
// Invite + membership API (the `membership` edge function)

async function callMembership(action: string, payload: Record<string, unknown>, withAuth: boolean): Promise<Record<string, unknown>> {
  if (!supabase || !FUNCTIONS_URL) throw new Error('Supabase not configured');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (withAuth) {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error('not signed in');
    headers['Authorization'] = `Bearer ${session.access_token}`;
  }
  const res = await fetch(`${FUNCTIONS_URL}/membership`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ action, ...payload }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(String(body.error || `membership ${action} failed (${res.status})`));
  return body;
}

export interface ProjectAccess { mode: 'all' | 'selected'; projectIds?: string[] }

export function createInvite(opts: { invitedName: string; personShort: string; role: 'admin' | 'member'; projectAccess: ProjectAccess; invitedEmail?: string }) {
  return callMembership('invite-create', opts as unknown as Record<string, unknown>, true) as Promise<{
    inviteId: string; link: string; token: string; expiresAt: string; invitedName: string; personShort: string;
  }>;
}

export function inviteInfo(token: string) {
  return callMembership('invite-info', { token }, false) as Promise<{
    valid: boolean; reason?: string; inviterName?: string; invitedEmail?: string | null; personShort?: string | null;
  }>;
}

export async function redeemInvite(opts: { token: string; email: string; password: string; displayName: string }): Promise<{ ok: boolean; personShort: string; role: string }> {
  const result = await callMembership('invite-redeem', opts as unknown as Record<string, unknown>, false) as {
    ok: boolean; personShort: string; role: string;
  };
  // The account now exists server-side; open the session locally with the
  // same credentials so the caller lands straight in the app.
  if (result.ok && supabase) {
    const { error } = await supabase.auth.signInWithPassword({ email: opts.email, password: opts.password });
    if (error) throw new Error(`joined, but sign-in failed: ${error.message}`);
  }
  return result;
}

// Joins the CURRENTLY signed-in user to the workspace (no account creation).
// Used for auto-redeeming a stashed token after Google sign-in, and by the
// NoAccess screen's paste field.
export function redeemInviteAuthed(token: string) {
  return callMembership('invite-redeem', { token }, true) as Promise<{ ok: boolean; personShort: string; role: string }>;
}

export function resetMemberPassword(userId: string, password: string) {
  return callMembership('reset-password', { userId, password }, true) as Promise<{ ok: boolean }>;
}

// ---------------------------------------------------------------------------
// Membership context
//
// Provided by the AuthGate in main.tsx once the member is verified. null when
// auth is disabled (VITE_AUTH_ENABLED unset) — App/MobileApp then fall back
// to the legacy localStorage identity, which keeps the pre-auth deploys and
// the flag-off rollout window fully functional.

export const MembershipContext = createContext<Membership | null>(null);

export function useMembership(): Membership | null {
  return useContext(MembershipContext);
}

// Convenience: is a given project visible to this member? Admins and
// mode:'all' members see everything; mode:'selected' members only their list.
// (Client-side filtering keyed to a verified identity — see design notes; the
// server-side room split is the phase-2 hardening.)
export function projectAllowed(member: Membership | null, projectId: string | undefined | null): boolean {
  if (!member) return true;               // auth disabled → legacy behavior
  if (member.role === 'admin') return true;
  const access = member.project_access;
  if (!access || access.mode === 'all') return true;
  if (!projectId) return true;            // unfiled tasks stay visible
  return Array.isArray(access.projectIds) && access.projectIds.includes(projectId);
}

// ---------------------------------------------------------------------------
// Invite token plumbing
//
// The link format is https://…/todo-app/?invite=TOKEN. The token is captured
// and stripped from the URL immediately (it's a bearer credential — it must
// not sit in the address bar or get into browser history any longer than
// necessary), then held in sessionStorage so a Google OAuth round-trip in the
// SAME browsing context can still find it. Cross-context handoffs (link opens
// in Safari, user wants the PWA) are handled by the invite screen's manual
// paste field instead — sessionStorage cannot cross that gap.

const INVITE_KEY = 'ctrl-invite-token';

export function captureInviteToken(): string | null {
  try {
    const url = new URL(window.location.href);
    let token = url.searchParams.get('invite');
    // Also accept #/invite/TOKEN (hash routes survive GitHub Pages rewrites).
    if (!token) {
      const m = window.location.hash.match(/^#\/invite\/([A-Za-z0-9_-]+)/);
      if (m) token = m[1];
    }
    if (token) {
      sessionStorage.setItem(INVITE_KEY, token);
      url.searchParams.delete('invite');
      window.history.replaceState({}, '', url.pathname + url.search);
      return token;
    }
    return sessionStorage.getItem(INVITE_KEY);
  } catch {
    return null;
  }
}

export function clearInviteToken(): void {
  try { sessionStorage.removeItem(INVITE_KEY); } catch { /* ignore */ }
}

// Accepts a pasted full link OR a bare token.
export function parseInviteInput(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    const fromQuery = url.searchParams.get('invite');
    if (fromQuery) return fromQuery;
    const m = url.hash.match(/^#\/invite\/([A-Za-z0-9_-]+)/);
    if (m) return m[1];
  } catch { /* not a URL — treat as bare token */ }
  return /^[A-Za-z0-9_-]{20,}$/.test(trimmed) ? trimmed : null;
}

// ---------------------------------------------------------------------------
// Sign-in / sign-out

export async function signInWithGoogle(): Promise<void> {
  if (!supabase) throw new Error('Supabase not configured');
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: APP_BASE_URL },
  });
  if (error) throw error;
}

export async function signInWithPassword(email: string, password: string): Promise<void> {
  if (!supabase) throw new Error('Supabase not configured');
  const { error } = await supabase.auth.signInWithPassword({ email: email.trim().toLowerCase(), password });
  if (error) throw error;
}

// scope:'local' — signing out on a shared browser must not also kill the
// Tauri and iPhone sessions (the default 'global' revokes every device's
// refresh token, which is brutal when password resets are admin-mediated).
export async function signOut(): Promise<void> {
  if (!supabase) return;
  clearMembershipCache();
  await supabase.auth.signOut({ scope: 'local' });
}
