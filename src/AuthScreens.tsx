// Pre-auth screens: SignIn, InviteJoin, NoAccess, AuthTrouble.
//
// These render OUTSIDE LiveblocksProvider (no room, no storage) so they must
// be self-sufficient: plain Tailwind on the app's palette, no shared-theme
// hook. Every screen carries the "Export local backup" escape hatch — an
// auth outage (paused Supabase, broken function, lost membership) must never
// stand between the owner and the snapshot in his own IndexedDB.

import React, { useEffect, useState } from 'react';
import {
  APP_BASE_URL, IS_TAURI,
  inviteInfo, redeemInvite, parseInviteInput, clearInviteToken,
  signInWithGoogle, signInWithPassword, signOut,
} from './auth';
import { getSlot, downloadSnapshot } from './backup';

// ---------------------------------------------------------------------------
// Shared bits

const FONT = "font-['Univers_BQ:55_Regular',sans-serif]";
const HEAD = "font-['NB_International:Regular',sans-serif]";
const INPUT = `${FONT} w-full h-[42px] px-[16px] rounded-full bg-[#151412] text-white text-[14px] placeholder-[#656464] outline-none focus:ring-1 focus:ring-[var(--app-accent,#7666fc)] border border-transparent`;
const BTN_PRIMARY = `${FONT} w-full h-[42px] rounded-full bg-[var(--app-accent,#7666fc)] text-white text-[14px] hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-default`;
const BTN_QUIET = `${FONT} text-[13px] text-[#656464] hover:text-white transition-colors`;

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="min-h-screen w-full flex flex-col items-center justify-center px-[24px]"
      style={{ backgroundColor: 'var(--app-bg, #1c1b19)', paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="w-full max-w-[360px] flex flex-col items-stretch gap-[14px]">
        {children}
      </div>
    </div>
  );
}

function Logo() {
  return (
    <div className={`${HEAD} text-white text-[19px] text-center mb-[10px]`}>
      Ctrl-Project
    </div>
  );
}

function ErrorLine({ msg }: { msg: string | null }) {
  if (!msg) return null;
  return <div className={`${FONT} text-[12.5px] text-[#e0644f] text-center leading-snug`}>{msg}</div>;
}

// Maps raw Supabase/API errors to copy a human can act on.
function friendlyError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  if (/invalid login credentials/i.test(raw)) return 'Wrong email or password.';
  if (/at least 6/i.test(raw)) return 'Password needs at least 6 characters.';
  if (/failed to fetch|network/i.test(raw)) return "Can't reach the server — check your connection and try again.";
  if (/signups not allowed|signup.*disabled/i.test(raw)) return 'Accounts are invite-only — ask for an invite link.';
  return raw;
}

// The escape hatch. Reads the local IndexedDB snapshot directly — zero
// network, works when every server in this stack is down.
function ExportBackupLink() {
  const [state, setState] = useState<'idle' | 'none' | 'done'>('idle');
  const exportLocal = async () => {
    try {
      const snap = (await getSlot('live')) ?? (await getSlot('daily'));
      if (!snap) { setState('none'); return; }
      downloadSnapshot(snap);
      setState('done');
    } catch {
      setState('none');
    }
  };
  return (
    <button type="button" onClick={exportLocal} className={`${BTN_QUIET} mt-[6px]`}>
      {state === 'none' ? 'No local backup found on this device' : state === 'done' ? 'Backup downloaded' : 'Export local backup'}
    </button>
  );
}

// Official Google "G" mark (branding guidelines require the real artwork).
function GoogleG() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden>
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

function GoogleButton({ onError }: { onError: (msg: string) => void }) {
  const [busy, setBusy] = useState(false);
  if (IS_TAURI) return null; // Google hard-blocks OAuth in embedded webviews
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await signInWithGoogle(); // full-page redirect follows on success
        } catch (e) {
          setBusy(false);
          onError(friendlyError(e));
        }
      }}
      className={`${FONT} w-full h-[42px] rounded-full bg-white text-[#1f1f1f] text-[14px] flex items-center justify-center gap-[10px] hover:bg-[#f1f1f1] transition-colors disabled:opacity-40`}
    >
      <GoogleG />
      {busy ? 'Opening Google…' : 'Continue with Google'}
    </button>
  );
}

