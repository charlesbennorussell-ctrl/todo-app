// Capsule controls — the one toggle language for both surfaces.
//
// A near-black track, capsules on it, and a knob (the surface colour) under whichever capsule is
// selected. The knob does not travel. When the selection changes, the old knob fades and shrinks
// away and a new one scales and fades in under the new capsule, a beat later — a change of
// state, not a journey. Two feels, chosen by surface:
//
//   'spring'  (desktop, mouse) — the new knob springs in from 0.7 with a hair of overshoot; the
//                                 label dips under the pointer while pressed, and an idle label
//                                 brightens on hover with a 300ms fade each way.
//   'quintic' (phone, touch)   — subtle: in from 0.92, easeInOutQuint, plus Material's bounded
//                                 press ripple growing from the touch point.
//
// Imports nothing from the app, so any file can use it without a cycle.
import { createContext, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';

export type Feel = 'spring' | 'quintic';

// ─── Motion vocabulary ────────────────────────────────────────────────────────────────────
export const QUINT: [number, number, number, number] = [0.83, 0, 0.17, 1];
// Where the knob starts from and shrinks to. The phone's are close to 1: a very subtle move.
const FROM_SCALE: Record<Feel, number> = { spring: 0.7, quintic: 0.92 };
const TO_SCALE: Record<Feel, number> = { spring: 0.85, quintic: 0.95 };
// The knob leaving: quick, shrinking a little as it goes.
const EXIT: Record<Feel, object> = {
  spring: { duration: 0.15, ease: [0.4, 0, 1, 1] },
  quintic: { duration: 0.16, ease: QUINT },
};
// The knob arriving: after the old one is mostly gone (the delay is about half the exit), so
// the change reads as "gone, then here" rather than as two knobs at once. On the desktop the
// scale rides a spring (ζ≈0.74 → a ~3% swell before it settles) while the opacity simply fades.
const ENTER: Record<Feel, object> = {
  spring: { scale: { type: 'spring', stiffness: 520, damping: 30, mass: 0.8, delay: 0.07 }, opacity: { duration: 0.18, ease: [0.2, 0, 0, 1], delay: 0.07 } },
  quintic: { duration: 0.28, ease: QUINT, delay: 0.06 },
};
const SPRING_PRESS = { type: 'spring' as const, stiffness: 700, damping: 34, mass: 0.6 };

function reducedMotion(): boolean {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

// ─── Track, knob, capsule ─────────────────────────────────────────────────────────────────
type TrackCtxValue = { feel: Feel; knob: string };
const TrackCtx = createContext<TrackCtxValue | null>(null);

/** The track: a styled container that tells its capsules which feel and knob colour to use. */
export function CapsuleTrack({ feel = 'spring', knob = '#232220', className = '', style, attrs, children }: {
  feel?: Feel;
  /** The knob's colour: the surface the capsules belong to (sheet, page, panel). */
  knob?: string;
  className?: string;
  style?: CSSProperties;
  /** Extra attributes for the track element (data-* hooks such as the sheets' data-chip-track). */
  attrs?: Record<string, string>;
  children: ReactNode;
}) {
  return (
    <TrackCtx.Provider value={{ feel, knob }}>
      <div className={className} style={style} {...attrs}>{children}</div>
    </TrackCtx.Provider>
  );
}

/**
 * The knob. Drop it inside any positioned, capsule-shaped host that is its own stacking context
 * (isolation: isolate) and toggle `active`: it scales and fades in, and fades and shrinks out.
 * Capsule uses it; bespoke buttons (the phone's day tabs, a calendar day) can too.
 */
export function CapsuleKnob({ active, feel = 'spring', color = '#232220' }: { active: boolean; feel?: Feel; color?: string }) {
  const instant = reducedMotion();
  return (
    <AnimatePresence initial={false}>
      {active && (
        <motion.span
          key="knob"
          aria-hidden
          className="absolute inset-0 rounded-full pointer-events-none"
          style={{ backgroundColor: color, zIndex: -1 }}
          initial={instant ? false : { opacity: 0, scale: FROM_SCALE[feel] }}
          animate={{ opacity: 1, scale: 1, transition: instant ? { duration: 0 } : ENTER[feel] }}
          exit={{ opacity: 0, scale: TO_SCALE[feel], transition: instant ? { duration: 0 } : EXIT[feel] }}
        />
      )}
    </AnimatePresence>
  );
}

/**
 * One capsule. Its knob appears under it when it is active (single- and multi-select alike).
 * The label dips on press (desktop); the ripple answers a touch (phone).
 */
export function Capsule({ active, onClick, size = 'md', className = '', style, disabled, title, children }: {
  active: boolean;
  onClick?: () => void;
  /** md = the sheets' 36px capsule; sm = the Settings toggles' 26px one. */
  size?: 'md' | 'sm';
  className?: string;
  style?: CSSProperties;
  disabled?: boolean;
  title?: string;
  children: ReactNode;
}) {
  const ctx = useContext(TrackCtx);
  const feel = ctx?.feel ?? 'spring';
  const knob = ctx?.knob ?? '#232220';
  // 16 / 14 of side padding: the 14 / 12 the sheets shipped with read as cramped.
  const dims = size === 'sm' ? 'h-[26px] px-[14px]' : 'h-[36px] px-[16px]';
  const tone = active ? 'text-white' : feel === 'spring' ? 'text-[#656464] hover:text-[#a8a8a8]' : 'text-[#656464]';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`relative inline-flex items-center rounded-full bg-transparent select-none whitespace-nowrap text-[13px] font-['Univers_BQ:55_Regular',sans-serif] ${dims} ${tone} ${className}`}
      // isolation: the knob sits at z-index -1, which must land behind the label and NOT behind
      // the track. The colour eases 300ms each way — the hover brightening and the turn to
      // white as the knob arrives are the same fade.
      style={{ transition: 'color 300ms ease', WebkitTapHighlightColor: 'transparent', isolation: 'isolate', ...style }}
    >
      <CapsuleKnob active={active} feel={feel} color={knob} />
      {feel === 'spring' ? (
        <motion.span className="relative" whileTap={{ scale: 0.94 }} transition={SPRING_PRESS}>{children}</motion.span>
      ) : (
        <span className="relative">{children}</span>
      )}
      {feel === 'quintic' && <Ripple />}
    </button>
  );
}

