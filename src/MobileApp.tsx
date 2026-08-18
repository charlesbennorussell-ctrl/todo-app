// MobileApp — the iPhone-first Focus shell. Mounts below 768px (Shell in main.tsx).
//
// Design contract (learned the hard way in v0.1.36→37): this must read as the SAME app
// as the desktop — same fonts, same grays, same purple, same card anatomy, same checkbox.
// It's a phone-native LAYOUT of the desktop Focus page, not a new design:
//
//   ┌───────────────────────────┐
//   │  Today   Tomorrow   Next  │  ← day tabs (tap to jump, swipe anywhere to slide)
//   ├───────────────────────────┤
//   │  Work                     │  ← the desktop Focus day-column, one day per screen
//   │   [card]                  │     (identical bands + cards via the shared
//   │   [card]                  │      computeCalendarDistribution engine)
//   │  Projects                 │
//   │   [card]                  │
//   ├───────────────────────────┤
//   │  ⌗   ▦   ≡   ⌂      (+)  │  ← the four nav icons + plus, docked at the bottom
//   └───────────────────────────┘
//
// Interactions:
//   swipe L/R          slide between Today / Tomorrow / Next (transform pager)
//   tap checkbox       2-stage toggle (pending → started → completed) — desktop toggleTask
//   long-press card    lift + drag to reorder (dnd-kit, desktop-tuned TouchSensor 250/10);
//                      while dragging, day tabs light up as drop targets — drop a card on
//                      "Tomorrow" to move it there (desktop cal-drop semantics)
//   tap card           bottom sheet: rename / When (Today·Tomorrow·Next) / delete
//   bottom +           quick-entry sheet: title + list + When, lands like the desktop's
//                      band "+" (bottom of the band)
//
// iOS traps consciously avoided (from the v0.1.40–52 archaeology):
//   - no animated opacity fades on the drag source (inline visibility swap instead)
//   - no will-change on rows that transform during drags
//   - DragOverlay measures the source rect itself (TouchSensor can beat dnd-kit's measuring)
//   - tap detection never trusts click timing; the checkbox handles its own pointerdown
//   - text inputs commit on blur AND on input (predictive text fires no keydown)

import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStorage, useMutation } from '@liveblocks/react/suspense';
import {
  DndContext, DragOverlay, MeasuringStrategy, MouseSensor, TouchSensor,
  useSensor, useSensors, useDroppable, pointerWithin,
  type DragStartEvent, type DragEndEvent, type CollisionDetection,
} from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { List, FolderTree, SquareKanban, Plus, Trash2, Pencil, X } from 'lucide-react';
import { MdOutlineCalendarMonth } from 'react-icons/md';
import type { Task, Project, Client, Person, ListId, SectionId } from './data';
import { LIST_TITLES, LISTS, PERSONAL_CLIENT_ID, formatDeadline, isLateDeadline, todayISO } from './data';
import { useMembership, projectAllowed } from './auth';
import {
  computeCalendarDistribution, makeCpCompare, TaskCheckbox, Arrowhead, DeadlineArrow,
  addDaysToDate, dateToISO, useSharedTheme, useSharedSubGroup, doneTint, convertTitleCase, useSharedCaseMode,
  buildSubGroupsShared,
} from './App';

// ── Shared module state ───────────────────────────────────────────────────────

const PANES: { section: SectionId; label: string }[] = [
  { section: 'today', label: 'Today' },
  { section: 'tomorrow', label: 'Tomorrow' },
  { section: 'next', label: 'Next' },
];

// Same settings the desktop reads — the phone honors them so both surfaces agree.
const readListSequence = (): ListId[] => {
  const fallback: ListId[] = ['work', 'projects', 'admin', 'personal'];
  try {
    const v = JSON.parse(window.localStorage.getItem('todo-app-list-sequence') || 'null');
    if (Array.isArray(v) && v.length >= 3) {
      const seq = (v as ListId[]).filter((l) => fallback.includes(l));
      for (const l of fallback) if (!seq.includes(l)) seq.push(l);
      if (seq.length === fallback.length) return seq;
    }
  } catch { /* fall back */ }
  return fallback;
};
const readSortByCP = () => { try { return window.localStorage.getItem('todo-app-sort-cp') === '1'; } catch { return false; } };
const readUserShort = () => { try { return window.localStorage.getItem('todo-app-user-short') || 'B'; } catch { return 'B'; } };

const isPrivateTask = (t: Task) => t.list === 'personal' || t.clientId === PERSONAL_CLIENT_ID;


// Debug overlay (?debug=1): the v0.1.49 lesson — on-device logs beat blind iteration.
const DEBUG = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('debug');
const debugLog: string[] = [];
let debugTick: (() => void) | null = null;
function dbg(msg: string) {
  if (!DEBUG) return;
  debugLog.push(`${new Date().toISOString().slice(14, 23)} ${msg}`);
  if (debugLog.length > 24) debugLog.shift();
  debugTick?.();
}

// ── Card ──────────────────────────────────────────────────────────────────────
// The desktop CalendarCard's two-line stacked layout, sized up for touch (52px vs 45px
// min-height). Same classes, same colors, same checkbox — reads as the same app.

