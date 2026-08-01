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

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStorage, useMutation } from '@liveblocks/react/suspense';
import {
  DndContext, DragOverlay, MeasuringStrategy, MouseSensor, TouchSensor,
  useSensor, useSensors, useDroppable, pointerWithin,
  type DragStartEvent, type DragEndEvent, type CollisionDetection,
} from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { List, FolderTree, SquareKanban, Plus, Trash2, X } from 'lucide-react';
import { MdOutlineCalendarMonth } from 'react-icons/md';
import type { Task, Project, Client, ListId, SectionId } from './data';
import { LIST_TITLES, LISTS, PERSONAL_CLIENT_ID, formatDeadline, isLateDeadline, todayISO } from './data';
import {
  computeCalendarDistribution, makeCpCompare, TaskCheckbox, Arrowhead, DeadlineArrow,
  addDaysToDate, dateToISO, useSharedTheme,
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

function MobileCardBody({ task, projects, clients, isTodayCard }: {
  task: Task; projects: Project[]; clients: Client[]; isTodayCard: boolean;
}) {
  const project = task.projectId ? projects.find((p) => p.id === task.projectId) : undefined;
  const resolvedClientId = task.clientId ?? project?.clientId;
  const client = resolvedClientId ? clients.find((c) => c.id === resolvedClientId) : undefined;
  const isScheduled = task.type === 'scheduled';
  const titleColor = task.completed ? 'text-[#383838]' : isScheduled ? 'text-[var(--app-accent)]' : isTodayCard ? 'text-white' : 'text-[#a8a8a8]';
  const metaColor = (isScheduled || isTodayCard) ? 'text-[var(--app-accent)]' : 'text-[#656464]';

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
      {client && project && <p className={`font-['Univers_BQ:55_Regular',sans-serif] text-[11.5px] whitespace-nowrap shrink-0 ${metaColor}`}>{client.short}<Arrowhead dim={task.completed} color={isTodayCard && !task.completed ? 'var(--app-accent)' : undefined} />{project.name}</p>}
      {client && !project && <p className={`font-['Univers_BQ:55_Regular',sans-serif] text-[11.5px] whitespace-nowrap shrink-0 ${metaColor}`}>{client.short}</p>}
      {!client && project && <p className={`font-['Univers_BQ:55_Regular',sans-serif] text-[11.5px] whitespace-nowrap shrink-0 ${metaColor}`}>{project.name}</p>}
      {/* Assignee initials are deliberately NOT rendered on the phone — it's a single-user
          surface and the circles just crowded a narrow row. `assignees` is untouched in the
          data; it still drives personal-task privacy and shows on the desktop. */}
      {/* A real deadline gets the desktop's arrow ahead of the date. `small` is the narrower
          11px variant (vs 18px) so it reads on a phone row without eating the title's space. */}
      {task.deadline && <DeadlineArrow small dim={task.completed} color={(isScheduled || isTodayCard) ? 'var(--app-accent)' : undefined} />}
      {task.deadline && <p className={`font-['NB_International:Regular',sans-serif] text-[11.5px] whitespace-nowrap shrink-0 ${(isScheduled || isTodayCard) ? 'text-[var(--app-accent)]' : isLateDeadline(task.deadline) ? 'text-white' : 'text-[#656464]'}`}>{formatDeadline(task.deadline)}</p>}
    </>
  );
  const checkbox = !isScheduled && (
    <div className="shrink-0 flex items-center justify-center">
      <TaskCheckbox completed={task.completed} started={task.started} onToggle={() => {}} accent={isTodayCard ? 'var(--app-accent)' : undefined} />
    </div>
  );
  const title = <span className={`font-['Univers_BQ:55_Regular',sans-serif] text-[13px] whitespace-nowrap overflow-hidden text-ellipsis ${titleColor}`}>{task.title || 'New Task'}</span>;

  return (
    <div className="relative px-[12px] py-[8px] overflow-hidden h-full flex flex-col justify-center gap-[2px]">
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

function MobileCard({ task, cellId, projects, clients, isTodayCard, onToggle, onOpen }: {
  task: Task; cellId: string; projects: Project[]; clients: Client[]; isTodayCard: boolean;
  onToggle: () => void; onOpen: () => void;
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
      <MobileCardBody task={task} projects={projects} clients={clients} isTodayCard={isTodayCard} />
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

function SheetShell({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  // iOS fires the synthetic click 0-300ms AFTER the touch tap that opened this sheet — the
  // stray click lands on the fresh backdrop and would close it instantly. Ignore backdrop
  // clicks for the first 500ms of the sheet's life.
  const openedAtRef = useRef(Date.now());
  // KEYBOARD AVOIDANCE. iOS does not shrink the LAYOUT viewport when the software keyboard
  // opens — only the visual viewport — so a bottom-anchored fixed panel stays pinned to the
  // screen bottom and the keyboard covers it (chips and the Add button become untappable).
  // visualViewport tells us how much is actually covered; lift the sheet by exactly that.
  const [kbInset, setKbInset] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      // How much of the layout viewport is hidden below the visual viewport = keyboard height.
      const covered = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      setKbInset(covered);
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => { vv.removeEventListener('resize', update); vv.removeEventListener('scroll', update); };
  }, []);
  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/50" onClick={() => { if (Date.now() - openedAtRef.current > 500) onClose(); }} />
      <div
        className="absolute left-0 right-0 bottom-0 bg-[#232220] rounded-t-[14px] px-[18px] pt-[16px]"
        style={{
          transform: kbInset > 0 ? `translateY(-${kbInset}px)` : undefined,
          // The safe-area pad is only meaningful when the sheet is resting on the home
          // indicator; once lifted by the keyboard it would just add dead space.
          paddingBottom: kbInset > 0 ? 18 : 'calc(env(safe-area-inset-bottom) + 18px)',
          animation: 'msheet-up 240ms cubic-bezier(0.16, 1, 0.3, 1)',
        }}
      >
        {children}
      </div>
      <style>{`@keyframes msheet-up { from { transform: translateY(100%); } to { transform: translateY(0); } }`}</style>
    </div>
  );
}

const CHIP_BASE = "px-[12px] py-[7px] rounded-full border text-[13px] font-['Univers_BQ:55_Regular',sans-serif] transition-colors";
const chipCls = (active: boolean) => `${CHIP_BASE} ${active ? 'border-[var(--app-accent)] text-[var(--app-accent)]' : 'border-[#3a3a3a] text-[#a8a8a8]'}`;

// ── The app ───────────────────────────────────────────────────────────────────

export default function MobileApp() {
  const tasks = (useStorage((root) => root.tasks) || []) as Task[];
  const projects = (useStorage((root) => root.projects) || []) as Project[];
  const clients = (useStorage((root) => root.clients) || []) as Client[];

  const setTasks = useMutation(({ storage }, updater: (prev: Task[]) => Task[]) => {
    const current = (storage.get('tasks' as never) as Task[] | undefined) || [];
    storage.set('tasks' as never, updater(current) as never);
  }, []);

  // Same room theme the desktop paints with — this is what keeps the two surfaces identical.
  useSharedTheme();
  // Layout diagnostics (long-press the header). Exists because the bottom bar sitting off the
  // screen bottom reproduces ONLY in the installed standalone PWA — desktop Chrome reports every
  // env(safe-area-inset-*) as 0, so the failing condition can't be recreated here. Measure on the
  // device instead of guessing.
  const [diag, setDiag] = useState(false);
  const holdRef = useRef<number | null>(null);
  const currentUserShort = readUserShort();
  if (DEBUG && typeof window !== 'undefined') (window as any).__mtasks = tasks;
  const listSequence = useMemo(readListSequence, []);
  const sortByCP = useMemo(readSortByCP, []);

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

  const renameTask = useCallback((id: string, title: string) => {
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, title } : t)));
  }, [setTasks]);

  const deleteTask = useCallback((id: string) => {
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, trashed: true, trashedAt: Date.now(), revivedAt: undefined } : t)));
  }, [setTasks]);

  const addTask = useCallback((title: string, listId: ListId, section: SectionId) => {
    const id = `task-${Date.now()}`;
    setTasks((prev) => {
      const maxOrder = prev.filter((x) => x.list === listId && x.section === section).reduce((m, x) => Math.max(m, x.order), -1);
      return [...prev, {
        id, title, type: 'todo' as const, assignees: currentUserShort ? [currentUserShort] : [],
        completed: false, list: listId, section, order: maxOrder + 1, createdAt: Date.now(),
      }];
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
    () => tasks.filter((t) => !t.trashed && (!isPrivateTask(t) || t.assignees.includes(currentUserShort))),
    [tasks, currentUserShort]
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
  const [sheetTask, setSheetTask] = useState<Task | null>(null);
  const [composing, setComposing] = useState(false);
  const liveSheetTask = sheetTask ? tasks.find((t) => t.id === sheetTask.id) ?? null : null;

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
          className="shrink-0 px-[18px] pt-[14px]"
          onTouchStart={() => { holdRef.current = window.setTimeout(() => setDiag((d) => !d), 700); }}
          onTouchEnd={() => { if (holdRef.current) { window.clearTimeout(holdRef.current); holdRef.current = null; } }}
          onTouchCancel={() => { if (holdRef.current) { window.clearTimeout(holdRef.current); holdRef.current = null; } }}
          onDoubleClick={() => setDiag((d) => !d)}
        >
          <p className="font-['Univers_BQ:55_Regular',sans-serif] text-[13px] text-white whitespace-nowrap">{headerDate}</p>
        </div>
        {/* Day switcher — the CTRL Assets toolbar paradigm: ONE rounded track with a lighter
            knob that slides to the active segment. No underline. Equal py above and below so
            the gap from the brand line and the gap down to the first band label match, and the
            control sits centred in that band of space. Each segment is still a drop target, so
            dragging a card onto "Tomorrow" moves it there. */}
        <div className="shrink-0 flex items-center justify-center pt-[28px] pb-[18px]">
          {/* Track is the same near-black as the bottom bar (#151412) so the switcher reads as
              chrome rather than as content. */}
          <div className="relative inline-flex items-center rounded-full bg-[#151412] p-[3px] w-[calc(100%-36px)] max-w-[340px]">
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
                {bandsByPane[i].map(({ listId, cellId, tasks: bandTasks }) => (
                  <div key={`${p.section}-${listId}`} className={bandTasks.length > 0 ? 'pb-[20px]' : 'pb-[10px]'}>
                    <div className="h-[24px] px-[20px] pb-[4px] flex items-center sticky top-0 z-10 bg-[var(--app-bg)]">
                      <p className="font-['Univers_BQ:55_Regular',sans-serif] leading-[normal] not-italic text-[14px] whitespace-nowrap text-[#5e5e5e]">{LIST_TITLES[listId]}</p>
                    </div>
                    <BandDroppable id={cellId} isEmpty={bandTasks.length === 0}>
                      <SortableContext items={bandTasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
                        {bandTasks.map((t) => (
                          <MobileCard
                            key={t.id}
                            task={t}
                            cellId={cellId}
                            projects={projects}
                            clients={clients}
                            isTodayCard={i === 0}
                            onToggle={() => toggleTask(t.id)}
                            onOpen={() => setSheetTask(t)}
                          />
                        ))}
                      </SortableContext>
                    </BandDroppable>
                  </div>
                ))}
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
            projects={projects}
            clients={clients}
            isos={isos}
            anchor={anchor}
            onRename={(title) => renameTask(liveSheetTask.id, title)}
            onMove={(idx) => {
              const targetSection = PANES[idx].section;
              const targetDate = idx === 0 ? isos[0] : idx === 1 ? isos[1] : dateToISO(addDaysToDate(anchor, 7));
              dropTask(liveSheetTask, targetDate, targetSection, null, false);
            }}
            onDelete={() => { deleteTask(liveSheetTask.id); setSheetTask(null); }}
            onClose={() => setSheetTask(null)}
          />
        )}

        {/* Compose sheet */}
        {composing && (
          <ComposeSheet
            listSequence={listSequence}
            defaultSection={PANES[pane].section}
            onCreate={(title, listId, section, keepOpen) => { addTask(title, listId, section); if (!keepOpen) setComposing(false); }}
            onClose={() => setComposing(false)}
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
        ['version', `v${__APP_VERSION__}`],
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
      className={`relative z-10 flex-1 py-[15.5px] rounded-full text-center transition-colors font-['Univers_BQ:55_Regular',sans-serif] text-[14px] ${
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

function TaskSheet({ task, projects, clients, isos, anchor, onRename, onMove, onDelete, onClose }: {
  task: Task; projects: Project[]; clients: Client[]; isos: string[]; anchor: Date;
  onRename: (title: string) => void; onMove: (paneIdx: number) => void; onDelete: () => void; onClose: () => void;
}) {
  const [title, setTitle] = useState(task.title);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const commit = () => { if (title.trim() !== task.title) onRename(title.trim()); };
  const project = task.projectId ? projects.find((p) => p.id === task.projectId) : undefined;
  const client = (task.clientId ?? project?.clientId) ? clients.find((c) => c.id === (task.clientId ?? project?.clientId)) : undefined;
  // Highlight the chip for the day the task DISPLAYS on. For dated tasks that's the deadline
  // (overdue absorbs into Today), regardless of a stale section; undated tasks follow section.
  const currentIdx = task.deadline
    ? (task.deadline <= isos[0] ? 0 : task.deadline === isos[1] ? 1 : 2)
    : task.section === 'today' ? 0 : task.section === 'tomorrow' ? 1 : 2;
  return (
    <SheetShell onClose={() => { commit(); onClose(); }}>
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') { commit(); (e.target as HTMLInputElement).blur(); } }}
        placeholder="New Task"
        className="w-full bg-transparent outline-none border-none text-white font-['Univers_BQ:55_Regular',sans-serif] text-[14px] placeholder:text-[#474747] pb-[10px]"
      />
      {(client || project) && (
        <p className="font-['Univers_BQ:55_Regular',sans-serif] text-[11.5px] text-[#656464] pb-[12px]">
          {client?.short}{client && project ? <Arrowhead /> : null}{project?.name}
        </p>
      )}
      <div className="flex flex-row gap-[8px] pb-[16px]">
        {PANES.map((p, i) => (
          <button key={p.section} type="button" className={chipCls(i === currentIdx)} onClick={() => { if (i !== currentIdx) { onMove(i); } onClose(); }}>
            {p.label}
          </button>
        ))}
      </div>
      {/* Delete is two taps. Tapping a card is the most common gesture here (it opens this
          sheet), so a single-tap Delete sitting under your thumb was one mis-tap away from
          trashing a task — and the phone has no Trash view to recover it from. The second tap
          is explicitly labelled and red; tapping anything else cancels it. */}
      <div className="flex flex-row items-center justify-between border-t border-[#33312e] pt-[14px]">
        {confirmDelete ? (
          <button type="button" aria-label="Confirm delete task" onClick={onDelete} className="flex flex-row items-center gap-[8px] text-[#FF7171] p-2 -m-2">
            <Trash2 size={16} /><span className="text-[13px]">Tap again to delete</span>
          </button>
        ) : (
          <button type="button" aria-label="Delete task" onClick={() => setConfirmDelete(true)} className="flex flex-row items-center gap-[8px] text-[#656464] p-2 -m-2">
            <Trash2 size={16} /><span className="text-[13px]">Delete</span>
          </button>
        )}
        <button type="button" onClick={() => { if (confirmDelete) { setConfirmDelete(false); return; } commit(); onClose(); }} className="text-[var(--app-accent)] text-[13px] p-2 -m-2">
          {confirmDelete ? 'Cancel' : 'Done'}
        </button>
      </div>
    </SheetShell>
  );
}

function ComposeSheet({ listSequence, defaultSection, onCreate, onClose }: {
  listSequence: ListId[]; defaultSection: SectionId;
  onCreate: (title: string, listId: ListId, section: SectionId, keepOpen: boolean) => void; onClose: () => void;
}) {
  const [title, setTitle] = useState('');
  const [listId, setListId] = useState<ListId>(() => {
    try { const v = window.localStorage.getItem('todo-app-mobile-last-list') as ListId | null; return v && LISTS.includes(v) ? v : listSequence[0]; } catch { return listSequence[0]; }
  });
  const [section, setSection] = useState<SectionId>(defaultSection);
  // How many tasks this composer run has added — drives the "Added N" hint so a rapid burst
  // gives feedback even though the sheet never closes.
  const [addedCount, setAddedCount] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // WebKit only raises the software keyboard when focus() runs synchronously inside the user
  // gesture's own task. The old setTimeout(…, 120) broke that chain, so the composer opened
  // focused but with NO keyboard — you had to tap the field a second time, which also defeats
  // the return-key rapid entry. Focus in a layout effect, before paint, still inside the tap.
  useLayoutEffect(() => { inputRef.current?.focus(); }, []);
  // RAPID ENTRY (desktop parity — Enter on a title spawns the next blank one):
  // the keyboard's return key saves and immediately clears the field WITHOUT closing the sheet
  // or dismissing the keyboard, keeping the same category + day selected. Type, return, type,
  // return. The "Add Task" button is the explicit finish — it saves and closes.
  // Blur is never called on the input, so iOS keeps the keyboard up between entries.
  const save = (keepOpen: boolean) => {
    const t = title.trim();
    if (!t) { if (!keepOpen) onClose(); return; }
    try { window.localStorage.setItem('todo-app-mobile-last-list', listId); } catch { /* ignore */ }
    onCreate(t, listId, section, keepOpen);
    if (keepOpen) {
      setTitle('');
      setAddedCount((n) => n + 1);
      inputRef.current?.focus();
    }
  };
  return (
    <SheetShell onClose={onClose}>
      <div className="flex flex-row items-center justify-between pb-[10px]">
        <p className="text-[#5e5e5e] text-[13px]">{addedCount > 0 ? `Added ${addedCount} — keep going` : 'New Task'}</p>
        <button type="button" aria-label="Close" onClick={onClose} className="text-[#656464] p-2 -m-2"><X size={16} /></button>
      </div>
      <input
        ref={inputRef}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save(true); } }}
        placeholder="What needs doing?"
        // iOS: label the return key "next" (rapid entry), start each task capitalized, and skip
        // autocorrect/spellcheck noise on short task titles.
        enterKeyHint="next"
        autoCapitalize="sentences"
        autoCorrect="off"
        spellCheck={false}
        className="w-full bg-transparent outline-none border-none text-white font-['Univers_BQ:55_Regular',sans-serif] text-[14px] placeholder:text-[#474747] pb-[14px]"
      />
      <div className="flex flex-row flex-wrap gap-[8px] pb-[10px]">
        {listSequence.map((l) => (
          <button key={l} type="button" className={chipCls(l === listId)} onClick={() => setListId(l)}>{LIST_TITLES[l]}</button>
        ))}
      </div>
      <div className="flex flex-row gap-[8px] pb-[16px]">
        {PANES.map((p) => (
          <button key={p.section} type="button" className={chipCls(p.section === section)} onClick={() => setSection(p.section)}>{p.label}</button>
        ))}
      </div>
      <button
        type="button"
        onClick={() => save(false)}
        disabled={!title.trim() && addedCount === 0}
        className={`w-full py-[12px] rounded-[8px] text-[14px] font-['Univers_BQ:55_Regular',sans-serif] transition-colors ${(title.trim() || addedCount > 0) ? 'bg-[var(--app-accent)] text-[#151412]' : 'bg-[#2b2a27] text-[#5e5e5e]'}`}
      >
        {title.trim() ? 'Add Task' : addedCount > 0 ? 'Done' : 'Add Task'}
      </button>
    </SheetShell>
  );
}
