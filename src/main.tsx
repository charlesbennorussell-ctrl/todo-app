import React, { useCallback, useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { LiveblocksProvider, RoomProvider, ClientSideSuspense } from '@liveblocks/react/suspense';
import type { Session } from '@supabase/supabase-js';
import App from './App';
import MobileApp from './MobileApp';
import './index.css';
import './liveblocks.config';
import { initialTasks, initialProjects, initialClients, initialPeople } from './data';
import { supabase } from './supabase';
import {
  MembershipContext, type Membership,
  fetchMembership, liveblocksAuthEndpoint, getAuthHealth, onAuthHealth,
  captureInviteToken, clearInviteToken, redeemInviteAuthed, signOut,
} from './auth';
import { SignInScreen, InviteJoinScreen, NoAccessScreen, AuthTroubleScreen } from './AuthScreens';

// Mobile-vs-desktop router. matchMedia is reactive — rotating an iPad or resizing a
// desktop browser across 768px hot-swaps mid-session. Overrides for testing:
//   ?mobile=1  → force the phone shell at any width
//   ?desktop=1 → force the desktop app at any width
// The PIP quick-view window is always the desktop App (its own reduced layout).
const MOBILE_BREAKPOINT = '(max-width: 767px)';
const urlParams = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
const FORCE_MOBILE = !!urlParams?.has('mobile');
const FORCE_DESKTOP = !!urlParams?.has('desktop') || !!urlParams?.has('pip');
const Shell = () => {
  const [isMobile, setIsMobile] = useState<boolean>(() => typeof window !== 'undefined' && window.matchMedia(MOBILE_BREAKPOINT).matches);
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_BREAKPOINT);
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  if (FORCE_DESKTOP) return <App />;
  return (FORCE_MOBILE || isMobile) ? <MobileApp /> : <App />;
};

const publicApiKey = import.meta.env.VITE_LIVEBLOCKS_PUBLIC_KEY as string | undefined;
const roomId = (import.meta.env.VITE_ROOM_ID as string | undefined) || 'todo-app-v3';

// Auth rollout flag. OFF → the app behaves exactly as before (public key, no
// gate) so this code can deploy safely BEFORE the backend is provisioned.
// Flipped to '1' in .env.production during the cutover window (deploy + pk
// key revocation happen in the same sitting — see AUTH-ROLLOUT.md).
const AUTH_ENABLED = (import.meta.env.VITE_AUTH_ENABLED as string | undefined) === '1' && !!supabase;

// The ONLY rooms any build may connect to. A typo'd VITE_ROOM_ID must fail
// loudly here — with token auth the server would reject unknown rooms anyway,
// but a public-key build would silently CREATE the room and seed it, which
// looks exactly like total data loss to the person staring at demo tasks.
const ROOM_ALLOWLIST = new Set(['todo-app-v3', 'todo-app-sandbox-dev']);
const roomIdValid = ROOM_ALLOWLIST.has(roomId);

// New rooms get seeded from initialStorage. Demo data is a dev convenience
// only — a production build must never plant demo tasks anywhere.
const seedData = import.meta.env.DEV
  ? { tasks: initialTasks, projects: initialProjects, clients: initialClients, people: initialPeople }
  : { tasks: [], projects: [], clients: [], people: [] };

// Wipe the browser's local CACHES only: the Liveblocks offline room cache + the `focus-images-cache`
// blob store. Both are caches — the room's source of truth is the Liveblocks server and images
// re-fetch from Supabase — so dropping them just forces a clean re-sync, never losing real data.
// CRITICAL: the `ctrl-project-backups` IndexedDB store is the user's local BACKUP safety net, NOT a
// cache — it must survive a reset (it's exactly what you'd restore from if the room were lost). Any
// db whose name mentions "backup" is protected. localStorage (focus-image binaries + settings +
// the Supabase session) is likewise left untouched.
const PROTECTED_DB = /backup/i;
async function clearLocalCache(): Promise<void> {
  const names = new Set<string>(['focus-images-cache']);
  try {
    if (typeof indexedDB !== 'undefined' && indexedDB.databases) {
      const dbs = await indexedDB.databases();
      dbs.forEach((d) => { if (d.name) names.add(d.name); });
    }
  } catch { /* enumeration unsupported — fall back to the known cache name */ }
  await Promise.all([...names]
    .filter((name) => !PROTECTED_DB.test(name))
    .map((name) => new Promise<void>((resolve) => {
      try {
        const req = indexedDB.deleteDatabase(name);
        req.onsuccess = req.onerror = req.onblocked = () => resolve();
      } catch { resolve(); }
    })));
}