function Divider() {
  return (
    <div className="flex items-center gap-[10px]">
      <div className="flex-1 h-px bg-[#33312e]" />
      <span className={`${FONT} text-[12px] text-[#656464]`}>or</span>
      <div className="flex-1 h-px bg-[#33312e]" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// SignIn — the default gate for anyone without a session.

export function SignInScreen({ onHaveInvite }: { onHaveInvite: (token: string) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showPaste, setShowPaste] = useState(false);
  const [pasteValue, setPasteValue] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await signInWithPassword(email, password);
      // onAuthStateChange in the gate takes it from here.
    } catch (err) {
      setError(friendlyError(err));
      setBusy(false);
    }
  };

  return (
    <Shell>
      <Logo />
      <GoogleButton onError={setError} />
      {!IS_TAURI && <Divider />}
      <form onSubmit={submit} className="flex flex-col gap-[10px]">
        <input
          className={INPUT} type="email" placeholder="Email" value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email" autoCapitalize="none" autoCorrect="off" spellCheck={false}
        />
        <input
          className={INPUT} type="password" placeholder="Password" value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
        />
        <button type="submit" className={BTN_PRIMARY} disabled={busy || !email || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      <ErrorLine msg={error} />
      <div className="flex flex-col items-center gap-[2px] mt-[4px]">
        {showPaste ? (
          <div className="w-full flex flex-col gap-[8px]">
            <input
              className={INPUT} placeholder="Paste your invite link" value={pasteValue}
              onChange={(e) => setPasteValue(e.target.value)}
              autoCapitalize="none" autoCorrect="off" spellCheck={false}
            />
            <button
              type="button" className={BTN_PRIMARY}
              disabled={!parseInviteInput(pasteValue)}
              onClick={() => { const t = parseInviteInput(pasteValue); if (t) onHaveInvite(t); }}
            >
              Use invite
            </button>
          </div>
        ) : (
          <button type="button" className={BTN_QUIET} onClick={() => setShowPaste(true)}>
            Have an invite link?
          </button>
        )}
        <div className={`${FONT} text-[12px] text-[#4a4948] text-center leading-snug mt-[6px]`}>
          Accounts are invite-only. Forgot your password? Ask your admin to reset it.
        </div>
        <ExportBackupLink />
      </div>
    </Shell>
  );
}

// ---------------------------------------------------------------------------
// InviteJoin — opened an invite link (or pasted one). Creates the account
// server-side and signs in. This IS the sign-up form.

export function InviteJoinScreen({ token, onDone, onBail }: {
  token: string;
  onDone: () => void;
  onBail: () => void; // invalid/expired → back to SignIn
}) {
  const [info, setInfo] = useState<{ valid: boolean; reason?: string; transient?: boolean; inviterName?: string; invitedEmail?: string | null; personShort?: string | null } | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setInfo(null);
    inviteInfo(token)
      .then((i) => {
        if (!alive) return;
        setInfo(i);
        if (i.invitedEmail) setEmail(i.invitedEmail);
      })
      // A THROW means we couldn't ask the server — the invite itself may be
      // perfectly fine (server asleep / offline). Distinct copy + Retry, never
      // "doesn't work anymore".
      .catch((e) => { if (alive) setInfo({ valid: false, transient: true, reason: friendlyError(e) }); });
    return () => { alive = false; };
  }, [token, attempt]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await redeemInvite({ token, email, password, displayName: name.trim() });
      clearInviteToken();
      onDone();
    } catch (err) {
      setError(friendlyError(err));
      setBusy(false);
    }
  };

  if (!info) {
    return (
      <Shell>
        <Logo />
        <div className={`${FONT} text-[13px] text-[#656464] text-center`}>Checking your invite…</div>
      </Shell>
    );
  }

  if (!info.valid) {
    return (
      <Shell>
        <Logo />
        <div className={`${FONT} text-[14px] text-white text-center`}>
          {info.transient ? "Can't check your invite right now" : "This invite doesn't work anymore"}
        </div>
        <div className={`${FONT} text-[13px] text-[#656464] text-center leading-snug`}>
          {info.transient
            ? `${info.reason} Your invite is probably still fine — try again in a moment.`
            : `${info.reason || 'It may have expired or been revoked.'} Ask for a fresh link.`}
        </div>
        {info.transient && (
          <button type="button" className={BTN_PRIMARY} onClick={() => setAttempt((a) => a + 1)}>
            Retry
          </button>
        )}
        <button
          type="button"
          className={info.transient ? BTN_QUIET : BTN_PRIMARY}
          onClick={() => { if (!info.transient) clearInviteToken(); onBail(); }}
        >
          Back to sign in
        </button>
        <ExportBackupLink />
      </Shell>
    );
  }

  return (
    <Shell>
      <Logo />
      <div className={`${FONT} text-[14px] text-white text-center leading-snug`}>
        {info.inviterName} invited you to Ctrl-Project
      </div>
      <form onSubmit={submit} className="flex flex-col gap-[10px] mt-[6px]">
        <input
          className={INPUT} placeholder="Your name" value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="name" autoCapitalize="words"
        />
        <input
          className={INPUT} type="email" placeholder="Email" value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email" autoCapitalize="none" autoCorrect="off" spellCheck={false}
        />
        <div className="flex flex-col gap-[4px]">
          <input
            className={INPUT} type="password" placeholder="Choose a password" value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
          />
          <span className={`${FONT} text-[11.5px] text-[#656464] px-[16px]`}>At least 6 characters</span>
        </div>
        <button type="submit" className={BTN_PRIMARY} disabled={busy || !name.trim() || !email || password.length < 6}>
          {busy ? 'Joining…' : 'Join workspace'}
        </button>
      </form>
      <ErrorLine msg={error} />
      <div className={`${FONT} text-[12px] text-[#4a4948] text-center leading-snug`}>
        You'll sign in with this email and password on all your devices.
        {!IS_TAURI && ' You can also use "Continue with Google" later if this is your Gmail address.'}
      </div>
    </Shell>
  );
}

