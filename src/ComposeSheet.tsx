// The compose sheet and everything it is made of — shared by the desktop and the phone,
// because "the phone version of New Task" is the version. One panel, one behaviour on both
// surfaces: the same chips, the same Personal-hides-Client rule, the same save-on-dismiss.
// Imports nothing from App.tsx (App imports THIS), so there is no cycle.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useMutation } from '@liveblocks/react/suspense';
import { motion } from 'motion/react';
import { ChevronLeft, ChevronRight, Plus, X } from 'lucide-react';
import type { Task, Project, Client, Person, ListId, SectionId } from './data';
import { LIST_TITLES, LISTS, addDaysToDate, dateToISO } from './data';
import { Capsule, CapsuleKnob, CapsuleTrack, Ripple, type Feel } from './Capsules';

// The four sections, in the order every switcher shows them. Hold is parked, not a day: its
// pane is sourced straight from the section and its drop token is 'HOLD@' rather than a date.
export const PANES: { section: SectionId; label: string }[] = [
  { section: 'today', label: 'Today' },
  { section: 'tomorrow', label: 'Tomorrow' },
  { section: 'next', label: 'Next' },
  // Parked. Not a day: its pane is sourced straight from the section (see paneBands),
  // and its drop token is 'HOLD@' rather than an ISO date.
  { section: 'hold', label: 'Hold' },
];