// Auto-recovery for a wedged "Connecting…". The Suspense fallback below stays mounted the whole
// time the Liveblocks room is connecting; if it's STILL up after RECOVER_MS the handshake has
// stalled (classic cause: the disk filled and the webview couldn't write its local cache, leaving
// it corrupt). We then auto-reset the local cache once and reload. A per-session attempt counter
// guards against a reload loop — after the one automatic reset we stop and surface a manual button
// rather than reloading forever.
//
// AUTH CAVEAT: when token auth is on, a stall can also mean "the auth stack is down" — and wiping
// caches is the WRONG medicine for that (it fixes nothing and eats the focus-images cache). The
// timer consults getAuthHealth(): only a stall with HEALTHY auth earns the wipe; auth trouble
// renders its own message and the AuthGate's health subscription usually swaps the screen first.
const RECOVER_MS = 10000;
const ATTEMPT_KEY = 'lb-recover-attempts';

// Liveblocks logs "Max number of concurrent connections per room exceeded" to console.error when the
// room's live-connection cap is hit (too many windows/tabs on the same room at once). Detect it so
// the recovery screen can tell the user to CLOSE other windows — NOT reload, because every reload
// opens another connection and keeps the cap saturated (the auto-recovery was making it worse).
let concurrencyLimited = false;
if (typeof console !== 'undefined') {
  const origError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    try { if (args.some((a) => typeof a === 'string' && /concurrent connections/i.test(a))) concurrencyLimited = true; } catch { /* ignore */ }
    origError(...args);
  };
}

// Launch screen: pure black with the app mark centred. Replaces the old
// "Connecting…" text, and — via SplashGate below — stays up for one beat after
// the app mounts so the two cross-fade instead of cutting.
const SPLASH_FADE_MS = 480;
const SPLASH_ENTER_MS = 320;
// The quintic curve the rest of the app settles on.
const SPLASH_EASE = 'cubic-bezier(0.86, 0, 0.07, 1)';

// The mark fades UP on first paint. Module-scoped so it happens exactly once per
// launch: the splash is rendered by two different owners (Loading while the room
// connects, then SplashGate during the hand-off), and without this the second
// mount would fade in all over again — a visible blink mid-boot.
let splashHasEntered = false;

const SplashScreen = ({ fading = false }: { fading?: boolean }) => {
  const [entered, setEntered] = useState(splashHasEntered);
  useEffect(() => {
    if (splashHasEntered) return;
    // rAF for the smooth case, timer for the non-compositing one (see SplashGate).
    const r = requestAnimationFrame(() => { splashHasEntered = true; setEntered(true); });
    const t = window.setTimeout(() => { splashHasEntered = true; setEntered(true); }, 60);
    return () => { cancelAnimationFrame(r); window.clearTimeout(t); };
  }, []);
  return (
    <div
      aria-hidden
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: '#000',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        opacity: fading ? 0 : entered ? 1 : 0,
        transition: `opacity ${fading ? SPLASH_FADE_MS : SPLASH_ENTER_MS}ms ${SPLASH_EASE}`,
        pointerEvents: 'none',
      }}
    >
      <img
        // BASE_URL keeps this correct under the '/todo-app/' production base and
        // '/' in dev, on desktop and phone alike.
        src={`${import.meta.env.BASE_URL || '/'}icons/icon-512.png`}
        alt=""
        style={{ width: 'min(60vw, 208px)', height: 'auto', display: 'block' }}
      />
    </div>
  );
};

// index.html already ships <body class="booting"> so the FIRST painted frame is
// black. This is the fallback for any entry that does NOT go through that markup
// (a dev harness, a future SSR shell); the desktop app is not one of them — it
// loads the hosted URL, so it gets the real index.html. Adding a class that is
// already there is a no-op, so this is free.
if (typeof document !== 'undefined') document.body.classList.add('booting');