// ---------------------------------------------------------------------------
// NoAccess — signed in but no membership. Error-only state (the happy path
// auto-redeems before ever getting here).

export function NoAccessScreen({ email, onUseInvite }: {
  email: string;
  // Resolves to null on success (the gate re-renders past this screen) or an
  // error message to show INLINE. A rejected invite ("expired", "already
  // used") must never masquerade as a server outage.
  onUseInvite: (token: string) => Promise<string | null>;
}) {
  const [pasteValue, setPasteValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Shell>
      <Logo />
      <div className={`${FONT} text-[14px] text-white text-center`}>No access to this workspace</div>
      <div className={`${FONT} text-[13px] text-[#656464] text-center leading-snug`}>
        You're signed in as {email}, but this account isn't a member.
        If you have an invite link, paste it below — otherwise ask the admin for one.
      </div>
      <input
        className={INPUT} placeholder="Paste your invite link" value={pasteValue}
        onChange={(e) => { setPasteValue(e.target.value); setError(null); }}
        autoCapitalize="none" autoCorrect="off" spellCheck={false}
      />
      <button
        type="button" className={BTN_PRIMARY}
        disabled={!parseInviteInput(pasteValue) || busy}
        onClick={async () => {
          const t = parseInviteInput(pasteValue);
          if (!t) return;
          setBusy(true);
          setError(null);
          const err = await onUseInvite(t);
          setBusy(false);
          if (err) setError(err);
        }}
      >
        {busy ? 'Checking…' : 'Use invite'}
      </button>
      <ErrorLine msg={error} />
      <button type="button" className={BTN_QUIET} onClick={() => void signOut()}>
        Sign out
      </button>
      <ExportBackupLink />
    </Shell>
  );
}

// ---------------------------------------------------------------------------
// AuthTrouble — the auth stack itself is unreachable (paused project, dead
// function, network). Distinct from SignIn so nobody misreads an outage as
// "I was removed" — and the local backup stays one click away.

export function AuthTroubleScreen({ detail, onRetry }: { detail: string; onRetry: () => void }) {
  return (
    <Shell>
      <Logo />
      <div className={`${FONT} text-[14px] text-white text-center`}>Can't reach the sign-in server</div>
      <div className={`${FONT} text-[13px] text-[#656464] text-center leading-snug`}>
        Your tasks are safe. This is usually a network hiccup or the server waking up —
        wait a few seconds and retry. If it persists, tell Benno (the Supabase project may be paused).
      </div>
      <div className={`${FONT} text-[11.5px] text-[#4a4948] text-center break-all`}>{detail}</div>
      <button type="button" className={BTN_PRIMARY} onClick={onRetry}>Retry</button>
      <button type="button" className={BTN_QUIET} onClick={() => { void signOut(); onRetry(); }}>
        Sign out
      </button>
      <ExportBackupLink />
    </Shell>
  );
}

// Re-export for the gate's convenience.
export { APP_BASE_URL };