function MobileCardBody({ task, projects, clients, isTodayCard, hideClient = false, hideProject = false }: {
  task: Task; projects: Project[]; clients: Client[]; isTodayCard: boolean;
  /** The sub-group heading above already names it — repeating it on every card is noise.
   *  Same two props, for the same reason, as the desktop's grouped columns. */
  hideClient?: boolean; hideProject?: boolean;
}) {
  const projectRaw = task.projectId ? projects.find((p) => p.id === task.projectId) : undefined;
  const project = hideProject ? undefined : projectRaw;
  // Resolve the client from the RAW project: hiding the project must not also strip the
  // client it implies, or a card under a client heading would lose both.
  const resolvedClientId = task.clientId ?? projectRaw?.clientId;
  const client = hideClient || !resolvedClientId ? undefined : clients.find((c) => c.id === resolvedClientId);
  const isScheduled = task.type === 'scheduled';
  const titleColor = task.completed ? 'text-[#383838]' : isScheduled ? 'text-[var(--app-accent)]' : isTodayCard ? 'text-white' : 'text-[#a8a8a8]';
  const metaColor = (isScheduled || isTodayCard) ? 'text-[var(--app-accent)]' : 'text-[#656464]';
  // A finished card speaks with ONE voice, exactly as on the desktop. The title
  // used to drop to gray while metaColor kept its Today purple, so completing a
  // task on the phone left the card half purple, half gray. doneTint is shared
  // with App.tsx so the two surfaces can't drift apart again.
  const done = task.completed;
  const doneCol = doneTint(isTodayCard);
  const doneStyle = done ? { color: doneCol } : undefined;

  // ONE line by default; drop to two ONLY when the content genuinely doesn't fit. An invisible
  // single-line probe with the exact same content measures overflow (scrollWidth > clientWidth);
  // a ResizeObserver re-checks on width changes (rotation, pane resize). No guesswork with
  // character counts — the probe uses the real fonts and real components.
  const probeRef = useRef<HTMLDivElement | null>(null);
  const [stacked, setStacked] = useState(false);
  useEffect(() => {
    const el = probeRef.current;
    if (!el) return;
    const check = () => setStacked(el.scrollWidth > el.clientWidth + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.title, task.deadline, task.completed, task.assignees.length, client?.short, project?.name]);

  const meta = (
    <>
      {/* All three client/project forms use metaColor, so they go accent-purple on a TODAY card
          the same way the date and assignee badges already do. The combined and project-only
          forms used to hardcode #656464, which is why Today's client/project stayed grey while
          everything else on the card turned purple. The arrowhead between them follows too. */}
      {client && project && <p style={doneStyle} className={`font-['Univers_BQ:55_Regular',sans-serif] text-[11.5px] whitespace-nowrap shrink-0 ${metaColor}`}>{client.short}<Arrowhead dim={task.completed} color={done ? doneCol : isTodayCard && !task.completed ? 'var(--app-accent)' : undefined} />{project.name}</p>}
      {client && !project && <p style={doneStyle} className={`font-['Univers_BQ:55_Regular',sans-serif] text-[11.5px] whitespace-nowrap shrink-0 ${metaColor}`}>{client.short}</p>}
      {!client && project && <p style={doneStyle} className={`font-['Univers_BQ:55_Regular',sans-serif] text-[11.5px] whitespace-nowrap shrink-0 ${metaColor}`}>{project.name}</p>}
      {/* Assignee initials are deliberately NOT rendered on the phone — it's a single-user
          surface and the circles just crowded a narrow row. `assignees` is untouched in the
          data; it still drives personal-task privacy and shows on the desktop. */}
      {/* A real deadline gets the desktop's arrow ahead of the date. `small` is the narrower
          11px variant (vs 18px) so it reads on a phone row without eating the title's space. */}
      {/* The shared arrow carries a -2px optical lift tuned for the desktop's larger rows; on a
          phone row it reads high, so nudge it back down to sit on the date's baseline. */}
      {task.deadline && (
        <span className="inline-flex shrink-0" style={{ transform: 'translateY(3px)' }}>
          <DeadlineArrow small dim={task.completed} dimColor={done ? doneCol : undefined} color={(isScheduled || isTodayCard) ? 'var(--app-accent)' : undefined} />
        </span>
      )}
      {task.deadline && <p style={doneStyle} className={`font-['NB_International:Regular',sans-serif] text-[11.5px] whitespace-nowrap shrink-0 ${(isScheduled || isTodayCard) ? 'text-[var(--app-accent)]' : isLateDeadline(task.deadline) ? 'text-white' : 'text-[#656464]'}`}>{formatDeadline(task.deadline)}</p>}
    </>
  );
  const checkbox = !isScheduled && (
    <div className="shrink-0 flex items-center justify-center">
      <TaskCheckbox completed={task.completed} started={task.started} onToggle={() => {}} doneColor={done ? doneCol : undefined} accent={isTodayCard ? 'var(--app-accent)' : undefined} />
    </div>
  );
  const title = <span style={doneStyle} className={`font-['Univers_BQ:55_Regular',sans-serif] text-[13px] whitespace-nowrap overflow-hidden text-ellipsis ${titleColor}`}>{task.title || 'New Task'}</span>;

  return (
    <div className="relative pl-[12px] pr-[40px] py-[8px] overflow-hidden h-full flex flex-col justify-center gap-[2px]">
      {/* Measuring probe — invisible, single-line, identical content */}
      <div ref={probeRef} aria-hidden className="absolute inset-x-0 top-0 px-[12px] invisible overflow-hidden flex flex-row items-center gap-[10px] whitespace-nowrap pointer-events-none">
        {checkbox}
        <span className="font-['Univers_BQ:55_Regular',sans-serif] text-[13px] whitespace-nowrap">{task.title || 'New Task'}</span>
        <span className="flex flex-row items-center gap-[6px] shrink-0">{meta}</span>
      </div>
      {stacked ? (
        <>
          <div className="flex flex-row items-center gap-[10px]">
            {checkbox}
            {title}
          </div>
          <div className="flex flex-row items-center gap-[6px] pl-[22px] min-h-[15px]">{meta}</div>
        </>
      ) : (
        <div className="flex flex-row items-center gap-[10px]">
          {checkbox}
          {title}
          {/* Meta HUGS the title rather than being pushed to the right edge — the client and
              project read as part of the task's name, not as a separate right-hand column.
              (No ml-auto.) The title carries overflow-hidden, which zeroes a flex item's
              automatic minimum size, so a long title truncates instead of shoving the meta
              off the card. */}
          <span className="flex flex-row items-center gap-[6px] shrink-0">{meta}</span>
        </div>
      )}
    </div>
  );
}

function MobileCard({ task, cellId, projects, clients, isTodayCard, hideClient, hideProject, onToggle, onOpen, onAddSibling }: {
  task: Task; cellId: string; projects: Project[]; clients: Client[]; isTodayCard: boolean;
  hideClient?: boolean; hideProject?: boolean;
  onToggle: () => void; onOpen: () => void; onAddSibling: () => void;
}) {
  const isScheduled = task.type === 'scheduled';
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    data: { type: 'task', task, calendarCellId: cellId },
    disabled: isScheduled, // milestones aren't draggable on the phone (v1)
    transition: { duration: 350, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
  });
  // iOS drag-source rule (v0.1.41): while dragging, hide the source with a synchronous
  // visibility swap and DROP its sortable transform — never an animated opacity fade
  // (mid-transition ghosts) and never will-change (stale compositor snapshots).
  const style: React.CSSProperties = {
    transform: isDragging ? undefined : CSS.Transform.toString(transform),
    transition,
    visibility: isDragging ? 'hidden' : undefined,
    touchAction: 'manipulation',
    ...(isTodayCard ? { backgroundColor: 'rgb(from var(--app-accent) r g b / 0.1)' } : {}),
  };
  // Tap detection (v0.1.43): explicit touch bookkeeping — iOS clicks lie. The tap window is
  // ≤10px AND ≤230ms: strictly SHORTER than the TouchSensor's 250ms long-press delay, so a
  // held finger can never read as both "tap" and "drag" at once.
  const tapRef = useRef<{ x: number; y: number; t: number } | null>(null);
  const padTapRef = useRef<{ x: number; y: number; t: number } | null>(null);
  const plusTapRef = useRef<{ x: number; y: number; t: number } | null>(null);
  // dnd-kit's listeners include the TouchSensor's own onTouchStart activator. Spreading it and
  // then declaring our own onTouchStart would CLOBBER it (later prop wins) and silently kill
  // long-press dragging on real touch devices — so compose the two by hand.
  const { onTouchStart: dndTouchStart, ...restListeners } = (listeners ?? {}) as Record<string, (e: any) => void>;
  return (
    <div
      ref={setNodeRef}
      data-mcard={task.id}
      style={style}
      className={`relative mx-[10px] mb-[5px] rounded-[3.333px] min-h-[44px] flex flex-col justify-center ${isTodayCard ? '' : 'bg-white/[0.03]'}`}
      {...attributes}
      {...restListeners}
      onTouchStart={(e) => {
        const t = e.touches[0];
        tapRef.current = { x: t.clientX, y: t.clientY, t: Date.now() };
        dndTouchStart?.(e);
      }}
      onTouchEnd={(e) => {
        const s = tapRef.current; tapRef.current = null;
        if (!s) return;
        const t = e.changedTouches[0];
        const dx = Math.abs(t.clientX - s.x), dy = Math.abs(t.clientY - s.y);
        if (dx <= 10 && dy <= 10 && Date.now() - s.t <= 230) {
          // Checkbox handles its own tap (stopPropagation) — reaching here means card body.
          // Milestones are read-only here: the sheet's When chips and Delete are written for
          // todos, and applying them to a scheduled milestone would silently reschedule or
          // trash a project marker. Editing milestones stays on the desktop.
          if (isScheduled) { dbg(`tap milestone ${task.id} (read-only)`); return; }
          dbg(`tap card ${task.id}`);
          onOpen();
        }
      }}
      onClick={(e) => {
        // Mouse path (desktop testing). Touch taps were already handled above; iOS's
        // synthetic click after touchend is ignored via the detail===0 sniff being
        // unreliable — instead suppress clicks that follow a recent touch tap.
        if ((e as React.MouseEvent).detail === 0) return;
        if (lastTouchAt.current && Date.now() - lastTouchAt.current < 700) return;
        if (isScheduled) return; // milestones are read-only on the phone (see onTouchEnd)
        onOpen();
      }}
    >
      <MobileCardBody task={task} projects={projects} clients={clients} isTodayCard={isTodayCard} hideClient={hideClient} hideProject={hideProject} />
      {/* "+" on the right edge — a new task carrying this one's category, project, client and
          deadline, opened straight into the sheet so you can name it. Same movement-guarded tap
          as the checkbox pad: a swipe or scroll that starts here must still pan, not fire. */}
      {!isScheduled && (
        <button
          type="button"
          aria-label="Add task in same project"
          className={`absolute right-0 top-0 bottom-0 w-[44px] flex items-center justify-center ${isTodayCard ? 'text-[var(--app-accent)]' : 'text-[#4a4a4a]'}`}
          onPointerDown={(e) => { if (e.pointerType === 'mouse') e.stopPropagation(); }}
          onTouchStart={(e) => { const t = e.touches[0]; plusTapRef.current = { x: t.clientX, y: t.clientY, t: Date.now() }; }}
          onTouchEnd={(e) => {
            const s = plusTapRef.current; plusTapRef.current = null;
            if (!s) return;
            const t = e.changedTouches[0];
            if (Math.abs(t.clientX - s.x) <= 10 && Math.abs(t.clientY - s.y) <= 10 && Date.now() - s.t <= 230) {
              e.stopPropagation(); e.preventDefault();
              dbg(`plus ${task.id}`);
              onAddSibling();
            }
          }}
          onClick={(e) => {
            e.stopPropagation();
            if (lastTouchAt.current && Date.now() - lastTouchAt.current < 700) return;
            onAddSibling();
          }}
        >
          <Plus size={15} />
        </button>
      )}
      {/* Checkbox tap pad — 40px invisible target over the 12px box. Touchstart is NOT
          stopped (a swipe/scroll starting on the pad must still pan/scroll normally);
          instead the toggle only fires on a genuine tap (≤10px, ≤230ms). */}
      {!isScheduled && (
        <button
          type="button"
          aria-label="Toggle task"
          className="absolute left-0 top-0 bottom-0 w-[40px]"
          onPointerDown={(e) => { if (e.pointerType === 'mouse') e.stopPropagation(); }}
          onTouchStart={(e) => { const t = e.touches[0]; padTapRef.current = { x: t.clientX, y: t.clientY, t: Date.now() }; }}
          onTouchEnd={(e) => {
            const s = padTapRef.current; padTapRef.current = null;
            if (!s) return;
            const t = e.changedTouches[0];
            if (Math.abs(t.clientX - s.x) <= 10 && Math.abs(t.clientY - s.y) <= 10 && Date.now() - s.t <= 230) {
              e.stopPropagation(); e.preventDefault();
              dbg(`toggle ${task.id}`);
              onToggle();
            }
          }}
          onClick={(e) => {
            e.stopPropagation();
            if (lastTouchAt.current && Date.now() - lastTouchAt.current < 700) return;
            onToggle();
          }}
        />
      )}
    </div>
  );
}

// Module-level "a touch happened" stamp — used to swallow iOS's trailing synthetic clicks.
const lastTouchAt = { current: 0 };
if (typeof window !== 'undefined') {
  window.addEventListener('touchend', () => { lastTouchAt.current = Date.now(); }, { capture: true, passive: true });
}

// ── Band (one list inside a pane) ─────────────────────────────────────────────

function BandDroppable({ id, children, isEmpty }: { id: string; children: React.ReactNode; isEmpty: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div ref={setNodeRef} className={`${isEmpty ? 'min-h-[34px]' : ''} ${isOver && isEmpty ? 'bg-white/[0.02] rounded-[3.333px] mx-[10px]' : ''}`}>
      {children}
    </div>
  );
}

// Whole-pane droppable — the desktop rule "the hotspot is the entire column": releasing a
// card in the empty space below the last band still lands it (own band, end position).
function PaneDroppable({ id, width, children }: { id: string; width: number; children: React.ReactNode }) {
  const { setNodeRef } = useDroppable({ id });
  return (
    <div ref={setNodeRef} className="h-full overflow-y-auto overscroll-contain pb-[20px]" style={{ width, WebkitOverflowScrolling: 'touch' }}>
      {children}
    </div>
  );
}

// ── Sheets ────────────────────────────────────────────────────────────────────

function SheetShell({ onClose, grabber, children }: {
  onClose: () => void;
  /** Touch handlers for the pull-up gesture the grab bar advertises. Passing them is what
      renders the bar: a sheet with no pull-up target must not show a handle it can't honour. */
  grabber?: { onTouchStart: (e: React.TouchEvent) => void; onTouchEnd: (e: React.TouchEvent) => void };
  children: React.ReactNode;
}) {
  // iOS fires the synthetic click 0-300ms AFTER the touch tap that opened this sheet — the
  // stray click lands on the fresh backdrop and would close it instantly. Ignore backdrop
  // clicks for the first 500ms of the sheet's life.
  const openedAtRef = useRef(Date.now());
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
  const keyboardUp = typeof window !== 'undefined' && vvBox.height > 0 && window.innerHeight - vvBox.height > 80;
  // The sheet's height has always been pure content — there is no floor anywhere — so the quick
  // task sheet opened at 216px, a quarter of an iPhone screen, and read as a strip rather than a
  // panel. Measure the floor against the WHOLE window, not the visible box, so it doesn't
  // collapse the moment the keyboard takes half the screen. Clamp it to vvBox.height because
  // min-height BEATS max-height: an unclamped floor in landscape would put the sheet's top —
  // the title field — back off screen, which is the failure the block above spent two attempts
  // fixing.
  const sheetFloor = typeof window === 'undefined' ? 0 : Math.min(Math.round(window.innerHeight / 3), vvBox.height);
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
    <div className="fixed left-0 right-0 z-50" style={{ top: vvBox.top, height: vvBox.height }}>
      <div className="absolute inset-0 bg-black/50" onClick={() => { if (Date.now() - openedAtRef.current > 500) onClose(); }} />
      {/* Sheet sits at the bottom of the visible box and can never exceed it, so its top — the
          title field — is always on screen. Children lay out as a flex column, so the child
          marked flex-1 becomes the scrolling middle while the title and the primary button
          stay pinned. */}
      <div
        data-msheet
        className="absolute left-0 right-0 bottom-0 flex flex-col rounded-t-[40px] px-[18px]"
        style={{
          backgroundColor: SHEET_BG,
          maxHeight: '100%',
          minHeight: sheetFloor,
          // 40px = the title capsule's 22px radius plus the sheet's own 18px gutter, so the
          // sheet's corner stays concentric with the field inside it — and it lands inside the
          // 39-55px range real iPhone displays use, which is what lets a full-bleed sheet read as
          // part of the screen rather than as a card pasted on top of it. The top of that range
          // would eat a fifth of the panel's height and crowd the capsule.
          //
          // The grab bar lives in the top padding, so that padding shrinks when it is present.
          paddingTop: grabber ? 8 : 16,
          // The home-indicator pad only means anything when the sheet rests on the screen
          // bottom; with the keyboard up it is sitting on the keyboard instead.
          paddingBottom: keyboardUp ? 14 : 'calc(env(safe-area-inset-bottom) + 18px)',
          animation: 'msheet-up 240ms cubic-bezier(0.16, 1, 0.3, 1)',
        }}
      >
        {/* The pill is 5x36 like the system's, but the target around it is 88x21 — you cannot
            start a swipe on a 5px bar. Same handlers as the lower controls, so the handle
            answers the exact gesture it advertises instead of just hinting at it. */}
        {grabber && (
          <div {...grabber} aria-hidden className="shrink-0 mx-auto mb-[6px] px-[26px] py-[8px]">
            <div className="h-[5px] w-[36px] rounded-full bg-[#4a4a4a]" />
          </div>
        )}
        {children}
      </div>
      <style>{`@keyframes msheet-up { from { transform: translateY(100%); } to { transform: translateY(0); } }`}</style>
    </div>
  );
}