// Mounts the app immediately, then dissolves the splash over it. The app fades
// UP as the splash fades OUT, both on the same curve, so there is no cut and no
// moment of empty background between them.
const SplashGate = ({ children }: { children: React.ReactNode }) => {
  const [revealed, setRevealed] = useState(false);
  const [removed, setRemoved] = useState(false);
  useEffect(() => {
    // Two frames: one for the app to lay out, one for it to paint. Starting the
    // fade in the same frame it mounts can catch a half-drawn first frame.
    //
    // The TIMER is not belt-and-braces, it is the safety net: requestAnimationFrame
    // does not fire at all while a window is not compositing (backgrounded at
    // launch, a hidden tab, some remote/virtual displays). Without it the reveal
    // never runs and the user is left staring at a permanent black screen with a
    // fully-loaded app behind it. Whichever fires first wins; setRevealed is
    // idempotent.
    let r2 = 0;
    const r1 = requestAnimationFrame(() => { r2 = requestAnimationFrame(() => setRevealed(true)); });
    const safety = window.setTimeout(() => setRevealed(true), 400);
    return () => { cancelAnimationFrame(r1); if (r2) cancelAnimationFrame(r2); window.clearTimeout(safety); };
  }, []);
  useEffect(() => {
    if (!revealed) return;
    const t = window.setTimeout(() => {
      setRemoved(true);
      document.body.classList.remove('booting');
    }, SPLASH_FADE_MS + 80);
    return () => window.clearTimeout(t);
  }, [revealed]);
  return (
    <>
      <div style={{ height: '100%', opacity: revealed ? 1 : 0, transition: `opacity ${SPLASH_FADE_MS}ms ${SPLASH_EASE}` }}>
        {children}
      </div>
      {!removed && <SplashScreen fading={revealed} />}
    </>
  );
};

const Loading = () => {
  const [phase, setPhase] = useState<'connecting' | 'stuck' | 'concurrency' | 'authTrouble'>('connecting');
  const [authDetail, setAuthDetail] = useState('');
  useEffect(() => {
    // Watch for the concurrency-limit error the moment it appears → switch to the "close windows"
    // message and STOP (never reload — that just opens another connection).
    const poll = window.setInterval(() => { if (concurrencyLimited) setPhase('concurrency'); }, 1200);
    let t = 0;
    let rearms = 0;
    const onExpiry = async () => {
      if (concurrencyLimited) { setPhase('concurrency'); return; }
      if (AUTH_ENABLED) {
        const health = getAuthHealth();
        if (health.status === 'forbidden' || health.status === 'unreachable') {
          // Auth outage, not a corrupt cache — do NOT wipe anything.
          setAuthDetail('detail' in health ? health.detail : '');
          setPhase('authTrouble');
          return;
        }
        // 'unknown' = the auth roundtrip hasn't COMPLETED yet (cold-started
        // edge function, slow network, a wedged getSession lock). Wiping fixes
        // none of those — the wipe is medicine for a corrupt ROOM cache, which
        // can only be the diagnosis once auth has positively succeeded ('ok').
        // Re-arm once to give slow auth time to land; then show auth copy.
        if (health.status !== 'ok') {
          if (rearms < 1) { rearms++; t = window.setTimeout(onExpiry, RECOVER_MS); return; }
          setAuthDetail('sign-in is not responding');
          setPhase('authTrouble');
          return;
        }
      }
      const attempts = Number(sessionStorage.getItem(ATTEMPT_KEY) || '0');
      if (attempts >= 1) { setPhase('stuck'); return; } // already auto-reset once → hand off to manual
      sessionStorage.setItem(ATTEMPT_KEY, '1');
      await clearLocalCache();
      window.location.reload();
    };
    t = window.setTimeout(onExpiry, RECOVER_MS);
    return () => { window.clearInterval(poll); window.clearTimeout(t); };
  }, []);
  const manualReset = async () => { await clearLocalCache(); window.location.reload(); };
  const btn: React.CSSProperties = { marginTop: 2, padding: '8px 16px', background: 'var(--app-accent)', color: 'white', border: 'none', borderRadius: 6, fontSize: 13, cursor: 'pointer' };
  return (
    <div style={{ minHeight: '100vh', background: '#000', color: '#666', display: 'flex', flexDirection: 'column', gap: 14, alignItems: 'center', justifyContent: 'center', fontFamily: 'sans-serif', padding: 40, textAlign: 'center' }}>
      {phase === 'concurrency' ? (
        <>
          <div style={{ fontSize: 15, color: '#ccc' }}>Too many windows connected</div>
          <div style={{ fontSize: 13, color: '#7a7a7a', maxWidth: 360, lineHeight: 1.5 }}>
            This room hit its live-connection limit. Close your other Ctrl-Project windows — the main app, the PIP quick-view, and any browser tabs — wait about a minute, then Retry. Your tasks are safe on the server; reloading won't help (it just opens another connection).
          </div>
          <button onClick={() => window.location.reload()} style={btn}>Retry</button>
        </>
      ) : phase === 'authTrouble' ? (
        <>
          <div style={{ fontSize: 15, color: '#ccc' }}>Sign-in problem</div>
          <div style={{ fontSize: 13, color: '#7a7a7a', maxWidth: 360, lineHeight: 1.5 }}>
            The room can't authenticate right now{authDetail ? ` (${authDetail})` : ''}. Your tasks are safe on the server and your local backup is untouched. Retry in a moment, or sign out and back in.
          </div>
          <button onClick={() => window.location.reload()} style={btn}>Retry</button>
          <button onClick={() => { void signOut().then(() => window.location.reload()); }} style={{ ...btn, background: '#3a3a3a' }}>Sign out</button>
        </>
      ) : phase === 'stuck' ? (
        <>
          <div style={{ fontSize: 15, color: '#ccc' }}>Still can't connect</div>
          <div style={{ fontSize: 13, color: '#7a7a7a', maxWidth: 340, lineHeight: 1.5 }}>
            Usually a dropped network or low disk space. Resetting the local cache is safe — your tasks live on the server.
          </div>
          <button onClick={manualReset} style={btn}>Reset local data &amp; reload</button>
        </>
      ) : (
        // Normal path: no copy, no spinner — just the launch screen.
        <SplashScreen />
      )}
    </div>
  );
};