export function SheetShell({ onClose, onSwipeDown, handle = false, floor = 1 / 3, maxWidth, placement = 'bottom', children }: {
  onClose: () => void;
  /** Desktop: cap the sheet's width and centre it. Unset = full-bleed, as on the phone. */
  maxWidth?: number;
  /** 'bottom' (phone): docked to the bottom edge, full-bleed. 'center' (desktop): a floating
   *  panel in the middle of the window, sized to its content, touching no edge. */
  placement?: 'bottom' | 'center';
  /** Pull DOWN anywhere on the sheet that isn't a control (chip, field, button, chip track)
   *  — and from the top of a scrolled body — runs this. Usually the same commit as onClose. */
  onSwipeDown?: () => void;
  /** Show the grab pill. Purely a hint now: the whole sheet answers the gesture. */
  handle?: boolean;
  /** Opening height as a fraction of the window. The sheet only ever GROWS from here. */
  floor?: number;
  children: React.ReactNode;
}) {
  // iOS fires the synthetic click 0-300ms AFTER the touch tap that opened this sheet — the
  // stray click lands on the fresh backdrop and would close it instantly. Ignore backdrop
  // clicks for the first 500ms of the sheet's life.
  const openedAtRef = useRef(Date.now());
  const centered = placement === 'center';
  // KEYBOARD AVOIDANCE — the overlay TRACKS THE VISUAL VIEWPORT instead of doing keyboard maths.
  //
  // Two earlier attempts failed for the same underlying reason: the overlay was `fixed inset-0`,
  // which pins it to the LAYOUT viewport. iOS does not shrink the layout viewport when the
  // keyboard opens — it offsets the VISUAL viewport (scrolls it) to reveal the focused field.
  // Fixed elements stay glued to the layout viewport, so relative to what you can actually see
  // the whole overlay rides upward and the sheet's top — the title you are typing into — goes
  // off screen. Subtracting an inset from the bottom cannot fix that, because the container
  // itself is in the wrong place.
  //
  // So: position the overlay AT the visual viewport (top = vv.offsetTop, height = vv.height).
  // It then covers exactly the visible area in every state — keyboard up, keyboard down,
  // mid-scroll — and the sheet simply sits at its bottom with max-height 100%. No arithmetic.
  const [vvBox, setVvBox] = useState<{ top: number; height: number }>(() => ({
    top: 0,
    height: typeof window === 'undefined' ? 0 : window.innerHeight,
  }));
  // "innerHeight minus visual height" is 0 in a standalone PWA on current iOS, where the
  // LAYOUT viewport shrinks with the keyboard too — so the keyboard-down padding (a 34px
  // home-indicator inset) was being applied under Save with the keyboard up, which is the
  // "panel twice the height of its button". The screen height doesn't move; a visual
  // viewport under ~72% of it can only mean a keyboard.
  const keyboardUp = typeof window !== 'undefined' && vvBox.height > 0
    && (window.innerHeight - vvBox.height > 80 || vvBox.height < window.screen.height * 0.72);
  // The sheet's height has always been pure content — there is no floor anywhere — so the quick
  // task sheet opened at 216px, a quarter of an iPhone screen, and read as a strip rather than a
  // panel. Measure the floor against the WHOLE window, not the visible box, so it doesn't
  // collapse the moment the keyboard takes half the screen. Clamp it to vvBox.height because
  // min-height BEATS max-height: an unclamped floor in landscape would put the sheet's top —
  // the title field — back off screen, which is the failure the block above spent two attempts
  // fixing.
  const sheetFloor = typeof window === 'undefined' ? 0 : Math.min(Math.round(window.innerHeight * floor), vvBox.height);
  // RATCHET. The sheet is bottom-anchored and content-sized, so when a section disappears
  // (choose Personal: the Client picker goes) the content gets shorter, the sheet shrinks,
  // and its TOP drops — revealing a slice of the app behind it. The height it has reached
  // is remembered and never given back while the sheet is open; the slack goes to the
  // bottom of the scroll body, invisibly, and the top stays docked. Clamped to the visual
  // viewport because min-height beats max-height and a locked height taller than what is
  // visible would push the title field off screen with the keyboard up.
  // The ratchet remembers DOCKED-NESS — the smallest gap ever seen above the sheet — not a
  // pixel height. A height ratchet failed in exactly the case it was built for: with the
  // keyboard up the sheet can only be as tall as the shrunken viewport, so its "tallest" was
  // small; when a chip tap dismissed the keyboard and dropped the Client section, a shorter
  // sheet in a taller viewport left a strip of the app showing above it. Once the sheet has
  // touched the top it stays touching the top, whatever the viewport does next.
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const [minGap, setMinGap] = useState(Number.POSITIVE_INFINITY);
  useEffect(() => {
    const el = sheetRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const box = el.parentElement?.clientHeight ?? 0;
      if (box > 0) setMinGap((g) => Math.min(g, Math.max(0, box - el.offsetHeight)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const docked = Number.isFinite(minGap) ? vvBox.height - minGap : 0;
  const lockedMin = Math.min(vvBox.height, Math.max(sheetFloor, docked));

  // DRAG TO DISMISS, the way the system sheets do it. The sheet FOLLOWS the finger while it
  // is down — you can pull it partway, change your mind, and push it back up — and only on
  // release is anything decided: past ~28% of its height, or a decisive flick, it slides off
  // the bottom edge and THEN closes; otherwise it springs back. Nothing happens on a small
  // move, which is what the previous "36px and it's gone" felt like.
  //
  // Native listeners, not React's: touchmove must be non-passive so the drag can
  // preventDefault the scroll it would otherwise turn into. A touch that begins on a
  // control (chip, field, button, the chip track) is that control's; one inside a scroll
  // body that has been scrolled is a scroll — only from the very top does a pull mean
  // "close". The drag only ever moves DOWN; upward is clamped to rest.
  const onSwipeDownRef = useRef(onSwipeDown);
  onSwipeDownRef.current = onSwipeDown;
  useEffect(() => {
    const el = sheetRef.current;
    if (!el || !onSwipeDownRef.current) return;
    let drag: { y0: number; dy: number; maxDy: number; lastY: number; lastT: number; v: number } | null = null;
    let leaving = false;
    const onStart = (e: TouchEvent) => {
      if (leaving) return;
      const target = e.target as Element;
      if (target.closest('button, input, textarea, select, a, [data-chip-track]')) return;
      const body = target.closest<HTMLElement>('[data-sheet-scroll]');
      if (body && body.scrollTop > 0) return;
      const t = e.touches[0];
      drag = { y0: t.clientY, dy: 0, maxDy: 0, lastY: t.clientY, lastT: e.timeStamp, v: 0 };
      el.style.transition = 'none';
    };
    const onMove = (e: TouchEvent) => {
      if (!drag) return;
      const t = e.touches[0];
      const dy = Math.max(0, t.clientY - drag.y0);
      const dt = Math.max(1, e.timeStamp - drag.lastT);
      drag.v = (t.clientY - drag.lastY) / dt;          // px per ms, + = downward
      drag.lastY = t.clientY; drag.lastT = e.timeStamp; drag.dy = dy;
      if (dy > drag.maxDy) drag.maxDy = dy;
      if (dy > 0) e.preventDefault();                   // the sheet moves, not the page
      el.style.transform = `translateY(${dy}px)`;
    };
    const onEnd = () => {
      if (!drag) return;
      const { dy, v, maxDy } = drag;
      drag = null;
      const h = el.offsetHeight || 1;
      // Changing your mind wins. If the finger came back UP from its lowest point by 20px,
      // or let go with upward momentum, the sheet snaps home and stays open — no matter how
      // far down it had been. A twitch of a few pixels doesn't count as reversing.
      const reversed = (maxDy - dy) >= 20 || v < -0.3;
      const commit = !reversed && (dy > h * 0.28 || (v > 0.6 && dy > 24));
      if (commit) {
        leaving = true;
        el.style.transition = 'transform 220ms cubic-bezier(0.32, 0.72, 0, 1)';
        el.style.transform = 'translateY(110%)';
        // Close once it is actually off screen; the timer covers a missed transitionend.
        let done = false;
        const finish = () => { if (done) return; done = true; onSwipeDownRef.current?.(); };
        el.addEventListener('transitionend', finish, { once: true });
        window.setTimeout(finish, 260);
      } else {
        el.style.transition = 'transform 260ms cubic-bezier(0.2, 0.9, 0.3, 1.1)';
        el.style.transform = 'translateY(0)';
      }
    };
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd, { passive: true });
    el.addEventListener('touchcancel', onEnd, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
    };
  }, []);
  useEffect(() => {
    const vv = window.visualViewport;
    const update = () => {
      setVvBox(vv ? { top: vv.offsetTop, height: vv.height } : { top: 0, height: window.innerHeight });
    };
    update();
    vv?.addEventListener('resize', update);
    vv?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    return () => {
      vv?.removeEventListener('resize', update);
      vv?.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
    };
  }, []);
  return (
    // Positioned at the VISUAL viewport, so this box is exactly what the user can see.
    // touch-action:none — a touch on this overlay must never be handed to the page beneath.
    // That hand-off is what made dragging the sheet down scroll the app underneath it.
    // The scroll body inside re-enables pan-y for itself.
    <div
      className={`fixed left-0 right-0 z-50 ${centered ? 'flex items-center justify-center' : ''}`}
      style={{ top: vvBox.top, height: vvBox.height, touchAction: 'none' }}
      // Escape closes — and commits, like every other way out. Stopped here so the app's own
      // key handler never sees it.
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}
    >
      <div className="absolute inset-0 bg-black/50" onClick={() => { if (Date.now() - openedAtRef.current > 500) onClose(); }} />
      {/* Sheet sits at the bottom of the visible box and can never exceed it, so its top — the
          title field — is always on screen. Children lay out as a flex column, so the child
          marked flex-1 becomes the scrolling middle while the title and the primary button
          stay pinned. */}
      <div
        ref={sheetRef}
        data-msheet
        className={centered
          ? 'relative flex flex-col rounded-[6px] px-[24px]'
          : 'absolute left-0 right-0 bottom-0 flex flex-col rounded-t-[4px] px-[18px]'}
        style={centered ? {
          // A floating panel: as wide as the caller asked but never wider than the window less
          // a margin, never taller than that either, and sized to its content. The ratchet
          // (minHeight) only stops it shrinking — and re-centring — once it has grown.
          width: `min(${maxWidth ?? 760}px, calc(100% - 48px))`,
          backgroundColor: SHEET_BG,
          maxHeight: 'calc(100% - 48px)',
          minHeight: lockedMin,
          paddingTop: 20,
          paddingBottom: 16,
          boxShadow: '0 24px 64px rgba(0, 0, 0, 0.45)',
          willChange: 'transform',
          animation: 'msheet-pop 260ms cubic-bezier(0.2, 0, 0, 1)',
        } : {
          maxWidth, marginLeft: 'auto', marginRight: 'auto',
          backgroundColor: SHEET_BG,
          maxHeight: '100%',
          minHeight: lockedMin,
          // Corners are 4px, deliberately: the sheet is a panel, not a second screen. The
          // 40px iPhone-radius version was tried and read as a card pasted over the app.
          //
          // The grab bar lives in the top padding, so that padding shrinks when it is present.
          paddingTop: handle ? 8 : 16,
          // Only the home-indicator inset below, plus a hair. The previous +18px, on top of
          // the Save row's own padding, was the "button floating on a panel twice its height".
          paddingBottom: keyboardUp ? 10 : 'calc(env(safe-area-inset-bottom) + 6px)',
          // willChange keeps the drag on the compositor; the entry animation still runs
          // first and hands the transform over to the drag engine when it ends.
          willChange: 'transform',
          animation: 'msheet-up 240ms cubic-bezier(0.16, 1, 0.3, 1)',
        }}
      >
        {/* The system's 5x36 pill. A hint: the whole sheet drags, not just this. */}
        {handle && (
          <div aria-hidden className="shrink-0 mx-auto mb-[6px] px-[26px] py-[8px]">
            <div className="h-[5px] w-[36px] rounded-full bg-[#4a4a4a]" />
          </div>
        )}
        {children}
      </div>
      <style>{`@keyframes msheet-up { from { transform: translateY(100%); } to { transform: translateY(0); } } @keyframes msheet-pop { from { opacity: 0; transform: translateY(14px) scale(0.985); } to { opacity: 1; transform: none; } }`}</style>
    </div>
  );
}

// Capsules speak the day-switcher's language: the GROUP is a near-black track, the SELECTED
// capsule is the page-background colour sitting on it (the switcher's knob), selected text is
// white, and everything unselected recedes to the same grey the switcher uses. No borders.
// The sheet's own surface colour. The SELECTED capsule uses it, so a chosen chip reads as a
// piece of the sheet lifted onto the darker track beneath it.
export const SHEET_BG = '#232220';
// Track hugs its capsules (inline-flex) instead of stretching edge to edge — two People chips
// get a two-chip-wide track, not a full-width bar. max-w-full lets long lists still wrap.
export const CHIP_TRACK = 'inline-flex flex-row flex-wrap items-center gap-[4px] rounded-[21px] bg-black p-[3px] max-w-full';
export const CHIP_BASE = "h-[36px] inline-flex items-center px-[14px] rounded-full text-[13px] font-['Univers_BQ:55_Regular',sans-serif] transition-colors";

// "Sat 12 Sep" — the absolute date, for a capsule that names a picked day.
function chipDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  if (isNaN(date.getTime())) return iso;
  return `${date.toLocaleDateString('en-US', { weekday: 'short' })} ${d} ${date.toLocaleDateString('en-US', { month: 'short' })}`;
}


/** Create a client by name; returns its id. Liveblocks-backed, so any surface can use it. */
export function useAddClient() {
return useMutation(({ storage }, name: string) => {
  const id = `client-${Date.now()}`;
  const current = (storage.get('clients' as never) as Client[] | undefined) || [];
  // Short code: first word, capped at 6 chars — matches the compact badges on cards.
  const short = name.trim().split(/\s+/)[0].slice(0, 6);
  storage.set('clients' as never, [...current, { id, name: name.trim(), short }] as never);
  return id;
}, []);
}

/** Create a project, optionally owned by a client and pinned to a category; returns its id. */
export function useAddProject() {
return useMutation(({ storage }, p: { name: string; clientId?: string; list?: ListId }) => {
  const id = `project-${Date.now()}`;
  const current = (storage.get('projects' as never) as Project[] | undefined) || [];
  storage.set('projects' as never, [...current, { id, name: p.name.trim(), clientId: p.clientId, list: p.list }] as never);
  return id;
}, []);
}


export function PanelSection({ label, open, onToggle, onCreate, createPlaceholder, feel = 'quintic', children }: {
  feel?: Feel;
  label: string;
  open?: boolean;
  onToggle?: () => void;
  onCreate?: (name: string) => void;
  createPlaceholder?: string;
  children: React.ReactNode;
}) {
  const [name, setName] = useState('');
  const canAdd = !!onCreate;
  const commit = () => {
    const n = name.trim();
    if (!n) return;
    onCreate?.(n);
    setName('');
    onToggle?.();
  };
  return (
    <div className="pb-[22px]">
      <div className="flex flex-row items-center gap-[8px] pb-[9px]">
        {canAdd ? (
          <button type="button" onClick={onToggle} className="text-[#5e5e5e]" style={{ fontSize: 11 }}>{label}</button>
        ) : (
          <p className="text-[#5e5e5e]" style={{ fontSize: 11 }}>{label}</p>
        )}
        {canAdd && open && (
          <button type="button" aria-label={`New ${label}`} onClick={() => { /* field is already shown */ }} className="text-[#5e5e5e]">
            <Plus size={12} />
          </button>
        )}
      </div>
      {canAdd && open && (
        <div className="flex flex-row items-center gap-[8px] pb-[10px]">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }}
            placeholder={createPlaceholder || `New ${label.toLowerCase()}`}
            autoCapitalize="words"
            autoCorrect="on"
            spellCheck={false}
            autoComplete="off"
            name="ctrl-entry-new"
            className="flex-1 h-[36px] bg-[#232220] rounded-full px-[14px] text-[13px] text-white outline-none border-none placeholder:text-[#474747]"
          />
          <button type="button" onClick={commit} className={CHIP_BASE + ' bg-[#232220] text-[var(--app-accent)]'}>Add</button>
        </div>
      )}
      <CapsuleTrack feel={feel} knob={SHEET_BG} className={CHIP_TRACK} attrs={{ 'data-chip-track': '' }}>{children}</CapsuleTrack>
    </div>
  );
}