// Capsules speak the day-switcher's language: the GROUP is a near-black track, the SELECTED
// capsule is the page-background colour sitting on it (the switcher's knob), selected text is
// white, and everything unselected recedes to the same grey the switcher uses. No borders.
// The sheet's own surface colour. The SELECTED capsule uses it, so a chosen chip reads as a
// piece of the sheet lifted onto the darker track beneath it.
const SHEET_BG = '#232220';
// Track hugs its capsules (inline-flex) instead of stretching edge to edge — two People chips
// get a two-chip-wide track, not a full-width bar. max-w-full lets long lists still wrap.
const CHIP_TRACK = 'inline-flex flex-row flex-wrap items-center gap-[4px] rounded-[21px] bg-black p-[3px] max-w-full';
const CHIP_BASE = "h-[36px] inline-flex items-center px-[14px] rounded-full text-[13px] font-['Univers_BQ:55_Regular',sans-serif] transition-colors";
const chipCls = (active: boolean) => `${CHIP_BASE} ${active ? 'bg-[#232220] text-white' : 'bg-transparent text-[#656464]'}`;

// ── The app ───────────────────────────────────────────────────────────────────

export default function MobileApp() {
  const tasks = (useStorage((root) => root.tasks) || []) as Task[];
  const projects = (useStorage((root) => root.projects) || []) as Project[];
  const clients = (useStorage((root) => root.clients) || []) as Client[];
  const people = (useStorage((root) => root.people) || []) as Person[];

  const setTasks = useMutation(({ storage }, updater: (prev: Task[]) => Task[]) => {
    const current = (storage.get('tasks' as never) as Task[] | undefined) || [];
    storage.set('tasks' as never, updater(current) as never);
  }, []);

  /** Create a client from the task panel. `short` is the badge text the cards render. */
  const addClient = useMutation(({ storage }, name: string) => {
    const id = `client-${Date.now()}`;
    const current = (storage.get('clients' as never) as Client[] | undefined) || [];
    // Short code: first word, capped at 6 chars — matches the compact badges on cards.
    const short = name.trim().split(/\s+/)[0].slice(0, 6);
    storage.set('clients' as never, [...current, { id, name: name.trim(), short }] as never);
    return id;
  }, []);

  /** Create a project, optionally owned by a client and pinned to a category. */
  const addProject = useMutation(({ storage }, p: { name: string; clientId?: string; list?: ListId }) => {
    const id = `project-${Date.now()}`;
    const current = (storage.get('projects' as never) as Project[] | undefined) || [];
    storage.set('projects' as never, [...current, { id, name: p.name.trim(), clientId: p.clientId, list: p.list }] as never);
    return id;
  }, []);

  // Same room theme the desktop paints with — this is what keeps the two surfaces identical.
  useSharedTheme();
  // …and the same three sub-grouping switches, off the same room key. Pane index IS the scope,
  // matching PANES above: 0 Today, 1 Tomorrow, 2 Next.
  const subGroup = useSharedSubGroup();
  const paneGrouped = [subGroup.today, subGroup.tomorrow, subGroup.next];
  // Layout diagnostics (long-press the header). Exists because the bottom bar sitting off the
  // screen bottom reproduces ONLY in the installed standalone PWA — desktop Chrome reports every
  // env(safe-area-inset-*) as 0, so the failing condition can't be recreated here. Measure on the
  // device instead of guessing.
  const [diag, setDiag] = useState(false);
  const holdRef = useRef<number | null>(null);
  // Verified identity when the auth gate is on; legacy localStorage otherwise.
  const membership = useMembership();
  const currentUserShort = membership?.person_short || readUserShort();
  if (DEBUG && typeof window !== 'undefined') (window as any).__mtasks = tasks;
  const listSequence = useMemo(readListSequence, []);
  const sortByCP = useMemo(readSortByCP, []);
  // Auto-capitalisation. Read from the ROOM (falling back to this device's cache pre-connect),
  // so toggling it in desktop Settings takes effect here without the phone owning a settings UI.
  const caseMode = useSharedCaseMode();
  // Names whose capitalisation is authoritative and outranks the case rules. Same list the
  // desktop builds into vocabRef.
  const titleVocab = useMemo(() => {
    const v: string[] = [];
    for (const c of clients) { if (c.short) v.push(c.short); if (c.name) v.push(c.name); }
    for (const p of projects) { if (p.name) v.push(p.name); }
    for (const pr of people) { if (pr.short) v.push(pr.short); if (pr.name) v.push(pr.name); }
    return v;
  }, [clients, projects, people]);
  const convertTitle = useCallback((s: string) => convertTitleCase(s, caseMode, titleVocab), [caseMode, titleVocab]);

  // Re-render pulse. The 60s interval (wired below) keeps day boundaries honest; toggleTask
  // also fires one at 15.1s so a task that just went "started" re-sorts the moment its hold
  // expires instead of waiting up to a minute for the next tick. Desktop does the same.
  const [clockTick, setClockTick] = useState(0);

  // ── Mutations (desktop semantics, verbatim) ────────────────────────────────
  const toggleTask = useCallback((id: string) => {
    setTasks((prev) => prev.map((t) => {
      if (t.id !== id) return t;
      if (t.completed) return { ...t, completed: false, completedDay: undefined, completedAt: undefined, started: false, startedAt: undefined, revivedAt: Date.now() };
      if (t.started) return { ...t, completed: true, completedDay: todayISO(), completedAt: Date.now(), revivedAt: undefined };
      return { ...t, started: true, startedAt: Date.now() };
    }));
    window.setTimeout(() => setClockTick((n) => n + 1), 15100);
  }, [setTasks]);

  // Capitalise on the way INTO storage, not on a timer. The desktop can defer 2s after blur
  // because its title is a live inline editable still on screen; here the write only happens
  // once the sheet's field has committed, so there is no visible field to rewrite under the
  // user — and an iOS webview suspended on sheet-close would never fire a pending timeout.
  const renameTask = useCallback((id: string, title: string) => {
    const next = convertTitle(title);
    setTasks((prev) => {
      const cur = prev.find((t) => t.id === id);
      // Storage here is a whole-array write, and this room has lost data to
      // concurrent whole-array writes before. A rename that changes nothing must
      // not become one.
      if (!cur || cur.title === next) return prev;
      return prev.map((t) => (t.id === id ? { ...t, title: next } : t));
    });
  }, [setTasks, convertTitle]);

  /** Patch any field set on a task — what the full panel writes back when editing. */
  const updateTask = useCallback((id: string, patch: Partial<Task>) => {
    // Title is optional on a patch, and an absent key must stay absent rather than become ''.
    const next = patch.title === undefined ? patch : { ...patch, title: convertTitle(patch.title) };
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...next } : t)));
  }, [setTasks, convertTitle]);

  const deleteTask = useCallback((id: string) => {
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, trashed: true, trashedAt: Date.now(), revivedAt: undefined } : t)));
  }, [setTasks]);

  // Monotonic suffix so two creations inside the same millisecond (rapid entry, a fast double
  // tap) can't collide on `task-<Date.now()>`.
  const idSeq = useRef(0);
  const newId = () => `task-${Date.now()}-${idSeq.current++}`;

  /** Create a task with the desktop's full field set. Appends to the bottom of its bucket. */
  const createTask = useCallback((p: {
    title: string; list: ListId; section: SectionId;
    projectId?: string; clientId?: string; deadline?: string;
    assignees?: string[]; milestone?: boolean;
  }) => {
    const id = newId();
    // Computed outside the updater so it runs once, not on every replay of it. The band "+"
    // and the empty-band ADD card pass '', which the converter returns untouched.
    const title = convertTitle(p.title);
    setTasks((prev) => {
      const maxOrder = prev.filter((x) => x.list === p.list && x.section === p.section).reduce((m, x) => Math.max(m, x.order), -1);
      return [...prev, {
        id,
        title,
        type: p.milestone ? ('scheduled' as const) : ('todo' as const),
        assignees: p.assignees ?? (currentUserShort ? [currentUserShort] : []),
        completed: false,
        list: p.list,
        section: p.section,
        order: maxOrder + 1,
        projectId: p.projectId,
        clientId: p.clientId,
        deadline: p.deadline,
        createdAt: Date.now(),
      }];
    });
    return id;
  }, [setTasks, currentUserShort, convertTitle]);

  /** The card "+" — a sibling of `src` carrying its category, section, project, client, deadline
   *  and type, inserted directly beneath it. Mirrors the desktop's addSiblingTask, including
   *  renumbering the bucket so the new row actually lands next to its source. */
  const addSibling = useCallback((src: Task) => {
    const id = newId();
    setTasks((prev) => {
      const bucket = prev.filter((t) => t.list === src.list && t.section === src.section).sort((a, b) => a.order - b.order);
      const idx = bucket.findIndex((t) => t.id === src.id);
      const created: Task = {
        id, title: '',
        type: src.type === 'scheduled' ? 'scheduled' : 'todo',
        assignees: currentUserShort ? [currentUserShort] : [],
        completed: false,
        list: src.list, section: src.section, order: 0,
        projectId: src.projectId, clientId: src.clientId, deadline: src.deadline,
        createdAt: Date.now(),
      };
      const insertAt = idx >= 0 ? idx + 1 : bucket.length;
      const reordered = [...bucket.slice(0, insertAt), created, ...bucket.slice(insertAt)].map((t, i) => ({ ...t, order: i }));
      const untouched = prev.filter((t) => !(t.list === src.list && t.section === src.section));
      return [...untouched, ...reordered];
    });
    return id;
  }, [setTasks, currentUserShort]);

  // Move/reorder — a direct port of the desktop's `cal:` drop branch (App.tsx handleDragEnd).
  // targetDate/targetSection follow the pane; dated tasks get RESCHEDULED to the target date,
  // undated tasks move section-only. Both buckets renumber 0..n.
  const dropTask = useCallback((srcTask: Task, targetDate: string, targetSection: SectionId, intendedOverTaskId: string | null, droppedInOwnBand: boolean) => {
    const targetList = srcTask.list; // no Ctrl on a phone — category never changes on drop
    const isQueueTask = !srcTask.deadline;
    dbg(`drop ${srcTask.id} d=${srcTask.deadline || '-'} -> ${targetSection}@${targetDate} over=${intendedOverTaskId || '-'} own=${droppedInOwnBand}`);
    setTasks((prev) => {
      const src = prev.find((t) => t.id === srcTask.id);
      if (!src) return prev;
      const without = prev.filter((t) => t.id !== src.id);
      const moved: Task = isQueueTask
        ? { ...src, list: targetList, section: targetSection }
        : { ...src, list: targetList, section: targetSection, deadline: targetDate };
      const toBucket = without.filter((t) => t.list === targetList && t.section === targetSection).sort((a, b) => a.order - b.order);
      let insertAt: number;
      const deferringToNext = targetSection === 'next' && src.section !== 'next';
      if (deferringToNext) insertAt = 0;
      else if (droppedInOwnBand && intendedOverTaskId) {
        const idx = toBucket.findIndex((t) => t.id === intendedOverTaskId);
        insertAt = idx >= 0 ? idx : 0;
      } else if (droppedInOwnBand) insertAt = toBucket.length;
      else insertAt = 0;
      const reorderedTo = [...toBucket.slice(0, insertAt), moved, ...toBucket.slice(insertAt)].map((t, i) => ({ ...t, order: i }));
      const fromOthers = without.filter((t) => t.list === src.list && t.section === src.section && t.id !== src.id).map((t, i) => ({ ...t, order: i }));
      const untouched = without.filter((t) => !(t.list === src.list && t.section === src.section) && !(t.list === targetList && t.section === targetSection));
      const sameBucket = src.list === targetList && src.section === targetSection;
      if (sameBucket) return [...untouched, ...reorderedTo];
      return [...untouched, ...fromOthers, ...reorderedTo];
    });
  }, [setTasks]);

  // ── Distribution (the desktop Focus engine, verbatim) ──────────────────────
  const calendarTasks = useMemo(
    () => tasks.filter((t) => !t.trashed && (!isPrivateTask(t) || t.assignees.includes(currentUserShort)) && projectAllowed(membership, t.projectId)),
    [tasks, currentUserShort, membership]
  );
  // Re-render each minute so "today" boundaries and completion-hiding stay honest overnight.
  useEffect(() => { const h = window.setInterval(() => setClockTick((n) => n + 1), 60000); return () => window.clearInterval(h); }, []);

  // Anchored to the REAL calendar day (midnight, matching the desktop's focus strip). The
  // minute tick above re-renders; when the date string flips at midnight this memo re-anchors
  // and every pane rolls forward automatically.
  const todayStamp = dateToISO(new Date());
  const anchor = useMemo(() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }, [todayStamp]); // eslint-disable-line react-hooks/exhaustive-deps
  const isos = useMemo(() => [...Array(9)].map((_, i) => dateToISO(addDaysToDate(anchor, i))), [anchor]);
  // Stable ref mirror for the collision callback (deps [] — it must not re-create mid-drag).
  const isosRef = useRef(isos);
  isosRef.current = isos;
  const cells = useMemo(
    () => computeCalendarDistribution(calendarTasks, anchor, 9, listSequence, projects, clients, sortByCP, 60, 30),
    // clockTick is REQUIRED: the started-hold is time-based, so the distribution must be
    // recomputed when the clock crosses it (toggleTask pulses at 15.1s, the interval at 60s).
    [calendarTasks, anchor, listSequence, projects, clients, sortByCP, clockTick]
  );

  // Assemble one pane's bands. Today=iso[0], Tomorrow=iso[1], Next=isos[2..8] flattened
  // (dated pile at top, or global client/project sort when the desktop toggle is on).
  const paneBands = useCallback((paneIdx: number): { listId: ListId; cellId: string; tasks: Task[] }[] => {
    const paneIsos = paneIdx === 0 ? [isos[0]] : paneIdx === 1 ? [isos[1]] : isos.slice(2);
    return listSequence.map((listId) => {
      const bucketRaw = paneIsos.flatMap((iso) => cells[`${iso}:${listId}`] || []);
      const bucket = paneIdx === 2
        ? (sortByCP
            ? [...bucketRaw].sort(makeCpCompare(projects, clients))
            : [...bucketRaw.filter((t) => t.deadline), ...bucketRaw.filter((t) => !t.deadline)])
        : bucketRaw;
      // Milestones dated inside the pane's window ride at the top of their band.
      const isoSet = new Set(paneIsos);
      const bandMilestones = calendarTasks.filter((t) => {
        if (t.type !== 'scheduled' || !t.deadline || !isoSet.has(t.deadline)) return false;
        if (t.projectId) {
          const proj = projects.find((p) => p.id === t.projectId);
          if (proj?.list) return proj.list === listId;
        }
        return t.list === listId;
      }).sort((a, b) => (a.deadline! < b.deadline! ? -1 : a.deadline! > b.deadline! ? 1 : a.title.localeCompare(b.title)));
      return { listId, cellId: `cal:${paneIsos[0]}:${listId}`, tasks: [...bandMilestones, ...bucket] };
    });
  }, [isos, cells, listSequence, sortByCP, projects, clients, calendarTasks]);

  const bandsByPane = useMemo(() => [paneBands(0), paneBands(1), paneBands(2)], [paneBands]);

  // ── Pager ──────────────────────────────────────────────────────────────────
  const [pane, setPane] = useState(0);
  const [dragX, setDragX] = useState<number | null>(null); // live finger offset while panning
  const pagerRef = useRef<HTMLDivElement | null>(null);
  const panRef = useRef<{ x: number; y: number; t: number; committed: 'h' | 'v' | null } | null>(null);
  const dndActiveRef = useRef(false);

  const onPanStart = (x: number, y: number) => {
    if (dndActiveRef.current) return;
    panRef.current = { x, y, t: Date.now(), committed: null };
  };
  const onPanMove = (x: number, y: number): boolean => {
    const s = panRef.current;
    if (!s || dndActiveRef.current) return false;
    const dx = x - s.x, dy = y - s.y;
    if (!s.committed) {
      if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.3) s.committed = 'h';
      else if (Math.abs(dy) > 12) s.committed = 'v';
    }
    if (s.committed === 'h') {
      const w = pagerRef.current?.clientWidth || window.innerWidth;
      let off = dx;
      // rubber-band resistance at the ends
      if ((pane === 0 && dx > 0) || (pane === PANES.length - 1 && dx < 0)) off = dx * 0.3;
      setDragX(Math.max(-w, Math.min(w, off)));
      return true;
    }
    return false;
  };
  const onPanEnd = (x: number) => {
    const s = panRef.current;
    panRef.current = null;
    if (!s || s.committed !== 'h') { setDragX(null); return; }
    const dx = x - s.x;
    const dt = Math.max(1, Date.now() - s.t);
    const w = pagerRef.current?.clientWidth || window.innerWidth;
    const velocity = dx / dt; // px per ms
    let next = pane;
    if (dx < -w * 0.25 || velocity < -0.35) next = Math.min(PANES.length - 1, pane + 1);
    else if (dx > w * 0.25 || velocity > 0.35) next = Math.max(0, pane - 1);
    dbg(`pan end dx=${Math.round(dx)} v=${velocity.toFixed(2)} -> pane ${next}`);
    setPane(next);
    setDragX(null);
  };

  // ── DnD ────────────────────────────────────────────────────────────────────
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 10 } }),
  );
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const [activeCellId, setActiveCellId] = useState<string | null>(null);
  const activeRectRef = useRef<{ w: number; h: number } | null>(null);
  const lastOverTaskIdRef = useRef<string | null>(null);
  const lastOverCellIdRef = useRef<string | null>(null);

  // Collision: pointerWithin, with card hits redirected to the card's band (category lock —
  // a Work card can only land in Work). Day-tab droppables (mtab:*) win when hit.
  const collision: CollisionDetection = useCallback((args) => {
    const hits = pointerWithin(args);
    const tabHit = hits.find((c) => String(c.id).startsWith('mtab:'));
    if (tabHit) return [tabHit];
    const at = args.active.data.current?.task as Task | undefined;
    if (!at) return hits;
    const out: typeof hits = [];
    const seen = new Set<string>();
    for (const c of hits) {
      const id = String(c.id);
      if (id.startsWith('cal:')) {
        const [, date, list] = id.split(':');
        lastOverCellIdRef.current = id;
        const redirect = list === at.list ? id : `cal:${date}:${at.list}`;
        if (!seen.has(redirect)) { out.push(list === at.list ? c : { ...c, id: redirect }); seen.add(redirect); }
        continue;
      }
      // A task-card hit: remember it for positional insert, redirect to its cell.
      const container = args.droppableContainers.find((d) => d.id === c.id);
      const otherCell = container?.data?.current?.calendarCellId as string | undefined;
      if (otherCell) {
        lastOverTaskIdRef.current = id;
        lastOverCellIdRef.current = otherCell;
        const [, date] = otherCell.split(':');
        const redirect = `cal:${date}:${at.list}`;
        if (!seen.has(id)) { out.push(c); seen.add(id); }
        if (!seen.has(redirect)) { seen.add(redirect); }
      }
    }
    if (out.length) return out;
    // No band/card under the pointer — fall back to the whole-pane hotspot: redirect to the
    // dragged task's own band in that pane ("own band, empty space → end" desktop rule).
    const paneHit = hits.find((c) => String(c.id).startsWith('mpane:'));
    if (paneHit) {
      const paneIdx = Number(String(paneHit.id).split(':')[1]);
      const paneIso = paneIdx === 0 ? isosRef.current[0] : paneIdx === 1 ? isosRef.current[1] : isosRef.current[2];
      const redirect = `cal:${paneIso}:${at.list}`;
      lastOverTaskIdRef.current = null;
      lastOverCellIdRef.current = redirect;
      return [{ ...paneHit, id: redirect }];
    }
    return hits;
  }, []);

  const onDragStart = (e: DragStartEvent) => {
    const t = e.active.data.current?.task as Task | undefined;
    const cell = e.active.data.current?.calendarCellId as string | undefined;
    dndActiveRef.current = true;
    panRef.current = null;
    setDragX(null);
    setActiveTask(t ?? null);
    setActiveCellId(cell ?? null);
    lastOverTaskIdRef.current = null;
    lastOverCellIdRef.current = cell ?? null;
    // Measure the source ourselves — TouchSensor's long-press can beat dnd-kit's
    // measuring loop and leave active.rect empty (the v0.1.40 "floating text" bug).
    const node = document.querySelector(`[data-mcard][style*="visibility"]`) as HTMLElement | null;
    const el = (e.active.data.current as any)?.node ?? node;
    const rect = (el instanceof HTMLElement ? el : null)?.getBoundingClientRect?.();
    const anyRect = e.active.rect.current.initial;
    activeRectRef.current = rect ? { w: rect.width, h: rect.height } : anyRect ? { w: anyRect.width, h: anyRect.height } : null;
    dbg(`drag start ${t?.id}`);
  };

  const onDragEnd = (e: DragEndEvent) => {
    dndActiveRef.current = false;
    const t = activeTask;
    setActiveTask(null);
    setActiveCellId(null);
    if (!t) return;
    const overId = e.over ? String(e.over.id) : null;
    dbg(`drag end over=${overId}`);
    if (!overId) return;
    // NO-OP GUARD (desktop has the equivalent at App.tsx handleDragEnd). TouchSensor activates
    // on TIME alone — 250ms with 10px tolerance — so a stationary press-and-hold IS a drag, and
    // dnd-kit reports `over === active`. Without this, an accidental long-press that never moved
    // would fall through and both reorder the task to the top of its band and re-date it.
    if (e.over && e.active && e.over.id === e.active.id) return;
    // Which day does this task ALREADY display on? Deadlines up to isos[8] place on their own
    // day; a date-RANGE task places on its startDate (computeCalendarDistribution's anchorOf),
    // so the anchor — not the deadline — is what decides where it currently sits.
    const anchorIso = (t.startDate && t.deadline) ? t.startDate : t.deadline;
    if (overId.startsWith('mtab:')) {
      // Dropped on a day tab — move to that day, top of the band.
      const idx = Number(overId.split(':')[1]);
      const targetSection = PANES[idx].section;
      if (targetSection === t.section && !t.deadline) return; // no-op (undated)
      // Same no-op for a DATED task already shown on that tab: dropping a task due in 3 days
      // onto "Next" used to stamp it to anchor+7, silently pushing the deadline out. Mirrors the
      // TaskSheet chips, which already no-op when you tap the day the task is on.
      const shownIdx = anchorIso ? (anchorIso <= isos[0] ? 0 : anchorIso === isos[1] ? 1 : 2) : null;
      if (shownIdx === idx) return;
      const targetDate = idx === 0 ? isos[0] : idx === 1 ? isos[1] : dateToISO(addDaysToDate(anchor, 7));
      dropTask(t, targetDate, targetSection, null, false);
      return;
    }
    // Reorder / in-pane drop. Resolve the cell we were really over.
    const cellId = overId.startsWith('cal:') ? overId : lastOverCellIdRef.current;
    if (!cellId) return;
    const [, date] = cellId.split(':');
    const paneIdx = date === isos[0] ? 0 : date === isos[1] ? 1 : 2;
    const targetSection = PANES[paneIdx].section;
    // The NEXT pane collapses seven days (isos[2..8]) into ONE droppable id, so `date` is
    // isos[2] for every band in it — NOT where the card visually sits. Stamping the deadline
    // from that id silently pulled a task due next Friday back to Sunday just for reordering it.
    // Inside the Next pane, keep the existing deadline for any task already anchored in that
    // window; Today/Tomorrow are unambiguous single days and still reschedule as before.
    const inNextWindow = !!anchorIso && isos.slice(2).includes(anchorIso);
    const targetDate = paneIdx === 2 && t.deadline && inNextWindow ? t.deadline : (paneIdx === 2 ? date : isos[paneIdx]);
    const overTaskId = overId.startsWith('cal:') ? null : overId;
    const droppedInOwnBand = (lastOverCellIdRef.current || cellId).split(':')[2] === t.list;
    dropTask(t, targetDate, targetSection, overTaskId ?? lastOverTaskIdRef.current, droppedInOwnBand);
    lastOverTaskIdRef.current = null;
    lastOverCellIdRef.current = null;
  };

  // ── Sheets state ───────────────────────────────────────────────────────────
  // Track the sheet by ID, not by object: the card "+" creates a sibling and opens the sheet on
  // it in the same tick, before that task exists in `tasks`. Looking it up live resolves on the
  // next render, and also keeps the sheet in sync if the task changes underneath it.
  const [sheetTaskId, setSheetTaskId] = useState<string | null>(null);
  // True when the sheet was opened by CREATING a task (band +, ADD card, card +),
  // as opposed to tapping an existing card. Drives straight-into-typing: the
  // title field focuses itself and iOS raises the keyboard, because naming the
  // thing is always the first move after making it.
  const [sheetAutoFocus, setSheetAutoFocus] = useState(false);
  // Every "create" entry point goes through here so the flag can't drift out of
  // sync with the sheet it belongs to.
  const openNewTaskSheet = useCallback((id: string) => { setSheetAutoFocus(true); setSheetTaskId(id); }, []);
  const openTaskSheet = useCallback((id: string) => { setSheetAutoFocus(false); setSheetTaskId(id); }, []);
  // Which band label has its "+" disclosed, keyed "<section>:<listId>". One at a time.
  // (band + buttons are always visible now — the tap-to-reveal disclosure state is gone)
  // Task currently open in the FULL panel for editing (from the card sheet's "Edit").
  const [editingId, setEditingId] = useState<string | null>(null);
  const editingTask = editingId ? tasks.find((t) => t.id === editingId) ?? null : null;
  const [composing, setComposing] = useState(false);
  const liveSheetTask = sheetTaskId ? tasks.find((t) => t.id === sheetTaskId) ?? null : null;

  // ── Render ─────────────────────────────────────────────────────────────────
  // Viewport width as STATE so rotation / resize re-lays the pager out instead of
  // leaving stale pixel offsets (translateX is in px).
  const [w, setW] = useState(() => (typeof window !== 'undefined' ? window.innerWidth : 375));
  useEffect(() => {
    const onResize = () => setW(window.innerWidth);
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => { window.removeEventListener('resize', onResize); window.removeEventListener('orientationchange', onResize); };
  }, []);
  const baseOffset = -pane * w;
  const offset = dragX != null ? baseOffset + dragX : baseOffset;

  const [, setDbgTick] = useState(0);
  useEffect(() => { if (DEBUG) debugTick = () => setDbgTick((n) => n + 1); return () => { debugTick = null; }; }, []);

  const headerDate = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collision}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => { dndActiveRef.current = false; setActiveTask(null); setActiveCellId(null); }}
      measuring={{ droppable: { strategy: MeasuringStrategy.BeforeDragging } }}
    >
      <div data-mshell className="fixed inset-0 flex flex-col bg-[var(--app-bg)] overflow-hidden" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
        {/* Header — brand + date. LONG-PRESS it to open the layout diagnostic panel; that works
            inside the installed home-screen app, where you can't append ?debug=1 to the URL. */}
        <div
          className="shrink-0 px-[18px] pt-[18px]"
          onTouchStart={() => { holdRef.current = window.setTimeout(() => setDiag((d) => !d), 700); }}
          onTouchEnd={() => { if (holdRef.current) { window.clearTimeout(holdRef.current); holdRef.current = null; } }}
          onTouchCancel={() => { if (holdRef.current) { window.clearTimeout(holdRef.current); holdRef.current = null; } }}
          onDoubleClick={() => setDiag((d) => !d)}
        >
          <p className="font-['Univers_BQ:55_Regular',sans-serif] text-[13px] text-white whitespace-nowrap">{headerDate}</p>
        </div>
        {/* Day switcher — the CTRL Assets toolbar paradigm: ONE rounded track with a lighter
            knob that slides to the active segment. No underline. The padding is measured in the
            app's one type unit — index.css forces every element to 14px — so 56 is 4 units above
            and 28 is 2 units below. Optically that is ~59px above (the date's line box adds ~3px
            of leading below the glyphs) against ~42px below, once the pane's pt-[7px] and the
            7px of lead inside the 28px label box are counted. The control therefore sits nearer
            the list it governs than the date above it — the relationship the old 45/24 pair was
            reaching for and missed. Each segment is still a drop target, so dragging a card onto
            "Tomorrow" moves it there. */}
        <div className="shrink-0 flex items-center justify-center pt-[56px] pb-[28px]">
          {/* Track is the same near-black as the bottom bar (#151412) so the switcher reads as
              chrome rather than as content. */}
          <div className="relative inline-flex items-center rounded-full bg-black p-[3px] w-[calc(100%-36px)] max-w-[340px]">
            {/* Sliding knob: one third of the inner width, translated by whole knob-widths.
                It is simply the page background colour sitting on the near-black track — the
                same one knob for all three days, no purple wash and no per-day special case. */}
            <div
              aria-hidden
              className="absolute top-[3px] bottom-[3px] left-[3px] rounded-full bg-[var(--app-bg)]"
              style={{
                width: 'calc((100% - 6px) / 3)',
                transform: `translateX(${pane * 100}%)`,
                transition: `transform 320ms cubic-bezier(0.16, 1, 0.3, 1)`,
              }}
            />
            {PANES.map((p, i) => <DayTab key={p.section} idx={i} label={p.label} active={pane === i} dragging={!!activeTask} onTap={() => setPane(i)} />)}
          </div>
        </div>
        {/* Pager */}
        <div
          ref={pagerRef}
          className="flex-1 min-h-0 relative overflow-hidden"
          style={{ touchAction: 'pan-y' }}
          onTouchStart={(e) => { const t = e.touches[0]; onPanStart(t.clientX, t.clientY); }}
          onTouchMove={(e) => { const t = e.touches[0]; onPanMove(t.clientX, t.clientY); }}
          onTouchEnd={(e) => { const t = e.changedTouches[0]; onPanEnd(t.clientX); }}
          // iOS fires touchcancel WITHOUT a matching touchend whenever the system seizes the
          // gesture (Control Centre / Notification Centre pull, home-indicator swipe, incoming
          // call). Without this the pan never resolves and the pane stays frozen part-swiped
          // between two days. Settle it back to the current pane.
          onTouchCancel={() => { panRef.current = null; setDragX(null); }}
          onPointerDown={(e) => { if (e.pointerType === 'mouse' && !(e.target as HTMLElement).closest('[data-mcard]')) onPanStart(e.clientX, e.clientY); }}
          onPointerMove={(e) => { if (e.pointerType === 'mouse') onPanMove(e.clientX, e.clientY); }}
          onPointerUp={(e) => { if (e.pointerType === 'mouse') onPanEnd(e.clientX); }}
        >
          <div
            className="absolute inset-y-0 left-0 flex flex-row"
            style={{
              width: `${PANES.length * 100}%`,
              transform: `translateX(${offset}px)`,
              transition: dragX != null ? 'none' : `transform 320ms cubic-bezier(0.16, 1, 0.3, 1)`,
            }}
          >
            {PANES.map((p, i) => (
              <PaneDroppable key={p.section} id={`mpane:${i}`} width={w}>
                {bandsByPane[i].map(({ listId, cellId, tasks: bandTasks }) => {
                  const grouped = paneGrouped[i];
                  // Ungrouped bands run through the SAME renderer as one anonymous group, so
                  // there is a single card-emitting path for `items` below to stay in step with.
                  const groups = grouped
                    ? buildSubGroupsShared(bandTasks, listId, projects, clients)
                    : [{ name: '', kind: 'client' as const, id: '', tasks: bandTasks }];
                  return (
                  <div key={`${p.section}-${listId}`} className="pt-[7px]">
                    {/* Label vertically centered; the + is ALWAYS visible (tap-to-reveal made it
                        undiscoverable) and sits in a 44px touch box with the same right-edge
                        geometry as the cards' + (card mx-10 + right-0 w-44 → icon center 32px
                        from the pane edge), so the column of pluses lines up. */}
                    <div className={`h-[28px] mb-[13px] pl-[20px] flex items-center sticky top-0 z-10 bg-[var(--app-bg)]`}>
                      <p className="font-['Univers_BQ:55_Regular',sans-serif] leading-[normal] not-italic text-[14px] whitespace-nowrap text-[#5e5e5e]">{LIST_TITLES[listId]}</p>
                      <button
                        type="button"
                        aria-label={`Add ${LIST_TITLES[listId]} task`}
                        onClick={() => openNewTaskSheet(createTask({ title: '', list: listId, section: p.section }))}
                        className="ml-auto w-[44px] mr-[10px] self-stretch flex items-center justify-center text-[#5e5e5e]"
                      ><Plus size={15} /></button>
                    </div>
                    <BandDroppable id={cellId} isEmpty={bandTasks.length === 0}>
                      {/* dnd-kit reads each card's index from `items` and displaces siblings using
                          rects[] in THAT order, so `items` must match the order the cards are
                          actually emitted in. Grouping permutes them — the partition is stable but
                          clients interleave inside the band — so deriving `items` from the flat
                          bandTasks would have the sortable maths compare cards that are nowhere
                          near each other. Identical to the flat list whenever grouping is off. */}
                      <SortableContext items={groups.flatMap((g) => g.tasks.map((t) => t.id))} strategy={verticalListSortingStrategy}>
                        {groups.map((g) => (
                          <Fragment key={`g-${g.name}`}>
                            {grouped && (
                              // Sub-break, not a category break: one label row and no blank unit
                              // above it — the louder gap belongs to the band label. The group name
                              // alone, because the label directly above already says the category;
                              // the desktop drops its prefix for the same reason. Not sticky: the
                              // band label is already `sticky top-0`, and a second one would fight it.
                              <div className="h-[28px] mb-[5px] pl-[20px] flex items-center">
                                <p className="font-['Univers_BQ:55_Regular',sans-serif] leading-[normal] not-italic text-[14px] whitespace-nowrap text-[#7a7a7a]">{g.name}</p>
                              </div>
                            )}
                            {g.tasks.map((t) => (
                              <MobileCard
                                key={t.id}
                                task={t}
                                cellId={cellId}
                                projects={projects}
                                clients={clients}
                                isTodayCard={i === 0}
                                // The heading directly above already names it, exactly as on
                                // the desktop's grouped columns. Only while grouped: an ungrouped
                                // band has no heading, so the card must still say it itself.
                                hideClient={grouped && listId !== 'personal'}
                                hideProject={grouped && listId === 'personal'}
                                onToggle={() => toggleTask(t.id)}
                                onOpen={() => openTaskSheet(t.id)}
                                onAddSibling={() => openNewTaskSheet(addSibling(t))}
                              />
                            ))}
                          </Fragment>
                        ))}
                      </SortableContext>
                      {/* Empty band: a quiet ADD+ placeholder card instead of confusing blank
                          space. Hidden while a drag is active so the empty-band drop slot keeps
                          its clean target look. */}
                      {bandTasks.length === 0 && !activeTask && (
                        <button
                          type="button"
                          onClick={() => openNewTaskSheet(createTask({ title: '', list: listId, section: p.section }))}
                          aria-label={`Add ${LIST_TITLES[listId]} task`}
                          className={`mx-[10px] mb-[5px] min-h-[44px] w-[calc(100%-20px)] rounded-[3.333px] flex flex-row items-center gap-[6px] px-[10px] ${i === 0 ? '' : 'bg-white/[0.03]'}`}
                          style={i === 0 ? { backgroundColor: 'rgb(from var(--app-accent) r g b / 0.1)' } : undefined}
                        >
                          <span className={`font-['Univers_BQ:55_Regular',sans-serif] text-[13px] ${i === 0 ? 'text-[var(--app-accent)]' : 'text-[#4a4a4a]'}`}>Add</span>
                          <Plus size={13} className={i === 0 ? 'text-[var(--app-accent)]' : 'text-[#4a4a4a]'} />
                        </button>
                      )}
                    </BandDroppable>
                  </div>
                  );
                })}
              </PaneDroppable>
            ))}
          </div>
        </div>
        {/* Bottom bar — the four icons + plus, desktop rail palette. Tall enough to CONTAIN the
            42px add button (42 + 13 top + 13 bottom = 68) instead of letting it break the top
            edge; the button is centred in the bar rather than lifted out of it. */}
        <div data-mbar className="shrink-0 bg-[#151412] flex flex-row items-center justify-around px-[10px]" style={{ paddingBottom: 'env(safe-area-inset-bottom)', height: 'calc(68px + env(safe-area-inset-bottom))' }}>
          {/* Focus is the only view the phone implements. The other three are marked
              aria-disabled and dimmed further so they read as "not here yet" rather than as
              normal inactive tabs you tapped and nothing happened. */}
          {[
            { label: 'Focus', Icon: SquareKanban, active: true },
            { label: 'Calendar', Icon: MdOutlineCalendarMonth, active: false },
          ].map(({ label, Icon, active }) => (
            <button
              key={label}
              aria-label={active ? label : `${label} — desktop only`}
              aria-disabled={!active}
              disabled={!active}
              className={`p-3 ${active ? 'text-white' : 'text-[#2f2e2c]'}`}
            ><Icon size={22} /></button>
          ))}
          <button
            aria-label="Add task"
            onClick={() => setComposing(true)}
            className="size-[42px] shrink-0 rounded-full bg-[var(--app-accent)] flex items-center justify-center"
          >
            <Plus size={22} color="#151412" strokeWidth={2.5} />
          </button>
          {[
            { label: 'List', Icon: List },
            { label: 'Project', Icon: FolderTree },
          ].map(({ label, Icon }) => (
            <button key={label} aria-label={`${label} — desktop only`} aria-disabled disabled className="p-3 text-[#2f2e2c]"><Icon size={22} /></button>
          ))}
        </div>

        {/* Drag overlay — desktop physics: scale 1.02, soft shadow, no drop animation */}
        <DragOverlay dropAnimation={null}>
          {activeTask ? (
            <div
              className="overflow-hidden rounded-[3.333px]"
              style={{
                width: activeRectRef.current?.w ?? w - 20,
                height: activeRectRef.current?.h ?? 52,
                transform: 'scale(1.02)',
                boxShadow: '0 1.875px 7.5px -0.625px rgba(0,0,0,0.35), 0 1.25px 3.125px -0.3125px rgba(0,0,0,0.25)',
                backgroundColor: activeCellId?.startsWith(`cal:${isos[0]}:`) ? 'rgb(from var(--app-accent) r g b / 0.1)' : 'rgba(58,58,58,0.85)',
              }}
            >
              <MobileCardBody task={activeTask} projects={projects} clients={clients} isTodayCard={!!activeCellId?.startsWith(`cal:${isos[0]}:`)} />
            </div>
          ) : null}
        </DragOverlay>

        {/* Task sheet */}
        {liveSheetTask && (
          <TaskSheet
            task={liveSheetTask}
            autoFocusTitle={sheetAutoFocus}
            projects={projects}
            clients={clients}
            isos={isos}
            anchor={anchor}
            convertTitle={convertTitle}
            onRename={(title) => renameTask(liveSheetTask.id, title)}
            onMove={(idx) => {
              const targetSection = PANES[idx].section;
              const targetDate = idx === 0 ? isos[0] : idx === 1 ? isos[1] : dateToISO(addDaysToDate(anchor, 7));
              dropTask(liveSheetTask, targetDate, targetSection, null, false);
            }}
            onDelete={() => { deleteTask(liveSheetTask.id); setSheetTaskId(null); }}
            onEdit={() => { setEditingId(liveSheetTask.id); setSheetTaskId(null); }}
            onClose={() => setSheetTaskId(null)}
          />
        )}

        {/* Compose sheet */}
        {/* One panel, two jobs: creating (bottom "+") and editing (card sheet -> Edit). */}
        {(composing || editingTask) && (
          <ComposeSheet
            key={editingTask ? `edit-${editingTask.id}` : 'create'}
            listSequence={listSequence}
            projects={projects}
            clients={clients}
            people={people}
            currentUserShort={currentUserShort}
            defaultSection={PANES[pane].section}
            isos={isos}
            anchor={anchor}
            editingTask={editingTask}
            onCreate={(payload, keepOpen) => { createTask(payload); if (!keepOpen) setComposing(false); }}
            onUpdate={updateTask}
            onAddClient={addClient}
            onAddProject={addProject}
            onClose={() => { setComposing(false); setEditingId(null); }}
          />
        )}

        {diag && <DiagPanel onClose={() => setDiag(false)} />}

        {/* Debug overlay (?debug=1) */}
        {DEBUG && (
          <div className="fixed left-0 right-0 z-[60] pointer-events-none px-2" style={{ bottom: 'calc(70px + env(safe-area-inset-bottom))' }}>
            <div className="bg-black/70 rounded p-2 max-h-[180px] overflow-hidden">
              {debugLog.slice(-12).map((l, i) => <p key={i} className="text-[10px] leading-[1.25] text-[#8f8]" style={{ fontSize: 10 }}>{l}</p>)}
            </div>
          </div>
        )}
      </div>
    </DndContext>
  );
}