// Renders only once the room is connected. Clears the recovery counter so a fresh stall later in
// the same session still earns the full auto-reset treatment.
const Connected = () => {
  useEffect(() => { try { sessionStorage.removeItem(ATTEMPT_KEY); } catch { /* ignore */ } }, []);
  return <Shell />;
};

const Missing = ({ what, hint }: { what: string; hint: string }) => (
  <div style={{ minHeight: '100vh', background: '#282828', color: 'white', padding: 40, fontFamily: 'sans-serif' }}>
    <h2>{what}</h2>
    <p dangerouslySetInnerHTML={{ __html: hint }} />
  </div>
);

// The providers subtree — identical for both auth modes except for HOW the
// Liveblocks client authenticates.
const Providers = ({ member }: { member: Membership | null }) => (
  <MembershipContext.Provider value={member}>
    <LiveblocksProvider {...(AUTH_ENABLED
      ? { authEndpoint: () => liveblocksAuthEndpoint(roomId) }
      : { publicApiKey: publicApiKey! })}
    >
      <RoomProvider
        id={roomId}
        initialPresence={{ cursor: null }}
        initialStorage={{
          ...seedData,
          // Focus-mode storage is metadata-only. Image binaries live in browser
          // localStorage to keep each Liveblocks key under the per-value size cap.
          focusBriefs: {},
          focusSubtasks: {},
          focusImages: {},
          focusReferences: {},
          // Image-folder definitions per bucket. Bucket key = projectKey, taskKey,
          // or `wip:${projectKey}`. Each entry is an ordered list of folders.
          // Images carry an optional `folderId` that points into this list — null /
          // missing = root of the bucket.
          focusImageFolders: {},
          // Theme colours are shared across every surface (desktop / PIP / phone) so they
          // cannot drift the way per-device localStorage did. Only seeds a NEW room; existing
          // rooms have no `theme` key and fall back to the localStorage cache then defaults,
          // and get one written the first time a colour is changed in Settings.
          theme: { bg: '#1c1b19', accent: '#7666fc' },
          // Auto-capitalisation mode, shared for the same reason. New rooms carry the key
          // from birth; existing rooms get it from the desktop's one-time backfill.
          caseMode: 'off',
          // Sub-grouping switches, shared for the same reason. Seeds a NEW room only; existing
          // rooms have no `subGroup` key, fall back to the localStorage cache then the defaults,
          // and get one written the first time a switch is flipped in Settings.
          subGroup: { today: false, tomorrow: false, next: true },
        }}
      >
        <ClientSideSuspense fallback={<Loading />}>
          <SplashGate>
            <Connected />
          </SplashGate>
        </ClientSideSuspense>
      </RoomProvider>
    </LiveblocksProvider>
  </MembershipContext.Provider>
);

