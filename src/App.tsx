import { Fragment, memo, useState, useCallback, useMemo, useRef, useEffect, useLayoutEffect } from 'react';
import { flushSync } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';
import { Plus, X, List, FolderTree, SlidersHorizontal as SettingsIcon, Folder, Trash2, Calendar as CalendarIcon, ChevronLeft, ChevronRight, ArrowUp, LayoutDashboard, Heart, FileText, Search } from 'lucide-react';
import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  DragEndEvent,
  DragStartEvent,
  DragOverEvent,
  DragOverlay,
  MeasuringStrategy,
  pointerWithin,
  useDroppable,
  useDraggable,
} from '@dnd-kit/core';
import { restrictToVerticalAxis, restrictToHorizontalAxis, restrictToParentElement } from '@dnd-kit/modifiers';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  rectSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

// Touch-primary device detection. Resolved once at module load (the answer
// is stable per session) so we don't pay for matchMedia on every render.
// Matches phones, finger-only tablets, etc. — devices where hover doesn't
// exist and the pointer is "coarse" (a finger, not a precise mouse pointer).
// Surfaces with both touch + mouse (some hybrids) resolve to false so they
// stay on the desktop tap-to-select-then-double-click-to-edit affordance.
// Touch-primary detection. Liberal — true on ANY of: touchstart available,
// maxTouchPoints > 0, hover-none pointer-coarse media query. Resolves once
// at module load (the answer is stable per session). The matchMedia alone
// returned false in some iPhone PWA configurations, which silently
// disabled the whole touch UX path.
const TOUCH_DEVICE = typeof window !== 'undefined' && (
  ('ontouchstart' in window)
  || ((navigator.maxTouchPoints || 0) > 0)
  || (typeof window.matchMedia === 'function' && window.matchMedia('(hover: none) and (pointer: coarse)').matches)
);

// PIP (picture-in-picture) mode. The Tauri shell opens a second always-on-top
// window at <app-url>?pip=1 via a global shortcut (Ctrl+Win+Space). When the
// flag is present the app renders ONLY the daily Dashboard stack — no nav, no
// other views — sized for a tall narrow window floating over other apps.
const PIP_MODE = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('pip');

// Focus-page column toggles. References (the DAM gallery) + Information are
// PARKED, not deleted — the external ctrl-assets app is taking over reference
// handling and a bridge between the two apps is planned. Flip these back to
// true to resurrect the columns exactly as they were.
const FOCUS_SHOW_INFO = false;
const FOCUS_SHOW_REFERENCES = false;

// Mobile debug overlay. Push a line via debugLog(message) and the most
// recent ~20 events render in a translucent strip at the bottom of the
// iPhone screen. Toggle by triple-tapping the strip (tap-tap-tap quickly
// at the very bottom of the screen). Only visible on TOUCH_DEVICE.
const DEBUG_BUFFER: Array<{ t: number; msg: string }> = [];
const DEBUG_SUBSCRIBERS: Array<() => void> = [];
function debugLog(msg: string) {
  if (!TOUCH_DEVICE) return;
  DEBUG_BUFFER.push({ t: Date.now(), msg });
  if (DEBUG_BUFFER.length > 30) DEBUG_BUFFER.shift();
  for (const fn of DEBUG_SUBSCRIBERS) fn();
}
function DebugOverlay() {
  const [, setTick] = useState(0);
  const [shown, setShown] = useState(true);
  useEffect(() => {
    const sub = () => setTick((n) => n + 1);
    DEBUG_SUBSCRIBERS.push(sub);
    return () => {
      const i = DEBUG_SUBSCRIBERS.indexOf(sub);
      if (i >= 0) DEBUG_SUBSCRIBERS.splice(i, 1);
    };
  }, []);
  if (!TOUCH_DEVICE) return null;
  const recent = DEBUG_BUFFER.slice(-20);
  return (
    <div
      onClick={() => setShown((v) => !v)}
      style={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        zIndex: 999999,
        background: 'rgba(0, 0, 0, 0.85)',
        color: '#0ff',
        fontFamily: 'monospace',
        fontSize: 9,
        lineHeight: '12px',
        padding: shown ? '4px 6px' : '2px 6px',
        maxHeight: shown ? '40vh' : '14px',
        overflow: 'hidden',
        pointerEvents: 'auto',
        borderTop: '1px solid #0ff',
      }}
    >
      {shown ? (
        <>
          <div style={{ color: '#ff0', marginBottom: 2 }}>
            TOUCH={String(TOUCH_DEVICE)} blockNext={String(blockNextClick)} editBlur={Date.now() - recentEditBlurAt}ms ago — tap to hide
          </div>
          {recent.map((e, i) => (
            <div key={i}>+{e.t - (recent[0]?.t || 0)}ms {e.msg}</div>
          ))}
        </>
      ) : (
        <div style={{ color: '#0ff' }}>debug ({DEBUG_BUFFER.length}) — tap to show</div>
      )}
    </div>
  );
}

// Module-level flag toggled when the touch-outside-edit listener wants to
// suppress the click that's about to follow. An always-on capture-phase
// click handler (installed once on module load below) reads the flag and
// stopImmediatePropagation + preventDefault when it's set. Always-on
// avoids the addEventListener-race we had with the per-touch registration
// pattern: there's no window where the click could fire before the
// blocker is in place.
let blockNextClick = false;
let blockNextClickAt = 0;
if (typeof document !== 'undefined') {
  document.addEventListener('click', (e) => {
    const tgt = (e.target as HTMLElement | null)?.tagName ?? '?';
    if (blockNextClick && Date.now() - blockNextClickAt < 800) {
      blockNextClick = false;
      e.stopImmediatePropagation();
      e.preventDefault();
      debugLog(`CLICK BLOCKED on ${tgt}`);
      return;
    }
    blockNextClick = false;
    debugLog(`click on ${tgt}`);
  }, { capture: true });
}

// Module-level timestamp of the most recent touch-outside-edit blur. The
// row's onTouchEnd handler checks this to skip setEditing on the same
// touch that just dismissed a previous editor (touchend fires before
// click, so we can't rely on the click blocker alone for touchend
// suppression).
let recentEditBlurAt = 0;

import { useStorage, useMutation, useUndo, useRedo } from '@liveblocks/react/suspense';
import { uploadFocusImage, deleteFocusImageBlob } from './supabase';
import { getCachedImageUrl, getCachedImageUrlSync, evictCachedImage } from './imageCache';
import { consumeOauthRedirect, openLightroomAuth, hasLightroomAuth, resolveShareUrl, fetchAlbumAssets, fetchAssetBlob } from './lightroom';
import {
  buildSnapshot,
  getSlot,
  putSlot,
  downloadSnapshot,
  readSnapshotFile,
  DAILY_REFRESH_MS,
  type BackupSlice,
  type BackupSnapshot,
} from './backup';
import arrowPaths from "./imports/svg-hzx9ujz7s0";
import {
  Assignee,
  SectionId,
  ListId,
  AppMode,
  Task,
  Project,
  Client,
  Person,
  LIST_TITLES,
  LISTS,
  PERSONAL_CLIENT_ID,
  formatDeadline,
  formatDeadlineShort,
  isLateDeadline,
  todayISO,
} from './data';


// --- CustomScroll ------------------------------------------------------------
// Drop-in replacement for `<div className="flex-1 min-h-0 overflow-y-auto">`.
// Hides the native scrollbar (which always sizes its thumb proportionally to
// content) and overlays a fixed-size pill + a triangle arrow at the top and
// bottom that we manage ourselves. Pill is 15px tall, the bottom triangle is
// 15px from the bottom of the scroll container (so it lands 15px above the
// app's bottom bar, since the scroll container's bottom edge is right against
// the bottom bar). Drag the pill to scroll; click the triangles to scroll
// step-by-step; wheel / trackpad / arrow keys still drive the underlying
// container natively, and the pill follows.
//
// Layout: outer div is `relative flex-1 min-h-0` (takes space in a flex column
// just like the overflow div it replaces). Inner div is `absolute inset-0
// overflow-y-auto` so it fills the outer and scrolls. Pill + triangles are
// absolutely positioned on the outer's right edge.
const CUSTOM_SCROLL_THUMB_H = 15;
const CUSTOM_SCROLL_TOP_PAD = 8;     // space at top above the up triangle
const CUSTOM_SCROLL_BOTTOM_PAD = 15; // space at bottom below the down triangle (= 15px from bottom bar)
const CUSTOM_SCROLL_ARROW_BOX = 14;  // clickable area for each triangle button
const CUSTOM_SCROLL_TRACK_GAP = 2;   // gap between arrow and pill at the extremes
const CUSTOM_SCROLL_STEP = 200;       // px scrolled per triangle click
const CUSTOM_SCROLL_WHEEL_MULT = 1.5; // wheel-event amplification (over browser default)
const CUSTOM_SCROLL_LINE_PX = 40;     // deltaMode=1 (lines) → px conversion
// Native-scroll architecture (NOT virtual scroll). Earlier we tried a
// transform-based virtual scroll (Locomotive-style) for buttery feel — but
// it broke dnd-kit auto-scroll-while-dragging (dnd-kit walks the DOM looking
// for `overflow: auto/scroll` ancestors; virtual scroll has overflow: hidden,
// so cards became un-movable near the edges). Native scroll keeps drag-drop
// working, and the JS-managed thumb (DOM transform writes, no React render
// per scroll frame) keeps the feel snappy without sacrificing reliability.
function CustomScroll({
  children,
  innerClassName = '',
}: {
  children: React.ReactNode;
  /** Classes for the inner scrolling div (e.g. padding for content). */
  innerClassName?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const thumbElRef = useRef<HTMLDivElement | null>(null);
  const [hasOverflow, setHasOverflow] = useState(false);
  const overflowRef = useRef(false);
  const dragRef = useRef<{ startY: number; startScrollTop: number; trackH: number; maxScroll: number } | null>(null);

  // Pill travels between just-below-up-arrow and just-above-down-arrow.
  const computeTrack = (clientH: number) => {
    const minTop = CUSTOM_SCROLL_TOP_PAD + CUSTOM_SCROLL_ARROW_BOX + CUSTOM_SCROLL_TRACK_GAP;
    const maxTop = clientH - CUSTOM_SCROLL_BOTTOM_PAD - CUSTOM_SCROLL_ARROW_BOX - CUSTOM_SCROLL_TRACK_GAP - CUSTOM_SCROLL_THUMB_H;
    return { minTop, trackH: Math.max(0, maxTop - minTop) };
  };

  // update() — runs on scroll. DOM-direct thumb position write (no React
  // render per frame). State only flips when overflow itself toggles.
  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const { scrollTop, scrollHeight, clientHeight } = el;
    const overflow = scrollHeight > clientHeight + 1;
    if (overflow !== overflowRef.current) {
      overflowRef.current = overflow;
      setHasOverflow(overflow);
    }
    if (!overflow) return;
    const thumb = thumbElRef.current;
    if (!thumb) return;
    const { minTop, trackH } = computeTrack(clientHeight);
    const maxScroll = scrollHeight - clientHeight;
    const ratio = maxScroll > 0 ? scrollTop / maxScroll : 0;
    const top = minTop + ratio * trackH;
    thumb.style.transform = `translate3d(0, ${top}px, 0)`;
  }, []);

  useLayoutEffect(() => { if (hasOverflow) update(); }, [hasOverflow, update]);

  useEffect(() => {
    update();
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    const mo = new MutationObserver(() => update());
    mo.observe(el, { childList: true });
    const onScroll = () => update();
    el.addEventListener('scroll', onScroll, { passive: true });
    // ---- Locomotive-style buttery wheel scroll ----------------------------
    // We intercept ONLY wheel events (preventDefault) and lerp scrollTop
    // toward an accumulating target on every rAF. The container still has
    // overflow-y:auto, so dnd-kit's "find ancestor scroll container" walk
    // still resolves to this element and its auto-scroll-while-dragging
    // mechanic keeps working — the previous attempt at transform-based
    // virtual scroll broke that, see the rationale comment above CustomScroll.
    //
    // Touch / keyboard / scrollbar / dnd-kit auto-scroll all bypass this
    // handler (they don't fire wheel events). When any of those move
    // scrollTop directly, the lerp detects the external delta and re-syncs
    // its target so we don't yank the user back to where the lerp wanted.
    //
    // LERP_FACTOR is the per-frame fraction of remaining distance we close.
    // 0.18 lands around 4 frames to close 80% of the gap → buttery but
    // snappy. Bump higher (0.25+) for snappier, lower (0.10) for syrupy.
    const LERP_FACTOR = 0.18;
    let target = el.scrollTop;
    let rafId: number | null = null;
    let lastSyncedTop = el.scrollTop;
    const tick = () => {
      rafId = null;
      const current = el.scrollTop;
      // External writer (dnd-kit auto-scroll, scrollbar drag, native
      // smooth-scroll from arrow buttons) — yield: adopt their position as
      // our new target and stop lerping until the next wheel event.
      if (Math.abs(current - lastSyncedTop) > 0.5) {
        target = current;
        lastSyncedTop = current;
        return;
      }
      const diff = target - current;
      if (Math.abs(diff) < 0.5) {
        el.scrollTop = target;
        lastSyncedTop = el.scrollTop;
        return;
      }
      const next = current + diff * LERP_FACTOR;
      el.scrollTop = next;
      lastSyncedTop = el.scrollTop;
      rafId = requestAnimationFrame(tick);
    };
    const onWheel = (e: WheelEvent) => {
      if (e.shiftKey) return;
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      e.preventDefault();
      let pixelDelta = e.deltaY;
      if (e.deltaMode === 1) pixelDelta *= CUSTOM_SCROLL_LINE_PX;
      else if (e.deltaMode === 2) pixelDelta *= el.clientHeight;
      // If target drifted way away from current (external writer moved us),
      // re-anchor target to current before accumulating — otherwise the
      // wheel input would warp us back to the pre-external position.
      if (Math.abs(target - el.scrollTop) > 50) target = el.scrollTop;
      const maxScroll = el.scrollHeight - el.clientHeight;
      target = Math.max(0, Math.min(maxScroll, target + pixelDelta * CUSTOM_SCROLL_WHEEL_MULT));
      if (rafId === null) rafId = requestAnimationFrame(tick);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      ro.disconnect();
      mo.disconnect();
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('wheel', onWheel);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [update]);

  const onThumbDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const el = ref.current;
    if (!el) return;
    const { trackH } = computeTrack(el.clientHeight);
    const maxScroll = el.scrollHeight - el.clientHeight;
    if (trackH <= 0 || maxScroll <= 0) return;
    dragRef.current = { startY: e.clientY, startScrollTop: el.scrollTop, trackH, maxScroll };
    const onMove = (ev: PointerEvent) => {
      if (!dragRef.current) return;
      const dy = ev.clientY - dragRef.current.startY;
      const scrollDelta = (dy / dragRef.current.trackH) * dragRef.current.maxScroll;
      el.scrollTop = Math.max(0, Math.min(dragRef.current.maxScroll, dragRef.current.startScrollTop + scrollDelta));
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, []);

  // Arrow-button click — native CSS smooth scroll. Browser handles the GPU
  // animation; no JS frame loop, no jank.
  const stepScroll = useCallback((delta: number) => {
    const el = ref.current;
    if (!el) return;
    el.scrollBy({ top: delta, behavior: 'smooth' });
  }, []);

  return (
    <div className="relative flex-1 min-h-0">
      {/* pr-[14px] reserves a column on the right for the pill. */}
      <div
        ref={ref}
        className={`absolute inset-0 overflow-y-auto custom-scroll-hidden pr-[14px] ${innerClassName}`}
      >
        {children}
      </div>
      {/* Sticky label overlay — pinned at the top of the column, crossfades date
          and category labels by opacity as the user scrolls. Inert if the
          children don't include any [data-sticky-tier] elements. Sits OVER the
          inner scroll element so labels stay fixed while content scrolls. */}
      <StickyOverlay scrollElRef={ref} />
      {hasOverflow && (
        <>
          {/* Up triangle */}
          <button
            type="button"
            onClick={() => stepScroll(-CUSTOM_SCROLL_STEP)}
            className="absolute right-0 z-10 flex items-center justify-center text-[#656464] hover:text-white transition-colors"
            style={{ top: CUSTOM_SCROLL_TOP_PAD, width: CUSTOM_SCROLL_ARROW_BOX, height: CUSTOM_SCROLL_ARROW_BOX }}
            aria-label="Scroll up"
          >
            <svg width="8" height="4" viewBox="0 0 8 4" fill="currentColor">
              <polygon points="4,0 8,4 0,4" />
            </svg>
          </button>
          {/* Down triangle */}
          <button
            type="button"
            onClick={() => stepScroll(CUSTOM_SCROLL_STEP)}
            className="absolute right-0 z-10 flex items-center justify-center text-[#656464] hover:text-white transition-colors"
            style={{ bottom: CUSTOM_SCROLL_BOTTOM_PAD, width: CUSTOM_SCROLL_ARROW_BOX, height: CUSTOM_SCROLL_ARROW_BOX }}
            aria-label="Scroll down"
          >
            <svg width="8" height="4" viewBox="0 0 8 4" fill="currentColor">
              <polygon points="0,0 8,0 4,4" />
            </svg>
          </button>
          {/* Pill thumb */}
          <div
            ref={thumbElRef}
            className="absolute top-0 right-[4px] w-[6px] rounded-full cursor-pointer transition-colors z-10 bg-[#656464] hover:bg-[#8a8a8a]"
            style={{ height: CUSTOM_SCROLL_THUMB_H, willChange: 'transform' }}
            onPointerDown={onThumbDown}
            aria-hidden
          />
        </>
      )}
    </div>
  );
}

// --- BriefField --------------------------------------------------------------
// Inline editable text used by the Brief / Notes blocks in Focus mode column 2.
// SINGLE-MODE design: the field is always contentEditable, and renders text +
// auto-detected http(s) URLs as real <a> chips. View and edit look IDENTICAL —
// grey body text, white clickable link chips, taller white caret. Empty value
// shows the placeholder as a dummy line via the [data-placeholder]:empty CSS.
//
// Why DOM-imperative (innerHTML rebuild) instead of JSX: React fights with
// contentEditable when it re-renders mid-edit (it'd resync the DOM to its
// virtual tree and clobber the user's typing). Instead we render NOTHING via
// React and rebuild the DOM ourselves whenever the value prop changes. The
// guard `el.innerText !== value` prevents overwrites while the user is typing
// (their typing only updates DOM, not value, so the effect doesn't fire).
function BriefField({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  const ref = useRef<HTMLDivElement | null>(null);

  // Build link-parsed DOM into the contentEditable. Splits on http(s) URLs,
  // wraps matches in white <a> chips that follow the link on click. Anchors
  // get contenteditable=false so they behave as atomic clickable chips:
  // backspace deletes the whole link, click opens it, surrounding text stays
  // freely editable. innerText still extracts the original text on blur.
  const renderToDom = useCallback((el: HTMLDivElement, text: string) => {
    while (el.firstChild) el.removeChild(el.firstChild);
    if (!text) return; // placeholder shown via CSS [data-placeholder]:empty:before
    const regex = /(https?:\/\/[^\s]+)/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        el.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }
      const url = match[0];
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = url;
      a.contentEditable = 'false';
      // Inline color so it survives any cascade weirdness inside contentEditable.
      a.style.color = '#ffffff';
      a.style.cursor = 'pointer';
      a.className = 'hover:underline';
      el.appendChild(a);
      lastIndex = match.index + url.length;
    }
    if (lastIndex < text.length) {
      el.appendChild(document.createTextNode(text.slice(lastIndex)));
    }
  }, []);

  // Sync the DOM to `value` whenever value changes from outside (mount, prop
  // update from another collaborator, parent re-render with new value).
  // Skipped while the user is actively typing — innerText already matches.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.innerText === value) return;
    renderToDom(el, value);
  }, [value, renderToDom]);

  const commit = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const text = el.innerText ?? '';
    if (text !== value) onChange(text);
    // Re-render the DOM so any newly-typed URLs become link chips on blur.
    renderToDom(el, text);
  }, [value, onChange, renderToDom]);

  // Sheet wrapper: soft hover-tint background panel that visually groups the
  // brief / notes content. When the field is empty, the placeholder text inside
  // shows in #474747 (the same grey as a finished task) per the .brief-edit CSS
  // override in index.css. The wrapper is a click-to-edit affordance — clicks
  // anywhere on the sheet (even outside the contentEditable's bounds) drop the
  // caret into the editor at the appropriate position.
  return (
    <div
      className="bg-white/[0.03] px-3 py-2 cursor-text"
      onClick={(e) => {
        // Forward clicks landing on the sheet's padding to the contentEditable
        // so the user can click anywhere inside the panel to start typing,
        // not just on the text itself.
        if (e.target === e.currentTarget && ref.current) {
          ref.current.focus();
        }
      }}
    >
      <div
        ref={ref}
        contentEditable
        suppressContentEditableWarning
        data-placeholder={placeholder}
        onBlur={commit}
        onKeyDown={(e) => {
          // Esc reverts to the last-saved value and blurs.
          if (e.key === 'Escape') {
            e.preventDefault();
            if (ref.current) renderToDom(ref.current, value);
            (e.currentTarget as HTMLDivElement).blur();
          }
        }}
        // Body text grey (#656464), like a task body. caret-color: white so the
        // cursor pops against the grey/dark background. line-height 2.2 makes
        // the caret visibly taller; .brief-edit (CSS in index.css) bottoms the
        // text glyphs in each line box so the caret reads as extending UP from
        // the baseline. Anchors render in white via inline style in renderToDom.
        className="font-['Univers_BQ:55_Regular',sans-serif] text-[14px] text-[#656464] whitespace-pre-wrap break-words outline-none cursor-text min-h-[21px] brief-edit"
        style={{ caretColor: 'white', lineHeight: 2.2 }}
      />
    </div>
  );
}

// View header — appears at the very top of every mode (list / project / calendar / settings).
// "{viewName} — Monday, April 28th — 12:25pm". Updates the clock once a minute.
function TopHeader({ viewName }: { viewName: string }) {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(t);
  }, []);
  const day = now.toLocaleDateString('en-US', { weekday: 'long' });
  const month = now.toLocaleDateString('en-US', { month: 'long' });
  const n = now.getDate();
  const ord = (n > 3 && n < 21) ? 'th' : (['th', 'st', 'nd', 'rd', 'th', 'th', 'th', 'th', 'th', 'th'][n % 10]);
  let h = now.getHours();
  const m = now.getMinutes();
  const ampm = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  const time = `${h}:${String(m).padStart(2, '0')}${ampm}`;
  return (
    // PIP: the quick window's columns inset their text 16px, so the header matches (35px
    // reads indented there — "nudge it over to the left").
    <div className={`${PIP_MODE ? 'px-[16px]' : 'px-[35px]'} h-[37px] flex items-center`} style={{ marginBottom: SPACING.cr }}>
      <p className="font-['NB_International:Regular',sans-serif] text-white text-[14.333px]">
        {viewName} — {day}, {month} {n}{ord} — {time}
      </p>
    </div>
  );
}

function TaskCheckbox({ completed, started = false, onToggle, accent }: { completed: boolean; started?: boolean; onToggle: () => void; accent?: string }) {
  // Three visual states (cycled by repeated clicks — see toggleTask):
  //   pending   → empty box with grey 1.5px stroke
  //   started   → solid mid-grey fill (no tick), reading as "in progress" / "I've begun this"
  //   completed → solid dark fill + white-ish tick, the existing "done" look
  // The started fill is intentionally LIGHTER than the completed fill so the eye can tell them
  // apart at a glance — pending=#0 fill, started=#656464 fill (matches the idle stroke), and
  // completed=#383838 fill (matches the faded text). Pre-2-stage tasks (no `started` property)
  // default to pending — backwards-compatible with existing storage.
  // `accent` (today-card purple) recolors the pending stroke + started fill; the completed
  // fill keeps the universal faded-done look so "done" reads the same everywhere.
  const idleStroke = accent || '#656464';
  const startedFill = accent || '#656464';
  const doneFill = '#383838';
  // Tick stroke is the page background color so the check reads as a cut-out shape from the
  // muted fill — same look as the original design, just on the dimmer fill.
  const tickStroke = '#282828';
  const fill = completed ? doneFill : (started ? startedFill : 'transparent');
  const border = completed ? doneFill : (started ? startedFill : idleStroke);
  return (
    // stopPropagation on pointerdown so a click on the checkbox doesn't bubble to the row's
    // {...listeners} and start a drag â€” toggling completion stays a click, not the start of a move.
    // -mt-[2px] lifts the checkbox so its TOP sits at the title's cap-height (top of capital
    // letters) and its bottom sits roughly at the baseline â€” visually "embedded" in the text line.
    <motion.div
      className="relative shrink-0 size-3 cursor-pointer -mt-[2px]"
      whileTap={{ scale: 0.9 }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => { e.stopPropagation(); onToggle(); }}
      // Two quick clicks to advance pending → started → done fire a dblclick that bubbles to
      // the row's onDoubleClick (open editor). Swallow it here so cycling the checkbox never
      // opens the edit panel.
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <div className="absolute inset-0 rounded-[3.333px]" style={{ backgroundColor: fill }}>
        <div aria-hidden="true" className="absolute border-[1.5px] border-solid inset-0 pointer-events-none rounded-[3.333px]" style={{ borderColor: border }} />
      </div>
      {completed && (
        // y: 2 nudges the tick down 2px (must go through framer's animate prop — an inline
        // style.transform would be overridden by the scale/opacity transform).
        <motion.div initial={{ scale: 0, opacity: 0, y: 1 }} animate={{ scale: 1, opacity: 1, y: 1 }} transition={{ type: "spring", duration: 0.3, bounce: 0.4 }} className="absolute inset-0 flex items-center justify-center">
          <svg className="w-2 h-2" viewBox="0 0 8 8"><path d="M6.5 1.5L3 5L1.5 3.5" stroke={tickStroke} strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </motion.div>
      )}
    </motion.div>
  );
}

function MilestoneToggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      onClick={() => onChange(!value)}
      className={`relative inline-flex h-[18px] w-[32px] shrink-0 rounded-full transition-colors ${value ? 'bg-[#7363FF]' : 'bg-[#1f1f1f]'}`}
    >
      <span className={`absolute top-[2px] size-[14px] rounded-full bg-white transition-transform ${value ? 'translate-x-[16px]' : 'translate-x-[2px]'}`} />
    </button>
  );
}

function AssigneeBadge({ letter, tone, hollow = false, dim = false, active = false, faint = false }: { letter: Assignee; tone: 'scheduled' | 'todo'; hollow?: boolean; dim?: boolean; active?: boolean; faint?: boolean }) {
  // `dim` matches the muted palette used for completed tasks; `active` swaps the fill to white
  // for the panel's "selected resource" treatment so the badge pops alongside its bold-white name.
  // `faint` (used for expired milestones) drops the scheduled purple to its faint variant.
  const scheduledColor = faint ? '#4f4290' : '#8465FF';
  const color = dim ? '#383838' : active ? '#ffffff' : (tone === 'scheduled' ? scheduledColor : '#656464');
  // Multi-character shorts (auto-disambiguated when two people share an initial) render as a
  // pill instead of a circle: same height, expanded width, fully rounded ends. The width grows
  // ~5px per extra character beyond the first.
  const len = letter.length || 1;
  const widthPx = len === 1 ? 12.333 : 12.333 + (len - 1) * 5;
  return (
    // -mt-[2px] matches the typographic alignment used on TaskCheckbox + DeadlineArrow so the
    // badge sits at the text's cap-to-baseline band, not centered on the row's bounding box.
    <div className="relative shrink-0 -mt-[2px] flex items-center justify-center" title={letter} style={{ width: widthPx, height: 12.333, borderRadius: 999, backgroundColor: hollow ? 'transparent' : color, border: hollow ? `1px solid ${color}` : 'none' }}>
      <span
        className="assignee-initial font-['Untitled_Sans:Heavy',sans-serif] font-extrabold leading-none not-italic text-[7.5px] text-center"
        style={{ color: hollow ? color : '#282828' }}
      >{letter}</span>
    </div>
  );
}

// TaskOrder + helper used by every task renderer (list, project, calendar, dashboard).
// Returns the visual sequence of "meta blocks" + where the title slot belongs. Each block is
// either 'project', 'client', 'title', or 'cp' (combined client-project rendered as a SINGLE
// span "Client-Project" with no whitespace around the dash). The combined block is used in
// 'cpt' / 'tcp' modes where client and project sit next to each other; the renderers know to
// emit it as one inline element so the flex gap between siblings doesn't add space around the
// dash. 'ptc' keeps project and client on separate sides of the title (no combination).
type TaskOrder = 'cpt' | 'ptc' | 'tcp';
type TaskMetaSlot = 'project' | 'client' | 'title' | 'cp';
function taskOrderSlots(order: TaskOrder, hasProject: boolean, hasClient: boolean): TaskMetaSlot[] {
  if (order === 'cpt') {
    // (client-project) title
    const out: TaskMetaSlot[] = [];
    if (hasClient && hasProject) out.push('cp');
    else if (hasClient) out.push('client');
    else if (hasProject) out.push('project');
    out.push('title');
    return out;
  }
  if (order === 'tcp') {
    // title (client-project)
    const out: TaskMetaSlot[] = ['title'];
    if (hasClient && hasProject) out.push('cp');
    else if (hasClient) out.push('client');
    else if (hasProject) out.push('project');
    return out;
  }
  // 'ptc' (default): project title client
  const out: TaskMetaSlot[] = [];
  if (hasProject) out.push('project');
  out.push('title');
  if (hasClient) out.push('client');
  return out;
}

// Just the arrowhead from DeadlineArrow (no line) — used as the inline ">" separator in
// breadcrumb-style meta paths (e.g. "RSL ▶ Launch ▶ PR Launch") so the chevron at the
// row's date and the chevron between meta slots share one visual vocabulary.
//
// Sized exactly like the DeadlineArrow's polygon (4×8 in a 12-tall wrapper, with -mt-[2px]
// to land on the text's baseline band — see DeadlineArrow). Tone:
//   - 'default'   → #656464 (matches DeadlineArrow's fill)
//   - 'milestone' → #8465ff (matches milestone purple)
function Arrowhead({ dim = false, tone = 'default', faint = false }: { dim?: boolean; tone?: 'default' | 'milestone'; faint?: boolean }) {
  // `faint` (used for expired milestones) drops the milestone purple to its faint variant.
  const milestoneFill = faint ? '#4f4290' : '#8465ff';
  const fill = dim ? '#383838' : tone === 'milestone' ? milestoneFill : '#656464';
  return (
    <span className="inline-flex items-center shrink-0 mx-[4px] -mt-[2px] align-middle" style={{ height: 12 }}>
      <svg width="4" height="8" viewBox="0 0 4 8" fill="none">
        <polygon points="0,0 4,4 0,8" fill={fill} />
      </svg>
    </span>
  );
}

function DeadlineArrow({ dim = false, small = false, color }: { dim?: boolean; small?: boolean; color?: string }) {
  // Custom inline SVG so we can shorten the LINE while keeping the arrowhead size and the
  // line's stroke thickness constant. `small` (responsive density 3+) cuts the line length
  // by ~50% (line goes from x=0..14 → x=7..14). Total wrapper width drops 18 → 11.
  // -mt-[2px] aligns the icon to the text's cap-to-baseline band, matching TaskCheckbox.
  // `dim` mirrors the muted palette used for completed tasks.
  // `color` overrides the resting tone (milestone purple etc.); dim always wins.
  const fill = dim ? '#383838' : (color || '#656464');
  const wrapW = small ? 11 : 18;
  // Coordinates inside a virtual 18×12 grid: arrowhead at right, line on its left.
  const lineStart = small ? 7 : 0;
  return (
    <div className="h-[12px] relative shrink-0 -mt-[2px]" style={{ width: wrapW }}>
      <svg className="absolute block inset-0" width={wrapW} height={12} viewBox={`${lineStart} 0 ${18 - lineStart} 12`} fill="none">
        <line x1={lineStart} y1="6" x2="14" y2="6" stroke={fill} strokeWidth="1" />
        <polygon points="14,2 18,6 14,10" fill={fill} />
      </svg>
    </div>
  );
}

// --- Motion system ------------------------------------------------------------
// Single source of truth for the app's motion vocabulary. Every drag interaction
// across list / project / calendar pulls from the same constants and primitives,
// so a tweak here propagates everywhere.
//
// Tuned for "buttery": smooth deceleration curves, durations long enough that
// the motion has room to breathe but short enough to feel responsive. Nothing
// abrupt, nothing bouncy.
const MOTION = {
  // easeOutQuart - slightly creamier than standard easeOut. Gentle landing.
  // The motion settles like it's gliding to a stop on velvet.
  easeOut: 'cubic-bezier(0.16, 1, 0.3, 1)',
  // For opacity fades where the bezier feels overly dramatic.
  easeStandard: 'cubic-bezier(0.4, 0, 0.2, 1)',
  // Durations - luxurious without feeling sluggish.
  fast: 200,   // micro: opacity, hover tints
  base: 320,   // layout shifts (e.g. underlying sortable transforms after a drop)
  slow: 420,   // overlays appearing, source collapse
  // Displacement-only timing. Deliberately MUCH longer than `base`: when you
  // scrub a dragged card over many neighbours quickly, each one's displacement
  // target keeps changing. A short transition means every target update kicks
  // off a fresh fast animation that "races to catch up", which reads as jerky.
  // A long transition lets the card glide smoothly between successive targets
  // without ever appearing to snap.
  displace: 600,
};
const DISPLACE_TRANSITION = `transform ${MOTION.displace}ms ${MOTION.easeOut}, margin-top ${MOTION.displace}ms ${MOTION.easeOut}`;

// --- Spacing vocabulary ------------------------------------------------------
// One row in the layout = 37px (the height of a task row, the section header, etc.).
// Treat the whole layout like a raw text document:
//   - tight        : 0px → continuous flow, like consecutive lines (no blank line between).
//   - SPACING.cr   : 37px → ONE carriage return. A blank line. The default "this is a new
//                    section" beat. Use between section header → next section, or between
//                    distinct groups in a column.
//   - SPACING.dcr  : 74px → DOUBLE carriage return. A paragraph break. Use sparingly — at
//                    the top of the page (header → content), and between top-level views'
//                    column titles → first section.
// Shorthand we use in chat:
//   "tight" / "T"     → no gap
//   "cr"    / "1"     → SPACING.cr (one blank line)
//   "double" / "2"    → SPACING.dcr (paragraph break)
// "Move that to a CR" = use SPACING.cr; "give it a double" = use SPACING.dcr.
const ROW_PX = 37;
const SPACING = {
  tight: 0,
  cr: ROW_PX,         // one carriage return = 37px
  dcr: ROW_PX * 2,    // two carriage returns = 74px
  topMargin: 30,      // distance from page top to the View header (List — Mon, Apr 28th — 12:25pm)
};

// --- Displaced ----------------------------------------------------------------
// Unified displacement primitive for ALL draggable rows (list, project, calendar).
//
// Why this exists: the previous setup used framer-motion `animate={{ y, marginTop }}`
// on every row, which restarts a JS spring on every drag-over event. With dozens of
// rows re-rendering at 60fps as the cursor moves, the springs stack up and cause
// noticeable stutter. This component does the same visual work with a single CSS
// transform + margin-top transition, which the browser composites on the GPU ï¿½
// no per-frame JS, no spring restarts, no jank.
//
// `React.memo` shortcuts re-renders entirely when the offset/gap props haven't
// changed for a given row ï¿½ critical when 30+ rows are mounted.
const Displaced = memo(function Displaced({
  offset = 0,
  gap = 0,
  active = false,
  className = '',
  children,
}: {
  offset?: number;
  gap?: number;
  active?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={className}
      style={{
        transform: offset ? `translate3d(0, ${offset}px, 0)` : undefined,
        marginTop: gap || undefined,
        transition: active ? DISPLACE_TRANSITION : 'none',
        // Promote to its own compositor layer only while a drag is happening —
        // `will-change` is a strong hint and is wasteful when nothing is moving.
        // CRITICAL: skip the promotion on TOUCH devices. iOS Safari leaves
        // stale snapshots of will-change'd layers behind during transform
        // updates, producing the "ghost doubling" of displaced peer rows.
        // Desktop browsers handle the promotion cleanly so we keep the perf
        // win there.
        willChange: active && !TOUCH_DEVICE ? 'transform, margin-top' : 'auto',
      }}
    >
      {children}
    </div>
  );
});

function SortableTaskItem({
  task, onToggle, onRename, onDelete, onEdit, onQuickEdit, onAddSibling, onReschedule, onCancelPendingRename, onSelect, isSelected = false, hasFocusContent = false, onOpenFocus, autoFocus = false, isDragOverlay = false, displacementOffset = 0, insertionGap = 0, isAnyDragging = false, collapsed = false, projects = [], clients = [], nonDraggable = false, idPrefix = '', taskOrder = 'ptc', density = 0,
  showIndent = false, hideContext = false,
}: {
  task: Task; onToggle: () => void; onRename?: (title: string) => void; onDelete?: () => void; onEdit?: (e?: React.MouseEvent) => void; onQuickEdit?: (e?: React.MouseEvent) => void; onAddSibling?: () => void; onReschedule?: (kind: 'today' | 'tomorrow' | 'nextWeek' | 'shiftBack' | 'shiftForward' | 'sectionForward' | 'sectionBack') => void;
  // Cancel any pending sentence-case-rename timer for this task. Called when the user re-clicks
  // the title (entering edit mode again) within the 2s post-blur window so the in-flight
  // conversion doesn't clobber the title mid-type.
  onCancelPendingRename?: () => void;
  // Single-click selection — sets the row as the app's "selected" task (drives the Focus
  // mode's Information panel + the visible highlight on the row). Selection is independent
  // of dragging: dnd-kit's distance threshold means a stationary click stays a click.
  onSelect?: () => void;
  isSelected?: boolean;
  // True when the task (or its project) has anything in the Focus-mode storage — brief,
  // notes, sub-tasks, images, references. Drives the small "open in Focus" icon that
  // appears before the + sibling button.
  hasFocusContent?: boolean;
  onOpenFocus?: () => void;
  autoFocus?: boolean; isDragOverlay?: boolean; displacementOffset?: number; insertionGap?: number; isAnyDragging?: boolean; collapsed?: boolean; projects?: Project[]; clients?: Client[]; nonDraggable?: boolean;
  taskOrder?: TaskOrder;
  // Responsive density level (0=full ... 7=tightest). See App's density comment for the cascade.
  density?: number;
  // Optional prefix for the dnd-kit sortable id. Lets the same task render in two places (e.g.
  // dashboard sub-list AND work column) without sharing a sortable id â€” otherwise picking up one
  // instance would mark BOTH as the active drag and fade them simultaneously.
  idPrefix?: string;
  // PROJECT VIEW 2: lets the same component render the project-view look (LIndent + no
  // project/client meta) without forking. Pure visual flags — no effect on drag mechanics.
  showIndent?: boolean;
  hideContext?: boolean;
}) {
  const project = task.projectId ? projects.find((p) => p.id === task.projectId) : undefined;
  // Prefer the task's explicit clientId, fall back to the project's owning client.
  const resolvedClientId = task.clientId ?? project?.clientId;
  const client = resolvedClientId ? clients.find((c) => c.id === resolvedClientId) : undefined;
  const [editing, setEditing] = useState(autoFocus);
  const [draft, setDraft] = useState(task.title);
  const titleRef = useRef<HTMLSpanElement>(null);
  // Touch tap detection for entering edit mode. Click events on iOS fire
  // even if the user moved up to ~10px during the touch — so relying on
  // onClick alone meant a near-scroll attempt would unintentionally open
  // the editor. We track touchstart position + time and only consider it
  // a "tap" if the finger barely moved (≤ 5px) and the touch was brief
  // (≤ 300ms). Anything beyond those thresholds is scroll-or-something-
  // else and we leave the row alone — the iOS browser still gets to do
  // its native scroll handling. Pure desktop is unaffected (this whole
  // path is gated on TOUCH_DEVICE).
  const touchTapRef = useRef<{ x: number; y: number; t: number } | null>(null);
  // "Fresh" = task was just created via + and has not yet received any user input. When the user
  // blurs out of an empty fresh task (clicks elsewhere) we start a 3-second fade-then-delete
  // timer. If they come back to it before the timer expires, we cancel the fade.
  const [fresh, setFresh] = useState(autoFocus && !task.title);
  // Hover state — driven by both onMouseEnter/Leave AND a row-level onMouseMove. The
  // mousemove acts as a backstop: if the browser throttles or drops mouseenter on a fast
  // sweep, mousemove will still fire as the cursor crosses pixels and re-set hovered=true.
  const [hovered, setHovered] = useState(false);
  const [fading, setFading] = useState(false);
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelFade = () => {
    if (fadeTimerRef.current) { clearTimeout(fadeTimerRef.current); fadeTimerRef.current = null; }
    setFading(false);
  };
  useEffect(() => () => { if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current); }, []);
  // Coordinates of the click that triggered the transition into edit mode. If set, the caret
  // is placed at that exact point in the text instead of being collapsed to start/end. Cleared
  // after one use. Lets the user click in the middle of a word and land the cursor there in
  // a single click instead of two.
  const editClickPosRef = useRef<{ x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    if (!editing || !titleRef.current) return;
    const el = titleRef.current;
    const clickPos = editClickPosRef.current;
    editClickPosRef.current = null;
    const handle = window.setTimeout(() => {
      if (!el.isConnected) return;
      el.focus();
      const sel = window.getSelection();
      if (!sel) return;
      // Prefer caret-from-point so the cursor lands where the user clicked. Falls back to
      // start (empty title) or end (existing title) when there's no click position — this
      // covers the autoFocus-on-spawn path where there's no click to anchor to.
      let placed = false;
      if (clickPos) {
        // caretRangeFromPoint is broadly supported in Chromium/WebKit; caretPositionFromPoint
        // is the standard but only Firefox; use whichever the browser provides.
        const doc = document as Document & {
          caretRangeFromPoint?: (x: number, y: number) => Range | null;
          caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
        };
        const r = doc.caretRangeFromPoint?.(clickPos.x, clickPos.y);
        if (r && el.contains(r.startContainer)) {
          sel.removeAllRanges();
          sel.addRange(r);
          placed = true;
        } else {
          const p = doc.caretPositionFromPoint?.(clickPos.x, clickPos.y);
          if (p && el.contains(p.offsetNode)) {
            const range = document.createRange();
            range.setStart(p.offsetNode, p.offset);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
            placed = true;
          }
        }
      }
      if (!placed) {
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(!task.title); // empty → start, has text → end
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }, 0);
    return () => clearTimeout(handle);
  }, [editing]);
  const sortable = useSortable({
    id: `${idPrefix}${task.id}`,
    data: { type: 'task', task },
    // Buttery displacement — longer duration + ease-out-expo. Same curve
    // applied to the references-gallery folder rows + image tiles, so every
    // sortable in the app glides on one motion vocabulary rather than each
    // surface picking its own snap.
    transition: { duration: 350, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
  });
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = sortable;
  // Inside <DragOverlay>, the cloned row still calls useSortable (it lives inside DndContext) and
  // gets back transform/isDragging values describing the SOURCE row's reordering. Applying those to
  // the overlay clone makes it inherit the source's animation and can compound with the outer
  // overlay wrapper's transform â€” visible as a small vertical "jump". Neutralize them on the clone.
  // Three-way style switch for the source row's wrapper:
  //   1. Inside the DragOverlay clone — neutralize the inherited transform /
  //      transition so the clone doesn't compound the outer overlay's motion.
  //   2. Source while being dragged — STRIP the dnd-kit transform (the
  //      DragOverlay is the moving thing; the source should stay put in its
  //      original slot) AND hide via `visibility: hidden`. Visibility is a
  //      synchronous CSS property that iOS Safari respects immediately —
  //      framer-motion's animate-opacity path was landing mid-transition on
  //      touch and producing the "ghost behind the overlay" glitch.
  //   3. Source in its normal state — apply dnd-kit's transform for
  //      displacement-when-peers-are-dragged animation.
  const style: React.CSSProperties = isDragOverlay
    ? { transform: undefined, transition: 'none' }
    : (isDragging
        ? { transform: undefined, transition: 'none', visibility: 'hidden' }
        : { transform: CSS.Transform.toString(transform), transition: !isAnyDragging ? 'none' : `transform ${MOTION.base}ms ${MOTION.easeOut}` });
  const isScheduled = task.type === 'scheduled';
  const isNext = task.section === 'next' || task.section === 'tomorrow';
  const isPersonal = resolvedClientId === PERSONAL_CLIENT_ID || task.list === 'personal';
  // Expired milestone: deadline is strictly before today's day boundary. Renders in a faint
  // purple so it's visible (lingering) but visually quieted vs. live milestones.
  const isExpiredMilestone = isScheduled && !!task.deadline && task.deadline < todayISO();
  // Live milestones: vivid purple. Expired milestones (lingering for 24h): faint purple.
  const milestonePurpleClass = isExpiredMilestone ? 'text-[#4f4290]' : 'text-[#8465ff]';
  // Completed tasks fade to a near-background color across ALL their text — no strikethrough,
  // just visually quieted. #474747 sits a few steps off the #282828 page background, slightly
  // brighter than the calendar's #383838 so completed rows in list / project / dashboard read
  // at arm's length. (Calendar keeps its own #383838 since its tighter card density already
  // pulls the eye.) Progressively bumped (3d3d3d → 424242 → 474747, ~2% per step) to make
  // completed rows just legible without breaking the "background-blended" feel.
  const titleColor = isScheduled ? milestonePurpleClass : task.completed ? 'text-[#474747]' : isNext ? 'text-[#a8a8a8]' : 'text-white';
  const metaColor = task.completed ? 'text-[#474747]' : isScheduled ? milestonePurpleClass : 'text-[#656464]';

  return (
    <Displaced offset={displacementOffset} gap={insertionGap} active={isAnyDragging}>
    {/*
     * Whole-card drag: {...attributes} {...listeners} live on the row container, NOT a tiny handle.
     * Click anywhere â†’ drag (PointerSensor's distance: 8 means a stationary click stays a click).
     * Interactive children (checkbox, +/trash buttons, title-while-editing) call
     * stopPropagation in their own pointerdown handlers so they keep working.
     */}
    {/* Source slot keeps its 37px layout space (no collapse) â€” prevents layout reflow during the
        drag, which was causing the "Next" header to overlap with rows. Card just fades to invisible. */}
    <motion.div
      ref={setNodeRef}
      style={style}
      data-task-row={isDragOverlay ? undefined : task.id}
      {...(nonDraggable ? {} : attributes)}
      {...(nonDraggable ? {} : listeners)}
      // Capture-phase pointerdown anywhere on the row aborts the fade-then-delete timer if
      // the user comes back to the task within the 3s window.
      onPointerDownCapture={fading ? cancelFade : undefined}
      // Desktop click → onSelect (highlight). Touch tap-to-edit is handled
      // by onTouchStart / onTouchEnd below — the click event on iOS fires
      // even after near-scrolls (movement up to ~10px), so we can't rely
      // on it for the "enter edit mode" intent. The recentEditBlurAt
      // guard also suppresses onSelect when the tap is the one that
      // dismissed a previous editor — the user wants a clean idle state
      // (nothing selected, nothing in edit) after tapping out, and a
      // fresh tap to choose the next action.
      onClick={onSelect && !isDragOverlay ? () => {
        if (TOUCH_DEVICE && Date.now() - recentEditBlurAt < 500) { debugLog(`onClick BLOCKED (editBlur ${Date.now() - recentEditBlurAt}ms ago)`); return; }
        debugLog(`onClick → onSelect(${task.id.slice(0,8)})`);
        onSelect();
      } : undefined}
      // Touch tap detection: record where + when the finger landed.
      onTouchStart={TOUCH_DEVICE && !isDragOverlay ? (e) => {
        const t = e.touches[0];
        if (t) touchTapRef.current = { x: t.clientX, y: t.clientY, t: Date.now() };
      } : undefined}
      // On lift, confirm it was a real tap (≤ 5px movement, ≤ 300ms) and
      // only then enter edit. Scrolls (more motion) and long-presses (the
      // dnd-kit TouchSensor will have taken over by then) fall through
      // untouched. e.target check skips taps on interactive children
      // (checkbox button, trash button, etc.) which have their own handlers.
      // The recentEditBlurAt guard skips entering edit on the same touch
      // that just dismissed a previously-active editor — the user gets a
      // clean "nothing selected" intermediate state, and a fresh tap is
      // required to open this row's editor (or a long-press to drag it).
      onTouchEnd={TOUCH_DEVICE && !isDragOverlay && onRename ? (e) => {
        const start = touchTapRef.current;
        touchTapRef.current = null;
        if (!start) return;
        const end = e.changedTouches[0];
        if (!end) return;
        const dx = Math.abs(end.clientX - start.x);
        const dy = Math.abs(end.clientY - start.y);
        const dt = Date.now() - start.t;
        if (dx > 5 || dy > 5 || dt > 300) { debugLog(`onTouchEnd skip (dx=${dx} dy=${dy} dt=${dt})`); return; } // scrolled or long-pressed → not a tap
        // This touch already did its job — dismissed a prior editor. Don't
        // also open this row's editor on the same gesture.
        if (Date.now() - recentEditBlurAt < 500) { debugLog(`onTouchEnd BLOCKED (editBlur ${Date.now() - recentEditBlurAt}ms ago)`); return; }
        // Skip if the target is an interactive child (button / input / etc.) —
        // those already have their own handlers, no need to ALSO open edit.
        const t = e.target as HTMLElement | null;
        if (t && (t.closest('button') || t.closest('input') || t.closest('textarea'))) { debugLog(`onTouchEnd skip (interactive child ${t.tagName})`); return; }
        debugLog(`onTouchEnd → setEditing(true) ${task.id.slice(0,8)}`);
        setEditing(true);
      } : undefined}
      onMouseEnter={!isDragging && !isDragOverlay ? () => setHovered(true) : undefined}
      onMouseMove={!isDragging && !isDragOverlay && !hovered ? () => setHovered(true) : undefined}
      onMouseLeave={!isDragging && !isDragOverlay ? () => setHovered(false) : undefined}
      className={`relative shrink-0 w-full group overflow-hidden ${nonDraggable || isDragOverlay ? '' : 'cursor-grab active:cursor-grabbing'} ${isDragOverlay ? 'z-50 bg-[#333333]' : ''}`}
      animate={{
        scale: isDragOverlay ? 1.02 : 1,
        // No visible fade for the 15-min "fresh-empty" delete countdown — the row stays full
        // opacity until silent deletion. Only isDragging fades the source while a drag is happening.
        // Opacity hides the SOURCE while drag is active so it doesn't double-
        // render under the floating DragOverlay clone. Critically gated on
        // `!isDragOverlay` — the clone inside the overlay portal shares the
        // same useSortable id, so isDragging is true for BOTH the source and
        // the clone. Without the !isDragOverlay guard, the clone would fade
        // to 0 too, which on iOS Safari can land mid-transition and show
        // "text but no card" or the half-faded source ghosting the overlay.
        opacity: isDragging && !isDragOverlay ? 0 : 1,
        // Background priority: drag overlay leaves the bg alone; selected wins over hover with
        // a 25% brighter wash (0.075 vs the 0.03 hover); hover wins over default; default is
        // transparent. Same 60ms in / 300ms out animation for all transitions.
        ...(isDragOverlay ? {} : {
          backgroundColor: isSelected
            ? 'rgba(255, 255, 255, 0.075)'
            : hovered && !isDragging
              ? 'rgba(255, 255, 255, 0.03)'
              : 'rgba(255, 255, 255, 0)',
        }),
      }}
      transition={{
        scale: { duration: 0.18 },
        // Snap-to-invisible on touch (no fade) so the source never ghosts
        // the overlay during the half-second iOS render handoff. Desktop
        // can afford the fade since the mouse-drag pickup is instant.
        opacity: isDragging && !isDragOverlay
          ? (TOUCH_DEVICE ? { duration: 0 } : { duration: 0.12, ease: "easeOut" })
          : { duration: 0 },
        // Snappy bg-color transition on touch (60ms) — desktop keeps the
        // gentle 300ms fade-out for non-hovered rows. The slow fade was
        // making selection-switching on the iPhone look like multiple rows
        // were highlighted at once during the cross-fade.
        backgroundColor: { duration: hovered || TOUCH_DEVICE ? 0.06 : 0.3, ease: [0.85, 0, 0.15, 1] },
      }}
    >
      <div onDoubleClick={(e) => { if (onEdit && !editing) { e.stopPropagation(); onEdit(e); } }} onContextMenu={(e) => { if (onQuickEdit) { e.preventDefault(); e.stopPropagation(); onQuickEdit(e); } }} className={`relative box-border flex flex-row gap-2 h-[37px] items-center pr-[31px] w-full ${showIndent ? 'pl-[43px]' : 'pl-[31px]'}`}>
        {/* Project-view-2 rows render the LIndent ⌐ glyph just before the checkbox. */}
        {showIndent && <LIndent />}
        {/* Visual grab affordance only â€” absolutely positioned so it doesn't take flex layout space.
            Otherwise the gap-2 after the arrow indents the checkbox 8px past the section labels.
            White when this row IS the drag overlay so it pops while in motion; gray on hover otherwise. */}
        {!nonDraggable && (
          <div className={`absolute left-[2px] top-1/2 -translate-y-1/2 p-1 transition-opacity duration-200 ${isDragOverlay ? 'opacity-100 text-white' : 'opacity-0 group-hover:opacity-100 text-[#5e5e5e]'}`}>
            <svg width="12" height="18" viewBox="0 0 12 18" fill="none">
              <path d="M6 1L6 17" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
              <path d="M2.5 3.5L6 0L9.5 3.5" stroke="currentColor" strokeWidth="1" fill="none" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M2.5 14.5L6 18L9.5 14.5" stroke="currentColor" strokeWidth="1" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
        )}
        {!isScheduled && <TaskCheckbox completed={task.completed} started={task.started} onToggle={onToggle} />}
        {/* Title row — slot order is driven by the user's `taskOrder` setting.
            Density-driven slot filtering: client hidden at >=4, project hidden at >=6.
            min-w-0 + the title span's `truncate` lets the row shrink with ellipsis when
            the column is narrower than the title (e.g. a 40-char title in a 280px
            dashboard column at high density). The cascade still preserves what it can —
            project truncates first, then meta hides — but when even the bare title
            can't fit, the title ellipsizes rather than pushing the date off the right
            edge of the column.
            -mr-2 cancels the outer row's gap-2, removing the redundant buffer between the
            trailing hit-zone and the assignee badge — the hit-zone itself provides the slack. */}
        <div className="flex flex-row items-center gap-[4px] min-w-0 overflow-hidden -mr-2">
          {(() => {
            // Compute which meta slots are "active" given the current density. The slot helper
            // already arranges them by user-chosen order — we just suppress the ones the cascade
            // has hidden by passing hasProject/hasClient = false at the right thresholds.
            // hideContext (project view 2): suppress project + client entirely — redundant.
            // showClient gated on a non-empty short — Personal client has short='' and would
            // otherwise hijack the 'cp' slot (which requires both client.short AND project.name)
            // and silently eat the project label too. Treating empty-short as "no client" here
            // makes taskOrderSlots fall through to the lone 'project' slot.
            const showClient = !hideContext && !!(client && client.short) && density < 4;
            const showProject = !hideContext && !!project && density < 6;
            // Milestones render their meta + title with " > " separators between adjacent slots
            // ("RSL > Launch > PR Launch"). Regular tasks keep gap-based separation. We track
            // whether the previous slot rendered something so we can inject a separator before
            // the current one only when needed (no leading separator, no double separators).
            let prevHadContent = false;
            const sepIfMilestone = (key: string) => {
              if (!isScheduled) return null;
              if (!prevHadContent) return null;
              // -mx-[4px] cancels the parent flex's gap-[4px] on each side, so the total
              // visible spacing around the arrowhead matches the inline cp slot use
              // (where there's no flex gap, just the Arrowhead's own mx-[4px]).
              return <span key={key} className="-mx-[4px] inline-flex items-center"><Arrowhead dim={task.completed} tone="milestone" faint={isExpiredMilestone} /></span>;
            };
            return taskOrderSlots(taskOrder, showProject, showClient).flatMap((slot, i) => {
              // Use metaColor (which already swaps to milestone-purple when isScheduled)
              // for ALL meta slots — earlier this path only applied it to the bare client
              // slot, leaving project + combined "cp" slots stuck on the default grey even
              // for milestone rows. That made e.g. "NwLvng > Website > Meet About" render
              // half-grey / half-purple on a milestone with both a client and a project.
              const metaCls = `font-['Univers_BQ:55_Regular',sans-serif] leading-[normal] not-italic text-[14px] whitespace-nowrap ${metaColor}`;
              // Progressive truncation: project name truncates first (density >= 1).
              const projectTruncate = density >= 1 ? 'truncate min-w-0 max-w-[120px]' : '';
              if (slot === 'project' && project && project.name) {
                const sep = sepIfMilestone(`sep-p-${i}`);
                prevHadContent = true;
                return [sep, <p key={`p-${i}`} className={`${metaCls} ${projectTruncate}`}>{project.name}</p>].filter(Boolean) as React.ReactNode[];
              }
              if (slot === 'client' && client && client.short) {
                const sep = sepIfMilestone(`sep-c-${i}`);
                prevHadContent = true;
                return [sep, <p key={`c-${i}`} className={metaCls}>{client.short}</p>].filter(Boolean) as React.ReactNode[];
              }
              if (slot === 'cp' && client && client.short && project && project.name) {
                const sep = sepIfMilestone(`sep-cp-${i}`);
                prevHadContent = true;
                return [sep, (
                  <p key={`cp-${i}`} className={`${metaCls} ${projectTruncate}`}>
                    {/* Arrowhead between client and project also picks up the milestone
                        purple when this row is a milestone, matching the surrounding text. */}
                    {client.short}<Arrowhead dim={task.completed} tone={isScheduled ? 'milestone' : 'default'} faint={isExpiredMilestone} />{project.name}
                  </p>
                )].filter(Boolean) as React.ReactNode[];
              }
            if (slot === 'title') {
              const sep = sepIfMilestone(`sep-t-${i}`);
              prevHadContent = true;
              const titleNode = (
          <span
            key={`t-${i}`}
            ref={titleRef}
            contentEditable={editing && !isDragOverlay}
            suppressContentEditableWarning
            data-placeholder="New Task"
            data-task-title={task.id}
            onPointerDown={(e) => {
              if (editing) { e.stopPropagation(); return; }
              if (!onRename) return;
              // On TOUCH devices we DO NOT enter edit mode on pointerdown —
              // pointerdown fires on touchstart, before iOS can decide whether
              // the gesture is a tap, a scroll, or a long-press. We'd open the
              // editor on every scroll attempt. The row's onTouchEnd handler
              // (above) confirms a real tap (≤5px / ≤300ms) before opening
              // the editor. The desktop pointerdown path stays — it's what
              // enables drag-select on the first mouse-click, which still
              // matters on a real mouse + keyboard setup.
              if (TOUCH_DEVICE) return;
              // User came back to edit the title — cancel any pending sentence-case conversion
              // so it can't fire mid-type and clobber what they're about to write.
              onCancelPendingRename?.();
              // Imperatively flip contentEditable + focus + place caret in the SAME pointerdown
              // tick, BEFORE React re-renders. This is what enables drag-to-select on the very
              // first click (browser needs contentEditable=true at pointerdown time to engage
              // its native drag-select). Setting contentEditable on the DOM directly side-steps
              // React's render cycle.
              const el = titleRef.current;
              if (!el) return;
              e.stopPropagation();
              el.contentEditable = 'true';
              el.focus();
              const doc = document as Document & {
                caretRangeFromPoint?: (x: number, y: number) => Range | null;
                caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
              };
              const r = doc.caretRangeFromPoint?.(e.clientX, e.clientY);
              if (r && el.contains(r.startContainer)) {
                const sel = window.getSelection();
                sel?.removeAllRanges();
                sel?.addRange(r);
              } else {
                const p = doc.caretPositionFromPoint?.(e.clientX, e.clientY);
                if (p && el.contains(p.offsetNode)) {
                  const range = document.createRange();
                  range.setStart(p.offsetNode, p.offset);
                  range.collapse(true);
                  const sel = window.getSelection();
                  sel?.removeAllRanges();
                  sel?.addRange(range);
                }
              }
              // Stash click position so the useLayoutEffect re-anchors the caret AFTER React
              // re-renders. Without this, React's reconciliation of the span's children
              // (text node) collapses the selection back to the end of the text.
              editClickPosRef.current = { x: e.clientX, y: e.clientY };
              setEditing(true);
            }}
            onBlur={(e) => {
              const next = (e.currentTarget.textContent || '').trim();
              if (onRename && next && next !== task.title) onRename(next);
              setEditing(false);
              // Fresh + still empty after blur → silently soft-delete after 15 minutes if the
              // user hasn't come back to fill it in. No visual fade — the row stays normal until
              // it quietly disappears (and lands in Settings → Trash since onDelete soft-deletes).
              // 15 min gives plenty of time to step away and return.
              //
              // DEFENSIVE re-check at fire time: read the LIVE DOM textContent at the moment
              // the timer fires, not just the value captured at blur. iOS predictive text
              // sometimes doesn't fire keydown for replacement-text events, so `fresh` may
              // stay true even after typing — and a stray re-render of {task.title} can briefly
              // clobber the contenteditable's content if it's empty in props. Both of those
              // were causing typed-then-trashed bugs ("tasks I never marked finished showing
              // up in Trash"). The fire-time re-check makes the timer a no-op if anything
              // got there in the meantime.
              if (fresh && !next && onDelete) {
                setFading(true);
                fadeTimerRef.current = setTimeout(() => {
                  fadeTimerRef.current = null;
                  const el = titleRef.current;
                  const live = el ? (el.textContent || '').trim() : '';
                  if (live) return; // user (or sync) put content there — keep the task
                  onDelete();
                }, 15 * 60 * 1000);
              }
            }}
            onInput={() => {
              // Backstop for the keydown-based "user typed" detection. iOS Safari's predictive
              // text, autocorrect-replace, dictation, and paste paths don't always fire keydown
              // for each character (or fire only for the trigger key), so relying on keydown
              // alone leaves `fresh` stuck at true even after the user has typed real content.
              // onInput fires for ALL of those paths — flipping fresh false and cancelling any
              // in-flight fade here closes the gap that was silently trashing typed tasks.
              if (fresh) setFresh(false);
              if (fading) cancelFade();
            }}
            onKeyDown={(e) => {
              // Stop ALL keystrokes from bubbling to the row's drag listeners while editing —
              // dnd-kit's KeyboardSensor would otherwise see Space/Arrow keys as "start drag" commands.
              e.stopPropagation();
              // Any non-control keystroke means the user is engaging — kill the "fresh" flag so
              // a subsequent blur with empty title doesn't trigger the fade-then-delete timer.
              // ALSO cancel any in-flight fade: if the row already started fading (e.g. a stray
              // blur fired between mount and the user typing the first character), typing must
              // rescue the row instead of letting the 3s timer delete it mid-edit.
              if (e.key.length === 1) {
                setFresh(false);
                if (fading) cancelFade();
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                (e.currentTarget as HTMLSpanElement).blur();
                if (onAddSibling) onAddSibling();
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                (e.currentTarget as HTMLSpanElement).textContent = task.title;
                setEditing(false);
                return;
              }
              // ArrowUp / ArrowDown / Tab navigate to the next or previous task title.
              // - Arrows preserve the X-position of the caret (so it lands inline with where it was).
              // - Tab places the caret at the START of the next title.
              if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Tab') {
                const titles = Array.from(document.querySelectorAll('[data-task-title]')) as HTMLElement[];
                const current = e.currentTarget as HTMLElement;
                const idx = titles.indexOf(current);
                if (idx < 0) return;
                const dir = e.key === 'ArrowUp' ? -1 : 1;
                const target = titles[idx + dir];
                if (!target) return;
                e.preventDefault();
                // Capture current caret X so the next title can land its caret in the same column.
                let caretX: number | undefined;
                if (e.key !== 'Tab') {
                  const sel = window.getSelection();
                  const range = sel?.rangeCount ? sel.getRangeAt(0) : null;
                  const r = range?.getBoundingClientRect();
                  caretX = r && (r.left || r.right) ? r.left : current.getBoundingClientRect().left;
                } else {
                  caretX = target.getBoundingClientRect().left + 1; // start of target text
                }
                const targetRect = target.getBoundingClientRect();
                const targetY = targetRect.top + targetRect.height / 2;
                // Save the title we're leaving (in case the user typed but didn't blur).
                const next = (current.textContent || '').trim();
                if (onRename && next && next !== task.title) onRename(next);
                // Dispatch a real pointerdown on the target — its existing handler flips
                // contentEditable, focuses, and places the caret at the (x, y) coordinates.
                target.dispatchEvent(new PointerEvent('pointerdown', {
                  bubbles: true, cancelable: true, button: 0,
                  clientX: caretX as number, clientY: targetY,
                  pointerType: 'mouse', isPrimary: true,
                }));
              }
            }}
            className={`relative z-10 font-['Univers_BQ:55_Regular',sans-serif] leading-[normal] not-italic text-[14px] outline-none whitespace-nowrap min-w-0 overflow-hidden text-ellipsis ${titleColor} ${onRename ? 'cursor-text pl-[7px] -ml-[7px]' : ''}`}
            // Hotspot tolerance:
            //   left  — 7px padding offset by negative margin so text doesn't shift
            //   right — handled by an absolutely-positioned spacer rendered AFTER the span (see
            //           below). The right side can't use padding+negative-margin alone because
            //           the parent's overflow-hidden + DOM-order hit testing make later siblings
            //           (assignee badge, deadline arrow) win the overlap.
            // min-w-0 + overflow-hidden + text-ellipsis: when the title row is squeezed
            // (narrow column + long title that the density cascade can't trim further), the
            // title ellipsizes instead of pushing the date off the right edge. Title fully
            // visible when there's room; gracefully truncates when there isn't.
            // Empty / very-short titles still need a comfortable min-width (40px = ~5 chars).
            style={(task.title || '').length <= 1 ? { minWidth: '40px' } : undefined}
          >{task.title}</span>
              );
              return [sep, titleNode].filter(Boolean) as React.ReactNode[];
            }
            return null;
            });
          })()}
          {/* Trailing hit-zone — a slim 4px transparent strip immediately AFTER the title.
              Captures clicks just past the title's last character and forwards them to the
              title span, dispatching a synthetic pointerdown so the existing caret-placement
              handler fires and lands the caret at the end. Lives outside the title span (so it
              isn't part of the contentEditable's text) but inside the same flex row, claiming
              real layout space — that's why DOM-order hit testing actually picks it up.
              Width matches the inner gap-[4px] between meta slots so the visual gap to the
              first assignee badge reads as the same beat used everywhere else in the row.
              Click target is `self-stretch` (full row height = 37px) so this remains an easy
              target despite being narrow horizontally. */}
          {onRename && (
            <span
              aria-hidden
              className="cursor-text shrink-0 self-stretch w-[4px]"
              onPointerDown={(e) => {
                if (editing) return;
                e.stopPropagation();
                e.preventDefault();
                const el = titleRef.current;
                if (!el) return;
                const rect = el.getBoundingClientRect();
                // Re-fire the click as if it landed on the END of the title text — the title's
                // own onPointerDown handles caret placement at that point.
                el.dispatchEvent(new PointerEvent('pointerdown', {
                  bubbles: true, cancelable: true, button: 0,
                  clientX: rect.right - 1, clientY: rect.top + rect.height / 2,
                  pointerType: 'mouse', isPrimary: true,
                }));
              }}
            />
          )}
        </div>
        {(() => {
          // Three render cases:
          //   1. Has a real deadline → DeadlineArrow + formatted date (existing behavior)
          //   2. No deadline, NOT a milestone, AND landed in Today or Tomorrow →
          //      grey "today" / "tomorrow" word with NO arrow. Acts as an implicit
          //      deadline label so the user can see at a glance which of the
          //      undated tasks belong to which day-band.
          //   3. Anything else → render nothing (e.g. an undated Next-section task).
          // All three cases share the same click affordance:
          //   double-click → push one day forward (today → tomorrow; tomorrow → next)
          //   shift+double-click → push one day backward
          //   alt-click → next week
          // Calling onReschedule on an undated task stamps a real deadline + moves
          // its section accordingly, so the implicit label "becomes" a real one.
          const hasDeadline = !!task.deadline;
          const isSectionFallback = !hasDeadline && !isScheduled && (task.section === 'today' || task.section === 'tomorrow');
          if (!hasDeadline && !isSectionFallback) return null;
          const late = hasDeadline ? isLateDeadline(task.deadline) : false;
          const clickable = !!onReschedule;
          // Color rules (in priority order):
          //   completed → #474747 (faded body color)
          //   no-deadline section fallback → #656464 (muted grey)
          //   milestone → milestone purple
          //   late → red
          //   next-section → dim grey-white
          //   default → white
          const colorCls = task.completed ? 'text-[#474747]'
            : isSectionFallback ? 'text-[#656464]'
            : isScheduled ? milestonePurpleClass
            : late ? 'text-[#FF7171]'
            : isNext ? 'text-[#a8a8a8]'
            : 'text-white';
          const cls = `font-['NB_International:Regular',sans-serif] leading-[normal] not-italic text-[14.333px] whitespace-nowrap ${colorCls} ${clickable ? 'cursor-pointer' : ''}`;
          return (
            <>
              {hasDeadline && !isScheduled && <DeadlineArrow dim={task.completed} small={density >= 3} />}
              <p
                className={cls}
                onClick={clickable ? (e) => { if (e.altKey) { e.stopPropagation(); onReschedule!('nextWeek'); } } : undefined}
                onDoubleClick={clickable ? (e) => {
                  e.stopPropagation();
                  // TWO different behaviors depending on whether the task is dated:
                  //
                  //   Dated task → push the DEADLINE one day forward / back. Repeated
                  //     double-clicks march the date along; section auto-tracks the
                  //     new date. Late tasks first catch up to today, then march.
                  //
                  //   Undated task → walk the SECTION forward / back (today → tomorrow
                  //     → next, or the reverse). Never auto-promotes the task into a
                  //     dated task — the user has to add a deadline explicitly.
                  //     Clamps at the ends of the sequence.
                  if (isSectionFallback) {
                    if (e.shiftKey) onReschedule!('sectionBack');
                    else onReschedule!('sectionForward');
                    return;
                  }
                  if (e.shiftKey) { onReschedule!('shiftBack'); return; }
                  if (late) onReschedule!('today');
                  else onReschedule!('shiftForward');
                } : undefined}
                title={clickable ? (isSectionFallback
                  ? 'Double-click → push to next section • Shift+double-click → previous section'
                  : 'Double-click → push one day later • Shift+double-click → one day earlier • Alt+click → next week') : undefined}
              >
                {hasDeadline
                  ? (density >= 2 ? formatDeadlineShort(task.deadline) : formatDeadline(task.deadline))
                  : (task.section === 'today' ? 'Today' : 'Tomorrow')}
              </p>
            </>
          );
        })()}
        {/* Assignees — now AFTER the date. Hidden at rest; fade IN on row-hover (~200ms), and on
            roll-off they LINGER ~1s then fade OUT over 500ms. The asymmetry is pure CSS: the
            not-hovered class carries duration-500 + delay-[1000ms], the hovered class fades in
            fast with no delay. Stays lit while dragging so the overlay still shows who owns it.
            opacity-only (reserved width) so appearing never nudges the row's other content. */}
        {density < 5 && task.assignees.length > 0 && (
          <span className={`flex flex-row items-center gap-2 transition-opacity ${(isDragOverlay || isDragging || hovered) ? 'opacity-100 duration-200' : 'opacity-0 duration-500 delay-1000'}`}>
            {task.assignees.map((a, i) => <AssigneeBadge key={`${a}-${i}`} letter={a} tone={isScheduled ? 'scheduled' : 'todo'} hollow={isPersonal} dim={task.completed} faint={isExpiredMilestone} />)}
          </span>
        )}
        {/* "Has Focus content" indicator. Shows when the task (or its parent project) has any
            brief / notes / sub-tasks / reference images attached. Always visible (not hover-
            reveal) so the eye can scan the column for "what has stuff" at a glance. Click jumps
            into Focus mode with this task selected, so its content opens up immediately.
            -mt-[2px] lifts the icon 2px so it sits with the title cap-height rather than the
            row centerline — visually quieter alongside the other inline meta items. */}
        {!isDragOverlay && hasFocusContent && onOpenFocus && (
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); (e.currentTarget as HTMLButtonElement).blur(); onOpenFocus(); }}
            className="p-1 -mt-[2px] text-[#5e5e5e] hover:text-white transition-colors"
            aria-label="Open in Focus view"
            title="Open in Focus"
          >
            <FileText size={12} />
          </button>
        )}
        {/* + sits inline right after the task info (assignees / deadline) so it always hugs the content.
            We blur() the button immediately so its focus state doesn't compete with the new task's
            title focus (which fires from a setTimeout in SortableTaskItem's useLayoutEffect). */}
        {!isDragOverlay && onAddSibling && (
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); (e.currentTarget as HTMLButtonElement).blur(); onAddSibling(); }}
            className="p-1 opacity-0 group-hover:opacity-100 text-[#5e5e5e] hover:text-white transition-opacity"
            aria-label="Add task in same project"
          >
            <Plus size={14} />
          </button>
        )}
        {/* Trash is the last element and uses ml-auto so it always pins to the right edge of the row. */}
        {!isDragOverlay && onDelete && (
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            className="ml-auto -mr-[22px] p-1 opacity-0 group-hover:opacity-100 text-[#5e5e5e] hover:text-white transition-opacity"
            aria-label="Delete task"
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>
    </motion.div>
    </Displaced>
  );
}

function SectionHeader({ title, onAdd, sticky, tall, accent }: { title: string; onAdd?: () => void; sticky?: 'date' | 'category'; tall?: boolean; accent?: boolean }) {
  // All section headers (Today, Inbox, Next, Milestones, …) render in the muted
  // grey-text tone — they're navigational labels, not highlighted state.
  //
  // STICKY BEHAVIOR (when `sticky` is set):
  // The inline header still scrolls naturally with the content — it's NOT
  // position:sticky any more. Instead, the parent CustomScroll renders a single
  // StickyOverlay over the top of the column showing the "currently active"
  // date and category labels, switching them via opacity crossfade (no vertical
  // motion). The inline label here scrolls up under the overlay's solid backdrop,
  // hidden by it. Data attrs tell the overlay what to render:
  //   data-sticky-tier  → 'date' | 'category'
  //   data-sticky-label → the label text
  //   data-sticky-tall  → 'true' if this date should reserve a 37px carriage-return
  //                       gap below its label (only the dashboard's Today/etc.).
  //
  // `tall` (only meaningful with sticky='date'): adds a 37px padding-bottom to
  // the outer wrapper so the inline header reserves the same vertical space the
  // sticky overlay will occupy when this date is active. Keeps the natural-flow
  // layout identical to before the overlay was introduced.
  // `accent` renders the label in milestone purple instead of the muted grey — used by the
  // focus page's mini-calendar for the "(Today)" band, matching the week calendar's today
  // header. Carried through to the sticky overlay via data-sticky-accent.
  const dataAttrs: Record<string, string | undefined> = sticky
    ? { 'data-sticky-tier': sticky, 'data-sticky-label': title, 'data-sticky-tall': tall ? 'true' : undefined, 'data-sticky-accent': accent ? 'true' : undefined }
    : {};
  const extension = tall ? 'pb-[37px]' : '';
  return (
    <div {...dataAttrs} className={`w-full box-border ${extension}`}>
      <div className="group h-[37px] w-full box-border flex flex-row gap-2 items-center px-[31px]">
        <p className={`font-['Univers_BQ:55_Regular',sans-serif] leading-[normal] not-italic text-[14px] whitespace-nowrap ${accent ? 'text-[#8465ff]' : 'text-[#656464]'}`}>{title}</p>
        {onAdd && <AddPlus onClick={onAdd} />}
      </div>
    </div>
  );
}

// StickyOverlay — sits inside CustomScroll's outer wrapper (above the inner
// scroll element). Driven by data attributes on SectionHeader: queries
// [data-sticky-tier="date"] and [data-sticky-tier="category"] to find the
// "currently active" labels based on scroll position, then renders them in
// fixed slots with an AnimatePresence opacity crossfade. The labels never
// move vertically — they fade in/out in place as the scroll position
// transitions between bands.
//
// Active date    = the LATEST [data-sticky-tier="date"] whose top is at-or-above
//                  the container top. (Most recently scrolled past = currently
//                  "in" that band.)
// Active category = the LATEST [data-sticky-tier="category"] within the active
//                  date's wrapper element whose top is at-or-above the container
//                  top + dateHeight (37 or 74). Categories are scoped to their
//                  date wrapper so they auto-clear when the date band ends.
function StickyOverlay({ scrollElRef }: { scrollElRef: React.RefObject<HTMLDivElement | null> }) {
  const [active, setActive] = useState<{ date: string | null; dateTall: boolean; dateAccent: boolean; category: string | null; dateHasAdd: boolean; catHasAdd: boolean }>({ date: null, dateTall: false, dateAccent: false, category: null, dateHasAdd: false, catHasAdd: false });
  // The overlay's + re-finds the currently-stuck header from the LIVE DOM at click time
  // (an element ref would go stale/detached across re-renders) and clicks its hidden inline
  // AddPlus, so the pinned header keeps its quick-add.
  const clickAdd = (tier: 'date' | 'category') => () => {
    const el = scrollElRef.current;
    if (!el) return;
    const containerTop = el.getBoundingClientRect().top;
    const dateEls = Array.from(el.querySelectorAll<HTMLElement>('[data-sticky-tier="date"]'));
    let dateEl: HTMLElement | null = null;
    for (const d of dateEls) if (d.getBoundingClientRect().top <= containerTop + 1) dateEl = d;
    if (tier === 'date') { (dateEl?.querySelector('[data-add-plus]') as HTMLButtonElement | null)?.click(); return; }
    // category: topmost category header within the active date's wrapper, at the flush-below threshold.
    const wrapper = dateEl?.parentElement;
    if (!wrapper) return;
    const tall = dateEl?.dataset.stickyTall === 'true';
    const threshold = containerTop + (tall ? 74 : 37) + 1;
    let catEl: HTMLElement | null = null;
    for (const c of Array.from(wrapper.querySelectorAll<HTMLElement>('[data-sticky-tier="category"]'))) {
      if (c.getBoundingClientRect().top <= threshold) catEl = c;
    }
    (catEl?.querySelector('[data-add-plus]') as HTMLButtonElement | null)?.click();
  };

  useEffect(() => {
    const el = scrollElRef.current;
    if (!el) return;
    let rafId = 0;
    const compute = () => {
      rafId = 0;
      const containerRect = el.getBoundingClientRect();
      const containerTop = containerRect.top;
      const dateEls = Array.from(el.querySelectorAll<HTMLElement>('[data-sticky-tier="date"]'));
      let activeDateEl: HTMLElement | null = null;
      for (const dEl of dateEls) {
        // +1 tolerance for subpixel scroll positions (the lerp sometimes lands
        // at 0.5px which would otherwise flicker on/off near the boundary).
        if (dEl.getBoundingClientRect().top <= containerTop + 1) activeDateEl = dEl;
      }
      const nextDate = activeDateEl?.dataset.stickyLabel || null;
      const nextDateTall = activeDateEl?.dataset.stickyTall === 'true';
      const nextDateAccent = activeDateEl?.dataset.stickyAccent === 'true';
      let nextCategory: string | null = null;
      let activeCatEl: HTMLElement | null = null;
      if (activeDateEl) {
        // Scope categories to the active date's wrapper so Tomorrow/Next bands
        // (which have no categories) cleanly clear the category slot.
        const wrapper = activeDateEl.parentElement;
        if (wrapper) {
          const catEls = Array.from(wrapper.querySelectorAll<HTMLElement>('[data-sticky-tier="category"]'));
          const catThreshold = containerTop + (nextDateTall ? 74 : 37);
          for (const cEl of catEls) {
            if (cEl.getBoundingClientRect().top <= catThreshold + 1) { nextCategory = cEl.dataset.stickyLabel || null; activeCatEl = cEl; }
          }
        }
      }
      const nextDateHasAdd = !!activeDateEl?.querySelector('[data-add-plus]');
      const nextCatHasAdd = !!activeCatEl?.querySelector('[data-add-plus]');
      setActive((prev) => (prev.date === nextDate && prev.dateTall === nextDateTall && prev.dateAccent === nextDateAccent && prev.category === nextCategory && prev.dateHasAdd === nextDateHasAdd && prev.catHasAdd === nextCatHasAdd ? prev : { date: nextDate, dateTall: nextDateTall, dateAccent: nextDateAccent, category: nextCategory, dateHasAdd: nextDateHasAdd, catHasAdd: nextCatHasAdd }));
    };
    const schedule = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(compute);
    };
    compute();
    el.addEventListener('scroll', schedule, { passive: true });
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    const mo = new MutationObserver(schedule);
    mo.observe(el, { childList: true, subtree: true });
    return () => {
      el.removeEventListener('scroll', schedule);
      ro.disconnect();
      mo.disconnect();
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [scrollElRef]);

  const dateHeight = active.dateTall ? 74 : 37;
  const bgHeight = (active.date ? dateHeight : 0) + (active.category ? 37 : 0);
  // pointer-events-none: the overlay is a visual layer only; clicks pass
  // through to whatever scrolls beneath. z-30 sits above task rows (z-10) but
  // below the drag overlay (z-50).
  //
  // LAYERED STRUCTURE (bottom → top):
  //   1. bg layer    — single always-opaque bg-[#282828] rect covering the full
  //                    overlay zone (date height + 37 for category if active).
  //                    NEVER animates opacity, so the backdrop is always 100%
  //                    opaque. Earlier we combined bg + label in one motion.div
  //                    per slot, but during AnimatePresence crossfade BOTH the
  //                    outgoing and incoming overlays carried bg at fading
  //                    opacity — alpha blending peaked at ~75% combined opacity
  //                    around the midpoint, letting underlying text bleed
  //                    through as a "ghost." Splitting bg out fixes it.
  //   2. date label  — separate motion.div inside an AnimatePresence; crossfades
  //                    text only, bg-transparent so it doesn't interact with
  //                    the bg layer's opacity.
  //   3. category    — same pattern, sits below the date.
  return (
    <div className="absolute top-0 left-0 right-[14px] pointer-events-none z-30">
      {/* Always-opaque backdrop — covers the entire overlay area in one go so
          no fade-related alpha gaps appear. */}
      {bgHeight > 0 && (
        <div
          className="absolute top-0 left-0 right-0 bg-[#282828]"
          style={{ height: bgHeight }}
        />
      )}
      {/* Date label slot — crossfade in place, no bg. */}
      <div className="absolute top-0 left-0 right-0 h-[37px]">
        <AnimatePresence>
          {active.date && (
            <motion.div
              key={`d-${active.date}`}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              // Buttery ease-out-expo, slightly longer than typical UI feedback
              // so the swap feels like a deliberate transition, not a flicker.
              transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
              className="group absolute inset-0 box-border flex flex-row gap-2 items-center px-[31px] pointer-events-auto"
            >
              <p className={`font-['Univers_BQ:55_Regular',sans-serif] leading-[normal] not-italic text-[14px] whitespace-nowrap ${active.dateAccent ? 'text-[#8465ff]' : 'text-[#656464]'}`}>{active.date}</p>
              {active.dateHasAdd && (
                <button type="button" onClick={clickAdd('date')} className="opacity-0 group-hover:opacity-100 text-[#656464] hover:text-white transition-opacity" aria-label="Add task"><Plus size={14} /></button>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      {/* Category label slot — sits flush below the date (top = dateHeight). */}
      <div className="absolute left-0 right-0 h-[37px]" style={{ top: dateHeight }}>
        <AnimatePresence>
          {active.category && (
            <motion.div
              key={`c-${active.category}`}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
              className="group absolute inset-0 box-border flex flex-row gap-2 items-center px-[31px] pointer-events-auto"
            >
              <p className="font-['Univers_BQ:55_Regular',sans-serif] leading-[normal] not-italic text-[#656464] text-[14px] whitespace-nowrap">{active.category}</p>
              {active.catHasAdd && (
                <button type="button" onClick={clickAdd('category')} className="opacity-0 group-hover:opacity-100 text-[#656464] hover:text-white transition-opacity" aria-label="Add task"><Plus size={14} /></button>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function Spacer() { return <div className="h-[37px] shrink-0 w-full" />; }

// Drop-target row inside the edge assign drawers (left = projects, right = assignees).
// Highlights while a dragged card hovers it; the drop itself is handled in handleDragEnd
// via the `edge:project:<id>` / `edge:person:<short>` droppable ids.
function EdgeDropRow({ id, children }: { id: string; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  // isOver → strong purple wash: signals "drop here and the task moves to this project /
  // gets this assignee." Purple matches the app's accent for project/assignment actions.
  return (
    <div ref={setNodeRef} className={`h-[37px] w-full box-border flex flex-row gap-2 items-center px-[31px] transition-colors ${isOver ? 'bg-[#8465ff]/30' : 'hover:bg-white/[0.04]'}`}>
      {children}
    </div>
  );
}

// A CLIENT header inside the assign tray. Doubles as a drop target (`edge:client:<id>` →
// assign the task straight to the client) AND the accordion toggle (hover to open its
// projects, click to pin). isOver → purple, same "drop here to assign" cue as the rows.
function EdgeClientRow({
  client, count, expanded, onMouseEnter, onMouseLeave, onClick,
}: {
  client: Client; count: number; expanded: boolean;
  onMouseEnter: () => void; onMouseLeave: () => void; onClick: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `edge:client:${client.id}` });
  return (
    <button
      ref={setNodeRef}
      type="button"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onClick={onClick}
      className={`group h-[37px] w-full text-left box-border flex flex-row gap-2 items-center px-[31px] transition-colors ${isOver ? 'bg-[#8465ff]/30' : 'hover:bg-white/[0.05]'}`}
    >
      <ChevronRight size={12} className={`text-[#5e5e5e] transition-transform ${expanded ? 'rotate-90' : ''}`} />
      <span className="font-['Univers_BQ:55_Regular',sans-serif] text-[14px] whitespace-nowrap overflow-hidden text-ellipsis text-white">{client.name || client.short}</span>
      <span className="text-[#474747] text-[12px]">{count}</span>
    </button>
  );
}

// The focus panel's "Projects" title, doubling as the un-nest drop target: dragging a
// sub-project onto it promotes it back to top level (focusnest:__root__ → parentId cleared).
function ProjectsHeaderDropZone({ onClearFilter }: { onClearFilter?: () => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: 'focusnest:__root__' });
  // Clicking the title (the empty space above the lists) clears any active filter — the
  // low-friction "click off the filter" gesture, alongside the explicit Clear-filter row.
  return (
    <div
      ref={setNodeRef}
      onClick={onClearFilter}
      className={`shrink-0 group h-[37px] w-full box-border flex flex-row gap-2 items-center px-[35px] transition-colors ${onClearFilter ? 'cursor-pointer' : ''} ${isOver ? 'bg-[#8465ff]/20' : ''}`}
      style={{ marginBottom: SPACING.dcr }}
    >
      <p className="font-['NB_International:Regular',sans-serif] leading-[normal] not-italic text-[14.333px] text-white whitespace-nowrap">Clients + Projects{isOver ? ' — drop to un-nest' : ''}</p>
    </div>
  );
}

// Full-area droppable behind the assign tray's content. Its job is to MASK the columns
// underneath: while the tray is open and a task is dragged over ANY part of it (headers,
// gaps, not just a row), calendarCollision returns this edge hit, so the sortables beneath
// the tray never see `over` and stop displacing/reacting. Specific rows (edge:project /
// edge:person) still win over this for the actual assignment (see calendarCollision).
function TrayMask() {
  const { setNodeRef } = useDroppable({ id: 'edge:__mask__' });
  return <div ref={setNodeRef} className="absolute inset-0 -z-10" aria-hidden />;
}

// A project row in the focus-page filter panel: draggable (drag onto another to nest it) AND
// a drop target (`focusnest:<id>`). Clicking still filters — the 8px sensor distance means a
// stationary press is a click, a >8px move is a drag. depth indents nested rows; `expandable`
// shows the accordion chevron; `active`/`onToggleExpand`/`onClick` drive filter + expand.
function FocusProjectRow({
  project, client, depth, count, active, expandable, expanded, onClick, onToggleExpand,
}: {
  project: Project; client?: Client; depth: number; count: number; active: boolean;
  expandable: boolean; expanded: boolean; onClick: () => void; onToggleExpand: () => void;
}) {
  const { setNodeRef: dragRef, attributes, listeners, isDragging } = useDraggable({
    id: `focusdrag:${project.id}`,
    data: { type: 'focusProject', projectId: project.id, project },
  });
  const { setNodeRef: dropRef, isOver } = useDroppable({ id: `focusnest:${project.id}` });
  return (
    <div
      ref={(el) => { dragRef(el); dropRef(el); }}
      {...attributes}
      {...listeners}
      onClick={onClick}
      className={`group h-[37px] w-full text-left box-border flex flex-row gap-2 items-center px-[31px] cursor-grab active:cursor-grabbing transition-colors ${isDragging ? 'opacity-40' : ''} ${isOver ? 'bg-[#8465ff]/20' : active ? 'bg-[#8465ff]/15' : 'hover:bg-white/[0.03]'}`}
      style={{ paddingLeft: 31 + depth * 24 }}
    >
      {expandable ? (
        <button
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); onToggleExpand(); }}
          className="shrink-0 -ml-[2px] p-[2px] text-[#5e5e5e] hover:text-white transition-colors"
          aria-label={expanded ? 'Collapse sub-projects' : 'Expand sub-projects'}
        >
          <ChevronRight size={12} className={`transition-transform ${expanded ? 'rotate-90' : ''}`} />
        </button>
      ) : depth > 0 ? <span className="shrink-0 w-[10px]" aria-hidden /> : null}
      {client?.short && depth === 0 && (
        <span className="font-['Univers_BQ:55_Regular',sans-serif] text-[14px] whitespace-nowrap text-[#656464]">{client.short}</span>
      )}
      <span className={`font-['Univers_BQ:55_Regular',sans-serif] text-[14px] whitespace-nowrap overflow-hidden text-ellipsis ${active ? 'text-[#8465ff]' : 'text-white'}`}>{project.name || 'Untitled'}</span>
      {count > 0 && <span className="text-[#474747] text-[12px]">{count}</span>}
      {active && <X size={14} className="ml-auto text-[#a8a8a8]" />}
    </div>
  );
}

// Settings row: customize the global PIP (quick window) shortcut. Records a key combo from a
// real keypress, then asks the Tauri shell to re-register it live (persisted Rust-side in
// app-config, so it survives restarts). In a plain browser it explains it's desktop-only.
// Note: Fn cannot be captured — laptop firmware handles it below the OS, so no app can bind it.
function PipShortcutSetting() {
  const tauri = typeof window !== 'undefined'
    ? (window as unknown as { __TAURI__?: { core?: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } } }).__TAURI__
    : undefined;
  const [combo, setCombo] = useState<string>(() => { try { return localStorage.getItem('pip-shortcut-display') || 'Ctrl+Space'; } catch { return 'Ctrl+Space'; } });
  const [recording, setRecording] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation();
    const k = e.key;
    if (k === 'Control' || k === 'Alt' || k === 'Shift' || k === 'Meta') return; // modifiers alone don't finish a combo
    const parts: string[] = [];
    if (e.ctrlKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    if (e.metaKey) parts.push('Super');
    if (parts.length === 0) { setStatus('Include a modifier (Ctrl / Alt / Shift / Win).'); return; }
    parts.push(k === ' ' ? 'Space' : k.length === 1 ? k.toUpperCase() : k);
    setCombo(parts.join('+'));
    setRecording(false);
    setStatus(null);
  };
  const apply = async () => {
    if (!tauri?.core?.invoke) { setStatus('Global shortcuts only work in the desktop app — open Ctrl-Project (Tauri) and set it there.'); return; }
    try {
      const res = await tauri.core.invoke('set_pip_shortcut', { combo });
      try { localStorage.setItem('pip-shortcut-display', combo); } catch { /* private mode */ }
      setStatus(`Registered: ${String(res)}`);
    } catch (err) {
      setStatus(String(err));
    }
  };
  return (
    <>
      <div className="flex flex-row items-center gap-3">
        <button
          type="button"
          onClick={() => { setRecording(true); setStatus(null); }}
          onKeyDown={onKeyDown}
          onBlur={() => setRecording(false)}
          className={`px-3 py-1 rounded-md text-[13px] transition-colors ${recording ? 'bg-[#7363FF] text-white' : 'bg-[#1f1f1f] text-[#ccc] hover:bg-[#333]'}`}
        >
          {recording ? 'Press keys…' : combo}
        </button>
        <button type="button" onClick={apply} className="text-[13px] text-[#656464] hover:text-white transition-colors">Apply</button>
      </div>
      {status && <p className="text-[12px] text-[#a8a8a8]">{status}</p>}
      <p className="text-[12px] text-[#656464]">Toggles the floating quick window from anywhere. Fn can't be bound — it never reaches the OS.</p>
    </>
  );
}

function SectionDroppable({ id, children }: { id: string; children: React.ReactNode }) {
  const { setNodeRef } = useDroppable({ id });
  // pb-[37px] gives the section a 37px slop zone below its last card so dropping in the visual
  // margin between sections still resolves here. Without this, drops in the gap between Today
  // and Next (or below the last card in a column) fell through to no droppable at all.
  return <div ref={setNodeRef} className="min-h-[37px] w-full pb-[37px]">{children}</div>;
}

function BottomBar({ mode, onSetMode, onAdd }: { mode: AppMode; onSetMode: (m: AppMode) => void; onAdd: () => void }) {
  const iconClass = (active: boolean) => `p-2 rounded-full transition-colors ${active ? 'text-white' : 'text-[#656464] hover:text-white'}`;
  return (
    <div className="fixed bottom-0 left-0 right-0 h-[76px] bg-[#232323] flex flex-row items-center justify-between pl-[17px] pr-[35px] z-40">
      {/* Left cluster: four view icons followed by the + add-task button. The 17px left
          gutter makes the Dashboard icon's geometric center (17 + p-2 padding + half of
          the 22px icon = 36) line up with the task-row checkbox center above (31px row
          padding + half of the 12px checkbox = 37) — within a sub-pixel of vertical
          alignment with the leftmost column's checkboxes. Settings stays at the standard
          35px right gutter. */}
      <div className="flex flex-row gap-10 items-center">
        {/* Order: Focus, Calendar, List, Project. Each icon carries a styled hover tooltip
            (the native title= delay/skin read as missing). Focus stays first so its glyph
            center keeps aligning with the leftmost column's checkboxes (see comment above). */}
        {([
          { m: 'focus', label: 'Focus', Icon: LayoutDashboard },
          { m: 'calendar', label: 'Calendar', Icon: CalendarIcon },
          { m: 'dashboard', label: 'List', Icon: List },
          { m: 'projectView', label: 'Project', Icon: FolderTree },
        ] as { m: AppMode; label: string; Icon: React.ComponentType<{ size?: number }> }[]).map(({ m, label, Icon }) => (
          <div key={m} className="group relative flex items-center">
            <button aria-label={label} onClick={() => onSetMode(m)} className={iconClass(mode === m)}><Icon size={22} /></button>
            <span className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 rounded bg-[#333333] text-white text-[11px] whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity">{label}</span>
          </div>
        ))}
        <motion.button title="Add task" aria-label="Add task" onClick={onAdd} whileHover={{ scale: 1.06 }} whileTap={{ scale: 0.94 }} className="size-[27px] rounded-full bg-[#7363FF] flex items-center justify-center shadow-lg">
          <Plus size={16} color="#232323" strokeWidth={2.5} />
        </motion.button>
      </div>
      {/* Settings — pinned to the right edge with the same 35px gutter. */}
      <button title="Settings" aria-label="Settings" onClick={() => onSetMode('settings')} className={iconClass(mode === 'settings')}><SettingsIcon size={22} /></button>
    </div>
  );
}

function DateRangePicker({ start, end, onChange }: { start?: string; end?: string; onChange: (s?: string, e?: string) => void }) {
  const [viewMonth, setViewMonth] = useState(() => {
    const base = start || end || todayISO();
    const [y, m] = base.split('-').map(Number);
    return { y, m };
  });
  const [hoverIso, setHoverIso] = useState<string | null>(null);

  const daysInMonth = new Date(viewMonth.y, viewMonth.m, 0).getDate();
  const firstDay = new Date(viewMonth.y, viewMonth.m - 1, 1).getDay();
  const monthName = new Date(viewMonth.y, viewMonth.m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  const iso = (d: number) => `${viewMonth.y}-${String(viewMonth.m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

  const pick = (d: number) => {
    const picked = iso(d);
    if (!start || (start && end)) {
      onChange(picked, undefined);
    } else {
      if (picked < start) onChange(picked, start);
      else if (picked === start) onChange(undefined, undefined);
      else onChange(start, picked);
    }
  };

  const prevMonth = () => setViewMonth(({ y, m }) => m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 });
  const nextMonth = () => setViewMonth(({ y, m }) => m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 });

  const inRange = (d: number) => {
    const cur = iso(d);
    const hovering = start && !end && hoverIso;
    const rangeEnd = end || (hovering && hoverIso >= start ? hoverIso : undefined);
    const rangeStart = start && hovering && hoverIso < start ? hoverIso : start;
    if (!rangeStart || !rangeEnd) return false;
    return cur >= rangeStart && cur <= rangeEnd;
  };

  return (
    <div className="bg-[#1f1f1f] rounded-md p-3">
      <div className="flex items-center justify-between mb-2">
        <button type="button" onClick={prevMonth} className="text-[#888] hover:text-white px-2">â€¹</button>
        <div className="text-white text-[13px]">{monthName}</div>
        <button type="button" onClick={nextMonth} className="text-[#888] hover:text-white px-2">â€º</button>
      </div>
      <div className="grid grid-cols-7 gap-1 text-[11px] text-[#666] mb-1">
        {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => <div key={i} className="text-center">{d}</div>)}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {Array.from({ length: firstDay }).map((_, i) => <div key={`b${i}`} />)}
        {Array.from({ length: daysInMonth }, (_, i) => i + 1).map((d) => {
          const cur = iso(d);
          const isStart = start === cur;
          const isEnd = end === cur;
          const isInRange = inRange(d);
          const isEdge = isStart || isEnd;
          return (
            <button
              key={d}
              type="button"
              onClick={() => pick(d)}
              onMouseEnter={() => setHoverIso(cur)}
              onMouseLeave={() => setHoverIso(null)}
              className={`h-7 rounded text-[12px] transition-colors ${isEdge ? 'bg-[#7363FF] text-white' : isInRange ? 'bg-[#7363FF]/30 text-white' : 'text-[#ccc] hover:bg-[#333]'}`}
            >{d}</button>
          );
        })}
      </div>
      <div className="flex items-center justify-between mt-2 text-[11px]">
        <div className="text-[#888]">
          {start && <span>{formatDeadline(start)}</span>}
          {start && end && <span className="mx-1">â†’</span>}
          {end && <span>{formatDeadline(end)}</span>}
          {!start && !end && <span>Pick start, then end</span>}
        </div>
        {(start || end) && (
          <button type="button" onClick={() => onChange(undefined, undefined)} className="text-[#888] hover:text-white">Clear</button>
        )}
      </div>
    </div>
  );
}

function AddModal({
  onClose, onAddTask, onUpdateTask, onAddProject, onAddClient, projects, clients, people, editingTask, defaultList, defaultAssignee,
}: {
  onClose: () => void;
  onAddTask: (t: Omit<Task, 'id' | 'order'>) => void;
  onUpdateTask?: (id: string, patch: Partial<Omit<Task, 'id' | 'order'>>) => void;
  onAddProject: (p: Omit<Project, 'id'>) => void;
  onAddClient: (c: Omit<Client, 'id'>) => void;
  projects: Project[]; clients: Client[]; people: Person[];
  editingTask?: Task | null;
  defaultList?: ListId;
  defaultAssignee?: string;
}) {
  const isEdit = !!editingTask;
  const initialProject = editingTask?.projectId ? projects.find((p) => p.id === editingTask.projectId) : undefined;
  const [tab, setTab] = useState<'task' | 'project' | 'client'>('task');
  const [title, setTitle] = useState(editingTask?.title ?? '');
  // Default for new tasks is 'work' — 'dashboard' is no longer a visible
  // column in list view, so tasks defaulting there would be invisible.
  const [list, setList] = useState<ListId>(editingTask?.list ?? defaultList ?? 'work');
  const [section, setSection] = useState<SectionId>(editingTask?.section ?? 'today');
  const [isMilestone, setIsMilestone] = useState<boolean>(editingTask?.type === 'scheduled');
  // Prefer the task's explicit clientId; fall back to the client owning its project.
  const [clientId, setClientId] = useState<string>(editingTask?.clientId ?? initialProject?.clientId ?? '');
  const [projectId, setProjectId] = useState<string>(editingTask?.projectId ?? '');
  const [assignees, setAssignees] = useState<string[]>(editingTask?.assignees ?? (defaultAssignee ? [defaultAssignee] : []));
  const [startDate, setStartDate] = useState<string | undefined>(editingTask?.startDate);
  const [deadline, setDeadline] = useState<string | undefined>(editingTask?.deadline);
  const [projectName, setProjectName] = useState('');
  const [projectClient, setProjectClient] = useState<string>('');
  const [clientName, setClientName] = useState('');

  const filteredProjects = useMemo(() => clientId ? projects.filter((p) => p.clientId === clientId) : projects, [projects, clientId]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (tab === 'task' && title.trim()) {
      // If the user only picked one date, treat it as the deadline (the more common case ï¿½
      // single-date picks should not silently land in startDate and disappear).
      const finalStart = (startDate && deadline) ? startDate : undefined;
      const finalDeadline = deadline ?? startDate;
      // If a project is picked, trust its clientId; else store the explicit client choice.
      const pickedProject = projectId ? projects.find((p) => p.id === projectId) : undefined;
      const finalClientId = pickedProject?.clientId ?? (clientId || undefined);
      if (isEdit && editingTask && onUpdateTask) {
        onUpdateTask(editingTask.id, {
          title: title.trim(),
          type: isMilestone ? 'scheduled' : 'todo',
          assignees,
          list,
          section,
          projectId: projectId || undefined,
          clientId: finalClientId,
          startDate: finalStart,
          deadline: finalDeadline,
          ...(isMilestone ? { completed: false } : {}),
        });
      } else {
        onAddTask({
          title: title.trim(),
          type: isMilestone ? 'scheduled' : 'todo',
          assignees,
          completed: false,
          list,
          section,
          projectId: projectId || undefined,
          clientId: finalClientId,
          startDate: finalStart,
          deadline: finalDeadline,
        });
      }
      onClose();
    } else if (tab === 'project' && projectName.trim()) {
      onAddProject({ name: projectName.trim(), clientId: projectClient || undefined });
      onClose();
    } else if (tab === 'client' && clientName.trim()) {
      onAddClient({ name: clientName.trim(), short: '' });
      onClose();
    }
  };

  const toggleAssignee = (short: string) => {
    setAssignees((prev) => prev.includes(short) ? prev.filter((s) => s !== short) : [...prev, short]);
  };

  const tabBtn = (id: typeof tab, label: string) => (
    <button type="button" onClick={() => setTab(id)} className={`px-4 py-2 text-[14px] rounded-md transition-colors ${tab === id ? 'bg-[#7363FF] text-white' : 'text-[#999] hover:text-white'}`}>{label}</button>
  );

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <motion.div initial={{ scale: 0.95, y: 10 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.95, y: 10 }} transition={{ type: 'spring', stiffness: 400, damping: 28 }} onClick={(e) => e.stopPropagation()} className="bg-[#2a2a2a] rounded-2xl border border-[#3a3a3a] w-[520px] p-6 shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <div className="flex gap-1">
            {isEdit ? <div className="px-4 py-2 text-[14px] text-white">Edit Task</div> : <>{tabBtn('task', 'Task')}{tabBtn('project', 'Project')}{tabBtn('client', 'Client')}</>}
          </div>
          <button onClick={onClose} className="text-[#888] hover:text-white p-1"><X size={18} /></button>
        </div>
        <form onSubmit={submit} className="flex flex-col gap-3">
          {tab === 'task' && (
            <>
              <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Task title (required)" className="bg-[#1f1f1f] rounded-md px-3 py-2 text-white text-[14px] outline-none focus:ring-1 focus:ring-[#7363FF]" />
              <div className="flex items-center justify-between bg-[#1f1f1f] rounded-md px-3 py-2">
                <div className="flex flex-col">
                  <span className={`text-[14px] ${isMilestone ? 'text-[#8465ff]' : 'text-white'}`}>Milestone</span>
                  <span className="text-[#666] text-[12px]">No checkbox Â· pinned to top of its column</span>
                </div>
                <MilestoneToggle value={isMilestone} onChange={setIsMilestone} />
              </div>
              <div className="flex gap-2">
                <select value={clientId} onChange={(e) => { setClientId(e.target.value); setProjectId(''); }} className="flex-1 bg-[#1f1f1f] rounded-md px-3 py-2 text-white text-[14px] outline-none">
                  <option value="">No client</option>
                  {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className="flex-1 bg-[#1f1f1f] rounded-md px-3 py-2 text-white text-[14px] outline-none">
                  <option value="">No project</option>
                  {filteredProjects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
              <div className="flex gap-2">
                <select value={list} onChange={(e) => setList(e.target.value as ListId)} className="flex-1 bg-[#1f1f1f] rounded-md px-3 py-2 text-white text-[14px] outline-none">
                  {LISTS.map((l) => <option key={l} value={l}>{LIST_TITLES[l]}</option>)}
                </select>
              </div>
              {/* Section toggle — Today / Tomorrow / Next as inline pills (Inbox stays a less-
                  prominent option since most new tasks land in one of the three time buckets).
                  Active pill uses the brand purple, idle pills are muted. */}
              <div className="flex gap-2">
                {([
                  ['today', 'Today'],
                  ['tomorrow', 'Tomorrow'],
                  ['next', 'Next'],
                  ['inbox', 'Inbox'],
                ] as const).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setSection(key)}
                    className={`flex-1 px-3 py-2 text-[14px] rounded-md transition-colors ${section === key ? 'bg-[#7363FF] text-white' : 'bg-[#1f1f1f] text-[#888] hover:text-white'}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div>
                <div className="text-[#888] text-[12px] mb-1">Assignees</div>
                <div className="flex flex-wrap gap-2">
                  {people.map((p) => {
                    const active = assignees.includes(p.short);
                    return (
                      <button key={p.id} type="button" onClick={() => toggleAssignee(p.short)} className={`px-3 py-1 rounded-full text-[13px] transition-colors ${active ? 'bg-[#7363FF] text-white' : 'bg-[#1f1f1f] text-[#ccc] hover:bg-[#333]'}`}>
                        {p.name} <span className="opacity-70">({p.short})</span>
                      </button>
                    );
                  })}
                </div>
              </div>
              <div>
                <div className="text-[#888] text-[12px] mb-1">Dates (optional â€” start â†’ deadline)</div>
                <DateRangePicker start={startDate} end={deadline} onChange={(s, e) => { setStartDate(s); setDeadline(e); }} />
              </div>
            </>
          )}
          {tab === 'project' && (
            <>
              <input autoFocus value={projectName} onChange={(e) => setProjectName(e.target.value)} placeholder="Project name" className="bg-[#1f1f1f] rounded-md px-3 py-2 text-white text-[14px] outline-none focus:ring-1 focus:ring-[#7363FF]" />
              <select value={projectClient} onChange={(e) => setProjectClient(e.target.value)} className="bg-[#1f1f1f] rounded-md px-3 py-2 text-white text-[14px] outline-none">
                <option value="">No client</option>
                {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </>
          )}
          {tab === 'client' && (
            <input autoFocus value={clientName} onChange={(e) => setClientName(e.target.value)} placeholder="Client name" className="bg-[#1f1f1f] rounded-md px-3 py-2 text-white text-[14px] outline-none focus:ring-1 focus:ring-[#7363FF]" />
          )}
          <div className="flex justify-end gap-2 mt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 rounded-md text-[#999] hover:text-white text-[14px]">Cancel</button>
            <button type="submit" className="px-4 py-2 rounded-md bg-[#7363FF] text-white text-[14px] hover:bg-[#8573ff]">{isEdit ? 'Save' : 'Add'}</button>
          </div>
          <p className="text-[#666] text-[12px] mt-1">Projects referenced: {projects.length} Â· Clients: {clients.length}</p>
        </form>
      </motion.div>
    </motion.div>
  );
}

// Destructive-action confirmation modal — user must type the literal word "TRASH" to enable
// the Confirm button. Used for deleting projects/clients (which would orphan tasks if done by
// accident). The kind label ("project" / "client") and name appear in the warning text so the
// user sees exactly what they're about to delete.
function TrashConfirmModal({
  kind,
  name,
  onConfirm,
  onClose,
}: {
  kind: 'project' | 'client';
  name: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState('');
  const armed = typed.trim().toUpperCase() === 'TRASH';
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.95, y: 10 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.95, y: 10 }}
        transition={{ type: 'spring', stiffness: 400, damping: 28 }}
        onClick={(e) => e.stopPropagation()}
        className="bg-[#2a2a2a] rounded-2xl border border-[#3a3a3a] w-[440px] p-6 shadow-2xl"
      >
        <div className="flex items-center gap-2 mb-3">
          <Trash2 size={16} className="text-[#FF7171]" />
          <p className="text-white text-[14px]">Delete {kind} "{name}"?</p>
        </div>
        <p className="text-[#888] text-[13px] mb-4">
          This is permanent. Tasks under this {kind} will be orphaned. Type <span className="text-white font-bold">TRASH</span> below to confirm.
        </p>
        <input
          autoFocus
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && armed) { onConfirm(); }
            if (e.key === 'Escape') onClose();
          }}
          placeholder="TRASH"
          className="w-full bg-[#1f1f1f] rounded-md px-3 py-2 text-white text-[14px] outline-none focus:ring-1 focus:ring-[#FF7171] mb-4 tracking-wider"
        />
        <div className="flex gap-2 justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-md text-[14px] text-[#888] hover:text-white"
          >
            Cancel
          </button>
          <button
            disabled={!armed}
            onClick={onConfirm}
            className={`px-4 py-2 rounded-md text-[14px] ${armed ? 'bg-[#FF7171] text-white hover:bg-[#ff5555]' : 'bg-[#3a3a3a] text-[#666] cursor-not-allowed'}`}
          >
            Delete
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

function SortableSubtaskRow({
  sub,
  storageKey,
  isAnyDragging,
  newId,
  onToggle,
  onRename,
  onDiscardIfEmpty,
  onAddAfter,
  onDelete,
}: {
  sub: { id: string; title: string; completed: boolean };
  storageKey: string;
  isAnyDragging: boolean;
  newId: string | null;
  onToggle: () => void;
  onRename: (v: string) => void;
  onDiscardIfEmpty: () => void;
  onAddAfter: () => void;
  onDelete: () => void;
}) {
  // dnd-kit sortable on each subtask row. id is namespaced so it can't collide with
  // task / project sortable ids elsewhere in the app, and `data` carries the type +
  // storage key the App's handleDragEnd checks for.
  const sortableId = `subtask:${storageKey}:${sub.id}`;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: sortableId,
    data: { type: 'subtask', key: storageKey, subId: sub.id },
    // Buttery displacement — match the rest of the app's sortables.
    transition: { duration: 350, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
  });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: isAnyDragging ? `transform ${MOTION.base}ms ${MOTION.easeOut}` : 'none',
    opacity: isDragging ? 0.4 : 1,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className="group relative h-[37px] w-full box-border flex flex-row gap-2 items-center px-[31px] hover:bg-white/[0.03] cursor-grab active:cursor-grabbing"
    >
      <div onPointerDown={(e) => e.stopPropagation()}>
        {/* Sub-tasks use the legacy 2-state checkbox (the local Sub type doesn't carry a
            `started` field). Cycling sub-tasks through 3 states is a separate refactor. */}
        <TaskCheckbox completed={sub.completed} onToggle={onToggle} />
      </div>
      <EditableText
        value={sub.title}
        onChange={onRename}
        autoFocus={sub.id === newId}
        onDiscardIfEmpty={onDiscardIfEmpty}
        onEnter={onAddAfter}
        placeholder="New Sub-Task"
        className={`font-['Univers_BQ:55_Regular',sans-serif] text-[14px] whitespace-nowrap ${sub.completed ? 'text-[#474747]' : 'text-white'}`}
      />
      {/* Hover-reveal "+" → spawn a new sub-task immediately after this one. Lives inline
          alongside the row so it sits in tab-order with the title. */}
      <button
        type="button"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); onAddAfter(); }}
        className="p-1 opacity-0 group-hover:opacity-100 text-[#5e5e5e] hover:text-white transition-opacity"
        aria-label="Add sub-task below"
      >
        <Plus size={12} />
      </button>
      <button
        type="button"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
        className="ml-auto -mr-[22px] p-1 opacity-0 group-hover:opacity-100 text-[#5e5e5e] hover:text-white transition-opacity"
        aria-label="Delete sub-task"
      >
        <Trash2 size={14} />
      </button>
    </div>
  );
}

// CachedImage — renders an <img> backed by the IndexedDB cache. On the first view of a given
// URL we kick off a background fetch + cache write, then swap the src to the resulting object
// URL. Subsequent views (within the same session) start with the object URL on the very first
// paint via the synchronous in-memory lookup, so there's no flicker. `decoding="async"` keeps
// large WebP decodes off the main thread, which fixes the scroll-stutter from rendering a
// dozen images at once.
function CachedImage({
  src, alt, className, style, loading,
}: {
  src: string;
  alt?: string;
  className?: string;
  style?: React.CSSProperties;
  loading?: 'lazy' | 'eager';
}) {
  const initial = getCachedImageUrlSync(src) ?? src;
  const [resolved, setResolved] = useState<string>(initial);
  useEffect(() => {
    let cancelled = false;
    setResolved(getCachedImageUrlSync(src) ?? src);
    if (src && src.startsWith('http')) {
      getCachedImageUrl(src).then((u) => {
        if (!cancelled && u !== src) setResolved(u);
      });
    }
    return () => { cancelled = true; };
  }, [src]);
  return (
    <img
      src={resolved}
      alt={alt ?? ''}
      className={className}
      style={style}
      loading={loading ?? 'lazy'}
      decoding="async"
    />
  );
}

function FocusDamViewer({
  images,
  tileView,
  oneUpImageId,
  onOneUpToggle,
  onDelete,
  onToggleFavorite,
}: {
  images: { id: string; dataUrl: string; filename: string; width: number; height: number; favorited?: boolean; ownerKey: string | null }[];
  tileView: 'zoom' | 'sm' | 'md' | 'lg';
  oneUpImageId: string | null;
  onOneUpToggle: (id: string) => void;
  onDelete: (ownerKey: string, id: string) => void;
  onToggleFavorite: (ownerKey: string, id: string) => void;
}) {
  // Track the container's actual width AND height so the zoom-fit math knows the
  // exact box it has to fill. useLayoutEffect measures synchronously BEFORE the
  // browser paints, so the first paint already has correct dimensions — no
  // "starts tiny then resizes" flash on mount or mode change. Dependencies
  // include tileView + oneUpImageId because the ref attaches to a different
  // div in each branch (each return statement renders its own container div).
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [dims, setDims] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    const update = () => setDims({ width: el.clientWidth, height: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [tileView, oneUpImageId]);
  // Empty-state rendering moved to the parent (the column 3 gallery slot)
  // so the same sheet can host the No Images Yet label + the drop zones
  // beneath it. When this component is rendered with zero images, just emit
  // an empty fragment — the parent decides what to show in its place.
  if (images.length === 0) {
    return null;
  }
  // 1-up inline view — when an image is single-clicked, it expands to fill the column. Click
  // again (or hit Esc, handled by App's keydown effect) to collapse back to the active grid /
  // tile view. Stays inline; no fullscreen lightbox modal.
  if (oneUpImageId) {
    const img = images.find((i) => i.id === oneUpImageId);
    if (img) {
      return (
        <div ref={containerRef} className="w-full">
          <div className="relative group inline-block cursor-zoom-out" onClick={() => onOneUpToggle(img.id)}>
            <CachedImage
              src={resolveImageSrc(img)}
              alt={img.filename}
              className="block max-w-full max-h-[80vh] w-auto h-auto"
              loading="eager"
            />
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); if (img.ownerKey) onToggleFavorite(img.ownerKey, img.id); }}
              className={`absolute top-1 left-1 p-1 bg-black/40 hover:bg-black/70 opacity-0 group-hover:opacity-100 transition-opacity ${img.favorited ? 'text-[#FF7171]' : 'text-white'}`}
              aria-label={img.favorited ? 'Unfavorite image' : 'Favorite image'}
            >
              <Heart size={12} fill={img.favorited ? 'currentColor' : 'none'} />
            </button>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); if (img.ownerKey) onDelete(img.ownerKey, img.id); }}
              className="absolute top-1 right-1 p-1 bg-black/40 opacity-0 group-hover:opacity-100 text-white hover:bg-black/70 transition-opacity"
              aria-label="Delete image"
            >
              <Trash2 size={12} />
            </button>
          </div>
        </div>
      );
    }
  }
  const ZOOM_GAP = 4;
  // Tile (justified-gallery / mosaic) layout. Each tile gets flex-grow + flex-basis tied to
  // its aspect ratio so rows are uniform-height and aspect-preserving.
  if (tileView === 'zoom') {
    // Fit-all mode. Find the LARGEST rowH such that the actual flex-wrap
    // layout fits inside the container's box (w × h). Closed-form formulas
    // (rowH = sqrt(w·h/ΣAR)) ignore inter-row gaps AND the discrete jumps
    // that happen when an image wraps to a new row, so they over- or
    // under-shoot. A simple iterative refit oscillates between two valid
    // row counts (e.g. "2 rows of tall imgs" vs "3 rows of short imgs"),
    // landing on whichever side the iteration ended on.
    //
    // Binary search is bulletproof: total-height-as-a-function-of-rowH is
    // (mostly) monotonic increasing — bigger images → wider items → fewer
    // per row → more rows → more total height. We search for the max rowH
    // that still satisfies (rows · rowH + (rows - 1) · gap) ≤ h.
    const w = dims.width || 1;
    const h = dims.height || 1;
    // simulateRows: how many rows does a given rowH produce, given flex-wrap
    // semantics? An item starts a new row when adding it (plus the inter-
    // item gap) would push the row past container width.
    const simulateRows = (rowH: number): number => {
      let rows = 1;
      let rowW = 0;
      for (const img of images) {
        const ar = (img.width || 1) / (img.height || 1);
        const imgW = ar * rowH;
        if (rowW === 0) rowW = imgW;
        else if (rowW + ZOOM_GAP + imgW <= w) rowW += ZOOM_GAP + imgW;
        else { rows++; rowW = imgW; }
      }
      return rows;
    };
    // Binary search for the maximum rowH that fits. 30 iterations on a
    // [20, h] range gives sub-pixel precision (h / 2^30 « 1px).
    let lo = 20;
    let hi = h;
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2;
      const rows = simulateRows(mid);
      const totalH = rows * mid + Math.max(0, rows - 1) * ZOOM_GAP;
      if (totalH <= h) lo = mid;
      else hi = mid;
    }
    const rowH = Math.max(20, lo);
    return (
      <div
        ref={containerRef}
        className="flex flex-row flex-wrap content-start h-full overflow-hidden"
        style={{ gap: `${ZOOM_GAP}px` }}
      >
        {images.map((img) => {
          const ar = (img.width || 1) / (img.height || 1);
          return (
            <Fragment key={img.id}>
              <div
                onClick={() => onOneUpToggle(img.id)}
                className="relative group bg-[#1f1f1f] overflow-hidden cursor-zoom-in"
                style={{ height: rowH, flexGrow: ar, flexBasis: ar * rowH, minWidth: Math.min(40, ar * rowH) }}
              >
                <CachedImage
                  src={resolveImageSrc(img)}
                  alt={img.filename}
                  className="block w-full h-full object-cover"
                />
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); if (img.ownerKey) onToggleFavorite(img.ownerKey, img.id); }}
                  className={`absolute top-1 left-1 p-1 bg-black/40 transition-opacity ${img.favorited ? 'opacity-100 text-[#FF7171]' : 'opacity-0 group-hover:opacity-100 text-white hover:bg-black/70'}`}
                  aria-label={img.favorited ? 'Unfavorite image' : 'Favorite image'}
                >
                  <Heart size={12} fill={img.favorited ? 'currentColor' : 'none'} />
                </button>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); if (img.ownerKey) onDelete(img.ownerKey, img.id); }}
                  className="absolute top-1 right-1 p-1 bg-black/40 opacity-0 group-hover:opacity-100 text-white hover:bg-black/70 transition-opacity"
                  aria-label="Delete image"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </Fragment>
          );
        })}
        {Array.from({ length: 4 }).map((_, i) => (
          <span key={`phantom-${i}`} className="grow-[1000]" aria-hidden />
        ))}
      </div>
    );
  }
  // Large = one image per row, full column width, with a viewport-height cap so super-tall
  // skinny portraits don't blow up the row. Each image scales to fill the column width up
  // to its natural size, and clamps at 70vh in height — wider images letterbox sideways.
  if (tileView === 'lg') {
    return (
      <div ref={containerRef} className="flex flex-col gap-1 pr-1">
        {images.map((img) => (
          <Fragment key={img.id}>
            <div className="relative group flex flex-row justify-start" onClick={() => onOneUpToggle(img.id)}>
              {/* Inner wrapper sits at image-rendered-size so the heart / trash buttons hug
                  the actual image (not the centering container's full width). */}
              <div className="relative inline-block cursor-zoom-in">
                <CachedImage
                  src={resolveImageSrc(img)}
                  alt={img.filename}
                  className="block max-w-full max-h-[70vh] w-auto h-auto"
                />
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); if (img.ownerKey) onToggleFavorite(img.ownerKey, img.id); }}
                  className={`absolute top-1 left-1 p-1 bg-black/40 hover:bg-black/70 opacity-0 group-hover:opacity-100 transition-opacity ${img.favorited ? 'text-[#FF7171]' : 'text-white'}`}
                  aria-label={img.favorited ? 'Unfavorite image' : 'Favorite image'}
                >
                  <Heart size={12} fill={img.favorited ? 'currentColor' : 'none'} />
                </button>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); if (img.ownerKey) onDelete(img.ownerKey, img.id); }}
                  className="absolute top-1 right-1 p-1 bg-black/40 opacity-0 group-hover:opacity-100 text-white hover:bg-black/70 transition-opacity"
                  aria-label="Delete image"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
          </Fragment>
        ))}
      </div>
    );
  }
  // Small / Medium — uniform-height rows, justified-gallery widths.
  // No max-height / overflow here: the parent CustomScroll wrapper owns the
  // scroll. Container is `h-full` so the wrapping rows can flow downward and
  // the CustomScroll's pill takes over once they overflow.
  const rowH = tileView === 'sm' ? 120 : 240;
  return (
    <div ref={containerRef} className="flex flex-row flex-wrap gap-1 content-start">
      {images.map((img) => {
        const ar = (img.width || 1) / (img.height || 1);
        return (
          <Fragment key={img.id}>
            <div
              onClick={() => onOneUpToggle(img.id)}
              className="relative group bg-[#1f1f1f] overflow-hidden cursor-zoom-in"
              style={{ height: rowH, flexGrow: ar, flexBasis: ar * rowH, minWidth: Math.min(60, ar * rowH) }}
            >
              <CachedImage
                src={resolveImageSrc(img)}
                alt={img.filename}
                className="block w-full h-full object-cover"
              />
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); if (img.ownerKey) onToggleFavorite(img.ownerKey, img.id); }}
                className={`absolute top-1 left-1 p-1 bg-black/40 hover:bg-black/70 opacity-0 group-hover:opacity-100 transition-opacity ${img.favorited ? 'text-[#FF7171]' : 'text-white'}`}
                aria-label={img.favorited ? 'Unfavorite image' : 'Favorite image'}
              >
                <Heart size={12} fill={img.favorited ? 'currentColor' : 'none'} />
              </button>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); if (img.ownerKey) onDelete(img.ownerKey, img.id); }}
                className="absolute top-1 right-1 p-1 bg-black/40 opacity-0 group-hover:opacity-100 text-white hover:bg-black/70 transition-opacity"
                aria-label="Delete image"
              >
                <Trash2 size={12} />
              </button>
            </div>
          </Fragment>
        );
      })}
      {Array.from({ length: 4 }).map((_, i) => (
        <span key={`phantom-${i}`} className="grow-[1000]" aria-hidden />
      ))}
    </div>
  );
}

// ─── Focus DAM (Reference Gallery) helpers ─────────────────────────────────
// Image data shape used across the gallery. Same as the storage shape but with
// `ownerKey` (the bucket id) appended so the gallery doesn't need to look up
// which bucket each image came from on every render.
type FocusDamImage = { id: string; url?: string; dataUrl?: string; filename: string; width: number; height: number; favorited?: boolean; folderId?: string; ownerKey: string };
type FocusDamFolder = {
  id: string;
  name: string;
  // Optional LR provenance — if set, the folder mirrors a Lightroom album
  // and a Re-sync affordance is shown on hover. The detail of which catalog
  // / share the folder came from is held in the storage record; the gallery
  // only needs to know whether to show the affordance.
  lrSource?: { kind: 'publicShare'; shareId: string; albumId: string } | { kind: 'ownAlbum'; catalogId: string; albumId: string };
};
type FocusDamBucket = { key: string; label: string; images: FocusDamImage[]; folders: FocusDamFolder[] };

// FocusDamTile: one image cell. Sortable so reorders inside the same context
// animate (the other tiles slide to make room for the dragged one), AND the
// drag is picked up by a DragOverlay rendered up at the DndContext level so
// the drag preview locks 1:1 to the cursor instead of just fading the source.
// PointerSensor's distance:8 activation keeps stationary clicks as clicks.
// NOT memoized — a previous attempt wrapped this in React.memo with a
// field-level comparator to avoid re-rendering every tile on every selection
// click, but the interaction with useSortable's internal context-driven
// re-renders caused the selection outline to lag one click behind (ctrl-
// click A → outline on A appears only after ctrl-click B). Stable callbacks
// from the App level (handleDamImageClick) still cut most of the per-click
// work; the remaining cost is acceptable for the correctness benefit.
function FocusDamTile({
  img,
  tileView,
  ownerKey,
  isSelected,
  rowH,
  onImageClick,
  onDelete,
  onToggleFavorite,
}: {
  img: FocusDamImage;
  tileView: 'zoom' | 'sm' | 'md' | 'lg';
  ownerKey: string;
  isSelected: boolean;
  rowH: number;
  onImageClick: (id: string, e: React.MouseEvent) => void;
  onDelete: (ownerKey: string, id: string) => void;
  onToggleFavorite: (ownerKey: string, id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: `dam-image:${img.id}`,
    data: { type: 'damImage', imageId: img.id, ownerKey, folderId: img.folderId ?? null, img },
    // Buttery displacement: 350ms ease-out-expo. Same curve as the folder
    // rows so reorder + cross-list drag share one motion vocabulary.
    transition: { duration: 350, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
  });
  // Hide the source while dragging — DragOverlay renders the floating preview.
  // Without `visibility: hidden` the source would also render at the cursor,
  // doubling the image. opacity:0 alone leaves the layout but blocks pointer
  // events on the now-empty cell, which makes drop-target detection flaky.
  const dragVisibility: React.CSSProperties = isDragging ? { opacity: 0 } : {};
  if (tileView === 'lg') {
    const lgStyle: React.CSSProperties = { transform: CSS.Transform.toString(transform), transition, ...dragVisibility };
    return (
      <div
        ref={setNodeRef}
        className="relative group flex flex-row justify-start"
        onClick={(e) => onImageClick(img.id, e)}
        {...attributes}
        {...listeners}
        style={lgStyle}
      >
        {/* w-full + h-auto + object-contain: small images scale UP to the
            column width (intentionally going past 1:1, even though that
            sacrifices DPI sharpness). max-h-[70vh] caps super-tall portraits;
            object-contain keeps aspect when the cap kicks in (no stretch). */}
        <div className={`relative block w-full cursor-zoom-in ${isSelected ? 'ring-2 ring-[#7363FF] ring-offset-0' : ''}`}>
          <CachedImage src={resolveImageSrc(img)} alt={img.filename} className="block w-full h-auto max-h-[70vh] object-contain" />
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onToggleFavorite(ownerKey, img.id); }}
            className={`absolute top-1 left-1 p-1 bg-black/40 hover:bg-black/70 opacity-0 group-hover:opacity-100 transition-opacity ${img.favorited ? 'text-[#FF7171]' : 'text-white'}`}
            aria-label={img.favorited ? 'Unfavorite image' : 'Favorite image'}
          >
            <Heart size={12} fill={img.favorited ? 'currentColor' : 'none'} />
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onDelete(ownerKey, img.id); }}
            className="absolute top-1 right-1 p-1 bg-black/40 opacity-0 group-hover:opacity-100 text-white hover:bg-black/70 transition-opacity"
            aria-label="Delete image"
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>
    );
  }
  const ar = (img.width || 1) / (img.height || 1);
  const tileStyle: React.CSSProperties = {
    height: rowH,
    flexGrow: ar,
    flexBasis: ar * rowH,
    minWidth: Math.min(60, ar * rowH),
    transform: CSS.Transform.toString(transform),
    transition,
    ...dragVisibility,
  };
  return (
    <div
      ref={setNodeRef}
      onClick={(e) => onImageClick(img.id, e)}
      {...attributes}
      {...listeners}
      className={`relative group bg-[#1f1f1f] overflow-hidden cursor-zoom-in ${isSelected ? 'outline outline-2 outline-[#7363FF]' : ''}`}
      style={tileStyle}
    >
      <CachedImage src={resolveImageSrc(img)} alt={img.filename} className="block w-full h-full object-cover" />
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onToggleFavorite(ownerKey, img.id); }}
        className={`absolute top-1 left-1 p-1 bg-black/40 hover:bg-black/70 opacity-0 group-hover:opacity-100 transition-opacity ${img.favorited ? 'opacity-100 text-[#FF7171]' : 'text-white'}`}
        aria-label={img.favorited ? 'Unfavorite image' : 'Favorite image'}
      >
        <Heart size={12} fill={img.favorited ? 'currentColor' : 'none'} />
      </button>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onDelete(ownerKey, img.id); }}
        className="absolute top-1 right-1 p-1 bg-black/40 opacity-0 group-hover:opacity-100 text-white hover:bg-black/70 transition-opacity"
        aria-label="Delete image"
      >
        <Trash2 size={12} />
      </button>
    </div>
  );
}

// FocusDamGroup: renders ONE flat block of images at the requested tile size
// (sm / md / lg / zoom). All tiles share a single SortableContext so dnd-kit
// can animate the displacement when one tile is dragged among them. Inside the
// context we split into two flex rows — favorited images first, then the rest
// — so favorited images get a guaranteed row break between themselves and the
// unfavorited group. The split is visual only; ordering / dragging remains
// across the whole array.
function FocusDamGroup({
  images,
  tileView,
  ownerKey,
  selectedImageIds,
  onImageClick,
  onDelete,
  onToggleFavorite,
  rowHOverride,
}: {
  images: FocusDamImage[];
  tileView: 'zoom' | 'sm' | 'md' | 'lg';
  ownerKey: string;
  selectedImageIds: Set<string>;
  onImageClick: (id: string, e: React.MouseEvent) => void;
  onDelete: (ownerKey: string, id: string) => void;
  onToggleFavorite: (ownerKey: string, id: string) => void;
  // Optional override for the row height. Used by Zoom All so the parent can
  // binary-search a "fit-everything-in-the-box" row height that's the same
  // across every group in the gallery.
  rowHOverride?: number;
}) {
  if (images.length === 0) return null;
  const sortableIds = images.map((img) => `dam-image:${img.id}`);
  if (tileView === 'lg') {
    return (
      <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
        <div className="flex flex-col gap-1 pr-1">
          {images.map((img) => (
            <FocusDamTile
              key={img.id}
              img={img}
              tileView="lg"
              ownerKey={ownerKey}
              isSelected={selectedImageIds.has(img.id)}
              rowH={0}
              onImageClick={onImageClick}
              onDelete={onDelete}
              onToggleFavorite={onToggleFavorite}
            />
          ))}
        </div>
      </SortableContext>
    );
  }
  // Row-height tier. Zoom All takes its row height from rowHOverride (the
  // parent runs a binary search to fit everything in the viewport, with 40px
  // as the floor); S / M / Zoom-fallback are static. L is its own branch
  // above (one image per row, viewport-capped).
  const rowH = rowHOverride ?? (tileView === 'zoom' ? 40 : tileView === 'sm' ? 120 : tileView === 'md' ? 240 : 360);
  // Split: favorited images go in the first row block, the rest in the
  // second. The favoriting logic (toggleFocusImageFavorite) already keeps
  // favorited images at the front of the bucket array, so this split
  // preserves array order. The two rows are stacked in a flex-col with a
  // small gap matching the inter-image gap-1, so the favorites end their
  // visual row even when there's spare width — what the user asked for.
  const favorited = images.filter((img) => img.favorited);
  const rest = images.filter((img) => !img.favorited);
  const renderRow = (items: FocusDamImage[], rowKey: string) => (
    <div className="flex flex-row flex-wrap gap-1 content-start">
      {items.map((img) => (
        <FocusDamTile
          key={img.id}
          img={img}
          tileView={tileView}
          ownerKey={ownerKey}
          isSelected={selectedImageIds.has(img.id)}
          rowH={rowH}
          onImageClick={onImageClick}
          onDelete={onDelete}
          onToggleFavorite={onToggleFavorite}
        />
      ))}
      {Array.from({ length: 4 }).map((_, i) => (
        <span key={`phantom-${rowKey}-${i}`} className="grow-[1000]" aria-hidden />
      ))}
    </div>
  );
  return (
    <SortableContext items={sortableIds} strategy={rectSortingStrategy}>
      <div className="flex flex-col gap-1">
        {favorited.length > 0 && renderRow(favorited, 'fav')}
        {rest.length > 0 && renderRow(rest, 'rest')}
      </div>
    </SortableContext>
  );
}

// Folder row: docks the folder icon + name on the left and creates a "carriage
// return" — a full-width row that breaks the flex flow above and below it. In
// rename mode, the name renders as an inline input that auto-focuses, commits
// on Enter / blur, and cancels on Esc. The trash affordance only appears on
// hover so the row stays visually quiet at rest. The whole row is rendered as
// a sortable item via dnd-kit so the user can drag-reorder folders within
// their bucket using the same underpinnings as the list-view sub-task reorder.
function FocusDamFolderRow({
  folder,
  bucketKey,
  isEditing,
  onStartEdit,
  onCommitRename,
  onCancelRename,
  onDelete,
  onResync,
}: {
  folder: FocusDamFolder;
  bucketKey: string;
  isEditing: boolean;
  onStartEdit: () => void;
  onCommitRename: (name: string) => void;
  onCancelRename: () => void;
  onDelete: () => void;
  // Only set for LR-sourced folders. Renders the manual "Re-sync" text
  // affordance on hover; click triggers a foreground sync that mirrors
  // the auto-sync background path.
  onResync?: () => void;
}) {
  const sortableId = `dam-folder:${bucketKey}:${folder.id}`;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: sortableId,
    data: { type: 'damFolder', bucketKey, folderId: folder.id },
    // Buttery transition — longer duration + ease-out-expo so the displaced
    // peer folders glide rather than snap. Same easing on FocusDamTile so the
    // gallery moves with one rhythm.
    transition: { duration: 350, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
  });
  const style: React.CSSProperties = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 };
  return (
    <div
      ref={setNodeRef}
      style={style}
      // The whole row is the drag handle now (not just the tiny FolderTree
      // icon). PointerSensor's distance:8 keeps stationary clicks as clicks,
      // so clicking the folder name still triggers rename and clicking the
      // trash still deletes — drag only activates after 8px of movement.
      // pt-1 + pb-[5px] gives a tight but breathable row; the visual gap
      // between this row and the images below comes from the gap-1 in the
      // folder-block flex-col plus a small extra cushion (see usage site).
      {...attributes}
      {...listeners}
      className="group flex flex-row items-center gap-2 pt-1 pb-[5px] select-none"
    >
      {/* Drag-affordance icon — hover-revealed so the row reads quiet at
          rest. No drag listeners on it; the parent row is the handle. */}
      <div
        className="opacity-0 group-hover:opacity-100 text-[#a8a8a8] transition-opacity"
        aria-hidden
      >
        <FolderTree size={12} />
      </div>
      <Folder size={14} className="text-[#a8a8a8] shrink-0" />
      {isEditing ? (
        <input
          type="text"
          autoFocus
          defaultValue={folder.name}
          onBlur={(e) => onCommitRename(e.target.value.trim())}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); onCommitRename((e.target as HTMLInputElement).value.trim()); }
            else if (e.key === 'Escape') { e.preventDefault(); onCancelRename(); }
          }}
          // Folder-name input matches the folder name's resting tone (grey),
          // not white — the brand-purple underline is plenty of "I'm being
          // edited" signal without needing the text colour to swap.
          className="bg-transparent text-[#a8a8a8] outline-none border-b border-[#7363FF] flex-1 min-w-0"
          placeholder="Folder name…"
        />
      ) : (
        <span
          // Folder names render in the same grey as the section header and
          // the icons — the user wants the whole "this is structure, not
          // content" row to read as a single muted band.
          className="text-[#a8a8a8] cursor-text flex-1 min-w-0 truncate"
          onClick={onStartEdit}
        >
          {folder.name || <span className="text-[#656464]">Untitled folder</span>}
        </span>
      )}
      {onResync && (
        // Manual Re-sync — text affordance, hover-revealed. Triggers a
        // foreground sync that pulls any new LR album assets, skipping
        // duplicates (already-imported lrAssetIds) and respecting the
        // folder's lrDeletedAssetIds. Sits BEFORE the trash so the
        // destructive action is the rightmost thing in the row.
        <button
          type="button"
          onClick={onResync}
          className="opacity-0 group-hover:opacity-100 text-[#656464] hover:text-white transition-opacity text-[12px]"
          aria-label="Re-sync from Lightroom"
        >
          Re-sync
        </button>
      )}
      <button
        type="button"
        onClick={onDelete}
        className="opacity-0 group-hover:opacity-100 text-[#5e5e5e] hover:text-[#FF7171] transition-opacity"
        aria-label="Delete folder"
      >
        <Trash2 size={12} />
      </button>
    </div>
  );
}

// FocusDamFolderDropTarget: the carriage-return row + the empty space directly
// below a folder header double as a drop target so a multi-selection of images
// can be dragged in. dnd-kit's useDroppable lights the row when isOver, giving
// the user the same "this is where it lands" affordance as the project-view
// drop targets above.
function FocusDamFolderDropTarget({ bucketKey, folderId, children }: { bucketKey: string; folderId: string | null; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({
    id: `dam-folder-drop:${bucketKey}:${folderId ?? 'root'}`,
    data: { type: 'damFolderDrop', bucketKey, folderId },
  });
  return (
    <div ref={setNodeRef} className={`transition-colors ${isOver ? 'bg-white/[0.04] rounded-sm' : ''}`}>
      {children}
    </div>
  );
}

// Project-block drop target for project view. Wraps the header + task list so dragging a
// task onto either lands the task as a child of this project. Inline highlight on hover lets
// the user see the drop target before releasing. The actual reparent happens in handleDragEnd
// via the data.type === 'proj2Project' branch.
// Drag handle on a Projects-view project header (the folder icon). Dragging the project into
// ANOTHER category column re-pins it there — project.list + every task moves (the existing
// type:'project' drop branch handles projList / project / clientHeader targets).
function Proj2ProjectDragHandle({ project, listId }: { project: Project; listId: ListId }) {
  const { attributes, listeners, setNodeRef } = useDraggable({
    id: `proj2drag:${listId}:${project.id}`,
    data: { type: 'project', project, listId },
  });
  return (
    <span ref={setNodeRef} {...attributes} {...listeners} className="cursor-grab active:cursor-grabbing -m-1 p-1 flex items-center shrink-0" title="Drag to another column to change category">
      <Folder size={12} className="text-[#656464]" />
    </span>
  );
}

// Whole-column droppable for the Projects view — dropping a PROJECT anywhere in a column
// (not on a specific row) recategorizes it to that column's list. Same data type the list
// view's ProjectListColumn uses, so the existing drop branches (project + task) just work.
function Proj2ColumnDroppable({ listId, children }: { listId: ListId; children: React.ReactNode }) {
  const { setNodeRef } = useDroppable({ id: `projlist2:${listId}`, data: { type: 'projList', listId } });
  return (
    <div ref={setNodeRef} className="flex-1 min-w-[280px] flex flex-col min-h-0 overflow-hidden">
      {children}
    </div>
  );
}

function Proj2ProjectDropZone({ projectId, listId, children }: { projectId: string; listId: ListId; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({
    id: `proj2-project:${listId}:${projectId}`,
    data: { type: 'proj2Project', projectId, listId },
  });
  return (
    <div ref={setNodeRef} className={isOver ? 'bg-white/[0.04] rounded-md transition-colors' : 'transition-colors'}>
      {children}
    </div>
  );
}

function FocusDropZone({ label, sublabel, onDropFiles }: { label: string; sublabel?: string; onDropFiles?: (files: FileList) => void }) {
  // Native HTML5 drag-and-drop for image files. We track `over` so the border
  // brightens while a drag hovers. preventDefault on dragOver is the magic that
  // lets the drop event fire — without it the browser navigates to the file.
  // onDropFiles is optional so a "WIP" zone (visual placeholder, no behavior
  // wired yet) can render as a non-functional drop target.
  const [over, setOver] = useState(false);
  const interactive = !!onDropFiles;
  return (
    <label
      onDragOver={interactive ? (e) => { e.preventDefault(); if (!over) setOver(true); } : undefined}
      onDragEnter={interactive ? (e) => { e.preventDefault(); setOver(true); } : undefined}
      onDragLeave={interactive ? () => setOver(false) : undefined}
      onDrop={interactive ? (e) => {
        e.preventDefault();
        setOver(false);
        if (e.dataTransfer.files?.length) onDropFiles!(e.dataTransfer.files);
      } : undefined}
      // 2px dashed grey border, no background fill (the parent sheet's tint
      // shows through). Hover lifts to the same dim-white (#a8a8a8) used by
      // Next-section task text — softer than full white. Drag-over commits
      // to full white as a "yes, drop here" signal.
      className={`flex-1 flex flex-col items-center justify-center min-h-[80px] border-2 border-dashed transition-colors ${interactive ? 'cursor-pointer' : 'cursor-default'} ${over ? 'border-white' : 'border-[#656464] hover:border-[#a8a8a8]'}`}
    >
      {interactive && (
        <input
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => { if (e.target.files?.length) onDropFiles!(e.target.files); e.currentTarget.value = ''; }}
        />
      )}
      <p className="font-['Univers_BQ:55_Regular',sans-serif] text-[13px] text-[#656464]">{label}</p>
      {sublabel && <p className="font-['Univers_BQ:55_Regular',sans-serif] text-[11px] text-[#656464]">{sublabel}</p>}
    </label>
  );
}

function ResourceDeleteModal({
  resource,
  taskCount,
  otherResources,
  onConfirm,
  onClose,
}: {
  resource: { id: string; name: string; short: string };
  taskCount: number;
  otherResources: { id: string; name: string; short: string }[];
  onConfirm: (reassignToShort: string | null) => void;
  onClose: () => void;
}) {
  // Two-step flow: pick reassignment target (or skip), then type DELETE to arm the red button.
  // Default behavior is "no reassignment" — selecting a target is opt-in.
  const [reassignTo, setReassignTo] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const armed = typed.trim().toUpperCase() === 'DELETE';
  const reassignTarget = reassignTo ? otherResources.find((r) => r.short === reassignTo) : null;
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.95, y: 10 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.95, y: 10 }}
        transition={{ type: 'spring', stiffness: 400, damping: 28 }}
        onClick={(e) => e.stopPropagation()}
        className="bg-[#2a2a2a] rounded-2xl border border-[#3a3a3a] w-[480px] p-6 shadow-2xl"
      >
        <div className="flex items-center gap-2 mb-3">
          <Trash2 size={16} className="text-[#FF7171]" />
          <p className="text-white text-[14px]">Delete resource "{resource.name}"?</p>
        </div>
        <p className="text-[#888] text-[13px] mb-4">
          {taskCount > 0
            ? <>{resource.name} is assigned to <span className="text-white">{taskCount}</span> {taskCount === 1 ? 'task' : 'tasks'}. Reassign them to another resource, or leave them unassigned.</>
            : <>{resource.name} isn't assigned to any tasks.</>}
        </p>
        {taskCount > 0 && otherResources.length > 0 && (
          <div className="mb-4">
            <p className="text-[#888] text-[12px] mb-2 uppercase tracking-wider">Reassign tasks to</p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setReassignTo(null)}
                className={`px-3 py-1.5 rounded-md text-[13px] transition-colors ${reassignTo === null ? 'bg-[#3a3a3a] text-white ring-1 ring-[#7363FF]' : 'bg-[#1f1f1f] text-[#888] hover:text-white'}`}
              >
                Leave unassigned
              </button>
              {otherResources.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => setReassignTo(r.short)}
                  className={`px-3 py-1.5 rounded-md text-[13px] transition-colors ${reassignTo === r.short ? 'bg-[#3a3a3a] text-white ring-1 ring-[#7363FF]' : 'bg-[#1f1f1f] text-[#888] hover:text-white'}`}
                >
                  {r.name || r.short}{r.short ? <span className="text-[#666] ml-1">({r.short})</span> : null}
                </button>
              ))}
            </div>
          </div>
        )}
        <p className="text-[#888] text-[13px] mb-2">
          Type <span className="text-white font-bold">DELETE</span> to confirm.
        </p>
        <input
          autoFocus
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && armed) onConfirm(reassignTo);
            if (e.key === 'Escape') onClose();
          }}
          placeholder="DELETE"
          className="w-full bg-[#1f1f1f] rounded-md px-3 py-2 text-white text-[14px] outline-none focus:ring-1 focus:ring-[#FF7171] mb-4 tracking-wider"
        />
        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="px-4 py-2 rounded-md text-[14px] text-[#888] hover:text-white">Cancel</button>
          <button
            disabled={!armed}
            onClick={() => onConfirm(reassignTo)}
            className={`px-4 py-2 rounded-md text-[14px] ${armed ? 'bg-[#FF7171] text-white hover:bg-[#ff5555]' : 'bg-[#3a3a3a] text-[#666] cursor-not-allowed'}`}
          >
            {reassignTarget ? `Reassign & Delete` : 'Delete'}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

function EditableText({ value, onChange, className, autoFocus = false, placeholder, onEditingChange, onDiscardIfEmpty, onEnter }: { value: string; onChange: (v: string) => void; className?: string; autoFocus?: boolean; placeholder?: string; onEditingChange?: (editing: boolean) => void; onDiscardIfEmpty?: () => void; onEnter?: () => void }) {
  const [editing, setEditingState] = useState(autoFocus);
  const setEditing = (v: boolean) => { setEditingState(v); onEditingChange?.(v); };
  useEffect(() => { if (autoFocus) onEditingChange?.(true); }, []);
  const ref = useRef<HTMLSpanElement>(null);
  // Focus whenever editing turns on — not just on autoFocus mount. Without this, clicking a
  // title flipped it to contentEditable but never placed a caret, so it looked "uneditable"
  // (you had to click a second time). Now one click puts you straight into the text.
  useEffect(() => {
    if (editing && ref.current && document.activeElement !== ref.current) {
      ref.current.focus();
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(ref.current);
      range.collapse(false);
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
  }, [editing]);
  return (
    <span
      ref={ref}
      contentEditable={editing}
      suppressContentEditableWarning
      data-placeholder={placeholder || ''}
      // While editing, swallow pointerdown AND mousedown so a click/drag inside the text
      // places a caret or selects text instead of starting a card drag. The card drag runs on
      // MouseSensor (mousedown), so stopping only pointerdown wasn't enough — a drag-to-select
      // still grabbed the card. Stopping both keeps selection inside the field.
      onPointerDown={(e) => { if (editing) e.stopPropagation(); }}
      onMouseDown={(e) => { if (editing) e.stopPropagation(); }}
      onClick={() => setEditing(true)}
      onBlur={(e) => {
        const next = (e.currentTarget.textContent || '').trim();
        if (next && next !== value) onChange(next);
        else if (!next && !value && onDiscardIfEmpty) onDiscardIfEmpty();
        else if (!next && value) e.currentTarget.textContent = value;
        setEditing(false);
      }}
      onKeyDown={(e) => {
        // Stop ALL keystrokes from bubbling to row drag listeners while editing — otherwise
        // dnd-kit's KeyboardSensor sees Space/Arrows as "start drag" commands.
        e.stopPropagation();
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          (e.currentTarget as HTMLSpanElement).blur();
          // Optional onEnter callback (e.g. spawn a sibling task).
          if (onEnter) onEnter();
        }
        if (e.key === 'Escape') { e.preventDefault(); (e.currentTarget as HTMLSpanElement).textContent = value; setEditing(false); }
      }}
      className={`outline-none cursor-text ${className || ''}`}
      style={value ? undefined : { minWidth: '1px' }}
    >{value || (placeholder && !editing ? <span className="text-[#383838]">{placeholder}</span> : null)}</span>
  );
}

function SettingsRow({ children }: { children: React.ReactNode }) {
  return <div className="group h-[37px] w-full box-border flex flex-row gap-2 items-center px-[31px]">{children}</div>;
}

function AddPlus({ onClick }: { onClick: () => void }) {
  // data-add-plus lets the StickyOverlay find + click this button for the header that's
  // currently pinned at the top (whose inline + is hidden behind the overlay).
  return (
    <button data-add-plus onClick={onClick} className="opacity-0 group-hover:opacity-100 text-[#656464] hover:text-white transition-opacity"><Plus size={14} /></button>
  );
}

function TrashBtn({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} className="opacity-0 group-hover:opacity-100 text-[#656464] hover:text-white"><Trash2 size={14} /></button>
  );
}

function ShortInBrackets({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const cls = "font-['Univers_BQ:55_Regular',sans-serif] leading-[normal] not-italic text-[14px] whitespace-nowrap text-white";
  return (
    <span className="inline-flex items-baseline">
      <span className={cls}>(</span>
      <EditableText value={value} onChange={onChange} className={cls} />
      <span className={cls}>)</span>
    </span>
  );
}

function ClientRow({ client, autoFocus, bodyFont, onRenameName, onRenameShort, onDelete, currentUserShort }: { client: Client; autoFocus: boolean; bodyFont: string; onRenameName: (v: string) => void; onRenameShort: (v: string) => void; onDelete: () => void; currentUserShort?: string }) {
  const [editingName, setEditingName] = useState(autoFocus);
  const isPersonal = client.id === PERSONAL_CLIENT_ID;
  // Drop target: dragging a project onto this row reassigns the project to this client.
  const { setNodeRef, isOver } = useDroppable({ id: `client:${client.id}`, data: { type: 'clientHeader', clientId: client.id } });
  return (
    <motion.div
      ref={setNodeRef}
      className={`relative group h-[37px] w-full box-border flex flex-row gap-2 items-center px-[31px] overflow-hidden ${isOver ? 'bg-white/[0.06] ring-1 ring-[#7363FF]/40' : ''}`}
      whileHover={{ backgroundColor: "rgba(255, 255, 255, 0.03)", transition: { duration: 0.15 } }}
    >
      {isPersonal && <AssigneeBadge letter={currentUserShort || '?'} tone="todo" hollow />}
      <span className="inline-flex items-baseline">
        {isPersonal ? (
          <span className={`${bodyFont} text-white`}>Personal</span>
        ) : (
          <EditableText value={client.name} onChange={onRenameName} className={`${bodyFont} text-white`} autoFocus={autoFocus} placeholder="New Client" onEditingChange={setEditingName} />
        )}
        {!isPersonal && !editingName && (
          <>
            <span className="w-[6px]" />
            <ShortInBrackets value={client.short || ''} onChange={onRenameShort} />
          </>
        )}
      </span>
      {!isPersonal && (
        <button
          type="button"
          onClick={onDelete}
          className="ml-auto -mr-[22px] p-1 opacity-0 group-hover:opacity-100 text-[#5e5e5e] hover:text-white transition-opacity"
          aria-label="Delete client"
        >
          <Trash2 size={14} />
        </button>
      )}
    </motion.div>
  );
}

function ResourceRow({ person, bodyFont, onDelete }: { person: Person; bodyFont: string; onDelete: () => void }) {
  // Drop target: dragging a project or task assigns this person to it (and to the project's children for projects).
  const { setNodeRef, isOver } = useDroppable({ id: `resource:${person.id}`, data: { type: 'resource', personShort: person.short } });
  return (
    <motion.div
      ref={setNodeRef}
      className={`relative group h-[37px] w-full box-border flex flex-row gap-2 items-center px-[31px] overflow-hidden ${isOver ? 'bg-white/[0.06] ring-1 ring-[#7363FF]/40' : ''}`}
      whileHover={{ backgroundColor: "rgba(255, 255, 255, 0.03)", transition: { duration: 0.15 } }}
    >
      <AssigneeBadge letter={person.short || '?'} tone="todo" />
      <span className="w-[2px]" />
      <span className={`${bodyFont} text-white`}>{person.name || '(unnamed)'}</span>
      {person.short && (
        <>
          <span className="w-[6px]" />
          <span className={`${bodyFont} text-[#656464]`}>({person.short})</span>
        </>
      )}
      <button
        type="button"
        onClick={onDelete}
        className="ml-auto -mr-[22px] p-1 opacity-0 group-hover:opacity-100 text-[#5e5e5e] hover:text-white transition-opacity"
        aria-label="Delete resource"
      >
        <Trash2 size={14} />
      </button>
    </motion.div>
  );
}

function HeaderAddMenu({
  clients,
  onAddBlankClient,
  onAddBlankProject,
  onAddBlankTask,
}: {
  clients: Client[];
  onAddBlankClient: () => void;
  onAddBlankProject: (clientId?: string) => void;
  onAddBlankTask: () => void;
}) {
  const [mode, setMode] = useState<'closed' | 'cascade' | 'picker'>('closed');
  const [filter, setFilter] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);

  // Close picker when clicking outside.
  useEffect(() => {
    if (mode !== 'picker') return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) { setMode('closed'); setFilter(''); }
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [mode]);

  const filtered = clients
    .filter((c) => c.name.toLowerCase().includes(filter.toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name));

  const cascadeBtn = "px-2 py-[2px] rounded text-[13px] text-[#ccc] hover:text-white hover:bg-white/[0.05] transition-colors whitespace-nowrap";

  return (
    <div
      ref={wrapRef}
      className="relative flex items-center"
      onMouseEnter={() => { if (mode === 'closed') setMode('cascade'); }}
      onMouseLeave={() => { if (mode === 'cascade') setMode('closed'); }}
    >
      <button
        type="button"
        onClick={() => setMode((m) => (m === 'closed' ? 'cascade' : m === 'cascade' ? 'closed' : m))}
        className={`${mode === 'closed' ? 'opacity-0 group-hover:opacity-100' : 'opacity-100'} text-[#656464] hover:text-white transition-opacity`}
        aria-label="Add"
      >
        <Plus size={14} />
      </button>
      {mode === 'cascade' && (
        <div className="ml-2 flex items-center gap-1 bg-[#1f1f1f] rounded-md px-1 py-[2px] shadow-lg">
          <button
            type="button"
            onClick={() => { setMode('picker'); setFilter(''); }}
            className={cascadeBtn}
          >Client+</button>
          <button
            type="button"
            onClick={() => { onAddBlankProject(); setMode('closed'); }}
            className={cascadeBtn}
          >Project+</button>
          <button
            type="button"
            onClick={() => { onAddBlankTask(); setMode('closed'); }}
            className={cascadeBtn}
          >Task+</button>
        </div>
      )}
      {mode === 'picker' && (
        <div className="absolute left-full top-full ml-2 mt-1 w-[240px] bg-[#1f1f1f] rounded-md p-2 shadow-2xl border border-[#2f2f2f] z-40">
          <input
            autoFocus
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Find a clientâ€¦"
            className="w-full bg-[#2a2a2a] rounded px-2 py-1 text-white text-[13px] outline-none focus:ring-1 focus:ring-[#7363FF] mb-2"
          />
          <div className="max-h-[220px] overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="text-[#666] text-[12px] px-2 py-1">No matching clients</div>
            ) : (
              filtered.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => { onAddBlankProject(c.id); setMode('closed'); setFilter(''); }}
                  className="w-full text-left px-2 py-1 text-[13px] text-[#ccc] hover:text-white hover:bg-white/[0.05] rounded transition-colors"
                >
                  {c.name} <span className="opacity-60">({c.short})</span>
                </button>
              ))
            )}
          </div>
          <div className="border-t border-[#2f2f2f] mt-1 pt-1">
            <button
              type="button"
              onClick={() => { onAddBlankClient(); setMode('closed'); setFilter(''); }}
              className="w-full text-left px-2 py-1 text-[13px] text-[#7363FF] hover:bg-white/[0.05] rounded transition-colors"
            >+ Create New</button>
          </div>
        </div>
      )}
    </div>
  );
}

function ProjectViewMode({
  projects, clients, tasks, newId, isAnyDragging, isDraggingProjTask, activeProjTaskId, activeProjTask, overProjTask, sourceCollapsed,
  onAddClient, onRenameClient, onRenameClientShort, onDeleteClient,
  onAddProject, onRenameProject, onDeleteProject,
  onToggleTask, onRenameTask, onDeleteTask, onEditTask, onQuickEditTask, onAddTaskToProject, onAddTaskInList, onAddProjectInList,
  people, onAddPerson, onDeletePerson, currentUserShort, taskOrder = 'ptc', density = 0,
}: {
  projects: Project[]; clients: Client[]; tasks: Task[]; people: Person[]; newId: string | null; isAnyDragging: boolean;
  currentUserShort: string;
  isDraggingProjTask: boolean;
  activeProjTaskId: string | null;
  // Pulled in so ProjectListColumn can run the same displacement math as the list view.
  activeProjTask: Task | null;
  overProjTask: Task | null;
  sourceCollapsed: boolean;
  onToggleTask: (id: string) => void;
  onRenameTask: (id: string, title: string) => void;
  onDeleteTask: (id: string) => void;
  onEditTask: (t: Task) => void;
  onQuickEditTask?: (t: Task) => void;
  onAddTaskToProject: (projectId: string, listId: ListId) => void;
  onAddTaskInList: (listId: ListId) => void;
  onAddProjectInList: (listId: ListId, clientId?: string) => void;
  onAddClient: () => void;
  onRenameClient: (id: string, name: string) => void;
  onRenameClientShort: (id: string, short: string) => void;
  onDeleteClient: (id: string) => void;
  onAddProject: (clientId?: string) => void;
  onRenameProject: (id: string, name: string) => void;
  onDeleteProject: (id: string) => void;
  onAddPerson: () => void;
  onDeletePerson: (id: string) => void;
  taskOrder?: TaskOrder;
  density?: number;
}) {
  // Personal pins to the top; all other clients sort alphabetically.
  const sortedClients = [...clients].sort((a, b) => {
    if (a.id === PERSONAL_CLIENT_ID) return -1;
    if (b.id === PERSONAL_CLIENT_ID) return 1;
    return a.name.localeCompare(b.name);
  });
  const bodyFont = "font-['Univers_BQ:55_Regular',sans-serif] leading-[normal] not-italic text-[14px] whitespace-nowrap";

  const Header = ({ title, onAdd }: { title: string; onAdd?: () => void }) => (
    <div className="group h-[37px] w-full box-border flex flex-row gap-2 items-center px-[35px] mb-[37px]">
      <p className="font-['NB_International:Regular',sans-serif] text-white text-[14.333px]">{title}</p>
      {onAdd && <AddPlus onClick={onAdd} />}
    </div>
  );

  const ClientSubHeader = ({ client, listId }: { client: Client; listId: ListId }) => {
    const { setNodeRef, isOver } = useDroppable({ id: `clientsub:${listId}:${client.id}`, data: { type: 'clientHeader', clientId: client.id, listId } });
    return (
      <div ref={setNodeRef} className={`group h-[37px] w-full box-border flex flex-row gap-2 items-center px-[31px] ${isOver ? 'bg-white/[0.06] ring-1 ring-[#7363FF]/40' : ''}`}>
        <p className={`${bodyFont} text-[#656464]`}>{client.name}</p>
        <AddPlus onClick={() => onAddProject(client.id)} />
      </div>
    );
  };

  // Parenthood is defined strictly by projectId. A task without a projectId is always "unassigned"
  // and renders at the very top of the column ï¿½ never absorbed by a project via title heuristics.
  // Milestones (type === 'scheduled') are pulled out and rendered separately at the top of the column.
  const tasksForProjectList = (p: Project, listId: ListId) => {
    // Within a project's task list in project view, Today tasks always sort above Next tasks.
    // Inside each section, preserve the user's manual order.
    const sectionRank: Record<SectionId, number> = { inbox: 0, today: 1, next: 2 };
    return tasks
      .filter((t) => t.list === listId && t.projectId === p.id && t.type !== 'scheduled')
      .sort((a, b) => {
        const sr = (sectionRank[a.section] ?? 99) - (sectionRank[b.section] ?? 99);
        if (sr !== 0) return sr;
        return a.order - b.order;
      });
  };

  // A milestone belongs to a column if the task itself is in that list, OR if its project is pinned to that list.
  const milestonesForList = (listId: ListId) => {
    return tasks
      .filter((t) => {
        if (t.type !== 'scheduled') return false;
        if (t.projectId) {
          const proj = projects.find((p) => p.id === t.projectId);
          if (proj?.list) return proj.list === listId;
        }
        return t.list === listId;
      })
      .sort((a, b) => {
        const ad = a.deadline || '\uffff';
        const bd = b.deadline || '\uffff';
        if (ad !== bd) return ad < bd ? -1 : 1;
        return a.title.localeCompare(b.title);
      });
  };

  const renderListColumn = (listId: ListId, title: string) => {
    // Tasks already shown under some project (either matched by projectId or by legacy title heuristic)
    const claimed = new Set<string>();
    for (const p of projects) for (const t of tasksForProjectList(p, listId)) claimed.add(t.id);
    const unassigned = tasks.filter((t) => t.list === listId && !t.projectId && !claimed.has(t.id) && t.type !== 'scheduled');
    const noClientProjects = projects.filter((p) => !p.clientId && (p.list ? p.list === listId : tasksForProjectList(p, listId).length > 0));
    const milestones = milestonesForList(listId);
    return <ProjectListColumn key={listId} listId={listId} title={title} unassigned={unassigned} noClientProjects={noClientProjects} milestones={milestones} />;
  };
  // Slot height for a project row ï¿½ matches the motion.div height animation in ProjectTaskRow.
  const PROJ_ROW_H = 37;
  // Same displacement math the list view runs:
  //  - both active+over in this bucket ? cards strictly between them slide by ï¿½slot height
  //  - active in a different bucket but over here ? the hovered slot opens an insertionGap above
  const projAnimProps = (bucket: Task[], task: Task, index: number): { displacementOffset: number; insertionGap: number } => {
    if (!activeProjTask || !overProjTask || activeProjTask.id === task.id) return { displacementOffset: 0, insertionGap: 0 };
    const aIdx = bucket.findIndex((t) => t.id === activeProjTask.id);
    const oIdx = bucket.findIndex((t) => t.id === overProjTask.id);
    const activeInBucket = aIdx >= 0;
    const overInBucket = oIdx >= 0;
    if (!activeInBucket && !overInBucket) return { displacementOffset: 0, insertionGap: 0 };
    if (activeInBucket && overInBucket) {
      if (aIdx < oIdx && index > aIdx && index <= oIdx) return { displacementOffset: -PROJ_ROW_H, insertionGap: 0 };
      if (aIdx > oIdx && index >= oIdx && index < aIdx) return { displacementOffset: PROJ_ROW_H, insertionGap: 0 };
    } else if (!activeInBucket && overInBucket) {
      if (index === oIdx) return { displacementOffset: 0, insertionGap: PROJ_ROW_H };
    }
    return { displacementOffset: 0, insertionGap: 0 };
  };
  const ProjectListColumn = ({ listId, title, unassigned, noClientProjects, milestones }: { listId: ListId; title: string; unassigned: Task[]; noClientProjects: Project[]; milestones: Task[] }) => {
    const { setNodeRef } = useDroppable({ id: `projlist:${listId}`, data: { type: 'projList', listId } });
    return (
    <div ref={setNodeRef} className={`flex-1 min-w-[280px]`}>
      <div className="group h-[37px] w-full box-border flex flex-row gap-2 items-center px-[35px] mb-[37px]">
        <p className="font-['NB_International:Regular',sans-serif] text-white text-[14.333px]">{title}</p>
        <HeaderAddMenu
          clients={clients}
          onAddBlankClient={onAddClient}
          onAddBlankProject={(clientId) => onAddProjectInList(listId, clientId)}
          onAddBlankTask={() => onAddTaskInList(listId)}
        />
      </div>
      {milestones.length > 0 && (
        <div className="mb-[37px]">
          {milestones.map((t) => (
            <ProjectTaskRow key={t.id} task={t} listId={listId} onToggle={() => onToggleTask(t.id)} onRename={(title) => onRenameTask(t.id, title)} onDelete={() => onDeleteTask(t.id)} onEdit={() => onEditTask(t)} isAnyDragging={isAnyDragging} autoFocus={t.id === newId} nonDraggable projects={projects} clients={clients} showContext />
          ))}
        </div>
      )}
      {unassigned.length > 0 && (
        <div className="mb-[37px]">
          <SortableContext items={unassigned.map((t) => `projtask-${listId}-${t.id}`)} strategy={verticalListSortingStrategy}>
            {unassigned.map((t, i) => {
              const { displacementOffset, insertionGap } = projAnimProps(unassigned, t, i);
              return (
                <ProjectTaskRow key={t.id} task={t} listId={listId} onToggle={() => onToggleTask(t.id)} onRename={(title) => onRenameTask(t.id, title)} onDelete={() => onDeleteTask(t.id)} onEdit={() => onEditTask(t)} onQuickEdit={onQuickEditTask ? () => onQuickEditTask(t) : undefined} onAddSibling={() => addSiblingTask(t)} isAnyDragging={isAnyDragging} taskOrder={taskOrder} density={density} autoFocus={t.id === newId} collapsed={sourceCollapsed && activeProjTaskId === t.id} displacementOffset={displacementOffset} insertionGap={insertionGap} />
              );
            })}
          </SortableContext>
        </div>
      )}
      {noClientProjects.length > 0 && (
        <div className="mb-[37px]">
          <SortableContext items={noClientProjects.map((p) => `projrow-${listId}-${p.id}`)} strategy={verticalListSortingStrategy}>
            {noClientProjects.map((p) => {
              const projTasks = tasksForProjectList(p, listId);
              return (
                <div key={p.id}>
                  <SortableProjectRow project={p} listId={listId} onRename={onRenameProject} onDelete={onDeleteProject} onAddTask={onAddTaskToProject} autoFocus={p.id === newId} isAnyDragging={isAnyDragging} />
                  <SortableContext items={projTasks.map((t) => `projtask-${listId}-${t.id}`)} strategy={verticalListSortingStrategy}>
                    {projTasks.map((t, i) => {
                      const { displacementOffset, insertionGap } = projAnimProps(projTasks, t, i);
                      return (
                        <ProjectTaskRow key={t.id} task={t} listId={listId} onToggle={() => onToggleTask(t.id)} onRename={(title) => onRenameTask(t.id, title)} onDelete={() => onDeleteTask(t.id)} onEdit={() => onEditTask(t)} onQuickEdit={onQuickEditTask ? () => onQuickEditTask(t) : undefined} onAddSibling={() => addSiblingTask(t)} isAnyDragging={isAnyDragging} taskOrder={taskOrder} density={density} autoFocus={t.id === newId} collapsed={sourceCollapsed && activeProjTaskId === t.id} displacementOffset={displacementOffset} insertionGap={insertionGap} />
                      );
                    })}
                  </SortableContext>
                </div>
              );
            })}
          </SortableContext>
        </div>
      )}
      {sortedClients.map((c, ci) => {
        const clientProjects = projects.filter((p) => p.clientId === c.id);
        const visibleProjects = clientProjects.filter((p) => {
          if (p.list) return p.list === listId;
          // No explicit pin: show in "projects" as default home, plus anywhere it has tasks.
          return listId === 'projects' || tasksForProjectList(p, listId).length > 0;
        });
        if (visibleProjects.length === 0) return null;
        return (
          <div key={c.id}>
            {ci > 0 && <Spacer />}
            <ClientSubHeader client={c} listId={listId} />
            <SortableContext items={visibleProjects.map((p) => `projrow-${listId}-${p.id}`)} strategy={verticalListSortingStrategy}>
              {visibleProjects.map((p) => {
                const projTasks = tasksForProjectList(p, listId);
                return (
                  <div key={p.id}>
                    <SortableProjectRow project={p} listId={listId} onRename={onRenameProject} onDelete={onDeleteProject} onAddTask={onAddTaskToProject} autoFocus={p.id === newId} isAnyDragging={isAnyDragging} />
                    <SortableContext items={projTasks.map((t) => `projtask-${listId}-${t.id}`)} strategy={verticalListSortingStrategy}>
                      {projTasks.map((t, i) => {
                        const { displacementOffset, insertionGap } = projAnimProps(projTasks, t, i);
                        return (
                          <ProjectTaskRow key={t.id} task={t} listId={listId} onToggle={() => onToggleTask(t.id)} onRename={(title) => onRenameTask(t.id, title)} onDelete={() => onDeleteTask(t.id)} onEdit={() => onEditTask(t)} onQuickEdit={onQuickEditTask ? () => onQuickEditTask(t) : undefined} onAddSibling={() => addSiblingTask(t)} isAnyDragging={isAnyDragging} taskOrder={taskOrder} density={density} autoFocus={t.id === newId} collapsed={sourceCollapsed && activeProjTaskId === t.id} displacementOffset={displacementOffset} insertionGap={insertionGap} />
                        );
                      })}
                    </SortableContext>
                  </div>
                );
              })}
            </SortableContext>
          </div>
        );
      })}
    </div>
    );
  };

  return (
    <div className="pt-[106px] pb-[106px] flex gap-0">
      <div className="flex-1 min-w-[280px]">
        <Header title="Resources" onAdd={onAddPerson} />
        {people.map((p) => (
          <ResourceRow key={p.id} person={p} bodyFont={bodyFont} onDelete={() => onDeletePerson(p.id)} />
        ))}
        <Spacer />
        <Header title="Clients" onAdd={onAddClient} />
        {sortedClients.map((c) => (
          <ClientRow key={c.id} client={c} autoFocus={c.id === newId} bodyFont={bodyFont} onRenameName={(v) => onRenameClient(c.id, v)} onRenameShort={(v) => onRenameClientShort(c.id, v)} onDelete={() => onDeleteClient(c.id)} currentUserShort={currentUserShort} />
        ))}
      </div>
      {renderListColumn('work', 'Work')}
      {renderListColumn('projects', 'Projects')}
      {renderListColumn('admin', 'Admin')}
    </div>
  );
}

function startOfWeek(d: Date): Date {
  const nd = new Date(d);
  nd.setHours(0, 0, 0, 0);
  nd.setDate(nd.getDate() - nd.getDay());
  return nd;
}
function addDaysToDate(d: Date, n: number): Date { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function dateToISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function CalendarDayDroppable({ id, children, isEmpty, className = '' }: { id: string; children: React.ReactNode; isEmpty: boolean; className?: string }) {
  const { setNodeRef } = useDroppable({ id });
  // No tint, no hint line ï¿½ displaced cards under the cursor show where the drop will land.
  return <div ref={setNodeRef} className={`${isEmpty ? 'min-h-[37px]' : ''} ${className}`}>{children}</div>;
}

function CalendarColumnDroppable({ date, children }: { date: string; children: React.ReactNode }) {
  const { setNodeRef } = useDroppable({ id: `col:${date}`, data: { type: 'column', date } });
  // h-full + flex-col + min-h-0 + overflow-hidden so each column can host its own
  // independently-scrolling content area (the caller provides the inner structure:
  // a shrink-0 day-name row plus a flex-1 overflow-y-auto wrapper for the bands).
  return (
    <div ref={setNodeRef} className="min-w-[200px] flex flex-col h-full min-h-0 overflow-hidden">
      {children}
    </div>
  );
}

const CAL_LISTS: { id: ListId; label: string }[] = [
  { id: 'admin', label: 'Admin' },
  { id: 'work', label: 'Work' },
  { id: 'projects', label: 'Projects' },
  { id: 'personal', label: 'Personal' },
];

// A task is "private" (Personal) when it lives in the Personal CATEGORY (list) or under the
// legacy Personal CLIENT — either way it's scoped to its assignees, so only the owner sees it.
const isPrivateTask = (t: Task) => t.list === 'personal' || t.clientId === PERSONAL_CLIENT_ID;

// Focus-page live search — does a task match the query? Checks its title + its project name +
// its client's name/short (case-insensitive). An empty query matches everything.
const taskMatchesQuery = (t: Task, query: string, projects: Project[], clients: Client[]): boolean => {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const proj = t.projectId ? projects.find((p) => p.id === t.projectId) : undefined;
  const cid = t.clientId ?? proj?.clientId;
  const cli = cid ? clients.find((c) => c.id === cid) : undefined;
  return t.title.toLowerCase().includes(q)
    || !!(proj?.name && proj.name.toLowerCase().includes(q))
    || !!(cli?.name && cli.name.toLowerCase().includes(q))
    || !!(cli?.short && cli.short.toLowerCase().includes(q));
};

// Click a sticky band label (Work / Projects / Admin / Personal) → smooth-scroll its column
// back to the TOP of that category. The clicked <p>'s grandparent is the band container; we
// animate the CustomScroll's scrollTop by hand (easeOutCubic over ~320ms) because native
// smooth scrollTo / scrollIntoView are no-ops on this custom overflow container.
const scrollBandToTop = (e: React.MouseEvent) => {
  const container = (e.currentTarget as HTMLElement).parentElement?.parentElement; // band container
  if (!container) return;
  let sc: HTMLElement | null = container.parentElement;
  while (sc && sc.scrollHeight <= sc.clientHeight + 1) sc = sc.parentElement;
  if (!sc) return;
  const el = sc;
  const start = el.scrollTop;
  const target = Math.max(0, start + (container.getBoundingClientRect().top - el.getBoundingClientRect().top));
  if (Math.abs(target - start) < 1) return;
  const t0 = performance.now();
  const ease = (p: number) => 1 - Math.pow(1 - p, 3);
  const step = (now: number) => {
    const p = Math.min(1, (now - t0) / 320);
    el.scrollTop = start + (target - start) * ease(p);
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
};

// Canvas-based text measurer for the focus page's content-sized columns. The app's global CSS
// forces one typographic standard (14px 'Untitled Sans') on every element, so a single font
// string measures every row accurately without touching the DOM.
let __measureCtx: CanvasRenderingContext2D | null = null;
const measureTextPx = (s: string): number => {
  if (!__measureCtx && typeof document !== 'undefined') __measureCtx = document.createElement('canvas').getContext('2d');
  if (!__measureCtx) return s.length * 8;
  __measureCtx.font = "14px 'Untitled Sans', sans-serif";
  return __measureCtx.measureText(s).width;
};

// Shared milestone card — the purple-tinted two-line card (title on line 1; client › project,
// assignees, date on line 2). Extracted from WeekCalendarMode's local MilestoneCard so the
// focus page's "Coming Up" section renders the IDENTICAL format. `onClick` (focus page) filters
// to the milestone's project — or seeds the live search with its title when it has no project.
function MilestoneCardView({ task, projects, clients, showDate, categoryDimmed = false, onEdit, onQuickEdit, onAddSibling, onClick, active = false }: {
  task: Task; projects: Project[]; clients: Client[]; showDate: boolean; categoryDimmed?: boolean;
  onEdit: () => void; onQuickEdit?: () => void; onAddSibling?: () => void; onClick?: () => void;
  // Active milestone filter — white title + × at the end of line 1 (same visual the
  // client/project filter rows use). Click anywhere on the card toggles it back off.
  active?: boolean;
}) {
  const project = task.projectId ? projects.find((p) => p.id === task.projectId) : undefined;
  const resolvedClientId = task.clientId ?? project?.clientId;
  const client = resolvedClientId ? clients.find((c) => c.id === resolvedClientId) : undefined;
  const isPersonal = resolvedClientId === PERSONAL_CLIENT_ID || task.list === 'personal';
  // Expired milestones (deadline before today) render in faint purple — a permanent record.
  const isExpired = !!task.deadline && task.deadline < todayISO();
  const milestonePurpleClass = isExpired ? 'text-[#4f4290]' : 'text-[#8465ff]';
  const DIM = 'text-[#454545]';
  const titleClass = active ? 'text-white' : categoryDimmed ? DIM : task.completed ? 'text-[#383838]' : milestonePurpleClass;
  // Inline style because Tailwind arbitrary opacity on hex colors wasn't reliably generating the CSS.
  const cardBgStyle: React.CSSProperties = { backgroundColor: 'rgba(132, 101, 255, 0.10)' };
  return (
    <div onClick={onClick} onDoubleClick={(e) => { e.stopPropagation(); onEdit(); }} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onQuickEdit?.(); }} style={cardBgStyle} className="relative mx-[6px] mb-[4px] group cursor-pointer h-[55px]">
      <div className="px-[10px] py-[6px] flex flex-col justify-center gap-[2px] h-full">
        <div className="flex flex-row items-center gap-[4px]">
          <span className={`font-['Univers_BQ:55_Regular',sans-serif] text-[13px] whitespace-nowrap overflow-hidden text-ellipsis ${titleClass}`}>{task.title}</span>
          {active && <X size={13} className="ml-auto shrink-0 text-[#a8a8a8]" />}
        </div>
        {/* Line 2 always reserves height so meta-less milestones don't render shorter. */}
        <div className="flex flex-row items-center gap-[6px] min-h-[15px]">
          {client?.short && project?.name && <p className={`font-['Univers_BQ:55_Regular',sans-serif] text-[11.5px] whitespace-nowrap ${titleClass}`}>{client.short}<Arrowhead dim={task.completed || categoryDimmed} tone="milestone" faint={isExpired} />{project.name}</p>}
          {client?.short && !project?.name && <p className={`font-['Univers_BQ:55_Regular',sans-serif] text-[11.5px] whitespace-nowrap ${titleClass}`}>{client.short}</p>}
          {!client?.short && project?.name && <p className={`font-['Univers_BQ:55_Regular',sans-serif] text-[11.5px] whitespace-nowrap ${titleClass}`}>{project.name}</p>}
          {task.assignees.map((a, i) => <AssigneeBadge key={`${a}-${i}`} letter={a} tone="scheduled" hollow={isPersonal} dim={task.completed || categoryDimmed} faint={isExpired} />)}
          {showDate && task.deadline && <DeadlineArrow small dim={task.completed || categoryDimmed} color={isExpired ? '#4f4290' : '#8465ff'} />}
          {showDate && task.deadline && <p className={`font-['NB_International:Regular',sans-serif] text-[11.5px] whitespace-nowrap ${titleClass}`}>{formatDeadline(task.deadline)}</p>}
          {onAddSibling && (
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); onAddSibling(); }}
              className="p-[2px] opacity-0 group-hover:opacity-100 text-[#5e5e5e] hover:text-white transition-opacity"
              aria-label="Add task in same project"
            >
              <Plus size={12} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// Per-day caps shared by the week calendar and the focus page's mini-calendar strip:
//   CAL_TASKS_PER_DAY (9)              — global cap on total slots (mandatory + queue)
//   CAL_QUEUE_CAP_PER_LIST_PER_DAY (3) — per-list cap on queue auto-fill per day
// Mandatory tasks (deadlined / today / tomorrow placed) are exempt from both caps.
const CAL_TASKS_PER_DAY = 9;
const CAL_QUEUE_CAP_PER_LIST_PER_DAY = 3;

// The calendar's day-distribution, extracted from WeekCalendarMode so the focus page's
// mini-calendar strip renders EXACTLY what the week calendar's day columns show. Returns a
// map keyed '<iso>:<listId>' → tasks for `horizonDays` days starting at todayAnchor
// (midnight-anchored). Semantics preserved verbatim:
//   - mandatory per list = deadline===day todos, plus section-'today' on today and
//     section-'tomorrow' on tomorrow
//   - queue fillers (next/inbox, undated, uncompleted) only for day 3+ — today and
//     tomorrow are sealed during the day (their fill happens at the 4 AM refill)
//   - global day budget CAL_TASKS_PER_DAY, per-list band cap
//     CAL_QUEUE_CAP_PER_LIST_PER_DAY, weekends queue-fill only the projects list
// listOrder: the universal section sequence (Settings → Section sequence). It drives BOTH
// band display order and the queue-filler allocation order — earlier lists in the sequence
// get first crack at each day's remaining budget.
function computeCalendarDistribution(tasks: Task[], todayAnchor: Date, horizonDays: number, listOrder: ListId[]): Record<string, Task[]> {
  const map: Record<string, Task[]> = {};
  const todayIso = `${todayAnchor.getFullYear()}-${String(todayAnchor.getMonth() + 1).padStart(2, '0')}-${String(todayAnchor.getDate()).padStart(2, '0')}`;
  const tomorrowAnchor = addDaysToDate(todayAnchor, 1);
  const tomorrowIso = `${tomorrowAnchor.getFullYear()}-${String(tomorrowAnchor.getMonth() + 1).padStart(2, '0')}-${String(tomorrowAnchor.getDate()).padStart(2, '0')}`;
  // Per-list queues + their cursors. Queues advance independently per list.
  const queues: Record<string, Task[]> = {};
  const queueIdxs: Record<string, number> = {};
  for (const listId of listOrder) {
    queues[listId] = tasks.filter((t) =>
      t.list === listId &&
      (t.section === 'next' || t.section === 'inbox') &&
      !t.deadline &&
      t.type !== 'scheduled' &&
      !t.completed
    ).sort((a, b) => a.order - b.order);
    queueIdxs[listId] = 0;
  }
  for (let off = 0; off < horizonDays; off++) {
    const d = addDaysToDate(todayAnchor, off);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const isTodayOrTomorrow = iso === todayIso || iso === tomorrowIso;
    // Pass 1 — collect mandatory per list, sum the total.
    const mandatoryByList: Record<string, Task[]> = {};
    let totalMandatory = 0;
    for (const listId of listOrder) {
      const m: Task[] = [];
      // COMPLETED tasks are excluded from every live placement below — they
      // used to pile up on today via their stale section:'today' (30-40 old
      // completions crowding the current day). Instead they appear once as a
      // faded RESIDUE row pinned to their completion date (see below).
      m.push(...tasks.filter((t) =>
        t.list === listId && t.deadline === iso && t.type !== 'scheduled' && !t.completed
      ).sort((a, b) => a.order - b.order));
      if (iso === todayIso) {
        m.push(...tasks.filter((t) =>
          t.list === listId && t.section === 'today' && !t.deadline && t.type !== 'scheduled' && !t.completed
        ).sort((a, b) => a.order - b.order));
      }
      if (iso === tomorrowIso) {
        m.push(...tasks.filter((t) =>
          t.list === listId && t.section === 'tomorrow' && !t.deadline && t.type !== 'scheduled' && !t.completed
        ).sort((a, b) => a.order - b.order));
      }
      mandatoryByList[listId] = m;
      totalMandatory += m.length;
    }
    // Pass 2 — assign queue fillers per list (today/tomorrow sealed; Wed+ real-time).
    let dayBudget = Math.max(0, CAL_TASKS_PER_DAY - totalMandatory);
    for (const listId of listOrder) {
      const m = mandatoryByList[listId];
      const skipQueueForWeekend = listId !== 'projects' && (d.getDay() === 0 || d.getDay() === 6);
      const listFillerCap = Math.max(0, CAL_QUEUE_CAP_PER_LIST_PER_DAY - m.length);
      let slotsLeft = Math.min(dayBudget, listFillerCap);
      if (skipQueueForWeekend) slotsLeft = 0;
      if (isTodayOrTomorrow) slotsLeft = 0;
      const queue = queues[listId];
      const fillers = queue.slice(queueIdxs[listId], queueIdxs[listId] + slotsLeft);
      queueIdxs[listId] += fillers.length;
      dayBudget -= fillers.length;
      // COMPLETION RESIDUE: a completed task shows once, faded, pinned on its
      // completion date — but NOT on the day it was completed (it "fades out"
      // that day and reappears as history from the next day onward). Old
      // completions with no completedDay stamp never place anywhere.
      const residue = tasks.filter((t) =>
        t.list === listId && t.completed && t.type !== 'scheduled' &&
        t.completedDay === iso && iso !== todayIso
      ).sort((a, b) => a.order - b.order);
      map[`${iso}:${listId}`] = [...m, ...fillers, ...residue];
    }
  }
  return map;
}

// Presentational body of a calendar card ï¿½ no drag wiring, no callbacks. Shared between the
// live CalendarCard and the DragOverlay so the floating ghost matches the source pixel-for-pixel.
function CalendarCardBody({ task, projects, clients, taskOrder = 'ptc' }: { task: Task; projects: Project[]; clients: Client[]; taskOrder?: TaskOrder }) {
  const project = task.projectId ? projects.find((p) => p.id === task.projectId) : undefined;
  const resolvedClientId = task.clientId ?? project?.clientId;
  const client = resolvedClientId ? clients.find((c) => c.id === resolvedClientId) : undefined;
  const isScheduled = task.type === 'scheduled';
  const isNext = task.section === 'next' || task.section === 'tomorrow';
  const isPersonal = resolvedClientId === PERSONAL_CLIENT_ID || task.list === 'personal';
  const titleColor = task.completed ? 'text-[#383838]' : isScheduled ? 'text-[#8465ff]' : isNext ? 'text-[#a8a8a8]' : 'text-white';
  const metaColor = isScheduled ? 'text-[#8465ff]' : 'text-[#656464]';
  // Whether the client lives ON the first row (combined with project per the slot helper) —
  // applies to 'cpt' and 'tcp' modes where client + project sit adjacent. In 'ptc' the client
  // stays on the second row alongside assignees + date (legacy two-row calendar layout).
  const clientOnFirstRow = taskOrder !== 'ptc';
  return (
    // Mirror the live card's flex-wrap layout so the floating drag copy is the SAME shape/height
    // (one line when wide, two when narrow) instead of a fixed two-row block.
    <div className="px-[10px] py-[7px] flex flex-row flex-wrap items-center content-center gap-x-[10px] gap-y-[1px] overflow-hidden h-full">
      <div className="flex flex-row items-center gap-[10px]">
        {!isScheduled && (
          <div className="shrink-0 flex items-center justify-center">
            <TaskCheckbox completed={task.completed} started={task.started} onToggle={() => {}} />
          </div>
        )}
        <span className={`font-['Univers_BQ:55_Regular',sans-serif] text-[13px] whitespace-nowrap overflow-hidden text-ellipsis ${titleColor}`}>{task.title}</span>
      </div>
      <div className="flex flex-row items-center gap-[6px]">
        {client && project && <p className={`font-['Univers_BQ:55_Regular',sans-serif] text-[11.5px] whitespace-nowrap text-[#656464]`}>{client.short}<Arrowhead dim={task.completed} />{project.name}</p>}
        {client && !project && <p className={`font-['Univers_BQ:55_Regular',sans-serif] text-[11.5px] whitespace-nowrap ${metaColor}`}>{client.short}</p>}
        {!client && project && <p className={`font-['Univers_BQ:55_Regular',sans-serif] text-[11.5px] whitespace-nowrap text-[#656464]`}>{project.name}</p>}
        {task.assignees.map((a, i) => <AssigneeBadge key={`${a}-${i}`} letter={a} tone={isScheduled ? 'scheduled' : 'todo'} hollow={isPersonal} dim={task.completed} />)}
        {task.deadline && <p className={`font-['NB_International:Regular',sans-serif] text-[11.5px] whitespace-nowrap ${isScheduled ? 'text-[#8465ff]' : isLateDeadline(task.deadline) ? 'text-[#FF7171]' : 'text-[#656464]'}`}>{formatDeadline(task.deadline)}</p>}
      </div>
    </div>
  );
}

function CalendarCard({ task, cellId, projects, clients, onToggle, onRename, onDelete, onEdit, onQuickEdit, onAddSibling, isAnyDragging, dimmed, categoryDimmed, displacementOffset = 0, insertionGap = 0, taskOrder = 'ptc', autoFocusEdit = false, stacked = false }: {
  task: Task; cellId: string; projects: Project[]; clients: Client[];
  onToggle: () => void; onRename: (title: string) => void; onDelete: () => void; onEdit: () => void;
  onQuickEdit?: () => void;
  onAddSibling?: () => void;
  // Freshly created task (newId): the title renders as an autofocused EditableText so the
  // user can start typing immediately — list-view parity. Blurring while still empty
  // discards the task via onDelete.
  autoFocusEdit?: boolean;
  // stacked = force the two-line layout (title on line 1, meta on line 2) instead of the
  // responsive one-line-when-wide flow. The Calendar view sets this so every card is uniformly
  // two lines (no mix of one- and two-liners).
  stacked?: boolean;
  isAnyDragging: boolean; dimmed?: boolean;
  // Cards in OTHER bands than the active drag's source category get muted so the drag's
  // landing options stay visually loud. Same flavor as the completed-task gray, just brighter.
  categoryDimmed?: boolean;
  // Same displacement system the list view uses: cards under the dragged item shift to make room.
  displacementOffset?: number; insertionGap?: number;
  taskOrder?: TaskOrder;
}) {
  const project = task.projectId ? projects.find((p) => p.id === task.projectId) : undefined;
  const resolvedClientId = task.clientId ?? project?.clientId;
  const client = resolvedClientId ? clients.find((c) => c.id === resolvedClientId) : undefined;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    data: { type: 'task', task, calendarCellId: cellId },
    transition: { duration: 350, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
  });
  // Today wash — same faint purple as the milestone card (inline: Tailwind arbitrary hex
  // alpha was unreliable here). Kept during category-dim so the "this is today" location
  // cue stays put while the text mutes.
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: isAnyDragging ? `transform ${MOTION.base}ms ${MOTION.easeOut}` : 'none',
    ...(cellId.startsWith(`cal:${todayISO()}:`) ? { backgroundColor: 'rgba(132, 101, 255, 0.10)' } : {}),
  };
  const isScheduled = task.type === 'scheduled';
  const isNext = task.section === 'next' || task.section === 'tomorrow';
  const isPersonal = resolvedClientId === PERSONAL_CLIENT_ID || task.list === 'personal';
  // TODAY cards go full milestone-purple (faint purple wash, purple checkbox/meta/badges,
  // WHITE title) — "what today is" reads at a glance. Keyed to the CELL the card renders in,
  // so dragging a card off today reverts it to the normal palette automatically.
  const isTodayCard = cellId.startsWith(`cal:${todayISO()}:`);
  // Category-dim color: 5% brighter than the completed-task #383838 (rgb 56 → 69 = #454545).
  // Wins over every other state — when the user is dragging across categories, ALL non-source
  // cards drop to this single muted gray regardless of whether they're scheduled, completed,
  // next, or normal.
  const DIM = 'text-[#454545]';
  const titleColor = categoryDimmed ? DIM : task.completed ? 'text-[#383838]' : isScheduled ? 'text-[#8465ff]' : isTodayCard ? 'text-white' : isNext ? 'text-[#a8a8a8]' : 'text-white';
  const metaColor = categoryDimmed ? DIM : (isScheduled || isTodayCard) ? 'text-[#8465ff]' : 'text-[#656464]';
  // Source-collapse: outer wrapper uses max-height (CSS can't transition from auto, but it CAN
  // transition from a fixed max-height to 0) + marginBottom so the column reflows when this card
  // becomes the active drag.
  // Displacement: a motion.div wrapper animates y / marginTop so OTHER cards slide out of the way
  // to reveal where the dragged card will land ï¿½ same trick the list view uses.
  // List-view-style drag mechanics with displacement RESTORED — the calendar's parent computes
  // displacementOffset / insertionGap externally per cell and passes them in; the <Displaced>
  // wrapper consumes them so neighbouring cards slide to make room (same trick list view uses).
  return (
    <Displaced offset={displacementOffset} gap={insertionGap} active={isAnyDragging}>
    <motion.div
      ref={setNodeRef}
      style={style}
      data-cal-card={task.id}
      className={`relative mx-[6px] mb-[4px] group min-h-[45px] flex ${isTodayCard ? '' : 'bg-white/[0.03]'} ${dimmed ? 'opacity-60' : ''}`}
      animate={{ opacity: isDragging ? 0 : 1 }}
      transition={{ opacity: { duration: 0.12, ease: 'easeOut' } }}
    >
      <div onDoubleClick={(e) => { e.stopPropagation(); onEdit(); }} onContextMenu={(e) => { if (onQuickEdit) { e.preventDefault(); e.stopPropagation(); onQuickEdit(); } }} {...attributes} {...listeners} className={`cursor-grab active:cursor-grabbing px-[10px] py-[7px] overflow-hidden flex-1 ${stacked ? 'flex flex-col justify-center gap-[2px]' : 'flex flex-row flex-wrap items-center content-center gap-x-[10px] gap-y-[1px]'}`}>
        {/* Calendar cards always render Title on line 1, all other meta on line 2 — taskOrder
            setting doesn't apply here. Line 1: checkbox + title. Line 2: client › project,
            assignees, deadline, + button. Checkbox is INLINE with the title so it stays aligned
            with the title cap-height when the whole content block is vertically centered. */}
        <div className="flex flex-row items-center gap-[10px] w-full pr-5">
          {!isScheduled && (
            <div onPointerDown={(e) => e.stopPropagation()} className="shrink-0 flex items-center justify-center">
              <TaskCheckbox completed={task.completed} started={task.started} onToggle={onToggle} accent={isTodayCard && !categoryDimmed ? '#8465ff' : undefined} />
            </div>
          )}
          <div className="flex flex-row items-center gap-[4px] min-w-0">
            {/* Title is ALWAYS an inline EditableText now — click to edit, drag-in-text to select
                (EditableText swallows the pointer while editing so it doesn't start a card drag).
                autoFocus only for a freshly created task. No onDiscardIfEmpty: the 3-min blank-sweep
                handles empties, so a fresh card never "blinks out". */}
            <EditableText
              value={task.title}
              onChange={onRename}
              autoFocus={autoFocusEdit}
              placeholder="New Task"
              className={`font-['Univers_BQ:55_Regular',sans-serif] text-[13px] whitespace-nowrap overflow-hidden text-ellipsis ${titleColor}`}
            />
          </div>
          {/* + hugs the END OF THE TITLE TEXT (not the card's right edge — parked out there
              next to the trash it read as unrelated). Hover-reveal; the title wrapper is
              content-sized (no flex-1) so the + sits right after the name, and the row's
              pr-5 keeps everything clear of the absolute trash button. */}
          {onAddSibling && (
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); onAddSibling(); }}
              className="shrink-0 p-[2px] opacity-0 group-hover:opacity-100 text-[#5e5e5e] hover:text-white transition-opacity"
              aria-label="Add task in same project"
            >
              <Plus size={12} />
            </button>
          )}
        </div>
        {/* Meta row indents past the checkbox + gap so it lines up under the title text, not under
            the checkbox. 22px = checkbox width (12) + title-row gap (10). When there's no checkbox
            (isScheduled milestones in this branch), the indent collapses to 0. In stacked mode the
            row reserves a min-height so even a meta-less task still reads as two lines (no mix). */}
          <div className={`flex flex-row items-center gap-[6px] ${stacked ? 'min-h-[15px]' : ''}`}>
            {/* When completed, all line-2 meta drops to the same faint #383838 — visually quieted to match the title.
                Only render the client/project paragraph when there's actual non-empty text to show; otherwise an
                empty <p> sits at the start of the row and the gap-[6px] pushes the next item (e.g. an assignee
                circle) 6px to the right, making it look indented. */}
            {client?.short && project?.name && <p className={`font-['Univers_BQ:55_Regular',sans-serif] text-[11.5px] whitespace-nowrap ${categoryDimmed ? DIM : task.completed ? 'text-[#383838]' : metaColor}`}>{client.short}<Arrowhead dim={task.completed || categoryDimmed} tone={isTodayCard ? 'milestone' : 'default'} />{project.name}</p>}
            {client?.short && !project?.name && <p className={`font-['Univers_BQ:55_Regular',sans-serif] text-[11.5px] whitespace-nowrap ${categoryDimmed ? DIM : task.completed ? 'text-[#383838]' : metaColor}`}>{client.short}</p>}
            {!client?.short && project?.name && <p className={`font-['Univers_BQ:55_Regular',sans-serif] text-[11.5px] whitespace-nowrap ${categoryDimmed ? DIM : task.completed ? 'text-[#383838]' : metaColor}`}>{project.name}</p>}
            {/* Deadline arrow — the same glyph list view puts before dates (small variant for
                the tighter card meta). Milestones get it too, tinted milestone purple. */}
            {task.deadline && <DeadlineArrow small dim={task.completed || categoryDimmed} color={(isScheduled || isTodayCard) ? '#8465ff' : undefined} />}
            {task.deadline && <p className={`font-['NB_International:Regular',sans-serif] text-[11.5px] whitespace-nowrap ${categoryDimmed ? DIM : task.completed ? 'text-[#383838]' : isScheduled ? 'text-[#8465ff]' : isLateDeadline(task.deadline) ? 'text-[#FF7171]' : isTodayCard ? 'text-[#8465ff]' : 'text-[#656464]'}`}>{formatDeadline(task.deadline)}</p>}
            {/* Assignees AFTER the date — hidden at rest, fade in on card-hover (~200ms), and on
                roll-off linger ~1s then fade out over 500ms (asymmetric group-hover transition). */}
            {task.assignees.length > 0 && (
              <span className="flex flex-row items-center gap-[6px] linger-reveal">
                {task.assignees.map((a, i) => <AssigneeBadge key={`${a}-${i}`} letter={a} tone={(isScheduled || isTodayCard) ? 'scheduled' : 'todo'} hollow={isPersonal} dim={task.completed || categoryDimmed} />)}
              </span>
            )}
          </div>
      </div>
      <button
        type="button"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
        className="absolute top-2 right-1 p-1 opacity-0 group-hover:opacity-100 text-[#5e5e5e] hover:text-white transition-opacity"
        aria-label="Delete task"
      >
        <Trash2 size={12} />
      </button>
    </motion.div>
    </Displaced>
  );
}

function WeekCalendarMode({
  tasks, projects, clients, onToggleTask, onRenameTask, onDeleteTask, onEditTask, onQuickEditTask, onAddSiblingTask, onAddTaskOnDay, onSyncSections, isAnyDragging,
  activeTask, overTask, activeCellId, activeSlotHeight, taskOrder = 'ptc', listSequence, newTaskId = null,
}: {
  tasks: Task[]; projects: Project[]; clients: Client[];
  onToggleTask: (id: string) => void;
  onRenameTask: (id: string, title: string) => void;
  onDeleteTask: (id: string) => void;
  onEditTask: (t: Task) => void;
  onQuickEditTask?: (t: Task) => void;
  // pinDeadline keeps the spawned sibling in the cell it came from — see addSiblingTask.
  onAddSiblingTask: (t: Task, pinDeadline?: string) => void;
  // Quick-add for a day cell's band label (+ on hover) — creates a blank task in that list
  // dated to that day. Autofocuses inline via newTaskId.
  onAddTaskOnDay: (listId: ListId, iso: string) => void;
  // Universal section sequence (Settings) — band order AND queue-allocation order.
  listSequence: ListId[];
  // Most recently created task id — its calendar card renders with an autofocused
  // editable title so the user can type immediately (list-view parity).
  newTaskId?: string | null;
  // Bulk section update — auto-promotes queue tasks landing on today/tomorrow into the
  // matching section so list view mirrors the calendar's distribution.
  onSyncSections: (updates: Array<{ id: string; section: SectionId }>) => void;
  isAnyDragging: boolean;
  // Drag context piped from App so the calendar can run the same displacement math the list view runs.
  activeTask: Task | null; overTask: Task | null; activeCellId: string | null; activeSlotHeight: number;
  taskOrder?: TaskOrder;
}) {
  const [weekOffset, setWeekOffset] = useState(0);
  // Column 1 = today, columns 2–5 = the next 4 days (no yesterday — it read as
  // noise). weekOffset shifts the whole window by 7-day increments.
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const weekStart = addDaysToDate(today, weekOffset * 7);
  // Five DATE columns (today + next 4); the 6th grid slot is the synthetic
  // "Next Week" look-ahead/drop column rendered after the map.
  const days = Array.from({ length: 5 }, (_, i) => addDaysToDate(weekStart, i));
  const dayNameShort = (d: Date) => d.toLocaleDateString('en-US', { weekday: 'short' });
  const bodyFont = "font-['Univers_BQ:55_Regular',sans-serif] leading-[normal] not-italic text-[14px] whitespace-nowrap";
  const todayIso = dateToISO(new Date());

  const todayAnchor = useMemo(() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }, []);
  const dayOffsetFromToday = (d: Date) => Math.round((d.getTime() - todayAnchor.getTime()) / 86400000);
  const isWeekendDate = (x: Date) => x.getDay() === 0 || x.getDay() === 6;

  // Distribution lives in computeCalendarDistribution (module scope — shared verbatim with
  // the focus page's mini-calendar strip). 84-day horizon ≈ 12 weeks; each cell render is an
  // O(1) map lookup. Recomputes only when the task list changes.
  const distributionByCell = useMemo(() => computeCalendarDistribution(tasks, todayAnchor, 84, listSequence), [tasks, todayAnchor, listSequence]);

  // (Auto-promotion of queue tasks into today/tomorrow happens ONCE per day inside the 4 AM
  //  refill effect in App. During the day today + tomorrow stay stable; only Wed+ continues to
  //  re-distribute in real-time. The on-render effect that used to do this has been removed.)
  void onSyncSections;

  const tasksForCell = (listId: ListId, d: Date): Task[] => {
    const off = dayOffsetFromToday(d);
    const iso = dateToISO(d);
    // Past days: keep showing whatever was actually there (deadlined or completed-on-this-day).
    if (off < 0) {
      return tasks.filter((t) => t.list === listId && t.deadline === iso && t.type !== 'scheduled').sort((a, b) => a.order - b.order);
    }
    return distributionByCell[`${iso}:${listId}`] || [];
  };

  // Milestones (scheduled tasks) render at the top of the column matching their deadline.
  // Anything dated outside the visible 7-day window stacks at the top of today's column.
  const visibleIsoSet = useMemo(() => new Set(days.map((d) => dateToISO(d))), [days]);
  const lastVisibleIso = dateToISO(days[days.length - 1]);
  const milestonesByIso = useMemo(() => {
    const map: Record<string, Task[]> = {};
    for (const t of tasks) {
      if (t.type !== 'scheduled' || !t.deadline) continue;
      if (!visibleIsoSet.has(t.deadline)) continue;
      (map[t.deadline] ||= []).push(t);
    }
    for (const iso in map) map[iso].sort((a, b) => a.title.localeCompare(b.title));
    return map;
  }, [tasks, visibleIsoSet]);
  const overflowMilestones = useMemo(() => {
    return tasks
      .filter((t) => t.type === 'scheduled' && t.deadline && t.deadline > lastVisibleIso)
      .sort((a, b) => (a.deadline! < b.deadline! ? -1 : a.deadline! > b.deadline! ? 1 : a.title.localeCompare(b.title)));
  }, [tasks, lastVisibleIso]);

  // Thin wrapper over the shared MilestoneCardView (extracted to module scope so the focus
  // page's "Coming Up" renders the identical purple-tint two-line card). Call sites unchanged.
  const MilestoneCard = ({ task, showDate, categoryDimmed = false }: { task: Task; showDate: boolean; categoryDimmed?: boolean }) => (
    <MilestoneCardView
      task={task}
      projects={projects}
      clients={clients}
      showDate={showDate}
      categoryDimmed={categoryDimmed}
      onEdit={() => onEditTask(task)}
      onQuickEdit={onQuickEditTask ? () => onQuickEditTask(task) : undefined}
      onAddSibling={() => onAddSiblingTask(task)}
    />
  );

  const formatRange = () => {
    // Range covers the five DATE columns (the Next Week column sits beyond it).
    const end = addDaysToDate(weekStart, 4);
    const mon = weekStart.toLocaleDateString('en-US', { month: 'short' });
    const monEnd = end.toLocaleDateString('en-US', { month: 'short' });
    // Use — (em dash) for the range separator. Previous source had UTF-8 mojibake from an
    // editor reinterpreting bytes as Latin-1.
    return mon === monEnd
      ? `${mon} ${weekStart.getDate()}—${end.getDate()}, ${end.getFullYear()}`
      : `${mon} ${weekStart.getDate()} — ${monEnd} ${end.getDate()}, ${end.getFullYear()}`;
  };

  return (
    // h-full + flex-col + overflow-hidden = the calendar fills its parent and never overflows
    // the page. Children are: TopHeader (shrink-0), week-range bar (shrink-0), then the grid
    // (flex-1 min-h-0). Within the grid each day-column has a shrink-0 day-name row and a
    // flex-1 overflow-y-auto body — every column scrolls independently while the day names,
    // week-range bar, and TopHeader stay pinned at the top.
    <div className="h-full flex flex-col" style={{ paddingTop: SPACING.topMargin, paddingBottom: 76 }}>
      <div className="shrink-0">
        <TopHeader viewName="Calendar" />
      </div>
      {/* Week-range navigator — same px-[35px] as TopHeader so it lines up vertically. h-[37px]
          matches the standard header row. DOUBLE carriage-return below so the day-name row
          gets the same paragraph-break gap that column titles in List + Project use. */}
      <div className="shrink-0 flex items-center gap-3 px-[35px] h-[37px]" style={{ marginBottom: SPACING.dcr }}>
        <button onClick={() => setWeekOffset((o) => o - 1)} className="p-1 text-[#656464] hover:text-white transition-colors"><ChevronLeft size={20} /></button>
        <p className="font-['NB_International:Regular',sans-serif] text-white text-[14.333px]">{formatRange()}</p>
        <button onClick={() => setWeekOffset((o) => o + 1)} className="p-1 text-[#656464] hover:text-white transition-colors"><ChevronRight size={20} /></button>
        {weekOffset !== 0 && (
          <button onClick={() => setWeekOffset(0)} className={`${bodyFont} text-[#656464] hover:text-white ml-2 transition-colors`}>Today</button>
        )}
      </div>
      {/* Grid wrapper padding = 35 (TopHeader inset) - 16 (column header's own px-16) so the
          first column's day-name lines up at 35px from the page edge — matching TopHeader.
          flex-1 min-h-0 lets children control their own scroll; overflow-x-auto preserves
          horizontal scroll for narrow viewports (the inner grid keeps min-w-[1400px]). */}
      <div className="flex-1 min-h-0 overflow-x-auto">
      <div className="grid grid-cols-6 gap-0 px-[19px] h-full min-w-[1200px]">
        {days.map((d, i) => {
          const iso = dateToISO(d);
          const isToday = iso === todayIso;
          return (
            <CalendarColumnDroppable key={iso} date={iso}>
              <div className={`shrink-0 h-[37px] flex items-center gap-2 px-[16px] mb-[37px] ${isToday ? 'text-[#8465ff]' : (d.getDay() === 0 || d.getDay() === 6 ? 'text-[#656464]' : 'text-white')}`}>
                <p className="font-['NB_International:Regular',sans-serif]">{dayNameShort(d)}</p>
                <p className={bodyFont}>{d.getDate()}</p>
                {isToday && <p className={bodyFont}>(Today)</p>}
              </div>
              {/* Independent per-column scroll. Coming-Up + per-band stacks live here.
                  CustomScroll supplies the fixed-size pill thumb (the native scrollbar is hidden). */}
              <CustomScroll>
              {/* Coming Up (overflow milestones) moved to the dedicated
                  "Next Week" column — see below after the day-columns map. */}
              {/* Milestones for this day are pinned above their respective category band (Work,
                  Projects, Admin) inside the list-loop below — no longer rendered as a standalone
                  block above all bands. */}
              {listSequence.map((listId) => {
                const label = LIST_TITLES[listId];
                const bucket = tasksForCell(listId, d);
                const items = bucket.map((t) => t.id);
                const isPast = dayOffsetFromToday(d) < 0;
                // Weekends are projects-only by default. Work/Admin sections appear only if they have
                // content for that day, or while a drag is active so the user can drop onto them.
                const isWeekend = d.getDay() === 0 || d.getDay() === 6;
                // Milestones whose effective list matches this band, pinned to the top of it.
                // Effective list = the project's pinned list if set, otherwise the task's own list.
                const dayMilestones = (milestonesByIso[iso] || []).filter((t) => {
                  if (t.projectId) {
                    const proj = projects.find((p) => p.id === t.projectId);
                    if (proj?.list) return proj.list === listId;
                  }
                  return t.list === listId;
                });
                if (isWeekend && listId !== 'projects' && bucket.length === 0 && dayMilestones.length === 0 && !isAnyDragging) return null;
                // Displacement math (mirrors getAnimationProps in list view):
                //  - If active and over are BOTH in this bucket: cards strictly between them slide by ï¿½slotH.
                //  - If active is in a DIFFERENT bucket and over is in this bucket: the over-index card gets
                //    an insertionGap above it, opening the slot the dragged card will land in.
                const aIdx = activeTask ? bucket.findIndex((t) => t.id === activeTask.id) : -1;
                const oIdx = overTask ? bucket.findIndex((t) => t.id === overTask.id) : -1;
                const activeInBucket = aIdx >= 0;
                const overInBucket = oIdx >= 0;
                // Cross-category dim: when a drag is active and the dragged card lives in a
                // different list than this band, every card in this band renders muted (#454545)
                // so the source category and matching drop targets stay visually loud.
                const categoryDimmed = !!activeTask && activeTask.list !== listId;
                return (
                  <CalendarDayDroppable key={listId} id={`cal:${iso}:${listId}`} isEmpty={bucket.length === 0 && dayMilestones.length === 0} className="pb-[37px] last:pb-0">
                    <div className="group/band h-[20px] px-[16px] pb-[6px] flex items-center gap-2 sticky top-0 z-10 bg-[#282828]">
                      <p onClick={scrollBandToTop} className={`${bodyFont} text-[#5e5e5e] cursor-pointer`}>{label}</p>
                      <button
                        type="button"
                        onClick={() => onAddTaskOnDay(listId, iso)}
                        className="opacity-0 group-hover/band:opacity-100 text-[#656464] hover:text-white transition-opacity"
                        aria-label={`Add ${label} task on ${iso}`}
                      >
                        <Plus size={14} />
                      </button>
                    </div>
                    {dayMilestones.length > 0 && dayMilestones.map((t) => <MilestoneCard key={`m-${t.id}`} task={t} showDate={false} categoryDimmed={categoryDimmed} />)}
                    <SortableContext items={items} strategy={verticalListSortingStrategy}>
                        {bucket.map((t, index) => {
                          let displacementOffset = 0;
                          let insertionGap = 0;
                          // CATEGORY GATE: only displace when this cell's list matches the
                          // source task's list. Cards in other categories (Work source dragging
                          // into Projects band of any column) never react — drops route back to
                          // the source list anyway, so feedback should match.
                          const sameCategory = activeTask && activeTask.list === listId;
                          if (sameCategory && activeTask && overTask && t.id !== activeTask.id) {
                            // SOURCE cell (active is here): leave displacement to dnd-kit's
                            // verticalListSortingStrategy. Stacking the external offset on top
                            // doubled the transform and made the source cell feel sticky/jumpy.
                            // DESTINATION cell (active is elsewhere, over is here): dnd-kit
                            // can't displace across SortableContexts, so we open an insertionGap
                            // above the over card so the user sees where the drop will land.
                            if (!activeInBucket && overInBucket && index === oIdx) {
                              insertionGap = activeSlotHeight;
                            }
                          }
                          return (
                            <CalendarCard
                              key={t.id}
                              task={t}
                              cellId={`cal:${iso}:${listId}`}
                              onToggle={() => onToggleTask(t.id)}
                              onRename={(title) => onRenameTask(t.id, title)}
                              onDelete={() => onDeleteTask(t.id)}
                              onEdit={() => onEditTask(t)}
                              onQuickEdit={onQuickEditTask ? () => onQuickEditTask(t) : undefined}
                              onAddSibling={() => onAddSiblingTask(t, iso)}
                              isAnyDragging={isAnyDragging}
                              dimmed={isPast}
                              categoryDimmed={categoryDimmed}
                              projects={projects}
                              clients={clients}
                              displacementOffset={displacementOffset}
                              insertionGap={insertionGap}
                              taskOrder={taskOrder}
                              autoFocusEdit={t.id === newTaskId}
                              stacked
                            />
                          );
                        })}
                    </SortableContext>
                  </CalendarDayDroppable>
                );
              })}
              </CustomScroll>
            </CalendarColumnDroppable>
          );
        })}
        {(() => {
          // ── 6th column: NEXT WEEK ──────────────────────────────────────────
          // Now a FULL calendar column just like the day columns: broken into the
          // three category bands (Admin / Work / Projects), each a real drop target
          // with draggable cards + displacement. Dropping a card here schedules it
          // for next Monday (the 'NW@' token tells handleDragEnd to set the deadline
          // even for undated queue tasks) and lands it at the top of its category
          // band (off-category-above rule in the drop handler).
          const lastD = days[days.length - 1];
          const delta = ((8 - lastD.getDay()) % 7) || 7; // first Monday after the window
          const nwStart = addDaysToDate(lastD, delta);
          const nwStartIso = dateToISO(nwStart);
          const nwEndIso = dateToISO(addDaysToDate(nwStart, 6));
          const nwToken = `NW@${nwStartIso}`;
          // Ids already shown in the five visible day cells — excluded from the queue
          // remainder so a task isn't listed twice.
          const placedIds = new Set<string>();
          for (const vd of days) {
            const vIso = dateToISO(vd);
            for (const l of listSequence) for (const t of (distributionByCell[`${vIso}:${l}`] || [])) placedIds.add(t.id);
          }
          // Per-list next-week bucket: tasks DATED inside next week, plus the undated
          // queue remainder for that list. Milestones are pinned above (dayMilestones).
          const nwBucketFor = (listId: ListId) => tasks
            .filter((t) => !t.completed && t.type !== 'scheduled' && t.list === listId
              && ((t.deadline && t.deadline >= nwStartIso && t.deadline <= nwEndIso)
                  || (!t.deadline && (t.section === 'next' || t.section === 'inbox') && !placedIds.has(t.id))))
            .sort((a, b) => ((a.deadline || '￿') < (b.deadline || '￿') ? -1 : (a.deadline || '￿') > (b.deadline || '￿') ? 1 : a.order - b.order));
          return (
            <CalendarColumnDroppable key="nextweek" date={nwToken}>
              <div className="shrink-0 h-[37px] flex items-center gap-2 px-[16px] mb-[37px] text-white">
                <p className="font-['NB_International:Regular',sans-serif]">Next Week</p>
              </div>
              <CustomScroll>
                {/* Coming-Up milestones (dated beyond the visible window) stay pinned at the
                    very top — a read-only look-ahead, same as before. */}
                {overflowMilestones.length > 0 && (
                  <div className="mb-[37px]">
                    <div className="h-[20px] px-[16px] flex items-center mb-[6px]">
                      <p className={`${bodyFont} text-[#5e5e5e]`}>Coming Up</p>
                    </div>
                    {overflowMilestones.map((t) => <MilestoneCard key={t.id} task={t} showDate />)}
                  </div>
                )}
                {listSequence.map((listId) => {
                  const label = LIST_TITLES[listId];
                  const bucket = nwBucketFor(listId);
                  const items = bucket.map((t) => t.id);
                  // Milestones dated next week (or beyond, minus the Coming-Up ones already
                  // shown) matched to this band by effective list — pinned above the cards.
                  const bandMilestones = (tasks.filter((t) => {
                    if (t.type !== 'scheduled' || !t.deadline || t.deadline < nwStartIso || t.deadline > nwEndIso) return false;
                    const proj = t.projectId ? projects.find((p) => p.id === t.projectId) : undefined;
                    return (proj?.list ?? t.list) === listId;
                  }));
                  // Displacement — identical logic to the day columns: same-bucket reorder
                  // shifts the between cards; cross-bucket-into-here opens a gap above the
                  // over-card so the drop slot is visible.
                  const aIdx = activeTask ? bucket.findIndex((t) => t.id === activeTask.id) : -1;
                  const oIdx = overTask ? bucket.findIndex((t) => t.id === overTask.id) : -1;
                  const activeInBucket = aIdx >= 0;
                  const overInBucket = oIdx >= 0;
                  const categoryDimmed = !!activeTask && activeTask.list !== listId;
                  const cellId = `cal:${nwToken}:${listId}`;
                  return (
                    <CalendarDayDroppable key={listId} id={cellId} isEmpty={bucket.length === 0 && bandMilestones.length === 0} className="pb-[37px] last:pb-0">
                      <div className="group/band h-[20px] px-[16px] pb-[6px] flex items-center gap-2 sticky top-0 z-10 bg-[#282828]">
                        <p onClick={scrollBandToTop} className={`${bodyFont} text-[#5e5e5e] cursor-pointer`}>{label}</p>
                        <button
                          type="button"
                          onClick={() => onAddTaskOnDay(listId, nwStartIso)}
                          className="opacity-0 group-hover/band:opacity-100 text-[#656464] hover:text-white transition-opacity"
                          aria-label={`Add ${label} task next week`}
                        >
                          <Plus size={14} />
                        </button>
                      </div>
                      {bandMilestones.length > 0 && bandMilestones.map((t) => <MilestoneCard key={`m-${t.id}`} task={t} showDate categoryDimmed={categoryDimmed} />)}
                      <SortableContext items={items} strategy={verticalListSortingStrategy}>
                        {bucket.map((t, index) => {
                          let displacementOffset = 0;
                          let insertionGap = 0;
                          const sameCategory = activeTask && activeTask.list === listId;
                          if (sameCategory && activeTask && overTask && t.id !== activeTask.id) {
                            if (!activeInBucket && overInBucket && index === oIdx) {
                              insertionGap = activeSlotHeight;
                            }
                          }
                          return (
                            <CalendarCard
                              key={t.id}
                              task={t}
                              cellId={cellId}
                              onToggle={() => onToggleTask(t.id)}
                              onRename={(title) => onRenameTask(t.id, title)}
                              onDelete={() => onDeleteTask(t.id)}
                              onEdit={() => onEditTask(t)}
                              onQuickEdit={onQuickEditTask ? () => onQuickEditTask(t) : undefined}
                              // NO pinned deadline in Next Week — dating the sibling hoisted it to
                              // the top of the column; undated, it slots in right under its sibling
                              // (addSiblingTask inserts at idx+1 in the section bucket).
                              onAddSibling={() => onAddSiblingTask(t)}
                              isAnyDragging={isAnyDragging}
                              categoryDimmed={categoryDimmed}
                              projects={projects}
                              clients={clients}
                              displacementOffset={displacementOffset}
                              insertionGap={insertionGap}
                              taskOrder={taskOrder}
                              autoFocusEdit={t.id === newTaskId}
                              stacked
                            />
                          );
                        })}
                      </SortableContext>
                    </CalendarDayDroppable>
                  );
                })}
              </CustomScroll>
            </CalendarColumnDroppable>
          );
        })()}
      </div>
      </div>
    </div>
  );
}

// --- BackupSection -----------------------------------------------------------
// Settings sub-block for the Local Backup feature. TWO named slots only:
// "live" (refreshed every 5 min, mirror of now) and "daily" (refreshed only
// when its existing value is older than 24h, your "yesterday" rollback). No
// accumulating history. Plus manual Download / Restore-from-file actions for
// permanent off-machine copies.
function BackupSection({
  liveBackupAt,
  dailyBackupAt,
  onDownload,
  onRestoreFromFile,
  onRestoreFromSlot,
}: {
  liveBackupAt: number | null;
  dailyBackupAt: number | null;
  onDownload: () => void | Promise<void>;
  onRestoreFromFile: (file: File) => Promise<string>;
  onRestoreFromSlot: (slot: 'live' | 'daily') => Promise<string>;
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [status, setStatus] = useState<string>('');
  const formatRelative = (ms: number): string => {
    const diff = Date.now() - ms;
    if (diff < 60_000) return 'just now';
    const m = Math.round(diff / 60_000);
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.round(h / 24);
    return `${d}d ago`;
  };
  const onFilePicked = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // reset so re-picking the same file fires change
    if (!file) return;
    try {
      const msg = await onRestoreFromFile(file);
      setStatus(msg);
    } catch (err) {
      setStatus(`Restore failed: ${(err as Error).message}`);
    }
  };
  const slotRow = (
    label: string,
    sublabel: string,
    at: number | null,
    slot: 'live' | 'daily',
  ) => (
    <div className="flex flex-row items-center gap-3 text-[13px]">
      <div className="flex flex-col">
        <span className="text-white">{label}</span>
        <span className="text-[#656464] text-[12px]">{sublabel}</span>
      </div>
      <div className="ml-auto flex flex-row items-center gap-3">
        <span className="text-[#656464]">
          {at
            ? <>Last refresh: <span className="text-white">{formatRelative(at)}</span></>
            : <>—</>}
        </span>
        <button
          type="button"
          disabled={!at}
          onClick={async () => {
            try {
              const msg = await onRestoreFromSlot(slot);
              setStatus(msg);
            } catch (err) {
              setStatus(`Restore failed: ${(err as Error).message}`);
            }
          }}
          className={`px-3 py-1 rounded-md transition-colors ${at ? 'bg-[#1f1f1f] hover:bg-[#262626] text-white' : 'bg-[#1f1f1f] text-[#656464] cursor-not-allowed'}`}
        >
          Restore
        </button>
      </div>
    </div>
  );
  return (
    <div className="flex flex-col gap-3">
      {/* Two-slot summary: the redundant live mirror + the 24-hour rolling copy. */}
      <div className="flex flex-col gap-2">
        {slotRow('Live mirror', 'Refreshed every 5 minutes', liveBackupAt, 'live')}
        {slotRow('24-hour rolling copy', 'Refreshed only when older than 24 hours', dailyBackupAt, 'daily')}
      </div>
      {/* Manual download / restore-from-file for off-machine copies. */}
      <div className="flex flex-row gap-3 items-center text-[13px]">
        <button
          type="button"
          onClick={async () => { await onDownload(); setStatus('Backup downloaded.'); }}
          className="px-3 py-1 rounded-md bg-[#1f1f1f] hover:bg-[#262626] text-white transition-colors"
        >
          Download backup
        </button>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="px-3 py-1 rounded-md bg-[#1f1f1f] hover:bg-[#262626] text-white transition-colors"
        >
          Restore from file
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          onChange={onFilePicked}
          className="hidden"
        />
      </div>
      {status && <p className="text-[#8465ff] text-[13px]">{status}</p>}
    </div>
  );
}

function SettingsMode({ people, newId, onAddPerson, onRenamePerson, onRenamePersonShort, onDeletePerson, currentUserShort, onSetCurrentUser, taskOrder, onSetTaskOrder, listSequence, onSetListSequence, tomorrowEnabled, onSetTomorrowEnabled, caseMode, onSetCaseMode, trashedTasks, completedTasks, projects, clients, onUntrashTask, onPurgeTask, onToggleTask, onPurgeEmptyProjects, onListClosedOutProjects, onRemoveProjectsByIds, onListStragglerProjects, onDeleteStragglerProject, liveBackupAt, dailyBackupAt, onDownloadBackup, onRestoreFromFile, onRestoreFromSlot }: {
  people: Person[]; newId: string | null;
  onAddPerson: () => void;
  onRenamePerson: (id: string, name: string) => void;
  onRenamePersonShort: (id: string, short: string) => void;
  onDeletePerson: (id: string) => void;
  currentUserShort: string;
  onSetCurrentUser: (short: string) => void;
  taskOrder: TaskOrder;
  onSetTaskOrder: (v: TaskOrder) => void;
  listSequence: ListId[];
  onSetListSequence: (v: ListId[]) => void;
  onPurgeEmptyProjects: () => number;
  onListClosedOutProjects: () => { id: string; name: string }[];
  onRemoveProjectsByIds: (ids: string[]) => number;
  onListStragglerProjects: () => { id: string; name: string; taskCount: number }[];
  onDeleteStragglerProject: (id: string) => void;
  tomorrowEnabled: boolean;
  onSetTomorrowEnabled: (v: boolean) => void;
  caseMode: 'off' | 'title';
  onSetCaseMode: (v: 'off' | 'title') => void;
  trashedTasks: Task[];
  completedTasks: Task[];
  projects: Project[];
  clients: Client[];
  onUntrashTask: (id: string) => void;
  onPurgeTask: (id: string) => void;
  onToggleTask: (id: string) => void;
  liveBackupAt: number | null;
  dailyBackupAt: number | null;
  onDownloadBackup: () => void | Promise<void>;
  onRestoreFromFile: (file: File) => Promise<string>;
  onRestoreFromSlot: (slot: 'live' | 'daily') => Promise<string>;
}) {
  const bodyFont = "font-['Univers_BQ:55_Regular',sans-serif] leading-[normal] not-italic text-[14px] whitespace-nowrap";
  const [purgeMsg, setPurgeMsg] = useState('');
  // Two-click confirm for "Remove closed-out projects": holds the ids surfaced on the first
  // click until the second click removes them (or another action clears it).
  const [closedOutIds, setClosedOutIds] = useState<string[] | null>(null);
  // Straggler-project manager: null = collapsed; array = the client-less projects to show with
  // per-row delete. Kept in local state so deleting one drops it from the list immediately
  // (the App-side refs update a tick later).
  const [stragglers, setStragglers] = useState<{ id: string; name: string; taskCount: number }[] | null>(null);
  return (
    // Fixed header + SCROLLING body. Previously the whole page was one non-scrolling block, so
    // on a viewport shorter than the settings content (~1300px) the lower sections — Local
    // Backup, People, Clients — were clipped below the fold with no way to reach them.
    <div className="h-full flex flex-col" style={{ paddingTop: SPACING.topMargin, paddingBottom: 76 }}>
      <div className="shrink-0"><TopHeader viewName="Settings" /></div>
      <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="flex gap-0 pb-[106px]">
      <div className="flex-1 min-w-[280px]">
        <div className="group h-[37px] w-full box-border flex flex-row gap-2 items-center px-[35px] mb-0">
          <p className="font-['NB_International:Regular',sans-serif] text-white text-[14.333px]">I am</p>
        </div>
        <div className="px-[31px] mb-[37px] flex flex-wrap gap-2">
          {people.map((p) => {
            const active = p.short === currentUserShort;
            return (
              <button key={p.id} type="button" onClick={() => onSetCurrentUser(p.short)} className={`px-3 py-1 rounded-full text-[13px] transition-colors ${active ? 'bg-[#7363FF] text-white' : 'bg-[#1f1f1f] text-[#ccc] hover:bg-[#333]'}`}>
                {p.name || '(unnamed)'} <span className="opacity-70">({p.short || '?'})</span>
              </button>
            );
          })}
          {people.length === 0 && <span className="text-[#666] text-[12px]">Add a person below first.</span>}
        </div>
        {/* Task display order — three options. Persisted per-browser via localStorage. */}
        <div className="group h-[37px] w-full box-border flex flex-row gap-2 items-center px-[35px] mb-0">
          <p className="font-['NB_International:Regular',sans-serif] text-white text-[14.333px]">Task Order</p>
        </div>
        <div className="px-[31px] mb-[37px] flex flex-col gap-2">
          {([
            { id: 'cpt' as TaskOrder, parts: ['Client - Project', 'Task'] as const },
            { id: 'ptc' as TaskOrder, parts: ['Project', 'Task', 'Client'] as const },
            { id: 'tcp' as TaskOrder, parts: ['Task', 'Client - Project'] as const },
          ]).map((opt) => {
            const active = taskOrder === opt.id;
            return (
              <button key={opt.id} type="button" onClick={() => onSetTaskOrder(opt.id)} className={`text-left text-[13px] transition-colors ${active ? 'text-[#8465ff] font-bold' : 'hover:text-white'}`}>
                {opt.parts.map((part, i) => (
                  <Fragment key={i}>
                    {i > 0 && <span>{'\u00A0\u00A0\u00A0'}</span>}
                    {/* When inactive, the "Task" word stays white; the other parts (project/client
                        labels) read as gray. When active, the active button color (purple) wins. */}
                    <span className={active ? '' : (part === 'Task' ? 'text-white' : 'text-[#656464]')}>
                      {part}
                    </span>
                  </Fragment>
                ))}
              </button>
            );
          })}
        </div>
        {/* Section sequence — the UNIVERSAL Work / Projects / Admin / Personal order. One
            setting drives every surface: list-view columns, dashboard-stack blocks, project-view
            columns, calendar bands (and their queue-fill priority), and the focus page's
            day columns. */}
        <div className="group h-[37px] w-full box-border flex flex-row gap-2 items-center px-[35px] mb-0">
          <p className="font-['NB_International:Regular',sans-serif] text-white text-[14.333px]">Section Sequence</p>
        </div>
        <div className="px-[31px] mb-[37px] flex flex-col gap-2">
          {/* Per-category up/down reorder — scales to any number of categories (now four,
              including Personal). This order drives every surface. */}
          {listSequence.map((l, i) => (
            <div key={l} className="flex flex-row items-center gap-3 h-[26px]">
              <span className="text-[13px] text-white w-[90px]">{LIST_TITLES[l]}</span>
              <button type="button" disabled={i === 0} onClick={() => { const n = [...listSequence]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; onSetListSequence(n); }} className="text-[14px] leading-none text-[#656464] hover:text-white disabled:opacity-20 disabled:hover:text-[#656464] transition-colors" aria-label={`Move ${LIST_TITLES[l]} up`}>&uarr;</button>
              <button type="button" disabled={i === listSequence.length - 1} onClick={() => { const n = [...listSequence]; [n[i + 1], n[i]] = [n[i], n[i + 1]]; onSetListSequence(n); }} className="text-[14px] leading-none text-[#656464] hover:text-white disabled:opacity-20 disabled:hover:text-[#656464] transition-colors" aria-label={`Move ${LIST_TITLES[l]} down`}>&darr;</button>
            </div>
          ))}
        </div>
        {/* Quick Window Shortcut — the global key combo that summons the floating focus PIP. */}
        <div className="group h-[37px] w-full box-border flex flex-row gap-2 items-center px-[35px] mb-0">
          <p className="font-['NB_International:Regular',sans-serif] text-white text-[14.333px]">Quick Window Shortcut</p>
        </div>
        <div className="px-[31px] mb-[37px] flex flex-col gap-2 items-start">
          <PipShortcutSetting />
        </div>
        {/* Maintenance — clean up "ghost" projects (blank name, no tasks). Runs
            automatically 5s after load, but this triggers it on demand. */}
        <div className="group h-[37px] w-full box-border flex flex-row gap-2 items-center px-[35px] mb-0">
          <p className="font-['NB_International:Regular',sans-serif] text-white text-[14.333px]">Maintenance</p>
        </div>
        <div className="px-[31px] mb-[37px] flex flex-col gap-2 items-start">
          <button
            type="button"
            onClick={() => { const n = onPurgeEmptyProjects(); setPurgeMsg(n > 0 ? `Removed ${n} empty project${n === 1 ? '' : 's'}.` : 'No empty projects found.'); }}
            className="text-[13px] text-[#656464] hover:text-white transition-colors"
          >
            Clean up empty projects
          </button>
          {/* Remove NAMED but task-less projects — the "closed-out ghosts" (Mindmap, Dome-0,
              etc.) the auto-purge leaves alone. Two-click: first lists exactly which projects
              have zero tasks; second removes them. Anything with tasks, or that has
              sub-projects, is never listed, so this can't delete live work. */}
          <button
            type="button"
            onClick={() => {
              if (closedOutIds) { const n = onRemoveProjectsByIds(closedOutIds); setPurgeMsg(`Removed ${n} closed-out project${n === 1 ? '' : 's'}.`); setClosedOutIds(null); return; }
              const list = onListClosedOutProjects();
              if (!list.length) { setPurgeMsg('No closed-out projects — every named project has tasks.'); return; }
              setClosedOutIds(list.map((p) => p.id));
              setPurgeMsg(`${list.length} project${list.length === 1 ? '' : 's'} with no tasks: ${list.map((p) => p.name).join(', ')}. Click again to remove.`);
            }}
            className={`text-[13px] transition-colors ${closedOutIds ? 'text-[#8465ff] font-bold' : 'text-[#656464] hover:text-white'}`}
          >
            {closedOutIds ? `Confirm — remove ${closedOutIds.length} closed-out project${closedOutIds.length === 1 ? '' : 's'}` : 'Remove closed-out projects'}
          </button>
          {purgeMsg && <p className="text-[#8465ff] text-[12px]">{purgeMsg}</p>}
          {/* Straggler manager — the client-less projects piling up at the bottom of the lists
              (Mindmap, Dome-0, Project Dash, Moving…). Shows each with its live task count so
              you know what it is, and a Delete that removes the project + tucks any tasks into
              the recoverable Trash. Works whether or not the project still has tasks. */}
          <button
            type="button"
            onClick={() => setStragglers((cur) => (cur ? null : onListStragglerProjects()))}
            className="text-[13px] text-[#656464] hover:text-white transition-colors mt-1"
          >
            {stragglers ? 'Hide straggler projects' : 'Manage straggler projects (no client)'}
          </button>
          {stragglers && stragglers.length === 0 && (
            <p className="text-[#656464] text-[12px]">No straggler projects — every project has a client.</p>
          )}
          {stragglers && stragglers.length > 0 && (
            <div className="flex flex-col gap-1 w-full max-w-[420px]">
              {stragglers.map((s) => (
                <div key={s.id} className="flex flex-row items-center justify-between gap-3 py-[3px] border-b border-white/[0.06]">
                  <span className="text-[13px] text-white truncate">{s.name} <span className="text-[#656464]">· {s.taskCount} task{s.taskCount === 1 ? '' : 's'}</span></span>
                  <button
                    type="button"
                    onClick={() => { onDeleteStragglerProject(s.id); setStragglers((prev) => (prev ? prev.filter((x) => x.id !== s.id) : prev)); setPurgeMsg(`Removed "${s.name}"${s.taskCount > 0 ? ` — ${s.taskCount} task${s.taskCount === 1 ? '' : 's'} moved to Trash` : ''}.`); }}
                    className="shrink-0 text-[12px] text-[#656464] hover:text-[#ff6b6b] transition-colors"
                  >
                    Delete
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
        {/* Tomorrow section toggle. Off → tomorrow tasks visually fall back into Next (data
            preserved). The midnight refill keeps Tomorrow at 5 tasks even while hidden — flip
            back on and you see the buffer ready to go. */}
        <div className="group h-[37px] w-full box-border flex flex-row gap-2 items-center px-[35px] mb-0">
          <p className="font-['NB_International:Regular',sans-serif] text-white text-[14.333px]">Tomorrow Section</p>
        </div>
        <div className="px-[31px] mb-[37px] flex flex-row gap-4">
          <button type="button" onClick={() => onSetTomorrowEnabled(true)} className={`text-[13px] transition-colors ${tomorrowEnabled ? 'text-[#8465ff] font-bold' : 'text-[#656464] hover:text-white'}`}>On</button>
          <button type="button" onClick={() => onSetTomorrowEnabled(false)} className={`text-[13px] transition-colors ${!tomorrowEnabled ? 'text-[#8465ff] font-bold' : 'text-[#656464] hover:text-white'}`}>Off</button>
        </div>
        {/* Title-case auto-correct. 2 seconds after the user blurs a title, rewrite to title
            case. Brand-name vocabulary + ALL-CAPS acronyms are preserved; small words ("and",
            "the", "of"…) stay lowercase. Off → leave titles exactly as typed. */}
        <div className="group h-[37px] w-full box-border flex flex-row gap-2 items-center px-[35px] mb-0">
          <p className="font-['NB_International:Regular',sans-serif] text-white text-[14.333px]">Title Case Auto-Correct</p>
        </div>
        <div className="px-[31px] mb-[37px] flex flex-row gap-4">
          <button type="button" onClick={() => onSetCaseMode('off')} className={`text-[13px] transition-colors ${caseMode === 'off' ? 'text-[#8465ff] font-bold' : 'text-[#656464] hover:text-white'}`}>Off</button>
          <button type="button" onClick={() => onSetCaseMode('title')} className={`text-[13px] transition-colors ${caseMode === 'title' ? 'text-[#8465ff] font-bold' : 'text-[#656464] hover:text-white'}`}>On</button>
        </div>
        {/* --- About / Version --------------------------------------------
            Shows which JS bundle is currently running (the in-memory webview
            doesn't auto-poll for new deploys). The Reload button does a
            window.location.reload() so the user can pull a fresh build
            from GitHub Pages without quitting the app. The dot color hints
            at how recent the build is — green (<1d), yellow (<7d), red
            (older). Build time is the moment Vite produced the bundle. */}
        <div className="group h-[37px] w-full box-border flex flex-row gap-2 items-center px-[35px] mb-0">
          <p className="font-['NB_International:Regular',sans-serif] text-white text-[14.333px]">About</p>
        </div>
        <div className="px-[31px] mb-[37px] flex flex-col gap-2 text-[13px]">
          {(() => {
            const buildDate = new Date(__BUILD_TIME__);
            const ageMs = Date.now() - buildDate.getTime();
            const ageDays = ageMs / (24 * 60 * 60 * 1000);
            const dotColor = ageDays < 1 ? '#7ED957' : ageDays < 7 ? '#E0C200' : '#FF7171';
            const ageLabel =
              ageMs < 60_000 ? 'just now'
              : ageMs < 60 * 60_000 ? `${Math.round(ageMs / 60_000)}m ago`
              : ageMs < 24 * 60 * 60_000 ? `${Math.round(ageMs / (60 * 60_000))}h ago`
              : `${Math.round(ageDays)}d ago`;
            return (
              <>
                <div className="flex flex-row items-center gap-3">
                  <span className="inline-block w-[8px] h-[8px] rounded-full" style={{ backgroundColor: dotColor }} />
                  <span className="text-white">Ctrl-Project v{__APP_VERSION__}</span>
                  <span className="text-[#656464]">built {ageLabel} ({buildDate.toLocaleString()})</span>
                </div>
                <div className="flex flex-row items-center gap-3">
                  <button
                    type="button"
                    onClick={() => window.location.reload()}
                    className="px-3 py-1 rounded-md bg-[#1f1f1f] hover:bg-[#262626] text-white transition-colors"
                  >
                    Reload to latest
                  </button>
                  <span className="text-[#656464] text-[12px]">
                    Pulls a fresh build from the server. Use this if you've left the app open during a deploy.
                  </span>
                </div>
              </>
            );
          })()}
        </div>
        {/* --- Local Backup --------------------------------------------------
            Auto-snapshot every 5 min into IndexedDB (rolling 20). The download
            button writes the current state to disk as JSON; restore reads a
            JSON file (or picks one of the IDB-stored snapshots) and overwrites
            the room with it. Supabase image blobs are NOT in the JSON — only
            their URLs — so a full disaster recovery means: keep this JSON +
            don't wipe the Supabase bucket. */}
        <div className="group h-[37px] w-full box-border flex flex-row gap-2 items-center px-[35px] mb-0">
          <p className="font-['NB_International:Regular',sans-serif] text-white text-[14.333px]">Local Backup</p>
        </div>
        <div className="px-[31px] mb-[37px] flex flex-col gap-2">
          <BackupSection
            liveBackupAt={liveBackupAt}
            dailyBackupAt={dailyBackupAt}
            onDownload={onDownloadBackup}
            onRestoreFromFile={onRestoreFromFile}
            onRestoreFromSlot={onRestoreFromSlot}
          />
        </div>
        <div className="group h-[37px] w-full box-border flex flex-row gap-2 items-center px-[35px] mb-[37px]">
          <p className="font-['NB_International:Regular',sans-serif] text-white text-[14.333px]">People</p>
          <AddPlus onClick={onAddPerson} />
        </div>
        {people.map((p) => (
          <SettingsRow key={p.id}>
            <span className="inline-flex items-baseline">
              <EditableText value={p.name} onChange={(v) => onRenamePerson(p.id, v)} className={`${bodyFont} text-white`} autoFocus={p.id === newId} placeholder="New Person" />
              {p.short && (
                <>
                  <span className="w-[6px]" />
                  <ShortInBrackets value={p.short} onChange={(v) => onRenamePersonShort(p.id, v)} />
                </>
              )}
            </span>
            <TrashBtn onClick={() => onDeletePerson(p.id)} />
          </SettingsRow>
        ))}
      </div>
      {/* Spacer column to keep the existing People column at left and push Trash/Completed right. */}
      <div className="flex-1 min-w-[280px]" />
      {/* TRASH column — every soft-deleted task lives here until the user revives it (up arrow)
          or purges it (X). Newest-first by trashedAt. */}
      <div className="flex-1 min-w-[280px]">
        <div className="group h-[37px] w-full box-border flex flex-row gap-2 items-center px-[35px] mb-[37px]">
          <p className="font-['NB_International:Regular',sans-serif] text-white text-[14.333px]">Trash</p>
          <p className="text-[#666] text-[12px] ml-2">{trashedTasks.length}</p>
        </div>
        {/* Internal scroll cap so a long trash history doesn't stretch the Settings page
            into a forever-scroll. max-h is calc'd off the viewport so it grows with the
            window. Native scrollbar (settings doesn't use the CustomScroll thumb to keep
            this lightweight). */}
        <div className="overflow-y-auto" style={{ maxHeight: 'calc(100vh - 260px)' }}>
          {trashedTasks.length === 0 && (
            <p className="px-[35px] text-[#666] text-[13px]">Empty.</p>
          )}
          {trashedTasks.map((t) => {
            const proj = t.projectId ? projects.find((p) => p.id === t.projectId) : undefined;
            const cli = (t.clientId ?? proj?.clientId) ? clients.find((c) => c.id === (t.clientId ?? proj?.clientId)) : undefined;
            const ctx = [cli?.short, proj?.name].filter(Boolean).join(' › ');
            return (
              <div key={t.id} className="group h-[37px] w-full box-border flex flex-row gap-2 items-center px-[31px] hover:bg-white/[0.03]">
                {ctx && <p className={`${bodyFont} text-[#656464]`}>{ctx}</p>}
                {ctx && <Arrowhead />}
                <span className={`${bodyFont} text-white`}>{t.title || '(untitled)'}</span>
                <button
                  type="button"
                  onClick={() => onUntrashTask(t.id)}
                  className="ml-auto p-1 opacity-0 group-hover:opacity-100 text-[#5e5e5e] hover:text-white transition-opacity"
                  aria-label="Revive task"
                  title="Revive (un-trash)"
                >
                  <ArrowUp size={14} />
                </button>
                <button
                  type="button"
                  onClick={() => onPurgeTask(t.id)}
                  className="-mr-[10px] p-1 opacity-0 group-hover:opacity-100 text-[#5e5e5e] hover:text-[#FF7171] transition-opacity"
                  aria-label="Permanently delete"
                  title="Permanently delete"
                >
                  <X size={14} />
                </button>
              </div>
            );
          })}
        </div>
      </div>
      {/* COMPLETED column — tasks that have been ticked off and are now hidden from the main
          views (4 AM cleared completions live here permanently; same-day completions appear too).
          Clicking the checkbox un-completes the task — the row stays visible for 10 minutes via
          the revivedAt grace window so a misclick can be undone. */}
      <div className="flex-1 min-w-[280px]">
        <div className="group h-[37px] w-full box-border flex flex-row gap-2 items-center px-[35px] mb-[37px]">
          <p className="font-['NB_International:Regular',sans-serif] text-white text-[14.333px]">Completed</p>
          <p className="text-[#666] text-[12px] ml-2">{completedTasks.length}</p>
        </div>
        {/* Same scroll cap as Trash — long completion history doesn't blow out
            the Settings page height. */}
        <div className="overflow-y-auto" style={{ maxHeight: 'calc(100vh - 260px)' }}>
          {completedTasks.length === 0 && (
            <p className="px-[35px] text-[#666] text-[13px]">Nothing checked off yet.</p>
          )}
          {completedTasks.map((t) => {
            const proj = t.projectId ? projects.find((p) => p.id === t.projectId) : undefined;
            const cli = (t.clientId ?? proj?.clientId) ? clients.find((c) => c.id === (t.clientId ?? proj?.clientId)) : undefined;
            const ctx = [cli?.short, proj?.name].filter(Boolean).join(' › ');
            return (
              <div key={t.id} className="group h-[37px] w-full box-border flex flex-row gap-2 items-center px-[31px] hover:bg-white/[0.03]">
                <TaskCheckbox completed={t.completed} started={t.started} onToggle={() => onToggleTask(t.id)} />
                {ctx && <p className={`${bodyFont} text-[#656464]`}>{ctx}</p>}
                {ctx && <Arrowhead />}
                <span className={`${bodyFont} ${t.completed ? 'text-[#656464] line-through' : 'text-white'}`}>{t.title || '(untitled)'}</span>
                {t.completedDay && <p className="ml-auto text-[#666] text-[12px]">{t.completedDay}</p>}
              </div>
            );
          })}
        </div>
      </div>
      </div>
      </div>
    </div>
  );
}

function SortableProjectRow({ project, listId, onRename, onDelete, onAddTask, autoFocus, isAnyDragging }: { project: Project; listId: ListId; onRename: (id: string, name: string) => void; onDelete: (id: string) => void; onAddTask: (projectId: string, listId: ListId) => void; autoFocus?: boolean; isAnyDragging?: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: `projrow-${listId}-${project.id}`,
    data: { type: 'project', project, listId },
    transition: { duration: 350, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
  });
  const style = { transform: CSS.Transform.toString(transform), transition: isAnyDragging ? 'transform 360ms cubic-bezier(0.22, 1, 0.36, 1)' : 'none', opacity: isDragging ? 0 : 1 };
  const bodyFont = "font-['Univers_BQ:55_Regular',sans-serif] leading-[normal] not-italic text-[14px] whitespace-nowrap";
  return (
    <motion.div
      ref={setNodeRef}
      style={style}
      className="relative group h-[37px] w-full box-border flex flex-row gap-2 items-center px-[31px] overflow-hidden"
      whileHover={!isDragging ? { backgroundColor: "rgba(255, 255, 255, 0.03)", transition: { duration: 0.15 } } : {}}
    >
      <motion.div
        {...attributes}
        {...listeners}
        className="opacity-0 group-hover:opacity-100 cursor-grab active:cursor-grabbing -ml-5 p-1 text-[#5e5e5e] hover:text-white transition-all duration-200"
        whileHover={{ scale: 1.1 }}
        whileTap={{ scale: 0.95 }}
      >
        <svg width="12" height="18" viewBox="0 0 12 18" fill="none">
          <path d="M6 1L6 17" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
          <path d="M2.5 3.5L6 0L9.5 3.5" stroke="currentColor" strokeWidth="1" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M2.5 14.5L6 18L9.5 14.5" stroke="currentColor" strokeWidth="1" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </motion.div>
      <Folder size={12} className="text-[#656464] shrink-0" />
      <EditableText value={project.name} onChange={(v) => onRename(project.id, v)} className={`${bodyFont} text-[#656464]`} autoFocus={autoFocus} placeholder="New Project" />
      <div className="ml-auto -mr-[22px] flex items-center gap-1">
        <button
          type="button"
          onClick={() => onAddTask(project.id, listId)}
          className="p-1 opacity-0 group-hover:opacity-100 text-[#5e5e5e] hover:text-white transition-opacity"
          aria-label="Add task"
        >
          <Plus size={14} />
        </button>
        <button
          type="button"
          onClick={() => onDelete(project.id)}
          className="p-1 opacity-0 group-hover:opacity-100 text-[#5e5e5e] hover:text-white transition-opacity"
          aria-label="Delete project"
        >
          <Trash2 size={14} />
        </button>
      </div>
    </motion.div>
  );
}

function LIndent() {
  return (
    <div className="shrink-0 w-[12px] h-[12px] flex items-end justify-start">
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
        <path d="M2 0 L2 8 L10 8" stroke="#656464" strokeWidth="1" fill="none" strokeLinecap="round" />
      </svg>
    </div>
  );
}

function ProjectTaskRow({ task, listId, onToggle, onRename, onDelete, onEdit, onQuickEdit, onAddSibling, isAnyDragging, autoFocus, collapsed, nonDraggable = false, projects = [], clients = [], showContext = false, displacementOffset = 0, insertionGap = 0, taskOrder = 'ptc', density = 0 }: { task: Task; listId: ListId; onToggle: () => void; onRename: (t: string) => void; onDelete?: () => void; onEdit?: () => void; onQuickEdit?: () => void; onAddSibling?: () => void; isAnyDragging?: boolean; autoFocus?: boolean; collapsed?: boolean; nonDraggable?: boolean; projects?: Project[]; clients?: Client[]; showContext?: boolean; displacementOffset?: number; insertionGap?: number; taskOrder?: TaskOrder; density?: number }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: `projtask-${listId}-${task.id}`,
    data: { type: 'projTask', task, listId },
    transition: { duration: 350, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
  });
  const style = { transform: CSS.Transform.toString(transform), transition: isAnyDragging ? `transform ${MOTION.base}ms ${MOTION.easeOut}` : 'none' };
  const bodyFont = "font-['Univers_BQ:55_Regular',sans-serif] leading-[normal] not-italic text-[14px] whitespace-nowrap";
  const isScheduled = task.type === 'scheduled';
  const isNext = task.section === 'next' || task.section === 'tomorrow';
  const titleColor = isScheduled ? 'text-[#8465ff]' : task.completed ? 'text-[#474747]' : isNext ? 'text-[#a8a8a8]' : 'text-white';
  const metaColor = task.completed ? 'text-[#474747]' : isScheduled ? 'text-[#8465ff]' : 'text-[#656464]';
  const project = showContext && task.projectId ? projects.find((p) => p.id === task.projectId) : undefined;
  // Prefer the task's explicit clientId, fall back to the project's owning client.
  const resolvedClientId = showContext ? (task.clientId ?? project?.clientId) : undefined;
  const client = resolvedClientId ? clients.find((c) => c.id === resolvedClientId) : undefined;
  // Personal-client tasks render the hollow assignee badge regardless of whether project context is shown.
  const ownerProject = task.projectId ? projects.find((p) => p.id === task.projectId) : undefined;
  const isPersonal = (task.clientId ?? ownerProject?.clientId) === PERSONAL_CLIENT_ID || task.list === 'personal';
  return (
    <Displaced offset={displacementOffset} gap={insertionGap} active={!!isAnyDragging}>
    {/* Whole-card drag â€” see SortableTaskItem for the rationale. */}
    {/* Source slot keeps its 37px layout space â€” see SortableTaskItem for rationale. */}
    <motion.div
      ref={setNodeRef}
      style={style}
      data-task-row={task.id}
      {...(nonDraggable ? {} : attributes)}
      {...(nonDraggable ? {} : listeners)}
      className={`relative shrink-0 w-full group overflow-hidden ${nonDraggable ? '' : 'cursor-grab active:cursor-grabbing'}`}
      animate={{ opacity: isDragging ? 0 : 1 }}
      transition={{ opacity: { duration: 0.12, ease: 'easeOut' } }}
      whileHover={!isDragging ? { backgroundColor: "rgba(255, 255, 255, 0.03)", transition: { duration: 0.15 } } : {}}
      onDoubleClick={(e) => { if (onEdit) { e.stopPropagation(); onEdit(); } }}
      onContextMenu={(e) => { if (onQuickEdit) { e.preventDefault(); e.stopPropagation(); onQuickEdit(); } }}
    >
      <div className="box-border flex flex-row gap-2 h-[37px] items-center pl-[43px] pr-[31px] w-full">
        {/* Visual grab affordance only â€” the whole row is the drag handle, this is the icon hint. */}
        {!nonDraggable && (
          <div className="opacity-0 group-hover:opacity-100 -ml-5 p-1 text-[#5e5e5e] transition-opacity duration-200">
            <svg width="12" height="18" viewBox="0 0 12 18" fill="none">
              <path d="M6 1L6 17" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
              <path d="M2.5 3.5L6 0L9.5 3.5" stroke="currentColor" strokeWidth="1" fill="none" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M2.5 14.5L6 18L9.5 14.5" stroke="currentColor" strokeWidth="1" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
        )}
        <LIndent />
        {!isScheduled && <TaskCheckbox completed={task.completed} started={task.started} onToggle={onToggle} />}
        {/* Same density cascade as SortableTaskItem: project truncates, date short, arrow short,
            then hide client → assignees → project. Title and date always visible. */}
        <div className="flex flex-row items-center gap-[4px] min-w-0 overflow-hidden shrink-0">
          {(() => {
            const showClient = !!client && density < 4;
            const showProject = !!project && density < 6;
            const projectTruncate = density >= 1 ? 'truncate min-w-0 max-w-[120px]' : '';
            return taskOrderSlots(taskOrder, showProject, showClient).map((slot, i) => {
              const metaCls = `${bodyFont} ${task.completed ? 'text-[#474747]' : 'text-[#656464]'}`;
              if (slot === 'project' && project) return <p key={`p-${i}`} className={`${metaCls} ${projectTruncate}`}>{project.name}</p>;
              if (slot === 'client' && client) return <p key={`c-${i}`} className={`${bodyFont} ${metaColor}`}>{client.short}</p>;
              if (slot === 'cp' && client && project) return <p key={`cp-${i}`} className={`${metaCls} ${projectTruncate}`}>{client.short}<Arrowhead dim={task.completed} />{project.name}</p>;
              if (slot === 'title') return <EditableText key={`t-${i}`} value={task.title} onChange={onRename} autoFocus={autoFocus} placeholder="New Task" onEnter={onAddSibling} className={`${bodyFont} ${titleColor}`} />;
              return null;
            });
          })()}
        </div>
        {/* Assignee circles hidden at rest, fade in on row-hover (opacity only — reserved
            width keeps the row from shifting). Matches SortableTaskItem. */}
        {density < 5 && task.assignees.length > 0 && (
          <span className="flex flex-row items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
            {task.assignees.map((a, i) => <AssigneeBadge key={`${a}-${i}`} letter={a} tone={isScheduled ? 'scheduled' : 'todo'} hollow={isPersonal} dim={task.completed} />)}
          </span>
        )}
        {task.deadline && (
          <>
            {!isScheduled && <DeadlineArrow dim={task.completed} small={density >= 3} />}
            <p className={`font-['NB_International:Regular',sans-serif] leading-[normal] not-italic text-[14.333px] whitespace-nowrap ${task.completed ? 'text-[#474747]' : isScheduled ? 'text-[#8465ff]' : isLateDeadline(task.deadline) ? 'text-[#FF7171]' : isNext ? 'text-[#a8a8a8]' : 'text-white'}`}>
              {density >= 2 ? formatDeadlineShort(task.deadline) : formatDeadline(task.deadline)}
            </p>
          </>
        )}
        {/* + sits inline immediately after the task info; trash uses ml-auto below to pin to the right edge. */}
        {onAddSibling && (
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onAddSibling(); }}
            className="p-1 opacity-0 group-hover:opacity-100 text-[#5e5e5e] hover:text-white transition-opacity"
            aria-label="Add task in same project"
          >
            <Plus size={14} />
          </button>
        )}
        {onDelete && (
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            className="ml-auto -mr-[22px] p-1 opacity-0 group-hover:opacity-100 text-[#5e5e5e] hover:text-white transition-opacity"
            aria-label="Delete task"
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>
    </motion.div>
    </Displaced>
  );
}

type StorageKey = 'tasks' | 'projects' | 'clients' | 'people';

function useStorageList<K extends StorageKey, T>(key: K) {
  const value = useStorage((root) => (root as any)[key]) as T[];
  const setter = useMutation(({ storage }, updater: T[] | ((prev: T[]) => T[])) => {
    const current = storage.get(key as any) as T[];
    const next = typeof updater === 'function' ? (updater as (p: T[]) => T[])(current) : updater;
    storage.set(key as any, next as any);
  }, []);
  return [value, setter] as const;
}

// Record<string, T> persisted in Liveblocks Storage. Same setter shape as useStorageList:
// pass a new Record OR an updater function. Used for focus-mode briefs / subtasks / images /
// references where the keys are dynamic (project ids + task ids) rather than a fixed list.
// Image binaries live in Supabase Storage (see src/supabase.ts) — Liveblocks holds only
// metadata + the hosted URL. URLs are tiny (~80 bytes) so they fit comfortably inside the
// Record-backed focusImages key, and uploads sync across collaborators automatically since
// every client just hands the URL back to <img>. Legacy dataUrl + localStorage paths are
// kept for rooms that pre-date the migration so old images still display.
const FOCUS_IMG_PREFIX = 'focus-img-';
function getImageDataLocal(id: string): string | null {
  try { return localStorage.getItem(FOCUS_IMG_PREFIX + id); }
  catch { return null; }
}
function removeImageDataLocal(id: string) {
  try { localStorage.removeItem(FOCUS_IMG_PREFIX + id); } catch { /* noop */ }
}
function resolveImageSrc(img: { id: string; url?: string; dataUrl?: string }): string {
  // Priority: hosted URL (Supabase) → legacy localStorage → legacy Liveblocks dataUrl.
  return img.url || getImageDataLocal(img.id) || img.dataUrl || '';
}

type StorageRecordKey = 'focusBriefs' | 'focusSubtasks' | 'focusImages' | 'focusReferences' | 'focusImageFolders';
function useStorageRecord<K extends StorageRecordKey, T>(key: K) {
  const value = useStorage((root) => (root as any)[key]) as Record<string, T> | null;
  const setter = useMutation(({ storage }, updater: Record<string, T> | ((prev: Record<string, T>) => Record<string, T>)) => {
    const current = (storage.get(key as any) as Record<string, T>) ?? {};
    const next = typeof updater === 'function' ? (updater as (p: Record<string, T>) => Record<string, T>)(current) : updater;
    // Wipe-protection: if `current` had content and `next` is empty {}, refuse the write —
    // that's almost always an updater that read stale state during a reload race or HMR
    // remount, and accepting it would silently delete every persisted entry. The legitimate
    // empty case (deleting the very last entry) still works because then `current` is also
    // already at one entry, and the updater returns `{ key: [] }`, not `{}`.
    const currentSize = Object.keys(current).length;
    const nextSize = Object.keys(next).length;
    if (currentSize > 0 && nextSize === 0) {
      console.warn(`[useStorageRecord] Refusing to wipe '${key}' (had ${currentSize} entries, updater returned empty)`);
      return;
    }
    storage.set(key as any, next as any);
  }, []);
  return [value ?? ({} as Record<string, T>), setter] as const;
}

// useFocusImagesV2 removed — Option B (LiveMap-backed image storage) ran into write-time
// conflicts with rooms that pre-dated the schema change. Falling back to Option A
// (Liveblocks holds metadata, browser localStorage holds the data URLs) until we sort
// out the lazy-init path on existing rooms.

// ─── TaskQuickEdit ────────────────────────────────────────────────────────────
// Right-side panel that opens on double-click (edit mode: stays open) or right-click
// (quick mode: closes after one change). Every selection auto-saves through onUpdateTask
// — there's no Save button. Click off (the dim overlay) to close.
//
// Sections, top to bottom: task preview row · type · list · client · project (filtered
// by selected client) · assignees · date quick-picks · month calendar.
function TaskQuickEdit({
  task, projects, clients, people, mode, anchor, newId,
  onClose, onUpdateTask, onAddProject, onAddClient, onAddPerson,
  onRenameClient, onRenameProject, onRenamePerson,
  onDeleteClient, onDeleteProject, onDeletePerson,
  projectListOf, onPinProjectList,
}: {
  task: Task;
  projects: Project[]; clients: Client[]; people: Person[];
  mode: 'edit' | 'quick';
  // anchor: { x, width } positions the panel over a specific column. null/undefined = centered.
  anchor?: { x: number; width: number } | null;
  // Id of an entity that was just created via a + button — that entity renders as an inline
  // EditableText with placeholder + autofocus instead of a regular Pill.
  newId?: string | null;
  onClose: () => void;
  onUpdateTask: (id: string, patch: Partial<Omit<Task, 'id' | 'order'>>) => void;
  onAddProject: (p: Omit<Project, 'id'>) => void;
  onAddClient: () => void;
  onAddPerson: () => void;
  onRenameClient: (id: string, name: string) => void;
  onRenameProject: (id: string, name: string) => void;
  onRenamePerson: (id: string, name: string) => void;
  // Delete callbacks — used when a freshly-created entity is left empty (user clicked + but
  // didn't type anything). The entity is removed instead of leaving a blank pill behind.
  onDeleteClient: (id: string) => void;
  onDeleteProject: (id: string) => void;
  onDeletePerson: (id: string) => void;
  // Effective list of a project (pinned list, else dominant task list, else 'projects').
  // Drives the contextual project picker: pick the LIST first, and the project options
  // narrow to projects that actually live in that list — no more House/Family-style admin
  // projects leaking into every picker.
  projectListOf: (id: string) => ListId;
  // Picking a project for a task PERMANENTLY pins an unpinned project to the task's list,
  // so the association sticks ("personal / financial / car are part of admin — they should
  // always be marked as that").
  onPinProjectList: (id: string, list: ListId) => void;
}) {
  // Auto-disambiguate initials: if two people share a first letter, both render with their
  // first two letters (so the badge becomes a small pill). Falls back to 3+ chars on triple
  // collisions. Returned map: person.id → display short.
  const displayShorts = (() => {
    const map: Record<string, string> = {};
    for (const p of people) {
      let len = 1;
      let candidate = (p.short || p.name || '?').substring(0, len).toUpperCase();
      const others = people.filter((o) => o.id !== p.id);
      while (len < 4 && others.some((o) => (o.short || o.name || '?').substring(0, len).toUpperCase() === candidate)) {
        len++;
        candidate = (p.short || p.name || '?').substring(0, len).toUpperCase();
      }
      map[p.id] = candidate;
    }
    return map;
  })();
  // Auto-apply: write through to storage on every change. In quick mode also dismiss.
  const apply = (patch: Partial<Omit<Task, 'id' | 'order'>>) => {
    onUpdateTask(task.id, patch);
    if (mode === 'quick') onClose();
  };
  // Resources are toggle-only and never close the panel — picking assignees is naturally a
  // multi-select operation, so quick-mode auto-close would feel jarring.
  const applyAssignees = (patch: Partial<Omit<Task, 'id' | 'order'>>) => {
    onUpdateTask(task.id, patch);
  };
  const ownerProject = task.projectId ? projects.find((p) => p.id === task.projectId) : undefined;
  const resolvedClientId = task.clientId ?? ownerProject?.clientId ?? '';
  const sortedClients = [...clients].sort((a, b) => {
    if (a.id === PERSONAL_CLIENT_ID) return -1;
    if (b.id === PERSONAL_CLIENT_ID) return 1;
    return a.name.localeCompare(b.name);
  });
  // Contextual project options: client match AND list match. A project counts as belonging
  // to the task's current list via projectListOf (pin → dominant tasks → 'projects' home).
  // The currently-assigned project always stays listed so an existing link never renders
  // as a phantom "nothing selected".
  const projectsForClient = resolvedClientId
    ? projects.filter((p) => p.clientId === resolvedClientId && (projectListOf(p.id) === task.list || p.id === task.projectId || p.id === newId))
    : [];
  const client = resolvedClientId ? clients.find((c) => c.id === resolvedClientId) : undefined;
  const isMilestone = task.type === 'scheduled';
  const todayIso = todayISO();
  const tomorrowIso = (() => { const d = new Date(); d.setDate(d.getDate() + 1); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; })();
  const nextWeekIso = (() => { const d = new Date(); d.setDate(d.getDate() + 7); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; })();

  // Pill (default): bold-white when active, dim-gray otherwise. Used for list / client / project / etc.
  const Pill = ({ active, onClick, children }: { active?: boolean; onClick: () => void; children: React.ReactNode }) => (
    <button onClick={onClick} className={`text-[14px] font-['Untitled_Sans',sans-serif] whitespace-nowrap transition-colors ${active ? 'text-white font-bold' : 'text-[#656464] hover:text-white'}`}>{children}</button>
  );
  // PillType: same shape, but uses purple when active. Reserved for the Task / Milestone toggle —
  // singling out the type as the most "categorical" decision visually.
  const PillType = ({ active, onClick, children }: { active?: boolean; onClick: () => void; children: React.ReactNode }) => (
    <button onClick={onClick} className={`text-[14px] font-['Untitled_Sans',sans-serif] whitespace-nowrap transition-colors ${active ? 'text-[#8465ff] font-bold' : 'text-[#656464] hover:text-white'}`}>{children}</button>
  );
  const PlusBtn = ({ onClick }: { onClick: () => void }) => (
    <button onClick={onClick} className="text-[#656464] hover:text-white transition-colors p-0" aria-label="Add"><Plus size={14} /></button>
  );

  // Calendar: simple month view with the deadline highlighted in purple.
  const [calMonth, setCalMonth] = useState(() => {
    const d = task.deadline ? new Date(task.deadline + 'T00:00:00') : new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const monthLabel = calMonth.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' });
  const firstDow = calMonth.getDay();
  const daysInMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() + 1, 0).getDate();
  const cells: { date: Date | null; iso: string | null; inMonth: boolean }[] = [];
  for (let i = 0; i < firstDow; i++) {
    const d = new Date(calMonth);
    d.setDate(-(firstDow - 1 - i));
    cells.push({ date: d, iso: dateToISO(d), inMonth: false });
  }
  for (let i = 1; i <= daysInMonth; i++) {
    const d = new Date(calMonth.getFullYear(), calMonth.getMonth(), i);
    cells.push({ date: d, iso: dateToISO(d), inMonth: true });
  }
  while (cells.length % 7 !== 0) {
    const d = new Date(calMonth);
    d.setMonth(d.getMonth() + 1);
    d.setDate(cells.length - firstDow - daysInMonth + 1);
    cells.push({ date: d, iso: dateToISO(d), inMonth: false });
  }

  // Click-off-to-close: the outer overlay catches clicks; the inner panel stops propagation.
  return (
    <motion.div
      className="fixed inset-0 z-50 bg-black/45"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      onClick={onClose}
      onContextMenu={(e) => { e.preventDefault(); onClose(); }}
    >
      <motion.div
        className="absolute top-0 h-full w-[440px] bg-[#1f1f1f] flex flex-col gap-[37px] overflow-y-auto pt-[106px]"
        // Position: when an anchor (column rect) is given, place panel over that column. Otherwise
        // center horizontally with calc() (using transform would conflict with framer's y-anim).
        style={anchor ? { left: Math.max(0, Math.min(anchor.x, window.innerWidth - 440)) } : { left: 'calc(50% - 220px)' }}
        initial={{ opacity: 0, y: -16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -16 }}
        transition={{ type: 'spring', stiffness: 320, damping: 36, mass: 0.7 }}
        onClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.stopPropagation()}
      >
        {/* Close button — absolute so it doesn't push the content down. The pt-[106px] on the
            parent aligns the task-preview row with the column headers (e.g. "Projects") in the
            list view behind the panel. */}
        <button onClick={onClose} className="absolute top-6 right-6 text-[#656464] hover:text-white transition-colors z-10" aria-label="Close">
          <X size={18} />
        </button>

        {/* Task preview row — same look as in the lists. Title is inline-editable. */}
        <div className="px-[31px] flex flex-row items-center gap-2">
          {!isMilestone && <TaskCheckbox completed={task.completed} started={task.started} onToggle={() => {
            // Mirror toggleTask's 3-state cycle here so the quick-edit / edit modal
            // checkbox behaves identically to the inline row checkbox. Goes through
            // apply() so the existing patch-then-(maybe-close) flow is preserved.
            if (task.completed) apply({ completed: false, completedDay: undefined, completedAt: undefined, started: false, startedAt: undefined, revivedAt: Date.now() });
            else if (task.started) apply({ completed: true, completedDay: todayISO(), completedAt: Date.now(), revivedAt: undefined });
            else apply({ started: true, startedAt: Date.now() });
          }} />}
          <EditableText
            value={task.title}
            onChange={(v) => onUpdateTask(task.id, { title: v })}
            placeholder="New Task"
            // Auto-enter edit mode for freshly created tasks so the cursor is already blinking
            // inside the empty title alongside the gray "New Task" placeholder.
            autoFocus={task.id === newId}
            className={`font-['Untitled_Sans',sans-serif] text-[14px] whitespace-nowrap ${task.completed ? 'text-[#474747]' : 'text-white'}`}
          />
          {client && <span className={`font-['Untitled_Sans',sans-serif] text-[14px] whitespace-nowrap ${task.completed ? 'text-[#474747]' : 'text-[#656464]'}`}>{client.short}</span>}
          {task.assignees.map((a, i) => <AssigneeBadge key={`${a}-${i}`} letter={a} tone={isMilestone ? 'scheduled' : 'todo'} dim={task.completed} />)}
          {task.deadline && (
            <>
              {!isMilestone && <DeadlineArrow dim={task.completed} />}
              <span className={`font-['NB_International:Regular',sans-serif] text-[14.333px] whitespace-nowrap ${task.completed ? 'text-[#474747]' : 'text-white'}`}>{formatDeadline(task.deadline)}</span>
            </>
          )}
        </div>

        {/* Type: Task / Milestone — uses the purple variant since type is the most categorical choice.
            mt-[37px] adds a SECOND spacer-row below the task preview for extra breathing room. */}
        <div className="px-[31px] flex flex-row gap-4 items-center mt-[37px]">
          <PillType active={!isMilestone} onClick={() => apply({ type: 'todo' })}>Task</PillType>
          <PillType active={isMilestone} onClick={() => apply({ type: 'scheduled' })}>Milestone</PillType>
        </div>

        {/* Section: Today / Tomorrow / Next — pinpoints where this task lands in its column. */}
        <div className="px-[31px] flex flex-row gap-4 items-center">
          <Pill active={task.section === 'today'} onClick={() => apply({ section: 'today' })}>Today</Pill>
          <Pill active={task.section === 'tomorrow'} onClick={() => apply({ section: 'tomorrow' })}>Tomorrow</Pill>
          <Pill active={task.section === 'next'} onClick={() => apply({ section: 'next' })}>Next</Pill>
        </div>

        {/* List: Work / Projects / Admin / Personal */}
        <div className="px-[31px] flex flex-row gap-4 items-center">
          {LISTS.map((l) => (
            <Pill key={l} active={task.list === l} onClick={() => apply({ list: l })}>{LIST_TITLES[l]}</Pill>
          ))}
        </div>

        {/* Clients — selecting changes the task's clientId and clears project (so the project
            list filters to the new client cleanly). Just-created clients render inline-editable. */}
        <div className="px-[31px] flex flex-row flex-wrap gap-x-4 gap-y-3 items-center">
          {sortedClients.map((c) => c.id === newId ? (
            <EditableText key={c.id} value={c.name} placeholder="New Client" autoFocus onChange={(v) => onRenameClient(c.id, v)} onDiscardIfEmpty={() => onDeleteClient(c.id)} className="text-[14px] font-['Untitled_Sans',sans-serif] whitespace-nowrap text-white font-bold" />
          ) : (
            <Pill key={c.id} active={resolvedClientId === c.id} onClick={() => apply({ clientId: c.id, projectId: undefined })}>{c.name || 'New Client'}</Pill>
          ))}
          <PlusBtn onClick={onAddClient} />
        </div>

        {/* Projects — only shown when the selected client actually has projects (or the user
            wants to add one). + creates a new project under the current client. */}
        {resolvedClientId && (
          <div className="px-[31px] flex flex-row flex-wrap gap-x-4 gap-y-3 items-center">
            {projectsForClient.map((p) => p.id === newId ? (
              <EditableText key={p.id} value={p.name} placeholder="New Project" autoFocus onChange={(v) => onRenameProject(p.id, v)} onDiscardIfEmpty={() => onDeleteProject(p.id)} className="text-[14px] font-['Untitled_Sans',sans-serif] whitespace-nowrap text-white font-bold" />
            ) : (
              <Pill key={p.id} active={task.projectId === p.id} onClick={() => { onPinProjectList(p.id, task.list); apply({ projectId: p.id }); }}>{p.name || 'New Project'}</Pill>
            ))}
            {/* New projects born in this panel inherit the task's list so they stay inside
                the contextual filter above instead of instantly vanishing from it. */}
            <PlusBtn onClick={() => onAddProject({ name: '', clientId: resolvedClientId, list: task.list })} />
          </div>
        )}

        {/* Assignees — toggleable; click to add or remove from the task's assignees list */}
        <div className="px-[31px] flex flex-row flex-wrap gap-x-4 gap-y-3 items-center">
          {people.map((p) => {
            const has = task.assignees.includes(p.short);
            const displayLetter = displayShorts[p.id] || p.short || '?';
            if (p.id === newId) {
              return (
                <div key={p.id} className="flex flex-row items-center gap-2">
                  <AssigneeBadge letter={displayLetter} tone="todo" active />
                  <EditableText value={p.name} placeholder="New Person" autoFocus onChange={(v) => onRenamePerson(p.id, v)} onDiscardIfEmpty={() => onDeletePerson(p.id)} className="text-[14px] font-['Untitled_Sans',sans-serif] whitespace-nowrap text-white font-bold" />
                </div>
              );
            }
            return (
              <button key={p.id} onClick={() => applyAssignees({ assignees: has ? task.assignees.filter((a) => a !== p.short) : [...task.assignees, p.short] })} className={`flex flex-row items-center gap-2 transition-opacity ${has ? '' : 'opacity-50 hover:opacity-100'}`}>
                <AssigneeBadge letter={displayLetter} tone={isMilestone ? 'scheduled' : 'todo'} active={has} />
                <span className={`text-[14px] font-['Untitled_Sans',sans-serif] whitespace-nowrap ${has ? 'text-white font-bold' : 'text-[#656464]'}`}>{p.name || 'New Person'}</span>
              </button>
            );
          })}
          <PlusBtn onClick={onAddPerson} />
        </div>

        {/* Date quick-picks */}
        <div className="px-[31px] flex flex-row gap-4 items-center flex-wrap">
          <Pill active={task.deadline === todayIso} onClick={() => apply({ deadline: todayIso })}>Today</Pill>
          {task.deadline && task.deadline !== todayIso && task.deadline !== tomorrowIso && task.deadline !== nextWeekIso && (
            <span className="text-white text-[14px] font-bold whitespace-nowrap">{new Date(task.deadline + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' })}</span>
          )}
          {task.deadline && (
            <button onClick={() => apply({ deadline: undefined, startDate: undefined })} className="text-[#656464] hover:text-white transition-colors p-1" aria-label="Clear date">
              <Trash2 size={14} />
            </button>
          )}
          <Pill active={task.deadline === tomorrowIso} onClick={() => apply({ deadline: tomorrowIso })}>Tomorrow</Pill>
          <Pill active={task.deadline === nextWeekIso} onClick={() => apply({ deadline: nextWeekIso })}>Next Week</Pill>
        </div>

        {/* Month calendar — header + day grid. Selected deadline in purple. */}
        <div className="px-[31px] pb-6 flex flex-col gap-3">
          <div className="flex flex-row justify-between items-center text-[#656464]">
            <button onClick={() => setCalMonth(new Date(calMonth.getFullYear(), calMonth.getMonth() - 1, 1))} className="hover:text-white"><ChevronLeft size={14} /></button>
            <span className="text-[13px] font-['Untitled_Sans',sans-serif]">{monthLabel}</span>
            <button onClick={() => setCalMonth(new Date(calMonth.getFullYear(), calMonth.getMonth() + 1, 1))} className="hover:text-white"><ChevronRight size={14} /></button>
          </div>
          <div className="grid grid-cols-7 gap-y-2 text-center text-[12px]">
            {['S','M','T','W','T','F','S'].map((d, i) => (
              <div key={`dow-${i}`} className="text-[#656464] font-['Untitled_Sans',sans-serif]">{d}</div>
            ))}
            {cells.map((c, i) => {
              const isStart = !!(task.startDate && c.iso === task.startDate);
              const isEnd = !!(task.deadline && c.iso === task.deadline && task.startDate);
              const isSingleDate = !!(task.deadline && !task.startDate && c.iso === task.deadline);
              const isInRange = !!(task.startDate && task.deadline && c.iso && c.iso > task.startDate && c.iso < task.deadline);
              const isSelected = isStart || isEnd || isSingleDate;
              const isToday = c.iso === todayIso;
              const onPick = () => {
                if (!c.iso) return;
                // Airbnb-style two-step: first click sets a single date; a second click on a
                // different date promotes it to a range (start..end). A third click resets.
                if (task.startDate && task.deadline) {
                  apply({ startDate: undefined, deadline: c.iso });
                } else if (task.deadline && c.iso !== task.deadline) {
                  const a = c.iso < task.deadline ? c.iso : task.deadline;
                  const b = c.iso < task.deadline ? task.deadline : c.iso;
                  apply({ startDate: a, deadline: b });
                } else if (task.deadline === c.iso) {
                  apply({ deadline: undefined, startDate: undefined });
                } else {
                  apply({ deadline: c.iso, startDate: undefined });
                }
              };
              // Background "bar" fills the full cell width during a range so neighbouring
              // cells visually connect into a single continuous pill. Endpoints render their
              // own purple circle ON TOP of the bar — the rounded edge merges seamlessly.
              const barLeft = isStart && !isEnd ? '50%' : '0';
              const barRight = isEnd && !isStart ? '50%' : '0';
              const showBar = isInRange || (isStart && !isEnd) || (isEnd && !isStart);
              return (
                <div key={`day-${i}`} className="relative h-7 flex items-center justify-center">
                  {showBar && (
                    <div className="absolute h-7 inset-y-0 bg-[#7363FF]" style={{ left: barLeft, right: barRight }} />
                  )}
                  <button
                    onClick={onPick}
                    className={`relative z-10 h-7 w-7 rounded-full flex items-center justify-center transition-colors text-[13px] font-bold ${isSelected ? 'bg-[#7363FF] text-[#1f1f1f]' : isInRange ? 'text-[#1f1f1f]' : isToday ? 'text-[#8465ff]' : c.inMonth ? 'text-white hover:bg-white/10 font-normal' : 'text-[#454545] hover:bg-white/[0.03] font-normal'}`}
                  >
                    {c.date?.getDate()}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

export default function App() {
  const [tasks, setTasks] = useStorageList<'tasks', Task>('tasks');
  const [projects, setProjects] = useStorageList<'projects', Project>('projects');
  const [clients, setClients] = useStorageList<'clients', Client>('clients');
  const [people, setPeople] = useStorageList<'people', Person>('people');
  // sortTick: bumped by toggleTask after the 15-second completion grace window elapses, to force
  // tasksByKey to re-evaluate and move newly-aged completed tasks to the bottom of their section.
  // Lives outside Liveblocks (it's a UI-timing concern, not synced state).
  const [sortTick, setSortTick] = useState(0);
  // Periodic tick (every 60s) so time-based filters / sorts re-evaluate without
  // a user interaction. Drives the 30-minute "hide completed task" filter and
  // any other "did the wall clock cross a threshold" check that depends on
  // wall-clock time — without this, a completed task would stay visible until
  // the next render, even after its 30-minute window expired.
  useEffect(() => {
    const id = window.setInterval(() => setSortTick((n) => n + 1), 60_000);
    return () => window.clearInterval(id);
  }, []);
  // Backup slot timestamps (epoch ms). Surfaced in Settings so the user can
  // see when each slot was last refreshed. Two slots only:
  //   • live  — refreshed every 5 minutes; mirrors current state
  //   • daily — refreshed only when its existing snapshot is older than 24h;
  //             always between 0 and 24 hours old, your "yesterday" rollback
  // No accumulating history. Each refresh OVERWRITES its slot in place.
  const [liveBackupAt, setLiveBackupAt] = useState<number | null>(null);
  const [dailyBackupAt, setDailyBackupAt] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    Promise.all([getSlot('live'), getSlot('daily')]).then(([live, daily]) => {
      if (cancelled) return;
      if (live) setLiveBackupAt(live.takenAtMs);
      if (daily) setDailyBackupAt(daily.takenAtMs);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);
  // Periodic version poll. Every 3 minutes (and once on mount), fetch the
  // version.json manifest the build step writes. If its buildTime is newer
  // than the constant baked into the running bundle, surface a banner so
  // the user can reload into the new version. Cache-busting via timestamp
  // so any HTTP cache layer (browser, GitHub Pages CDN) doesn't serve a
  // stale manifest. `dismissedBuildTime` lets the user mute the banner
  // for THIS particular build — opens up again the next time a newer one
  // ships.
  const [newBuildTime, setNewBuildTime] = useState<string | null>(null);
  const [dismissedBuildTime, setDismissedBuildTime] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const POLL_MS = 3 * 60 * 1000;
    const check = async () => {
      try {
        // base path on GH Pages is /todo-app/; build-time we know what `base`
        // we used so derive the manifest URL from the document's <base> or
        // import.meta.env.BASE_URL (Vite exposes this constant).
        const baseUrl = import.meta.env.BASE_URL || '/';
        const url = `${baseUrl}version.json?t=${Date.now()}`;
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) return;
        const manifest = await res.json() as { version: string; buildTime: string };
        if (cancelled) return;
        if (manifest.buildTime && manifest.buildTime > __BUILD_TIME__) {
          setNewBuildTime(manifest.buildTime);
        }
      } catch {
        // Network blip / file missing during deploy — silently retry next tick.
      }
    };
    check();
    const id = window.setInterval(check, POLL_MS);
    return () => { cancelled = true; window.clearInterval(id); };
  }, []);
  // Hoisted up-front because several useCallbacks below reference currentUserShort in their dep arrays
  // (e.g. to seed new tasks with the current user as assignee).
  const [currentUserShort, setCurrentUserShortState] = useState<string>(() => {
    if (typeof window === 'undefined') return '';
    return window.localStorage.getItem('todo-app-user-short') || '';
  });
  const setCurrentUserShort = useCallback((s: string) => {
    setCurrentUserShortState(s);
    try { window.localStorage.setItem('todo-app-user-short', s); } catch {}
  }, []);
  const [mode, setMode] = useState<AppMode>('focus');
  const [showAdd, setShowAdd] = useState(false);
  const [prefillList, setPrefillList] = useState<ListId | null>(null);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  // Projects view: slide-out Resources/Clients assignment tray (left edge).
  // Auto-opens while a drag approaches the left edge; chevron handle toggles
  // it manually for adding/renaming people and clients.
  // (assignTrayOpen removed — the Projects view now uses the shared master assign drawer.)
  // 'edit' = double-click, panel stays open until you click off. 'quick' = right-click,
  // panel closes after a single change is applied (one-shot mode for quick re-categorising).
  const [editMode, setEditMode] = useState<'edit' | 'quick'>('edit');
  // Display order for task meta. Per-user preference, persisted in localStorage.
  //   'cpt' = Client-Project Task    (e.g. FOG-Essentialist  Send Comps)
  //   'ptc' = Project  Task  Client  (current default — e.g. Essentialist Send Comps  FOG)
  //   'tcp' = Task Client-Project    (e.g. Send Comps  FOG-Essentialist)
  const [taskOrder, setTaskOrderState] = useState<'cpt' | 'ptc' | 'tcp'>(() => {
    if (typeof window === 'undefined') return 'ptc';
    const v = window.localStorage.getItem('todo-app-task-order');
    return v === 'cpt' || v === 'tcp' ? v : 'ptc';
  });
  const setTaskOrder = useCallback((v: 'cpt' | 'ptc' | 'tcp') => {
    setTaskOrderState(v);
    try { window.localStorage.setItem('todo-app-task-order', v); } catch {}
  }, []);
  // Universal SECTION SEQUENCE — the one true order for Work / Projects / Admin across
  // every surface: list-view columns, dashboard-stack blocks, project-view columns,
  // calendar bands (including the queue-filler allocation order inside
  // computeCalendarDistribution), and the focus page's day columns. Previously each
  // surface hardcoded its own order and they had all drifted apart. Persisted
  // per-browser, set from Settings → Section sequence.
  const [listSequence, setListSequenceState] = useState<ListId[]>(() => {
    const fallback: ListId[] = ['work', 'projects', 'admin', 'personal'];
    if (typeof window === 'undefined') return fallback;
    try {
      const v = JSON.parse(window.localStorage.getItem('todo-app-list-sequence') || 'null');
      if (Array.isArray(v) && v.length >= 3) {
        // Keep the user's saved order, drop anything unknown, and append any category that's
        // missing — this migrates old 3-item sequences by adding 'personal' at the end.
        const seq = (v as ListId[]).filter((l) => fallback.includes(l));
        for (const l of fallback) if (!seq.includes(l)) seq.push(l);
        if (seq.length === fallback.length) return seq;
      }
    } catch {}
    return fallback;
  });
  const setListSequence = useCallback((v: ListId[]) => {
    setListSequenceState(v);
    try { window.localStorage.setItem('todo-app-list-sequence', JSON.stringify(v)); } catch {}
  }, []);
  // Responsive density of a single dashboard column. The cascade fights to preserve the task
  // title — title text is NEVER truncated, and date + arrow always stay visible.
  //   0  full       — everything visible at full size
  //   1  tight      — project name truncates (max-w on the project span)
  //   2  tighter    — date switches from "Fri-Apr 24" → "04-25"
  //   3  snug       — deadline arrow horizontal line ~50% shorter (head + stroke unchanged)
  //   4  compact    — client short hidden
  //   5  minimal    — assignee badges hidden
  //   6  bare       — project name hidden entirely
  // The + and trash buttons, the date, the arrow, and the title are ALWAYS visible.
  // Spacing/margins never compress.
  const [columnPx, setColumnPx] = useState<number>(typeof window === 'undefined' ? 440 : window.innerWidth / 4);
  useEffect(() => {
    const update = () => setColumnPx(window.innerWidth / 4);
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  const density: number = columnPx >= 460 ? 0 : columnPx >= 420 ? 1 : columnPx >= 380 ? 2 : columnPx >= 340 ? 3 : columnPx >= 300 ? 4 : columnPx >= 260 ? 5 : 6;

  // Tomorrow section toggle. When ON: a "Tomorrow" section sits between Today and Next.
  // When OFF: tasks tagged section='tomorrow' visually fall back into Next (data is preserved
  // — re-enabling the toggle restores them to Tomorrow without losing context).
  // DEFAULT: ON for users who haven't explicitly toggled it. The previous default (OFF
  // when the localStorage key was missing) hid Tomorrow from anyone who'd never visited
  // Settings, which is the wrong "don't surprise them" — surprising them with a missing
  // section beats surprising them with an unexpected one. Users who explicitly turned it
  // off retain that preference (we only default-on when the key is unset).
  const [tomorrowEnabled, setTomorrowEnabledState] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    const v = window.localStorage.getItem('todo-app-tomorrow-enabled');
    if (v === null) return true;
    return v === '1';
  });
  const setTomorrowEnabled = useCallback((v: boolean) => {
    setTomorrowEnabledState(v);
    try { window.localStorage.setItem('todo-app-tomorrow-enabled', v ? '1' : '0'); } catch {}
  }, []);
  // Title-case auto-conversion mode. 2s after blur on a title, the text is rewritten in the
  // chosen mode:
  //   'off'   — no conversion
  //   'title' — "Buy Milk and Eggs" (small words like "and / the / of" stay lowercase)
  // Brand-name vocabulary + ALL-CAPS acronyms are preserved. Default 'off' (don't surprise
  // the user; they opt in).
  type CaseMode = 'off' | 'title';
  const [caseMode, setCaseModeState] = useState<CaseMode>(() => {
    if (typeof window === 'undefined') return 'off';
    const v = window.localStorage.getItem('todo-app-case-mode');
    return v === 'title' ? 'title' : 'off';
  });
  const setCaseMode = useCallback((v: CaseMode) => {
    setCaseModeState(v);
    try { window.localStorage.setItem('todo-app-case-mode', v); } catch {}
  }, []);
  // Convenience boolean for the schedule callbacks below.
  const sentenceCaseEnabled = caseMode !== 'off';
  // Anchor rect: panel opens over this column. Captured at click time from the row's nearest
  // column ancestor. null → centered (used by the bottom + button).
  const [editAnchor, setEditAnchor] = useState<{ x: number; width: number } | null>(null);
  const captureAnchorFromEvent = (e?: { currentTarget?: EventTarget | null }): { x: number; width: number } | null => {
    if (!e?.currentTarget) return null;
    const el = e.currentTarget as HTMLElement;
    // Walk up to the column wrapper (uses `flex-1 min-w-[280px]`).
    const col = el.closest('.flex-1.min-w-\\[280px\\]') as HTMLElement | null;
    if (!col) return null;
    const r = col.getBoundingClientRect();
    return { x: r.left, width: r.width };
  };
  const openEdit = useCallback((t: Task, e?: { currentTarget?: EventTarget | null }) => { setEditingTask(t); setSelectedTaskId(t.id); setEditMode('edit'); setEditAnchor(captureAnchorFromEvent(e)); }, []);
  const openQuick = useCallback((t: Task, e?: { currentTarget?: EventTarget | null }) => { setEditingTask(t); setSelectedTaskId(t.id); setEditMode('quick'); setEditAnchor(captureAnchorFromEvent(e)); }, []);

  // ── Blank-task auto-expiry ────────────────────────────────────────────────
  // Tasks created but never given a title self-destruct 3 minutes after
  // creation. Legacy blanks with no createdAt stamp count as already expired,
  // so accumulated empty rows get cleaned on the first sweep. The task
  // currently open in the edit/quick panel is exempt (mid-edit protection).
  const editingTaskIdRef = useRef<string | null>(null);
  useEffect(() => { editingTaskIdRef.current = editingTask?.id ?? null; }, [editingTask]);
  // The most recently created task (newId) is exempt too — it's the one whose title field
  // is autofocused and mid-type. Ref is synced next to newId's declaration further down
  // (declaring it here keeps the sweep closure TDZ-safe).
  const newlyCreatedIdRef = useRef<string | null>(null);
  useEffect(() => {
    const MAX_AGE_MS = 180_000, SWEEP_EVERY_MS = 30_000;
    const sweep = () => {
      const now = Date.now();
      setTasks((prev) => {
        const expired = prev.filter((t) =>
          !t.title.trim() && !t.trashed &&
          (now - (t.createdAt ?? 0)) > MAX_AGE_MS &&
          t.id !== editingTaskIdRef.current &&
          t.id !== newlyCreatedIdRef.current);
        if (expired.length === 0) return prev;
        const ids = new Set(expired.map((t) => t.id));
        console.log(`[blank-sweep] removing ${expired.length} empty task(s)`);
        return prev.filter((t) => !ids.has(t.id));
      });
    };
    const h = setInterval(sweep, SWEEP_EVERY_MS);
    sweep();
    return () => clearInterval(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Single-click selection — Information panel and any "where am I?" affordances key off this.
  // Editing also sets it (above), so opening the quick-edit / full panel drags the selection
  // along with the user. Selection persists across panel close so the focus column doesn't
  // suddenly snap back when the user dismisses the editor.
  const selectTask = useCallback((id: string) => setSelectedTaskId(id), []);
  // Click handler for the FileText icon — selects the task AND switches to Focus mode so its
  // content opens in column 2/3. setSelectedTaskId / setMode are stable refs from useState
  // so empty deps is fine even though their declarations are further down the file.
  const openTaskInFocus = useCallback((id: string) => {
    setSelectedTaskId(id);
    setMode('focus');
  }, []);
  // Bottom + button: create a blank task and immediately open the edit panel for it, anchored
  // to the Work column (since new tasks default to list='work'). Title starts empty — the panel's
  // EditableText shows "New Task" as a gray placeholder which disappears on first keystroke.
  const addAndEditTask = useCallback(() => {
    const id = `t-${Date.now()}`;
    const newTask: Task = { id, title: '', type: 'todo', assignees: currentUserShort ? [currentUserShort] : [], completed: false, list: 'work', section: 'today', order: 0, createdAt: Date.now() };
    setTasks((prev) => [...prev, newTask]);
    setEditingTask(newTask);
    setNewId(id);
    setEditMode('edit');
    // Anchor over the Work column at click time. Find it via DOM.
    const cols = document.querySelectorAll('.flex-1.min-w-\\[280px\\]');
    // Column order in dashboard mode: dashboard, work, projects, admin → work is index 1.
    const workCol = cols[1] as HTMLElement | undefined;
    setEditAnchor(workCol ? { x: workCol.getBoundingClientRect().left, width: workCol.getBoundingClientRect().width } : null);
  }, [currentUserShort, setTasks]);
  const [activeId, setActiveId] = useState<string | null>(null);
  // Mid-drag wheel scrolling. While a card is being dragged, the DragOverlay ghost rides under
  // the cursor and swallows wheel events before they reach the tray / columns — exactly when
  // scrolling matters most (holding a task over the tray to reach a project further down). A
  // window-level CAPTURE listener runs before anything can eat the event: during a drag it
  // finds the scrollable panel under the cursor (checking EVERY element at the point, so the
  // ghost is skipped), scrolls it directly, and stops the event there. dnd-kit tracks ancestor
  // scrolls mid-drag, so droppable hit-testing stays correct while the list moves. Outside a
  // drag it returns immediately and CustomScroll's buttery lerp keeps handling the wheel.
  // (Default window sizing moved to the Rust shell via raw Win32 SetWindowPos — every
  // Tauri-layer sizing path mis-scales on this machine, and the webview's own innerWidth
  // reports the REQUEST rather than reality, so no web-side loop can even observe truth.)
  const wheelDragRef = useRef(false);
  useEffect(() => { wheelDragRef.current = !!activeId; }, [activeId]);
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (!wheelDragRef.current) return;
      for (const raw of document.elementsFromPoint(e.clientX, e.clientY)) {
        let n: HTMLElement | null = raw instanceof HTMLElement ? raw : null;
        while (n) {
          if (n.scrollHeight > n.clientHeight + 1) {
            const oy = getComputedStyle(n).overflowY;
            if (oy === 'auto' || oy === 'scroll') {
              n.scrollTop += e.deltaY;
              e.preventDefault();
              e.stopPropagation();
              return;
            }
          }
          n = n.parentElement;
        }
      }
    };
    window.addEventListener('wheel', onWheel, { passive: false, capture: true });
    return () => window.removeEventListener('wheel', onWheel, { capture: true });
  }, []);
  // Underlying task id (without any sortable prefix). For per-list columns this matches activeId,
  // but for prefixed contexts (dashboard sub-lists) activeId is e.g. "dash:work:taskId" while
  // activeTaskId stays "taskId" so tasks.find(t.id === activeTaskId) resolves the real task.
  const [activeTaskId, setActiveTaskIdState] = useState<string | null>(null);
  const [activeType, setActiveType] = useState<'task' | 'project' | 'projTask' | 'damImage' | 'focusProject' | null>(null);
  // The project being dragged in the focus-panel nesting UI (drag one project onto another to
  // make it a sub-project). Held for the DragOverlay pill.
  const [activeFocusProject, setActiveFocusProject] = useState<Project | null>(null);
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [activeProjTask, setActiveProjTask] = useState<Task | null>(null);
  // The image being dragged in the references gallery — held so DragOverlay
  // can render a 1:1 floating preview that locks to the cursor (the source
  // tile is hidden via visibility:hidden during drag). activeDamMultiCount
  // is set > 1 when the dragged tile is part of a multi-selection, so the
  // overlay can stamp a "+N" badge to communicate that more is moving.
  const [activeDamImage, setActiveDamImage] = useState<FocusDamImage | null>(null);
  const [activeDamMultiCount, setActiveDamMultiCount] = useState(1);
  const [overId, setOverId] = useState<string | null>(null);
  // For calendar cross-list redirects: the redirected `over` is a cell id and loses the
  // task identity. We mirror the task id into state so the per-cell displacement compute
  // (which feeds <Displaced> wrappers) can react to it on re-render.
  const [overTaskIdHint, setOverTaskIdHint] = useState<string | null>(null);
  const [activeRectWidth, setActiveRectWidth] = useState<number | undefined>(undefined);
  const [activeRectHeight, setActiveRectHeight] = useState<number | undefined>(undefined);
  // When the active drag originated from a calendar card, this holds its source cell id (e.g. "cal:2026-04-25:work").
  // The DragOverlay uses this to render a CalendarCard-shaped overlay (rounded, 2-row) instead of a list-row.
  // It also gates off the list-mode column-offset and source-collapse behavior, which don't make sense in calendar.
  const [activeCalendarCellId, setActiveCalendarCellId] = useState<string | null>(null);
  const [columnOffset, setColumnOffset] = useState(0);
  const [sourceCollapsed, setSourceCollapsed] = useState(false);
  const collapseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingOffsetRef = useRef<number>(0);
  const dwellTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startXRef = useRef<number | null>(null);
  const ctrlDownRef = useRef(false);
  useEffect(() => {
    const dn = (e: KeyboardEvent) => { if (e.ctrlKey || e.metaKey) ctrlDownRef.current = true; };
    const up = (e: KeyboardEvent) => { if (!e.ctrlKey && !e.metaKey) ctrlDownRef.current = false; };
    const blur = () => { ctrlDownRef.current = false; };
    window.addEventListener('keydown', dn);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => { window.removeEventListener('keydown', dn); window.removeEventListener('keyup', up); window.removeEventListener('blur', blur); };
  }, []);

  // Auto-promote INBOX tasks to 'today' when their start date arrives. Same "rest of day
  // override" rule as the deadline auto-promote: skip Next + Tomorrow so user drags into
  // those sections aren't fought back to Today (e.g. drag from Today to Next was sometimes
  // making the task vanish — startDate effect immediately re-promoted it). The 4 AM cycle
  // (below) re-evaluates startDate at rollover, surfacing the task back into Today.
  useEffect(() => {
    const today = todayISO();
    const needsPromote = tasks.some((t) => t.startDate && t.startDate <= today && t.section === 'inbox');
    if (needsPromote) {
      setTasks((prev) => prev.map((t) => (t.startDate && t.startDate <= today && t.section === 'inbox' ? { ...t, section: 'today' as SectionId } : t)));
    }
  }, [tasks, setTasks]);

  // Auto-promote INBOX tasks to 'today' when their deadline arrives — at any time, since the
  // user hasn't placed them anywhere yet. 'next' and 'tomorrow' are NOT touched here; those are
  // treated as a "for the rest of the day" override that the 4 AM cycle (below) re-evaluates.
  useEffect(() => {
    const today = todayISO();
    const needsPromote = tasks.some((t) =>
      t.deadline && t.deadline <= today && t.type !== 'scheduled' && t.section === 'inbox'
    );
    if (needsPromote) {
      setTasks((prev) => prev.map((t) =>
        t.deadline && t.deadline <= today && t.type !== 'scheduled' && t.section === 'inbox'
          ? { ...t, section: 'today' as SectionId }
          : t
      ));
    }
  }, [tasks, setTasks]);

  // Migration: ensure the seeded Personal client exists for rooms created before it was added.
  useEffect(() => {
    if (!clients.some((c) => c.id === PERSONAL_CLIENT_ID)) {
      setClients((prev) => (prev.some((c) => c.id === PERSONAL_CLIENT_ID) ? prev : [{ id: PERSONAL_CLIENT_ID, name: 'Personal', short: '' }, ...prev]));
    }
  }, [clients, setClients]);

  // Touch-outside-to-blur. Capture-phase document listener that detects
  // when a touch lands outside the currently-editing element. When it
  // does: (1) blurs that element (deferred to rAF so the iOS keyboard
  // dismissal doesn't scramble dnd-kit's TouchSensor rect cache during
  // its 500ms long-press wait), (2) stamps recentEditBlurAt so the
  // row's onTouchEnd handler skips its setEditing call on this same
  // touch, (3) sets blockNextClick so the always-on click handler at
  // module-load suppresses the click that's about to follow — which is
  // what stops the new card from getting onSelect → setSelectedTaskId.
  // Editable detection uses isContentEditable (the DOM property, not the
  // attribute) so it works regardless of whether React serializes
  // contentEditable={true} as "true" or empty string.
  useEffect(() => {
    if (!TOUCH_DEVICE) return;
    // Scope the editable search to task titles ONLY. Earlier we walked
    // every [contenteditable] on the page — but the BriefField component
    // in Focus mode (and any future inline editor) is ALWAYS
    // contentEditable, not gated on focus / edit state. That meant our
    // listener saw "edit is active" on every touch and fired blur + block
    // + deselect every time, even when the user was just tapping a row.
    // [data-task-title] is set on every task-title span; combined with
    // isContentEditable (true only when editing={true} flips the React
    // prop) it uniquely identifies the row that's actually in edit mode.
    const findEditable = (): HTMLElement | null => {
      const els = document.querySelectorAll('[data-task-title]');
      for (const el of els) {
        if (el instanceof HTMLElement && el.isContentEditable) return el;
      }
      return null;
    };
    const onDocTouchStart = (e: TouchEvent) => {
      const tgt = (e.target as HTMLElement | null)?.tagName ?? '?';
      const editable = findEditable();
      if (!editable) {
        debugLog(`touchstart ${tgt} (no editable found)`);
        return;
      }
      const target = e.target as Node | null;
      if (target && editable.contains(target)) {
        debugLog(`touchstart ${tgt} (inside editable, ignoring)`);
        return;
      }
      debugLog(`touchstart ${tgt} OUTSIDE editable — blur + block + deselect`);
      recentEditBlurAt = Date.now();
      blockNextClick = true;
      blockNextClickAt = Date.now();
      // Also clear the highlighted selection — without this, the row that
      // was being edited stays highlighted after you tap off, since the
      // blur only exits edit mode and doesn't touch selectedTaskId.
      setSelectedTaskId(null);
      requestAnimationFrame(() => editable.blur());
    };
    document.addEventListener('touchstart', onDocTouchStart, { passive: true, capture: true });
    return () => document.removeEventListener('touchstart', onDocTouchStart, true);
  }, []);
  // Gesture disambiguation across mouse + touch + keyboard:
  //
  // MouseSensor (desktop) — distance:8 means a mouse-down + 8px of motion
  // starts a drag. Pure clicks (no motion) stay clicks and fire the
  // existing onClick / onDoubleClick / onContextMenu handlers normally.
  //
  // TouchSensor (mobile) — delay:500 + tolerance:5 means a long-press
  // starts a drag. If the finger moves more than 5px within the 500ms
  // wait the sensor cancels — so a vertical swipe becomes a scroll (the
  // browser keeps its native scroll handling), and a quick tap becomes a
  // tap (browser fires click → existing handlers run). Long-press without
  // movement crosses 500ms → drag activates and the tile lifts. This is
  // the same pattern Apple's reorderable lists, Trello, and Todoist use.
  //
  // KeyboardSensor is unchanged — Tab to focus a card, Space to pick up,
  // arrows to move, Space to drop.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 10 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  // BeforeDragging (vs Always): measure droppable rects ONCE at drag start, not on every render.
  // Why: our Displaced primitive moves cards via CSS transform to make room for the dragged item.
  // CSS transforms affect getBoundingClientRect â€” so with Always, dnd-kit re-measured the displaced
  // (visually-shifted) rects, recomputed `over`, the displacement target changed, cards moved again,
  // and the cycle created a tiny vertical feedback loop that visibly nudged the dragged overlay.
  // BeforeDragging anchors collision detection to the original pre-drag layout, so displacement is
  // purely visual feedback with no measurement loop.
  const measuringConfig = { droppable: { strategy: MeasuringStrategy.BeforeDragging } };

  const toggleTask = useCallback((id: string) => {
    setTasks((prev) => prev.map((t) => {
      if (t.id !== id) return t;
      // Three-state cycle (the "2-stage checkbox"):
      //   pending (started=false, completed=false)  → STARTED  (started=true, completed=false)
      //   started                                   → COMPLETED (completed=true)
      //   completed                                 → pending (full reset; gives an explicit "undo" path)
      // Each transition stamps the matching *At so the bucket sort's 15s grace window applies
      // identically to both started→sink and completed→sink. revivedAt is stamped when leaving
      // completed so the recently-revived linger window matches the legacy behavior.
      if (t.completed) {
        // completed → pending. Wipes started too — full reset for the cleanest "undo" path.
        return { ...t, completed: false, completedDay: undefined, completedAt: undefined, started: false, startedAt: undefined, revivedAt: Date.now() };
      }
      if (t.started) {
        // started → completed. Stamp completed* fields; leave started=true so storage records
        // the full journey, though the sort only cares about completed at this point.
        return { ...t, completed: true, completedDay: todayISO(), completedAt: Date.now(), revivedAt: undefined };
      }
      // pending → started. No completedDay/completedAt yet — those are reserved for the
      // final tier. startedAt drives the same 15s grace window as completedAt so the row
      // doesn't visibly jump to the bottom mid-click.
      return { ...t, started: true, startedAt: Date.now() };
    }));
    // Force a re-render ~15.1s after the click so the just-toggled task gets re-sorted to
    // its tier once the grace window elapses. Bumps a counter that the sort memo depends on;
    // no-op if the user re-cycles inside the window (the sort just re-evaluates).
    window.setTimeout(() => {
      setSortTick((n) => n + 1);
    }, 15100);
  }, []);

  const deleteTask = useCallback((id: string) => {
    // SOFT delete: flag the task as trashed so it's hidden from main views but still listed in
    // Settings → Trash for 10 min (and indefinitely until purged). Hard-delete is reserved for
    // the future "Empty trash" affordance.
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, trashed: true, trashedAt: Date.now(), revivedAt: undefined } : t)));
  }, []);

  // Revive a trashed task (undo a soft delete). Stamps revivedAt so the task stays visible in
  // Settings → Trash for 10 min in case the user wants to re-trash it.
  const untrashTask = useCallback((id: string) => {
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, trashed: false, trashedAt: undefined, revivedAt: Date.now() } : t)));
  }, []);

  // Hard-delete: actually remove from storage. Used by Settings → Trash "Empty" / per-row purge.
  const purgeTask = useCallback((id: string) => {
    setTasks((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // Bulk-update sections to mirror the calendar's auto-distribution. Called by
  // WeekCalendarMode after computing the per-cell distribution: any queue task that lands on
  // today / tomorrow gets its section flipped so list view shows it in the matching bucket.
  const syncCalendarSections = useCallback((updates: Array<{ id: string; section: SectionId }>) => {
    if (updates.length === 0) return;
    const map = new Map(updates.map((u) => [u.id, u.section]));
    setTasks((prev) => prev.map((t) => {
      const next = map.get(t.id);
      return next && t.section !== next ? { ...t, section: next } : t;
    }));
  }, []);

  // Sentence-case auto-converter. The trigger is BLUR (the user clicks/tabs off the title).
  // 2 seconds after blur, the title is rewritten in sentence case. If the user comes back to
  // edit the same title within those 2s (focus / pointerdown), the timer is cancelled — so
  // re-edits aren't clobbered mid-type.
  // Per-key timer map. Key format: "task:<id>" | "proj:<id>" | "cli:<id>".
  const sentenceCaseTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const SENTENCE_CASE_DELAY_MS = 2000; // 2 seconds after blur
  // Vocabulary stays a ref so the converter always sees the latest entries without re-binding.
  const vocabRef = useRef<string[]>([]);
  useEffect(() => {
    const vocab: string[] = [];
    for (const c of clients) { if (c.short) vocab.push(c.short); if (c.name) vocab.push(c.name); }
    for (const p of projects) { if (p.name) vocab.push(p.name); }
    for (const pr of people) { if (pr.short) vocab.push(pr.short); if (pr.name) vocab.push(pr.name); }
    vocabRef.current = vocab;
  }, [clients, projects, people]);
  // Words that title-case-style guides keep lowercased even mid-sentence (articles, short
  // conjunctions, prepositions). Used in 'title' mode only. Note: 'up' is a particle that often
  // pairs with a verb ("Catch Up", "Sign Up") so we capitalize it.
  const TITLE_CASE_LOWER = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'nor', 'of', 'on', 'or', 'so', 'the', 'to', 'yet', 'via', 'vs', 'vs.']);
  // Common-typo fixes — applied first, before the case logic. Map of lowercased core →
  // canonical form (preserving the apostrophe / canonical capitalization).
  const TYPO_FIXES: Record<string, string> = {
    im: "I'm",
    ive: "I've",
    ill: "I'll",
    id: "I'd",
    dont: "don't",
    cant: "can't",
    wont: "won't",
    isnt: "isn't",
    arent: "aren't",
    wasnt: "wasn't",
    werent: "weren't",
    didnt: "didn't",
    doesnt: "doesn't",
    hasnt: "hasn't",
    havent: "haven't",
    couldnt: "couldn't",
    wouldnt: "wouldn't",
    shouldnt: "shouldn't",
    youre: "you're",
    youll: "you'll",
    youve: "you've",
    youd: "you'd",
    theyre: "they're",
    theyll: "they'll",
    theyve: "they've",
    theyd: "they'd",
    were: "we're", // ambiguous with past-tense "were" — see comment below
    well: "we'll", // same caveat
    weve: "we've",
    wed: "we'd",
    its: "it's", // ambiguous with possessive "its"
    lets: "let's",
  };
  // The above includes a handful of ambiguous short forms ("its", "were", "well"). We deliberately
  // SKIP those at runtime — too easy to wreck legitimate uses ("the dog wagged its tail",
  // "all is well", "they were here"). Only unambiguous contraction-without-apostrophe fixes fire.
  const SKIP_AMBIGUOUS = new Set(['its', 'were', 'well']);
  const sentenceCaseConvert = useCallback((s: string, mode: CaseMode): string => {
    if (!s || mode === 'off') return s;
    const vocabMap = new Map<string, string>();
    for (const v of vocabRef.current) vocabMap.set(v.toLowerCase(), v);
    // Tokenize keeping whitespace so we can re-stitch with original spacing.
    const parts = s.split(/(\s+)/);
    let firstWordSeen = false;
    return parts.map((part) => {
      if (/^\s*$/.test(part)) return part;
      // Strip leading/trailing punctuation for matching, re-attach after.
      const lead = part.match(/^[^\p{L}\p{N}]+/u)?.[0] ?? '';
      const trail = part.match(/[^\p{L}\p{N}]+$/u)?.[0] ?? '';
      const core = part.slice(lead.length, part.length - trail.length);
      if (!core) return part;
      const isFirst = !firstWordSeen;
      firstWordSeen = true;
      // Vocabulary match — restore the canonical case from the vocab entry.
      const v = vocabMap.get(core.toLowerCase());
      if (v) return lead + v + trail;
      // Common-typo fix: "Im" → "I'm", "dont" → "don't", etc. Skip ambiguous shorts.
      const lowerCore = core.toLowerCase();
      if (TYPO_FIXES[lowerCore] && !SKIP_AMBIGUOUS.has(lowerCore)) {
        return lead + TYPO_FIXES[lowerCore] + trail;
      }
      // Already ALL-CAPS (length ≥ 2, contains a letter) → presumed acronym, leave alone.
      if (core.length >= 2 && core === core.toUpperCase() && /\p{L}/u.test(core)) return part;
      // Mixed case (e.g. iPhone, eBay) — preserve user-typed unusual casing.
      const titleCase = core.charAt(0).toUpperCase() + core.slice(1).toLowerCase();
      const lower = core.toLowerCase();
      const upper = core.toUpperCase();
      if (core !== titleCase && core !== lower && core !== upper) return part;
      // Title case: first word capitalized; otherwise capitalize unless it's a small word
      // (article / preposition / short conjunction).
      if (isFirst) return lead + titleCase + trail;
      if (TITLE_CASE_LOWER.has(lower)) return lead + lower + trail;
      return lead + titleCase + trail;
    }).join('');
  }, []);
  // Schedule (or re-schedule) the per-item 30-minute timer. Each subsequent edit on the same
  // item RESETS the timer — the conversion only fires once the user has been quiet on that
  // specific item for 30 min straight. Other items' timers are independent.
  const scheduleSentenceCase = useCallback((taskId: string) => {
    if (!sentenceCaseEnabled) return;
    const key = `task:${taskId}`;
    const existing = sentenceCaseTimers.current.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      sentenceCaseTimers.current.delete(key);
      setTasks((prev) => prev.map((t) => {
        if (t.id !== taskId) return t;
        const converted = sentenceCaseConvert(t.title, caseMode);
        return converted === t.title ? t : { ...t, title: converted };
      }));
    }, SENTENCE_CASE_DELAY_MS);
    sentenceCaseTimers.current.set(key, timer);
  }, [sentenceCaseEnabled, sentenceCaseConvert]);
  const scheduleSentenceCaseProject = useCallback((id: string) => {
    if (!sentenceCaseEnabled) return;
    const key = `proj:${id}`;
    const existing = sentenceCaseTimers.current.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      sentenceCaseTimers.current.delete(key);
      setProjects((prev) => prev.map((p) => {
        if (p.id !== id) return p;
        const converted = sentenceCaseConvert(p.name, caseMode);
        return converted === p.name ? p : { ...p, name: converted };
      }));
    }, SENTENCE_CASE_DELAY_MS);
    sentenceCaseTimers.current.set(key, timer);
  }, [sentenceCaseEnabled, sentenceCaseConvert]);
  const scheduleSentenceCaseClient = useCallback((id: string) => {
    if (!sentenceCaseEnabled) return;
    const key = `cli:${id}`;
    const existing = sentenceCaseTimers.current.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      sentenceCaseTimers.current.delete(key);
      setClients((prev) => prev.map((c) => {
        if (c.id !== id) return c;
        const converted = sentenceCaseConvert(c.name, caseMode);
        return converted === c.name ? c : { ...c, name: converted };
      }));
    }, SENTENCE_CASE_DELAY_MS);
    sentenceCaseTimers.current.set(key, timer);
  }, [sentenceCaseEnabled, sentenceCaseConvert]);
  // Cancel a pending sentence-case timer. Called when the user re-focuses the title within
  // the 2s window so a mid-conversion clobber can't happen.
  const cancelSentenceCaseTask = useCallback((id: string) => {
    const key = `task:${id}`;
    const t = sentenceCaseTimers.current.get(key);
    if (t) { clearTimeout(t); sentenceCaseTimers.current.delete(key); }
  }, []);

  const renameTask = useCallback((id: string, title: string) => {
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, title } : t)));
    scheduleSentenceCase(id);
  }, [scheduleSentenceCase]);

  const addTask = useCallback((t: Omit<Task, 'id' | 'order'>) => {
    setTasks((prev) => {
      const maxOrder = prev.filter((x) => x.list === t.list && x.section === t.section).reduce((m, x) => Math.max(m, x.order), -1);
      return [...prev, { ...t, id: `task-${Date.now()}`, order: maxOrder + 1 }];
    });
  }, []);

  const updateTask = useCallback((id: string, patch: Partial<Omit<Task, 'id' | 'order'>>) => {
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);
  // Quick reschedule shortcut used by late-date click handlers in the row renderers.
  //   'today'    → deadline = today + section = 'today'
  //   'tomorrow' → deadline = tomorrow + section = 'tomorrow'
  //   'nextWeek' → deadline = today + 7 days + section = 'next'
  //   'shiftBack'→ deadline = current deadline - 1 day (tomorrow → today, today → yesterday…)
  const rescheduleTaskTo = useCallback((id: string, kind: 'today' | 'tomorrow' | 'nextWeek' | 'shiftBack' | 'shiftForward' | 'sectionForward' | 'sectionBack') => {
    setTasks((prev) => prev.map((t) => {
      if (t.id !== id) return t;
      // SECTION-ONLY shifts. For undated tasks the user wants to march them
      // through today → tomorrow → next without auto-promoting them into a
      // dated task. (A task only becomes a "deadline task" when the user
      // explicitly adds one.) Walks the section sequence in either direction
      // and clamps at the ends.
      if (kind === 'sectionForward' || kind === 'sectionBack') {
        const seq: SectionId[] = ['today', 'tomorrow', 'next'];
        const idx = seq.indexOf(t.section);
        if (idx < 0) return t;
        const nextIdx = idx + (kind === 'sectionForward' ? 1 : -1);
        if (nextIdx < 0 || nextIdx >= seq.length) return t; // clamped
        return { ...t, section: seq[nextIdx] };
      }
      const today = new Date(); today.setHours(0, 0, 0, 0);
      let target: Date;
      if (kind === 'shiftBack' || kind === 'shiftForward') {
        // Shift the existing deadline by ±1 day. If no deadline yet, anchor to
        // today so shiftForward goes to tomorrow and shiftBack goes to yesterday.
        const start = t.deadline ? new Date(t.deadline + 'T00:00:00') : new Date(today);
        target = new Date(start);
        target.setDate(start.getDate() + (kind === 'shiftForward' ? 1 : -1));
      } else {
        target = new Date(today);
        if (kind === 'tomorrow') target.setDate(today.getDate() + 1);
        else if (kind === 'nextWeek') target.setDate(today.getDate() + 7);
        // 'today' → leave at today
      }
      const iso = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}-${String(target.getDate()).padStart(2, '0')}`;
      // Section follows the new date: today/past → today, tomorrow → tomorrow, future → next.
      const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      const tomorrowDate = new Date(today); tomorrowDate.setDate(today.getDate() + 1);
      const tomorrowIso = `${tomorrowDate.getFullYear()}-${String(tomorrowDate.getMonth() + 1).padStart(2, '0')}-${String(tomorrowDate.getDate()).padStart(2, '0')}`;
      let section: SectionId;
      if (iso <= todayIso) section = 'today';
      else if (iso === tomorrowIso) section = 'tomorrow';
      else section = 'next';
      return { ...t, deadline: iso, section };
    }));
  }, []);

  const addProject = useCallback((p: Omit<Project, 'id'>) => setProjects((prev) => [...prev, { ...p, id: `p-${Date.now()}` }]), []);
  const addTaskToProject = useCallback((projectId: string, listId: ListId = 'projects') => {
    const id = `task-${Date.now()}`;
    setTasks((prev) => {
      const maxOrder = prev.filter((x) => x.list === listId && x.section === 'today').reduce((m, x) => Math.max(m, x.order), -1);
      return [...prev, { id, title: '', type: 'todo', assignees: currentUserShort ? [currentUserShort] : [], completed: false, list: listId, section: 'today', order: maxOrder + 1, projectId, createdAt: Date.now() }];
    });
    setNewId(id);
  }, [currentUserShort]);
  const addClient = useCallback((c: Omit<Client, 'id'>) => setClients((prev) => [...prev, { ...c, id: `c-${Date.now()}` }]), []);
  const [newId, setNewId] = useState<string | null>(null);
  // Mirror for the blank-task sweep (declared next to the sweep effect, which runs above
  // this state's declaration in file order).
  useEffect(() => { newlyCreatedIdRef.current = newId; }, [newId]);
  // Pending destructive-confirm: when set, the TrashConfirmModal renders. The user must type
  // "TRASH" in the modal before the actual delete fires.
  const [pendingTrash, setPendingTrash] = useState<{ kind: 'project' | 'client'; id: string; name: string } | null>(null);
  // Resource (person) deletes go through a richer two-step flow: optionally reassign their tasks
  // to another resource, then type DELETE to confirm. People are referenced by short across all
  // task assignees, so a careless click can wipe attribution from dozens of tasks.
  const [pendingResourceDelete, setPendingResourceDelete] = useState<{ id: string; name: string; short: string } | null>(null);
  // Focus-mode (project dashboard) state — persisted through Liveblocks Storage so dropped
  // images, briefs, sub-tasks, and references survive reloads and sync across collaborators.
  // Each map is keyed by either a project id (for shared project-level data) or a task id
  // (for task-specific data) — see the projectKey / taskKey resolution inside the focus mode
  // JSX for the routing logic. With nothing selected, both keys are null and the Information
  // panel renders an empty placeholder (no dummy fallback project).
  const [focusBriefs, setFocusBriefs] = useStorageRecord<'focusBriefs', string>('focusBriefs');
  const [focusSubtasks, setFocusSubtasks] = useStorageRecord<'focusSubtasks', { id: string; title: string; completed: boolean }[]>('focusSubtasks');
  const [focusReferences, setFocusReferences] = useStorageRecord<'focusReferences', { label: string; url: string }[]>('focusReferences');
  const [focusNewSubtaskId, setFocusNewSubtaskId] = useState<string | null>(null);
  // Reference images: Liveblocks holds metadata + hosted URL only (~80 bytes per image).
  // The actual binary lives in Supabase Storage. URLs sync across collaborators for free —
  // any client can render the image directly from its Supabase URL.
  // `folderId` (optional): if set, the image belongs to a sub-folder inside its bucket;
  // otherwise it sits at the bucket's root. The folders themselves live in
  // `focusImageFolders[bucketKey]` (see below).
  // `lrAssetId` (optional): set when this image was imported from a Lightroom album,
  // mirroring the LR asset's id. Re-sync uses it to (a) detect duplicates so the
  // same image isn't imported twice and (b) record deleted-from-local in the folder's
  // lrDeletedAssetIds so re-sync doesn't keep re-importing something the user removed.
  const [focusImages, setFocusImages] = useStorageRecord<'focusImages', { id: string; url?: string; dataUrl?: string; filename: string; width: number; height: number; favorited?: boolean; folderId?: string; lrAssetId?: string }[]>('focusImages');
  // Folder definitions per image bucket. The bucket key matches the focusImages key:
  // projectKey for Project, taskKey for Task, or `wip:${projectKey}` for WIP. The
  // array order IS the display order — folders render top-to-bottom in the gallery,
  // each producing a carriage-return row break with the folder icon + name docked
  // left, followed by the images that point at it via folderId.
  // `lrSource`, `lrSyncedAt`, `lrDeletedAssetIds` (all optional): set when this folder
  // was created by a Lightroom import. lrSource records which album the folder mirrors;
  // lrSyncedAt is the unix-ms timestamp of the last successful sync; lrDeletedAssetIds
  // remembers which Lightroom asset ids the user has removed locally, so re-sync
  // skips them instead of re-importing on every pass.
  const [focusImageFolders, setFocusImageFolders] = useStorageRecord<'focusImageFolders', { id: string; name: string; lrSource?: { kind: 'publicShare'; shareId: string; albumId: string } | { kind: 'ownAlbum'; catalogId: string; albumId: string }; lrSyncedAt?: number; lrDeletedAssetIds?: string[] }[]>('focusImageFolders');
  // "Has any Focus-mode content" lookup — returns true if the task itself OR its project
  // has a brief / notes / sub-tasks / images / references stashed against it. Drives the
  // inline FileText icon on every task row. Project-level content IS inherited so users
  // can see at a glance which tasks belong to projects with reference material —
  // previously-suspect "Rivington 123 attached to random tasks" turned out to be orphan
  // storage entries (deleted task ids); the cleanup effect above now drops those, so
  // inheritance is safe again.
  const taskHasFocusContent = useCallback((task: Task): boolean => {
    const tid = task.id;
    const pid = task.projectId;
    if (focusBriefs[tid]?.trim()) return true;
    if (pid && focusBriefs[pid]?.trim()) return true;
    if ((focusSubtasks[tid] || []).length > 0) return true;
    if (pid && (focusSubtasks[pid] || []).length > 0) return true;
    if ((focusImages[tid] || []).length > 0) return true;
    if (pid && (focusImages[pid] || []).length > 0) return true;
    // WIP bucket lives under a derived key — also check it so the inline icon
    // appears for tasks whose project has WIP-zone images attached.
    if (pid && (focusImages[`wip:${pid}`] || []).length > 0) return true;
    if ((focusReferences[tid] || []).length > 0) return true;
    if (pid && (focusReferences[pid] || []).length > 0) return true;
    return false;
  }, [focusBriefs, focusSubtasks, focusImages, focusReferences]);
  // Direct-write mutation that bypasses useStorageRecord's "refuse to wipe" guard.
  // The guard exists to protect against stale-state updaters during reload races, but
  // for an explicit user-requested purge we WANT the records emptied. This writes the
  // empty objects straight to Liveblocks storage with no checks.
  const purgeAllFocusStorage = useMutation(({ storage }) => {
    storage.set('focusBriefs' as never, {} as never);
    storage.set('focusSubtasks' as never, {} as never);
    storage.set('focusImages' as never, {} as never);
    storage.set('focusReferences' as never, {} as never);
  }, []);
  // Restore the entire app state from a backup snapshot. Writes every record
  // straight to Liveblocks Storage in a single mutation, bypassing the
  // useStorageRecord wipe-guard. Caller must confirm with the user — this is
  // destructive: every existing task / project / etc. is replaced.
  const restoreFromSnapshot = useMutation(({ storage }, slice: BackupSlice) => {
    storage.set('tasks' as never, (slice.tasks ?? []) as never);
    storage.set('projects' as never, (slice.projects ?? []) as never);
    storage.set('clients' as never, (slice.clients ?? []) as never);
    storage.set('people' as never, (slice.people ?? []) as never);
    storage.set('focusBriefs' as never, (slice.focusBriefs ?? {}) as never);
    storage.set('focusSubtasks' as never, (slice.focusSubtasks ?? {}) as never);
    storage.set('focusImages' as never, (slice.focusImages ?? {}) as never);
    storage.set('focusReferences' as never, (slice.focusReferences ?? {}) as never);
  }, []);
  // (Removed) The previous one-time `focus-purge-v2` startup wipe is gone for
  // good. It was scoped to localStorage, so opening the app from a NEW origin
  // (e.g. switching from local dev to GitHub Pages, or browser-to-desktop)
  // would re-run the purge there and wipe the cloud (Liveblocks) state again
  // — taking out any references the user had legitimately re-added since the
  // first purge. The purgeAllFocusStorage mutation above is still defined in
  // case we ever need a manual nuke from a Settings button, but it's not
  // wired to a startup effect anymore.
  // --- Local backup hooks ---------------------------------------------------
  // Builds the current backup slice from live state. Used by the auto-snapshot
  // interval and the manual Download Backup button. Declared HERE (after the
  // focus storage hooks it depends on) to avoid a TDZ error.
  const buildCurrentSlice = useCallback((): BackupSlice => ({
    tasks, projects, clients, people,
    focusBriefs, focusSubtasks, focusImages, focusReferences,
  }), [tasks, projects, clients, people, focusBriefs, focusSubtasks, focusImages, focusReferences]);
  // Auto-snapshot tick — runs every 5 minutes while the app is open.
  //   1. Always overwrite the LIVE slot with current state (mirror of "now")
  //   2. If the DAILY slot is missing OR older than 24 hours, refresh it too
  // Skipped entirely when storage hasn't hydrated (room is empty in every
  // record), so we don't write a "blank slate" over a perfectly good daily.
  // Uses a ref for the slice-builder so the interval doesn't need to be
  // re-created every time data changes.
  const sliceRef = useRef(buildCurrentSlice);
  useEffect(() => { sliceRef.current = buildCurrentSlice; }, [buildCurrentSlice]);
  useEffect(() => {
    const tick = async () => {
      const slice = sliceRef.current();
      const total = slice.tasks.length + slice.projects.length + slice.clients.length + slice.people.length;
      if (total === 0) return; // skip pre-hydration / empty-room snapshots
      // 1. Live mirror — overwrite every tick.
      const snapshot = buildSnapshot(slice, 'live');
      try {
        await putSlot('live', snapshot);
        setLiveBackupAt(snapshot.takenAtMs);
      } catch (e) {
        console.warn('[backup] putSlot live failed', e);
      }
      // 2. Daily — refresh only if the existing one is older than 24h (or missing).
      try {
        const existing = await getSlot('daily');
        const stale = !existing || (Date.now() - existing.takenAtMs) > DAILY_REFRESH_MS;
        if (stale) {
          const dailySnap = buildSnapshot(slice, 'daily');
          await putSlot('daily', dailySnap);
          setDailyBackupAt(dailySnap.takenAtMs);
        }
      } catch (e) {
        console.warn('[backup] putSlot daily failed', e);
      }
    };
    // Baseline snapshot ~10s after mount so even a quick close-the-tab session
    // ends with a fresh live backup written.
    const initial = window.setTimeout(() => { void tick(); }, 10_000);
    const id = window.setInterval(() => { void tick(); }, 5 * 60 * 1000);
    return () => { window.clearTimeout(initial); window.clearInterval(id); };
  }, []);
  // Manual download — builds a snapshot from current state and triggers a
  // browser download. Stash this somewhere safe for off-machine recovery.
  const downloadBackup = useCallback(async () => {
    const snapshot = buildSnapshot(buildCurrentSlice());
    downloadSnapshot(snapshot);
  }, [buildCurrentSlice]);
  // Helper: confirm-and-restore from a snapshot's data slice.
  const confirmAndRestore = useCallback((snapshot: BackupSnapshot, label: string): string => {
    const counts = {
      tasks: snapshot.data.tasks.length,
      projects: snapshot.data.projects.length,
      clients: snapshot.data.clients.length,
      people: snapshot.data.people.length,
      focusBriefs: Object.keys(snapshot.data.focusBriefs).length,
      focusSubtasks: Object.keys(snapshot.data.focusSubtasks).length,
      focusImages: Object.keys(snapshot.data.focusImages).length,
      focusReferences: Object.keys(snapshot.data.focusReferences).length,
    };
    const ok = window.confirm(
      `Restore ${label}?\n\n` +
      `Snapshot taken: ${new Date(snapshot.takenAtMs).toLocaleString()}\n\n` +
      `This REPLACES every task, project, client, person, brief, sub-task, image, and reference in the current room.\n\n` +
      `Snapshot contains:\n` +
      `  • ${counts.tasks} tasks  • ${counts.projects} projects  • ${counts.clients} clients  • ${counts.people} people\n` +
      `  • ${counts.focusBriefs} briefs  • ${counts.focusSubtasks} sub-task buckets  • ${counts.focusImages} image buckets  • ${counts.focusReferences} reference buckets`
    );
    if (!ok) return 'Cancelled.';
    restoreFromSnapshot(snapshot.data);
    return `Restored ${label} (taken ${new Date(snapshot.takenAtMs).toLocaleString()}).`;
  }, [restoreFromSnapshot]);
  // Restore from an uploaded JSON file.
  const restoreFromFile = useCallback(async (file: File): Promise<string> => {
    const snapshot = await readSnapshotFile(file);
    return confirmAndRestore(snapshot, `from ${file.name}`);
  }, [confirmAndRestore]);
  // Restore from one of the two named slots in IndexedDB.
  const restoreFromSlot = useCallback(async (slot: 'live' | 'daily'): Promise<string> => {
    const snapshot = await getSlot(slot);
    if (!snapshot) return `No ${slot} backup available yet.`;
    return confirmAndRestore(snapshot, slot === 'live' ? 'live mirror' : '24-hour rolling backup');
  }, [confirmAndRestore]);
  // DAM viewer settings. Tile (justified-gallery / mosaic) is the only layout — uniform row
  // height with aspect-preserving widths. Sub-toggle picks between Zoom All (fit-all height
  // computed from image count) and three fixed row heights (sm / md / lg).
  const [focusDamTileHeight, setFocusDamTileHeight] = useState<'zoom' | 'sm' | 'md' | 'lg'>('md');
  // Scale-and-compress helper. Reads the dropped File, draws it into a canvas at max-side
  // 1920px (longest edge), encodes to WebP at 0.85 quality. Smaller images keep their
  // native dimensions — we only downscale when the longest side > 1920. Now that blobs
  // live in Supabase Storage (and Liveblocks only persists the URL + metadata), the old
  // 1MB-per-key Liveblocks constraint that previously forced 1200/0.75 no longer applies,
  // so we get noticeably crisper references for the cost of a slightly larger blob.
  const scaleAndCompressImage = useCallback(async (file: File) => {
    const objUrl = URL.createObjectURL(file);
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = rej;
      i.src = objUrl;
    });
    const MAX_SIDE = 1920;
    const longSide = Math.max(img.naturalWidth, img.naturalHeight);
    const scale = longSide > MAX_SIDE ? MAX_SIDE / longSide : 1;
    const w = Math.round(img.naturalWidth * scale);
    const h = Math.round(img.naturalHeight * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0, w, h);
    URL.revokeObjectURL(objUrl);
    const blob: Blob = await new Promise((res, rej) => canvas.toBlob((b) => b ? res(b) : rej(new Error('toBlob failed')), 'image/webp', 0.85));
    return { blob, width: w, height: h };
  }, []);
  const addFocusImages = useCallback(async (key: string, files: FileList | File[], folderId?: string, lrAssetIds?: (string | undefined)[]) => {
    const fileArray = Array.from(files);
    // Pre-filter to image files. Track original indices so the parallel
    // lrAssetIds array stays aligned (the LR importer passes one id per file
    // — if non-image files were filtered out without remembering positions
    // the asset-id mapping would slide).
    const list: Array<{ file: File; lrAssetId?: string }> = [];
    fileArray.forEach((f, i) => {
      if (f.type.startsWith('image/')) list.push({ file: f, lrAssetId: lrAssetIds?.[i] });
    });
    if (list.length === 0) return;
    // Process + upload all in parallel. Each one: scale → WebP blob → Supabase upload →
    // metadata-with-URL row. Anything that fails the upload throws here so the user sees
    // it in the dev console; the metadata for that image is skipped (no orphan row).
    // If folderId is provided, every new image is stamped with it so the bucket
    // gallery renders them inside that folder rather than at the bucket root.
    // If lrAssetIds is provided, each image carries the matching asset id so re-sync
    // can recognise duplicates and the delete path can record the asset id in the
    // folder's lrDeletedAssetIds.
    const processed = await Promise.all(list.map(async ({ file, lrAssetId }) => {
      const { blob, width, height } = await scaleAndCompressImage(file);
      const id = `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      let url = '';
      try {
        url = await uploadFocusImage(id, blob);
      } catch (e) {
        console.error('[focusImages] Supabase upload failed', e);
        throw e;
      }
      const meta: { id: string; url: string; filename: string; width: number; height: number; folderId?: string; lrAssetId?: string } = { id, url, filename: file.name, width, height };
      if (folderId) meta.folderId = folderId;
      if (lrAssetId) meta.lrAssetId = lrAssetId;
      return meta;
    }));
    setFocusImages((prev) => ({ ...prev, [key]: [...(prev[key] || []), ...processed] }));
  }, [scaleAndCompressImage, setFocusImages]);
  const deleteFocusImage = useCallback((key: string, id: string) => {
    removeImageDataLocal(id);
    // Evict from the IDB cache too so the local object URL gets revoked and the IDB row freed.
    const target = (focusImages[key] || []).find((img) => img.id === id);
    if (target?.url) evictCachedImage(target.url);
    // Fire-and-forget the Supabase delete — Liveblocks metadata is the source of truth, and
    // an orphan blob is harmless if the delete fails.
    deleteFocusImageBlob(id).catch((e) => console.warn('[focusImages] Supabase delete failed', e));
    setFocusImages((prev) => ({ ...prev, [key]: (prev[key] || []).filter((img) => img.id !== id) }));
    // If the deleted image came from a Lightroom import, record its LR asset id
    // on the parent folder's lrDeletedAssetIds so the next re-sync skips it
    // instead of pulling it back in. The folderId + lrAssetId both come from
    // the image metadata we captured before the splice above.
    if (target?.lrAssetId && target.folderId) {
      const folderId = target.folderId;
      const lrAssetId = target.lrAssetId;
      setFocusImageFolders((prev) => {
        const arr = prev[key] || [];
        const next = arr.map((f) => {
          if (f.id !== folderId) return f;
          const existing = f.lrDeletedAssetIds || [];
          if (existing.includes(lrAssetId)) return f;
          return { ...f, lrDeletedAssetIds: [...existing, lrAssetId] };
        });
        return { ...prev, [key]: next };
      });
    }
  }, [focusImages, setFocusImages, setFocusImageFolders]);
  // Toggle the heart on a reference image. Favorited images bubble to the front of their
  // bucket — the viewer also stable-sorts so unfavorited items keep their relative order.
  const toggleFocusImageFavorite = useCallback((key: string, id: string) => {
    setFocusImages((prev) => {
      const arr = prev[key] || [];
      const idx = arr.findIndex((img) => img.id === id);
      if (idx < 0) return prev;
      const target = arr[idx];
      const updated = { ...target, favorited: !target.favorited };
      const others = arr.filter((img) => img.id !== id);
      const firstUnfavedIdx = others.findIndex((img) => !img.favorited);
      const insertAt = updated.favorited ? 0 : (firstUnfavedIdx < 0 ? others.length : firstUnfavedIdx);
      const next = [...others.slice(0, insertAt), updated, ...others.slice(insertAt)];
      return { ...prev, [key]: next };
    });
  }, [setFocusImages]);
  // ── Image folder helpers ────────────────────────────────────────────────────
  // Folders live PER image bucket (WIP / Project / Task), with the array order
  // doubling as the display order. addFocusFolder PREPENDS a new untitled folder
  // (so the latest one is at the top of the section, matching the gallery's
  // top-of-collection placement) and returns its id so the caller can put it
  // into rename mode immediately.
  const addFocusFolder = useCallback((bucketKey: string): string => {
    const id = `folder-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setFocusImageFolders((prev) => ({
      ...prev,
      [bucketKey]: [{ id, name: '' }, ...(prev[bucketKey] || [])],
    }));
    return id;
  }, [setFocusImageFolders]);
  const renameFocusFolder = useCallback((bucketKey: string, folderId: string, name: string) => {
    setFocusImageFolders((prev) => ({
      ...prev,
      [bucketKey]: (prev[bucketKey] || []).map((f) => f.id === folderId ? { ...f, name } : f),
    }));
  }, [setFocusImageFolders]);
  // Delete a folder. Images that pointed at it become orphans (folderId no longer
  // resolves); we re-home them to the bucket's root by clearing folderId so they
  // re-appear above any remaining folders rather than disappearing. This also keeps
  // the bucket's image array intact — only the folder definition is removed.
  const deleteFocusFolder = useCallback((bucketKey: string, folderId: string) => {
    setFocusImageFolders((prev) => ({
      ...prev,
      [bucketKey]: (prev[bucketKey] || []).filter((f) => f.id !== folderId),
    }));
    setFocusImages((prev) => {
      const arr = prev[bucketKey] || [];
      const next = arr.map((img) => img.folderId === folderId ? { ...img, folderId: undefined } : img);
      return { ...prev, [bucketKey]: next };
    });
  }, [setFocusImageFolders, setFocusImages]);
  // Reorder folders within a bucket via drag-drop. Same shape as reorderFocusSubtask.
  const reorderFocusFolder = useCallback((bucketKey: string, fromId: string, toId: string) => {
    if (fromId === toId) return;
    setFocusImageFolders((prev) => {
      const arr = [...(prev[bucketKey] || [])];
      const fromIdx = arr.findIndex((f) => f.id === fromId);
      const toIdx = arr.findIndex((f) => f.id === toId);
      if (fromIdx < 0 || toIdx < 0) return prev;
      const [moved] = arr.splice(fromIdx, 1);
      arr.splice(toIdx, 0, moved);
      return { ...prev, [bucketKey]: arr };
    });
  }, [setFocusImageFolders]);
  // Move a set of images to a folder (or to the bucket's root if folderId is null)
  // WITHIN the same bucket. Images keep their relative order in the bucket array;
  // only the `folderId` field is mutated. For cross-bucket moves use moveFocusImagesToBucket.
  const moveFocusImagesToFolder = useCallback((bucketKey: string, imageIds: string[], folderId: string | null) => {
    if (imageIds.length === 0) return;
    const idSet = new Set(imageIds);
    setFocusImages((prev) => {
      const arr = prev[bucketKey] || [];
      const next = arr.map((img) => idSet.has(img.id) ? { ...img, folderId: folderId ?? undefined } : img);
      return { ...prev, [bucketKey]: next };
    });
  }, [setFocusImages]);
  // Cross-bucket move: pull the named images out of `fromBucket` and append them
  // to `toBucket`, optionally landing inside a folder in the destination. Used when
  // the user drags a multi-selection from (say) Project into the WIP section, or
  // into a folder header inside another bucket.
  const moveFocusImagesToBucket = useCallback((fromBucket: string, toBucket: string, imageIds: string[], folderId: string | null) => {
    if (fromBucket === toBucket || imageIds.length === 0) return;
    const idSet = new Set(imageIds);
    setFocusImages((prev) => {
      const fromArr = prev[fromBucket] || [];
      const toArr = prev[toBucket] || [];
      const moving = fromArr
        .filter((img) => idSet.has(img.id))
        .map((img) => ({ ...img, folderId: folderId ?? undefined }));
      const fromNext = fromArr.filter((img) => !idSet.has(img.id));
      return { ...prev, [fromBucket]: fromNext, [toBucket]: [...toArr, ...moving] };
    });
  }, [setFocusImages]);
  const addFocusSubtask = useCallback((key: string, afterId?: string) => {
    const id = `sub-${Date.now()}`;
    setFocusSubtasks((prev) => {
      const arr = prev[key] || [];
      if (afterId) {
        const i = arr.findIndex((s) => s.id === afterId);
        if (i >= 0) {
          const next = [...arr.slice(0, i + 1), { id, title: '', completed: false }, ...arr.slice(i + 1)];
          return { ...prev, [key]: next };
        }
      }
      return { ...prev, [key]: [...arr, { id, title: '', completed: false }] };
    });
    setFocusNewSubtaskId(id);
  }, []);
  const renameFocusSubtask = useCallback((key: string, id: string, title: string) => {
    setFocusSubtasks((prev) => ({ ...prev, [key]: (prev[key] || []).map((s) => s.id === id ? { ...s, title } : s) }));
  }, []);
  const toggleFocusSubtask = useCallback((key: string, id: string) => {
    setFocusSubtasks((prev) => ({ ...prev, [key]: (prev[key] || []).map((s) => s.id === id ? { ...s, completed: !s.completed } : s) }));
  }, []);
  const deleteFocusSubtask = useCallback((key: string, id: string) => {
    setFocusSubtasks((prev) => ({ ...prev, [key]: (prev[key] || []).filter((s) => s.id !== id) }));
  }, []);
  // Native HTML5 drag-reorder for sub-tasks. Each row has a small grab handle (only the handle
  // is draggable, so checkbox + title stay clickable / typeable). On drop we move the dragged
  // sub-task's index to the target's index — same shape as a list-view manual reorder.
  const reorderFocusSubtask = useCallback((key: string, fromId: string, toId: string) => {
    if (fromId === toId) return;
    setFocusSubtasks((prev) => {
      const arr = [...(prev[key] || [])];
      const fromIdx = arr.findIndex((s) => s.id === fromId);
      const toIdx = arr.findIndex((s) => s.id === toId);
      if (fromIdx < 0 || toIdx < 0) return prev;
      const [moved] = arr.splice(fromIdx, 1);
      arr.splice(toIdx, 0, moved);
      return { ...prev, [key]: arr };
    });
  }, []);
  // 1-up inline view — when set, the DAM grid collapses to a single full-size image. Single-
  // click on any thumbnail enters 1-up; single-click on the 1-up image exits back to whatever
  // grid/tile view was active. Stays inline (no fullscreen lightbox modal).
  const [focusOneUpImageId, setFocusOneUpImageId] = useState<string | null>(null);
  // Focus page left panel filter: focusProjectId narrows to ONE project; focusClientId narrows
  // to ALL of a client's tasks (clicking a client header). Project wins over client when both
  // are set. Clicking a client filters + expands its accordion; then clicking a sub-project
  // narrows to just that project.
  const [focusProjectId, setFocusProjectId] = useState<string | null>(null);
  const [focusClientId, setFocusClientId] = useState<string | null>(null);
  // Focus-page live search query — filters the day columns + the Milestones column.
  const [focusSearch, setFocusSearch] = useState('');
  // Milestone filter — clicking a milestone (Milestones column or a "Coming Up" card) makes
  // IT the active filter: the milestone row highlights with an × (same visual language as the
  // client/project filter) and the day columns narrow to its project — or, when it has no
  // project, to tasks matching its name via an INVISIBLE query (the search bar stays empty).
  const [focusMilestoneId, setFocusMilestoneId] = useState<string | null>(null);
  const milestoneClickTo = (t: Task) => {
    setFocusClientId(null);
    setFocusProjectId(null);
    setFocusMilestoneId((cur) => (cur === t.id ? null : t.id));
  };
  const focusMilestone = focusMilestoneId ? tasks.find((t) => t.id === focusMilestoneId) ?? null : null;
  const passesMilestoneFilter = (t: Task) => {
    if (!focusMilestone) return true;
    if (focusMilestone.projectId) return t.projectId === focusMilestone.projectId;
    return taskMatchesQuery(t, focusMilestone.title, projects, clients);
  };
  // Edge assign rails: which slide-out drawer is open. Both sides now show the SAME
  // unified tray (Assign To people on top, Assign Project below). 'left' | 'right' just
  // records which edge pulled it out. Opened by hovering/clicking the thin edge bars or by
  // dragging a task card into the edge zones; drops on drawer rows reassign.
  const [edgeDrawer, setEdgeDrawer] = useState<'left' | 'right' | null>(null);
  // Mirror of edgeDrawer for the collision fn (which is a useCallback and would otherwise
  // capture a stale value). The tray's drop rows are always MOUNTED (so dnd-kit measures them
  // at their real on-screen position), so collision must only honour edge hits while the tray
  // is actually open — otherwise a normal first-column drag would be captured by the invisible
  // tray sitting over it.
  const edgeDrawerRef = useRef<'left' | 'right' | null>(null);
  useEffect(() => { edgeDrawerRef.current = edgeDrawer; }, [edgeDrawer]);
  // SINGLE-OPEN accordion in the edge tray: at most one client's projects showing at a time.
  // Lingering over a client header opens it (and closes whichever was open); roll off → null.
  const [edgeExpandedClient, setEdgeExpandedClient] = useState<string | null>(null);
  // Dwell timer for "linger over a client header → its accordion opens" in the tray.
  const trayHoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // SINGLE-OPEN accordion in the focus page's left project-filter panel — opening one client
  // closes the others, so only one is expanded at a time.
  const [focusExpandedClient, setFocusExpandedClient] = useState<string | null>(null);
  // Which PARENT projects are expanded (accordion) to show their sub-projects.
  const [focusExpandedProjects, setFocusExpandedProjects] = useState<Set<string>>(new Set());
  // Drag-to-accordion: while dragging a project, hovering a collapsed parent for a beat
  // auto-expands it so you can drop INTO its subtree. This ref holds the pending dwell timer
  // + which project it's for, so moving off cancels it.
  const focusDwellRef = useRef<{ id: string; timer: number } | null>(null);
  // Drag-over state for the References column. When the user drags a file from
  // outside the app onto the column AND there are already images visible, we
  // overlay an "Add Images" sheet on top of the gallery so they can pick a
  // bucket (Project / Task / WIP). Empty-state path doesn't need this — its
  // drop zones are already on screen.
  const [refsDragActive, setRefsDragActive] = useState(false);
  const refsDragCounter = useRef(0);
  // File-picker ref for the "Add Image +" button on the References toggles row.
  // Click the button → hidden input opens the OS file picker → multi-select
  // images get routed to projectKey by default (or taskKey if no project).
  const refsAddInputRef = useRef<HTMLInputElement | null>(null);
  // Multi-select state for the gallery. A Set of image ids currently selected.
  // Plain click on an image (without modifier) toggles 1-up like before; Cmd/Ctrl-
  // click toggles selection of that one image; Shift-click extends the selection
  // from the most recent anchor click to the clicked image. The anchor is the
  // last id the user clicked WITHOUT shift held, so chains of shift-clicks always
  // pivot off the same point.
  const [selectedImageIds, setSelectedImageIds] = useState<Set<string>>(() => new Set());
  const [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(null);
  // Folder rename inline-edit state. Stores the id of the folder whose label is
  // currently in edit mode (renamed via the inline input next to the icon).
  // Setting null exits rename mode. New folders auto-enter rename mode on creation.
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
  // Favorites-only filter for the references gallery — when active, every
  // bucket renders only its favorited images (folders that go empty under
  // the filter still render, so the user can still see / use them as drop
  // targets while filtered).
  const [favoritesFilterActive, setFavoritesFilterActive] = useState(false);
  // Lightroom import auth + UI state. `lightroomAuthed` mirrors the localStorage
  // token presence; flipped to true when the redirect handler completes the
  // OAuth dance, flipped to false on sign-out (UI not yet wired). The import
  // dialog state controls the share-URL prompt that appears when an
  // authenticated user clicks Import from Lightroom.
  const [lightroomAuthed, setLightroomAuthed] = useState<boolean>(() => hasLightroomAuth());
  const [lightroomImportOpen, setLightroomImportOpen] = useState(false);
  // Lightroom import job state. The dialog is a small state machine:
  //   idle      — empty URL field, "Import" button visible
  //   resolving — looking up the share URL → catalog/album
  //   importing — fetching + processing assets one at a time
  //   done      — all assets imported (count + folder name shown)
  //   error     — something failed (message shown, can retry)
  const [lrImportStatus, setLrImportStatus] = useState<'idle' | 'resolving' | 'importing' | 'done' | 'error' | 'cancelled'>('idle');
  const [lrImportUrl, setLrImportUrl] = useState('');
  const [lrImportError, setLrImportError] = useState<string>('');
  const [lrImportProgress, setLrImportProgress] = useState({ current: 0, total: 0 });
  const [lrImportFolderName, setLrImportFolderName] = useState('');
  // AbortController for the in-flight import. Set when the import job starts;
  // calling .abort() interrupts the asset loop AND cancels any in-flight
  // fetch. Cleared when the job finishes (any outcome).
  const lrImportAbortRef = useRef<AbortController | null>(null);
  // Sync ledger — tracks which folder IDs are currently re-syncing so the
  // auto-sync useEffect doesn't kick off duplicate jobs and the manual
  // Re-sync button can show a spinner. Kept in a ref because nothing visual
  // depends on it precisely; tile re-renders don't need to wait.
  const lrSyncingFolderIdsRef = useRef<Set<string>>(new Set());
  // Import driver — resolves the share URL, creates a folder named after the
  // album, then walks the asset list pulling each image's blob and feeding it
  // into addFocusImages with the new folder's id stamped on. Sequential (one
  // image at a time) to keep the proxy + Supabase upload pipeline from being
  // hammered, and to give a clean per-image progress count.
  const runLightroomImport = useCallback(async (targetBucket: string) => {
    const url = lrImportUrl.trim();
    if (!url) return;
    const controller = new AbortController();
    lrImportAbortRef.current = controller;
    const { signal } = controller;
    setLrImportStatus('resolving');
    setLrImportError('');
    setLrImportProgress({ current: 0, total: 0 });
    const isAbort = (e: unknown): boolean => (e instanceof DOMException && e.name === 'AbortError') || signal.aborted;
    try {
      const resolved = await resolveShareUrl(url);
      if (signal.aborted) { setLrImportStatus('cancelled'); return; }
      if ('error' in resolved) {
        setLrImportError(resolved.error);
        setLrImportStatus('error');
        return;
      }
      const assets = await fetchAlbumAssets(resolved, signal);
      if (signal.aborted) { setLrImportStatus('cancelled'); return; }
      if (assets.length === 0) {
        setLrImportError('Album has no images.');
        setLrImportStatus('error');
        return;
      }
      // Make a folder named after the LR album, stash its id so each image
      // can be stamped with folderId on creation. Folder lands at the top of
      // the section per addFocusFolder's prepend behaviour.
      const folderId = addFocusFolder(targetBucket);
      renameFocusFolder(targetBucket, folderId, resolved.name);
      setLrImportFolderName(resolved.name);
      setLrImportProgress({ current: 0, total: assets.length });
      setLrImportStatus('importing');
      let imported = 0;
      for (const asset of assets) {
        if (signal.aborted) break;
        try {
          const blob = await fetchAssetBlob(asset, signal);
          const file = new File([blob], asset.filename || `${asset.id}.jpg`, { type: blob.type || 'image/jpeg' });
          await addFocusImages(targetBucket, [file], folderId, [asset.id]);
          imported += 1;
          setLrImportProgress({ current: imported, total: assets.length });
        } catch (e) {
          if (isAbort(e)) break;
          console.warn(`[lightroom] failed to import ${asset.filename}:`, e);
          // Continue with remaining assets — partial success beats hard fail.
        }
      }
      // Stamp the folder with the LR source so re-sync knows where to pull
      // from later. Done AFTER the import so we don't auto-sync an empty
      // folder mid-creation. Set even on partial-import / cancelled (the
      // user can re-sync from the same source to fill in the rest).
      const lrSource = resolved.kind === 'publicShare'
        ? { kind: 'publicShare' as const, shareId: resolved.shareId, albumId: resolved.albumId }
        : { kind: 'ownAlbum' as const, catalogId: resolved.catalogId, albumId: resolved.albumId };
      setFocusImageFolders((prev) => ({
        ...prev,
        [targetBucket]: (prev[targetBucket] || []).map((f) => f.id === folderId ? { ...f, lrSource, lrSyncedAt: Date.now() } : f),
      }));
      setLrImportStatus(signal.aborted ? 'cancelled' : 'done');
    } catch (e) {
      if (isAbort(e)) {
        setLrImportStatus('cancelled');
        return;
      }
      console.error('[lightroom] import failed:', e);
      setLrImportError((e as Error).message || 'Unknown error during import.');
      setLrImportStatus('error');
    } finally {
      lrImportAbortRef.current = null;
    }
  }, [lrImportUrl, addFocusFolder, renameFocusFolder, addFocusImages, setFocusImageFolders]);
  // syncLightroomFolder — re-sync an already-imported LR folder. Pulls the
  // current asset list, diffs against:
  //   (a) existing local images in the folder that have an lrAssetId — those
  //       are skipped as duplicates
  //   (b) the folder's lrDeletedAssetIds — assets the user removed locally,
  //       which we mustn't re-import or the delete won't stick
  // …and adds whatever's left. Fire-and-forget; updates lrSyncedAt on the
  // folder regardless of how many were added (so we don't keep poking it).
  // De-duped via lrSyncingFolderIdsRef so the auto-sync useEffect doesn't
  // launch concurrent jobs against the same folder.
  const syncLightroomFolder = useCallback(async (bucketKey: string, folderId: string): Promise<{ added: number; total: number; error?: string }> => {
    if (lrSyncingFolderIdsRef.current.has(folderId)) {
      return { added: 0, total: 0 };
    }
    const folder = (focusImageFoldersRef.current[bucketKey] || []).find((f) => f.id === folderId);
    if (!folder?.lrSource) return { added: 0, total: 0 };
    lrSyncingFolderIdsRef.current.add(folderId);
    try {
      const target: ResolvedTarget = folder.lrSource.kind === 'publicShare'
        ? { kind: 'publicShare', shareId: folder.lrSource.shareId, albumId: folder.lrSource.albumId, name: folder.name }
        : { kind: 'ownAlbum', catalogId: folder.lrSource.catalogId, albumId: folder.lrSource.albumId, name: folder.name };
      const assets = await fetchAlbumAssets(target);
      // Skip set: existing local images in this folder with an lrAssetId,
      // plus the folder's lrDeletedAssetIds (user-removed images).
      const existing = (focusImagesRef.current[bucketKey] || [])
        .filter((i) => i.folderId === folderId && i.lrAssetId);
      const existingLrIds = new Set(existing.map((i) => i.lrAssetId!));
      const deletedLrIds = new Set(folder.lrDeletedAssetIds || []);
      const newAssets = assets.filter((a) => !existingLrIds.has(a.id) && !deletedLrIds.has(a.id));
      let added = 0;
      for (const asset of newAssets) {
        try {
          const blob = await fetchAssetBlob(asset);
          const file = new File([blob], asset.filename || `${asset.id}.jpg`, { type: blob.type || 'image/jpeg' });
          await addFocusImages(bucketKey, [file], folderId, [asset.id]);
          added += 1;
        } catch (e) {
          console.warn(`[lightroom sync] failed to import ${asset.filename}:`, e);
        }
      }
      // Stamp lrSyncedAt regardless of whether we added anything — that's
      // what the auto-sync debounce checks against.
      setFocusImageFolders((prev) => ({
        ...prev,
        [bucketKey]: (prev[bucketKey] || []).map((f) => f.id === folderId ? { ...f, lrSyncedAt: Date.now() } : f),
      }));
      return { added, total: assets.length };
    } catch (e) {
      console.warn('[lightroom sync] failed:', e);
      return { added: 0, total: 0, error: (e as Error).message };
    } finally {
      lrSyncingFolderIdsRef.current.delete(folderId);
    }
  }, [addFocusImages, setFocusImageFolders]);
  // (Auto-sync useEffect lives further down, AFTER selectedTaskId is
  // declared — referencing it from up here would land in the temporal-dead-
  // -zone and crash the whole bundle on first render.)
  // OAuth redirect consumer — runs once at mount. If the URL has ?code=…,
  // exchange it for tokens, then update lightroomAuthed so the import button
  // flips to "ready". Errors are logged; the button stays in the auth state
  // and the user can retry.
  useEffect(() => {
    let cancelled = false;
    consumeOauthRedirect()
      .then((consumed) => {
        if (cancelled) return;
        if (consumed) setLightroomAuthed(true);
      })
      .catch((e) => console.warn('[lightroom] oauth redirect consume failed:', e));
    return () => { cancelled = true; };
  }, []);
  // Refs for the multi-select drag handler — handleDragEnd is wrapped in
  // useCallback and would be recreated on every selection / image change if we
  // depended on the values directly. Using refs lets the callback read the
  // latest snapshot without invalidating its identity (which would cascade and
  // re-bind every drag listener in the tree on every keystroke).
  const selectedImageIdsRef = useRef(selectedImageIds);
  useEffect(() => { selectedImageIdsRef.current = selectedImageIds; }, [selectedImageIds]);
  const focusImagesRef = useRef(focusImages);
  useEffect(() => { focusImagesRef.current = focusImages; }, [focusImages]);
  const focusImageFoldersRef = useRef(focusImageFolders);
  useEffect(() => { focusImageFoldersRef.current = focusImageFolders; }, [focusImageFolders]);
  // Live mirror of the task list — lets purgeEmptyProjects (a stable useCallback) read the
  // current tasks without re-binding on every change.
  const tasksRef = useRef(tasks);
  useEffect(() => { tasksRef.current = tasks; }, [tasks]);
  // Same live mirror for projects — the closed-out-project cleanup (a stable useCallback,
  // triggered from Settings) reads the current list without re-binding on every change.
  const projectsRef = useRef(projects);
  useEffect(() => { projectsRef.current = projects; }, [projects]);
  const clientsRef = useRef(clients);
  useEffect(() => { clientsRef.current = clients; }, [clients]);
  // Gallery-container dimension tracking — Zoom All needs to know how much
  // room the sectioned content has so we can binary-search the largest row
  // height that still fits everything in the viewport. Using a state-based
  // ref (not useRef) so the effect re-runs when the container actually mounts
  // / unmounts as the user switches modes — useRef wouldn't trigger re-render.
  const [galleryContainerEl, setGalleryContainerEl] = useState<HTMLDivElement | null>(null);
  const [galleryContainerDims, setGalleryContainerDims] = useState({ width: 800, height: 600 });
  useLayoutEffect(() => {
    if (!galleryContainerEl) return;
    const el = galleryContainerEl;
    const update = () => setGalleryContainerDims({ width: el.clientWidth, height: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [galleryContainerEl]);
  // 1-up navigation refs. The IIFE that builds the sectioned data writes the
  // visual-order flat list of images plus the per-container groups (folders +
  // bucket roots) here so the keydown / wheel handlers can cycle through them
  // without recomputing the bucket structure. Visual order = same order the
  // user sees in the gallery (folders first, then root, by bucket).
  const damVisualFlatRef = useRef<FocusDamImage[]>([]);
  const damContainersRef = useRef<{ key: string; images: FocusDamImage[] }[]>([]);
  // Wheel throttle for 1-up cycling — without it a smooth-trackpad swipe
  // burns through every image in the gallery on a single gesture.
  const lastDamWheelRef = useRef(0);
  // Selection-anchor mirror so the App-level click handler can read the
  // latest anchor without taking it as a useCallback dependency (which
  // would re-create the callback on every selection change and bust the
  // FocusDamTile React.memo).
  const selectionAnchorIdRef = useRef<string | null>(null);
  useEffect(() => { selectionAnchorIdRef.current = selectionAnchorId; }, [selectionAnchorId]);
  // Dedicated shift-click start. First shift-click of a sequence sets it;
  // subsequent shift-clicks bridge from it; plain click clears it. Ctrl-
  // click leaves it alone so a user can build (ctrl-click A) + (ctrl-click
  // C) + (shift-click G to add C-through-G) without losing A.
  const shiftStartIdRef = useRef<string | null>(null);
  // Stable per-tile click handler. Defined ONCE at App level (deps: []) so
  // the reference is identical across renders — combined with React.memo on
  // FocusDamTile, this means selecting an image only re-renders the tiles
  // that actually changed selection state, not all 50+ tiles in the gallery.
  // All "current state" reads go through refs (selectedImageIdsRef,
  // selectionAnchorIdRef, shiftStartIdRef, damVisualFlatRef), which are kept
  // in sync by the useEffect mirrors above. Without this stabilization,
  // every ctrl-click would re-render the whole gallery + every dnd-kit
  // useSortable hook, producing the perceptible "weird delay" between click
  // and selection outline appearing.
  const handleDamImageClick = useCallback((id: string, e: React.MouseEvent) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod) {
      e.stopPropagation();
      // flushSync forces React to commit the state update + re-render
      // synchronously, before this handler returns. Without it, the
      // setSelectedImageIds was getting batched into a deferred update
      // that didn't paint until the NEXT user interaction — the outline
      // appeared on the second click instead of the first. flushSync
      // pulls the commit into the current event tick so the new selection
      // outline is part of the very next browser paint.
      flushSync(() => {
        setSelectedImageIds((prev) => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
      });
      setSelectionAnchorId(id);
      return;
    }
    if (e.shiftKey) {
      e.stopPropagation();
      const flat = damVisualFlatRef.current;
      const start = shiftStartIdRef.current;
      // First shift-click of a sequence — just select this image and stamp
      // it as the bridge start. The next shift-click will fill the gap
      // between this image and wherever the user lands.
      if (!start) {
        flushSync(() => {
          setSelectedImageIds((prev) => {
            const next = new Set(prev);
            next.add(id);
            return next;
          });
        });
        shiftStartIdRef.current = id;
        setSelectionAnchorId(id);
        return;
      }
      // Subsequent shift-click — add the contiguous range from the
      // shift-start to this image to the selection. We ADD rather than
      // REPLACE so any ctrl-clicked extras stay in the selection. The
      // shift-start sticks: another shift-click will redefine the range
      // from the SAME start, the same way Finder / Explorer do it.
      const a = flat.findIndex((img) => img.id === start);
      const b = flat.findIndex((img) => img.id === id);
      if (a < 0 || b < 0) return;
      const [lo, hi] = a < b ? [a, b] : [b, a];
      const range = flat.slice(lo, hi + 1).map((img) => img.id);
      flushSync(() => {
        setSelectedImageIds((prev) => {
          const next = new Set(prev);
          for (const r of range) next.add(r);
          return next;
        });
      });
      setSelectionAnchorId(id);
      return;
    }
    // Plain click: clear selection, toggle 1-up. Also clear the shift-start
    // so the next shift-click begins a fresh range from where the user
    // clicked, not from a stale prior sequence. No flushSync needed — plain
    // clicks already feel instant because the visual change is the 1-up
    // expansion, not the outline.
    shiftStartIdRef.current = null;
    setSelectedImageIds(new Set());
    setSelectionAnchorId(id);
    setFocusOneUpImageId((cur) => cur === id ? null : id);
  }, []);
  // The currently-selected task. Set on single-click of a task row, or when the user opens
  // the edit / quick-edit panel. The Focus mode's Information column dynamically shows the
  // project tied to this task, and rows render a 25%-brighter highlight while selected.
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  // Lightroom auto-sync trigger. Fires whenever the user lands on a different
  // task (which changes the active project / task / wip buckets in Focus
  // mode). Walks every folder in those buckets and kicks a background sync
  // for any with an lrSource that hasn't synced in the last 60 seconds.
  // syncLightroomFolder de-dupes via lrSyncingFolderIdsRef so concurrent
  // triggers (e.g. from a fast task-switch) don't pile up jobs on the same
  // folder. Only runs in Focus mode — no point pulling LR data when the
  // user is in List or Calendar view.
  // NOTE: this useEffect lives HERE (after selectedTaskId is declared)
  // rather than next to syncLightroomFolder up above, because including
  // selectedTaskId in the dep array before its declaration is hit lands
  // in the temporal-dead-zone and crashes the bundle at first render.
  useEffect(() => {
    if (mode !== 'focus') return;
    const sel = selectedTaskId ? tasks.find((t) => t.id === selectedTaskId) : null;
    const proj = sel?.projectId ? projects.find((p) => p.id === sel.projectId) : null;
    const projectKey = proj?.id ?? null;
    const taskKey = sel?.id ?? null;
    const wipKey = projectKey ? `wip:${projectKey}` : null;
    const buckets = [projectKey, taskKey, wipKey].filter((k): k is string => !!k);
    if (buckets.length === 0) return;
    const STALE_MS = 60_000;
    const now = Date.now();
    const folders = focusImageFoldersRef.current;
    for (const bucket of buckets) {
      for (const f of folders[bucket] || []) {
        if (!f.lrSource) continue;
        if (f.lrSyncedAt && now - f.lrSyncedAt < STALE_MS) continue;
        // Background — don't await. syncLightroomFolder handles its own
        // errors and updates state when finished.
        syncLightroomFolder(bucket, f.id);
      }
    }
  }, [mode, selectedTaskId, tasks, projects, syncLightroomFolder]);
  // Liveblocks history hooks — Cmd/Ctrl+Z undoes the last storage mutation, Cmd/Ctrl+Shift+Z (or
  // Ctrl+Y on Windows) redoes. Skip when the user is editing text so the browser's native input
  // undo handles in-progress typing.
  const undo = useUndo();
  const redo = useRedo();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Escape exits 1-up view if active.
      if (focusOneUpImageId && e.key === 'Escape') { e.preventDefault(); setFocusOneUpImageId(null); return; }
      // 1-up navigation: arrow keys cycle. Left / Right walk the visual flat
      // list (every image, in gallery order). Up / Down jump to the next /
      // previous container (folder or bucket-root) and land on its first image.
      // Empty containers are skipped so the user always lands on an actual
      // image. Wrap-around is preserved at both ends.
      if (focusOneUpImageId && (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        const flat = damVisualFlatRef.current;
        if (flat.length === 0) return;
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          const idx = flat.findIndex((img) => img.id === focusOneUpImageId);
          if (idx < 0) return;
          e.preventDefault();
          const dir = e.key === 'ArrowRight' ? 1 : -1;
          const next = (idx + dir + flat.length) % flat.length;
          setFocusOneUpImageId(flat[next].id);
          return;
        }
        // Up / Down — folder hop. Build "current container key" from the
        // current image, then walk to the next non-empty container.
        const containers = damContainersRef.current;
        if (containers.length === 0) return;
        const cur = flat.find((img) => img.id === focusOneUpImageId);
        if (!cur) return;
        const containerKey = `${cur.ownerKey}::${cur.folderId ?? 'root'}`;
        let containerIdx = containers.findIndex((c) => c.key === containerKey);
        if (containerIdx < 0) return;
        e.preventDefault();
        const dir = e.key === 'ArrowDown' ? 1 : -1;
        // Walk up to one full revolution looking for a non-empty container.
        for (let attempts = 0; attempts < containers.length; attempts++) {
          containerIdx = (containerIdx + dir + containers.length) % containers.length;
          const next = containers[containerIdx];
          if (next.images.length > 0) {
            setFocusOneUpImageId(next.images[0].id);
            return;
          }
        }
        return;
      }
      const t = e.target as HTMLElement | null;
      const inEditable = !!(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable));
      const isMod = e.ctrlKey || e.metaKey;
      // Cmd/Ctrl-Z / Y — undo / redo, skip when typing.
      if (isMod && !inEditable) {
        const k = e.key.toLowerCase();
        if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
        if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); redo(); return; }
      }
      // Arrow nav between task rows. Strict guards so this only intercepts
      // arrows when there's an EXISTING selection — otherwise the user's
      // arrow keys remain free for normal browser behavior (form fields,
      // contentEditable, etc.). Tab is intentionally NOT intercepted —
      // standard focus traversal needs to keep working app-wide.
      if (inEditable) return;
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      // Only navigate when there's already a selected task — otherwise let
      // arrow keys do their default thing (page scroll, focus, etc.).
      if (!selectedTaskId) return;
      const rows = Array.from(document.querySelectorAll('[data-task-row]')) as HTMLElement[];
      if (rows.length === 0) return;
      const currentIdx = rows.findIndex((el) => el.getAttribute('data-task-row') === selectedTaskId);
      if (currentIdx < 0) return;
      const isDown = e.key === 'ArrowDown';
      let nextIdx = isDown ? currentIdx + 1 : currentIdx - 1;
      if (nextIdx < 0 || nextIdx >= rows.length) return;
      e.preventDefault();
      const nextId = rows[nextIdx].getAttribute('data-task-row');
      if (nextId) setSelectedTaskId(nextId);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, focusOneUpImageId, selectedTaskId]);
  const addBlankClient = useCallback(() => {
    const id = `c-${Date.now()}`;
    setClients((prev) => [...prev, { id, name: '', short: '' }]);
    setNewId(id);
  }, []);
  const addBlankProject = useCallback((clientId?: string, list?: ListId) => {
    const id = `p-${Date.now()}`;
    setProjects((prev) => [...prev, { id, name: '', clientId, list }]);
    setNewId(id);
  }, []);
  // Pin an UNPINNED project to a list — called when the edit panel assigns the project to
  // a task, so the project's list affiliation becomes permanent ("House is admin, always").
  // Already-pinned projects are left alone.
  const pinProjectList = useCallback((id: string, list: ListId) => {
    setProjects((prev) => prev.map((p) => (p.id === id && !p.list ? { ...p, list } : p)));
  }, []);
  // Nest a project under another (drag-to-accordion) or un-nest it (parentId = undefined).
  // Guards: no self-parenting, and no cycles — walk the prospective parent's ancestor chain
  // and refuse if `id` is already an ancestor (would orphan the subtree).
  const setProjectParent = useCallback((id: string, parentId: string | undefined) => {
    if (id === parentId) return;
    setProjects((prev) => {
      if (parentId) {
        const byId = new Map(prev.map((p) => [p.id, p]));
        let cur = byId.get(parentId);
        let hops = 0;
        while (cur && hops < 100) {
          if (cur.id === id) return prev; // parentId is a descendant of id → cycle, abort
          cur = cur.parentId ? byId.get(cur.parentId) : undefined;
          hops++;
        }
      }
      return prev.map((p) => (p.id === id ? { ...p, parentId } : p));
    });
  }, []);
  const addBlankTaskInList = useCallback((listId: ListId) => {
    const id = `task-${Date.now()}`;
    setTasks((prev) => {
      const maxOrder = prev.filter((x) => x.list === listId && x.section === 'today').reduce((m, x) => Math.max(m, x.order), -1);
      return [...prev, { id, title: '', type: 'todo', assignees: currentUserShort ? [currentUserShort] : [], completed: false, list: listId, section: 'today', order: maxOrder + 1, createdAt: Date.now() }];
    });
    setNewId(id);
  }, [currentUserShort]);
  // opts lets a caller stamp the new task with a project/client. Critical for the dashboard +
  // buttons while a left-panel FILTER is active: without inheriting the filter's project/client
  // the fresh task fails the scope filter and vanishes the instant it's created ("disappears
  // instantly"). projectId wins over clientId when both are somehow supplied.
  const addBlankTaskInSection = useCallback((listId: ListId, section: SectionId, opts?: { projectId?: string; clientId?: string }) => {
    const id = `task-${Date.now()}`;
    setTasks((prev) => {
      const maxOrder = prev.filter((x) => x.list === listId && x.section === section).reduce((m, x) => Math.max(m, x.order), -1);
      const extra: Partial<Task> = {};
      if (opts?.projectId) extra.projectId = opts.projectId;
      else if (opts?.clientId) extra.clientId = opts.clientId;
      return [...prev, { id, title: '', type: 'todo', assignees: currentUserShort ? [currentUserShort] : [], completed: false, list: listId, section, order: maxOrder + 1, createdAt: Date.now(), ...extra }];
    });
    setNewId(id);
  }, [currentUserShort]);
  // Quick-add for a calendar DAY cell: create a blank task dated to `iso` in `listId`. Section
  // follows the day (today / tomorrow → those sections so they show as mandatory; any other day
  // → 'next' with the deadline pinning it to that column). Autofocuses inline like every other +.
  const addTaskOnDay = useCallback((listId: ListId, iso: string) => {
    const id = `task-${Date.now()}`;
    const today = todayISO();
    const tomorrow = (() => { const d = new Date(); d.setHours(d.getHours() - 4); d.setDate(d.getDate() + 1); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; })();
    const section: SectionId = iso === today ? 'today' : iso === tomorrow ? 'tomorrow' : 'next';
    setTasks((prev) => {
      const maxOrder = prev.filter((x) => x.list === listId && x.deadline === iso).reduce((m, x) => Math.max(m, x.order), -1);
      return [...prev, { id, title: '', type: 'todo', assignees: currentUserShort ? [currentUserShort] : [], completed: false, list: listId, section, order: maxOrder + 1, deadline: iso, createdAt: Date.now() }];
    });
    setNewId(id);
  }, [currentUserShort]);
  // Add a blank task as a sibling of an existing one: same list/section/project, inserted right after it.
  // pinDeadline (calendar callsites): keeps the new task in the CELL it was spawned from.
  // A sibling created from a calendar card inherits the source's deadline; if the source is
  // an undated queue task shown on a future day, the cell's date is pinned instead — without
  // it the blank sibling fell into the queue and "disappeared" from the cell the user was
  // looking at.
  const addSiblingTask = useCallback((sibling: Task, pinDeadline?: string) => {
    const id = `task-${Date.now()}`;
    // If the sibling is a milestone (type === 'scheduled'), spawn another milestone — not a
    // regular todo. The user clicked + on a milestone row, so they want to author another
    // milestone in the same project, not demote the action into a sibling task.
    const isMilestoneSibling = sibling.type === 'scheduled';
    setTasks((prev) => {
      const bucket = prev.filter((t) => t.list === sibling.list && t.section === sibling.section).sort((a, b) => a.order - b.order);
      const idx = bucket.findIndex((t) => t.id === sibling.id);
      const newTask: Task = {
        id,
        title: '',
        type: isMilestoneSibling ? 'scheduled' : 'todo',
        assignees: currentUserShort ? [currentUserShort] : [],
        completed: false,
        list: sibling.list,
        section: sibling.section,
        order: 0,
        projectId: sibling.projectId,
        // Carry the clientId too so a sibling milestone inherits the parent's client (regular
        // tasks normally derive client via project, but milestones often have only clientId).
        clientId: sibling.clientId,
        deadline: sibling.deadline ?? pinDeadline,
        // Stamp creation time — this site was MISSED when the blank-task sweep landed, so
        // fresh siblings (createdAt undefined) counted as "legacy expired" and were reaped
        // by the very next 30-second sweep. That was the "new task disappears" bug.
        createdAt: Date.now(),
      };
      const insertAt = idx >= 0 ? idx + 1 : bucket.length;
      const reordered = [...bucket.slice(0, insertAt), newTask, ...bucket.slice(insertAt)].map((t, i) => ({ ...t, order: i }));
      const untouched = prev.filter((t) => !(t.list === sibling.list && t.section === sibling.section));
      return [...untouched, ...reordered];
    });
    setNewId(id);
  }, [currentUserShort]);
  const addPerson = useCallback(() => {
    const id = `pr-${Date.now()}`;
    setPeople((prev) => [...prev, { id, name: '', short: '?' }]);
    setNewId(id);
  }, []);
  const deleteProject = useCallback((id: string) => setProjects((prev) => prev.filter((p) => p.id !== id)), []);
  const deleteClient = useCallback((id: string) => setClients((prev) => prev.filter((c) => c.id !== id)), []);
  // Purge "ghost" projects — blank-named projects that carry no tasks and aren't the one
  // currently being named (newId). These accumulate when a + spawns a project the user
  // never titles. Returns how many were removed so the caller can surface it.
  const purgeEmptyProjects = useCallback((): number => {
    let removed = 0;
    setProjects((prev) => {
      const usedIds = new Set(tasksRef.current.map((t) => t.projectId).filter(Boolean) as string[]);
      const kept = prev.filter((p) => {
        const isGhost = !(p.name || '').trim() && !usedIds.has(p.id) && p.id !== newlyCreatedIdRef.current;
        if (isGhost) removed++;
        return !isGhost;
      });
      return removed > 0 ? kept : prev;
    });
    return removed;
  }, []);
  // "Closed-out" projects — the NAMED, task-less strays that the ghost purge deliberately
  // leaves alone (it only removes untitled ones, so it never deletes something you titled).
  // These are what pile up at the bottom of the project lists after a project's tasks are
  // all cleared. A project counts as closed-out only if it has a name, is referenced by NO
  // task at all (any status), and isn't a parent of other projects (so nesting is never
  // orphaned). Returned for display; removal is a separate, explicit step.
  const listClosedOutProjects = useCallback((): { id: string; name: string }[] => {
    const usedIds = new Set(tasksRef.current.map((t) => t.projectId).filter(Boolean) as string[]);
    const parentIds = new Set(projectsRef.current.map((p) => p.parentId).filter(Boolean) as string[]);
    return projectsRef.current
      .filter((p) => (p.name || '').trim() && !usedIds.has(p.id) && !parentIds.has(p.id) && p.id !== newlyCreatedIdRef.current)
      .map((p) => ({ id: p.id, name: p.name }));
  }, []);
  const removeProjectsByIds = useCallback((ids: string[]): number => {
    if (!ids.length) return 0;
    const idSet = new Set(ids);
    setProjects((prev) => prev.filter((p) => !idSet.has(p.id)));
    return ids.length;
  }, []);
  // "Straggler" projects — the ones with no client (or a client that no longer exists) that pile
  // up at the bottom of the project lists. Returned with a live (non-trashed) task count so the
  // user can see what each actually is before deciding to remove it.
  const listStragglerProjects = useCallback((): { id: string; name: string; taskCount: number }[] => {
    const clientIds = new Set(clientsRef.current.map((c) => c.id));
    const counts = new Map<string, number>();
    tasksRef.current.forEach((t) => { if (t.projectId && !t.trashed) counts.set(t.projectId, (counts.get(t.projectId) || 0) + 1); });
    return projectsRef.current
      .filter((p) => !p.clientId || !clientIds.has(p.clientId))
      .map((p) => ({ id: p.id, name: p.name || 'Untitled', taskCount: counts.get(p.id) || 0 }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, []);
  // Remove a straggler project. Any tasks it holds are moved to Trash (recoverable in
  // Settings → Trash), never hard-deleted, and any sub-projects are promoted to top level so
  // nesting is never left dangling.
  const deleteStragglerProject = useCallback((id: string) => {
    setTasks((prev) => prev.map((t) => (t.projectId === id && !t.trashed ? { ...t, trashed: true, trashedAt: Date.now(), revivedAt: undefined } : t)));
    setProjects((prev) => prev.filter((p) => p.id !== id).map((p) => (p.parentId === id ? { ...p, parentId: undefined } : p)));
  }, []);
  const renameProject = useCallback((id: string, name: string) => {
    setProjects((prev) => prev.map((p) => (p.id === id ? { ...p, name } : p)));
    scheduleSentenceCaseProject(id);
  }, [scheduleSentenceCaseProject]);
  const contractName = useCallback((name: string): string => {
    const trimmed = name.trim();
    if (trimmed.length <= 6) return trimmed;
    const words = trimmed.split(/\s+/);
    if (words.length > 1) {
      const initials = words.map((w) => w[0]?.toUpperCase() || '').join('');
      if (initials.length <= 6) return initials;
      return initials.slice(0, 6);
    }
    const first = trimmed[0];
    const rest = trimmed.slice(1).replace(/[aeiou]/gi, '');
    const condensed = first + rest;
    return condensed.slice(0, 6);
  }, []);
  const renameClient = useCallback((id: string, name: string) => {
    setClients((prev) => prev.map((c) => {
      if (c.id !== id) return c;
      // Auto-update the short on rename UNLESS the user manually customized it.
      // Heuristic: if the current short matches contractName(currentName), it was auto-generated
      // — keep it in sync with the new name. If it differs, the user typed something custom in
      // ShortInBrackets, so leave it alone.
      const shouldAutoShort = id === newId || !c.short || c.short === contractName(c.name);
      return { ...c, name, short: shouldAutoShort ? contractName(name) : c.short };
    }));
    scheduleSentenceCaseClient(id);
  }, [newId, contractName, scheduleSentenceCaseClient]);
  const renameClientShort = useCallback((id: string, short: string) => {
    setClients((prev) => prev.map((c) => (c.id === id ? { ...c, short } : c)));
  }, []);
  const renamePerson = useCallback((id: string, name: string) => setPeople((prev) => prev.map((p) => (p.id === id ? { ...p, name } : p))), []);
  const renamePersonShort = useCallback((id: string, short: string) => {
    setPeople((prev) => {
      const prior = prev.find((p) => p.id === id)?.short;
      if (prior && prior !== short) {
        setTasks((ts) => ts.map((t) => ({ ...t, assignees: t.assignees.map((a) => (a === prior ? short : a)) as typeof t.assignees })));
      }
      return prev.map((p) => (p.id === id ? { ...p, short } : p));
    });
  }, []);
  const deletePerson = useCallback((id: string) => {
    // When a person is removed, also strip their short from every task's assignees so we don't
    // leave orphaned badges (still rendering the deleted person's initial) on tasks.
    setPeople((prev) => {
      const removed = prev.find((p) => p.id === id);
      const removedShort = removed?.short;
      if (removedShort) {
        setTasks((tasksPrev) => tasksPrev.map((t) => (
          t.assignees.includes(removedShort)
            ? { ...t, assignees: t.assignees.filter((a) => a !== removedShort) }
            : t
        )));
      }
      return prev.filter((p) => p.id !== id);
    });
  }, [setTasks]);
  // Open the two-step delete-confirm flow for a resource. If the person is unnamed/no-short and
  // has no assignments, fall through to a direct delete — confirm UI for an empty stub feels noisy.
  const requestDeleteResource = useCallback((id: string) => {
    const p = people.find((x) => x.id === id);
    if (!p) return;
    if (!p.short) { deletePerson(id); return; }
    setPendingResourceDelete({ id: p.id, name: p.name || '(unnamed)', short: p.short });
  }, [people, deletePerson]);
  // Finalize the delete. If reassignToShort is set, every task that had the deleted resource's
  // short gets the replacement appended (deduped) before the original is stripped. If null, the
  // short is just removed (existing deletePerson behavior).
  const confirmDeleteResource = useCallback((reassignToShort: string | null) => {
    setPendingResourceDelete((target) => {
      if (!target) return null;
      const removedShort = target.short;
      if (removedShort) {
        setTasks((prev) => prev.map((t) => {
          if (!t.assignees.includes(removedShort)) return t;
          const without = t.assignees.filter((a) => a !== removedShort);
          if (reassignToShort && !without.includes(reassignToShort)) without.push(reassignToShort);
          return { ...t, assignees: without };
        }));
      }
      setPeople((prev) => prev.filter((p) => p.id !== target.id));
      return null;
    });
  }, [setTasks, setPeople]);

  const handleDragStart = useCallback((e: DragStartEvent) => {
    const type = e.active.data.current?.type;
    if (type === 'focusProject') {
      setActiveId(e.active.id as string);
      setActiveType('focusProject');
      setActiveFocusProject(e.active.data.current?.project as Project);
      return;
    }
    if (type === 'project') {
      setActiveId(e.active.id as string);
      setActiveType('project');
      setActiveProject(e.active.data.current?.project as Project);
      const rect = e.active.rect.current.initial;
      if (rect) setActiveRectWidth(rect.width);
      return;
    }
    if (type === 'projTask') {
      setActiveId(e.active.id as string);
      setActiveType('projTask');
      setActiveProjTask(e.active.data.current?.task as Task);
      const rect = e.active.rect.current.initial;
      if (rect) setActiveRectWidth(rect.width);
      return;
    }
    // DAM image drag: capture the image + the multi-select count so the
    // DragOverlay can render the floating preview at the source tile's exact
    // size, plus a "+N" badge if a multi-selection is being moved together.
    if (type === 'damImage') {
      setActiveId(e.active.id as string);
      setActiveType('damImage');
      const img = e.active.data.current?.img as FocusDamImage | undefined;
      setActiveDamImage(img ?? null);
      const draggedId = e.active.data.current?.imageId as string | undefined;
      const sel = selectedImageIdsRef.current;
      const isInSelection = !!draggedId && sel.has(draggedId);
      setActiveDamMultiCount(isInSelection && sel.size > 1 ? sel.size : 1);
      const rect = e.active.rect.current.initial;
      if (rect) { setActiveRectWidth(rect.width); setActiveRectHeight(rect.height); }
      return;
    }
    setActiveId(e.active.id as string);
    setActiveTaskIdState((e.active.data.current?.task as Task | undefined)?.id ?? String(e.active.id));
    setActiveType('task');
    const rect = e.active.rect.current.initial;
    if (rect && rect.width > 0) {
      setActiveRectWidth(rect.width); setActiveRectHeight(rect.height);
    } else {
      // iOS-Safari fast-path: TouchSensor's long-press activation can fire
      // before dnd-kit's measuring loop has populated rect.current.initial.
      // Fall back to a direct getBoundingClientRect() on the source row
      // via its data-task-row attribute — without this the DragOverlay
      // wrapper renders width:0 and you see only the text floating
      // without the card backdrop.
      const taskId = (e.active.data.current?.task as Task | undefined)?.id;
      if (taskId) {
        // Calendar/focus cards carry data-cal-card; list rows carry data-task-row. Measure
        // whichever exists so the drag overlay always locks to the REAL card size + layout
        // instead of falling back to the stubby default width (which wrapped to two rows).
        const el = (document.querySelector(`[data-cal-card="${taskId}"]`) || document.querySelector(`[data-task-row="${taskId}"]`)) as HTMLElement | null;
        if (el) {
          const r = el.getBoundingClientRect();
          if (r.width > 0) { setActiveRectWidth(r.width); setActiveRectHeight(r.height); }
        }
      }
    }
    // Calendar cards tag their useSortable data with calendarCellId; remember it so the overlay
    // and the column-offset effect can both branch on calendar vs list origin.
    const cellId = (e.active.data.current?.calendarCellId as string | undefined) || null;
    setActiveCalendarCellId(cellId);
    setColumnOffset(0);
  }, []);

  // Source-collapse: ALWAYS trigger after a short delay, regardless of cursor direction. Previously
  // this was tied to horizontal column-offset, which meant vertical-only drags (e.g. moving a task
  // between sections in the same column) never collapsed â€” and worse, the source slot would flicker
  // open again any time the cursor returned to column 0. Decoupling fixes both.
  useEffect(() => {
    if (!activeId) return;
    const t = setTimeout(() => setSourceCollapsed(true), 220);
    return () => { clearTimeout(t); };
  }, [activeId]);

  useEffect(() => {
    if (!activeId) return;
    // Column-offset snap: drag right/left and the overlay snaps to adjacent columns once you
    // pass half a column width. Now active for calendar too — restrictToHorizontalAxis locks
    // the Y to the source row, and the snap gives a clear "card jumped to next day" feedback.
    // Dashboard drags are strictly horizontally locked — never snap to an adjacent column.
    if (activeId.startsWith('dash:')) return;
    if (activeId.startsWith('projtask-') || activeId.startsWith('projrow-')) return;
    const onMove = (ev: PointerEvent) => {
      if (startXRef.current === null) startXRef.current = ev.clientX;
      const colWidth = activeRectWidth || 440;
      const deadZone = colWidth * 0.5;
      const raw = ev.clientX - startXRef.current;
      let target = 0;
      if (Math.abs(raw) > deadZone) target = Math.round(raw / colWidth);
      if (target !== pendingOffsetRef.current) {
        pendingOffsetRef.current = target;
        setColumnOffset(target);
      }
    };
    window.addEventListener('pointermove', onMove);
    return () => {
      window.removeEventListener('pointermove', onMove);
      startXRef.current = null;
    };
  }, [activeId, activeRectWidth, activeCalendarCellId]);

  // Tracks the id of the most recent calendar TASK the cursor was over (before
  // calendarCollision's cross-list redirect). Used by the cell-drop handler to insert at
  // the user's intended position rather than appending to the end of the destination bucket.
  const lastCalOverTaskIdRef = useRef<string | null>(null);
  // Tracks the cell id (cal:date:listId) the cursor was actually over BEFORE the category
  // redirect. Lets the cell-drop handler tell whether the user released ABOVE the source
  // category band (→ insert at top of source bucket) or BELOW (→ insert at bottom).
  const lastCalOverCellIdRef = useRef<string | null>(null);
  const handleDragOver = useCallback((event: DragOverEvent) => {
    const { active, over } = event;
    setOverId((over?.id as string) || null);
    // Drag-to-accordion: while dragging a project, dwelling over a collapsed parent for a beat
    // auto-expands it so the user can drop into the subtree. `event.active.data` is always
    // current (state would be stale in this []-deps callback).
    if (active.data.current?.type === 'focusProject') {
      const oid = over ? String(over.id) : '';
      const target = oid.startsWith('focusnest:') ? oid.slice('focusnest:'.length) : '';
      const dragged = active.data.current.projectId as string;
      if (target && target !== '__root__' && target !== dragged) {
        if (focusDwellRef.current?.id !== target) {
          if (focusDwellRef.current) clearTimeout(focusDwellRef.current.timer);
          const timer = window.setTimeout(() => {
            setFocusExpandedProjects((prev) => { const n = new Set(prev); n.add(target); return n; });
            focusDwellRef.current = null;
          }, 1200);
          focusDwellRef.current = { id: target, timer };
        }
      } else if (focusDwellRef.current) {
        clearTimeout(focusDwellRef.current.timer); focusDwellRef.current = null;
      }
      return;
    }
    // If over is a task (not a cell), remember its id. If user dragged off everything, clear.
    const overTask = over?.data.current?.task as Task | undefined;
    if (overTask) {
      lastCalOverTaskIdRef.current = overTask.id;
      setOverTaskIdHint(overTask.id);
    } else if (!over) {
      lastCalOverTaskIdRef.current = null;
      setOverTaskIdHint(null);
    }
    // (when over is a redirected cell id, calendarCollision has already updated the ref/state
    //  via pushHint; we leave them alone here so the hint persists across the redirect.)
  }, []);

  const handleCrossSectionMove = useCallback((a: Task, o: Task) => {
    setTasks((prev) => {
      const fromOthers = prev.filter((t) => t.list === a.list && t.section === a.section && t.id !== a.id).map((t, i) => ({ ...t, order: i }));
      const toOthers = prev.filter((t) => t.list === o.list && t.section === o.section);
      const overIndex = toOthers.findIndex((t) => t.id === o.id);
      const moved = { ...a, list: o.list, section: o.section };
      const reorderedTo = [...toOthers.slice(0, overIndex), moved, ...toOthers.slice(overIndex)].map((t, i) => ({ ...t, order: i }));
      const untouched = prev.filter((t) => !(t.list === a.list && t.section === a.section) && !(t.list === o.list && t.section === o.section));
      return [...untouched, ...fromOthers, ...reorderedTo];
    });
  }, []);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    setOverId(null);
    setOverTaskIdHint(null);
    const clearOverlay = () => { setActiveId(null); setActiveTaskIdState(null); setActiveType(null); setActiveProject(null); setActiveProjTask(null); setActiveCalendarCellId(null); setActiveDamImage(null); setActiveDamMultiCount(1); setActiveFocusProject(null); };
    // Cancel any pending drag-to-accordion dwell.
    if (focusDwellRef.current) { clearTimeout(focusDwellRef.current.timer); focusDwellRef.current = null; }
    // Focus-panel project nesting: dropped a project onto another → nest; onto the un-nest
    // zone (focusnest:__root__) → clear parent. Handled early so it can't fall through to the
    // task-drop paths below.
    if (active.data.current?.type === 'focusProject') {
      const draggedId = active.data.current.projectId as string;
      const overIdRaw = over ? String(over.id) : '';
      if (overIdRaw.startsWith('focusnest:')) {
        const target = overIdRaw.slice('focusnest:'.length);
        setProjectParent(draggedId, target === '__root__' ? undefined : target);
      }
      clearOverlay();
      return;
    }
    const resetDragRefs = () => {
      setColumnOffset(0); pendingOffsetRef.current = 0;
      if (dwellTimerRef.current) { clearTimeout(dwellTimerRef.current); dwellTimerRef.current = null; }
      if (collapseTimerRef.current) { clearTimeout(collapseTimerRef.current); collapseTimerRef.current = null; }
      setSourceCollapsed(false);
    };
    // Sub-task drag-reorder. Same dnd-kit sortable plumbing as the rest of the app —
    // active.data carries { type: 'subtask', key, subId } and over carries the same on the
    // drop target. Handles intra-list reorder only (sub-tasks don't move across keys).
    if (active.data.current?.type === 'subtask') {
      const fromId = active.data.current.subId as string;
      const key = active.data.current.key as string;
      const overData = over?.data.current;
      if (overData?.type === 'subtask' && overData.key === key) {
        const toId = overData.subId as string;
        if (fromId && toId && fromId !== toId) reorderFocusSubtask(key, fromId, toId);
      }
      resetDragRefs();
      clearOverlay();
      return;
    }
    // DAM folder drag-reorder. Folders are sortable within their bucket — same
    // shape as the sub-task reorder above. Cross-bucket folder moves aren't a
    // thing (folders are scoped to a bucket).
    if (active.data.current?.type === 'damFolder') {
      const fromId = active.data.current.folderId as string;
      const bucketKey = active.data.current.bucketKey as string;
      const overData = over?.data.current;
      if (overData?.type === 'damFolder' && overData.bucketKey === bucketKey) {
        const toId = overData.folderId as string;
        if (fromId && toId && fromId !== toId) reorderFocusFolder(bucketKey, fromId, toId);
      }
      resetDragRefs();
      clearOverlay();
      return;
    }
    // DAM image drag. The dragged tile carries { type: 'damImage', imageId,
    // ownerKey, folderId, img } and the drop target is either:
    //   - 'damFolderDrop' (folder header / bucket root container — no peer
    //     position is implied, the moving images are appended to that
    //     folder / root), or
    //   - 'damImage' (a peer tile — the moving images land just before the
    //     over peer, so the user gets the "drop where you saw the gap"
    //     positioning that matches the in-place displacement animation).
    // If the dragged image is part of the active multi-selection AND the
    // selection has more than one member, the WHOLE selection moves;
    // otherwise just the dragged image.
    if (active.data.current?.type === 'damImage') {
      const overData = over?.data.current;
      const draggedId = active.data.current.imageId as string;
      const fromBucketActive = active.data.current.ownerKey as string;
      // Resolve destination from over.data — both shapes give us bucket +
      // folder, plus an optional `overImageId` for peer-on-peer drops.
      let toBucket: string | null = null;
      let toFolderId: string | null = null;
      let overImageId: string | null = null;
      if (overData?.type === 'damFolderDrop') {
        toBucket = overData.bucketKey as string;
        toFolderId = (overData.folderId ?? null) as string | null;
      } else if (overData?.type === 'damImage') {
        toBucket = overData.ownerKey as string;
        toFolderId = (overData.folderId ?? null) as string | null;
        overImageId = overData.imageId as string;
      }
      if (toBucket) {
        const sel = selectedImageIdsRef.current;
        const idsToMove = sel.has(draggedId) && sel.size > 1 ? Array.from(sel) : [draggedId];
        // Detect "no-op self drop": user picked up a tile and dropped it on
        // itself without moving. Skip — running the reorder/move pipeline
        // would just churn storage for no reason.
        if (idsToMove.length === 1 && overImageId === draggedId) {
          resetDragRefs();
          clearOverlay();
          return;
        }
        // Reorder fast-path: same bucket + same folder + single item +
        // dropped on a peer. Use arrayMove on the bucket's image array so
        // dnd-kit's displacement animation matches the final layout.
        const fromFolderActive = (active.data.current.folderId ?? null) as string | null;
        if (
          idsToMove.length === 1 &&
          fromBucketActive === toBucket &&
          fromFolderActive === toFolderId &&
          overImageId &&
          overImageId !== draggedId
        ) {
          setFocusImages((prev) => {
            const arr = prev[toBucket!] || [];
            const fromIdx = arr.findIndex((i) => i.id === draggedId);
            const toIdx = arr.findIndex((i) => i.id === overImageId);
            if (fromIdx < 0 || toIdx < 0) return prev;
            return { ...prev, [toBucket!]: arrayMove(arr, fromIdx, toIdx) };
          });
          resetDragRefs();
          clearOverlay();
          return;
        }
        // General path (move + optional insertion). Walk focusImages once to
        // group the moving ids by source bucket, then for each source emit
        // ONE storage update that splices the moving images out of the
        // source array and inserts them in the destination array at the
        // chosen insertion index.
        const movingSet = new Set(idsToMove);
        const idToBucket = new Map<string, string>();
        const focusImagesNow = focusImagesRef.current;
        for (const [bucketKey, imgs] of Object.entries(focusImagesNow)) {
          for (const img of imgs) {
            if (movingSet.has(img.id)) idToBucket.set(img.id, bucketKey);
          }
        }
        const groups = new Map<string, string[]>();
        for (const id of idsToMove) {
          const src = idToBucket.get(id);
          if (!src) continue;
          if (!groups.has(src)) groups.set(src, []);
          groups.get(src)!.push(id);
        }
        // Apply storage updates in a single setFocusImages so Liveblocks
        // batches them as one transaction (and so we don't read stale
        // bucket arrays mid-loop after the first source mutates).
        setFocusImages((prev) => {
          let next: typeof prev = prev;
          // Pull moving images out of each source bucket. Stamp each with
          // the new folderId so they land in the right folder at the dest.
          const movingImages: FocusDamImage[] = [];
          for (const [src, ids] of groups) {
            const idSet = new Set(ids);
            const arr = next[src] || [];
            const moved = arr
              .filter((img) => idSet.has(img.id))
              .map((img) => ({ ...img, folderId: toFolderId ?? undefined } as FocusDamImage));
            movingImages.push(...moved);
            const remaining = arr.filter((img) => !idSet.has(img.id));
            next = { ...next, [src]: remaining };
          }
          // Insert into destination bucket. If overImageId is provided AND
          // resolves in the (possibly already-mutated) destination array,
          // insert at that index; else append.
          const destArr = next[toBucket!] || [];
          let insertIdx = destArr.length;
          if (overImageId) {
            const oi = destArr.findIndex((i) => i.id === overImageId);
            if (oi >= 0) insertIdx = oi;
          }
          const destNext = [...destArr.slice(0, insertIdx), ...movingImages, ...destArr.slice(insertIdx)];
          next = { ...next, [toBucket!]: destNext };
          return next;
        });
        // Selection clears after a successful move/reorder so the next
        // operation starts fresh. 1-up state is left untouched.
        setSelectedImageIds(new Set());
      }
      resetDragRefs();
      clearOverlay();
      return;
    }
    if (active.data.current?.type === 'projTask') {
      const srcTask = active.data.current.task as Task;
      const overData = over?.data.current;
      // Drop on a resource row ? assign that resource (additive) to this task and skip the move logic.
      if (overData?.type === 'resource') {
        const short = overData.personShort as string;
        if (short) {
          setTasks((prev) => prev.map((t) => (t.id === srcTask.id && !t.assignees.includes(short) ? { ...t, assignees: [...t.assignees, short] } : t)));
        }
        resetDragRefs();
        clearOverlay(); return;
      }
      let targetList: ListId = srcTask.list;
      let targetProjectId: string | undefined = srcTask.projectId;
      // Section follows the over-task too â€” without this, dropping a Next task onto a Today task
      // kept the source's section, which made cross-section moves in project view feel broken.
      let targetSection: SectionId = srcTask.section;
      if (overData?.type === 'project') {
        targetProjectId = (overData.project as Project).id;
        if (overData.listId) targetList = overData.listId as ListId;
      } else if (overData?.type === 'projTask') {
        const overTask = overData.task as Task;
        targetProjectId = overTask.projectId;
        targetList = overTask.list;
        targetSection = overTask.section;
      } else if (overData?.type === 'projList') {
        // Drop on empty column ? move the task to that list, keep the same project.
        targetList = overData.listId as ListId;
      } else if (overData?.type === 'clientHeader' && overData.listId) {
        // Drop on a client subheader in a column ? move task to that column; drop project linkage.
        targetList = overData.listId as ListId;
        targetProjectId = undefined;
      }
      if (targetList !== srcTask.list || targetProjectId !== srcTask.projectId || targetSection !== srcTask.section) {
        setTasks((prev) => {
          // Remove source first to avoid double-counting when source/target bucket overlap
          const without = prev.filter((t) => t.id !== srcTask.id);
          const moved: Task = { ...srcTask, list: targetList, projectId: targetProjectId, section: targetSection };
          // Build target bucket, insert moved at correct position
          const targetBucket = without.filter((t) => t.list === targetList && t.section === targetSection);
          let insertIdx = targetBucket.length;
          if (overData?.type === 'projTask') {
            const overTask = overData.task as Task;
            const idx = targetBucket.findIndex((t) => t.id === overTask.id);
            if (idx >= 0) insertIdx = idx;
          }
          targetBucket.splice(insertIdx, 0, moved);
          const reorderedTarget = targetBucket.map((t, i) => ({ ...t, order: i }));
          // Source bucket (after source removal) â€” may equal target if same list+section
          const sameBucket = srcTask.list === targetList && srcTask.section === targetSection;
          const sourceBucket = sameBucket ? [] : without.filter((t) => t.list === srcTask.list && t.section === srcTask.section).map((t, i) => ({ ...t, order: i }));
          const untouched = without.filter((t) =>
            !(t.list === targetList && t.section === targetSection) &&
            (sameBucket || !(t.list === srcTask.list && t.section === srcTask.section))
          );
          return [...untouched, ...sourceBucket, ...reorderedTarget];
        });
      }
      resetDragRefs();
      clearOverlay(); return;
    }
    if (active.data.current?.type === 'project' && over) {
      const srcProject = active.data.current.project as Project;
      const overData = over.data.current;
      // Drop on a resource row ? assign that resource to every task that belongs to this project.
      if (overData?.type === 'resource') {
        const short = overData.personShort as string;
        if (short) {
          setTasks((prev) => prev.map((t) => (t.projectId === srcProject.id && !t.assignees.includes(short) ? { ...t, assignees: [...t.assignees, short] } : t)));
        }
        resetDragRefs();
        clearOverlay(); return;
      }
      // Drop on an empty list column ? pin this project to that list.
      if (overData?.type === 'projList') {
        const targetList = overData.listId as ListId;
        setProjects((prev) => prev.map((p) => (p.id === srcProject.id ? { ...p, list: targetList } : p)));
        setTasks((prev) => prev.map((t) => (t.projectId === srcProject.id ? { ...t, list: targetList } : t)));
        resetDragRefs();
        clearOverlay(); return;
      }
      let targetClientId: string | undefined = srcProject.clientId;
      let targetList: ListId | undefined = srcProject.list;
      if (overData?.type === 'project') {
        targetClientId = (overData.project as Project).clientId;
        targetList = (overData.listId as ListId) ?? targetList;
      } else if (overData?.type === 'clientHeader') {
        targetClientId = (overData.clientId as string);
        // When a client subheader carries a listId (project-view columns), pin the project to that list.
        if (overData.listId) targetList = overData.listId as ListId;
      }
      const overProjectId = overData?.type === 'project' ? (overData.project as Project).id : null;
      setProjects((prev) => {
        let next = prev.map((p) => (p.id === srcProject.id ? { ...p, clientId: targetClientId, list: targetList } : p));
        if (overProjectId && overProjectId !== srcProject.id) {
          const oldI = next.findIndex((p) => p.id === srcProject.id);
          const newI = next.findIndex((p) => p.id === overProjectId);
          if (oldI >= 0 && newI >= 0) next = arrayMove(next, oldI, newI);
        }
        return next;
      });
      // If the project has a pinned list, move its tasks to that list so they render in the right column.
      if (targetList) {
        setTasks((prev) => prev.map((t) => (t.projectId === srcProject.id ? { ...t, list: targetList as ListId } : t)));
      }
      resetDragRefs();
      clearOverlay(); return;
    }
    if (!over || active.id === over.id) { setActiveId(null); setActiveTaskIdState(null); setColumnOffset(0); pendingOffsetRef.current = 0; if (dwellTimerRef.current) { clearTimeout(dwellTimerRef.current); dwellTimerRef.current = null; } if (collapseTimerRef.current) { clearTimeout(collapseTimerRef.current); collapseTimerRef.current = null; } setSourceCollapsed(false); return; }
    // Underlying task ids â€” active/over .id may carry a sortable prefix (e.g. dashboard "dash:work:")
    // so look up the actual task via data.task when present.
    const activeTaskId = (active.data.current?.task as Task | undefined)?.id ?? String(active.id);
    const overTaskId = (over.data.current?.task as Task | undefined)?.id ?? String(over.id);
    const overIdStr = String(over.id);
    // Edge assign rails: drop on a row inside the slide-out drawers. Left drawer rows are
    // edge:project:<id> (reparent, list follows the project's pin), right drawer rows are
    // edge:person:<short> (add assignee — additive, never removes existing ones).
    if (overIdStr.startsWith('edge:')) {
      const dragged = tasks.find((t) => t.id === activeTaskId);
      if (dragged) {
        if (overIdStr.startsWith('edge:project:')) {
          const pid = overIdStr.slice('edge:project:'.length);
          const proj = projects.find((p) => p.id === pid);
          const targetList: ListId = proj?.list ?? dragged.list;
          setTasks((prev) => prev.map((t) => (t.id === dragged.id ? { ...t, projectId: pid, list: targetList } : t)));
        } else if (overIdStr.startsWith('edge:client:')) {
          // Assign the task directly to a CLIENT (top level): set clientId and detach it from
          // any specific project so it lives at the client, not under a sub-project.
          const cid = overIdStr.slice('edge:client:'.length);
          setTasks((prev) => prev.map((t) => (t.id === dragged.id ? { ...t, clientId: cid, projectId: undefined } : t)));
        } else if (overIdStr.startsWith('edge:person:')) {
          const short = overIdStr.slice('edge:person:'.length);
          setTasks((prev) => prev.map((t) => (t.id === dragged.id && !t.assignees.includes(short) ? { ...t, assignees: [...t.assignees, short] } : t)));
        }
      }
      setEdgeDrawer(null);
      resetDragRefs();
      clearOverlay();
      return;
    }
    // Project view 2: drop on a project block (header OR empty area OR existing task). The
    // task gets reparented to that project — projectId is set, and list flips to the
    // project's pinned list (or the column's list if unpinned). Header drops handled here;
    // existing-task drops fall through to the regular reorder path AND get reparented via
    // the prefix check below.
    const overData = over.data.current;
    if (overData?.type === 'proj2Project') {
      const targetProjectId = overData.projectId as string;
      const targetListId = overData.listId as ListId;
      const targetProject = projects.find((p) => p.id === targetProjectId);
      const targetList: ListId = targetProject?.list ?? targetListId;
      setTasks((prev) => prev.map((t) => (t.id === activeTaskId ? { ...t, projectId: targetProjectId, list: targetList, section: t.section || 'today' } : t)));
      setActiveId(null); setActiveTaskIdState(null); setActiveType(null); setActiveCalendarCellId(null);
      setColumnOffset(0); pendingOffsetRef.current = 0;
      if (dwellTimerRef.current) { clearTimeout(dwellTimerRef.current); dwellTimerRef.current = null; }
      if (collapseTimerRef.current) { clearTimeout(collapseTimerRef.current); collapseTimerRef.current = null; }
      setSourceCollapsed(false);
      return;
    }
    if (overIdStr.startsWith('cal:')) {
      const [, targetDateRaw, targetListRaw] = overIdStr.split(':');
      // 'NW@<iso>' = the Next Week hotspot column — schedule for next week,
      // setting the deadline even for queue tasks that normally keep none.
      const isNextWeekDrop = targetDateRaw.startsWith('NW@');
      const targetDate = isNextWeekDrop ? targetDateRaw.slice(3) : targetDateRaw;
      const droppedList = targetListRaw as ListId;
      const srcTask = tasks.find((t) => t.id === activeTaskId);
      // The redirected collision lost the original over-task — fall back to the refs captured
      // by calendarCollision so we can insert at the user's intended position.
      const intendedOverTaskId = lastCalOverTaskIdRef.current;
      const droppedCellId = lastCalOverCellIdRef.current; // e.g. cal:2026-04-26:projects
      if (srcTask) {
        const targetList: ListId = ctrlDownRef.current ? droppedList : srcTask.list;
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
        const targetDateObj = new Date(targetDate + 'T00:00:00');
        const tomorrowIso = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;
        // Section follows the target column's date relationship: today → 'today',
        // tomorrow → 'tomorrow', any other day → 'next' (queue).
        let targetSection: SectionId;
        if (targetDateObj.getTime() <= today.getTime()) targetSection = 'today';
        else if (targetDate === tomorrowIso) targetSection = 'tomorrow';
        else targetSection = 'next';
        // RULES (per user spec):
        //   A. If the source task HAS a deadline: rewrite its deadline to the target date
        //      (calendar drag = reschedule).
        //   B. If the source task has NO deadline: leave deadline alone — the drop just
        //      changes its priority/order in the queue. Today / Tomorrow drops still flip
        //      section to 'today' / 'tomorrow' (explicit placement); future-day drops keep
        //      section='next' so the task stays in the auto-distributed queue.
        const isQueueTask = !srcTask.deadline && !isNextWeekDrop;
        // Which band did the user actually release in? Only a drop within the task's OWN
        // band gives positional control; anything else defaults to the top of its stack.
        const droppedListId = droppedCellId ? (droppedCellId.split(':')[2] as ListId) : null;
        setTasks((prev) => {
          // Remove source first so it can't be double-counted.
          const without = prev.filter((t) => t.id !== srcTask.id);
          // Rule A vs B: rewrite deadline only when the source already had one. Queue tasks
          // keep their (undefined) deadline so they stay in the auto-distributed queue.
          const moved: Task = isQueueTask
            ? { ...srcTask, list: targetList, section: targetSection }
            : { ...srcTask, list: targetList, section: targetSection, deadline: targetDate };
          // Build the destination bucket without the source.
          const toBucket = without.filter((t) => t.list === targetList && t.section === targetSection).sort((a, b) => a.order - b.order);
          // Insert position (per user spec): positional control ONLY when the card is
          // released inside its OWN category band —
          //   - own band, on a card          → before that card (displace)
          //   - own band, empty space below  → end of the stack
          //   - ANYWHERE else in the column  → TOP of its stack (index 0), never "somewhere
          //     in the middle"
          //   - deferring today/tomorrow → Next always lands at the top (resurface first)
          let insertAt: number;
          const deferringToNext = targetSection === 'next' && srcTask.section !== 'next';
          const droppedInOwnBand = droppedListId === targetList;
          if (deferringToNext) {
            insertAt = 0;
          } else if (droppedInOwnBand && intendedOverTaskId) {
            const idx = toBucket.findIndex((t) => t.id === intendedOverTaskId);
            insertAt = idx >= 0 ? idx : 0;
          } else if (droppedInOwnBand) {
            insertAt = toBucket.length;
          } else {
            insertAt = 0;
          }
          const reorderedTo = [...toBucket.slice(0, insertAt), moved, ...toBucket.slice(insertAt)].map((t, i) => ({ ...t, order: i }));
          const fromOthers = without.filter((t) => t.list === srcTask.list && t.section === srcTask.section && t.id !== srcTask.id).map((t, i) => ({ ...t, order: i }));
          const untouched = without.filter((t) => !(t.list === srcTask.list && t.section === srcTask.section) && !(t.list === targetList && t.section === targetSection));
          // sameBucket short-circuit: don't double-include `fromOthers` AND `reorderedTo`.
          const sameBucket = srcTask.list === targetList && srcTask.section === targetSection;
          if (sameBucket) {
            return [...untouched, ...reorderedTo];
          }
          return [...untouched, ...fromOthers, ...reorderedTo];
        });
      }
      lastCalOverTaskIdRef.current = null;
      lastCalOverCellIdRef.current = null;
      resetDragRefs();
      clearOverlay(); return;
    }
    if (overIdStr.startsWith('section:')) {
      const [, targetList, targetSectionRaw] = overIdStr.split(':') as ['section', ListId, string];
      const srcTask = tasks.find((t) => t.id === activeTaskId);
      const targetIsMilestones = targetSectionRaw === 'milestones';
      // If dropping on Milestones, mark task as scheduled (pin it to that list's milestone group); section is preserved.
      // If dropping a milestone into a regular section, convert it back to a todo in that section.
      const targetType: Task['type'] = targetIsMilestones ? 'scheduled' : 'todo';
      const targetSection: SectionId = targetIsMilestones ? srcTask?.section ?? 'today' : (targetSectionRaw as SectionId);
      // Buckets: milestones is its own display bucket per list; regular sections are their own buckets.
      const srcBucketKey = srcTask ? (srcTask.type === 'scheduled' ? `${srcTask.list}:milestones` : `${srcTask.list}:${srcTask.section}`) : '';
      const tgtBucketKey = `${targetList}:${targetIsMilestones ? 'milestones' : targetSection}`;
      if (srcTask && srcBucketKey !== tgtBucketKey) {
        setTasks((prev) => {
          const inBucket = (t: Task, key: string) => {
            const [l, s] = key.split(':');
            if (s === 'milestones') return t.list === (l as ListId) && t.type === 'scheduled';
            return t.list === (l as ListId) && t.section === (s as SectionId) && t.type !== 'scheduled';
          };
          const fromOthers = prev.filter((t) => inBucket(t, srcBucketKey) && t.id !== srcTask.id).map((t, i) => ({ ...t, order: i }));
          const toBucket = prev.filter((t) => inBucket(t, tgtBucketKey) && t.id !== srcTask.id);
          const moved: Task = { ...srcTask, list: targetList, section: targetSection, type: targetType };
          const reorderedTo = [...toBucket, moved].map((t, i) => ({ ...t, order: i }));
          const untouched = prev.filter((t) => !inBucket(t, srcBucketKey) && !inBucket(t, tgtBucketKey) && t.id !== srcTask.id);
          return [...untouched, ...fromOthers, ...reorderedTo];
        });
      }
      resetDragRefs();
      clearOverlay(); return;
    }
    const a = tasks.find((t) => t.id === activeTaskId);
    const o = tasks.find((t) => t.id === overTaskId);
    if (!a || !o) { setActiveId(null); setActiveTaskIdState(null); setColumnOffset(0); pendingOffsetRef.current = 0; if (dwellTimerRef.current) { clearTimeout(dwellTimerRef.current); dwellTimerRef.current = null; } if (collapseTimerRef.current) { clearTimeout(collapseTimerRef.current); collapseTimerRef.current = null; } setSourceCollapsed(false); return; }
    // Dashboard cards stay scoped to their LIST (work/admin/projects) — dragging
    // ACROSS lists (e.g. Work today → Admin today) is blocked, but dragging
    // ACROSS sections within the same list (Work today → Work tomorrow → Next/Work)
    // is allowed so the user can re-date a task without leaving the dashboard.
    //
    // Prefix format:
    //   dash:${list}:${section}:   ← inside a list block (Work/Admin/Projects)
    //   dash:next:${list}:         ← inside the Next block (list lives in the 3rd slot)
    // Per-list columns use bare task ids (no prefix). A dashboard task can never
    // resolve to a non-dashboard drop target — the dashboard is "view-only" for
    // list moves; the user must drag in the per-list column for that.
    const prefixOf = (id: string) => { const i = id.lastIndexOf(':'); return i >= 0 ? id.substring(0, i + 1) : ''; };
    const activePrefix = prefixOf(String(active.id));
    const overPrefix = prefixOf(String(over.id));
    const dashListOf = (prefix: string): string | null => {
      if (!prefix.startsWith('dash:')) return null;
      const parts = prefix.split(':'); // e.g. ['dash', 'work', 'today', ''] or ['dash', 'next', 'work', '']
      if (parts[1] === 'next') return parts[2] || null;
      return parts[1] || null;
    };
    const activeDashList = dashListOf(activePrefix);
    const overDashList = dashListOf(overPrefix);
    if (activeDashList !== null) {
      // Source is a dashboard task — enforce: target must also be dashboard AND same list.
      if (overDashList === null || activeDashList !== overDashList) {
        setActiveId(null); setActiveTaskIdState(null); setActiveType(null); setActiveCalendarCellId(null); setColumnOffset(0); pendingOffsetRef.current = 0; if (dwellTimerRef.current) { clearTimeout(dwellTimerRef.current); dwellTimerRef.current = null; } if (collapseTimerRef.current) { clearTimeout(collapseTimerRef.current); collapseTimerRef.current = null; } setSourceCollapsed(false); return;
      }
    }
    // Project view 2: when dropping a task onto another task that lives in a project bucket
    // (over.id has the `proj2:${listId}:${projectId}:` prefix), also reparent the dragged
    // task into that bucket's project. Fires regardless of whether the source task already
    // had the same project — covers the "reorder within project" case too.
    if (overPrefix.startsWith('proj2:')) {
      const parts = overPrefix.slice('proj2:'.length).split(':');
      // parts: [listId, projectIdOrLiteral, ...]
      const proj2ListId = parts[0] as ListId;
      const proj2Token = parts[1];
      let proj2ProjectId: string | undefined;
      if (proj2Token && proj2Token !== 'none' && proj2Token !== 'client') proj2ProjectId = proj2Token;
      const targetProject = proj2ProjectId ? projects.find((p) => p.id === proj2ProjectId) : undefined;
      const targetList: ListId = targetProject?.list ?? proj2ListId;
      if (a.projectId !== proj2ProjectId || a.list !== targetList) {
        setTasks((prev) => prev.map((t) => (t.id === a.id ? { ...t, projectId: proj2ProjectId, list: targetList } : t)));
      }
    }
    if (a.list === o.list && a.section === o.section) {
      setTasks((prev) => {
        // Calendar drags share list+section across multiple days (every section='next' Work
        // task lives in the same flat list); scoping the arrayMove to the cell's deadline
        // keeps a same-day reorder from globally reshuffling other days' tasks.
        const isCalendarDrag = !!activeCalendarCellId;
        const dayMatch = (t: Task) => !isCalendarDrag || t.deadline === a.deadline;
        const inBucket = (t: Task) => t.list === a.list && t.section === a.section && dayMatch(t);
        const list = prev.filter(inBucket).sort((x, y) => x.order - y.order);
        const oldI = list.findIndex((t) => t.id === a.id);
        const newI = list.findIndex((t) => t.id === o.id);
        if (oldI === newI) return prev;
        const reordered = arrayMove(list, oldI, newI).map((t, i) => ({ ...t, order: i }));
        return [...prev.filter((t) => !inBucket(t)), ...reordered];
      });
    } else {
      handleCrossSectionMove(a, o);
    }
    setActiveId(null); setActiveTaskIdState(null); setActiveType(null); setActiveCalendarCellId(null); setColumnOffset(0); pendingOffsetRef.current = 0; if (dwellTimerRef.current) { clearTimeout(dwellTimerRef.current); dwellTimerRef.current = null; } if (collapseTimerRef.current) { clearTimeout(collapseTimerRef.current); collapseTimerRef.current = null; } setSourceCollapsed(false);
  }, [tasks, reorderFocusSubtask, reorderFocusFolder, moveFocusImagesToFolder, moveFocusImagesToBucket, setFocusImages]);

  // Default to first person if unset
  useEffect(() => {
    if (!currentUserShort && people.length > 0) setCurrentUserShort(people[0].short);
  }, [currentUserShort, people, setCurrentUserShort]);

  // 4 AM section refill. Today is SACRED — only deadlined / date-ranged tasks land there
  // (handled by the deadline auto-promote effect above). The refill cascade only tops up
  // Tomorrow:
  //    Next → Tomorrow (if Tomorrow < 3)
  // Day boundary is 4 AM (not midnight) so late-night work counts as the previous day — see
  // todayISO() in data.ts for the consumer-side shift. Runs on mount when last refill < today,
  // then schedules itself for the next 4 AM. Persisted via localStorage so each browser only
  // refills once per day. Multi-client safety relies on Liveblocks merging idempotently.
  useEffect(() => {
    const TARGET = 3;
    const refillNow = () => {
      const today = todayISO();
      setTasks((prev) => {
        let next = [...prev];
        // STEP A — expire "rest of day" overrides. Any task whose deadline OR startDate has
        // arrived (≤ today) that the user had snoozed into Tomorrow / Next / Inbox yesterday is
        // now back in scope. Promote it to Today so the user sees it. Today/Inbox/Next/Tomorrow
        // placement was the user's call for THAT day; a new day = re-evaluation.
        next = next.map((t) => {
          if (t.type === 'scheduled' || t.completed || t.section === 'today') return t;
          const dueOrStarting = (t.deadline && t.deadline <= today) || (t.startDate && t.startDate <= today);
          return dueOrStarting ? { ...t, section: 'today' as SectionId } : t;
        });
        // STEP B — snapshot fill Today AND Tomorrow from the queue. Each list pulls up to
        // TARGET (3) queue tasks per day. After this snapshot the calendar leaves today +
        // tomorrow alone for the rest of the day; only Wed+ keeps re-distributing in real-time.
        const lists: ListId[] = LISTS;
        for (const targetSection of ['today', 'tomorrow'] as const) {
          for (const listId of lists) {
            const cmp = (a: Task, b: Task) => a.order - b.order;
            const sectionList = next.filter((t) => t.list === listId && t.section === targetSection && t.type !== 'scheduled' && !t.completed).sort(cmp);
            const nextList = next.filter((t) => t.list === listId && t.section === 'next' && t.type !== 'scheduled' && !t.completed && !t.deadline).sort(cmp);
            while (sectionList.length < TARGET && nextList.length > 0) {
              const moved = nextList.shift()!;
              const idx = next.findIndex((t) => t.id === moved.id);
              if (idx >= 0) { next[idx] = { ...next[idx], section: targetSection }; sectionList.push(next[idx]); }
            }
          }
        }
        // Re-number order within each affected (list, section) so newly moved tasks land at the end.
        for (const listId of lists) {
          for (const sec of ['today', 'tomorrow', 'next'] as SectionId[]) {
            const bucket = next.filter((t) => t.list === listId && t.section === sec && t.type !== 'scheduled' && !t.completed).sort((a, b) => a.order - b.order);
            bucket.forEach((t, i) => {
              const idx = next.findIndex((x) => x.id === t.id);
              if (idx >= 0) next[idx] = { ...next[idx], order: i };
            });
          }
        }
        return next;
      });
      try { window.localStorage.setItem('todo-app-last-refill', todayISO()); } catch {}
    };

    // First-load refill if we missed it today.
    try {
      const last = window.localStorage.getItem('todo-app-last-refill');
      if (!last || last < todayISO()) refillNow();
    } catch {}

    // Schedule the next 4 AM rollover (+1s buffer). Day boundary is 4 AM, not midnight, so
    // late-night work (12:00–3:59 AM) still counts as the previous day. If we're already past
    // 4 AM today, schedule for tomorrow's 4 AM; otherwise for today's 4 AM (a few hours away).
    const now = new Date();
    const next4am = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 4, 0, 1);
    if (next4am <= now) next4am.setDate(next4am.getDate() + 1);
    const ms = Math.max(1000, next4am.getTime() - now.getTime());
    const timer = window.setTimeout(refillNow, ms);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Global keyboard shortcuts:
  //   Enter   → spawn a task (sibling of hovered row, or fresh in Today/Work if none hovered)
  //   1       → list view (dashboard)
  //   2       → project view
  //   3       → calendar view
  //   N       → open the new-task quick-edit panel (anchored to the Work column)
  // All skip when the user is typing in an input / contentEditable / button focus.
  useEffect(() => {
    const isTypingTarget = (t: HTMLElement | null) => {
      if (!t) return false;
      if (t.isContentEditable) return true;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return true;
      return false;
    };
    const handler = (e: KeyboardEvent) => {
      if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (isTypingTarget(t)) return;
      if (e.key === 'Enter') {
        if (t?.tagName === 'BUTTON') return;
        const hoveredRow = document.querySelector('[data-task-row]:hover') as HTMLElement | null;
        const hoveredId = hoveredRow?.getAttribute('data-task-row');
        const hoveredTask = hoveredId ? tasks.find((x) => x.id === hoveredId) : undefined;
        e.preventDefault();
        if (hoveredTask) addSiblingTask(hoveredTask);
        else addBlankTaskInSection('work', 'today');
        return;
      }
      // Ctrl+Space — PIP quick view. In the Tauri desktop app the OS-level
      // global shortcut (registered in src-tauri/lib.rs) handles this even
      // when the app is unfocused; this in-app fallback covers the WEB build,
      // opening the same ?pip=1 view in a small popup window.
      if (e.code === 'Space' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        if (!('__TAURI_INTERNALS__' in window)) {
          window.open('/?pip=1', 'ctrl-pip', 'width=420,height=880,left=40,top=40');
        }
        return;
      }
      // View-mode shortcuts (1/2/3) and N (new-task panel).
      if (e.key === '1') { e.preventDefault(); setMode('dashboard'); return; }
      if (e.key === '2') { e.preventDefault(); setMode('projectView'); return; }
      if (e.key === '3') { e.preventDefault(); setMode('calendar'); return; }
      if (e.key === 'n' || e.key === 'N') { e.preventDefault(); addAndEditTask(); return; }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [addBlankTaskInSection, addSiblingTask, tasks, setMode, addAndEditTask]);

  // One-time migration: Russell â†’ Benno
  const migratedRef = useRef(false);
  useEffect(() => {
    if (migratedRef.current) return;
    const russell = people.find((p) => p.name === 'Russell');
    if (russell) {
      migratedRef.current = true;
      setPeople((prev) => prev.map((p) => (p.id === russell.id ? { ...p, name: 'Benno', short: 'B' } : p)));
      if (russell.short && russell.short !== 'B') {
        const old = russell.short;
        setTasks((prev) => prev.map((t) => ({ ...t, assignees: t.assignees.map((a) => (a === old ? 'B' : a)) })));
      }
      if (currentUserShort === russell.short) setCurrentUserShort('B');
    }
  }, [people, setPeople, setTasks, currentUserShort, setCurrentUserShort]);

  // For a milestone, the column is determined by the project it belongs to: the project's explicit list
  // if any, else the dominant list of that project's tasks, else the milestone's own list.
  const projectListMap = useMemo(() => {
    const m: Record<string, ListId> = {};
    for (const p of projects) {
      if (p.list) { m[p.id] = p.list; continue; }
      const counts: Partial<Record<ListId, number>> = {};
      for (const t of tasks) if (t.projectId === p.id) counts[t.list] = (counts[t.list] || 0) + 1;
      let best: ListId | null = null;
      let bestN = 0;
      for (const k of Object.keys(counts) as ListId[]) {
        const n = counts[k] || 0;
        if (n > bestN) { best = k; bestN = n; }
      }
      if (best) m[p.id] = best;
    }
    return m;
  }, [projects, tasks]);

  const effectiveListFor = useCallback((t: Task): ListId => {
    if (t.type !== 'scheduled') return t.list;
    if (t.projectId && projectListMap[t.projectId]) return projectListMap[t.projectId];
    return t.list;
  }, [projectListMap]);

  // One-time hygiene sweep: PERMANENTLY pin every unpinned project to its dominant task
  // list. "House / Family / Financial / Car" style projects whose tasks all live in Admin
  // were floating list-less, so they leaked into every surface's project picker — pinning
  // them makes the affiliation stick (new pins also happen at panel-assignment time via
  // pinProjectList). Runs once per session and only writes when something actually needs
  // pinning.
  const pinMigrationRef = useRef(false);
  useEffect(() => {
    if (pinMigrationRef.current) return;
    if (projects.length === 0 || tasks.length === 0) return;
    pinMigrationRef.current = true;
    const needsPin = projects.some((p) => !p.list && projectListMap[p.id]);
    if (!needsPin) return;
    setProjects((prev) => prev.map((p) => (!p.list && projectListMap[p.id] ? { ...p, list: projectListMap[p.id] } : p)));
  }, [projects, tasks, projectListMap, setProjects]);

  // One-time list-alignment sweep: a task's CATEGORY should always follow its project's pinned
  // list — a task under a Projects-pinned project belongs in the Projects band, never Work.
  // Drags used to be able to split a project's tasks across categories; this consolidates any
  // that diverged (only the `list` field changes, only when it differs from the project's pin,
  // only for pinned projects). Runs once, 6s after mount so project pins + Liveblocks have
  // settled. Going forward the category-lock keeps them from diverging again.
  const listAlignRef = useRef(false);
  useEffect(() => {
    if (listAlignRef.current) return;
    listAlignRef.current = true;
    const h = window.setTimeout(() => {
      const pin = new Map<string, ListId>();
      for (const p of projectsRef.current) if (p.list) pin.set(p.id, p.list);
      const misaligned = tasksRef.current.filter((t) => !t.trashed && t.projectId && pin.has(t.projectId) && t.list !== pin.get(t.projectId));
      if (misaligned.length === 0) return;
      const ids = new Set(misaligned.map((t) => t.id));
      setTasks((prev) => prev.map((t) => (ids.has(t.id) && t.projectId && pin.has(t.projectId) ? { ...t, list: pin.get(t.projectId)! } : t)));
      console.log(`[list-align] moved ${misaligned.length} task(s) into their project's category`);
    }, 6000);
    return () => window.clearTimeout(h);
  }, []);

  // One-time ghost purge: 5s after mount (Liveblocks has synced, no in-flight rename),
  // remove blank-named projects that carry no tasks — the "untitled project ghosts" the
  // user can't otherwise clear. Delayed + one-shot so it never races a project being named.
  const ghostPurgeRef = useRef(false);
  useEffect(() => {
    if (ghostPurgeRef.current) return;
    ghostPurgeRef.current = true;
    const h = window.setTimeout(() => {
      const n = purgeEmptyProjects();
      if (n > 0) console.log(`[ghost-purge] removed ${n} empty project(s)`);
    }, 5000);
    return () => window.clearTimeout(h);
  }, [purgeEmptyProjects]);

  // Tasks in the "Personal" client are scoped to their assignees: other users never see them.
  // This filter is applied to every display path (list, project, calendar, dashboard) so Personal
  // work stays off the team's radar.
  // Also strip:
  //   - trashed tasks (they live in Settings → Trash)
  //   - tasks completed before today's day boundary (they live in Settings → Completed; calendar
  //     bypasses this filter and shows historical completions)
  //   - expired milestones older than the 24-hour lingering window (visible in calendar permanently
  //     via calendarTasks below; here they fall off list/project view after a day)
  // Recently revived tasks (revivedAt within 10 min) are always shown regardless of completedDay.
  const REVIVE_WINDOW_MS = 10 * 60 * 1000;
  // Completed tasks linger in list / project / dashboard for COMPLETED_LINGER_MS after the
  // user checks them off, then disappear. Calendar view ignores this and keeps every
  // historical completion visible (via calendarTasks below). Tied to completedAt (epoch
  // ms) — the same timestamp the 15-second sink delay uses. Falls back to the previous
  // 4-AM-rollover behavior for legacy tasks that have completedDay but no completedAt.
  const COMPLETED_LINGER_MS = 30 * 60 * 1000;
  const visibleTasks = useMemo(() => {
    const today = todayISO();
    const now = Date.now();
    // Yesterday's ISO — milestones whose deadline is yesterday or today still show in list/project.
    const yesterday = (() => { const d = new Date(); d.setHours(d.getHours() - 4); d.setDate(d.getDate() - 1); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; })();
    return tasks.filter((t) => {
      if (t.trashed) return false;
      if (isPrivateTask(t) && !t.assignees.includes(currentUserShort)) return false;
      if (t.completed) {
        // Recently revived tasks ALWAYS stay visible inside the revive window — gives
        // the user a 10-min grace to re-check after an accidental un-check.
        const justRevived = !!t.revivedAt && (now - t.revivedAt) < REVIVE_WINDOW_MS;
        if (!justRevived) {
          // Modern: hide once 30 minutes have elapsed since check-off.
          if (t.completedAt && (now - t.completedAt) > COMPLETED_LINGER_MS) return false;
          // Legacy fallback: tasks completed before completedAt was added still use the
          // 4-AM rollover (completedDay < today → hide).
          if (!t.completedAt && t.completedDay && t.completedDay < today) return false;
        }
      }
      // Expired milestone: show for 24 hours after the deadline (linger), then hide.
      // Calendar still shows them via calendarTasks below.
      if (t.type === 'scheduled' && t.deadline && t.deadline < yesterday) return false;
      return true;
    });
    // sortTick included so the periodic 60-second tick (declared below) re-evaluates
    // this filter and lifts completed tasks out once their 30-minute window expires.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, currentUserShort, sortTick]);

  // Calendar view bypasses the completedDay filter — historical completions stay visible there.
  const calendarTasks = useMemo(
    () => tasks.filter((t) => !t.trashed && (!isPrivateTask(t) || t.assignees.includes(currentUserShort))),
    [tasks, currentUserShort]
  );

  // Focus-page mini-calendar cells — the SAME distribution the week calendar computes,
  // over a 3-day horizon (today / tomorrow / day-after). Keyed '<iso>:<listId>'. Feeds on
  // calendarTasks (NOT raw tasks) because that's exactly what WeekCalendarMode receives —
  // trashed tasks stripped, Personal-client tasks scoped to the current user. Midnight
  // anchor matches the calendar's own (not the 4 AM todayISO boundary) so the strip and the
  // calendar view never disagree about which day a task sits in.
  const focusStripCells = useMemo(() => {
    const anchor = new Date();
    anchor.setHours(0, 0, 0, 0);
    // 9-day horizon: Today (0) + Tomorrow (1) + the "Next" column's week (2..8).
    return computeCalendarDistribution(calendarTasks, anchor, 9, listSequence);
  }, [calendarTasks, listSequence]);

  // Settings → Trash column: every soft-deleted task (newest first by trashedAt). Personal
  // scoping still applies — other users don't see your trashed Personal items.
  const trashedTasks = useMemo(
    () => tasks
      .filter((t) => t.trashed && (!isPrivateTask(t) || t.assignees.includes(currentUserShort)))
      .sort((a, b) => (b.trashedAt ?? 0) - (a.trashedAt ?? 0)),
    [tasks, currentUserShort]
  );
  // Settings → Completed column: tasks that are currently completed OR were recently revived
  // (within REVIVE_WINDOW_MS) so the user can still re-check them after a misclick. Newest by
  // completedDay descending; ties by id for stability.
  const completedTasksForSettings = useMemo(() => {
    const now = Date.now();
    return tasks
      .filter((t) => {
        if (t.trashed) return false;
        if (isPrivateTask(t) && !t.assignees.includes(currentUserShort)) return false;
        if (t.completed) return true;
        if (t.revivedAt && now - t.revivedAt < REVIVE_WINDOW_MS) return true;
        return false;
      })
      .sort((a, b) => {
        const ad = a.completedDay || '\u0000';
        const bd = b.completedDay || '\u0000';
        if (ad !== bd) return ad < bd ? 1 : -1;
        return a.id < b.id ? -1 : 1;
      });
  }, [tasks, currentUserShort]);

  const tasksByKey = useMemo(() => {
    const m: Record<string, Task[]> = {};
    // Split milestones (type === 'scheduled') out of regular section buckets and into a per-list `milestones` bucket.
    // Milestones go into the column of their project, not their own list.
    for (const t of visibleTasks) {
      if (t.type === 'scheduled') {
        const k = `${effectiveListFor(t)}:milestones`;
        (m[k] ||= []).push(t);
      } else {
        const k = `${t.list}:${t.section}`;
        (m[k] ||= []).push(t);
      }
    }
    // 15-second grace window: a task that was JUST checked off (or just marked started)
    // keeps its current position so the user has time to undo a misclick without the row
    // visibly sliding away. After the window elapses, toggleTask's setTimeout bumps
    // sortTick which re-runs this memo and the task drops to its tier.
    const COMPLETED_GRACE_MS = 15000;
    const now = Date.now();
    const isSunkCompleted = (t: Task) =>
      t.completed && (!t.completedAt || now - t.completedAt >= COMPLETED_GRACE_MS);
    // Mirror sink logic for the started tier: a task is past the grace window when 15s have
    // elapsed since startedAt. Once sunk it lives BELOW pending but ABOVE completed.
    const isSunkStarted = (t: Task) =>
      !t.completed && !!t.started && (!t.startedAt || now - t.startedAt >= COMPLETED_GRACE_MS);
    // 3-tier sort key \u2014 pending = 0 (top), started = 1 (middle), completed = 2 (bottom).
    // Within the grace window the task stays at tier 0 so it doesn't jump on click.
    const tier = (t: Task) => isSunkCompleted(t) ? 2 : isSunkStarted(t) ? 1 : 0;
    for (const k of Object.keys(m)) {
      if (k.endsWith(':milestones')) {
        // Milestones don't have a "started" tier \u2014 they're date-anchored. Completed milestones
        // sink to the bottom (after grace) of the milestones bucket. Among the rest: deadline
        // ascending, undated last, ties broken by title.
        m[k].sort((a, b) => {
          const aSunk = isSunkCompleted(a);
          const bSunk = isSunkCompleted(b);
          if (aSunk !== bSunk) return aSunk ? 1 : -1;
          const ad = a.deadline || '\uffff';
          const bd = b.deadline || '\uffff';
          if (ad !== bd) return ad < bd ? -1 : 1;
          return a.title.localeCompare(b.title);
        });
      } else {
        // 3-tier sort: pending \u2192 started \u2192 completed (each past their grace window).
        // Section-aware completed placement (user policy): in TODAY / TOMORROW a finished
        // task sinks to the bottom; in NEXT it flips to the TOP and stays there. Started
        // keeps its middle tier everywhere; grace windows unchanged.
        // Within a tier (and within freshly-toggled tasks still in grace): deadline ascending,
        // undated tasks below dated, manual order as the final tiebreaker.
        const completedOnTop = k.endsWith(':next');
        const tierFor = (t: Task) => { const b = tier(t); return b === 2 && completedOnTop ? -1 : b; };
        m[k].sort((a, b) => {
          const at = tierFor(a);
          const bt = tierFor(b);
          if (at !== bt) return at - bt;
          const ad = a.deadline;
          const bd = b.deadline;
          if (ad && bd) return ad === bd ? a.order - b.order : ad < bd ? -1 : 1;
          if (ad) return -1;
          if (bd) return 1;
          return a.order - b.order;
        });
      }
    }
    // Dashboard = aggregated view of work+projects+admin scoped to the current
    // user. A task counts as the user's if they're explicitly an assignee OR
    // if no one is assigned (unassigned tasks default to "everyone's" — they
    // were previously hidden from dashboard, which made dragging an unassigned
    // task into the dashboard's Tomorrow column appear to do nothing because
    // the assignee filter then rejected it from the aggregate).
    const dashBuckets = ['milestones', 'inbox', 'today', 'tomorrow', 'next'] as const;
    for (const s of dashBuckets) {
      const agg: Task[] = [];
      for (const l of LISTS) {
        for (const t of (m[`${l}:${s}`] || [])) {
          if (t.assignees.length === 0 || t.assignees.includes(currentUserShort)) agg.push(t);
        }
      }
      if (s === 'milestones') {
        agg.sort((a, b) => {
          const aSunk = isSunkCompleted(a);
          const bSunk = isSunkCompleted(b);
          if (aSunk !== bSunk) return aSunk ? 1 : -1;
          const ad = a.deadline || '\uffff';
          const bd = b.deadline || '\uffff';
          if (ad !== bd) return ad < bd ? -1 : 1;
          return a.title.localeCompare(b.title);
        });
      } else {
        // Dashboard aggregates carry over per-list bucket order, with the same
        // section-aware completed placement as the per-list sort: sink in
        // today/tomorrow, TOP in next.
        const aggCompletedOnTop = s === 'next';
        const aggTier = (t: Task) => { const b = tier(t); return b === 2 && aggCompletedOnTop ? -1 : b; };
        agg.sort((a, b) => {
          const at = aggTier(a);
          const bt = aggTier(b);
          return at === bt ? 0 : at - bt;
        });
      }
      m[`dashboard:${s}`] = agg;
    }
    // Per-list dashboard sub-sections under Today: each list's today tasks for the
    // current user (or unassigned — same rule as the aggregate above). Order
    // preserved from the underlying today bucket.
    for (const l of LISTS) {
      const agg = (m[`${l}:today`] || []).filter((t) => t.assignees.length === 0 || t.assignees.includes(currentUserShort));
      m[`dashboard:list:${l}`] = agg;
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleTasks, currentUserShort, effectiveListFor, sortTick]);

  const activeTask = activeTaskId ? tasks.find((t) => t.id === activeTaskId) : null;
  // overId may carry a sortable prefix (e.g. "dash:work:taskId"). Strip it so we can resolve the
  // real task — otherwise hovering over a dashboard card returns null and displacement bails out.
  // For calendar cross-list redirects, overId is a `cal:date:list` cell id and the task identity
  // is lost; fall back to overTaskIdHint which calendarCollision captured before redirecting.
  const overTask = useMemo(() => {
    if (!overId) {
      if (overTaskIdHint) return tasks.find((t) => t.id === overTaskIdHint) ?? null;
      return null;
    }
    const s = String(overId);
    if (s.startsWith('cal:') && overTaskIdHint) {
      return tasks.find((t) => t.id === overTaskIdHint) ?? null;
    }
    const i = s.lastIndexOf(':');
    const taskId = i >= 0 ? s.substring(i + 1) : s;
    return tasks.find((t) => t.id === taskId) ?? null;
  }, [overId, overTaskIdHint, tasks]);
  // For project view, over IDs are namespaced as `projtask-${listId}-${taskId}`. Resolve the underlying task
  // so ProjectListColumn can run the same displacement math the list view runs.
  const overProjTask = useMemo(() => {
    if (!overId) return null;
    const s = String(overId);
    if (!s.startsWith('projtask-')) return null;
    const rest = s.slice('projtask-'.length); // `${listId}-${taskId}`
    const dash = rest.indexOf('-');
    if (dash < 0) return null;
    const taskId = rest.slice(dash + 1);
    return tasks.find((t) => t.id === taskId) ?? null;
  }, [overId, tasks]);

  const getAnimationProps = useCallback((task: Task, index: number, list: Task[], idPrefix = '') => {
    if (!activeTask || !overTask || activeTask.id === task.id) return { displacementOffset: 0, insertionGap: 0 };
    // The same task can be rendered in multiple sortable contexts (e.g. dashboard sub-list AND its
    // owning per-list column). Each rendering passes its own idPrefix. Only animate the rendering
    // whose context the active drag actually originated in — otherwise picking up a dashboard task
    // also displaces the per-list column's copy of it (visual duplicates, overlaps).
    //
    // Dashboard same-list cross-section drag: within the new list-first layout, the dashboard
    // splits each list (work/admin/projects) into multiple SortableContexts by section
    // (dash:work:today:, dash:work:tomorrow:, dash:next:work:). For displacement to keep
    // working as the user drags from Tomorrow into Today within the same list, we treat all
    // prefixes with the same dashboard LIST as one animation context — so a drag in
    // dash:work:tomorrow: still animates targets in dash:work:today: (or dash:next:work:).
    const prefixOf = (id: string | null | undefined) => {
      if (!id) return '';
      const i = id.lastIndexOf(':');
      return i >= 0 ? id.substring(0, i + 1) : '';
    };
    const activePrefix = prefixOf(activeId);
    const dashListOf = (prefix: string): string | null => {
      if (!prefix.startsWith('dash:')) return null;
      const parts = prefix.split(':'); // ['dash', list-or-'next', section-or-list, '']
      if (parts[1] === 'next') return parts[2] || null;
      return parts[1] || null;
    };
    const activeDashList = dashListOf(activePrefix);
    const itemDashList = dashListOf(idPrefix);
    const sameAnimContext = activeDashList !== null && itemDashList !== null
      ? activeDashList === itemDashList
      : activePrefix === idPrefix;
    if (!sameAnimContext) return { displacementOffset: 0, insertionGap: 0 };
    const sameBucket = (x: Task, y: Task) => x.list === y.list && x.section === y.section;
    const inActiveBucket = sameBucket(activeTask, task);
    const inOverBucket = sameBucket(overTask, task);
    if (!inActiveBucket && !inOverBucket) return { displacementOffset: 0, insertionGap: 0 };

    if (!sameBucket(activeTask, task) && sameBucket(overTask, task)) {
      const overIndex = list.findIndex((t) => t.id === overTask.id);
      if (index === overIndex) return { displacementOffset: 0, insertionGap: 41 };
      return { displacementOffset: 0, insertionGap: 0 };
    }
    if (inActiveBucket && inOverBucket) {
      const aI = list.findIndex((t) => t.id === activeTask.id);
      const oI = list.findIndex((t) => t.id === overTask.id);
      if (aI < oI && index > aI && index <= oI) return { displacementOffset: -41, insertionGap: 0 };
      if (aI > oI && index >= oI && index < aI) return { displacementOffset: 41, insertionGap: 0 };
    }
    return { displacementOffset: 0, insertionGap: 0 };
  }, [activeTask, overTask, activeId, overId]);

  const renderBucket = (list: Task[], idPrefix = '') => (
    <SortableContext items={list.map((t) => `${idPrefix}${t.id}`)} strategy={verticalListSortingStrategy}>
      <AnimatePresence>
        {list.map((task, index) => {
          const { displacementOffset, insertionGap } = getAnimationProps(task, index, list, idPrefix);
          return (
            <SortableTaskItem key={`${idPrefix}${task.id}`} task={task} idPrefix={idPrefix} onToggle={() => toggleTask(task.id)} onRename={(title) => renameTask(task.id, title)} onDelete={() => deleteTask(task.id)} onEdit={(e) => openEdit(task, e)} onQuickEdit={(e) => openQuick(task, e)} onAddSibling={() => addSiblingTask(task)} onReschedule={(kind) => rescheduleTaskTo(task.id, kind)} onCancelPendingRename={() => cancelSentenceCaseTask(task.id)} onSelect={() => selectTask(task.id)} isSelected={selectedTaskId === task.id} hasFocusContent={taskHasFocusContent(task)} onOpenFocus={() => openTaskInFocus(task.id)} autoFocus={task.id === newId} displacementOffset={displacementOffset} insertionGap={insertionGap} isAnyDragging={!!activeTask} collapsed={sourceCollapsed && `${idPrefix}${task.id}` === activeId} projects={projects} clients={clients} taskOrder={taskOrder} density={density} />
          );
        })}
      </AnimatePresence>
    </SortableContext>
  );

  // Milestones are read-only in the column: not draggable, sorted by deadline. Still rendered through
  // SortableTaskItem (with nonDraggable) so visuals stay identical to other rows. Inherits the
  // user's taskOrder + density just like regular tasks so the meta-slot order matches.
  // onAddSibling is wired so the hover-reveal + button on the milestone row spawns a sibling task
  // in the milestone's project — matches the affordance on every other view.
  const renderMilestoneBucket = (list: Task[]) => (
    <>
      {list.map((task) => (
        <SortableTaskItem
          key={task.id}
          task={task}
          onToggle={() => toggleTask(task.id)}
          onRename={(title) => renameTask(task.id, title)}
          onDelete={() => deleteTask(task.id)}
          onEdit={() => openEdit(task)}
          onQuickEdit={(e) => openQuick(task, e)}
          onAddSibling={() => addSiblingTask(task)}
          onSelect={() => selectTask(task.id)}
          isSelected={selectedTaskId === task.id}
          hasFocusContent={taskHasFocusContent(task)}
          onOpenFocus={() => openTaskInFocus(task.id)}
          isAnyDragging={!!activeTask}
          projects={projects}
          clients={clients}
          taskOrder={taskOrder}
          density={density}
        />
      ))}
    </>
  );
  // ^ milestones are now DRAGGABLE (nonDraggable removed): the drop plumbing
  // already supported cross-list milestone moves (section:<list>:milestones
  // targets convert type correctly), so a milestone accidentally filed under
  // Work can simply be dragged into Projects/Admin.

  // omitDeadlineIso: the focus page's mini-calendar bands are already grouped BY day, so a
  // per-row chip matching the band's own day ("Today" inside the Today band) is noise — pass
  // the band's iso to suppress exactly those. Chips for OTHER days still render, which is
  // how an overdue task inside Today keeps its red late date. Dashboard-milestones callsite
  // passes nothing and keeps all dates.
  const renderReadonlyBucket = (list: Task[], omitDeadlineIso?: string, titleOnly?: boolean, onRowClick?: (t: Task) => void, activeRowId?: string | null) => (
    <>
      {list.map((task) => {
        const project = task.projectId ? projects.find((p) => p.id === task.projectId) : undefined;
        const resolvedClientId = task.clientId ?? project?.clientId;
        const client = resolvedClientId ? clients.find((c) => c.id === resolvedClientId) : undefined;
        const isScheduled = task.type === 'scheduled';
        const isNext = task.section === 'next' || task.section === 'tomorrow';
        const isPersonal = resolvedClientId === PERSONAL_CLIENT_ID || task.list === 'personal';
        // Active filter row (milestone filter): white title + × at the row end — the same
        // visual the client/project filter rows use.
        const isActiveRow = activeRowId === task.id;
        const titleColor = isActiveRow ? 'text-white' : isScheduled ? 'text-[#8465ff]' : task.completed ? 'text-[#474747]' : isNext ? 'text-[#a8a8a8]' : 'text-white';
        const metaColor = task.completed ? 'text-[#474747]' : isScheduled ? 'text-[#8465ff]' : 'text-[#656464]';
        return (
          <div key={`dash-${task.id}`} onClick={onRowClick ? () => onRowClick(task) : undefined} onDoubleClick={() => openEdit(task)} onContextMenu={(e) => { e.preventDefault(); openQuick(task); }} className={`h-[37px] box-border flex flex-row gap-2 items-center px-[31px] w-full group hover:bg-white/[0.03] ${onRowClick ? 'cursor-pointer' : ''}`}>
            {!isScheduled && <TaskCheckbox completed={task.completed} started={task.started} onToggle={() => toggleTask(task.id)} />}
            <div className="flex flex-row items-center gap-[4px]">
              {/* Use the shared taskOrderSlots so dashboard milestones honor the user's chosen
                  meta order (cpt / tcp / ptc, etc.) — same as regular task rows do. */}
              {(() => {
                // titleOnly (milestones column): drop the client / project meta entirely — just
                // the milestone name + its date read cleanly in a narrow column.
                const showClient = !titleOnly && !!client;
                const showProject = !titleOnly && !!project;
                const metaCls = `font-['Univers_BQ:55_Regular',sans-serif] text-[14px] whitespace-nowrap ${task.completed ? 'text-[#474747]' : 'text-[#656464]'}`;
                return taskOrderSlots(taskOrder, showProject, showClient).map((slot, i) => {
                  if (slot === 'project' && project) return <p key={`p-${i}`} className={metaCls}>{project.name}</p>;
                  if (slot === 'client' && client) return <p key={`c-${i}`} className={`font-['Univers_BQ:55_Regular',sans-serif] text-[14px] whitespace-nowrap ${metaColor}`}>{client.short}</p>;
                  if (slot === 'cp' && client && project) return <p key={`cp-${i}`} className={metaCls}>{client.short}<Arrowhead dim={task.completed} />{project.name}</p>;
                  if (slot === 'title') return <span key={`t-${i}`} className={`font-['Univers_BQ:55_Regular',sans-serif] text-[14px] whitespace-nowrap ${titleColor}`}>{task.title}</span>;
                  return null;
                });
              })()}
            </div>
            {!titleOnly && task.assignees.map((a, i) => <AssigneeBadge key={`${a}-${i}`} letter={a} tone={isScheduled ? 'scheduled' : 'todo'} hollow={isPersonal} dim={task.completed} />)}
            {task.deadline && task.deadline !== omitDeadlineIso && (
              <>
                <DeadlineArrow dim={task.completed} color={isScheduled ? '#8465ff' : undefined} />
                <p className={`font-['NB_International:Regular',sans-serif] text-[14.333px] whitespace-nowrap ${task.completed ? 'text-[#474747]' : isScheduled ? 'text-[#8465ff]' : isLateDeadline(task.deadline) ? 'text-[#FF7171]' : isNext ? 'text-[#a8a8a8]' : 'text-white'}`}>{formatDeadline(task.deadline)}</p>
              </>
            )}
            {isActiveRow && <X size={13} className="ml-auto text-[#a8a8a8] shrink-0" />}
            <button
              type="button"
              onClick={() => deleteTask(task.id)}
              className={`${isActiveRow ? '' : 'ml-auto'} -mr-[22px] p-1 opacity-0 group-hover:opacity-100 text-[#5e5e5e] hover:text-white transition-opacity`}
              aria-label="Delete task"
            >
              <Trash2 size={14} />
            </button>
          </div>
        );
      })}
    </>
  );

  // filterProjectId (dashboard column only): when set, every bucket narrows to that single
  // project's tasks — the focus page's left-panel project filter drives this. Callers that
  // use Array.map must wrap in a lambda (`LISTS.map((l) => renderColumn(l))`) so map's index
  // isn't accidentally passed as the filter.
  const renderColumn = (listId: ListId, filterProjectId?: string | null, filterClientId?: string | null) => {
    // When a left-panel filter is active, tasks added from this column must inherit it or they
    // fail the scope filter and vanish on creation. Undefined when no filter is active.
    const filterOpts = filterProjectId ? { projectId: filterProjectId } : filterClientId ? { clientId: filterClientId } : undefined;
    // Dashboard tasks are now draggable too â€” using the same renderBucket as the per-list columns.
    // Reordering within a sub-list (admin/work/projects) updates order; dragging across sub-lists
    // moves the task to the target's list (handled by handleCrossSectionMove).
    const bucket = renderBucket;
    const milestoneBucket = listId === 'dashboard' ? renderReadonlyBucket : renderMilestoneBucket;
    const wrap = (section: string, node: React.ReactNode) =>
      listId === 'dashboard' ? node : <SectionDroppable id={`section:${listId}:${section}`}>{node}</SectionDroppable>;
    // Milestones only surface in per-list columns; the dashboard omits them so they aren't duplicated.
    const milestones = listId === 'dashboard' ? [] : (tasksByKey[`${listId}:milestones`] || []);
    return (
      // Three-tier layout: column title (sticky), milestones (sticky-below-title), then a
      // flex-1 scroller that contains the rest. The whole column is min-h-0 so flex parent's
      // overflow:hidden actually clips it instead of letting it grow forever.
      <div key={listId} className="flex-1 min-w-[280px] flex flex-col min-h-0 overflow-hidden">
        {/* Column title — 37px-tall flex container with a DOUBLE carriage-return below so the
            column header has a clear paragraph break before its first section. shrink-0 so
            the title never gets squeezed by the scrolling content. */}
        <div className="shrink-0 group h-[37px] w-full box-border flex flex-row gap-2 items-center px-[35px]" style={{ marginBottom: SPACING.dcr }}>
          <p className="font-['NB_International:Regular',sans-serif] leading-[normal] not-italic text-[14.333px] text-white">
            {LIST_TITLES[listId]}
            {listId === 'dashboard' && (
              <> — {people.find((p) => p.short === currentUserShort)?.name || currentUserShort}</>
            )}
          </p>
        </div>
        {/* Milestones — also pinned (shrink-0) so they stay visible when the rest scrolls. */}
        {milestones.length > 0 && (
          <div className="shrink-0">{wrap('milestones', milestoneBucket(milestones))}</div>
        )}
        {/* Independent per-column scroll. Inbox + Today/Tomorrow/Next sections live here.
            CustomScroll supplies the fixed-size pill thumb (the native scrollbar is hidden). */}
        <CustomScroll>
        {/* Inbox only surfaces in the per-list columns. The dashboard's list-first structure is
            Today/Tomorrow → Next; the aggregated inbox isn't part of it and, being outside the
            scoped block, would leak past the project/client filter — so skip it here. */}
        {listId !== 'dashboard' && (tasksByKey[`${listId}:inbox`] || []).length > 0 && wrap('inbox', bucket(tasksByKey[`${listId}:inbox`] || []))}
        {listId === 'dashboard' ? (
          // Dashboard column — list-first hierarchy (user-requested reorganization):
          //
          //   Work (tall date-tier)            ┐
          //     Today                          │  ← per-list block: WORK list's today
          //       <work today tasks>           │     + tomorrow tasks, both filtered to
          //     (space)                        │     the current user.
          //     Tomorrow                       │
          //       <work tomorrow tasks>        ┘
          //   (space)
          //   Admin (tall date-tier)           ┐
          //     Today                          │  ← same shape, ADMIN list's tasks
          //     Tomorrow                       ┘
          //   (space)
          //   Projects (tall date-tier)        ┐
          //     Today                          │  ← same shape, PROJECTS list's tasks
          //     Tomorrow                       ┘
          //   (space)
          //   Next (tall date-tier)            ┐
          //     Work                           │  ← cross-list aggregate of NEXT-section
          //       <work next tasks>            │     tasks, broken down by list
          //     Admin                          │
          //       <admin next tasks>           │
          //     Projects                       │
          //       <projects next tasks>        ┘
          //
          // The sticky overlay reads data-sticky-tier on each SectionHeader: the
          // list labels (Work/Admin/Projects/Next) are tier='date' tall, the inner
          // date/list labels are tier='category' at top:74 flush below.
          (() => {
            // Inline assignee filter — dashboard scopes to tasks assigned to the
            // current user (or unassigned, which default to "everyone's").
            const forMe = (xs: Task[]) => xs.filter((t) => t.assignees.length === 0 || t.assignees.includes(currentUserShort));
            // Left-panel filter — narrow to ONE project, else to ALL of a client's tasks
            // (a task's client = its explicit clientId, else its project's clientId). Applied
            // after forMe so the filter narrows every bucket.
            const clientOf = (t: Task) => t.clientId ?? (t.projectId ? projects.find((p) => p.id === t.projectId)?.clientId : undefined);
            const scope = (xs: Task[]) =>
              filterProjectId ? xs.filter((t) => t.projectId === filterProjectId)
              : filterClientId ? xs.filter((t) => clientOf(t) === filterClientId)
              : xs;
            // Universal section sequence (Settings) drives the block order here too.
            const orderedLists = listSequence;
            // Build per-list bundles up-front so we know which list blocks are
            // empty (skipped) vs visible (rendered) — needed for the Spacer
            // between-block logic to skip dead spacers.
            const blocks = orderedLists.map((list) => {
              const today = scope(forMe(tasksByKey[`${list}:today`] || []));
              const tomorrow = tomorrowEnabled ? scope(forMe(tasksByKey[`${list}:tomorrow`] || [])) : [];
              // When tomorrow is OFF, tomorrow-tagged tasks fall through into
              // next — mirrors the per-list column's tomorrow→next merge.
              const next = scope(forMe(tomorrowEnabled
                ? (tasksByKey[`${list}:next`] || [])
                : [...(tasksByKey[`${list}:tomorrow`] || []), ...(tasksByKey[`${list}:next`] || [])]));
              return { list, today, tomorrow, next };
            });
            const listBlocks = blocks.filter((b) => b.today.length + b.tomorrow.length > 0);
            const nextBlocks = blocks.filter((b) => b.next.length > 0);
            return (
              <>
                {/* Per-list blocks: Work, then Admin, then Projects (skipping any
                    list with no today/tomorrow tasks). */}
                {/* Quick-add is wired on every header: the tall list header (Work/Admin/
                    Projects) and the "Today / Tomorrow" header both spawn a today task in
                    that list; the Next sub-headers spawn a next task. The new blank task
                    autofocuses inline (renderBucket passes autoFocus on newId) so the user
                    types straight into it — no mode switch needed. */}
                {listBlocks.map((b, idx) => (
                  <div key={`dash-list-${b.list}`}>
                    {idx > 0 && <Spacer />}
                    <SectionHeader title={LIST_TITLES[b.list]} sticky="date" tall onAdd={() => { addBlankTaskInSection(b.list, 'today', filterOpts); }} />
                    {/* Today + Tomorrow consolidated into ONE chunk per list — a single
                        "Today / Tomorrow" header with the tasks stacked day-ordered
                        (todays first, then tomorrows). The separate sub-headers were
                        reading as noise. Day membership stays visible through the row
                        tone: tomorrow rows render in the dimmer next-tier grey. One
                        merged SortableContext (prefix dash:<list>:days:) so drags flow
                        across the day boundary; drops resolve the section from the
                        target row, same as before. */}
                    <SectionHeader title="Today / Tomorrow" sticky="category" onAdd={() => { addBlankTaskInSection(b.list, 'today', filterOpts); }} />
                    {bucket([...b.today, ...b.tomorrow], `dash:${b.list}:days:`)}
                  </div>
                ))}
                {/* Next block at the bottom — same shape as the list blocks but
                    with the categories swapped: Next is the date label, the
                    sub-sections are the lists (Work/Admin/Projects). */}
                {nextBlocks.length > 0 && (
                  <div>
                    {listBlocks.length > 0 && <Spacer />}
                    <SectionHeader title="Next" sticky="date" tall />
                    {nextBlocks.map((b, idx) => (
                      <Fragment key={`dash-next-${b.list}`}>
                        {idx > 0 && <Spacer />}
                        <SectionHeader title={LIST_TITLES[b.list]} sticky="category" onAdd={() => { addBlankTaskInSection(b.list, 'next', filterOpts); }} />
                        {bucket(b.next, `dash:next:${b.list}:`)}
                      </Fragment>
                    ))}
                  </div>
                )}
              </>
            );
          })()
        ) : (
          // Headers live INSIDE their section's droppable so dropping ON the "Today" / "Next"
          // label (or anywhere in that section's empty space) lands in that section. Previously
          // the headers were free-standing siblings â€” drops on them fell through.
          //
          // Per-list columns have NO category sub-tier — there's only one date-level header per
          // section. Each section's SectionDroppable wraps the header + cards and scopes the
          // sticky behavior: the header sticks at top:0 within the section, then pops out when
          // the user scrolls past the section's last card.
          <>
            {wrap('today', (
              <>
                <SectionHeader title="Today" sticky="date" onAdd={() => addBlankTaskInSection(listId, 'today', filterOpts)} />
                {bucket(tasksByKey[`${listId}:today`] || [])}
              </>
            ))}
            {tomorrowEnabled && wrap('tomorrow', (
              <>
                <SectionHeader title="Tomorrow" sticky="date" onAdd={() => addBlankTaskInSection(listId, 'tomorrow', filterOpts)} />
                {bucket(tasksByKey[`${listId}:tomorrow`] || [])}
              </>
            ))}
            {wrap('next', (
              <>
                <SectionHeader title="Next" sticky="date" onAdd={() => addBlankTaskInSection(listId, 'next', filterOpts)} />
                {/* When the Tomorrow toggle is OFF, tomorrow-tagged tasks visually appear here
                    inside Next. Their data still says section='tomorrow' so flipping the toggle
                    on restores them to the Tomorrow section without losing context. */}
                {bucket(tomorrowEnabled
                  ? (tasksByKey[`${listId}:next`] || [])
                  : [...(tasksByKey[`${listId}:tomorrow`] || []), ...(tasksByKey[`${listId}:next`] || [])])}
              </>
            ))}
          </>
        )}
        </CustomScroll>
      </div>
    );
  };

  // PROJECT VIEW 2: built fresh from the list view (renderColumn). Same column shape, same
  // drag mechanics — but tasks grouped under client > project headers instead of by section.
  // renderBucket inside uses SortableTaskItem with showIndent + hideContext so visuals match
  // the legacy project view (LIndent, no redundant project/client meta on rows).
  const proj2BodyFont = "font-['Univers_BQ:55_Regular',sans-serif] leading-[normal] not-italic text-[14px] whitespace-nowrap";
  const proj2SortedClients = useMemo(() => [...clients].sort((a, b) => {
    if (a.id === PERSONAL_CLIENT_ID) return -1;
    if (b.id === PERSONAL_CLIENT_ID) return 1;
    return a.name.localeCompare(b.name);
  }), [clients]);
  // Render a sortable bucket of tasks with the project-view-2 visual flags. Same wiring as
  // list view's renderBucket. The third arg toggles the LIndent ⌐ prefix — true for tasks
  // under a project header, false for orphan/loose lists (no parent to indent under, so the
  // indent reads as visual noise). App-scope (not inside renderProjectGroupedColumn) because
  // the focus page's single-project drill-down reuses it for its task list.
  const renderProjectBucket = (list: Task[], idPrefix: string, indent: boolean) => (
      <SortableContext items={list.map((t) => `${idPrefix}${t.id}`)} strategy={verticalListSortingStrategy}>
        <AnimatePresence>
          {list.map((task, index) => {
            const { displacementOffset, insertionGap } = getAnimationProps(task, index, list, idPrefix);
            return (
              <SortableTaskItem
                key={`${idPrefix}${task.id}`}
                task={task}
                idPrefix={idPrefix}
                onToggle={() => toggleTask(task.id)}
                onRename={(title) => renameTask(task.id, title)}
                onDelete={() => deleteTask(task.id)}
                onEdit={(e) => openEdit(task, e)}
                onQuickEdit={(e) => openQuick(task, e)}
                onAddSibling={() => addSiblingTask(task)}
                onReschedule={(kind) => rescheduleTaskTo(task.id, kind)}
                onCancelPendingRename={() => cancelSentenceCaseTask(task.id)}
                onSelect={() => selectTask(task.id)}
                isSelected={selectedTaskId === task.id}
                hasFocusContent={taskHasFocusContent(task)}
                onOpenFocus={() => openTaskInFocus(task.id)}
                autoFocus={task.id === newId}
                displacementOffset={displacementOffset}
                insertionGap={insertionGap}
                isAnyDragging={!!activeTask}
                collapsed={sourceCollapsed && `${idPrefix}${task.id}` === activeId}
                projects={projects}
                clients={clients}
                taskOrder={taskOrder}
                density={density}
                showIndent={indent}
                hideContext
              />
            );
          })}
        </AnimatePresence>
      </SortableContext>
    );

  const renderProjectGroupedColumn = (listId: ListId) => {
    // Gather all tasks visible in this list (across all sections — Project View 2 doesn't carve
    // by today/tomorrow/next, it carves by client > project). Milestones (type === 'scheduled')
    // are included too so they live UNDER their project header in project view, not as a separate
    // top-of-column bucket like in list view.
    const allTasks = (tasksByKey[`${listId}:today`] || [])
      .concat(tasksByKey[`${listId}:tomorrow`] || [])
      .concat(tasksByKey[`${listId}:next`] || [])
      .concat(tasksByKey[`${listId}:inbox`] || [])
      .concat(tasksByKey[`${listId}:milestones`] || []);
    // Map projectId → tasks (non-projected tasks go to orphans). Milestones often don't have
    // an explicit projectId but ARE conceptually a project's milestone (e.g. an "RSL Launch"
    // milestone belongs in the "Launch" project under the RSL client). Resolve them by matching
    // title to a project name under the same client — purely a render-time inference, the
    // underlying task data is untouched.
    const tasksByProject = new Map<string, Task[]>();
    // Tasks that have a clientId but no project (and no inferred project match) — they live
    // under their client header without a project subgroup, so e.g. a Zakynthos milestone with
    // no project still appears in project view as "Zakynthos → milestone" instead of falling to
    // the column orphan strip at the very top.
    const tasksByClient = new Map<string, Task[]>();
    const orphans: Task[] = [];
    for (const t of allTasks) {
      let resolvedProjectId = t.projectId;
      if (!resolvedProjectId && t.type === 'scheduled' && t.clientId && t.title) {
        const norm = t.title.trim().toLowerCase();
        const matched = projects.find(
          (p) => p.clientId === t.clientId && p.name && p.name.trim().toLowerCase() === norm,
        );
        if (matched) resolvedProjectId = matched.id;
      }
      if (resolvedProjectId && projects.find((p) => p.id === resolvedProjectId)) {
        const arr = tasksByProject.get(resolvedProjectId) || [];
        arr.push(t);
        tasksByProject.set(resolvedProjectId, arr);
      } else if (t.clientId && clients.find((c) => c.id === t.clientId)) {
        const arr = tasksByClient.get(t.clientId) || [];
        arr.push(t);
        tasksByClient.set(t.clientId, arr);
      } else {
        orphans.push(t);
      }
    }
    // Pin milestones to the top of each project's bucket so they read as the project's
    // headline goal, with the day-to-day tasks underneath.
    // Milestones sort by deadline ascending (undated last, title tiebreak) everywhere they
    // pin — same rule as the list-view milestones bucket and the focus panel.
    const sortMilestones = (xs: Task[]) => [...xs].sort((a, b) => {
      const ad = a.deadline || '￿';
      const bd = b.deadline || '￿';
      if (ad !== bd) return ad < bd ? -1 : 1;
      return a.title.localeCompare(b.title);
    });
    for (const pid of Array.from(tasksByProject.keys())) {
      const arr = tasksByProject.get(pid)!;
      const milestones = arr.filter((t) => t.type === 'scheduled');
      if (milestones.length === 0) continue;
      const others = arr.filter((t) => t.type !== 'scheduled');
      tasksByProject.set(pid, [...sortMilestones(milestones), ...others]);
    }
    // Same milestone-on-top rule for client-level orphans (no project under them).
    for (const cid of Array.from(tasksByClient.keys())) {
      const arr = tasksByClient.get(cid)!;
      const milestones = arr.filter((t) => t.type === 'scheduled');
      if (milestones.length === 0) continue;
      const others = arr.filter((t) => t.type !== 'scheduled');
      tasksByClient.set(cid, [...sortMilestones(milestones), ...others]);
    }
    // Build the client > projects hierarchy. A client appears in this column if any of its
    // projects has tasks here, OR it's pinned to this list, OR it has client-level tasks
    // (e.g. a milestone tied to the client without a concrete project).
    const clientBlocks = proj2SortedClients
      .map((c) => {
        const clientProjects = projects
          .filter((p) => p.clientId === c.id)
          .filter((p) => {
            if (p.list) return p.list === listId;
            // Unpinned project: show in 'projects' list as default home, plus anywhere it has tasks here
            return listId === 'projects' || tasksByProject.has(p.id);
          });
        const clientLevelTasks = tasksByClient.get(c.id) || [];
        return { client: c, projects: clientProjects, clientLevelTasks };
      })
      .filter((b) => b.projects.length > 0 || b.clientLevelTasks.length > 0);
    return (
      <Proj2ColumnDroppable key={listId} listId={listId}>
        {/* Column header with the cascading add menu (HeaderAddMenu). DOUBLE carriage-return
            below for a paragraph break before the first client / project block. shrink-0 so
            it stays pinned at the top of the column when the rest scrolls. */}
        <div className="shrink-0 group h-[37px] w-full box-border flex flex-row gap-2 items-center px-[35px]" style={{ marginBottom: SPACING.dcr }}>
          <p className="font-['NB_International:Regular',sans-serif] leading-[normal] not-italic text-[14.333px] text-white">
            {LIST_TITLES[listId]}
          </p>
          <HeaderAddMenu
            clients={clients}
            onAddBlankClient={addBlankClient}
            onAddBlankProject={(clientId) => addBlankProject(clientId, listId)}
            onAddBlankTask={() => addBlankTaskInList(listId)}
          />
        </div>
        {/* Independent per-column scroll. Orphans + client/project blocks live here.
            CustomScroll supplies the fixed-size pill thumb (the native scrollbar is hidden). */}
        <CustomScroll>
        {orphans.length > 0 && (
          <div className="mb-[37px]">
            {renderProjectBucket(orphans, `proj2:${listId}:none:`, false)}
          </div>
        )}
        {clientBlocks.map(({ client: c, projects: clientProjects, clientLevelTasks }, ci) => (
          <div key={c.id}>
            {ci > 0 && <Spacer />}
            {/* Client subheader — editable client name + AddPlus to spawn a new project under
                this client in this column. Trash button opens the TRASH-confirm modal (Personal
                client cannot be deleted — it's a system client). */}
            <div className="group h-[37px] w-full box-border flex flex-row gap-2 items-center px-[31px]">
              <EditableText
                value={c.name}
                onChange={(v) => renameClient(c.id, v)}
                autoFocus={c.id === newId}
                placeholder="New Client"
                onDiscardIfEmpty={() => deleteClient(c.id)}
                className={`${proj2BodyFont} text-[#656464]`}
              />
              <AddPlus onClick={() => addBlankProject(c.id, listId)} />
              {c.id !== PERSONAL_CLIENT_ID && (
                <div className="ml-auto">
                  <TrashBtn onClick={() => setPendingTrash({ kind: 'client', id: c.id, name: c.name || 'Untitled' })} />
                </div>
              )}
            </div>
            {/* Client-level tasks (no project) sit directly under the client header — typically
                milestones tied to a client without a specific project. Indented like project
                tasks for visual continuity. */}
            {clientLevelTasks.length > 0 && renderProjectBucket(clientLevelTasks, `proj2:${listId}:client:${c.id}:`, true)}
            {clientProjects.map((p) => {
              const projTasks = tasksByProject.get(p.id) || [];
              return (
                <Proj2ProjectDropZone key={p.id} projectId={p.id} listId={listId}>
                  {/* Project header — folder icon + EDITABLE project name + AddPlus to spawn
                      a new task under this project. The name uses EditableText so the user can
                      click-to-rename, with placeholder + autoFocus on freshly-created projects.
                      onDiscardIfEmpty deletes the project if the user blurs without typing
                      anything (matches the fresh-task fade behavior). */}
                  <div className="group h-[37px] w-full box-border flex flex-row gap-2 items-center px-[35px]">
                    {/* Folder icon doubles as the drag handle — drag the project into another
                        column to recategorize it (tasks follow). */}
                    <Proj2ProjectDragHandle project={p} listId={listId} />
                    <EditableText
                      value={p.name}
                      onChange={(v) => renameProject(p.id, v)}
                      autoFocus={p.id === newId}
                      placeholder="New Project"
                      onDiscardIfEmpty={() => deleteProject(p.id)}
                      className={`${proj2BodyFont} text-[#656464]`}
                    />
                    <AddPlus onClick={() => addTaskToProject(p.id, listId)} />
                    <div className="ml-auto">
                      <TrashBtn onClick={() => setPendingTrash({ kind: 'project', id: p.id, name: p.name || 'Untitled' })} />
                    </div>
                  </div>
                  {/* Empty-project drop slot. When a project has no tasks, the header alone
                      can be a tiny target — the slot adds a 37px landing zone so users have
                      something to aim at directly under the header. The Proj2ProjectDropZone
                      wraps both, so dropping anywhere on this block reparents the dragged task. */}
                  {projTasks.length === 0 ? (
                    <div className="h-[37px] w-full" aria-hidden />
                  ) : (
                    renderProjectBucket(projTasks, `proj2:${listId}:${p.id}:`, true)
                  )}
                </Proj2ProjectDropZone>
              );
            })}
          </div>
        ))}
        </CustomScroll>
      </Proj2ColumnDroppable>
    );
  };

  const calendarCollision = useCallback((args: Parameters<typeof pointerWithin>[0]) => {
    const collisions = pointerWithin(args);
    // Edge assign drawers win over everything, in EVERY mode — without this the calendar
    // branch below filters collisions down to cal-cell hits and the drawers would be
    // unreachable drop targets while in calendar view.
    // Assign tray wins over everything while a task is over it. Prefer a SPECIFIC row
    // (edge:project / edge:person → real assignment) over the full-area mask (edge:__mask__
    // → just suppresses the columns underneath), so dropping on a row assigns while dropping
    // in a gap/header simply does nothing instead of leaking to the columns below.
    const edgeHits = collisions.filter((c) => String(c.id).startsWith('edge:'));
    // The tray's droppables are always mounted (for correct measurement), so they collide even
    // when the tray is shut. Only honour them while it's actually OPEN; otherwise drop them from
    // consideration so a normal drag over the first column behaves as if the tray weren't there.
    if (edgeDrawerRef.current === 'left') {
      if (edgeHits.length) {
        const specific = edgeHits.find((c) => c.id !== 'edge:__mask__');
        return [specific || edgeHits[0]];
      }
    }
    const base = edgeHits.length ? collisions.filter((c) => !String(c.id).startsWith('edge:')) : collisions;
    // The focus page's day columns use the SAME calendar engine as the Calendar view, so it needs
    // the same collision handling — most importantly the CATEGORY LOCK: a task-card collision is
    // redirected to a cell in the DRAGGED task's own list (activeList), so dropping a Projects
    // card onto the Work band keeps it a Projects task (lands in Projects) instead of flipping to
    // Work. Hold Ctrl/Cmd to override (allowListChange). Without extending this to focus mode, a
    // focus-view drop onto another card fell through to the reorder path and changed categories.
    if (mode !== 'calendar' && mode !== 'focus') return base;
    const activeCellId = args.active.data.current?.calendarCellId as string | undefined;
    const activeTask = args.active.data.current?.task as Task | undefined;
    if (!activeCellId || !activeTask) return base;
    const activeList = activeTask.list;
    const allowListChange = ctrlDownRef.current;

    // Resolve the target day from any collision â€” whether on a cal cell or a task card in a different cell.
    const dayFromCollision = (c: { id: string | number }): string | null => {
      const id = String(c.id);
      if (id.startsWith('cal:')) return id.split(':')[1] || null;
      const container = args.droppableContainers.find((d) => d.id === c.id);
      const otherCell = container?.data?.current?.calendarCellId as string | undefined;
      if (otherCell) return otherCell.split(':')[1] || null;
      return null;
    };

    // Track per-cell collisions (to preserve intra-cell sortable reordering).
    const cellHits: typeof collisions = [];
    let columnHit: { id: string; date: string } | null = null;
    const seen = new Set<string>();
    for (const c of base) {
      const id = String(c.id);
      if (id.startsWith('col:')) {
        if (!columnHit) columnHit = { id, date: id.split(':')[1] };
        continue;
      }
      if (id.startsWith('cal:')) {
        const [, date, list] = id.split(':');
        // Remember which cell the cursor was REALLY over before any list-redirect — the
        // drop handler uses this to know if the user released above / below / inside the
        // source category band.
        lastCalOverCellIdRef.current = id;
        if (allowListChange || list === activeList) {
          if (!seen.has(id)) { cellHits.push(c); seen.add(id); }
        } else {
          const redirectId = `cal:${date}:${activeList}`;
          if (!seen.has(redirectId)) { cellHits.push({ ...c, id: redirectId }); seen.add(redirectId); }
        }
        continue;
      }
      // Task-card collision.
      const container = args.droppableContainers.find((d) => d.id === c.id);
      const otherCell = container?.data?.current?.calendarCellId as string | undefined;
      if (otherCell && otherCell === activeCellId) {
        if (!seen.has(id)) { cellHits.push(c); seen.add(id); }
        continue;
      }
      const day = otherCell ? otherCell.split(':')[1] : dayFromCollision(c);
      if (day) {
        // BEFORE we redirect this task collision to a cell id, remember the task id so the
        // cell-drop handler can insert at that task's position AND the per-cell displacement
        // can open an insertion gap above it (cross-column visual cue).
        lastCalOverTaskIdRef.current = id;
        if (otherCell) lastCalOverCellIdRef.current = otherCell;
        // Mirror to state so the per-cell displacement re-renders. Wrap in a setState only
        // when the value actually changes — calendarCollision runs on every cursor tick.
        setOverTaskIdHint((prev) => (prev === id ? prev : id));
        const redirectId = `cal:${day}:${activeList}`;
        if (!seen.has(redirectId)) { cellHits.push({ ...c, id: redirectId }); seen.add(redirectId); }
      }
    }
    if (cellHits.length > 0) return cellHits;
    // No direct cell/card hit â€” fall back to a column hit, redirecting to source-list cell for that day.
    if (columnHit) {
      return [{ id: `cal:${columnHit.date}:${activeList}`, data: { droppableContainer: null as any, value: 1 } } as unknown as (typeof collisions)[number]];
    }
    return [];
  }, [mode]);

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={calendarCollision}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragMove={(ev) => {
        const ae = ev.activatorEvent as PointerEvent | null;
        const x = (ae && typeof ae.clientX === 'number' ? ae.clientX : 0) + ev.delta.x;
        // Left-only assign tray: enter the left edge zone while dragging a task → the tray
        // pulls out; drift back toward the middle → it tucks away.
        if (activeType === 'task' || activeType === 'projTask') {
          if (x < 110 && mode !== 'settings') setEdgeDrawer('left');
          else if (x > 360) setEdgeDrawer(null);
        }
      }}
      onDragEnd={(ev) => { setEdgeDrawer(null); handleDragEnd(ev); }}
      measuring={measuringConfig}
      // NO axis lock on task drags any more — cards must be able to travel horizontally
      // into the edge assign drawers (and the Projects-view tray). The category lock is
      // still enforced at the displacement+drop layer so data stays clean.
      modifiers={[]}
    >
      {/* New-version banner. Sits fixed at the top of the viewport with a
          high z-index so it overlays the TopHeader and column titles. The
          poll detected a freshly-deployed bundle whose buildTime is newer
          than the one running in this webview; the user can either Reload
          (window.location.reload pulls the new bundle from the server) or
          Dismiss (mutes for THIS specific buildTime — banner re-opens the
          next time a newer build is detected). */}
      {newBuildTime && newBuildTime !== dismissedBuildTime && (
        <div className="fixed top-0 left-0 right-0 z-[1000] bg-[#8465ff] text-white px-[35px] py-2 flex flex-row items-center gap-3 text-[13px] shadow-lg">
          <span className="font-bold">New version available</span>
          <span className="text-white/80">deployed {new Date(newBuildTime).toLocaleString()}</span>
          <div className="ml-auto flex flex-row gap-2 items-center">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="px-3 py-1 rounded-md bg-white text-[#8465ff] hover:bg-white/90 transition-colors font-bold"
            >
              Reload
            </button>
            <button
              type="button"
              onClick={() => setDismissedBuildTime(newBuildTime)}
              className="px-3 py-1 rounded-md text-white/80 hover:text-white transition-colors"
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
        </div>
      )}
      {/* pl-[22px] carves a permanent gutter on the far left for the assign rail, so the rail
          lives in its OWN space and never overlaps a column. Fixed overlays (rail, tray, nav,
          modals) are position:fixed → unaffected by this padding; only the flowing mode views
          shift right into place. PIP has no rail, so no gutter there. */}
      <div className={`relative h-screen bg-[#282828] overflow-hidden ${PIP_MODE ? '' : 'pl-[22px]'}`}>
        {/* PIP quick-view: an always-on-top mini-window (?pip=1, opened by the Tauri shell's
            global shortcut) that renders the FOCUS view below with NO BottomBar / tray chrome.
            Edits sync live via Liveblocks, so changes here land in the main window instantly.
            The focus block's guard (PIP_MODE || mode === 'focus') is what fires it in PIP. */}
        {!PIP_MODE && mode === 'dashboard' && (
          <div className="h-full flex flex-col" style={{ paddingTop: SPACING.topMargin, paddingBottom: 76 }}>
            <div className="shrink-0">
              <TopHeader viewName="List" />
            </div>
            {/* Columns row — flex-1 + min-h-0 so children can shrink to fit and each column
                can have its own overflow:auto scroller. */}
            <div className="flex flex-row gap-0 flex-1 min-h-0 overflow-x-auto mobile-carousel">
              {/* Lambda (not bare map(renderColumn)) so map's index isn't passed as the
                  second renderColumn param (filterProjectId). Column order = the universal
                  section sequence from Settings. */}
              {listSequence.map((l) => renderColumn(l))}
            </div>
          </div>
        )}
        {!PIP_MODE && mode === 'projectView' && (
          // PROJECT VIEW — built from list view's renderColumn, grouping tasks by project.
          // Inherits ALL of list view's working drag mechanics 1:1 (renderBucket, SortableTaskItem,
          // getAnimationProps, the existing DragOverlay path). The only diff is the column body
          // uses renderProjectGroupedColumn (with client > project hierarchy) instead of
          // renderColumn. The Dashboard column is replaced with a Resources + Clients sidebar.
          // Layout: TopHeader is fixed (shrink-0), then a flex-1 row with each column carrying
          // its own scroll. Same fixed-header / per-column-scroll pattern as list view.
          <div className="h-full flex flex-col" style={{ paddingTop: SPACING.topMargin, paddingBottom: 76 }}>
            <div className="shrink-0">
              <TopHeader viewName="Projects" />
            </div>
            <div className="flex flex-row gap-0 flex-1 min-h-0 overflow-x-auto mobile-carousel">
            {/* Column order = the universal section sequence from Settings. */}
            {listSequence.map((l) => renderProjectGroupedColumn(l))}
            </div>
          </div>
        )}
        {/* Legacy ProjectViewMode removed — `mode === 'projectView'` now renders the new
            project view above (built off list view's drag tech). */}
        {!PIP_MODE && mode === 'calendar' && (
          <WeekCalendarMode
            tasks={calendarTasks}
            projects={projects}
            clients={clients}
            onToggleTask={toggleTask}
            onRenameTask={renameTask}
            onDeleteTask={deleteTask}
            onEditTask={openEdit}
            onQuickEditTask={openQuick}
            onAddSiblingTask={addSiblingTask}
            onAddTaskOnDay={addTaskOnDay}
            onSyncSections={syncCalendarSections}
            isAnyDragging={!!activeId}
            activeTask={activeTask}
            overTask={overTask}
            activeCellId={activeCalendarCellId}
            activeSlotHeight={(activeRectHeight ?? 50) + 4}
            taskOrder={taskOrder}
            listSequence={listSequence}
            newTaskId={newId}
          />
        )}
        {(PIP_MODE || mode === 'focus') && (() => {
          // Project Focus mode — three-column dashboard pinned to a single project.
          //   Col 1: the user's Dashboard (Today + Tomorrow), same renderer as list view.
          //   Col 2: "<Project Name> — Information", with an editable Brief block and a
          //          stub Integrations section (Dropbox + Lightroom hookup placeholders).
          //   Col 3: References — list of saved URLs scoped to this project.
          // The Information panel follows the current selection. We track two keys separately:
          //   projectKey: the project id WHEN the selection has a project
          //   taskKey:    the selected task id WHEN something is selected
          // Briefs / Notes / Images are stored under whichever key applies, so a project's brief
          // is shared across every task in the project, while task-level notes + images stay
          // pinned to that one task. With NO selection at all, both keys are null and the
          // Information / References columns render a quiet "select a task" empty state — no
          // dummy fallback project.
          const selectedTask = selectedTaskId ? tasks.find((t) => t.id === selectedTaskId) : null;
          const taskProject = selectedTask?.projectId ? projects.find((p) => p.id === selectedTask.projectId) : null;
          const taskProjectClient = taskProject?.clientId ? clients.find((c) => c.id === taskProject.clientId) : undefined;
          let projectKey: string | null = null;
          let taskKey: string | null = null;
          if (taskProject) {
            projectKey = taskProject.id;
            taskKey = selectedTask!.id;
          } else if (selectedTask) {
            taskKey = selectedTask.id;
          }
          // Reusable JSX node for the "<Client> ⌧ <Project>" breadcrumb. Used in the column
          // title AND the Brief sub-header so the labels stay in lockstep.
          const projectBreadcrumb = taskProject ? (
            <>
              {taskProjectClient && taskProjectClient.short && <>{taskProjectClient.short}<Arrowhead /></>}
              {taskProject.name || 'Untitled'}
            </>
          ) : null;
          // activeProjectId: the key used by the existing subtask + integration sections, which
          // are scoped to either project or (if no project) the task. Null when nothing is
          // selected — the dependent sections only render when this is non-null.
          const activeProjectId: string | null = projectKey || taskKey || null;
          const projectBriefValue = projectKey ? (focusBriefs[projectKey] ?? '') : '';
          const taskNotesValue = taskKey ? (focusBriefs[taskKey] ?? '') : '';
          // References: hardcoded URL list (link references), plus the dropped + processed images
          // from both the project and task drop zones (merged for display).
          const refs = projectKey ? focusReferences[projectKey] || [] : (taskKey ? focusReferences[taskKey] || [] : []);
          // WIP gets its own bucket key so images dropped into the WIP zone don't co-mingle
          // with the shared project pool. The key is just a deterministic string derived from
          // projectKey — the storage layer doesn't care, it's a flat Record<string, …>.
          const wipKey: string | null = projectKey ? `wip:${projectKey}` : null;
          const wipImgs = wipKey ? focusImages[wipKey] || [] : [];
          const projectImgs = projectKey ? focusImages[projectKey] || [] : [];
          const taskImgs = taskKey ? focusImages[taskKey] || [] : [];
          // Display order in the gallery: WIP → Project → Task. Same order as the drop zones.
          const allImages = [...wipImgs, ...projectImgs, ...taskImgs];
          // Folder definitions per bucket — pulled here so we can pass them into the
          // sectioned gallery. Bucket key matches focusImages key (wipKey, projectKey, taskKey).
          const wipFolders = wipKey ? focusImageFolders[wipKey] || [] : [];
          const projectFolders = projectKey ? focusImageFolders[projectKey] || [] : [];
          const taskFolders = taskKey ? focusImageFolders[taskKey] || [] : [];
          const taskTitleForNotes = (selectedTask?.title || 'Task').trim() || 'Task';
          // Content-sized side columns: each is exactly its longest entry + a 30px buffer
          // (user spec), so nothing crams and the three day columns absorb the remainder.
          // Measured from the UNFILTERED sets so widths stay stable while filtering.
          // Milestone rows = title + gap(8) + arrow(18) + gap(8) + date; clients = name only.
          const clientEntryWidths = proj2SortedClients.map((c) => measureTextPx(c.name || (c.id === PERSONAL_CLIENT_ID ? 'Personal' : c.short) || ''));
          const col1W = Math.min(460, Math.max(170, Math.round(31 + Math.max(measureTextPx('Clients + Projects') + 8, ...clientEntryWidths, 60) + 30)));
          const msWidths = visibleTasks.filter((t) => t.type === 'scheduled').map((t) => measureTextPx(t.title) + (t.deadline ? 8 + 18 + 8 + measureTextPx(formatDeadline(t.deadline)) : 0));
          const col2W = Math.min(460, Math.max(170, Math.round(31 + Math.max(measureTextPx('Milestones') + 22, ...msWidths, 60) + 30)));
          // SYMMETRIC side columns — asymmetry read as "off". Both take the wider of the two
          // (in practice the longest milestone + its date), so one may carry a little extra
          // white space but the pair stays visually balanced.
          const sideW = Math.max(col1W, col2W);
          return (
            // Focus mode: fixed TopHeader, fixed column titles, each column body scrolls
            // independently. Same pattern as List / Project / Calendar.
            <div className="h-full flex flex-col" style={{ paddingTop: PIP_MODE ? 14 : SPACING.topMargin, paddingBottom: PIP_MODE ? 12 : 76 }}>
              <div className="shrink-0">
                <TopHeader viewName="Focus" />
              </div>
              {/* PIP close — × top-right hides the always-on-top quick window (the Tauri shell
                  also hides it on blur, i.e. clicking anywhere outside). Browser fallback: no-op. */}
              {PIP_MODE && (
                <button
                  type="button"
                  onClick={() => {
                    const w = (window as unknown as { __TAURI__?: { window?: { getCurrentWindow?: () => { hide: () => void } } } }).__TAURI__;
                    if (w?.window?.getCurrentWindow) w.window.getCurrentWindow().hide();
                  }}
                  className="fixed top-2 right-2 z-50 p-2 text-[#656464] hover:text-white transition-colors"
                  aria-label="Close quick window"
                >
                  <X size={16} />
                </button>
              )}
              {/* SIX-COLUMN GRID: col 1 = projects-as-filters, cols 2–3 = the Dashboard
                  stack at double width (the 2fr track — no col-span wrapper needed),
                  cols 4–6 = the calendar unpacked into Today / Tomorrow / Next columns.
                  overflow-x-auto lets narrow windows scroll instead of crushing columns
                  (each child carries its own min-width). NOTE for un-parking
                  FOCUS_SHOW_INFO / FOCUS_SHOW_REFERENCES: the track template is fixed at
                  five tracks — re-enabling those columns means widening the template. */}
              {/* Filter + Milestones are fixed-narrow (same width, sized to fit their names + a
                  small buffer) instead of stretchy 1fr tracks; the three day columns split the
                  freed space, so the calendar gets wider. */}
              {/* PIP: ONLY the three day columns — no filter panel, no Milestones column.
                  Full mode: cols 1–2 are content-sized (longest entry + 30px), days split the rest. */}
              <div className="grid gap-0 flex-1 min-h-0 w-full overflow-x-auto" style={{ gridTemplateColumns: PIP_MODE ? '1fr 1fr 1fr' : `${sideW}px ${sideW}px 1fr 1fr 1fr` }}>
                {/* Column 1 — Projects panel: flat master list (milestones pinned on top);
                    clicking a project FILTERS the Dashboard stack + all three calendar
                    columns (focusProjectId). Active row shows an ×; click again to clear.
                    Information + References are parked behind FOCUS_SHOW_INFO /
                    FOCUS_SHOW_REFERENCES while ctrl-assets takes over reference handling. */}
                {!PIP_MODE && (() => {
                  // Left panel: top-pinned milestones + a COLLAPSED project filter. Client
                  // headers collapse their projects so the user scans the big picture and
                  // expands on demand. Clicking a project FILTERS (not navigates) — the
                  // center Dashboard stack and the three calendar columns narrow to it.
                  // The active project highlights + shows an ×; click again to clear.
                  // (Milestones now live in their own dedicated column — see below.)
                  // Project nesting: a project with a parentId renders indented under its
                  // parent (accordion), and NOT in its own client group. `childrenOf` maps a
                  // parent id → its sub-projects; `isTopLevel` = no parent (or orphaned parent).
                  const projById = new Map(projects.map((p) => [p.id, p]));
                  const childrenOf = new Map<string, Project[]>();
                  for (const p of projects) {
                    if (p.parentId && projById.has(p.parentId)) {
                      const arr = childrenOf.get(p.parentId) || [];
                      arr.push(p); childrenOf.set(p.parentId, arr);
                    }
                  }
                  const isTopLevel = (p: Project) => !p.parentId || !projById.has(p.parentId);
                  const clientlessTop = projects.filter((pp) => (!pp.clientId || !clients.some((c) => c.id === pp.clientId)) && isTopLevel(pp));
                  // Recursive node: the row + (if expanded) its sub-projects one level deeper.
                  // Only the top-level row shows the client short (nested rows are clearly
                  // under a parent already).
                  const renderNode = (p: Project, client: Client | undefined, depth: number): React.ReactNode => {
                    const kids = childrenOf.get(p.id) || [];
                    const expanded = focusExpandedProjects.has(p.id);
                    return (
                      <Fragment key={p.id}>
                        <FocusProjectRow
                          project={p}
                          client={client}
                          depth={depth}
                          count={visibleTasks.filter((t) => t.projectId === p.id).length}
                          active={focusProjectId === p.id}
                          expandable={kids.length > 0}
                          expanded={expanded}
                          onClick={() => { setFocusClientId(null); setFocusMilestoneId(null); setFocusProjectId(focusProjectId === p.id ? null : p.id); }}
                          onToggleExpand={() => setFocusExpandedProjects((prev) => { const n = new Set(prev); n.has(p.id) ? n.delete(p.id) : n.add(p.id); return n; })}
                        />
                        {expanded && kids.map((k) => renderNode(k, undefined, depth + 1))}
                      </Fragment>
                    );
                  };
                  return (
                    <div className="flex-1 min-w-0 flex flex-col min-h-0 overflow-hidden">
                      {/* Header doubles as the un-nest drop zone AND a click-to-clear-filter
                          target (clicking above the lists clears the active filter). */}
                      <ProjectsHeaderDropZone onClearFilter={(focusClientId || focusProjectId || focusMilestoneId) ? () => { setFocusClientId(null); setFocusProjectId(null); setFocusMilestoneId(null); } : undefined} />
                      {/* Search — the FIRST content row (aligned with the first milestone and the
                          day columns' Work band). A yellow magnifier + a chrome-less input that
                          live-filters the day columns and the Milestone / Goals column as you type.
                          The X shows ONLY when there's search text, and clears just the search. */}
                      <div className="shrink-0 h-[37px] w-full box-border flex flex-row gap-2 items-center px-[31px]">
                        <Search size={12} className="shrink-0 text-[#656464]" />
                        <input
                          value={focusSearch}
                          onChange={(e) => setFocusSearch(e.target.value)}
                          placeholder="Search"
                          className="focus-search-input flex-1 min-w-0 bg-transparent border-0 outline-none text-white text-[14px]"
                        />
                        {focusSearch && (
                          <button type="button" onClick={() => setFocusSearch('')} className="shrink-0 text-[#a8a8a8] hover:text-white transition-colors" aria-label="Clear search">
                            <X size={13} />
                          </button>
                        )}
                      </div>
                      {/* Full carriage-return gap between Search and the client list (Personal first). */}
                      <div className="shrink-0 h-[37px]" aria-hidden />
                      <CustomScroll>
                        {/* CLIENTS ONLY — the filter is a flat roster of every client. Muted list-
                            gray by default; the SELECTED one goes white (no purple anywhere). Click a
                            client to filter the dashboard to its tasks; click again (or the X) to clear. */}
                        {proj2SortedClients.map((c) => {
                          const clientActive = focusClientId === c.id && !focusProjectId;
                          return (
                            <button
                              key={c.id}
                              type="button"
                              onClick={() => { setFocusProjectId(null); setFocusMilestoneId(null); setFocusClientId(focusClientId === c.id ? null : c.id); }}
                              className={`group h-[37px] w-full text-left box-border flex flex-row gap-2 items-center px-[31px] transition-colors ${clientActive ? '' : 'hover:bg-white/[0.03]'}`}
                            >
                              <span className={`font-['Univers_BQ:55_Regular',sans-serif] text-[14px] whitespace-nowrap overflow-hidden text-ellipsis ${clientActive ? 'text-white' : 'text-[#656464]'}`}>
                                {c.name || (c.id === PERSONAL_CLIENT_ID ? 'Personal' : c.short)}
                              </span>
                              {clientActive && <X size={14} className="ml-auto text-[#a8a8a8]" />}
                            </button>
                          );
                        })}
                      </CustomScroll>
                    </div>
                  );
                })()}
                {/* Column 2 — MILESTONES, in their own narrow column (same 1fr width as the filter).
                    Grouped by effective list then deadline, like everything else. Rendered
                    title-only (no client / project meta) — just the milestone name + its date. */}
                {!PIP_MODE && (() => {
                  const clientOfMs = (t: Task) => t.clientId ?? (t.projectId ? projects.find((p) => p.id === t.projectId)?.clientId : undefined);
                  const msRank = (t: Task) => { const idx = listSequence.indexOf(effectiveListFor(t)); return idx < 0 ? 99 : idx; };
                  const milestones = visibleTasks
                    .filter((t) => t.type === 'scheduled' && taskMatchesQuery(t, focusSearch, projects, clients) && passesMilestoneFilter(t) && (focusProjectId ? t.projectId === focusProjectId : focusClientId ? clientOfMs(t) === focusClientId : true))
                    .sort((a, b) => {
                      if (msRank(a) !== msRank(b)) return msRank(a) - msRank(b);
                      const ad = a.deadline || '￿'; const bd = b.deadline || '￿';
                      if (ad !== bd) return ad < bd ? -1 : 1;
                      return a.title.localeCompare(b.title);
                    });
                  return (
                    <div className="flex-1 min-w-0 flex flex-col min-h-0 overflow-hidden">
                      <div className="group shrink-0 h-[37px] flex items-center gap-2 px-[31px]" style={{ marginBottom: SPACING.dcr }}>
                        <p className="font-['NB_International:Regular',sans-serif] leading-[normal] not-italic text-[14.333px] text-white">Milestones</p>
                        {/* + creates a new milestone (a scheduled task dated today) and opens the
                            editor so you can set its title + date. Inherits the active filter. */}
                        <button
                          type="button"
                          onClick={() => {
                            const id = `task-${Date.now()}`;
                            const ms: Task = { id, title: '', type: 'scheduled', assignees: currentUserShort ? [currentUserShort] : [], completed: false, list: 'work', section: 'today', deadline: todayISO(), order: 0, createdAt: Date.now(), ...(focusProjectId ? { projectId: focusProjectId } : focusClientId ? { clientId: focusClientId } : {}) };
                            setTasks((prev) => [...prev, ms]);
                            setNewId(id);
                            openEdit(ms);
                          }}
                          className="opacity-0 group-hover:opacity-100 text-[#656464] hover:text-white transition-opacity"
                          aria-label="Add milestone"
                        >
                          <Plus size={14} />
                        </button>
                      </div>
                      <CustomScroll>
                        {renderReadonlyBucket(milestones, undefined, true, milestoneClickTo, focusMilestoneId)}
                      </CustomScroll>
                    </div>
                  );
                })()}
                {/* Columns 3–5 — the calendar as THREE wide (2fr) side-by-side day columns:
                    Today, Tomorrow, and Next. Same engine as the calendar view (focusStripCells ←
                    computeCalendarDistribution), same band structure (Work / Admin / Projects),
                    same CalendarCards. The left-panel client filter narrows all three columns. */}
                {(() => {
                  const stripAnchor = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; })();
                  // One band block (label + cards) per CAL_LIST, aggregated over the
                  // column's iso set. Mirrors WeekCalendarMode's per-day band rendering.
                  const dayBands = (isos: string[], colKey: string, section: SectionId) => listSequence.map((listId) => {
                    const bandLabel = LIST_TITLES[listId];
                    const isoSet = new Set(isos);
                    // Filter helper — project narrows to one, else client narrows to all its tasks.
                    const clientOfT = (t: Task) => t.clientId ?? (t.projectId ? projects.find((p) => p.id === t.projectId)?.clientId : undefined);
                    const passesFilter = (t: Task) => taskMatchesQuery(t, focusSearch, projects, clients) && passesMilestoneFilter(t) && (focusProjectId ? t.projectId === focusProjectId : focusClientId ? clientOfT(t) === focusClientId : true);
                    const bucketAll = isos.flatMap((iso) => focusStripCells[`${iso}:${listId}`] || []);
                    const bucket = bucketAll.filter(passesFilter);
                    // Milestones dated inside this column's window, band-matched by
                    // effective list (project's pinned list wins over the task's own) —
                    // same rule as WeekCalendarMode's dayMilestones, over the same
                    // calendarTasks set the calendar itself receives.
                    const bandMilestones = calendarTasks.filter((t) => {
                      if (t.type !== 'scheduled' || !t.deadline || !isoSet.has(t.deadline)) return false;
                      if (!passesFilter(t)) return false;
                      if (t.projectId) {
                        const proj = projects.find((p) => p.id === t.projectId);
                        if (proj?.list) return proj.list === listId;
                      }
                      return t.list === listId;
                    }).sort((a, b) => (a.deadline! < b.deadline! ? -1 : a.deadline! > b.deadline! ? 1 : a.title.localeCompare(b.title)));
                    const cellId = `cal:${isos[0]}:${listId}`;
                    const cellTasks = [...bandMilestones, ...bucket];
                    // Drag-displace (same engine as the calendar view): the SOURCE band leans on
                    // dnd-kit's native sortable shift; a DESTINATION band opens an insertion gap
                    // above the card being dragged over so the landing spot is visible. Only the
                    // drag's own category reacts.
                    const dAIdx = activeTask ? cellTasks.findIndex((t) => t.id === activeTask.id) : -1;
                    const dOIdx = overTask ? cellTasks.findIndex((t) => t.id === overTask.id) : -1;
                    const dActiveInBucket = dAIdx >= 0;
                    const dOverInBucket = dOIdx >= 0;
                    const dSameCategory = !!activeTask && activeTask.list === listId;
                    const dSlotH = (activeRectHeight ?? 40) + 4;
                    // Every band renders now (even empty) so a task can be created in ANY
                    // category on ANY day — the label carries a hover-reveal +. Empty bands
                    // are just the quiet grey label until you hover.
                    return (
                      <div key={`${colKey}-${listId}`} className={cellTasks.length > 0 ? 'pb-[24px] last:pb-0' : 'pb-[12px] last:pb-0'}>
                        {/* Band label — same treatment as the calendar's in-column
                            category labels (grey, 20px row, 16px inset) + hover +. */}
                        <div className="group/band h-[20px] px-[16px] pb-[6px] flex items-center gap-2 sticky top-0 z-10 bg-[#282828]">
                          <p onClick={scrollBandToTop} className="font-['Univers_BQ:55_Regular',sans-serif] leading-[normal] not-italic text-[14px] whitespace-nowrap text-[#5e5e5e] cursor-pointer">{bandLabel}</p>
                          <button
                            type="button"
                            onClick={() => addBlankTaskInSection(listId, section, focusProjectId ? { projectId: focusProjectId } : focusClientId ? { clientId: focusClientId } : undefined)}
                            className="opacity-0 group-hover/band:opacity-100 text-[#656464] hover:text-white transition-opacity"
                            aria-label={`Add ${bandLabel} task`}
                          >
                            <Plus size={14} />
                          </button>
                        </div>
                        {/* Wrap the cards in the SAME droppable cell the calendar view uses, so a
                            drop anywhere in the band (including an empty one) registers as this
                            cal:<day>:<list> target — without it, focus-mode drops fell through and
                            snapped back to Next. min-h keeps empty bands droppable. */}
                        <CalendarDayDroppable id={cellId} isEmpty={cellTasks.length === 0}>
                          <SortableContext items={cellTasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
                            {cellTasks.map((t, index) => {
                              let insertionGap = 0;
                              if (dSameCategory && activeTask && overTask && t.id !== activeTask.id && !dActiveInBucket && dOverInBucket && index === dOIdx) {
                                insertionGap = dSlotH;
                              }
                              return (
                              <CalendarCard
                                key={t.id}
                                task={t}
                                cellId={cellId}
                                onToggle={() => toggleTask(t.id)}
                                onRename={(title) => renameTask(t.id, title)}
                                onDelete={() => deleteTask(t.id)}
                                onEdit={() => openEdit(t)}
                                onQuickEdit={() => openQuick(t)}
                                onAddSibling={() => addSiblingTask(t, section === 'next' ? undefined : isos[0])}
                                isAnyDragging={!!activeTask}
                                categoryDimmed={!!activeTask && activeTask.list !== listId}
                                projects={projects}
                                clients={clients}
                                displacementOffset={0}
                                insertionGap={insertionGap}
                                taskOrder={taskOrder}
                                autoFocusEdit={t.id === newId}
                                stacked
                              />
                              );
                            })}
                          </SortableContext>
                        </CalendarDayDroppable>
                      </div>
                    );
                  });
                  const d0 = stripAnchor;
                  const d1 = addDaysToDate(stripAnchor, 1);
                  const nextIsos = [2, 3, 4, 5, 6, 7, 8].map((off) => dateToISO(addDaysToDate(stripAnchor, off)));
                  // Day headers replicate the calendar view's: NB-font weekday + Univers
                  // date number, purple for today with the "(Today)" suffix.
                  const dayHeader = (d: Date, isToday: boolean) => (
                    <div className={`shrink-0 h-[37px] flex items-center gap-2 px-[16px] ${isToday ? 'text-[#8465ff]' : 'text-white'}`} style={{ marginBottom: SPACING.dcr }}>
                      <p className="font-['NB_International:Regular',sans-serif]">{d.toLocaleDateString('en-US', { weekday: 'short' })}</p>
                      <p className="font-['Univers_BQ:55_Regular',sans-serif] leading-[normal] not-italic text-[14px] whitespace-nowrap">{d.getDate()}</p>
                      {isToday && <p className="font-['NB_International:Regular',sans-serif]">(Today)</p>}
                    </div>
                  );
                  const cols: Array<{ key: string; header: React.ReactNode; isos: string[]; section: SectionId }> = [
                    { key: 'fc-today', header: dayHeader(d0, true), isos: [dateToISO(d0)], section: 'today' },
                    { key: 'fc-tomorrow', header: dayHeader(d1, false), isos: [dateToISO(d1)], section: 'tomorrow' },
                    {
                      key: 'fc-next',
                      header: (
                        <div className="shrink-0 h-[37px] flex items-center gap-2 px-[16px] text-white" style={{ marginBottom: SPACING.dcr }}>
                          <p className="font-['NB_International:Regular',sans-serif]">Next</p>
                        </div>
                      ),
                      isos: nextIsos,
                      section: 'next',
                    },
                  ];
                  // "Coming Up" — upcoming milestones dated BEYOND the Next column's window,
                  // pinned read-only at the top of the Next column. Mirrors the calendar view's
                  // Next-Week look-ahead so a dated milestone a week or two out (e.g. a birthday)
                  // still gets featured on the focus page. Respects the active filter + search.
                  const focusLastVisibleIso = nextIsos[nextIsos.length - 1];
                  const cuClientOf = (t: Task) => t.clientId ?? (t.projectId ? projects.find((p) => p.id === t.projectId)?.clientId : undefined);
                  const cuPasses = (t: Task) => passesMilestoneFilter(t) && (focusProjectId ? t.projectId === focusProjectId : focusClientId ? cuClientOf(t) === focusClientId : true);
                  const comingUpMilestones = calendarTasks
                    .filter((t) => t.type === 'scheduled' && !!t.deadline && t.deadline > focusLastVisibleIso && cuPasses(t) && taskMatchesQuery(t, focusSearch, projects, clients))
                    .sort((a, b) => (a.deadline! < b.deadline! ? -1 : a.deadline! > b.deadline! ? 1 : a.title.localeCompare(b.title)));
                  return cols.map((col) => (
                    <div key={col.key} className="min-w-[240px] flex flex-col min-h-0 overflow-hidden">
                      {col.header}
                      <CustomScroll>
                        {/* Next column only: upcoming milestones beyond the window, featured up top. */}
                        {col.section === 'next' && comingUpMilestones.length > 0 && (
                          <div className="mb-[24px]">
                            <div className="h-[20px] px-[16px] flex items-center mb-[6px]">
                              <p className="font-['Univers_BQ:55_Regular',sans-serif] leading-[normal] not-italic text-[14px] whitespace-nowrap text-[#5e5e5e]">Coming Up</p>
                            </div>
                            {/* Same purple-tint two-line card the calendar's Coming Up uses.
                                Click → filter to its project (or name-search when projectless). */}
                            {comingUpMilestones.map((t) => (
                              <MilestoneCardView
                                key={t.id}
                                task={t}
                                projects={projects}
                                clients={clients}
                                showDate
                                onEdit={() => openEdit(t)}
                                onQuickEdit={() => openQuick(t)}
                                onAddSibling={() => addSiblingTask(t)}
                                onClick={() => milestoneClickTo(t)}
                                active={focusMilestoneId === t.id}
                              />
                            ))}
                          </div>
                        )}
                        {dayBands(col.isos, col.key, col.section)}
                      </CustomScroll>
                    </div>
                  ));
                })()}
                {/* Column 2 — Project / Task Information (Brief + Integrations).
                    Title sits in the same row as the Dashboard column header so the three
                    columns share a single top-aligned header line. The header reads
                    "<Client> ⌧ <Project> — Information" when a project is in play, or
                    "<Task Title> — Information" for an unprojected task. */}
                {FOCUS_SHOW_INFO && (
                <div className="flex-1 min-w-[280px] flex flex-col min-h-0 overflow-hidden">
                  <div className="shrink-0 group h-[37px] w-full box-border flex flex-row gap-2 items-center px-[35px]" style={{ marginBottom: SPACING.dcr }}>
                    <p className="font-['NB_International:Regular',sans-serif] leading-[normal] not-italic text-[14.333px] text-white">
                      {projectBreadcrumb ? <>{projectBreadcrumb} — Information</>
                        : selectedTask ? <>{(selectedTask.title || 'Untitled Task').trim() || 'Untitled Task'} — Information</>
                        : 'Information'}
                    </p>
                  </div>
                  {/* When nothing's selected (no project / no task), the entire
                      scroll body is replaced by a single full-fill rectangle:
                      bg = the row hover-tint (rgba(255,255,255,0.03)), so it
                      reads as a soft "drop a task here" surface; centered text
                      "Select a Task" in the page background color (#282828) so
                      it's a quiet emboss rather than a foreground label. The
                      rectangle takes the full remaining flex space below the
                      column title — no gap, no extra padding chrome — so the
                      empty state feels like the column itself is paused. */}
                  {!activeProjectId && (
                    <div className="flex-1 mx-[31px] mb-[8px] bg-white/[0.03] flex items-center justify-center">
                      <span className="text-[#656464] text-[18px] font-bold">Select a Task</span>
                    </div>
                  )}
                  {activeProjectId && (
                  <CustomScroll>
                  {/* Brief / Notes section. Three cases:
                        - Selection has a project → "Project Brief" (shared across the project)
                          PLUS "<Task Title> — Notes" (task-specific) underneath
                        - Selection has no project → just "Notes" (task-specific)
                        - No selection (fallback project) → "Project Brief" only
                      Both fields share focusBriefs storage; the key is what differs (project id
                      vs task id), so each scope has its own persistent text. */}
                  {projectKey && (
                    <>
                      <div className="group h-[37px] w-full box-border flex flex-row gap-2 items-center px-[31px]">
                        <p className="font-['Univers_BQ:55_Regular',sans-serif] leading-[normal] not-italic text-[#656464] text-[14px] whitespace-nowrap">
                          {projectBreadcrumb ? <>Project: {projectBreadcrumb} — Brief</> : 'Project: Brief'}
                        </p>
                      </div>
                      <div className="px-[31px] pb-[37px]">
                        <BriefField
                          value={projectBriefValue}
                          onChange={(v) => setFocusBriefs((prev) => ({ ...prev, [projectKey]: v }))}
                          placeholder="Write the project brief…"
                        />
                      </div>
                    </>
                  )}
                  {taskKey && (
                    <>
                      <div className="group h-[37px] w-full box-border flex flex-row gap-2 items-center px-[31px]">
                        <p className="font-['Univers_BQ:55_Regular',sans-serif] leading-[normal] not-italic text-[#656464] text-[14px] whitespace-nowrap">
                          Task: {taskTitleForNotes} — Notes
                        </p>
                      </div>
                      <div className="px-[31px] pb-[37px]">
                        <BriefField
                          value={taskNotesValue}
                          onChange={(v) => setFocusBriefs((prev) => ({ ...prev, [taskKey]: v }))}
                          placeholder={`Notes for ${taskTitleForNotes}…`}
                        />
                      </div>
                    </>
                  )}
                  {/* Sub-Tasks — only renders when there's at least one sub-task on the current
                      project / task. The first one is added from the inline "+ Sub-Task" button
                      that always sits at the bottom of column 2 (see below) so an empty state
                      doesn't carve out vertical real estate in the Information panel. */}
                  {activeProjectId && (focusSubtasks[activeProjectId] || []).length > 0 && (
                    <>
                      <div className="group h-[37px] w-full box-border flex flex-row gap-2 items-center px-[31px]">
                        <p className="font-['Univers_BQ:55_Regular',sans-serif] leading-[normal] not-italic text-[#656464] text-[14px] whitespace-nowrap">Sub-Tasks</p>
                        <AddPlus onClick={() => addFocusSubtask(activeProjectId)} />
                      </div>
                      <div className="pb-[37px]">
                        <SortableContext
                          items={(focusSubtasks[activeProjectId] || []).map((s) => `subtask:${activeProjectId}:${s.id}`)}
                          strategy={verticalListSortingStrategy}
                        >
                          {(focusSubtasks[activeProjectId] || []).map((sub) => (
                            <SortableSubtaskRow
                              key={sub.id}
                              sub={sub}
                              storageKey={activeProjectId}
                              isAnyDragging={!!activeId}
                              newId={focusNewSubtaskId}
                              onToggle={() => toggleFocusSubtask(activeProjectId, sub.id)}
                              onRename={(v) => renameFocusSubtask(activeProjectId, sub.id, v)}
                              onDiscardIfEmpty={() => deleteFocusSubtask(activeProjectId, sub.id)}
                              onAddAfter={() => addFocusSubtask(activeProjectId, sub.id)}
                              onDelete={() => deleteFocusSubtask(activeProjectId, sub.id)}
                            />
                          ))}
                        </SortableContext>
                      </div>
                    </>
                  )}
                  {/* Inline "+ Sub-Task" entry-point — visible whenever a project / task is in
                      play, so the user can spawn the first sub-task without an empty Sub-Tasks
                      header taking up space until then. */}
                  {activeProjectId && (focusSubtasks[activeProjectId] || []).length === 0 && (
                    <button
                      type="button"
                      onClick={() => addFocusSubtask(activeProjectId)}
                      className="px-[31px] pb-[37px] flex flex-row items-center gap-2 text-[14px] text-[#656464] hover:text-white transition-colors"
                    >
                      <Plus size={14} />
                      <span>Sub-Task</span>
                    </button>
                  )}
                  {/* (Reference drop zones live in the References column now —
                      directly under that column's header, where the resulting
                      gallery grid sits, so the action and the result share the
                      same visual surface.) */}
                  {/* Integrations — placeholder row of hookup buttons. Hidden when no selection
                      so an empty Information panel doesn't look like dummy scaffolding. */}
                  {activeProjectId && (
                    <>
                      <div className="group h-[37px] w-full box-border flex flex-row gap-2 items-center px-[31px]">
                        <p className="font-['Univers_BQ:55_Regular',sans-serif] leading-[normal] not-italic text-[#656464] text-[14px] whitespace-nowrap">Integrations</p>
                      </div>
                      <div className="px-[31px] flex flex-col gap-2">
                        <button
                          type="button"
                          onClick={() => console.log('connect dropbox', activeProjectId)}
                          className="flex flex-row items-center justify-between bg-white/[0.03] hover:bg-white/[0.06] px-3 py-2 text-[14px] text-[#656464] hover:text-white text-left transition-colors"
                        >
                          <span>Dropbox</span>
                          <span className="text-[#656464] text-[12px]">Connect</span>
                        </button>
                      </div>
                    </>
                  )}
                  </CustomScroll>
                  )}
                </div>
                )}
                {/* Column 3 — References. Twice the width of the Dashboard / Information
                    columns (flex-[2]) since reference cards are a richer visual surface and
                    benefit from the extra horizontal real estate. Two drop zones (project,
                    task) accept image files, scale them to 1920px max + WebP-compress, then
                    feed a scrollable DAM grid below with view-mode toggles.
                    Layout (flex column):
                      - Title row (shrink-0)
                      - URL references list (shrink-0)
                      - View-mode toggles (shrink-0)
                      - Gallery slot (flex-1 min-h-0) — for Zoom All it renders the gallery
                        DIRECTLY (gallery uses h-full and ResizeObserver to fit exactly,
                        no scrollbar); for Small / Medium / Large it wraps the gallery in
                        a CustomScroll so the rows can overflow and scroll. */}
                {FOCUS_SHOW_REFERENCES && (
                <div
                  className="flex-[2] min-w-[280px] flex flex-col min-h-0 overflow-hidden relative"
                  // External-file drag tracking. We keep a counter ref because moving
                  // between child elements fires dragLeave-then-dragEnter rapidly,
                  // causing flicker if you naively toggle a boolean. Counter only
                  // hits zero when the cursor truly leaves the column. preventDefault
                  // on dragOver is required for the drop event to fire later.
                  onDragEnter={(e) => {
                    if (!e.dataTransfer.types.includes('Files')) return;
                    e.preventDefault();
                    refsDragCounter.current += 1;
                    if (!refsDragActive) setRefsDragActive(true);
                  }}
                  onDragOver={(e) => {
                    if (!e.dataTransfer.types.includes('Files')) return;
                    e.preventDefault();
                  }}
                  onDragLeave={() => {
                    refsDragCounter.current = Math.max(0, refsDragCounter.current - 1);
                    if (refsDragCounter.current === 0) setRefsDragActive(false);
                  }}
                  onDrop={() => {
                    // The inner FocusDropZone handles the actual file ingestion.
                    // We just reset the overlay flag here in case the drop missed
                    // a zone (e.g. user released over the gallery area itself).
                    refsDragCounter.current = 0;
                    setRefsDragActive(false);
                  }}
                >
                  <div className="shrink-0 group h-[37px] w-full box-border flex flex-row gap-2 items-center px-[35px]" style={{ marginBottom: SPACING.dcr }}>
                    <p className="font-['NB_International:Regular',sans-serif] leading-[normal] not-italic text-[14.333px] text-white">References</p>
                  </div>
                  {/* (Drop zones live INSIDE the empty state below — see the
                      gallery slot. When there are images, the gallery itself is
                      the surface; when there are no images, the empty state
                      shows the No Images Yet label with the three drop zones
                      laid out side by side beneath it.) */}
                  {/* Existing URL references (link list) */}
                  {refs.length > 0 && (
                    <div className="shrink-0 px-[31px] flex flex-col gap-2 pb-[37px]">
                      {refs.map((r, i) => (
                        <a
                          key={`${r.url}-${i}`}
                          href={r.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex flex-row items-center justify-between bg-[#1f1f1f] hover:bg-[#262626] rounded-md px-3 py-2 text-[14px] text-white transition-colors"
                        >
                          <span className="truncate">{r.label}</span>
                          <span className="text-[#656464] text-[12px] shrink-0 ml-2">Open</span>
                        </a>
                      ))}
                    </div>
                  )}
                  {/* View-mode toggles + "Add Image +" / "Add Folder +" affordances,
                      all on one row. "Zoom All" stays a wordmark since it's a mode
                      rather than a size; size knobs collapse to one-letter glyphs
                      (S / M / L). Active = white text, no background pill —
                      contrast alone signals selection. Inactive = grey, brightens
                      to white on hover. The two add buttons sit at the far right
                      (ml-auto on the first one), with Add Image opening the OS
                      file picker and Add Folder appending an empty folder to the
                      project bucket (or task bucket if no project) and putting it
                      straight into rename mode. */}
                  <div className="shrink-0 px-[31px]">
                    {/* Toggles + actions row. Each button gets px-2 py-1 so the
                        hotspot is roughly twice the glyph's footprint — easier
                        to land a click on the single-letter S / M / L glyphs.
                        gap-3 between toggles gives more visual buffer than the
                        old gap-4 + skinny buttons did. The ml-2 step before the
                        heart filter (and the ml-auto on Add Image) groups the
                        toolbar into "view modes | favorites filter | actions". */}
                    <div className="flex flex-row gap-3 mb-3 text-[12px] flex-wrap items-center">
                      {([
                        ['zoom', 'Zoom All'],
                        ['sm', 'S'],
                        ['md', 'M'],
                        ['lg', 'L'],
                      ] as const).map(([key, label]) => (
                        <button
                          key={key}
                          type="button"
                          onClick={() => setFocusDamTileHeight(key)}
                          className={`px-2 py-1 transition-colors ${focusDamTileHeight === key ? 'text-white' : 'text-[#656464] hover:text-white'}`}
                        >
                          {label}
                        </button>
                      ))}
                      {(projectKey || taskKey) && (
                        <button
                          type="button"
                          onClick={() => setFavoritesFilterActive((v) => !v)}
                          // Heart filter — toggles the gallery to favorites-only.
                          // Active state matches the heart-on-tile color (#FF7171,
                          // filled); inactive is the same muted grey as the view
                          // toggles. Sits before Add Image so the toolbar reads
                          // "view modes | filter | actions" left-to-right.
                          className={`ml-auto px-2 py-1 transition-colors ${favoritesFilterActive ? 'text-[#FF7171]' : 'text-[#656464] hover:text-white'}`}
                          aria-label={favoritesFilterActive ? 'Show all images' : 'Show favorites only'}
                          aria-pressed={favoritesFilterActive}
                        >
                          <Heart size={14} fill={favoritesFilterActive ? 'currentColor' : 'none'} />
                        </button>
                      )}
                      {(projectKey || taskKey) && (
                        <button
                          type="button"
                          onClick={() => refsAddInputRef.current?.click()}
                          className="px-2 py-1 flex flex-row items-center gap-1 text-[#656464] hover:text-white transition-colors"
                        >
                          <span>Add Image</span>
                          <Plus size={14} />
                        </button>
                      )}
                      {(projectKey || taskKey) && (
                        <button
                          type="button"
                          onClick={() => {
                            // Default destination matches Add Image: project bucket
                            // first (so the folder shows up in the Project section),
                            // falling back to the task bucket if no project is
                            // selected. The newly-created folder enters rename mode
                            // immediately so the user can type its name.
                            const target = projectKey ?? taskKey;
                            if (!target) return;
                            const id = addFocusFolder(target);
                            setEditingFolderId(id);
                          }}
                          className="px-2 py-1 flex flex-row items-center gap-1 text-[#656464] hover:text-white transition-colors"
                        >
                          <span>Add Folder</span>
                          <Plus size={14} />
                        </button>
                      )}
                      {(projectKey || taskKey) && (
                        <button
                          type="button"
                          // Always opens the import dialog — no OAuth required for
                          // public /shares/ URLs (the dialog scrapes the public
                          // share page directly). Private /libraries/ URLs still
                          // need an Adobe sign-in; the dialog tells the user to
                          // click Connect Lightroom in that case.
                          onClick={() => setLightroomImportOpen(true)}
                          className="px-2 py-1 flex flex-row items-center gap-1 text-[#656464] hover:text-white transition-colors"
                        >
                          <span>Import from Lightroom</span>
                          <Plus size={14} />
                        </button>
                      )}
                      {/* Adobe sign-in affordance, only shown when NOT yet
                          authenticated. Tucked at the end of the toolbar so
                          it doesn't get in the way once the user has signed
                          in (most users only need it for /libraries/ URLs). */}
                      {(projectKey || taskKey) && !lightroomAuthed && (
                        <button
                          type="button"
                          onClick={() => openLightroomAuth().catch((e) => console.error('[lightroom] auth start failed:', e))}
                          className="px-2 py-1 flex flex-row items-center gap-1 text-[#656464] hover:text-white transition-colors"
                          title="Connect your Adobe Lightroom account (only needed to import your own /libraries/ URLs — public /shares/ URLs work without sign-in)"
                        >
                          <span>Connect Lightroom</span>
                        </button>
                      )}
                      <input
                        ref={refsAddInputRef}
                        type="file"
                        accept="image/*"
                        multiple
                        className="hidden"
                        onChange={(e) => {
                          const files = e.target.files;
                          e.currentTarget.value = '';
                          if (!files || files.length === 0) return;
                          const target = projectKey ?? taskKey;
                          if (target) addFocusImages(target, files);
                        }}
                      />
                    </div>
                  </div>
                  {/* Gallery slot — flex column with the new sectioned layout. The
                      buckets (WIP / Project / Task) each render as their own section
                      with a header label and a dnd-kit-sortable list of folders;
                      images flow inside their assigned folder, or at the bucket
                      "root" (above any folders) when they have no folderId. The
                      whole thing scrolls inside a CustomScroll regardless of the
                      tile-view mode — the multi-section world makes the original
                      Zoom-All "fit everything in the box" math impractical, so
                      Zoom mode now just uses the largest tile size and lets the
                      content scroll like S/M/L.
                      EMPTY STATE: when no bucket has any images OR folders AND a
                      project / task is selected, render a single sheet with the
                      "No Images Yet" label stacked above the three drop zones
                      (WIP / Project / Task) side by side. */}
                  {(() => {
                    // Build the bucket array exactly once per render so both the
                    // empty-state branch and the gallery branch see the same data.
                    // Each bucket carries its key (for delete / move callbacks),
                    // its label (for the section header), the images stamped with
                    // their ownerKey, and the folders for that bucket.
                    const damBucketsAll: FocusDamBucket[] = [];
                    if (wipKey) damBucketsAll.push({ key: wipKey, label: 'WIP', images: wipImgs.map((i) => ({ ...i, ownerKey: wipKey })), folders: wipFolders });
                    if (projectKey) damBucketsAll.push({ key: projectKey, label: 'Project', images: projectImgs.map((i) => ({ ...i, ownerKey: projectKey })), folders: projectFolders });
                    if (taskKey) damBucketsAll.push({ key: taskKey, label: 'Task', images: taskImgs.map((i) => ({ ...i, ownerKey: taskKey })), folders: taskFolders });
                    // Favorites filter: when on, strip non-favorited images from each
                    // bucket. Folders + buckets stay (so they remain valid drop targets);
                    // they just render empty placeholders if all their images filter out.
                    const damBuckets: FocusDamBucket[] = favoritesFilterActive
                      ? damBucketsAll.map((b) => ({ ...b, images: b.images.filter((i) => i.favorited) }))
                      : damBucketsAll;
                    // Build the visual-order containers + flat list. Visual order
                    // matches the gallery: folders first (in bucket-folder order),
                    // then bucket-root images. flatImages is the concatenation —
                    // used for left/right arrow + scroll-wheel cycling. Containers
                    // are used for up/down arrow folder/section jumping. We mirror
                    // both into refs at the App level so the keyboard handler can
                    // navigate without recomputing on every key.
                    const damContainers: { key: string; images: FocusDamImage[] }[] = [];
                    for (const bucket of damBuckets) {
                      const folderIdSet = new Set(bucket.folders.map((f) => f.id));
                      // Mirror the gallery's "hide empty folders under the
                      // favorites filter" logic so 1-up arrow / wheel nav
                      // can't land on a container that isn't on screen.
                      const navFolders = favoritesFilterActive
                        ? bucket.folders.filter((f) => bucket.images.some((i) => i.folderId === f.id))
                        : bucket.folders;
                      for (const folder of navFolders) {
                        const folderImgs = bucket.images.filter((i) => i.folderId === folder.id);
                        damContainers.push({ key: `${bucket.key}::${folder.id}`, images: folderImgs });
                      }
                      const rootImgs = bucket.images.filter((i) => !i.folderId || !folderIdSet.has(i.folderId));
                      damContainers.push({ key: `${bucket.key}::root`, images: rootImgs });
                    }
                    const flatImages: FocusDamImage[] = damContainers.flatMap((c) => c.images);
                    damVisualFlatRef.current = flatImages;
                    damContainersRef.current = damContainers;
                    // "Completely empty" uses the UNFILTERED set — if the user has images
                    // but the favorites filter happens to hide them all, we still render
                    // the gallery (with empty rows) instead of falling back to the
                    // No-Images-Yet sheet.
                    const isCompletelyEmpty = damBucketsAll.flatMap((b) => b.images).length === 0
                      && damBucketsAll.every((b) => b.folders.length === 0);
                    // Zoom All fit-to-box: when the user picks Zoom All, binary-search
                    // the largest row height that still keeps the sectioned content
                    // inside the gallery's viewport (no scroll). Floor 40, ceil 360 —
                    // small collections grow toward L; large collections shrink toward
                    // the floor. Subtractions account for section headers (24), folder
                    // rows (30 each), the SPACING.cr top padding (37), the pb-[8px]
                    // bottom padding (8), and gaps inside / between sections.
                    let zoomRowH: number | undefined;
                    if (focusDamTileHeight === 'zoom') {
                      const W = Math.max(1, galleryContainerDims.width - 62); // px-[31px] both sides
                      // Safety buffer (-60) on top of the deterministic chrome
                      // subtractions — covers small rounding inside flex-wrap,
                      // line-height differences across browsers, and the gaps
                      // between the section's flex-col children that the per-
                      // section accounting doesn't fully model. Without it the
                      // bottom row gets clipped because the search converges to
                      // a row height ~5–10px taller than what genuinely fits.
                      const H = Math.max(1, galleryContainerDims.height - 8 - 37 - 60);
                      const rowsHeightAt = (imgs: FocusDamImage[], rowH: number): number => {
                        if (imgs.length === 0) return 0;
                        let rows = 1;
                        let rowW = 0;
                        const gap = 4;
                        for (const img of imgs) {
                          const ar = (img.width || 1) / (img.height || 1);
                          const itemW = ar * rowH;
                          if (rowW === 0) rowW = itemW;
                          else if (rowW + gap + itemW <= W) rowW += gap + itemW;
                          else { rows++; rowW = itemW; }
                        }
                        return rows * rowH + (rows - 1) * gap;
                      };
                      const groupHeightAt = (imgs: FocusDamImage[], rowH: number): number => {
                        if (imgs.length === 0) return 0;
                        const favs = imgs.filter((i) => i.favorited);
                        const rest = imgs.filter((i) => !i.favorited);
                        let h = 0;
                        if (favs.length > 0) h += rowsHeightAt(favs, rowH);
                        if (rest.length > 0) {
                          if (h > 0) h += 4; // gap-1 between fav-row and rest-row
                          h += rowsHeightAt(rest, rowH);
                        }
                        return h;
                      };
                      const totalAt = (rowH: number): number => {
                        let total = 0;
                        let firstSection = true;
                        for (const bucket of damBuckets) {
                          if (bucket.images.length === 0 && bucket.folders.length === 0) continue;
                          if (!firstSection) total += 16; // gap-4 between sections
                          firstSection = false;
                          total += 24; // section header + gap-2
                          for (const folder of bucket.folders) {
                            const folderImgs = bucket.images.filter((i) => i.folderId === folder.id);
                            total += 30; // folder row pt-1 + text + pb-[5px]
                            total += 4;  // gap-1 within folder block
                            total += folderImgs.length === 0 ? 60 : groupHeightAt(folderImgs, rowH);
                            total += 8;  // gap-2 between folder blocks (parent flex-col gap-2)
                          }
                          const folderIdSet = new Set(bucket.folders.map((f) => f.id));
                          const rootImgs = bucket.images.filter((i) => !i.folderId || !folderIdSet.has(i.folderId));
                          if (rootImgs.length > 0) {
                            if (bucket.folders.length > 0) total += 24; // marginTop spacer
                            total += groupHeightAt(rootImgs, rowH);
                          }
                        }
                        return total;
                      };
                      let lo = 40;
                      let hi = 360;
                      // 30 iterations puts sub-pixel precision well below render resolution.
                      for (let i = 0; i < 30; i++) {
                        const mid = (lo + hi) / 2;
                        if (totalAt(mid) <= H) lo = mid;
                        else hi = mid;
                      }
                      zoomRowH = Math.max(40, lo);
                    }
                    // Multi-select click router lives at the App level
                    // (handleDamImageClick — defined alongside the other DAM
                    // refs). Routing through a stable callback means the per-
                    // tile React.memo holds; selection changes only re-render
                    // the tiles that flipped state.
                    return (
                      <div
                        ref={setGalleryContainerEl}
                        className="flex-1 min-h-0 px-[31px] pb-[8px] flex flex-col"
                        // Click on the empty space inside the gallery slot
                        // clears the multi-selection. Image clicks call
                        // stopPropagation when modifiers are held, so this
                        // only fires for actual whitespace clicks.
                        onClick={() => { if (selectedImageIds.size > 0) setSelectedImageIds(new Set()); }}
                      >
                        {isCompletelyEmpty && (projectKey || taskKey) ? (
                          <div className="flex-1 bg-white/[0.03] flex flex-col items-center justify-center gap-3 p-6">
                            <span className="text-[#656464] text-[18px] font-bold">No Images Yet</span>
                            <p className="text-[#656464] text-[13px] text-center max-w-[480px]">
                              Drop Into One of the Zones Below
                            </p>
                            <div className="flex flex-row gap-3 w-full max-w-[700px] mt-3">
                              {/* WIP renders first (own bucket — wipKey), Project second
                                  (projectKey), Task third (taskKey). Each zone routes its
                                  dropped files to the matching bucket via addFocusImages. */}
                              {wipKey && (
                                <FocusDropZone
                                  label="WIP"
                                  onDropFiles={(files) => addFocusImages(wipKey, files)}
                                />
                              )}
                              {projectKey && (
                                <FocusDropZone
                                  label="Project"
                                  onDropFiles={(files) => addFocusImages(projectKey, files)}
                                />
                              )}
                              {taskKey && (
                                <FocusDropZone
                                  label="Task"
                                  onDropFiles={(files) => addFocusImages(taskKey, files)}
                                />
                              )}
                            </div>
                          </div>
                        ) : focusOneUpImageId ? (
                          (() => {
                            const img = flatImages.find((i) => i.id === focusOneUpImageId);
                            if (!img) return null;
                            return (
                              <div
                                className="w-full"
                                // Scroll-wheel cycling. Each notch moves to
                                // the next / previous image in the visual
                                // flat list. Throttled (~140ms) so a single
                                // smooth-trackpad swipe doesn't blow past
                                // 20 images at once. preventDefault stops
                                // page scroll while in 1-up.
                                onWheel={(e) => {
                                  if (Math.abs(e.deltaY) < 4) return;
                                  const now = Date.now();
                                  if (now - lastDamWheelRef.current < 140) { e.preventDefault(); return; }
                                  lastDamWheelRef.current = now;
                                  e.preventDefault();
                                  const flat = damVisualFlatRef.current;
                                  if (flat.length === 0) return;
                                  const idx = flat.findIndex((i) => i.id === focusOneUpImageId);
                                  if (idx < 0) return;
                                  const dir = e.deltaY > 0 ? 1 : -1;
                                  const next = (idx + dir + flat.length) % flat.length;
                                  setFocusOneUpImageId(flat[next].id);
                                }}
                              >
                                <div
                                  // block w-full so the wrapper takes the
                                  // column width — the image inside scales
                                  // up to match (small natural-size images
                                  // get blown up to fill the slot, which
                                  // sacrifices DPI sharpness on purpose per
                                  // the user's note that 72dpi-at-scale is
                                  // fine for this view).
                                  className="relative group block w-full cursor-zoom-out"
                                  onClick={() => setFocusOneUpImageId(null)}
                                >
                                  <CachedImage
                                    src={resolveImageSrc(img)}
                                    alt={img.filename}
                                    // w-full + h-auto: image fills the
                                    // column. max-h-[80vh] caps super-tall
                                    // portraits; object-contain keeps the
                                    // aspect ratio when the cap kicks in
                                    // (no stretch / no crop).
                                    className="block w-full h-auto max-h-[80vh] object-contain"
                                    loading="eager"
                                  />
                                  <button
                                    type="button"
                                    onClick={(e) => { e.stopPropagation(); toggleFocusImageFavorite(img.ownerKey, img.id); }}
                                    className={`absolute top-1 left-1 p-1 bg-black/40 hover:bg-black/70 opacity-0 group-hover:opacity-100 transition-opacity ${img.favorited ? 'text-[#FF7171]' : 'text-white'}`}
                                    aria-label={img.favorited ? 'Unfavorite image' : 'Favorite image'}
                                  >
                                    <Heart size={12} fill={img.favorited ? 'currentColor' : 'none'} />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={(e) => { e.stopPropagation(); deleteFocusImage(img.ownerKey, img.id); setFocusOneUpImageId(null); }}
                                    className="absolute top-1 right-1 p-1 bg-black/40 opacity-0 group-hover:opacity-100 text-white hover:bg-black/70 transition-opacity"
                                    aria-label="Delete image"
                                  >
                                    <Trash2 size={12} />
                                  </button>
                                </div>
                              </div>
                            );
                          })()
                        ) : (
                          <CustomScroll>
                            {/* One-CR space (37px, the project-wide "blank line" rhythm)
                                between the toggles row above and the first section
                                header. Without it the section labels read as
                                continuation of the toolbar. */}
                            <div className="flex flex-col gap-4" style={{ paddingTop: SPACING.cr }}>
                              {damBuckets.map((bucket) => {
                                const folderIdSet = new Set(bucket.folders.map((f) => f.id));
                                // Root images = anything in the bucket that doesn't
                                // resolve to an existing folder (handles orphans
                                // gracefully — deleted folder's images come back to
                                // root rather than disappearing).
                                const rootImages = bucket.images.filter((i) => !i.folderId || !folderIdSet.has(i.folderId));
                                // Under the favorites filter, hide folders that contain
                                // no favorited images — the "Drop Images Here" sheet
                                // would otherwise clutter a view that's meant to show
                                // only the favorited material. Off-filter behaviour is
                                // unchanged: empty folders still render so they can be
                                // used as drop targets.
                                const visibleFolders = favoritesFilterActive
                                  ? bucket.folders.filter((f) => bucket.images.some((i) => i.folderId === f.id))
                                  : bucket.folders;
                                if (rootImages.length === 0 && visibleFolders.length === 0) return null;
                                return (
                                  <div key={bucket.key} className="flex flex-col gap-2">
                                    {/* Section header — bucket label, mixed-case grey. The
                                        global font-size:14px !important rule overrides any
                                        text-[Npx] class, so we lean on color for hierarchy
                                        instead. */}
                                    <div className="text-[#a8a8a8]">{bucket.label}</div>
                                    {/* Folder rows render FIRST inside each section — the
                                        user's mental model is "folders sit at the top of
                                        the collection, loose images flow underneath." Folder
                                        order is dnd-kit-sortable so the user can drag-reorder
                                        within the bucket using the same underpinnings as the
                                        list-view sub-task reorder. */}
                                    <SortableContext
                                      items={visibleFolders.map((f) => `dam-folder:${bucket.key}:${f.id}`)}
                                      strategy={verticalListSortingStrategy}
                                    >
                                      {visibleFolders.map((folder) => {
                                        const folderImgs = bucket.images.filter((i) => i.folderId === folder.id);
                                        return (
                                          <div key={folder.id} className="flex flex-col gap-1">
                                            <FocusDamFolderRow
                                              folder={folder}
                                              bucketKey={bucket.key}
                                              isEditing={editingFolderId === folder.id}
                                              onStartEdit={() => setEditingFolderId(folder.id)}
                                              onCommitRename={(name) => { renameFocusFolder(bucket.key, folder.id, name); setEditingFolderId(null); }}
                                              onCancelRename={() => setEditingFolderId(null)}
                                              onDelete={() => deleteFocusFolder(bucket.key, folder.id)}
                                              onResync={folder.lrSource ? () => { syncLightroomFolder(bucket.key, folder.id); } : undefined}
                                            />
                                            <FocusDamFolderDropTarget bucketKey={bucket.key} folderId={folder.id}>
                                              {folderImgs.length > 0 ? (
                                                <FocusDamGroup
                                                  images={folderImgs}
                                                  tileView={focusDamTileHeight}
                                                  ownerKey={bucket.key}
                                                  selectedImageIds={selectedImageIds}
                                                  onImageClick={handleDamImageClick}
                                                  onDelete={deleteFocusImage}
                                                  onToggleFavorite={toggleFocusImageFavorite}
                                                  rowHOverride={zoomRowH}
                                                />
                                              ) : (
                                                // Empty-folder sheet — same soft tint
                                                // as the No-Images-Yet sheet, so the
                                                // "drop here" target reads as a
                                                // proper landing zone instead of a
                                                // tiny italic line.
                                                <div className="bg-white/[0.03] flex items-center justify-center min-h-[60px] text-[#656464]">
                                                  Drop Images Here
                                                </div>
                                              )}
                                            </FocusDamFolderDropTarget>
                                          </div>
                                        );
                                      })}
                                    </SortableContext>
                                    {/* Root images render AFTER the folders — loose
                                        items at the bottom of the section. When folders
                                        ARE present, we add a chunk of top-margin equal
                                        to a folder row's vertical footprint so the
                                        boundary between "in a folder" and "not in a
                                        folder" reads with the same beat as the boundary
                                        between two folders. Without it, root images
                                        kiss the last folder's images and lose the
                                        structural break. Same drop-target wrapping so
                                        a multi-select can land at the bucket root. */}
                                    <FocusDamFolderDropTarget bucketKey={bucket.key} folderId={null}>
                                      {rootImages.length > 0 ? (
                                        <div style={visibleFolders.length > 0 ? { marginTop: 24 } : undefined}>
                                          <FocusDamGroup
                                            images={rootImages}
                                            tileView={focusDamTileHeight}
                                            ownerKey={bucket.key}
                                            selectedImageIds={selectedImageIds}
                                            onImageClick={handleDamImageClick}
                                            onDelete={deleteFocusImage}
                                            onToggleFavorite={toggleFocusImageFavorite}
                                            rowHOverride={zoomRowH}
                                          />
                                        </div>
                                      ) : (
                                        <div className="h-1" />
                                      )}
                                    </FocusDamFolderDropTarget>
                                  </div>
                                );
                              })}
                            </div>
                          </CustomScroll>
                        )}
                      </div>
                    );
                  })()}
                  {/* Drag-over overlay: covers the column fully (solid #282828) when
                      the user drags an external file over the column AND there are
                      already images visible (the empty-state path doesn't need
                      this — its drop zones are always on screen). The same three
                      buckets (Project / Task / WIP) are presented; release on any
                      one ingests the file. pointer-events:none on the wrapper text
                      so only the FocusDropZones are draggable targets. */}
                  {refsDragActive && allImages.length > 0 && (projectKey || taskKey) && (
                    <div className="absolute inset-0 z-50 bg-[#282828] flex flex-col items-center justify-center gap-3 p-6">
                      <span className="text-[#656464] text-[18px] font-bold pointer-events-none">Add Images</span>
                      <p className="text-[#656464] text-[13px] text-center max-w-[480px] pointer-events-none">
                        Drop Into One of the Zones Below
                      </p>
                      <div className="flex flex-row gap-3 w-full max-w-[700px] mt-3">
                        {/* Same WIP / Project / Task order as the empty-state zones. */}
                        {wipKey && (
                          <FocusDropZone
                            label="WIP"
                            onDropFiles={(files) => {
                              addFocusImages(wipKey, files);
                              refsDragCounter.current = 0;
                              setRefsDragActive(false);
                            }}
                          />
                        )}
                        {projectKey && (
                          <FocusDropZone
                            label="Project"
                            onDropFiles={(files) => {
                              addFocusImages(projectKey, files);
                              refsDragCounter.current = 0;
                              setRefsDragActive(false);
                            }}
                          />
                        )}
                        {taskKey && (
                          <FocusDropZone
                            label="Task"
                            onDropFiles={(files) => {
                              addFocusImages(taskKey, files);
                              refsDragCounter.current = 0;
                              setRefsDragActive(false);
                            }}
                          />
                        )}
                      </div>
                    </div>
                  )}
                  {/* Lightbox removed — single-click on any tile now toggles inline 1-up
                      view via FocusDamViewer's onOneUpToggle. */}
                </div>
                )}
              </div>
              {/* Lightroom import dialog. State machine:
                  - idle: URL input + Import button
                  - resolving: spinner-like text while we look up the share
                  - importing: progress count "X of Y"
                  - done: success message with imported folder name
                  - error: red error string + retry */}
              {lightroomImportOpen && (
                <div
                  className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60"
                  onClick={() => { if (lrImportStatus !== 'importing' && lrImportStatus !== 'resolving') setLightroomImportOpen(false); }}
                >
                  <div
                    className="bg-[#2a2a2a] border border-[#3a3a3a] rounded-2xl w-[520px] p-6 flex flex-col gap-4 shadow-2xl"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <p className="text-white text-[14px] font-bold">Import from Lightroom</p>
                    {(lrImportStatus === 'idle' || lrImportStatus === 'error') && (
                      <>
                        <p className="text-[#a8a8a8] text-[13px]">
                          Paste a Lightroom share URL (a /shares/&hellip; link from an album YOU shared,
                          or a /libraries/&hellip;/albums/&hellip; URL from your own LR web view).
                        </p>
                        <input
                          type="text"
                          value={lrImportUrl}
                          onChange={(e) => setLrImportUrl(e.target.value)}
                          placeholder="https://lightroom.adobe.com/shares/..."
                          className="bg-[#1f1f1f] text-white px-3 py-2 rounded-md border border-[#3a3a3a] outline-none focus:border-[#7363FF]"
                          autoFocus
                        />
                        {lrImportStatus === 'error' && (
                          <p className="text-[#FF7171] text-[12px]">{lrImportError}</p>
                        )}
                        <div className="flex flex-row justify-end gap-2 mt-2">
                          <button
                            type="button"
                            onClick={() => setLightroomImportOpen(false)}
                            className="px-3 py-1 text-[13px] text-[#a8a8a8] hover:text-white transition-colors"
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            onClick={() => { const target = projectKey ?? taskKey; if (target) runLightroomImport(target); }}
                            disabled={!lrImportUrl.trim() || (!projectKey && !taskKey)}
                            className="px-3 py-1 text-[13px] bg-[#7363FF] text-white rounded-md hover:bg-[#8473ff] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            Import
                          </button>
                        </div>
                      </>
                    )}
                    {(lrImportStatus === 'resolving' || lrImportStatus === 'importing') && (
                      <>
                        {lrImportStatus === 'resolving' ? (
                          <p className="text-[#a8a8a8] text-[13px]">Resolving share URL&hellip;</p>
                        ) : (
                          <>
                            <p className="text-[#a8a8a8] text-[13px]">
                              Importing &ldquo;{lrImportFolderName}&rdquo; &mdash; {lrImportProgress.current} of {lrImportProgress.total}&hellip;
                            </p>
                            <div className="h-1 bg-[#1f1f1f] rounded overflow-hidden">
                              <div
                                className="h-full bg-[#7363FF] transition-all duration-200"
                                style={{ width: `${(lrImportProgress.current / Math.max(1, lrImportProgress.total)) * 100}%` }}
                              />
                            </div>
                          </>
                        )}
                        {/* Cancel — calls .abort() on the in-flight controller.
                            The driver picks up signal.aborted between iterations
                            and bails; any in-flight fetch is also cancelled. */}
                        <div className="flex flex-row justify-end mt-2">
                          <button
                            type="button"
                            onClick={() => lrImportAbortRef.current?.abort()}
                            className="px-3 py-1 text-[13px] text-[#a8a8a8] hover:text-white transition-colors"
                          >
                            Cancel
                          </button>
                        </div>
                      </>
                    )}
                    {lrImportStatus === 'done' && (
                      <>
                        <p className="text-white text-[13px]">
                          Imported {lrImportProgress.total} {lrImportProgress.total === 1 ? 'image' : 'images'} into &ldquo;{lrImportFolderName}&rdquo;.
                        </p>
                        <button
                          type="button"
                          onClick={() => { setLightroomImportOpen(false); setLrImportStatus('idle'); setLrImportUrl(''); }}
                          className="self-end px-3 py-1 text-[13px] text-[#a8a8a8] hover:text-white transition-colors"
                        >
                          Done
                        </button>
                      </>
                    )}
                    {lrImportStatus === 'cancelled' && (
                      <>
                        <p className="text-[#a8a8a8] text-[13px]">
                          Import cancelled. {lrImportProgress.current > 0 ? `${lrImportProgress.current} of ${lrImportProgress.total} were already imported into "${lrImportFolderName}". Re-sync that folder later to fill in the rest.` : ''}
                        </p>
                        <button
                          type="button"
                          onClick={() => { setLightroomImportOpen(false); setLrImportStatus('idle'); setLrImportUrl(''); }}
                          className="self-end px-3 py-1 text-[13px] text-[#a8a8a8] hover:text-white transition-colors"
                        >
                          Close
                        </button>
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })()}
        {!PIP_MODE && mode === 'settings' && (
          <SettingsMode
            people={people}
            newId={newId}
            onAddPerson={addPerson}
            onRenamePerson={renamePerson}
            onRenamePersonShort={renamePersonShort}
            onDeletePerson={deletePerson}
            currentUserShort={currentUserShort}
            onSetCurrentUser={setCurrentUserShort}
            taskOrder={taskOrder}
            onSetTaskOrder={setTaskOrder}
            listSequence={listSequence}
            onSetListSequence={setListSequence}
            onPurgeEmptyProjects={purgeEmptyProjects}
            onListClosedOutProjects={listClosedOutProjects}
            onRemoveProjectsByIds={removeProjectsByIds}
            onListStragglerProjects={listStragglerProjects}
            onDeleteStragglerProject={deleteStragglerProject}
            tomorrowEnabled={tomorrowEnabled}
            onSetTomorrowEnabled={setTomorrowEnabled}
            caseMode={caseMode}
            onSetCaseMode={setCaseMode}
            trashedTasks={trashedTasks}
            completedTasks={completedTasksForSettings}
            projects={projects}
            clients={clients}
            onUntrashTask={untrashTask}
            onPurgeTask={purgeTask}
            onToggleTask={toggleTask}
            liveBackupAt={liveBackupAt}
            dailyBackupAt={dailyBackupAt}
            onDownloadBackup={downloadBackup}
            onRestoreFromFile={restoreFromFile}
            onRestoreFromSlot={restoreFromSlot}
          />
        )}

        {/* ── Edge assign rails ───────────────────────────────────────────────
            Ever-present bars hugging the left and right edges of every view
            (except Settings + PIP), with generous margins so they clear the
            task columns and the right one sits well inside the scroll-bar.
            Rollover or click pulls out the tray; while dragging a task,
            entering the edge zone auto-opens it (see onDragMove) — drop on a
            row to reassign. BOTH sides show the SAME unified tray: Assign To
            (people) on top, then Assign Project (grouped by client, collapsed)
            below. On the Projects view the LEFT edge belongs to the existing
            Resources/Clients tray, so only the right rail shows there. */}
        {!PIP_MODE && mode !== 'settings' && (() => {
          // Assign rail + tray. The rail is a FULL-HEIGHT lighter bar living in the far-left
          // gutter (the pl-[22px] on the wrapper reserves the space) — ONLY the bar is the
          // hotspot, so it never overlaps or intercepts a column. Hover/click the bar (or drag
          // a task into the left edge) → the tray slides out, OPAQUE, masking the columns
          // underneath (TrayMask + calendarCollision keep the drag from leaking below). Drop a
          // task on a person → assignee added; on a project → the task MOVES to that project.
          const trayOpen = edgeDrawer === 'left';
          // A task drag is in flight — the tray must NOT translate during it (so its drop rows
          // stay measured on-screen); it only fades. Slides normally when not dragging.
          const trayDrag = activeType === 'task' || activeType === 'projTask';
          // Single-open accordion, hover-driven: EVERY client starts collapsed, even mid-drag.
          // Lingering over a client header opens ITS projects (and closes whatever was open);
          // rolling onto the next one readjusts. Dropping straight on a client header assigns
          // the client; hover-open then drop on a project row to assign the project.
          const hoverExpand = (cid: string) => {
            if (trayHoverTimerRef.current) clearTimeout(trayHoverTimerRef.current);
            trayHoverTimerRef.current = setTimeout(() => { setEdgeExpandedClient(cid); }, 250);
          };
          const cancelHoverExpand = () => { if (trayHoverTimerRef.current) { clearTimeout(trayHoverTimerRef.current); trayHoverTimerRef.current = null; } };
                    return (
            /* Monolithic assign drawer — the rail is merged into the panel. Closed: the 320px
               body translates off-screen-left and only the 22px chevron handle (absolute, added
               as the last child) stays visible. Open: translateX(0). Drag-safe: during a task
               drag the transform is pinned to 0 and only opacity animates, so dnd-kit keeps every
               drop row measured on-screen. One flat #333333 material, 300ms ease-in-out. */
            <div
              onMouseEnter={() => setEdgeDrawer('left')}
              onMouseLeave={() => { setEdgeDrawer((d) => (d === 'left' ? null : d)); cancelHoverExpand(); setEdgeExpandedClient(null); }}
              className={`fixed left-0 top-[104px] bottom-[84px] w-[320px] z-40 bg-[#333333] flex flex-col duration-300 ease-in-out ${trayDrag ? 'transition-opacity' : 'transition-[transform,opacity]'}`}
              style={{
                transform: (trayOpen || trayDrag) ? 'translateX(0)' : 'translateX(-320px)',
                opacity: (trayDrag && !trayOpen) ? 0 : 1,
                pointerEvents: trayOpen ? 'auto' : (trayDrag ? 'none' : 'auto'),
              }}
            >
                <TrayMask />
                {/* Assign To — people. */}
                <div className="shrink-0 h-[37px] flex items-center px-[31px]">
                  <p className="font-['NB_International:Regular',sans-serif] text-white text-[14.333px]">Assign To</p>
                </div>
                <div className="shrink-0">
                  {people.map((per) => (
                    <EdgeDropRow key={per.id} id={`edge:person:${per.short}`}>
                      <AssigneeBadge letter={per.short || '?'} tone="todo" />
                      <span className="font-['Univers_BQ:55_Regular',sans-serif] text-[14px] whitespace-nowrap overflow-hidden text-ellipsis text-white">{per.name}</span>
                    </EdgeDropRow>
                  ))}
                </div>
                {/* Two-line-space breather before the Assign Client / Project section. */}
                <div className="shrink-0 h-[74px]" aria-hidden />
                <div className="shrink-0 h-[37px] flex items-center px-[31px]">
                  <p className="font-['NB_International:Regular',sans-serif] text-white text-[14.333px]">Assign Client / Project</p>
                </div>
                {/* Projects grouped by client. Drop on the CLIENT header → assign the client;
                    expand (hover-linger or click, and always while dragging) → drop on a PROJECT.
                    Clientless projects list flat below. */}
                <CustomScroll>
                  {proj2SortedClients.map((c) => {
                    const clientProjects = projects.filter((p) => p.clientId === c.id);
                    if (clientProjects.length === 0) return null;
                    // Tray always shows every client EXPANDED — the indentation makes the
                    // client→project hierarchy read clearly, and it keeps every project row
                    // mounted so all are live drop targets the moment a drag starts.
                    const expanded = true;
                    return (
                      <Fragment key={c.id}>
                        <EdgeClientRow
                          client={c}
                          count={clientProjects.length}
                          expanded={expanded}
                          onMouseEnter={() => hoverExpand(c.id)}
                          onMouseLeave={cancelHoverExpand}
                          onClick={() => { cancelHoverExpand(); setEdgeExpandedClient((cur) => (cur === c.id ? null : c.id)); }}
                        />
                        {expanded && clientProjects.map((p) => (
                          <EdgeDropRow key={p.id} id={`edge:project:${p.id}`}>
                            {/* Indent projects clearly UNDER the client name (which sits past the
                                chevron at ~51px) so the hierarchy reads at a glance. */}
                            <span className="pl-[44px] font-['Univers_BQ:55_Regular',sans-serif] text-[14px] whitespace-nowrap overflow-hidden text-ellipsis text-[#c8c8c8]">{p.name || 'Untitled'}</span>
                          </EdgeDropRow>
                        ))}
                      </Fragment>
                    );
                  })}
                  {projects.filter((p) => !p.clientId || !clients.some((c) => c.id === p.clientId)).map((p) => (
                    <EdgeDropRow key={p.id} id={`edge:project:${p.id}`}>
                      <span className="font-['Univers_BQ:55_Regular',sans-serif] text-[14px] whitespace-nowrap overflow-hidden text-ellipsis text-white">{p.name || 'Untitled'}</span>
                    </EdgeDropRow>
                  ))}
                </CustomScroll>
                {/* Chevron handle — the visible sliver when the drawer is closed. Absolute at the
                    panel's right edge (right:-22) so it sits just past the 320px body; being a
                    child, it slides out WITH the drawer. Full-height, same #333333, no hover tint
                    (one monolithic material). Rotates 180° when open to read as "close". */}
                <button
                  type="button"
                  onClick={() => setEdgeDrawer('left')}
                  style={{ right: -22 }}
                  className="absolute top-0 bottom-0 w-[22px] bg-[#333333] flex items-center justify-center"
                  aria-label="Assign drawer"
                  title="Assign project / person"
                >
                  <ChevronRight size={12} className={`text-[#a8a8a8] shrink-0 transition-transform duration-300 ${trayOpen ? 'rotate-180' : ''}`} />
                </button>
              </div>
          );
        })()}
        {!PIP_MODE && <BottomBar mode={mode} onSetMode={setMode} onAdd={addAndEditTask} />}

        <AnimatePresence>
          {pendingTrash && (
            <TrashConfirmModal
              key={`trash-${pendingTrash.kind}-${pendingTrash.id}`}
              kind={pendingTrash.kind}
              name={pendingTrash.name}
              onClose={() => setPendingTrash(null)}
              onConfirm={() => {
                if (pendingTrash.kind === 'project') deleteProject(pendingTrash.id);
                if (pendingTrash.kind === 'client') deleteClient(pendingTrash.id);
                setPendingTrash(null);
              }}
            />
          )}
          {pendingResourceDelete && (
            <ResourceDeleteModal
              key={`resource-delete-${pendingResourceDelete.id}`}
              resource={pendingResourceDelete}
              taskCount={tasks.filter((t) => t.assignees.includes(pendingResourceDelete.short)).length}
              otherResources={people.filter((p) => p.id !== pendingResourceDelete.id && p.short).map((p) => ({ id: p.id, name: p.name, short: p.short }))}
              onClose={() => setPendingResourceDelete(null)}
              onConfirm={(reassignToShort) => confirmDeleteResource(reassignToShort)}
            />
          )}
          {showAdd && (
            <AddModal
              onClose={() => { setShowAdd(false); setPrefillList(null); }}
              onAddTask={addTask}
              onAddProject={addProject}
              onAddClient={addClient}
              projects={projects}
              clients={clients}
              people={people}
              defaultList={prefillList ?? undefined}
              defaultAssignee={currentUserShort || undefined}
            />
          )}
          {editingTask && (
            // Pull the LIVE task from storage so changes (toggling assignees, picking a second
            // date for a range, etc.) are reflected immediately. editingTask is only the initial
            // pointer — its fields are stale the moment we mutate the task.
            <TaskQuickEdit
              key={editingTask.id + ':' + editMode}
              task={tasks.find((t) => t.id === editingTask.id) ?? editingTask}
              projects={projects}
              clients={clients}
              people={people}
              mode={editMode}
              anchor={editAnchor}
              newId={newId}
              onClose={() => {
                // If the user opened the panel via the bottom + (creating a new task) and never
                // typed a title, discard the empty task so we don't leave a blank row behind.
                if (editingTask && editingTask.id === newId) {
                  const live = tasks.find((t) => t.id === editingTask.id);
                  if (live && !live.title.trim()) deleteTask(editingTask.id);
                }
                setEditingTask(null);
                setEditAnchor(null);
              }}
              onUpdateTask={updateTask}
              onAddProject={(p) => addBlankProject(p.clientId, p.list)}
              projectListOf={(id) => projectListMap[id] ?? 'projects'}
              onPinProjectList={pinProjectList}
              onAddClient={addBlankClient}
              onAddPerson={addPerson}
              onRenameClient={renameClient}
              onRenameProject={renameProject}
              onRenamePerson={renamePerson}
              onDeleteClient={deleteClient}
              onDeleteProject={deleteProject}
              onDeletePerson={deletePerson}
            />
          )}
        </AnimatePresence>

        <DragOverlay dropAnimation={null} style={{ cursor: 'grabbing' }}>
          {activeTask && activeType === 'task' ? (
            activeCalendarCellId ? (
              // Calendar drag: free-floating ghost that tracks the cursor 1:1. dnd-kit's
              // DragOverlay already positions it under the pointer, so the motion.div must NOT
              // add its own x-offset — the old `x: columnOffset*…` column-snap DOUBLE-applied
              // horizontal movement (card raced ahead of the cursor) and, when activeRectWidth
              // was unmeasured, the `?? '100%'` width blew the card out to the full portal
              // width. Fixed width fallback + no x-snap = a normal-size card that follows the
              // mouse.
              <motion.div
                initial={{ scale: 1 }}
                animate={{
                  scale: 1.02,
                  boxShadow: "0 1.875px 7.5px -0.625px rgba(0, 0, 0, 0.35), 0 1.25px 3.125px -0.3125px rgba(0, 0, 0, 0.25)",
                }}
                transition={{ scale: { type: "spring", stiffness: 600, damping: 30, mass: 0.4 } }}
                className="bg-[#3a3a3a] overflow-hidden"
                style={{ width: activeRectWidth ?? 220, height: activeRectHeight ?? 55, willChange: 'transform' }}
              >
                <CalendarCardBody task={activeTask} projects={projects} clients={clients} taskOrder={taskOrder} />
              </motion.div>
            ) : (
              <motion.div
                initial={{ scale: 1, x: 0 }}
                animate={{
                  scale: 1.02,
                  x: columnOffset * (activeRectWidth || 440),
                  boxShadow: "0 1.875px 7.5px -0.625px rgba(0, 0, 0, 0.35), 0 1.25px 3.125px -0.3125px rgba(0, 0, 0, 0.25)",
                }}
                transition={{
                  scale: { type: "spring", stiffness: 600, damping: 30, mass: 0.4 },
                  x: { type: "spring", stiffness: 320, damping: 34, mass: 0.7 },
                }}
                className="bg-[#333333]"
                style={{ width: activeRectWidth ?? '100%', willChange: 'transform' }}
              >
                {/* Forward the SAME render-controlling props the source row uses
                    (taskOrder, density, hasFocusContent), otherwise the lifted
                    overlay renders in the component defaults — different slot
                    order, different truncation thresholds, missing focus icon —
                    and the card visibly "scrambles" the moment the user picks it
                    up. Width is pinned to the source's measured rect, but the
                    INTERNAL layout still needs the source's settings. */}
                <SortableTaskItem
                  task={activeTask}
                  onToggle={() => {}}
                  // No-op onRename so the title row renders its trailing 7px hit-zone
                  // span. Without it the title div's `-mr-2` cancels the parent flex's
                  // gap-2 with nothing to push back, and the first assignee badge gets
                  // jammed up against the title text.
                  onRename={() => {}}
                  isDragOverlay
                  projects={projects}
                  clients={clients}
                  taskOrder={taskOrder}
                  density={density}
                  hasFocusContent={taskHasFocusContent(activeTask)}
                />
              </motion.div>
            )
          ) : null}
          {activeProject ? (
            <motion.div
              initial={{ scale: 1 }}
              animate={{
                scale: 1.02,
                boxShadow: "0 1.875px 7.5px -0.625px rgba(0, 0, 0, 0.35), 0 1.25px 3.125px -0.3125px rgba(0, 0, 0, 0.25)",
              }}
              transition={{ scale: { type: "spring", stiffness: 600, damping: 30, mass: 0.4 } }}
              className="bg-[#333333] h-[37px] box-border flex flex-row gap-2 items-center px-[31px]"
              style={{ width: activeRectWidth ?? '100%', willChange: 'transform' }}
            >
              <Folder size={12} className="text-[#656464]" />
              <span className="font-['Univers_BQ:55_Regular',sans-serif] text-[14px] text-white whitespace-nowrap">{activeProject.name}</span>
            </motion.div>
          ) : null}
          {activeFocusProject ? (
            <div className="bg-[#333333] h-[37px] box-border flex flex-row gap-2 items-center px-[31px] shadow-lg">
              <Folder size={12} className="text-[#656464]" />
              <span className="font-['Univers_BQ:55_Regular',sans-serif] text-[14px] text-white whitespace-nowrap">{activeFocusProject.name || 'Untitled'}</span>
            </div>
          ) : null}
          {activeProjTask ? (
            <motion.div
              initial={{ scale: 1, x: 0 }}
              animate={{
                scale: 1.02,
                x: columnOffset * (activeRectWidth || 440),
                boxShadow: "0 1.875px 7.5px -0.625px rgba(0, 0, 0, 0.35), 0 1.25px 3.125px -0.3125px rgba(0, 0, 0, 0.25)",
              }}
              transition={{
                scale: { type: "spring", stiffness: 600, damping: 30, mass: 0.4 },
                x: { type: "spring", stiffness: 320, damping: 34, mass: 0.7 },
              }}
              className="bg-[#333333] h-[37px] box-border flex flex-row gap-2 items-center pl-[43px] pr-[31px]"
              style={{ width: activeRectWidth ?? '100%', willChange: 'transform' }}
            >
              <LIndent />
              <TaskCheckbox completed={activeProjTask.completed} started={activeProjTask.started} onToggle={() => {}} />
              <span className={`font-['Univers_BQ:55_Regular',sans-serif] text-[14px] whitespace-nowrap ${activeProjTask.completed ? 'text-[#474747]' : 'text-white'}`}>{activeProjTask.title}</span>
            </motion.div>
          ) : null}
          {/* References-gallery image drag preview. Locks 1:1 to the cursor
              (DragOverlay positions it at the active rect during drag), at
              the source tile's exact width × height so the user sees the
              tile they grabbed under their cursor instead of a re-flow of
              the gallery. The "+N" badge stamps the upper-right corner
              when a multi-selection is being moved together so it's
              obvious the operation will land more than one image. */}
          {activeType === 'damImage' && activeDamImage ? (
            <motion.div
              initial={{ scale: 1 }}
              animate={{
                scale: 1.02,
                boxShadow: "0 1.875px 7.5px -0.625px rgba(0, 0, 0, 0.35), 0 1.25px 3.125px -0.3125px rgba(0, 0, 0, 0.25)",
              }}
              transition={{ scale: { type: "spring", stiffness: 600, damping: 30, mass: 0.4 } }}
              className="relative bg-[#1f1f1f] overflow-hidden"
              style={{ width: activeRectWidth ?? '100%', height: activeRectHeight, willChange: 'transform' }}
            >
              <CachedImage
                src={resolveImageSrc(activeDamImage)}
                alt={activeDamImage.filename}
                className="block w-full h-full object-cover"
              />
              {activeDamMultiCount > 1 ? (
                <div className="absolute top-1 right-1 bg-[#7363FF] text-white px-2 py-0.5 rounded-full pointer-events-none">
                  +{activeDamMultiCount - 1}
                </div>
              ) : null}
            </motion.div>
          ) : null}
        </DragOverlay>
      </div>
      <DebugOverlay />
    </DndContext>
  );
}