// Layout diagnostics for the installed PWA. Reports the numbers that decide where the bottom bar
// lands — the real safe-area insets (0 in desktop Chrome, non-zero only on device), the several
// different "heights" iOS exposes, and the measured shell/bar rectangles. The GAP line is the
// answer: how many pixels sit between the bottom of the bar and the bottom of the window.
function DiagPanel({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<[string, string][]>([]);
  // What the SERVER currently has, read past every cache. This is the row that settles whether a
  // hard reload failed or the deploy simply had not finished when you pressed it: if `server`
  // is ahead of `version`, the reload is at fault; if they match, you already have the newest
  // build and there was nothing to fetch.
  const [server, setServer] = useState('checking…');
  useEffect(() => {
    let alive = true;
    const url = `${import.meta.env.BASE_URL}version.json?t=${Date.now()}`;
    fetch(url, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j) => { if (alive) setServer(`v${j.version}`); })
      .catch(() => { if (alive) setServer('unreachable'); });
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    const read = () => {
      // Resolve env() by letting the engine compute it on a throwaway element.
      const probe = document.createElement('div');
      probe.style.cssText = 'position:fixed;left:-9999px;top:0;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom);';
      document.body.appendChild(probe);
      const cs = getComputedStyle(probe);
      const insetTop = cs.paddingTop, insetBottom = cs.paddingBottom;
      probe.remove();
      const shell = document.querySelector('[data-mshell]') as HTMLElement | null;
      const bar = document.querySelector('[data-mbar]') as HTMLElement | null;
      const sr = shell?.getBoundingClientRect();
      const br = bar?.getBoundingClientRect();
      const vv = window.visualViewport;
      const r = (n?: number) => (n === undefined ? '—' : String(Math.round(n)));
      setRows([
        ['version (installed)', `v${__APP_VERSION__}`],
        ['standalone', String(window.matchMedia('(display-mode: standalone)').matches || !!(navigator as unknown as { standalone?: boolean }).standalone)],
        ['inset top / bottom', `${insetTop} / ${insetBottom}`],
        ['window.innerHeight', r(window.innerHeight)],
        ['visualViewport.h', r(vv?.height)],
        ['screen.height', r(window.screen.height)],
        ['documentElement.clientH', r(document.documentElement.clientHeight)],
        ['shell top → bottom', `${r(sr?.top)} → ${r(sr?.bottom)}`],
        ['bar top → bottom', `${r(br?.top)} → ${r(br?.bottom)}`],
        ['bar height', r(br?.height)],
        ['GAP below bar', br ? r(window.innerHeight - br.bottom) : '—'],
        // Sheet/keyboard diagnostics — only meaningful while a sheet is open with the keyboard up.
        ['vv offsetTop', r(vv?.offsetTop)],
        ['keyboard height', vv ? r(window.innerHeight - vv.height) : '—'],
        (() => {
          const sheet = document.querySelector('[data-msheet]') as HTMLElement | null;
          const sr = sheet?.getBoundingClientRect();
          return ['sheet top → bottom', sr ? `${r(sr.top)} → ${r(sr.bottom)}` : 'closed'] as [string, string];
        })(),
        (() => {
          const fld = document.querySelector('[data-msheet] textarea') as HTMLElement | null;
          const fr = fld?.getBoundingClientRect();
          return ['title field top', fr ? `${r(fr.top)}${fr.top < 0 ? ' (OFF TOP)' : ''}` : 'closed'] as [string, string];
        })(),
        ['body scroll overflow', r(document.body.scrollHeight - window.innerHeight)],
        ['body padTop / padBottom', `${getComputedStyle(document.body).paddingTop} / ${getComputedStyle(document.body).paddingBottom}`],
      ]);
    };
    read();
    const h = window.setInterval(read, 1000);
    return () => window.clearInterval(h);
  }, []);
  return (
    <div className="fixed inset-0 z-[80] bg-black/85 flex items-center justify-center p-4" onClick={onClose}>
      <div className="w-full max-w-[330px] rounded-[10px] bg-[#232220] p-[14px]" onClick={(e) => e.stopPropagation()}>
        <p className="text-white text-[13px] pb-[8px]">Layout diagnostics</p>
        <div className="flex flex-row justify-between gap-3 py-[2px]">
          <span className="text-[#8a8a8a]" style={{ fontSize: 11 }}>version (server)</span>
          <span className={server.startsWith('v') && server !== `v${__APP_VERSION__}` ? 'text-[var(--app-accent)] text-right' : 'text-white text-right'} style={{ fontSize: 11 }}>{server}</span>
        </div>
        {rows.map(([k, v]) => (
          <div key={k} className="flex flex-row justify-between gap-3 py-[2px]">
            <span className="text-[#8a8a8a]" style={{ fontSize: 11 }}>{k}</span>
            <span className="text-white text-right" style={{ fontSize: 11 }}>{v}</span>
          </div>
        ))}
        {/* HARD RELOAD. There is no service worker, so an installed home-screen app just uses
            the HTTP cache and can keep serving an old build — which previously meant deleting
            the icon and re-adding it to pick up a deploy. Dropping any Cache Storage and
            re-entering with a fresh ?v= makes iOS fetch a genuinely new document (the asset
            filenames are content-hashed, so new JS/CSS follows). Existing params are preserved,
            and the URL stays in the PWA's scope so it stays full-screen. */}
        <button
          type="button"
          onClick={async () => {
            try {
              if ('caches' in window) {
                const keys = await caches.keys();
                await Promise.all(keys.map((k) => caches.delete(k)));
              }
            } catch { /* nothing cached — carry on */ }
            // Force the HTTP cache entry for the DOCUMENT itself to be revalidated before we
            // navigate. A fresh ?v= alone only guarantees a new cache KEY; iOS could still hand
            // back a stale entry for the base path on the next boot. cache:'reload' makes the
            // engine go to the network and overwrite what it stored.
            try { await fetch(window.location.pathname, { cache: 'reload' }); } catch { /* offline */ }
            const u = new URL(window.location.href);
            u.searchParams.set('v', String(Date.now()));
            window.location.replace(u.toString());
          }}
          className="mt-[12px] w-full py-[9px] rounded-[8px] bg-[#2f2e2c] text-white text-[13px]"
        >
          Hard reload (fetch newest build)
        </button>
        <button type="button" onClick={onClose} className="mt-[8px] w-full py-[9px] rounded-[8px] bg-[var(--app-accent)] text-[#151412] text-[13px]">Close</button>
      </div>
    </div>
  );
}

