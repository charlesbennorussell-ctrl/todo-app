// Capsule controls with a LIVE knob — the one toggle language for both surfaces.
//
// A near-black track, capsules on it, and ONE knob (the surface colour) that slides to
// whichever capsule is selected. The knob is a real element that MOVES, not a background that
// swaps: its two edges are animated separately, so it stretches toward the target and contracts
// when it lands — the liquid of iOS's segmented control. Two feels, chosen by surface:
//
//   'spring'  (desktop, mouse) — springs, the leading edge stiffer than the trailing one.
//                                 Interruptible: a click mid-flight carries the current velocity
//                                 into the new target instead of restarting.
//   'quintic' (phone, touch)   — easeInOutQuint on both edges, the trailing edge a beat behind
//                                 so the knob still stretches. Plus Material's touch feedback: a
//                                 bounded ripple growing from the touch point, and an unbounded
//                                 halo that flashes and is gone.
//
// Imports nothing from the app, so any file can use it without a cycle.
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { AnimatePresence, animate, motion, useMotionValue, useTransform } from 'motion/react';

export type Feel = 'spring' | 'quintic';

// ─── Motion vocabulary ────────────────────────────────────────────────────────────────────
// Desktop. The LEADING edge is the one facing the target; it gets there in ~150ms with a hair
// of overshoot (ζ≈0.80 → ~1.5%, so on a 160px move it pokes ~2px past the capsule — inside
// the track's 3px padding even on an end capsule). The TRAILING edge follows on a softer
// spring (ζ≈0.8, arrives ~130ms later), which is what makes the knob elongate on the way —
// to about 1.8× its length mid-travel — and gather itself on arrival, settling by ~450ms.
// Measured in dev/harness.html, not guessed.
const SPRING_LEAD = { type: 'spring' as const, stiffness: 560, damping: 38, mass: 1 };
const SPRING_TRAIL = { type: 'spring' as const, stiffness: 240, damping: 25, mass: 1 };
// Row changes (a capsule on the next wrapped line) move both edges together.
const SPRING_ROW = { type: 'spring' as const, stiffness: 420, damping: 32, mass: 1 };
// A capsule appearing on its own (multi-select) and the press-dip on the knob.
const SPRING_SOLO = { type: 'spring' as const, stiffness: 520, damping: 30, mass: 0.8 };
const SPRING_PRESS = { type: 'spring' as const, stiffness: 700, damping: 34, mass: 0.6 };
// Phone. easeInOutQuint — nearly still for the first tenth, then a rush, then a long glide in.
// The trailing edge starts a beat later, so the knob is longest mid-travel.
export const QUINT: [number, number, number, number] = [0.83, 0, 0.17, 1];
const QUINT_DUR = 0.46;
const QUINT_LAG = 0.07;

