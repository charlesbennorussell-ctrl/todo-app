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
//   'quintic' (phone, touch)   — subtle: in from 0.92, easeInOutQuint. The knob IS the touch
//                                 feedback: a press ripple and a halo were both tried and read
//                                 as a flash at the end of the move.
//
// Imports nothing from the app, so any file can use it without a cycle.
import { createContext, useContext, type CSSProperties, type ReactNode } from 'react';
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
 * The label dips on press (desktop).
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
    </button>
  );
}