// One segment of the day switcher: tap target + drop target ("drop a card on Tomorrow to move
// it there"). The active pill is the shared sliding knob behind these, so a segment paints no
// background of its own — only its label colour changes. z-10 keeps the labels above the knob.
function DayTab({ idx, label, active, dragging, onTap }: { idx: number; label: string; active: boolean; dragging: boolean; onTap: () => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: `mtab:${idx}` });
  return (
    <button
      ref={setNodeRef}
      type="button"
      onClick={onTap}
      className={`relative z-10 flex-1 py-[8px] rounded-full text-center transition-colors font-['Univers_BQ:55_Regular',sans-serif] text-[14px] ${
        // Mid-drag the segments read as landing zones: the one under the finger goes full
        // accent, the others hint in accent so it's obvious you can drop on them.
        isOver && dragging ? 'text-[var(--app-accent)]'
        // The active label is always WHITE — including Today. The purple lives in Today's knob
        // fill, not the word, so the label stays legible against it.
        : active ? 'text-white'
        : dragging ? 'text-[var(--app-accent)]/60'
        : 'text-[#656464]'
      }`}
      style={isOver && dragging ? { boxShadow: 'inset 0 0 0 1.5px var(--app-accent)', borderRadius: 9999 } : undefined}
    >
      {label}
    </button>
  );
}