function reducedMotion(): boolean {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

// ─── Knob engine ──────────────────────────────────────────────────────────────────────────
type Box = { l: number; t: number; r: number; b: number };

// Position of the capsule carrying data-knob-item=id, relative to the track. Bounding rects
// rather than offsetLeft, so a capsule wrapped in a positioned span (the phone's native date
// field) measures the same as a bare one. Capsules never scale their own box — the press-dip is
// on the label inside — so a rect read right after a click is the true box.
function measure(track: HTMLElement, id: string): Box | null {
  const tr = track.getBoundingClientRect();
  for (const el of Array.from(track.querySelectorAll<HTMLElement>('[data-knob-item]'))) {
    if (el.getAttribute('data-knob-item') !== id) continue;
    const r = el.getBoundingClientRect();
    return { l: r.left - tr.left, t: r.top - tr.top, r: r.right - tr.left, b: r.bottom - tr.top };
  }
  return null;
}

const sameBox = (a: Box | null, b: Box) => !!a && a.l === b.l && a.t === b.t && a.r === b.r && a.b === b.b;

type TrackCtxValue = { feel: Feel; shared: boolean; knob: string; pressKnob: (down: boolean) => void };
const TrackCtx = createContext<TrackCtxValue | null>(null);

/**
 * The track. Pass `active` (the data-knob-item id of the selected capsule) for a single-select
 * group and the track owns one sliding knob; omit it for a multi-select group and each active
 * capsule paints its own. Any child carrying data-knob-item can be a knob target — a Capsule,
 * or a bespoke button such as the phone's day tabs.
 */
export function CapsuleTrack({ active, feel = 'spring', knob = '#232220', className = '', style, attrs, children }: {
  active?: string | null;
  feel?: Feel;
  /** The knob's colour: the surface the capsules belong to (sheet, page, panel). */
  knob?: string;
  className?: string;
  style?: CSSProperties;
  /** Extra attributes for the track element (data-* hooks such as the sheets' data-chip-track). */
  attrs?: Record<string, string>;
  children: ReactNode;
}) {
  const shared = active !== undefined;
  const ref = useRef<HTMLDivElement>(null);
  const l = useMotionValue(0);
  const t = useMotionValue(0);
  const r = useMotionValue(0);
  const b = useMotionValue(0);
  const w = useTransform([l, r], ([a, c]: number[]) => Math.max(0, c - a));
  const h = useTransform([t, b], ([a, c]: number[]) => Math.max(0, c - a));
  const scale = useMotionValue(1);
  const [shown, setShown] = useState(false);
  const lastId = useRef<string | null>(null);
  const lastBox = useRef<Box | null>(null);
  const feelRef = useRef(feel);
  feelRef.current = feel;

  const goTo = (box: Box, animated: boolean) => {
    const from = lastBox.current;
    if (!animated || !from || reducedMotion()) {
      l.jump(box.l); r.jump(box.r); t.jump(box.t); b.jump(box.b);
      return;
    }
    // Moving right → the right edge leads. Ties (a pure row change) lead with the left.
    const rightward = box.l + box.r > from.l + from.r;
    const lead = rightward ? r : l;
    const trail = rightward ? l : r;
    const leadTo = rightward ? box.r : box.l;
    const trailTo = rightward ? box.l : box.r;
    if (feelRef.current === 'spring') {
      animate(lead, leadTo, SPRING_LEAD);
      animate(trail, trailTo, SPRING_TRAIL);
      animate(t, box.t, SPRING_ROW);
      animate(b, box.b, SPRING_ROW);
    } else {
      animate(lead, leadTo, { duration: QUINT_DUR, ease: QUINT });
      animate(trail, trailTo, { duration: QUINT_DUR, ease: QUINT, delay: QUINT_LAG });
      animate(t, box.t, { duration: QUINT_DUR, ease: QUINT });
      animate(b, box.b, { duration: QUINT_DUR, ease: QUINT });
    }
  };

  // Re-measure after EVERY render: the selection may have changed (animate there), or the
  // capsules may have re-flowed under an unchanged selection — a section appearing above, a
  // chip added before the active one, a wrap — in which case the knob jumps to keep up.
  const sync = (mayAnimate: boolean) => {
    const track = ref.current;
    const id = active ?? null;
    const box = track && id != null ? measure(track, id) : null;
    if (!box) {
      lastId.current = null; lastBox.current = null;
      setShown(false);
      return;
    }
    const changed = lastId.current !== id;
    if (!changed && sameBox(lastBox.current, box)) return;
    goTo(box, mayAnimate && changed);
    lastId.current = id; lastBox.current = box;
    setShown(true);
  };
  const syncRef = useRef(sync);
  syncRef.current = sync;
  useLayoutEffect(() => { if (shared) syncRef.current(true); });
  // Dev harness hook: lets the knob's motion values be read from the console.
  useEffect(() => {
    if (import.meta.env.DEV && ref.current) (ref.current as HTMLDivElement & { __mv?: unknown }).__mv = { l, t, r, b, scale };
  }, [l, t, r, b, scale]);
  useEffect(() => {
    const track = ref.current;
    if (!track || !shared) return;
    const ro = new ResizeObserver(() => syncRef.current(false));
    ro.observe(track);
    return () => ro.disconnect();
  }, [shared]);

  const pressKnob = (down: boolean) => { animate(scale, down ? 0.965 : 1, SPRING_PRESS); };

  return (
    <TrackCtx.Provider value={{ feel, shared, knob, pressKnob }}>
      <div ref={ref} className={`relative ${className}`} style={style} {...attrs}>
        {shared && (
          <motion.div
            aria-hidden
            className="absolute pointer-events-none"
            style={{ left: l, top: t, width: w, height: h, scale, borderRadius: 9999, backgroundColor: knob, opacity: shown ? 1 : 0 }}
          />
        )}
        {children}
      </div>
    </TrackCtx.Provider>
  );
}

/**
 * One capsule. Paints no background of its own inside a single-select track (the track's knob
 * is the background); inside a multi-select track it pops its own knob in and out. The label
 * dips on press (desktop); the ripple and halo answer a touch (phone).
 */
export function Capsule({ id, active, onClick, size = 'md', className = '', style, disabled, title, children }: {
  id: string;
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
  const shared = !!ctx?.shared;
  const knob = ctx?.knob ?? '#232220';
  const dims = size === 'sm' ? 'h-[26px] px-[12px]' : 'h-[36px] px-[14px]';
  const tone = active ? 'text-white' : feel === 'spring' ? 'text-[#656464] hover:text-[#a8a8a8]' : 'text-[#656464]';
  return (
    <button
      type="button"
      data-knob-item={id}
      onClick={onClick}
      disabled={disabled}
      title={title}
      onPointerDown={() => { if (active && shared) ctx?.pressKnob(true); }}
      onPointerUp={() => { if (shared) ctx?.pressKnob(false); }}
      onPointerCancel={() => { if (shared) ctx?.pressKnob(false); }}
      onPointerLeave={() => { if (shared) ctx?.pressKnob(false); }}
      className={`relative z-10 inline-flex items-center rounded-full bg-transparent select-none whitespace-nowrap text-[13px] font-['Univers_BQ:55_Regular',sans-serif] ${dims} ${tone} ${className}`}
      style={{ transition: 'color 240ms cubic-bezier(0.2, 0, 0, 1)', WebkitTapHighlightColor: 'transparent', isolation: 'isolate', ...style }}
    >
      {!shared && (
        <AnimatePresence initial={false}>
          {active && (
            <motion.span
              key="knob"
              aria-hidden
              className="absolute inset-0 rounded-full"
              style={{ backgroundColor: knob, zIndex: -1 }}
              initial={{ scale: 0.6, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.8, opacity: 0 }}
              transition={feel === 'spring' ? SPRING_SOLO : { duration: 0.3, ease: QUINT }}
            />
          )}
        </AnimatePresence>
      )}
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
// Drop <Ripple /> inside any positioned element and it answers presses on that element:
//   • a BOUNDED ripple — a soft-edged disc that starts under the finger at a fifth of the
//     element's size and grows to cover it while drifting to its centre (450ms, Material's
//     standard curve), then fades out 150ms after release, but never before it has been
//     visible for 225ms, so a quick tap still shows a full press;
//   • an UNBOUNDED halo — a disc a little larger than the element that flashes outward and is
//     gone in under 400ms.
// On touch the ripple waits 150ms before starting, and a finger that travels more than a few
// pixels first is a scroll, not a press — so a list can be flicked without lighting every row.
// A tap released inside those 150ms still ripples, on release. Numbers are Material Web's
// (ripple.ts): PRESS_GROW 450, MINIMUM_PRESS 225, INITIAL_ORIGIN_SCALE 0.2, PADDING 10,
// SOFT_EDGE 35% / min 75, TOUCH_DELAY 150, pressed opacity 0.12.
const TOUCH_DELAY_MS = 150;
const MINIMUM_PRESS_MS = 225;
const FADE_MS = 150;

type Wave = { id: number; fading: boolean; style: CSSProperties };
type Halo = { id: number; size: number };

export function Ripple({ color = 'rgba(255, 255, 255, 0.12)', haloColor = 'rgba(255, 255, 255, 0.22)', halo = true }: {
  color?: string;
  haloColor?: string;
  halo?: boolean;
}) {
  const hostRef = useRef<HTMLSpanElement>(null);
  const [waves, setWaves] = useState<Wave[]>([]);
  const [halos, setHalos] = useState<Halo[]>([]);
  useEffect(() => {
    const clip = hostRef.current;
    const el = clip?.parentElement;
    if (!clip || !el) return;
    // The host must clip nothing (the halo reaches outside it) and must be its own stacking
    // context, so the halo's negative z-index lands behind the label and NOT behind the host's
    // parent. Inline because the host is whatever element we were dropped into.
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
      if (halo) {
        setHalos((hs) => [...hs, { id, size: maxDim + 18 }]);
        later(() => setHalos((hs) => hs.filter((x) => x.id !== id)), 420);
      }
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
  }, [color, halo]);
  return (
    <>
      <span ref={hostRef} aria-hidden className="cap-ripple-clip">
        {waves.map((wv) => <span key={wv.id} className="cap-ripple-wave" style={{ ...wv.style, opacity: wv.fading ? 0 : 1 }} />)}
      </span>
      {halos.map((hl) => <span key={hl.id} aria-hidden className="cap-halo" style={{ width: hl.size, height: hl.size, backgroundColor: haloColor }} />)}
    </>
  );
}