// ---------------------------------------------------------------------------
// AuthGate — sits ABOVE every provider so no room connection is opened until
// the caller is a verified member. Three-and-a-half states, but the happy
// path (invite in hand or session cached) never shows a middle screen: a
// stashed invite token is auto-redeemed the moment auth lands.

type GatePhase =
  | { k: 'boot' }
  | { k: 'signedOut' }
  | { k: 'invite'; token: string }
  | { k: 'checking' }
  | { k: 'noAccess'; email: string }
  | { k: 'member'; member: Membership }
  | { k: 'trouble'; detail: string };

// 'boot' and 'checking' render the launch screen, which by design says nothing —
// so a wedged getSession() or a hung members query would be indistinguishable
// from a slow one, forever, behind a black rectangle. Give the stall a deadline
// and fall through to AuthTroubleScreen, which carries Retry, Sign out and the
// Export-local-backup escape hatch. Independent of RECOVER_MS above: that timer
// only starts once the room providers have mounted, which is strictly later.
const BOOT_STALL_MS = 12000;

const AuthGate = () => {
  const [phase, setPhase] = useState<GatePhase>({ k: 'boot' });
  const evaluatingRef = useRef(false);
  // A SIGNED_IN that arrives while an evaluate is already in flight must not
  // be silently dropped (the in-flight one may be deciding on stale state) —
  // park it and re-run once the current pass finishes.
  const pendingRef = useRef<Session | null | undefined>(undefined);

  const evaluate = useCallback(async (session: Session | null) => {
    if (evaluatingRef.current) { pendingRef.current = session; return; }
    evaluatingRef.current = true;
    try {
      const stashedToken = captureInviteToken();
      if (!session) {
        setPhase(stashedToken ? { k: 'invite', token: stashedToken } : { k: 'signedOut' });
        return;
      }
      setPhase({ k: 'checking' });
      let result = await fetchMembership(session.user.id);
      // Happy-path auto-redeem: signed in + token in hand + not a member yet →
      // join silently, then re-check. Failures fall through to NoAccess where
      // the reason is visible and the paste field offers a way forward.
      if (result.kind === 'none' && stashedToken) {
        try {
          await redeemInviteAuthed(stashedToken);
          clearInviteToken();
        } catch { /* invalid/expired token → NoAccess below */ }
        // Re-check EVEN when redeem threw: a racing window (main + PIP) may
        // have completed the join first, making this window's failure moot.
        result = await fetchMembership(session.user.id);
      }
      if (result.kind === 'error') {
        setPhase({ k: 'trouble', detail: result.detail });
      } else if (result.kind === 'none') {
        setPhase({ k: 'noAccess', email: session.user.email || 'unknown' });
      } else {
        clearInviteToken(); // member + leftover token = already redeemed or moot
        setPhase({ k: 'member', member: result.member });
      }
    } finally {
      evaluatingRef.current = false;
      if (pendingRef.current !== undefined) {
        const next = pendingRef.current;
        pendingRef.current = undefined;
        void evaluate(next);
      }
    }
  }, []);

  useEffect(() => {
    if (!supabase) return;
    // Strip OAuth debris (?code=&state=) once supabase-js has done its
    // exchange — a bookmarked/refreshed code retriggers stale exchanges.
    const cleanOAuthParams = () => {
      try {
        const url = new URL(window.location.href);
        if (url.searchParams.has('code')) {
          url.searchParams.delete('code');
          url.searchParams.delete('state');
          window.history.replaceState({}, '', url.pathname + (url.search || ''));
        }
      } catch { /* ignore */ }
    };

    supabase.auth.getSession().then(({ data }) => { cleanOAuthParams(); void evaluate(data.session); });

    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') {
        setPhase({ k: 'signedOut' });
      } else if (event === 'SIGNED_IN') {
        cleanOAuthParams();
        // Dedupe: SIGNED_IN also fires on tab refocus; don't re-gate a
        // rendered member for the same user.
        setPhase((p) => {
          if (p.k === 'member' && p.member.user_id === session?.user?.id) return p;
          void evaluate(session);
          return p.k === 'member' ? p : { k: 'checking' };
        });
      }
      // TOKEN_REFRESHED / USER_UPDATED need no re-gate.
    });

    // Membership revoked mid-session: liveblocks-auth starts returning 403,
    // the health store flips to 'forbidden', and we re-evaluate — which tears
    // down the providers and lands on NoAccess/SignIn.
    const offHealth = onAuthHealth((h) => {
      if (h.status === 'forbidden') {
        void supabase.auth.getSession().then(({ data }) => evaluate(data.session));
      }
    });

    return () => { sub.subscription.unsubscribe(); offHealth(); };
  }, [evaluate]);

  // Re-arms on boot→checking on purpose: reaching 'checking' proves getSession
  // actually landed, so the membership query has earned its own full deadline
  // rather than inheriting the remains of the previous one. A late evaluate()
  // that resolves to 'member' simply overwrites this — last write wins.
  useEffect(() => {
    if (phase.k !== 'boot' && phase.k !== 'checking') return;
    const t = window.setTimeout(() => {
      // Release the in-flight guard first. `evaluate` opens with
      // `if (evaluatingRef.current) return`, so a run that never settled would
      // still hold it — and AuthTroubleScreen's Retry calls evaluate(), which
      // would early-return and do nothing at all. Declaring the stall over means
      // declaring that run abandoned.
      evaluatingRef.current = false;
      setPhase({ k: 'trouble', detail: 'sign-in did not respond' });
    }, BOOT_STALL_MS);
    return () => window.clearTimeout(t);
  }, [phase.k]);

  switch (phase.k) {
    case 'boot':
    case 'checking':
      // The same launch screen the room-connect fallback shows. Anything else
      // here — a themed ground, the word "Connecting…" — is a second screen
      // wedged between the black first frame and the splash, and that IS the
      // flicker. SplashScreen is position:fixed and needs no layout parent;
      // body.booting is the ground its mark fades up from. splashHasEntered
      // then keeps the Loading and SplashGate mounts from re-fading it.
      return <SplashScreen />;
    case 'signedOut':
      return <SignInScreen onHaveInvite={(token) => setPhase({ k: 'invite', token })} />;
    case 'invite':
      return (
        <InviteJoinScreen
          token={phase.token}
          onDone={() => { /* signInWithPassword inside redeem fires SIGNED_IN → evaluate */ }}
          onBail={() => setPhase({ k: 'signedOut' })}
        />
      );
    case 'noAccess':
      return (
        <NoAccessScreen
          email={phase.email}
          onUseInvite={async (token) => {
            // Returns the error INLINE — an expired/used/wrong-email invite is
            // a fact about the invite, and showing it as "can't reach the
            // sign-in server" would send the user chasing a phantom outage.
            try {
              await redeemInviteAuthed(token);
              clearInviteToken();
              const { data } = await supabase!.auth.getSession();
              void evaluate(data.session);
              return null;
            } catch (e) {
              return e instanceof Error ? e.message : String(e);
            }
          }}
        />
      );
    case 'trouble':
      return (
        <AuthTroubleScreen
          detail={phase.detail}
          onRetry={() => {
            setPhase({ k: 'boot' });
            void supabase!.auth.getSession().then(({ data }) => evaluate(data.session));
          }}
        />
      );
    case 'member':
      return <Providers member={phase.member} />;
  }
};

const Root = () => {
  if (!roomIdValid) {
    return <Missing what="Unknown room id" hint={`<code>VITE_ROOM_ID=${roomId}</code> is not in the room allowlist. Refusing to connect — a typo here would silently create and seed a new empty room.`} />;
  }
  if (AUTH_ENABLED) return <AuthGate />;
  if (!publicApiKey) {
    return <Missing what="Missing Liveblocks key" hint="Set <code>VITE_LIVEBLOCKS_PUBLIC_KEY</code> in <code>.env.local</code> and restart the dev server." />;
  }
  return <Providers member={null} />;
};

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