// The desktop's deadline picker: a month grid, always open. The selected day is an accent disc
// that scales and fades in under the day (the same knob as the capsules'); clicking the selected
// day clears the deadline. Six rows always, so the grid never changes height between months.
const DOW = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const CAL_SPRING = { type: 'spring' as const, stiffness: 520, damping: 34, mass: 0.9 };
function isoToDate(iso: string): Date { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); }

export function MonthCalendar({ value, onChange, todayIso }: { value: string; onChange: (iso: string) => void; todayIso: string }) {
  const [month, setMonth] = useState(() => { const d = isoToDate(value || todayIso); return new Date(d.getFullYear(), d.getMonth(), 1); });
  // Follow the value into its month when it is set from outside (a capsule).
  useEffect(() => {
    if (!value) return;
    const d = isoToDate(value);
    if (isNaN(d.getTime())) return;
    setMonth((cur) => (cur.getFullYear() === d.getFullYear() && cur.getMonth() === d.getMonth()) ? cur : new Date(d.getFullYear(), d.getMonth(), 1));
  }, [value]);
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const start = addDaysToDate(first, -first.getDay());
  const cells = [...Array(42)].map((_, i) => {
    const d = addDaysToDate(start, i);
    return { iso: dateToISO(d), day: d.getDate(), inMonth: d.getMonth() === month.getMonth() };
  });
  const label = month.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const step = (n: number) => setMonth(new Date(month.getFullYear(), month.getMonth() + n, 1));
  return (
    <div className="flex flex-col gap-[8px] select-none">
      <div className="flex flex-row items-center justify-between px-[6px]">
        <button type="button" aria-label="Previous month" onClick={() => step(-1)} className="text-[#656464] hover:text-white transition-colors p-1 -m-1"><ChevronLeft size={14} /></button>
        <span className="text-[13px] text-[#a8a8a8]">{label}</span>
        <button type="button" aria-label="Next month" onClick={() => step(1)} className="text-[#656464] hover:text-white transition-colors p-1 -m-1"><ChevronRight size={14} /></button>
      </div>
      <div className="grid grid-cols-7 gap-y-[2px] text-center">
        {DOW.map((d, i) => <div key={`dow-${i}`} className="h-[22px] flex items-center justify-center text-[11px] text-[#5e5e5e]">{d}</div>)}
        {cells.map((c) => {
          const selected = c.iso === value;
          const today = c.iso === todayIso;
          return (
            <div key={c.iso} className="h-[36px] flex items-center justify-center">
              <motion.button
                type="button"
                whileTap={{ scale: 0.88 }}
                transition={CAL_SPRING}
                onClick={() => onChange(selected ? '' : c.iso)}
                className={`relative h-[32px] w-[32px] rounded-full flex items-center justify-center text-[13px] transition-colors ${selected ? 'text-white' : today ? 'text-[var(--app-accent)]' : c.inMonth ? 'text-white hover:bg-white/10' : 'text-[#4a4a4a] hover:bg-white/[0.04]'}`}
                style={{ isolation: 'isolate', transitionDuration: '240ms' }}
              >
                <CapsuleKnob active={selected} feel="spring" color="var(--app-accent)" />
                {c.day}
              </motion.button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Full task panel — the desktop AddModal's field set, laid out for a phone. Used BOTH for
// creating (bottom "+") and for editing (the card sheet's "Edit"), so the two can never drift.
//
// Layout rules:
//  - Every section is the same shape and rhythm. When (Today / Tomorrow / Next) is just the first
//    such section — no special width or padding — so all the capsules feel identical.
//  - Nothing is hidden behind a disclosure; the body scrolls instead.
//  - Dismissing COMMITS. The backdrop, the X and Add Task all save what you have filled in, so a
//    half-typed task can't be lost by tapping away.
//  - Client and Project narrow to the chosen Category, since a project is pinned to a category.
export function ComposeSheet({ listSequence, projects, clients, people, currentUserShort, defaultSection, isos, anchor, editingTask, onCreate, onUpdate, onAddClient, onAddProject, onClose, maxWidth, surface = 'phone' }: {
  listSequence: ListId[];
  projects: Project[]; clients: Client[]; people: Person[];
  currentUserShort: string;
  defaultSection: SectionId;
  isos: string[]; anchor: Date;
  editingTask?: Task | null;
  onCreate: (payload: {
    title: string; list: ListId; section: SectionId;
    projectId?: string; clientId?: string; deadline?: string;
    assignees?: string[]; milestone?: boolean;
  }, keepOpen: boolean) => void;
  onUpdate: (id: string, patch: Partial<Task>) => void;
  onAddClient: (name: string) => string;
  onAddProject: (p: { name: string; clientId?: string; list?: ListId }) => string;
  onClose: () => void;
  /** Desktop only: cap and centre the sheet. */
  maxWidth?: number;
  /** Which surface is showing this. Desktop: a centred floating panel, spring-driven knobs,
   *  and the month calendar exposed beside the fields. Phone: a bottom sheet, quintic knobs,
   *  Material ripples. */
  surface?: 'phone' | 'desktop';
}) {
  const isEdit = !!editingTask;
  const desktop = surface === 'desktop';
  const feel: Feel = desktop ? 'spring' : 'quintic';
  const seedProject = editingTask?.projectId ? projects.find((p) => p.id === editingTask.projectId) : undefined;
  const [title, setTitle] = useState(editingTask?.title ?? '');
  const [listId, setListId] = useState<ListId>(() => {
    if (editingTask) return editingTask.list;
    try { const v = window.localStorage.getItem('todo-app-mobile-last-list') as ListId | null; return v && LISTS.includes(v) ? v : listSequence[0]; } catch { return listSequence[0]; }
  });
  const [section, setSection] = useState<SectionId>(editingTask?.section ?? defaultSection);
  const [clientId, setClientId] = useState(editingTask?.clientId ?? seedProject?.clientId ?? '');
  const [projectId, setProjectId] = useState(editingTask?.projectId ?? '');
  const [assignees, setAssignees] = useState<string[]>(editingTask?.assignees ?? (currentUserShort ? [currentUserShort] : []));
  const [deadline, setDeadline] = useState(editingTask?.deadline ?? '');
  const [milestone, setMilestone] = useState(editingTask?.type === 'scheduled');
  const [addedCount, setAddedCount] = useState(0);
  const [openLabel, setOpenLabel] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  // WebKit only raises the software keyboard when focus() runs synchronously inside the user
  // gesture's own task, so this must be a layout effect, not a timeout. Don't steal focus when
  // editing — the keyboard would cover the fields you opened this for.
  useLayoutEffect(() => { if (!isEdit) inputRef.current?.focus(); }, [isEdit]);

  // Projects are pinned to a category (`project.list`); unpinned ones belong everywhere. So the
  // Project list follows the Category you picked, and the Client list narrows to whoever owns
  // those projects. The current selection is always kept visible so it can't silently vanish.
  const categoryProjects = useMemo(
    () => projects.filter((p) => !p.list || p.list === listId),
    [projects, listId]
  );
  const visibleClients = useMemo(() => {
    const owners = new Set(categoryProjects.map((p) => p.clientId).filter(Boolean) as string[]);
    return clients.filter((c) => owners.has(c.id) || c.id === clientId);
  }, [clients, categoryProjects, clientId]);
  const visibleProjects = useMemo(
    () => (clientId ? categoryProjects.filter((p) => p.clientId === clientId) : categoryProjects),
    [categoryProjects, clientId]
  );
  // Changing Category can orphan the current picks — drop them rather than submit a mismatch.
  useEffect(() => {
    if (projectId && !categoryProjects.some((p) => p.id === projectId)) setProjectId('');
    // Personal has no clients — everything there hangs off the Personal system client — so a
    // client carried over from another category would be a contradiction waiting to sync.
    if (listId === 'personal' && clientId) setClientId('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listId]);

  const chooseClient = (id: string) => {
    setClientId(id);
    if (projectId && !projects.some((p) => p.id === projectId && p.clientId === id)) setProjectId('');
  };
  const chooseProject = (id: string) => {
    setProjectId(id);
    const owner = projects.find((p) => p.id === id)?.clientId;
    if (owner) setClientId(owner);
  };

  const payload = () => {
    const owner = projectId ? projects.find((p) => p.id === projectId)?.clientId : undefined;
    return {
      title: title.trim(),
      list: listId,
      section,
      projectId: projectId || undefined,
      clientId: owner ?? (clientId || undefined),
      deadline: deadline || undefined,
      assignees,
      milestone,
    };
  };

  // RAPID ENTRY (create only): return saves and clears WITHOUT closing or dismissing the
  // keyboard, keeping every other field as-is so a run of related tasks is one gesture each.
  const save = (keepOpen: boolean) => {
    const t = title.trim();
    if (!t) { if (!keepOpen) onClose(); return; }
    if (isEdit && editingTask) {
      const p = payload();
      onUpdate(editingTask.id, {
        title: p.title, type: milestone ? 'scheduled' : 'todo',
        list: p.list, section: p.section,
        projectId: p.projectId, clientId: p.clientId, deadline: p.deadline, assignees: p.assignees,
      });
      onClose();
      return;
    }
    try { window.localStorage.setItem('todo-app-mobile-last-list', listId); } catch { /* ignore */ }
    onCreate(payload(), keepOpen);
    if (keepOpen) {
      setTitle('');
      setAddedCount((n) => n + 1);
      inputRef.current?.focus();
    }
  };

  // Dismissing commits. A half-filled task tapped away is saved, not thrown away.
  const commitAndClose = () => save(false);
  const toggleLabel = (k: string) => setOpenLabel((v) => (v === k ? null : k));

  // The Deadline capsules are ONE single-select group whose value is the deadline: None, Today,
  // +1 wk, or a custom date — the phone's native picker, the desktop's calendar.
  const weekIso = dateToISO(addDaysToDate(anchor, 7));
  const deadlineKey = !deadline ? 'none' : deadline === isos[0] ? 'today' : deadline === weekIso ? 'week' : 'custom';
  const deadlineSection = (
    <PanelSection label="Deadline" feel={feel}>
      <Capsule active={deadlineKey === 'none'} onClick={() => setDeadline('')}>None</Capsule>
      <Capsule active={deadlineKey === 'today'} onClick={() => setDeadline(isos[0])}>Today</Capsule>
      <Capsule active={deadlineKey === 'week'} onClick={() => setDeadline(weekIso)}>+1 wk</Capsule>
      {desktop ? (
        // The calendar beside these is the picker; this capsule only NAMES a day chosen there.
        deadlineKey === 'custom' && <Capsule active>{chipDate(deadline)}</Capsule>
      ) : (
        // The phone's picker is the native one. The capsule is sized by its LABEL — "Date" until a
        // day outside the presets is picked, then that day — and the date field itself is an
        // invisible layer over it: type=date brings its own intrinsic width and chrome on every
        // engine, and letting it size the capsule put it on a line of its own. A tap anywhere on
        // the capsule opens the picker. Its knob appears under it like under any other capsule.
        <span
          className={`${CHIP_BASE} relative bg-transparent ${deadlineKey === 'custom' ? 'text-white' : 'text-[#656464]'}`}
          style={{ isolation: 'isolate', transition: 'color 240ms cubic-bezier(0.2, 0, 0, 1)', WebkitTapHighlightColor: 'transparent' }}
        >
          <CapsuleKnob active={deadlineKey === 'custom'} feel={feel} color={SHEET_BG} />
          {deadlineKey === 'custom' ? chipDate(deadline) : 'Date'}
          <input
            type="date"
            aria-label="Deadline"
            value={deadline}
            onChange={(e) => setDeadline(e.target.value)}
            className="absolute inset-0 w-full h-full opacity-0 appearance-none cursor-pointer"
          />
          <Ripple />
        </span>
      )}
    </PanelSection>
  );

  const primaryLabel = isEdit || title.trim() || addedCount === 0 ? 'Save' : 'Done';
  const primaryEnabled = isEdit ? !!title.trim() : !!title.trim() || addedCount > 0;
  return (
    // Opens at ~62% and only grows. Pull down anywhere that isn't a control saves and
    // closes — the same commit the backdrop and the X run; a half-filled task is never
    // thrown away.
    <SheetShell onClose={commitAndClose} onSwipeDown={commitAndClose} handle={!desktop} floor={desktop ? 0 : 0.62} maxWidth={maxWidth} placement={desktop ? 'center' : 'bottom'}>
      {/* pt: the title used to sit hard against the handle. Same grey as the section labels
          below it — it is a label for the panel, not content. */}
      <div className="shrink-0 flex flex-row items-center justify-between pt-[10px] pb-[14px]">
        <p className="text-[#5e5e5e] text-[14px]">{isEdit ? 'Edit Task' : addedCount > 0 ? `Added ${addedCount}` : 'New Task'}</p>
        <button type="button" aria-label="Close" onClick={commitAndClose} className="text-[#656464] p-2 -m-2"><X size={16} /></button>
      </div>

      {/* A TEXTAREA, not an input. iOS kept raising the Contact AutoFill bar over the keyboard,
          and autocomplete="off" does not stop it — Safari ignores that hint for contact
          autofill. WebKit only runs the contact classifier over <input> fields, so a one-row
          textarea sidesteps it entirely while looking and behaving identically: Enter is
          intercepted for save/rapid-entry (so it never inserts a newline), and resize and
          scrolling are off. */}
      <textarea
        ref={inputRef}
        rows={1}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save(!isEdit); } }}
        placeholder="New task"
        enterKeyHint={isEdit ? 'done' : 'next'}
        autoCapitalize="sentences"
        autoCorrect="on"
        spellCheck={false}
        autoComplete="off"
        name="ctrl-entry"
        // A full-width capsule on the SAME black the chip tracks use, so the title reads as one
        // more control of the panel rather than a box of its own. Placeholder in the section-
        // label grey for the same reason.
        // rounded-full, not a fixed 22px: 22 happens to be exactly half of this field's 43.6px
        // one-line height, so a fixed radius is a capsule only while that height holds and
        // degrades into a rounded rectangle the moment anything makes the box taller. 9999px
        // always clamps to half the box. Don't reach for leading-* to change the height —
        // index.css forces line-height 1.4 on textarea and the class is a no-op; use py-*.
        // appearance-none: iOS paints its own textarea chrome and quietly ignores the radius
        // without it — which is why this kept coming back as a square box on the phone while
        // rendering as a capsule everywhere else.
        className="shrink-0 w-full appearance-none resize-none overflow-hidden bg-black rounded-full px-[16px] py-[12px] outline-none border-none text-white font-['Univers_BQ:55_Regular',sans-serif] text-[14px] leading-[1.4] placeholder:text-[#5e5e5e]"
      />
      <div className="shrink-0 h-[18px]" />

      {/* Everything is present — no disclosure. The body scrolls when it outgrows the sheet. */}
      {/* data-sheet-scroll: the pull-down gesture defers to this while it is scrolled.
          touch-action pan-y re-enables scrolling inside the overlay, which blocks all touch
          hand-off to the page beneath. */}
      <div data-sheet-scroll className="flex-1 min-h-0 overflow-y-auto overscroll-contain" style={{ touchAction: 'pan-y' }}>
        {/* Desktop: two columns — the fields, and the deadline with its calendar. Phone: one. */}
        <div className={desktop ? 'grid gap-x-[32px]' : ''} style={desktop ? { gridTemplateColumns: 'minmax(0, 1fr) 296px' } : undefined}>
        <div className="min-w-0">
        <PanelSection label="When" feel={feel}>
          {PANES.map((p) => (
            <Capsule key={p.section} active={p.section === section} onClick={() => setSection(p.section)}>{p.label}</Capsule>
          ))}
        </PanelSection>

        <PanelSection label="Category" feel={feel}>
          {listSequence.map((l) => (
            <Capsule key={l} active={l === listId} onClick={() => setListId(l)}>{LIST_TITLES[l]}</Capsule>
          ))}
        </PanelSection>

        {listId !== 'personal' && (
        <PanelSection
          label="Client"
          open={openLabel === 'client'}
          onToggle={() => toggleLabel('client')}
          onCreate={(n) => setClientId(onAddClient(n))}
          createPlaceholder="New client name"
          feel={feel}
        >
          <Capsule active={clientId === ''} onClick={() => chooseClient('')}>None</Capsule>
          {visibleClients.map((c) => (
            <Capsule key={c.id} active={clientId === c.id} onClick={() => chooseClient(c.id)}>{c.short || c.name}</Capsule>
          ))}
        </PanelSection>
        )}

        <PanelSection
          label="Project"
          open={openLabel === 'project'}
          onToggle={() => toggleLabel('project')}
          onCreate={(n) => setProjectId(onAddProject({ name: n, clientId: clientId || undefined, list: listId }))}
          createPlaceholder="New project name"
          feel={feel}
        >
          <Capsule active={projectId === ''} onClick={() => setProjectId('')}>None</Capsule>
          {visibleProjects.map((p) => (
            <Capsule key={p.id} active={projectId === p.id} onClick={() => chooseProject(p.id)}>{p.name}</Capsule>
          ))}
        </PanelSection>

        {!desktop && deadlineSection}

        <PanelSection label="People" feel={feel}>
          {people.map((pr) => {
            const on = assignees.includes(pr.short);
            return (
              <Capsule
                key={pr.id}
                active={on}
                onClick={() => setAssignees((a) => (on ? a.filter((x) => x !== pr.short) : [...a, pr.short]))}
              >{pr.name}</Capsule>
            );
          })}
        </PanelSection>

        <PanelSection label="Type" feel={feel}>
          <Capsule active={!milestone} onClick={() => setMilestone(false)}>Task</Capsule>
          <Capsule active={milestone} onClick={() => setMilestone(true)}>Milestone</Capsule>
        </PanelSection>
        </div>
        {desktop && (
          // The desktop has the room: the calendar sits beside the fields, always open, and is
          // the picker for any day the capsules above it don't name.
          <div className="min-w-0">
            {deadlineSection}
            <MonthCalendar value={deadline} onChange={setDeadline} todayIso={isos[0]} />
          </div>
        )}
        </div>
      </div>

      {/* Centred pill with a little air above and below — not a full-width bar, not a
          button adrift on a panel twice its height. White on the app accent, like every other
          accent button. Not the only way out either: the backdrop, the X and a pull-down all
          commit — this is the explicit version of the same thing. */}
      <div className="shrink-0 flex flex-row justify-center pt-[10px] pb-[6px]">
        <button
          type="button"
          onClick={() => save(false)}
          disabled={!primaryEnabled}
          className={`h-[38px] min-w-[168px] px-[24px] rounded-full text-[14px] font-['Univers_BQ:55_Regular',sans-serif] transition-colors ${primaryEnabled ? 'bg-[var(--app-accent)] text-white' : 'bg-[#2b2a27] text-[#5e5e5e]'}`}
        >
          {primaryLabel}
          {!desktop && <Ripple color="rgba(255, 255, 255, 0.18)" haloColor="rgba(255, 255, 255, 0.26)" />}
        </button>
      </div>
    </SheetShell>
  );
}