// ─── Touch feedback (Material) ────────────────────────────────────────────────────────────
// Drop <Ripple /> inside any positioned element and it answers presses on that element with a
// BOUNDED ripple: a soft-edged disc that starts under the finger at a fifth of the element's
// size and grows to cover it while drifting to its centre (450ms, Material's standard curve),
// then fades out 150ms after release — but never before it has been visible for 225ms, so a
// quick tap still shows a full press. On touch the ripple waits 150ms before starting, and a
// finger that travels more than a few pixels first is a scroll, not a press — so a list can be
// flicked without lighting every row. A tap released inside those 150ms still ripples, on
// release. Numbers are Material Web's (ripple.ts): PRESS_GROW 450, MINIMUM_PRESS 225,
// INITIAL_ORIGIN_SCALE 0.2, PADDING 10, SOFT_EDGE 35% / min 75, TOUCH_DELAY 150, pressed
// opacity 0.12.
const TOUCH_DELAY_MS = 150;
const MINIMUM_PRESS_MS = 225;
const FADE_MS = 150;

type Wave = { id: number; fading: boolean; style: CSSProperties };

export function Ripple({ color = 'rgba(255, 255, 255, 0.12)' }: { color?: string }) {
  const hostRef = useRef<HTMLSpanElement>(null);
  const [waves, setWaves] = useState<Wave[]>([]);
  useEffect(() => {
    const clip = hostRef.current;
    const el = clip?.parentElement;
    if (!clip || !el) return;
    // The host must be positioned (the clip is absolute inside it) and its own stacking context.
    // Inline because the host is whatever element we were dropped into.
    if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
    el.style.isolation = 'isolate';

    let seq = 0;
    let live: { id: number; at: number } | null = null;
    let pending: { x: number; y: number } | null = null;
    let down: { x: number; y: number } | null = null;
    let timer = 0;
    const timers: number[] = [];
    const later = (fn: () => void, ms: number) => { timers.push(window.setTimeout(fn, ms)); };

    const begin = (x: number, y: number) => {
      if (reducedMotion()) return;
      const rect = el.getBoundingClientRect();
      const w = rect.width, h = rect.height;
      const maxDim = Math.max(w, h);
      const softEdge = Math.max(0.35 * maxDim, 75);
      const initial = Math.max(1, Math.floor(maxDim * 0.2));
      const scaleTo = (Math.hypot(w, h) + 10 + softEdge) / initial;
      const id = ++seq;
      live = { id, at: performance.now() };
      const style = {
        width: initial, height: initial,
        '--r-x0': `${x - rect.left - initial / 2}px`, '--r-y0': `${y - rect.top - initial / 2}px`,
        '--r-x1': `${w / 2 - initial / 2}px`, '--r-y1': `${h / 2 - initial / 2}px`,
        '--r-s': String(scaleTo),
        background: `radial-gradient(closest-side, ${color} max(100% - 70px, 65%), transparent 100%)`,
      } as CSSProperties;
      setWaves((ws) => [...ws, { id, fading: false, style }]);
    };
    const end = () => {
      const cur = live;
      live = null;
      if (!cur) return;
      const wait = Math.max(0, MINIMUM_PRESS_MS - (performance.now() - cur.at));
      later(() => {
        setWaves((ws) => ws.map((x) => (x.id === cur.id ? { ...x, fading: true } : x)));
        later(() => setWaves((ws) => ws.filter((x) => x.id !== cur.id)), FADE_MS + 40);
      }, wait);
    };
    const onDown = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      // A control nested inside the host owns its own feedback.
      const btn = (e.target as Element).closest('button');
      if (btn && btn !== el && el.contains(btn)) return;
      down = { x: e.clientX, y: e.clientY };
      if (e.pointerType === 'touch') {
        pending = { x: e.clientX, y: e.clientY };
        timer = window.setTimeout(() => { if (pending) { begin(pending.x, pending.y); pending = null; } }, TOUCH_DELAY_MS);
      } else {
        begin(e.clientX, e.clientY);
      }
    };
    const onMove = (e: PointerEvent) => {
      if (!down) return;
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 12) {   // a scroll or a drag
        window.clearTimeout(timer); pending = null; down = null; end();
      }
    };
    const onUp = () => {
      window.clearTimeout(timer);
      if (pending) { begin(pending.x, pending.y); pending = null; }
      down = null;
      end();
    };
    const onCancel = () => { window.clearTimeout(timer); pending = null; down = null; end(); };
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onCancel);
    el.addEventListener('pointerleave', onCancel);
    return () => {
      window.clearTimeout(timer);
      timers.forEach((id) => window.clearTimeout(id));
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onCancel);
      el.removeEventListener('pointerleave', onCancel);
    };
  }, [color]);
  return (
    <span ref={hostRef} aria-hidden className="cap-ripple-clip">
      {waves.map((wv) => <span key={wv.id} className="cap-ripple-wave" style={{ ...wv.style, opacity: wv.fading ? 0 : 1 }} />)}
    </span>
  );
}