function TaskSheet({ task, projects, clients, isos, anchor, autoFocusTitle, convertTitle, onRename, onMove, onDelete, onEdit, onClose }: {
  task: Task; projects: Project[]; clients: Client[]; isos: string[]; anchor: Date;
  /** Sheet was opened by creating this task → focus the title and raise the keyboard. */
  autoFocusTitle?: boolean;
  /** The same auto-capitalisation renameTask applies. Needed here for the dirty-check only —
   *  see commit() below. */
  convertTitle: (s: string) => string;
  onRename: (title: string) => void; onMove: (paneIdx: number) => void; onDelete: () => void;
  /** Hand off to the full task panel, pre-filled with this task. */
  onEdit: () => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(task.title);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Measured against what will actually be STORED, because the title is auto-capitalised on the
  // way in. Comparing the raw field text instead makes every blur after the first look like an
  // edit, and each one rewrites the whole tasks array into the room for no content change.
  // Compares RAW against STORED, and sends raw — renameTask does the single conversion.
  // `title` is seeded from task.title, so an untouched sheet compares equal and writes
  // nothing. Running the converter here instead made merely OPENING a task and dismissing
  // it rewrite the title: any stored title not already in converted form ("buy milk", or
  // anything typed before the mode was switched on) differs from its converted form, so
  // the check read as dirty on a read-only glance and rewrote the whole tasks array.
  const commit = () => { const raw = title.trim(); if (raw !== task.title) onRename(raw); };
  const titleRef = useRef<HTMLInputElement | null>(null);

  // Straight into typing on a freshly created task. useLayoutEffect (not a
  // timeout) keeps the focus() inside the tap's own call stack, which is what
  // iOS requires before it will raise the keyboard — a deferred focus gets the
  // caret but no keyboard.
  useLayoutEffect(() => {
    if (!autoFocusTitle) return;
    titleRef.current?.focus();
  }, [autoFocusTitle]);

  // Swipe UP anywhere on the sheet's lower controls (day chips + Edit/Delete/
  // Done row) = the Edit button. Pulling the bar upward to expand into the full
  // panel is the gesture the layout already suggests. Taps are untouched: we
  // only act past a decisive vertical threshold, and never when the gesture is
  // mostly horizontal (that's the day-chip row's own territory).
  const pullRef = useRef<{ x: number; y: number; t: number } | null>(null);
  const pullHandlers = {
    onTouchStart: (e: React.TouchEvent) => {
      const t = e.touches[0];
      pullRef.current = { x: t.clientX, y: t.clientY, t: Date.now() };
    },
    onTouchEnd: (e: React.TouchEvent) => {
      const s = pullRef.current;
      pullRef.current = null;
      if (!s) return;
      const t = e.changedTouches[0];
      const dy = t.clientY - s.y;
      const dx = Math.abs(t.clientX - s.x);
      if (dy < -40 && dx < 60 && Date.now() - s.t < 600) {
        e.preventDefault();
        e.stopPropagation();
        commit();
        onEdit();
      }
    },
  };
  const project = task.projectId ? projects.find((p) => p.id === task.projectId) : undefined;
  const client = (task.clientId ?? project?.clientId) ? clients.find((c) => c.id === (task.clientId ?? project?.clientId)) : undefined;
  // Highlight the chip for the day the task DISPLAYS on. For dated tasks that's the deadline
  // (overdue absorbs into Today), regardless of a stale section; undated tasks follow section.
  const currentIdx = task.deadline
    ? (task.deadline <= isos[0] ? 0 : task.deadline === isos[1] ? 1 : 2)
    : task.section === 'today' ? 0 : task.section === 'tomorrow' ? 1 : 2;
  return (
    <SheetShell onClose={() => { commit(); onClose(); }} grabber={pullHandlers}>
      <input
        ref={titleRef}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') { commit(); (e.target as HTMLInputElement).blur(); } }}
        placeholder="New task"
        autoComplete="off"
        name="ctrl-entry-rename"
        // iOS ties auto-capitalisation to the keyboard's smart features: autocorrect="off"
        // switches them off as a group, so capitalisation died with it. Autocorrect back on;
        // spellcheck stays off to avoid red squiggles under project jargon.
        autoCapitalize="sentences"
        autoCorrect="on"
        spellCheck={false}
        // Same full-width capsule as the creator panel's title field, so both sheets read as
        // one system rather than one styled field and one bare line of text.
        className="shrink-0 w-full bg-[#151412] rounded-full px-[16px] py-[12px] outline-none border-none text-white font-['Univers_BQ:55_Regular',sans-serif] text-[14px] leading-[1.4] placeholder:text-[#656464]"
      />
      <div className="shrink-0 h-[12px]" />
      {(client || project) && (
        <p className="font-['Univers_BQ:55_Regular',sans-serif] text-[11.5px] text-[#656464] pb-[12px] px-[4px]">
          {client?.short}{client && project ? <Arrowhead /> : null}{project?.name}
        </p>
      )}
      {/* Lower controls, and the pull-up-to-edit target: dragging this whole
          block upward opens the full task panel. */}
      {/* mt-auto: the sheet is now taller than its content, and free space in a flex column
          pools at the END — which would leave this row floating above a band of dead sheet.
          Pushing it to the bottom puts the slack under the title, where it belongs. */}
      <div {...pullHandlers} className="mt-auto">
      {/* Same control as the day switcher and the creator panel: capsules on a dark track. */}
      <div className="pb-[16px]">
        <div className={CHIP_TRACK}>
          {PANES.map((p, i) => (
            <button key={p.section} type="button" className={chipCls(i === currentIdx)} onClick={() => { if (i !== currentIdx) { onMove(i); } onClose(); }}>
              {p.label}
            </button>
          ))}
        </div>
      </div>
      {/* Edit · Delete · Done. Edit hands off to the same full panel the bottom "+" opens, so
          there is one task form in the app rather than two that drift.
          Delete stays two taps: tapping a card is the gesture that opens this sheet, so a
          single-tap Delete under your thumb was one mis-tap from trashing a task — and the phone
          has no Trash view to recover from. The second tap is labelled and red; Cancel backs out. */}
      {/* A fixed three-slot grid in BOTH states, so arming the delete never re-flows the row:
          the trash stays exactly where it was and only its label and colour change. Previously
          the confirm state dropped to two buttons and justify-between threw the trash to the
          left, which read as the button moving out from under your thumb. */}
      <div className="shrink-0 grid grid-cols-3 items-center border-t border-[#33312e] pt-[14px]">
        <button
          type="button"
          onClick={() => { if (confirmDelete) { setConfirmDelete(false); return; } commit(); onEdit(); }}
          className={`justify-self-start flex flex-row items-center gap-[7px] p-2 -m-2 ${confirmDelete ? 'text-[#656464]' : 'text-[#a8a8a8]'}`}
        >
          {confirmDelete ? <span className="text-[13px]">Cancel</span> : <><Pencil size={15} /><span className="text-[13px]">Edit</span></>}
        </button>

        <button
          type="button"
          aria-label={confirmDelete ? 'Confirm delete task' : 'Delete task'}
          onClick={() => (confirmDelete ? onDelete() : setConfirmDelete(true))}
          className={`justify-self-center flex flex-row items-center gap-[7px] p-2 -m-2 ${confirmDelete ? 'text-[#FF7171]' : 'text-[#656464]'}`}
        >
          <Trash2 size={15} />
          <span className="text-[13px]">{confirmDelete ? 'Confirm' : 'Delete'}</span>
        </button>

        <button
          type="button"
          onClick={() => { if (confirmDelete) { setConfirmDelete(false); return; } commit(); onClose(); }}
          className="justify-self-end text-[var(--app-accent)] text-[13px] p-2 -m-2"
        >
          Done
        </button>
      </div>
      </div>
    </SheetShell>
  );
}

// One section of the task panel: a quiet label, then a row of identical capsules, with the SAME
// buffer above and below every time. Declared at module scope (not inside ComposeSheet) so React
// keeps its identity across renders — otherwise the inline "new item" field would remount and
// lose focus on every keystroke.
//
// `onCreate` opts the section into the label-tap paradigm used elsewhere in the app: tap the
// label, a "+" appears in the same grey, tap that and an inline field lets you name a new one.
function PanelSection({ label, open, onToggle, onCreate, createPlaceholder, children }: {
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
      <div className={CHIP_TRACK}>{children}</div>
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
function ComposeSheet({ listSequence, projects, clients, people, currentUserShort, defaultSection, isos, anchor, editingTask, onCreate, onUpdate, onAddClient, onAddProject, onClose }: {
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
}) {
  const isEdit = !!editingTask;
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

  const primaryLabel = isEdit ? 'Save' : title.trim() ? 'Add Task' : addedCount > 0 ? 'Done' : 'Add Task';
  const primaryEnabled = isEdit ? !!title.trim() : !!title.trim() || addedCount > 0;

  return (
    <SheetShell onClose={commitAndClose}>
      <div className="shrink-0 flex flex-row items-center justify-between pb-[12px]">
        <p className="text-white text-[14px]">{isEdit ? 'Edit Task' : addedCount > 0 ? `Added ${addedCount}` : 'New Task'}</p>
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
        // A full-width capsule on the dark track colour, so the title reads as THE field of the
        // sheet rather than floating loose above the chip groups that surround it.
        // rounded-full, not a fixed 22px: 22 happens to be exactly half of this field's 43.6px
        // one-line height, so a fixed radius is a capsule only while that height holds and
        // degrades into a rounded rectangle the moment anything makes the box taller. 9999px
        // always clamps to half the box. Don't reach for leading-* to change the height —
        // index.css forces line-height 1.4 on textarea and the class is a no-op; use py-*.
        className="shrink-0 w-full resize-none overflow-hidden bg-[#151412] rounded-full px-[16px] py-[12px] outline-none border-none text-white font-['Univers_BQ:55_Regular',sans-serif] text-[14px] leading-[1.4] placeholder:text-[#656464]"
      />
      <div className="shrink-0 h-[18px]" />

      {/* Everything is present — no disclosure. The body scrolls when it outgrows the sheet. */}
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
        <PanelSection label="When">
          {PANES.map((p) => (
            <button key={p.section} type="button" className={chipCls(p.section === section)} onClick={() => setSection(p.section)}>{p.label}</button>
          ))}
        </PanelSection>

        <PanelSection label="Category">
          {listSequence.map((l) => (
            <button key={l} type="button" className={chipCls(l === listId)} onClick={() => setListId(l)}>{LIST_TITLES[l]}</button>
          ))}
        </PanelSection>

        <PanelSection
          label="Client"
          open={openLabel === 'client'}
          onToggle={() => toggleLabel('client')}
          onCreate={(n) => setClientId(onAddClient(n))}
          createPlaceholder="New client name"
        >
          <button type="button" className={chipCls(clientId === '')} onClick={() => chooseClient('')}>None</button>
          {visibleClients.map((c) => (
            <button key={c.id} type="button" className={chipCls(clientId === c.id)} onClick={() => chooseClient(c.id)}>{c.short || c.name}</button>
          ))}
        </PanelSection>

        <PanelSection
          label="Project"
          open={openLabel === 'project'}
          onToggle={() => toggleLabel('project')}
          onCreate={(n) => setProjectId(onAddProject({ name: n, clientId: clientId || undefined, list: listId }))}
          createPlaceholder="New project name"
        >
          <button type="button" className={chipCls(projectId === '')} onClick={() => setProjectId('')}>None</button>
          {visibleProjects.map((p) => (
            <button key={p.id} type="button" className={chipCls(projectId === p.id)} onClick={() => chooseProject(p.id)}>{p.name}</button>
          ))}
        </PanelSection>

        <PanelSection label="Deadline">
          {/* The date field is a CAPSULE like every other chip. type=date brings its own
              intrinsic sizing on iOS — a native control height and inner padding that made it
              stand taller than its neighbours — so appearance-none plus box-border and an
              explicit height force it onto the same 36px as the rest. It also has no
              placeholder of its own, so when empty its text is hidden and "Date" is laid over
              it, and it fills with the sheet colour once set, exactly like a selected chip. */}
          <span className="relative inline-flex">
            <input
              type="date"
              value={deadline}
              onChange={(e) => setDeadline(e.target.value)}
              className={`${CHIP_BASE} box-border appearance-none leading-none ${deadline ? 'bg-[#232220] text-white' : 'bg-transparent text-transparent'}`}
            />
            {!deadline && (
              <span className="absolute inset-0 flex items-center pl-[14px] pointer-events-none text-[#656464] text-[13px]">Date</span>
            )}
          </span>
          <button type="button" className={chipCls(false)} onClick={() => setDeadline(isos[0])}>Today</button>
          <button type="button" className={chipCls(false)} onClick={() => setDeadline(dateToISO(addDaysToDate(anchor, 7)))}>+1 wk</button>
          {deadline && <button type="button" className={chipCls(false)} onClick={() => setDeadline('')}>Clear</button>}
        </PanelSection>

        <PanelSection label="People">
          {people.map((pr) => {
            const on = assignees.includes(pr.short);
            return (
              <button
                key={pr.id}
                type="button"
                className={chipCls(on)}
                onClick={() => setAssignees((a) => (on ? a.filter((x) => x !== pr.short) : [...a, pr.short]))}
              >{pr.name}</button>
            );
          })}
        </PanelSection>

        <PanelSection label="Type">
          <button type="button" className={chipCls(!milestone)} onClick={() => setMilestone(false)}>Task</button>
          <button type="button" className={chipCls(milestone)} onClick={() => setMilestone(true)}>Milestone</button>
        </PanelSection>
      </div>

      <button
        type="button"
        onClick={() => save(false)}
        disabled={!primaryEnabled}
        className={`shrink-0 mt-[10px] w-full py-[12px] rounded-[8px] text-[14px] font-['Univers_BQ:55_Regular',sans-serif] transition-colors ${primaryEnabled ? 'bg-[var(--app-accent)] text-[#151412]' : 'bg-[#2b2a27] text-[#5e5e5e]'}`}
      >
        {primaryLabel}
      </button>
    </SheetShell>
  );
}
