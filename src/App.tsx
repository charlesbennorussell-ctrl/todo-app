import { Fragment, memo, useState, useCallback, useMemo, useRef, useEffect, useLayoutEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Plus, X, List, FolderTree, SlidersHorizontal as SettingsIcon, Folder, Trash2, Calendar as CalendarIcon, ChevronLeft, ChevronRight, ArrowUp } from 'lucide-react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
  DragStartEvent,
  DragOverEvent,
  DragOverlay,
  MeasuringStrategy,
  pointerWithin,
  useDroppable,
} from '@dnd-kit/core';
import { restrictToVerticalAxis } from '@dnd-kit/modifiers';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useStorage, useMutation } from '@liveblocks/react/suspense';
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


function TaskCheckbox({ completed, onToggle }: { completed: boolean; onToggle: () => void }) {
  // Completed state matches the faded row palette â€” fill + border collapse into the same muted
  // mid-tone as the text (#383838), with a slightly lighter tick (#6a6a6a) and a chunkier
  // 1.5-stroke so the check actually reads at this low contrast level.
  const idleStroke = '#656464';
  const doneFill = '#383838';
  // Tick stroke is the page background color so the check reads as a cut-out shape from the
  // muted fill — same look as the original design, just on the dimmer fill.
  const tickStroke = '#282828';
  return (
    // stopPropagation on pointerdown so a click on the checkbox doesn't bubble to the row's
    // {...listeners} and start a drag â€” toggling completion stays a click, not the start of a move.
    // -mt-[2px] lifts the checkbox so its TOP sits at the title's cap-height (top of capital
    // letters) and its bottom sits roughly at the baseline â€” visually "embedded" in the text line.
    <motion.div className="relative shrink-0 size-3 cursor-pointer -mt-[2px]" whileTap={{ scale: 0.9 }} onPointerDown={(e) => e.stopPropagation()} onClick={onToggle}>
      <div className="absolute inset-0 rounded-[3.333px]" style={{ backgroundColor: completed ? doneFill : 'transparent' }}>
        <div aria-hidden="true" className="absolute border-[1.5px] border-solid inset-0 pointer-events-none rounded-[3.333px]" style={{ borderColor: completed ? doneFill : idleStroke }} />
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

function AssigneeBadge({ letter, tone, hollow = false, dim = false, active = false }: { letter: Assignee; tone: 'scheduled' | 'todo'; hollow?: boolean; dim?: boolean; active?: boolean }) {
  // `dim` matches the muted palette used for completed tasks; `active` swaps the fill to white
  // for the panel's "selected resource" treatment so the badge pops alongside its bold-white name.
  const color = dim ? '#383838' : active ? '#ffffff' : (tone === 'scheduled' ? '#8465FF' : '#656464');
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
function Arrowhead({ dim = false, tone = 'default' }: { dim?: boolean; tone?: 'default' | 'milestone' }) {
  const fill = dim ? '#383838' : tone === 'milestone' ? '#8465ff' : '#656464';
  return (
    <span className="inline-flex items-center shrink-0 mx-[4px] -mt-[2px] align-middle" style={{ height: 12 }}>
      <svg width="4" height="8" viewBox="0 0 4 8" fill="none">
        <polygon points="0,0 4,4 0,8" fill={fill} />
      </svg>
    </span>
  );
}

function DeadlineArrow({ dim = false, small = false }: { dim?: boolean; small?: boolean }) {
  // Custom inline SVG so we can shorten the LINE while keeping the arrowhead size and the
  // line's stroke thickness constant. `small` (responsive density 3+) cuts the line length
  // by ~50% (line goes from x=0..14 → x=7..14). Total wrapper width drops 18 → 11.
  // -mt-[2px] aligns the icon to the text's cap-to-baseline band, matching TaskCheckbox.
  // `dim` mirrors the muted palette used for completed tasks.
  const fill = dim ? '#383838' : '#656464';
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
        // Promote to its own compositor layer only while a drag is happening ï¿½
        // `will-change` is a strong hint and is wasteful when nothing is moving.
        willChange: active ? 'transform, margin-top' : 'auto',
      }}
    >
      {children}
    </div>
  );
});

function SortableTaskItem({
  task, onToggle, onRename, onDelete, onEdit, onQuickEdit, onAddSibling, onReschedule, onCancelPendingRename, autoFocus = false, isDragOverlay = false, displacementOffset = 0, insertionGap = 0, isAnyDragging = false, collapsed = false, projects = [], clients = [], nonDraggable = false, idPrefix = '', taskOrder = 'ptc', density = 0,
  showIndent = false, hideContext = false,
}: {
  task: Task; onToggle: () => void; onRename?: (title: string) => void; onDelete?: () => void; onEdit?: (e?: React.MouseEvent) => void; onQuickEdit?: (e?: React.MouseEvent) => void; onAddSibling?: () => void; onReschedule?: (kind: 'today' | 'tomorrow' | 'nextWeek' | 'shiftBack') => void;
  // Cancel any pending sentence-case-rename timer for this task. Called when the user re-clicks
  // the title (entering edit mode again) within the 2s post-blur window so the in-flight
  // conversion doesn't clobber the title mid-type.
  onCancelPendingRename?: () => void;
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
  const sortable = useSortable({ id: `${idPrefix}${task.id}`, data: { type: 'task', task } });
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = sortable;
  // Inside <DragOverlay>, the cloned row still calls useSortable (it lives inside DndContext) and
  // gets back transform/isDragging values describing the SOURCE row's reordering. Applying those to
  // the overlay clone makes it inherit the source's animation and can compound with the outer
  // overlay wrapper's transform â€” visible as a small vertical "jump". Neutralize them on the clone.
  const style = isDragOverlay
    ? { transform: undefined, transition: 'none' }
    : { transform: CSS.Transform.toString(transform), transition: !isAnyDragging ? 'none' : `transform ${MOTION.base}ms ${MOTION.easeOut}` };
  const isScheduled = task.type === 'scheduled';
  const isNext = task.section === 'next' || task.section === 'tomorrow';
  const isPersonal = resolvedClientId === PERSONAL_CLIENT_ID;
  // Completed tasks fade to a near-background color across ALL their text â€” no strikethrough,
  // just visually quieted. #383838 is one step off the #282828 page background.
  const titleColor = isScheduled ? 'text-[#8465ff]' : task.completed ? 'text-[#383838]' : isNext ? 'text-[#a8a8a8]' : 'text-white';
  const metaColor = task.completed ? 'text-[#383838]' : isScheduled ? 'text-[#8465ff]' : 'text-[#656464]';

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
      onMouseEnter={!isDragging && !isDragOverlay ? () => setHovered(true) : undefined}
      onMouseMove={!isDragging && !isDragOverlay && !hovered ? () => setHovered(true) : undefined}
      onMouseLeave={!isDragging && !isDragOverlay ? () => setHovered(false) : undefined}
      className={`relative shrink-0 w-full group overflow-hidden ${nonDraggable || isDragOverlay ? '' : 'cursor-grab active:cursor-grabbing'} ${isDragOverlay ? 'z-50 bg-[#333333]' : ''}`}
      animate={{
        scale: isDragOverlay ? 1.02 : 1,
        // `fading` overrides the normal opacity to drive the 3-second fade-out before deletion.
        opacity: fading ? 0 : (isDragging ? 0 : 1),
        // Hover tint: 60ms in / 300ms out, heavy ease in-out. Driven by JS state (smoother
        // framer interpolation than CSS transitions during fast cursor changes).
        ...(isDragOverlay ? {} : { backgroundColor: hovered && !isDragging ? "rgba(255, 255, 255, 0.03)" : "rgba(255, 255, 255, 0)" }),
      }}
      transition={{
        scale: { duration: 0.18 },
        opacity: fading ? { duration: 3, ease: 'linear' } : isDragging ? { duration: 0.12, ease: "easeOut" } : { duration: 0 },
        backgroundColor: { duration: hovered ? 0.06 : 0.3, ease: [0.85, 0, 0.15, 1] },
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
        {!isScheduled && <TaskCheckbox completed={task.completed} onToggle={onToggle} />}
        {/* Title row — slot order is driven by the user's `taskOrder` setting.
            Density-driven slot filtering: client hidden at >=4, project hidden at >=6.
            shrink-0 keeps the title-row at content width; the title is NEVER squeezed.
            -mr-2 cancels the outer row's gap-2, removing the redundant buffer between the
            trailing hit-zone and the assignee badge — the hit-zone itself provides the slack. */}
        <div className="flex flex-row items-center gap-[4px] min-w-0 overflow-hidden shrink-0 -mr-2">
          {(() => {
            // Compute which meta slots are "active" given the current density. The slot helper
            // already arranges them by user-chosen order — we just suppress the ones the cascade
            // has hidden by passing hasProject/hasClient = false at the right thresholds.
            // hideContext (project view 2): suppress project + client entirely — redundant.
            const showClient = !hideContext && !!client && density < 4;
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
              return <span key={key} className="-mx-[4px] inline-flex items-center"><Arrowhead dim={task.completed} tone="milestone" /></span>;
            };
            return taskOrderSlots(taskOrder, showProject, showClient).flatMap((slot, i) => {
              const metaCls = `font-['Univers_BQ:55_Regular',sans-serif] leading-[normal] not-italic text-[14px] whitespace-nowrap ${task.completed ? 'text-[#383838]' : 'text-[#656464]'}`;
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
                return [sep, <p key={`c-${i}`} className={`font-['Univers_BQ:55_Regular',sans-serif] leading-[normal] not-italic text-[14px] whitespace-nowrap ${metaColor}`}>{client.short}</p>].filter(Boolean) as React.ReactNode[];
              }
              if (slot === 'cp' && client && client.short && project && project.name) {
                const sep = sepIfMilestone(`sep-cp-${i}`);
                prevHadContent = true;
                return [sep, (
                  <p key={`cp-${i}`} className={`${metaCls} ${projectTruncate}`}>
                    {client.short}<Arrowhead dim={task.completed} />{project.name}
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
              // Fresh + still empty after blur → start the 3-second fade-then-delete sequence.
              if (fresh && !next && onDelete) {
                setFading(true);
                fadeTimerRef.current = setTimeout(() => { onDelete(); fadeTimerRef.current = null; }, 3000);
              }
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
            className={`relative z-10 font-['Univers_BQ:55_Regular',sans-serif] leading-[normal] not-italic text-[14px] outline-none whitespace-nowrap ${titleColor} ${onRename ? 'cursor-text pl-[7px] -ml-[7px]' : ''}`}
            // Hotspot tolerance:
            //   left  — 7px padding offset by negative margin so text doesn't shift
            //   right — handled by an absolutely-positioned spacer rendered AFTER the span (see
            //           below). The right side can't use padding+negative-margin alone because
            //           the parent's overflow-hidden + DOM-order hit testing make later siblings
            //           (assignee badge, deadline arrow) win the overlap.
            // Empty / very-short titles still need a comfortable min-width (40px = ~5 chars).
            style={(task.title || '').length <= 1 ? { minWidth: '40px' } : undefined}
          >{task.title}</span>
              );
              return [sep, titleNode].filter(Boolean) as React.ReactNode[];
            }
            return null;
            });
          })()}
          {/* Trailing hit-zone — a 7px (~1 char) transparent strip immediately AFTER the title.
              Captures clicks just past the title's last character and forwards them to the
              title span, dispatching a synthetic pointerdown so the existing caret-placement
              handler fires and lands the caret at the end. Lives outside the title span (so it
              isn't part of the contentEditable's text) but inside the same flex row, claiming
              real layout space — that's why DOM-order hit testing actually picks it up. */}
          {onRename && (
            <span
              aria-hidden
              className="cursor-text shrink-0 self-stretch w-[7px]"
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
        {/* Assignees hide at density >= 5. */}
        {density < 5 && task.assignees.map((a, i) => <AssigneeBadge key={`${a}-${i}`} letter={a} tone={isScheduled ? 'scheduled' : 'todo'} hollow={isPersonal} dim={task.completed} />)}
        {task.deadline && (
          <>
            {!isScheduled && <DeadlineArrow dim={task.completed} small={density >= 3} />}
            {/* Late deadlines render in #FF7171. Both Late AND Today dates are clickable:
                - double-click → reschedule to tomorrow
                - alt-click   → reschedule to next week
                Future / undated dates have no click affordance. */}
            {(() => {
              const late = isLateDeadline(task.deadline);
              // Every dated task is clickable when onReschedule is wired (was: only late+today).
              // Future tasks now respond to shift+double-click (move date earlier) and double-click
              // (push to tomorrow) so the user can advance any deadline without opening the editor.
              const clickable = !!onReschedule;
              const cls = `font-['NB_International:Regular',sans-serif] leading-[normal] not-italic text-[14.333px] whitespace-nowrap ${task.completed ? 'text-[#383838]' : isScheduled ? 'text-[#8465ff]' : late ? 'text-[#FF7171]' : isNext ? 'text-[#a8a8a8]' : 'text-white'} ${clickable ? 'cursor-pointer' : ''}`;
              return (
                <p
                  className={cls}
                  onClick={clickable ? (e) => { if (e.altKey) { e.stopPropagation(); onReschedule!('nextWeek'); } } : undefined}
                  onDoubleClick={clickable ? (e) => {
                    e.stopPropagation();
                    // shift+double-click → move date one day EARLIER (tomorrow → today, etc.)
                    if (e.shiftKey) { onReschedule!('shiftBack'); return; }
                    // overdue tasks get promoted to today (was: tomorrow); on-time / future tasks
                    // get pushed to tomorrow (the legacy "snooze one day" behavior).
                    if (late) onReschedule!('today');
                    else onReschedule!('tomorrow');
                  } : undefined}
                  title={clickable ? 'Double-click → ' + (late ? 'today' : 'tomorrow') + ' • Shift+double-click → one day earlier • Alt+click → next week' : undefined}
                >
                  {density >= 2 ? formatDeadlineShort(task.deadline) : formatDeadline(task.deadline)}
                </p>
              );
            })()}
          </>
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

function SectionHeader({ title, onAdd }: { title: string; onAdd?: () => void }) {
  // "Today" is the highlighted section across the app, so its header reads white.
  // Other section headers (Inbox, Next, Milestones, etc.) stay muted grey.
  const color = title === 'Today' ? 'text-white' : 'text-[#656464]';
  return (
    <div className="group h-[37px] w-full box-border flex flex-row gap-2 items-center px-[31px]">
      <p className={`font-['Univers_BQ:55_Regular',sans-serif] leading-[normal] not-italic ${color} text-[14px] whitespace-nowrap`}>{title}</p>
      {onAdd && <AddPlus onClick={onAdd} />}
    </div>
  );
}

function Spacer() { return <div className="h-[37px] shrink-0 w-full" />; }

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
    <div className="fixed bottom-0 left-0 right-0 h-[109px] bg-[#232323] grid grid-cols-3 items-center px-14 z-40">
      {/* Left column: three view icons. */}
      <div className="flex flex-row gap-10 items-center justify-self-start">
        <button onClick={() => onSetMode('dashboard')} className={iconClass(mode === 'dashboard')}><List size={22} /></button>
        <button onClick={() => onSetMode('projectView')} className={iconClass(mode === 'projectView')}><FolderTree size={22} /></button>
        <button onClick={() => onSetMode('calendar')} className={iconClass(mode === 'calendar')}><CalendarIcon size={22} /></button>
      </div>
      {/* Center column: + add-task button, dead-centered in the bottom bar. */}
      <motion.button onClick={onAdd} whileHover={{ scale: 1.06 }} whileTap={{ scale: 0.94 }} className="size-[27px] rounded-full bg-[#7363FF] flex items-center justify-center shadow-lg justify-self-center">
        <Plus size={16} color="#232323" strokeWidth={2.5} />
      </motion.button>
      {/* Right column: settings (3-sliders icon). */}
      <button onClick={() => onSetMode('settings')} className={`${iconClass(mode === 'settings')} justify-self-end`}><SettingsIcon size={22} /></button>
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
  const [list, setList] = useState<ListId>(editingTask?.list ?? defaultList ?? 'dashboard');
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
                <select value={section} onChange={(e) => setSection(e.target.value as SectionId)} className="flex-1 bg-[#1f1f1f] rounded-md px-3 py-2 text-white text-[14px] outline-none">
                  <option value="inbox">Inbox</option>
                  <option value="today">Today</option>
                  <option value="next">Next</option>
                </select>
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

function EditableText({ value, onChange, className, autoFocus = false, placeholder, onEditingChange, onDiscardIfEmpty, onEnter }: { value: string; onChange: (v: string) => void; className?: string; autoFocus?: boolean; placeholder?: string; onEditingChange?: (editing: boolean) => void; onDiscardIfEmpty?: () => void; onEnter?: () => void }) {
  const [editing, setEditingState] = useState(autoFocus);
  const setEditing = (v: boolean) => { setEditingState(v); onEditingChange?.(v); };
  useEffect(() => { if (autoFocus) onEditingChange?.(true); }, []);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (autoFocus && ref.current) {
      ref.current.focus();
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(ref.current);
      range.collapse(true);
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
  }, [autoFocus]);
  return (
    <span
      ref={ref}
      contentEditable={editing}
      suppressContentEditableWarning
      data-placeholder={placeholder || ''}
      // While editing, swallow pointerdown so clicks within the text place a caret
      // instead of bubbling to the row's drag listeners.
      onPointerDown={(e) => { if (editing) e.stopPropagation(); }}
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
  return (
    <button onClick={onClick} className="opacity-0 group-hover:opacity-100 text-[#656464] hover:text-white transition-opacity"><Plus size={14} /></button>
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
        {!isPersonal && !editingName && client.short && (
          <>
            <span className="w-[6px]" />
            <ShortInBrackets value={client.short} onChange={onRenameShort} />
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
    <div className="group h-[37px] w-full box-border flex flex-row gap-2 items-center px-[35px] mb-[74px]">
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
      <div className="group h-[37px] w-full box-border flex flex-row gap-2 items-center px-[35px] mb-[74px]">
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
    <div className="pt-[106px] pb-[140px] flex gap-0">
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
  return (
    <div ref={setNodeRef} className="min-w-[200px] border-r border-[#333333] last:border-r-0 flex flex-col">
      {children}
      <div className="flex-1 min-h-[100px]" />
    </div>
  );
}

const CAL_LISTS: { id: ListId; label: string }[] = [
  { id: 'admin', label: 'Admin' },
  { id: 'work', label: 'Work' },
  { id: 'projects', label: 'Projects' },
];

// Presentational body of a calendar card ï¿½ no drag wiring, no callbacks. Shared between the
// live CalendarCard and the DragOverlay so the floating ghost matches the source pixel-for-pixel.
function CalendarCardBody({ task, projects, clients, taskOrder = 'ptc' }: { task: Task; projects: Project[]; clients: Client[]; taskOrder?: TaskOrder }) {
  const project = task.projectId ? projects.find((p) => p.id === task.projectId) : undefined;
  const resolvedClientId = task.clientId ?? project?.clientId;
  const client = resolvedClientId ? clients.find((c) => c.id === resolvedClientId) : undefined;
  const isScheduled = task.type === 'scheduled';
  const isNext = task.section === 'next' || task.section === 'tomorrow';
  const isPersonal = resolvedClientId === PERSONAL_CLIENT_ID;
  const titleColor = task.completed ? 'text-[#383838]' : isScheduled ? 'text-[#8465ff]' : isNext ? 'text-[#a8a8a8]' : 'text-white';
  const metaColor = isScheduled ? 'text-[#8465ff]' : 'text-[#656464]';
  // Whether the client lives ON the first row (combined with project per the slot helper) —
  // applies to 'cpt' and 'tcp' modes where client + project sit adjacent. In 'ptc' the client
  // stays on the second row alongside assignees + date (legacy two-row calendar layout).
  const clientOnFirstRow = taskOrder !== 'ptc';
  return (
    <div className="pl-[10px] pr-[10px] py-[6px] flex flex-row items-start gap-[10px]">
      {!isScheduled && (
        <div className="shrink-0 flex items-center justify-center pt-[3px]">
          <TaskCheckbox completed={task.completed} onToggle={() => {}} />
        </div>
      )}
      <div className="flex-1 min-w-0 flex flex-col gap-[2px]">
        <div className="flex flex-row items-center gap-[4px]">
          {taskOrderSlots(taskOrder, !!project, clientOnFirstRow ? !!client : false).map((slot, i) => {
            const metaCls = `font-['Univers_BQ:55_Regular',sans-serif] text-[13px] whitespace-nowrap overflow-hidden text-ellipsis text-[#656464]`;
            if (slot === 'project' && project) return <p key={`p-${i}`} className={metaCls}>{project.name}</p>;
            if (slot === 'client' && client) return <p key={`c-${i}`} className={`font-['Univers_BQ:55_Regular',sans-serif] text-[13px] whitespace-nowrap ${metaColor}`}>{client.short}</p>;
            if (slot === 'cp' && client && project) return <p key={`cp-${i}`} className={metaCls}>{client.short}<Arrowhead dim={task.completed} />{project.name}</p>;
            if (slot === 'title') return <span key={`t-${i}`} className={`font-['Univers_BQ:55_Regular',sans-serif] text-[13px] whitespace-nowrap overflow-hidden text-ellipsis ${titleColor}`}>{task.title}</span>;
            return null;
          })}
        </div>
        <div className="flex flex-row items-center gap-[6px]">
          {/* Client only renders in this row for 'ptc' (default). cpt/tcp put it on the first row. */}
          {!clientOnFirstRow && client && <p className={`font-['Univers_BQ:55_Regular',sans-serif] text-[11.5px] whitespace-nowrap ${metaColor}`}>{client.short}</p>}
          {task.assignees.map((a, i) => <AssigneeBadge key={`${a}-${i}`} letter={a} tone={isScheduled ? 'scheduled' : 'todo'} hollow={isPersonal} dim={task.completed} />)}
          {task.deadline && <p className={`font-['NB_International:Regular',sans-serif] text-[11.5px] whitespace-nowrap ${isScheduled ? 'text-[#8465ff]' : isLateDeadline(task.deadline) ? 'text-[#FF7171]' : 'text-[#656464]'}`}>{formatDeadline(task.deadline)}</p>}
        </div>
      </div>
    </div>
  );
}

function CalendarCard({ task, cellId, projects, clients, onToggle, onRename, onDelete, onEdit, onQuickEdit, onAddSibling, isAnyDragging, dimmed, displacementOffset = 0, insertionGap = 0, taskOrder = 'ptc' }: {
  task: Task; cellId: string; projects: Project[]; clients: Client[];
  onToggle: () => void; onRename: (title: string) => void; onDelete: () => void; onEdit: () => void;
  onQuickEdit?: () => void;
  onAddSibling?: () => void;
  isAnyDragging: boolean; dimmed?: boolean;
  // Same displacement system the list view uses: cards under the dragged item shift to make room.
  displacementOffset?: number; insertionGap?: number;
  taskOrder?: TaskOrder;
}) {
  const project = task.projectId ? projects.find((p) => p.id === task.projectId) : undefined;
  const resolvedClientId = task.clientId ?? project?.clientId;
  const client = resolvedClientId ? clients.find((c) => c.id === resolvedClientId) : undefined;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: task.id, data: { type: 'task', task, calendarCellId: cellId } });
  const style = { transform: CSS.Transform.toString(transform), transition: isAnyDragging ? `transform ${MOTION.base}ms ${MOTION.easeOut}` : 'none' };
  const isScheduled = task.type === 'scheduled';
  const isNext = task.section === 'next' || task.section === 'tomorrow';
  const isPersonal = resolvedClientId === PERSONAL_CLIENT_ID;
  const titleColor = task.completed ? 'text-[#383838]' : isScheduled ? 'text-[#8465ff]' : isNext ? 'text-[#a8a8a8]' : 'text-white';
  const metaColor = isScheduled ? 'text-[#8465ff]' : 'text-[#656464]';
  // Source-collapse: outer wrapper uses max-height (CSS can't transition from auto, but it CAN
  // transition from a fixed max-height to 0) + marginBottom so the column reflows when this card
  // becomes the active drag.
  // Displacement: a motion.div wrapper animates y / marginTop so OTHER cards slide out of the way
  // to reveal where the dragged card will land ï¿½ same trick the list view uses.
  return (
    <Displaced offset={displacementOffset} gap={insertionGap} active={isAnyDragging}>
    {/* Source-collapse: when this card becomes the active drag, the slot it occupies
        smoothly closes (max-height ? 0) AND fades ï¿½ combined, it feels like the card
        physically dissolves into the column rather than just snapping out of layout. */}
    <div
      className="overflow-hidden"
      style={{
        maxHeight: isDragging ? 0 : 200,
        marginBottom: isDragging ? 0 : 4,
        opacity: isDragging ? 0 : 1,
        transition: `max-height ${MOTION.base}ms ${MOTION.easeOut}, margin-bottom ${MOTION.base}ms ${MOTION.easeOut}, opacity ${MOTION.fast}ms ${MOTION.easeStandard}`,
      }}
    >
    <div
      ref={setNodeRef}
      style={{ ...style, opacity: isDragging ? 0 : 1, transition: isAnyDragging ? `${style.transition || 'none'}, opacity 120ms ease-out` : 'opacity 120ms ease-out' }}
      className={`relative mx-[6px] rounded-md bg-[#333333] border border-[#444444] group ${dimmed ? 'opacity-60' : ''}`}
    >
      <div onDoubleClick={(e) => { e.stopPropagation(); onEdit(); }} onContextMenu={(e) => { if (onQuickEdit) { e.preventDefault(); e.stopPropagation(); onQuickEdit(); } }} {...attributes} {...listeners} className="cursor-grab active:cursor-grabbing pl-[10px] pr-[10px] py-[6px] flex flex-row items-start gap-[10px] overflow-hidden">
        {!isScheduled && (
          <div onPointerDown={(e) => e.stopPropagation()} className="shrink-0 flex items-center justify-center pt-[3px]">
            <TaskCheckbox completed={task.completed} onToggle={onToggle} />
          </div>
        )}
        <div className="flex-1 min-w-0 flex flex-col gap-[2px]">
          {(() => {
            const clientOnFirstRow = taskOrder !== 'ptc';
            return <>
              <div className="flex flex-row items-center gap-[4px]">
                {taskOrderSlots(taskOrder, !!project, clientOnFirstRow ? !!client : false).map((slot, i) => {
                  const metaCls = `font-['Univers_BQ:55_Regular',sans-serif] text-[13px] whitespace-nowrap overflow-hidden text-ellipsis text-[#656464]`;
                  if (slot === 'project' && project) return <p key={`p-${i}`} className={metaCls}>{project.name}</p>;
                  if (slot === 'client' && client) return <p key={`c-${i}`} className={`font-['Univers_BQ:55_Regular',sans-serif] text-[13px] whitespace-nowrap ${metaColor}`}>{client.short}</p>;
                  if (slot === 'cp' && client && project) return <p key={`cp-${i}`} className={metaCls}>{client.short}<Arrowhead dim={task.completed} />{project.name}</p>;
                  if (slot === 'title') return <span key={`t-${i}`} className={`font-['Univers_BQ:55_Regular',sans-serif] text-[13px] whitespace-nowrap overflow-hidden text-ellipsis ${titleColor}`}>{task.title}</span>;
                  return null;
                })}
              </div>
              <div className="flex flex-row items-center gap-[6px]">
                {!clientOnFirstRow && client && <p className={`font-['Univers_BQ:55_Regular',sans-serif] text-[11.5px] whitespace-nowrap ${metaColor}`}>{client.short}</p>}
                {task.assignees.map((a, i) => <AssigneeBadge key={`${a}-${i}`} letter={a} tone={isScheduled ? 'scheduled' : 'todo'} hollow={isPersonal} dim={task.completed} />)}
                {task.deadline && <p className={`font-['NB_International:Regular',sans-serif] text-[11.5px] whitespace-nowrap ${isScheduled ? 'text-[#8465ff]' : isLateDeadline(task.deadline) ? 'text-[#FF7171]' : 'text-[#656464]'}`}>{formatDeadline(task.deadline)}</p>}
                {/* + button hugs the inline task info on the second row. Trash stays pinned at top-right via absolute. */}
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
            </>;
          })()}
        </div>
      </div>
      <button
        type="button"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
        className="absolute top-1 right-1 p-1 opacity-0 group-hover:opacity-100 text-[#5e5e5e] hover:text-white transition-opacity"
        aria-label="Delete task"
      >
        <Trash2 size={12} />
      </button>
    </div>
    </div>
    </Displaced>
  );
}

function WeekCalendarMode({
  tasks, projects, clients, onToggleTask, onRenameTask, onDeleteTask, onEditTask, onQuickEditTask, onAddSiblingTask, isAnyDragging,
  activeTask, overTask, activeCellId, activeSlotHeight, taskOrder = 'ptc',
}: {
  tasks: Task[]; projects: Project[]; clients: Client[];
  onToggleTask: (id: string) => void;
  onRenameTask: (id: string, title: string) => void;
  onDeleteTask: (id: string) => void;
  onEditTask: (t: Task) => void;
  onQuickEditTask?: (t: Task) => void;
  onAddSiblingTask: (t: Task) => void;
  isAnyDragging: boolean;
  // Drag context piped from App so the calendar can run the same displacement math the list view runs.
  activeTask: Task | null; overTask: Task | null; activeCellId: string | null; activeSlotHeight: number;
  taskOrder?: TaskOrder;
}) {
  const [weekOffset, setWeekOffset] = useState(0);
  // Column 1 = yesterday, column 2 = today, columns 3ï¿½7 = next 5 days. weekOffset shifts the whole window by 7-day increments.
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const weekStart = addDaysToDate(today, -1 + weekOffset * 7);
  const days = Array.from({ length: 7 }, (_, i) => addDaysToDate(weekStart, i));
  const dayNameShort = (d: Date) => d.toLocaleDateString('en-US', { weekday: 'short' });
  const bodyFont = "font-['Univers_BQ:55_Regular',sans-serif] leading-[normal] not-italic text-[14px] whitespace-nowrap";
  const todayIso = dateToISO(new Date());

  const todayAnchor = useMemo(() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }, []);
  const dayOffsetFromToday = (d: Date) => Math.round((d.getTime() - todayAnchor.getTime()) / 86400000);
  const PER_DAY_CAP = 12;

  const isWeekendDate = (x: Date) => x.getDay() === 0 || x.getDay() === 6;

  // Returns the 1-based stripe slot for day d when assigning the 'next' bucket across upcoming days.
  // For Projects, every future day counts. For Work/Admin, weekends are skipped so striping lands
  // only on weekdays ï¿½ Sat/Sun stay clean unless something is explicitly dropped there.
  const stripeSlotForDay = (listId: ListId, d: Date): number | null => {
    const off = dayOffsetFromToday(d);
    if (off <= 0) return null;
    if (listId !== 'projects' && isWeekendDate(d)) return null;
    let slot = 0;
    for (let i = 1; i <= off; i++) {
      const day = addDaysToDate(todayAnchor, i);
      if (listId === 'projects' || !isWeekendDate(day)) slot++;
    }
    return slot;
  };

  const tasksForCell = (listId: ListId, d: Date): Task[] => {
    const off = dayOffsetFromToday(d);
    const iso = dateToISO(d);
    if (off === 0) {
      // Today column: every today-section task lives here, regardless of any explicit deadline.
      return tasks.filter((t) => t.list === listId && t.section === 'today' && t.type !== 'scheduled').sort((a, b) => a.order - b.order);
    }
    if (off > 0) {
      // Future days: a task with deadline === iso is pinned to this exact day (this is how a
      // work/admin task ends up on a weekend ï¿½ drop it there, the drop handler writes the deadline,
      // and we render it on that day instead of striping it through the next weekday).
      const pinned = tasks.filter((t) => t.list === listId && t.section === 'next' && t.type !== 'scheduled' && t.deadline === iso).sort((a, b) => a.order - b.order);
      const slot = stripeSlotForDay(listId, d);
      let striped: Task[] = [];
      if (slot !== null) {
        // Striped pool excludes anything that's pinned somewhere (its date already chose where it goes).
        const nextBucket = tasks.filter((t) => t.list === listId && t.section === 'next' && t.type !== 'scheduled' && !t.deadline).sort((a, b) => a.order - b.order);
        const start = (slot - 1) * PER_DAY_CAP;
        striped = nextBucket.slice(start, start + PER_DAY_CAP);
      }
      return [...pinned, ...striped];
    }
    // Past days: completed tasks whose deadline matches this day
    return tasks.filter((t) => t.list === listId && t.completed && t.deadline === iso && t.type !== 'scheduled').sort((a, b) => a.order - b.order);
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

  const MilestoneCard = ({ task, showDate }: { task: Task; showDate: boolean }) => {
    const project = task.projectId ? projects.find((p) => p.id === task.projectId) : undefined;
    const resolvedClientId = task.clientId ?? project?.clientId;
    const client = resolvedClientId ? clients.find((c) => c.id === resolvedClientId) : undefined;
    const isPersonal = resolvedClientId === PERSONAL_CLIENT_ID;
    // Milestone meta follows the user's task-order setting too. cpt/tcp combine client+project
    // on the first row; ptc keeps client on the second row alongside assignees + date.
    const clientOnFirstRow = taskOrder !== 'ptc';
    return (
      <div onDoubleClick={(e) => { e.stopPropagation(); onEditTask(task); }} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onQuickEditTask?.(task); }} className="relative mx-[6px] mb-[4px] rounded-md bg-[#333333] border border-[#444444] cursor-pointer">
        <div className="px-[10px] py-[6px] flex flex-col gap-[2px]">
          <div className="flex flex-row items-center gap-[4px]">
            {taskOrderSlots(taskOrder, !!project, clientOnFirstRow ? !!client : false).map((slot, i) => {
              if (slot === 'project' && project) return <p key={`p-${i}`} className="font-['Univers_BQ:55_Regular',sans-serif] text-[13px] whitespace-nowrap overflow-hidden text-ellipsis text-[#656464]">{project.name}</p>;
              if (slot === 'client' && client) return <p key={`c-${i}`} className="font-['Univers_BQ:55_Regular',sans-serif] text-[13px] whitespace-nowrap text-[#8465ff]">{client.short}</p>;
              if (slot === 'cp' && client && project) return <p key={`cp-${i}`} className="font-['Univers_BQ:55_Regular',sans-serif] text-[13px] whitespace-nowrap overflow-hidden text-ellipsis text-[#656464]">{client.short}<Arrowhead />{project.name}</p>;
              if (slot === 'title') return <span key={`t-${i}`} className="font-['Univers_BQ:55_Regular',sans-serif] text-[13px] whitespace-nowrap overflow-hidden text-ellipsis text-[#8465ff]">{task.title}</span>;
              return null;
            })}
          </div>
          <div className="flex flex-row items-center gap-[6px]">
            {!clientOnFirstRow && client && <p className="font-['Univers_BQ:55_Regular',sans-serif] text-[11.5px] whitespace-nowrap text-[#8465ff]">{client.short}</p>}
            {task.assignees.map((a, i) => <AssigneeBadge key={`${a}-${i}`} letter={a} tone="scheduled" hollow={isPersonal} dim={task.completed} />)}
            {showDate && task.deadline && <p className="font-['NB_International:Regular',sans-serif] text-[11.5px] whitespace-nowrap text-[#8465ff]">{formatDeadline(task.deadline)}</p>}
          </div>
        </div>
      </div>
    );
  };

  const formatRange = () => {
    const end = addDaysToDate(weekStart, 6);
    const mon = weekStart.toLocaleDateString('en-US', { month: 'short' });
    const monEnd = end.toLocaleDateString('en-US', { month: 'short' });
    return mon === monEnd
      ? `${mon} ${weekStart.getDate()}â€“${end.getDate()}, ${end.getFullYear()}`
      : `${mon} ${weekStart.getDate()} â€“ ${monEnd} ${end.getDate()}, ${end.getFullYear()}`;
  };

  return (
    <div className="pt-[106px] pb-[140px] px-[35px] min-w-[1400px]">
      <div className="flex items-center gap-3 mb-[37px]">
        <button onClick={() => setWeekOffset((o) => o - 1)} className="p-1 text-[#656464] hover:text-white transition-colors"><ChevronLeft size={20} /></button>
        <p className="font-['NB_International:Regular',sans-serif] text-white text-[14.333px]">{formatRange()}</p>
        <button onClick={() => setWeekOffset((o) => o + 1)} className="p-1 text-[#656464] hover:text-white transition-colors"><ChevronRight size={20} /></button>
        {weekOffset !== 0 && (
          <button onClick={() => setWeekOffset(0)} className={`${bodyFont} text-[#656464] hover:text-white ml-2 transition-colors`}>Today</button>
        )}
      </div>
      <div className="grid grid-cols-7 gap-0">
        {days.map((d, i) => {
          const iso = dateToISO(d);
          const isToday = iso === todayIso;
          return (
            <CalendarColumnDroppable key={iso} date={iso}>
              <div className={`h-[37px] flex items-baseline gap-2 px-[16px] mb-[74px] ${isToday ? 'text-[#8465ff]' : (d.getDay() === 0 || d.getDay() === 6 ? 'text-[#656464]' : 'text-white')}`}>
                <p className="font-['NB_International:Regular',sans-serif]">{dayNameShort(d)}</p>
                <p className={bodyFont}>{d.getDate()}</p>
                {isToday && <p className={bodyFont}>(Today)</p>}
              </div>
              {/* The last visible column gets the overflow stack of milestones whose deadlines fall beyond the window. */}
              {iso === lastVisibleIso && overflowMilestones.length > 0 && (
                <div className="mb-[12px]">
                  {overflowMilestones.map((t) => <MilestoneCard key={t.id} task={t} showDate />)}
                </div>
              )}
              {/* Milestones for this day, pinned above the per-list sections. Date is implied by the column, so it's hidden. */}
              {(milestonesByIso[iso] || []).length > 0 && (
                <div className="mb-[12px]">
                  {milestonesByIso[iso].map((t) => <MilestoneCard key={t.id} task={t} showDate={false} />)}
                </div>
              )}
              {CAL_LISTS.map(({ id: listId, label }) => {
                const bucket = tasksForCell(listId, d);
                const items = bucket.map((t) => t.id);
                const isPast = dayOffsetFromToday(d) < 0;
                // Weekends are projects-only by default. Work/Admin sections appear only if they have
                // content for that day, or while a drag is active so the user can drop onto them.
                const isWeekend = d.getDay() === 0 || d.getDay() === 6;
                if (isWeekend && listId !== 'projects' && bucket.length === 0 && !isAnyDragging) return null;
                // Displacement math (mirrors getAnimationProps in list view):
                //  - If active and over are BOTH in this bucket: cards strictly between them slide by ï¿½slotH.
                //  - If active is in a DIFFERENT bucket and over is in this bucket: the over-index card gets
                //    an insertionGap above it, opening the slot the dragged card will land in.
                const aIdx = activeTask ? bucket.findIndex((t) => t.id === activeTask.id) : -1;
                const oIdx = overTask ? bucket.findIndex((t) => t.id === overTask.id) : -1;
                const activeInBucket = aIdx >= 0;
                const overInBucket = oIdx >= 0;
                return (
                  <CalendarDayDroppable key={listId} id={`cal:${iso}:${listId}`} isEmpty={bucket.length === 0} className="pb-[37px] last:pb-0">
                    <div className="h-[20px] px-[16px] flex items-center mb-[6px]">
                      <p className={`${bodyFont} text-[#5e5e5e]`}>{label}</p>
                    </div>
                    <SortableContext items={items} strategy={verticalListSortingStrategy}>
                        {bucket.map((t, index) => {
                          let displacementOffset = 0;
                          let insertionGap = 0;
                          if (activeTask && overTask && t.id !== activeTask.id) {
                            if (activeInBucket && overInBucket) {
                              if (aIdx < oIdx && index > aIdx && index <= oIdx) displacementOffset = -activeSlotHeight;
                              else if (aIdx > oIdx && index >= oIdx && index < aIdx) displacementOffset = activeSlotHeight;
                            } else if (!activeInBucket && overInBucket) {
                              if (index === oIdx) insertionGap = activeSlotHeight;
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
                              onAddSibling={() => onAddSiblingTask(t)}
                              isAnyDragging={isAnyDragging}
                              dimmed={isPast}
                              projects={projects}
                              clients={clients}
                              displacementOffset={displacementOffset}
                              insertionGap={insertionGap}
                              taskOrder={taskOrder}
                            />
                          );
                        })}
                    </SortableContext>
                  </CalendarDayDroppable>
                );
              })}
            </CalendarColumnDroppable>
          );
        })}
      </div>
    </div>
  );
}

function SettingsMode({ people, newId, onAddPerson, onRenamePerson, onRenamePersonShort, onDeletePerson, currentUserShort, onSetCurrentUser, taskOrder, onSetTaskOrder, tomorrowEnabled, onSetTomorrowEnabled, caseMode, onSetCaseMode, trashedTasks, completedTasks, projects, clients, onUntrashTask, onPurgeTask, onToggleTask }: {
  people: Person[]; newId: string | null;
  onAddPerson: () => void;
  onRenamePerson: (id: string, name: string) => void;
  onRenamePersonShort: (id: string, short: string) => void;
  onDeletePerson: (id: string) => void;
  currentUserShort: string;
  onSetCurrentUser: (short: string) => void;
  taskOrder: TaskOrder;
  onSetTaskOrder: (v: TaskOrder) => void;
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
}) {
  const bodyFont = "font-['Univers_BQ:55_Regular',sans-serif] leading-[normal] not-italic text-[14px] whitespace-nowrap";
  return (
    <div className="pt-[106px] pb-[140px] flex gap-0">
      <div className="flex-1 min-w-[280px]">
        <div className="group h-[37px] w-full box-border flex flex-row gap-2 items-center px-[35px] mb-[20px]">
          <p className="font-['NB_International:Regular',sans-serif] text-white text-[14.333px]">I am</p>
        </div>
        <div className="px-[31px] mb-[50px] flex flex-wrap gap-2">
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
        <div className="group h-[37px] w-full box-border flex flex-row gap-2 items-center px-[35px] mb-[20px]">
          <p className="font-['NB_International:Regular',sans-serif] text-white text-[14.333px]">Task order</p>
        </div>
        <div className="px-[31px] mb-[50px] flex flex-col gap-2">
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
        {/* Tomorrow section toggle. Off → tomorrow tasks visually fall back into Next (data
            preserved). The midnight refill keeps Tomorrow at 5 tasks even while hidden — flip
            back on and you see the buffer ready to go. */}
        <div className="group h-[37px] w-full box-border flex flex-row gap-2 items-center px-[35px] mb-[20px]">
          <p className="font-['NB_International:Regular',sans-serif] text-white text-[14.333px]">Tomorrow section</p>
        </div>
        <div className="px-[31px] mb-[50px] flex flex-row gap-4">
          <button type="button" onClick={() => onSetTomorrowEnabled(true)} className={`text-[13px] transition-colors ${tomorrowEnabled ? 'text-[#8465ff] font-bold' : 'text-[#656464] hover:text-white'}`}>On</button>
          <button type="button" onClick={() => onSetTomorrowEnabled(false)} className={`text-[13px] transition-colors ${!tomorrowEnabled ? 'text-[#8465ff] font-bold' : 'text-[#656464] hover:text-white'}`}>Off</button>
        </div>
        {/* Title-case auto-correct. 2 seconds after the user blurs a title, rewrite to title
            case. Brand-name vocabulary + ALL-CAPS acronyms are preserved; small words ("and",
            "the", "of"…) stay lowercase. Off → leave titles exactly as typed. */}
        <div className="group h-[37px] w-full box-border flex flex-row gap-2 items-center px-[35px] mb-[20px]">
          <p className="font-['NB_International:Regular',sans-serif] text-white text-[14.333px]">Title case auto-correct</p>
        </div>
        <div className="px-[31px] mb-[50px] flex flex-row gap-4">
          <button type="button" onClick={() => onSetCaseMode('off')} className={`text-[13px] transition-colors ${caseMode === 'off' ? 'text-[#8465ff] font-bold' : 'text-[#656464] hover:text-white'}`}>Off</button>
          <button type="button" onClick={() => onSetCaseMode('title')} className={`text-[13px] transition-colors ${caseMode === 'title' ? 'text-[#8465ff] font-bold' : 'text-[#656464] hover:text-white'}`}>On</button>
        </div>
        <div className="group h-[37px] w-full box-border flex flex-row gap-2 items-center px-[35px] mb-[74px]">
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
        <div className="group h-[37px] w-full box-border flex flex-row gap-2 items-center px-[35px] mb-[74px]">
          <p className="font-['NB_International:Regular',sans-serif] text-white text-[14.333px]">Trash</p>
          <p className="text-[#666] text-[12px] ml-2">{trashedTasks.length}</p>
        </div>
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
      {/* COMPLETED column — tasks that have been ticked off and are now hidden from the main
          views (4 AM cleared completions live here permanently; same-day completions appear too).
          Clicking the checkbox un-completes the task — the row stays visible for 10 minutes via
          the revivedAt grace window so a misclick can be undone. */}
      <div className="flex-1 min-w-[280px]">
        <div className="group h-[37px] w-full box-border flex flex-row gap-2 items-center px-[35px] mb-[74px]">
          <p className="font-['NB_International:Regular',sans-serif] text-white text-[14.333px]">Completed</p>
          <p className="text-[#666] text-[12px] ml-2">{completedTasks.length}</p>
        </div>
        {completedTasks.length === 0 && (
          <p className="px-[35px] text-[#666] text-[13px]">Nothing checked off yet.</p>
        )}
        {completedTasks.map((t) => {
          const proj = t.projectId ? projects.find((p) => p.id === t.projectId) : undefined;
          const cli = (t.clientId ?? proj?.clientId) ? clients.find((c) => c.id === (t.clientId ?? proj?.clientId)) : undefined;
          const ctx = [cli?.short, proj?.name].filter(Boolean).join(' › ');
          return (
            <div key={t.id} className="group h-[37px] w-full box-border flex flex-row gap-2 items-center px-[31px] hover:bg-white/[0.03]">
              <TaskCheckbox completed={t.completed} onToggle={() => onToggleTask(t.id)} />
              {ctx && <p className={`${bodyFont} text-[#656464]`}>{ctx}</p>}
              {ctx && <Arrowhead />}
              <span className={`${bodyFont} ${t.completed ? 'text-[#656464] line-through' : 'text-white'}`}>{t.title || '(untitled)'}</span>
              {t.completedDay && <p className="ml-auto text-[#666] text-[12px]">{t.completedDay}</p>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SortableProjectRow({ project, listId, onRename, onDelete, onAddTask, autoFocus, isAnyDragging }: { project: Project; listId: ListId; onRename: (id: string, name: string) => void; onDelete: (id: string) => void; onAddTask: (projectId: string, listId: ListId) => void; autoFocus?: boolean; isAnyDragging?: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: `projrow-${listId}-${project.id}`, data: { type: 'project', project, listId } });
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
      <EditableText value={project.name} onChange={(v) => onRename(project.id, v)} className={`${bodyFont} text-white`} autoFocus={autoFocus} placeholder="New Project" />
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
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: `projtask-${listId}-${task.id}`, data: { type: 'projTask', task, listId } });
  const style = { transform: CSS.Transform.toString(transform), transition: isAnyDragging ? `transform ${MOTION.base}ms ${MOTION.easeOut}` : 'none' };
  const bodyFont = "font-['Univers_BQ:55_Regular',sans-serif] leading-[normal] not-italic text-[14px] whitespace-nowrap";
  const isScheduled = task.type === 'scheduled';
  const isNext = task.section === 'next' || task.section === 'tomorrow';
  const titleColor = isScheduled ? 'text-[#8465ff]' : task.completed ? 'text-[#383838]' : isNext ? 'text-[#a8a8a8]' : 'text-white';
  const metaColor = task.completed ? 'text-[#383838]' : isScheduled ? 'text-[#8465ff]' : 'text-[#656464]';
  const project = showContext && task.projectId ? projects.find((p) => p.id === task.projectId) : undefined;
  // Prefer the task's explicit clientId, fall back to the project's owning client.
  const resolvedClientId = showContext ? (task.clientId ?? project?.clientId) : undefined;
  const client = resolvedClientId ? clients.find((c) => c.id === resolvedClientId) : undefined;
  // Personal-client tasks render the hollow assignee badge regardless of whether project context is shown.
  const ownerProject = task.projectId ? projects.find((p) => p.id === task.projectId) : undefined;
  const isPersonal = (task.clientId ?? ownerProject?.clientId) === PERSONAL_CLIENT_ID;
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
        {!isScheduled && <TaskCheckbox completed={task.completed} onToggle={onToggle} />}
        {/* Same density cascade as SortableTaskItem: project truncates, date short, arrow short,
            then hide client → assignees → project. Title and date always visible. */}
        <div className="flex flex-row items-center gap-[4px] min-w-0 overflow-hidden shrink-0">
          {(() => {
            const showClient = !!client && density < 4;
            const showProject = !!project && density < 6;
            const projectTruncate = density >= 1 ? 'truncate min-w-0 max-w-[120px]' : '';
            return taskOrderSlots(taskOrder, showProject, showClient).map((slot, i) => {
              const metaCls = `${bodyFont} ${task.completed ? 'text-[#383838]' : 'text-[#656464]'}`;
              if (slot === 'project' && project) return <p key={`p-${i}`} className={`${metaCls} ${projectTruncate}`}>{project.name}</p>;
              if (slot === 'client' && client) return <p key={`c-${i}`} className={`${bodyFont} ${metaColor}`}>{client.short}</p>;
              if (slot === 'cp' && client && project) return <p key={`cp-${i}`} className={`${metaCls} ${projectTruncate}`}>{client.short}<Arrowhead dim={task.completed} />{project.name}</p>;
              if (slot === 'title') return <EditableText key={`t-${i}`} value={task.title} onChange={onRename} autoFocus={autoFocus} placeholder="New Task" onEnter={onAddSibling} className={`${bodyFont} ${titleColor}`} />;
              return null;
            });
          })()}
        </div>
        {density < 5 && task.assignees.map((a, i) => <AssigneeBadge key={`${a}-${i}`} letter={a} tone={isScheduled ? 'scheduled' : 'todo'} hollow={isPersonal} dim={task.completed} />)}
        {task.deadline && (
          <>
            {!isScheduled && <DeadlineArrow dim={task.completed} small={density >= 3} />}
            <p className={`font-['NB_International:Regular',sans-serif] leading-[normal] not-italic text-[14.333px] whitespace-nowrap ${task.completed ? 'text-[#383838]' : isScheduled ? 'text-[#8465ff]' : isLateDeadline(task.deadline) ? 'text-[#FF7171]' : isNext ? 'text-[#a8a8a8]' : 'text-white'}`}>
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
  const projectsForClient = resolvedClientId ? projects.filter((p) => p.clientId === resolvedClientId) : [];
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
          {!isMilestone && <TaskCheckbox completed={task.completed} onToggle={() => apply({ completed: !task.completed })} />}
          <EditableText
            value={task.title}
            onChange={(v) => onUpdateTask(task.id, { title: v })}
            placeholder="New Task"
            // Auto-enter edit mode for freshly created tasks so the cursor is already blinking
            // inside the empty title alongside the gray "New Task" placeholder.
            autoFocus={task.id === newId}
            className={`font-['Untitled_Sans',sans-serif] text-[14px] whitespace-nowrap ${task.completed ? 'text-[#383838]' : 'text-white'}`}
          />
          {client && <span className={`font-['Untitled_Sans',sans-serif] text-[14px] whitespace-nowrap ${task.completed ? 'text-[#383838]' : 'text-[#656464]'}`}>{client.short}</span>}
          {task.assignees.map((a, i) => <AssigneeBadge key={`${a}-${i}`} letter={a} tone={isMilestone ? 'scheduled' : 'todo'} dim={task.completed} />)}
          {task.deadline && (
            <>
              {!isMilestone && <DeadlineArrow dim={task.completed} />}
              <span className={`font-['NB_International:Regular',sans-serif] text-[14.333px] whitespace-nowrap ${task.completed ? 'text-[#383838]' : 'text-white'}`}>{formatDeadline(task.deadline)}</span>
            </>
          )}
        </div>

        {/* Type: Task / Milestone — uses the purple variant since type is the most categorical choice.
            mt-[37px] adds a SECOND spacer-row below the task preview for extra breathing room. */}
        <div className="px-[31px] flex flex-row gap-4 items-center mt-[37px]">
          <PillType active={!isMilestone} onClick={() => apply({ type: 'todo' })}>Task</PillType>
          <PillType active={isMilestone} onClick={() => apply({ type: 'scheduled' })}>Milestone</PillType>
        </div>

        {/* List: Work / Projects / Admin */}
        <div className="px-[31px] flex flex-row gap-4 items-center">
          {(['work', 'projects', 'admin'] as ListId[]).map((l) => (
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
              <Pill key={p.id} active={task.projectId === p.id} onClick={() => apply({ projectId: p.id })}>{p.name || 'New Project'}</Pill>
            ))}
            <PlusBtn onClick={() => onAddProject({ name: '', clientId: resolvedClientId })} />
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
  const [mode, setMode] = useState<AppMode>('dashboard');
  const [showAdd, setShowAdd] = useState(false);
  const [prefillList, setPrefillList] = useState<ListId | null>(null);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
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
  const [tomorrowEnabled, setTomorrowEnabledState] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem('todo-app-tomorrow-enabled') === '1';
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
  const openEdit = useCallback((t: Task, e?: { currentTarget?: EventTarget | null }) => { setEditingTask(t); setEditMode('edit'); setEditAnchor(captureAnchorFromEvent(e)); }, []);
  const openQuick = useCallback((t: Task, e?: { currentTarget?: EventTarget | null }) => { setEditingTask(t); setEditMode('quick'); setEditAnchor(captureAnchorFromEvent(e)); }, []);
  // Bottom + button: create a blank task and immediately open the edit panel for it, anchored
  // to the Work column (since new tasks default to list='work'). Title starts empty — the panel's
  // EditableText shows "New Task" as a gray placeholder which disappears on first keystroke.
  const addAndEditTask = useCallback(() => {
    const id = `t-${Date.now()}`;
    const newTask: Task = { id, title: '', type: 'todo', assignees: currentUserShort ? [currentUserShort] : [], completed: false, list: 'work', section: 'today', order: 0 };
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
  // Underlying task id (without any sortable prefix). For per-list columns this matches activeId,
  // but for prefixed contexts (dashboard sub-lists) activeId is e.g. "dash:work:taskId" while
  // activeTaskId stays "taskId" so tasks.find(t.id === activeTaskId) resolves the real task.
  const [activeTaskId, setActiveTaskIdState] = useState<string | null>(null);
  const [activeType, setActiveType] = useState<'task' | 'project' | 'projTask' | null>(null);
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [activeProjTask, setActiveProjTask] = useState<Task | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
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

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
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
      const nextCompleted = !t.completed;
      // Stamp completedDay (today's boundary) when checking; clear it + stamp revivedAt when
      // un-checking. completedDay drives the "completed clears at 4 AM" filter; revivedAt keeps
      // recently-uncompleted tasks visible in the Settings → Completed column for 10 min so a
      // misclick can be undone there.
      if (nextCompleted) return { ...t, completed: true, completedDay: todayISO(), revivedAt: undefined };
      return { ...t, completed: false, completedDay: undefined, revivedAt: Date.now() };
    }));
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
  // conjunctions, prepositions). Used in 'title' mode only.
  const TITLE_CASE_LOWER = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'nor', 'of', 'on', 'or', 'so', 'the', 'to', 'up', 'yet', 'via', 'vs', 'vs.']);
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
  const rescheduleTaskTo = useCallback((id: string, kind: 'today' | 'tomorrow' | 'nextWeek' | 'shiftBack') => {
    setTasks((prev) => prev.map((t) => {
      if (t.id !== id) return t;
      const today = new Date(); today.setHours(0, 0, 0, 0);
      let target: Date;
      if (kind === 'shiftBack') {
        // Shift the existing deadline back by one day. If no deadline yet, treat as starting from today.
        const start = t.deadline ? new Date(t.deadline + 'T00:00:00') : new Date(today);
        target = new Date(start);
        target.setDate(start.getDate() - 1);
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
      return [...prev, { id, title: '', type: 'todo', assignees: currentUserShort ? [currentUserShort] : [], completed: false, list: listId, section: 'today', order: maxOrder + 1, projectId }];
    });
    setNewId(id);
  }, [currentUserShort]);
  const addClient = useCallback((c: Omit<Client, 'id'>) => setClients((prev) => [...prev, { ...c, id: `c-${Date.now()}` }]), []);
  const [newId, setNewId] = useState<string | null>(null);
  // Pending destructive-confirm: when set, the TrashConfirmModal renders. The user must type
  // "TRASH" in the modal before the actual delete fires.
  const [pendingTrash, setPendingTrash] = useState<{ kind: 'project' | 'client'; id: string; name: string } | null>(null);
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
  const addBlankTaskInList = useCallback((listId: ListId) => {
    const id = `task-${Date.now()}`;
    setTasks((prev) => {
      const maxOrder = prev.filter((x) => x.list === listId && x.section === 'today').reduce((m, x) => Math.max(m, x.order), -1);
      return [...prev, { id, title: '', type: 'todo', assignees: currentUserShort ? [currentUserShort] : [], completed: false, list: listId, section: 'today', order: maxOrder + 1 }];
    });
    setNewId(id);
  }, [currentUserShort]);
  const addBlankTaskInSection = useCallback((listId: ListId, section: SectionId) => {
    const id = `task-${Date.now()}`;
    setTasks((prev) => {
      const maxOrder = prev.filter((x) => x.list === listId && x.section === section).reduce((m, x) => Math.max(m, x.order), -1);
      return [...prev, { id, title: '', type: 'todo', assignees: currentUserShort ? [currentUserShort] : [], completed: false, list: listId, section, order: maxOrder + 1 }];
    });
    setNewId(id);
  }, [currentUserShort]);
  // Add a blank task as a sibling of an existing one: same list/section/project, inserted right after it.
  const addSiblingTask = useCallback((sibling: Task) => {
    const id = `task-${Date.now()}`;
    setTasks((prev) => {
      const bucket = prev.filter((t) => t.list === sibling.list && t.section === sibling.section).sort((a, b) => a.order - b.order);
      const idx = bucket.findIndex((t) => t.id === sibling.id);
      const newTask: Task = { id, title: '', type: 'todo', assignees: currentUserShort ? [currentUserShort] : [], completed: false, list: sibling.list, section: sibling.section, order: 0, projectId: sibling.projectId };
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
      const shouldAutoShort = id === newId || !c.short;
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

  const handleDragStart = useCallback((e: DragStartEvent) => {
    const type = e.active.data.current?.type;
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
    setActiveId(e.active.id as string);
    setActiveTaskIdState((e.active.data.current?.task as Task | undefined)?.id ?? String(e.active.id));
    setActiveType('task');
    const rect = e.active.rect.current.initial;
    if (rect) { setActiveRectWidth(rect.width); setActiveRectHeight(rect.height); }
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
    // Column-offset snap: drag right/left and the overlay snaps to adjacent columns once you pass
    // half a column width. List view only ï¿½ calendar columns are narrow (200px) so a half-column
    // dead-zone fires constantly as the cursor crosses days, and the spring chasing the snap target
    // makes the overlay feel like it's lagging the cursor. Calendar overlay tracks the cursor 1:1.
    if (activeCalendarCellId) return;
    // Dashboard drags are strictly horizontally locked â€” never snap to an adjacent column.
    if (activeId.startsWith('dash:')) return;
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

  const handleDragOver = useCallback((event: DragOverEvent) => {
    const { over } = event;
    setOverId((over?.id as string) || null);
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
    const clearOverlay = () => { setActiveId(null); setActiveTaskIdState(null); setActiveType(null); setActiveProject(null); setActiveProjTask(null); setActiveCalendarCellId(null); };
    const resetDragRefs = () => {
      setColumnOffset(0); pendingOffsetRef.current = 0;
      if (dwellTimerRef.current) { clearTimeout(dwellTimerRef.current); dwellTimerRef.current = null; }
      if (collapseTimerRef.current) { clearTimeout(collapseTimerRef.current); collapseTimerRef.current = null; }
      setSourceCollapsed(false);
    };
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
    if (overIdStr.startsWith('cal:')) {
      const [, targetDate, targetListRaw] = overIdStr.split(':');
      const droppedList = targetListRaw as ListId;
      const srcTask = tasks.find((t) => t.id === activeTaskId);
      if (srcTask) {
        // Default: snap back to source category. Hold Ctrl/Cmd to allow category change.
        const targetList: ListId = ctrlDownRef.current ? droppedList : srcTask.list;
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const targetDateObj = new Date(targetDate + 'T00:00:00');
        const targetSection: SectionId = targetDateObj.getTime() <= today.getTime() ? 'today' : 'next';
        const sameBucket = srcTask.list === targetList && srcTask.section === targetSection;
        setTasks((prev) => {
          // Remove source first so it can't be double-counted.
          const without = prev.filter((t) => t.id !== srcTask.id);
          const moved: Task = { ...srcTask, list: targetList, section: targetSection, deadline: targetDate };
          if (sameBucket) {
            // Append moved to end of the combined bucket, reorder, leave other buckets untouched.
            const bucket = without.filter((t) => t.list === targetList && t.section === targetSection);
            const reordered = [...bucket, moved].map((t, i) => ({ ...t, order: i }));
            const untouched = without.filter((t) => !(t.list === targetList && t.section === targetSection));
            return [...untouched, ...reordered];
          }
          const fromOthers = without.filter((t) => t.list === srcTask.list && t.section === srcTask.section).map((t, i) => ({ ...t, order: i }));
          const toBucket = without.filter((t) => t.list === targetList && t.section === targetSection);
          const reorderedTo = [...toBucket, moved].map((t, i) => ({ ...t, order: i }));
          const untouched = without.filter((t) => !(t.list === srcTask.list && t.section === srcTask.section) && !(t.list === targetList && t.section === targetSection));
          return [...untouched, ...fromOthers, ...reorderedTo];
        });
      }
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
    // Dashboard cards are horizontally locked: a drag from one dashboard sub-list (e.g. "dash:work:")
    // can only resolve to drops within the SAME sub-list. Drops on a different sub-list, or on a
    // per-list column's copy of the task, are ignored â€” no list-changing moves from the dashboard.
    const prefixOf = (id: string) => { const i = id.lastIndexOf(':'); return i >= 0 ? id.substring(0, i + 1) : ''; };
    const activePrefix = prefixOf(String(active.id));
    const overPrefix = prefixOf(String(over.id));
    if (activePrefix.startsWith('dash:') && activePrefix !== overPrefix) {
      setActiveId(null); setActiveTaskIdState(null); setActiveType(null); setActiveCalendarCellId(null); setColumnOffset(0); pendingOffsetRef.current = 0; if (dwellTimerRef.current) { clearTimeout(dwellTimerRef.current); dwellTimerRef.current = null; } if (collapseTimerRef.current) { clearTimeout(collapseTimerRef.current); collapseTimerRef.current = null; } setSourceCollapsed(false); return;
    }
    if (a.list === o.list && a.section === o.section) {
      setTasks((prev) => {
        const list = prev.filter((t) => t.list === a.list && t.section === a.section).sort((x, y) => x.order - y.order);
        const oldI = list.findIndex((t) => t.id === a.id);
        const newI = list.findIndex((t) => t.id === o.id);
        if (oldI === newI) return prev;
        const reordered = arrayMove(list, oldI, newI).map((t, i) => ({ ...t, order: i }));
        return [...prev.filter((t) => !(t.list === a.list && t.section === a.section)), ...reordered];
      });
    } else {
      handleCrossSectionMove(a, o);
    }
    setActiveId(null); setActiveTaskIdState(null); setActiveType(null); setActiveCalendarCellId(null); setColumnOffset(0); pendingOffsetRef.current = 0; if (dwellTimerRef.current) { clearTimeout(dwellTimerRef.current); dwellTimerRef.current = null; } if (collapseTimerRef.current) { clearTimeout(collapseTimerRef.current); collapseTimerRef.current = null; } setSourceCollapsed(false);
  }, [tasks]);

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
        // STEP B — top up Tomorrow to TARGET=3 from Next. Today is left untouched (sacred —
        // only the deadline-driven promotion above adds to it).
        const lists: ListId[] = ['work', 'projects', 'admin'];
        for (const listId of lists) {
          const cmp = (a: Task, b: Task) => a.order - b.order;
          const tomorrowList = next.filter((t) => t.list === listId && t.section === 'tomorrow' && t.type !== 'scheduled' && !t.completed).sort(cmp);
          const nextList = next.filter((t) => t.list === listId && t.section === 'next' && t.type !== 'scheduled' && !t.completed).sort(cmp);
          while (tomorrowList.length < TARGET && nextList.length > 0) {
            const moved = nextList.shift()!;
            const idx = next.findIndex((t) => t.id === moved.id);
            if (idx >= 0) { next[idx] = { ...next[idx], section: 'tomorrow' }; tomorrowList.push(next[idx]); }
          }
          // Re-number order within Tomorrow + Next so newly moved tasks land at the end.
          [tomorrowList, nextList].forEach((bucketList, bucketIdx) => {
            const sec = (['tomorrow', 'next'] as SectionId[])[bucketIdx];
            bucketList.forEach((t, i) => {
              const idx = next.findIndex((x) => x.id === t.id);
              if (idx >= 0) next[idx] = { ...next[idx], section: sec, order: i };
            });
          });
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

  // Tasks in the "Personal" client are scoped to their assignees: other users never see them.
  // This filter is applied to every display path (list, project, calendar, dashboard) so Personal
  // work stays off the team's radar.
  // Also strip:
  //   - trashed tasks (they live in Settings → Trash)
  //   - tasks completed before today's day boundary (they live in Settings → Completed; calendar
  //     bypasses this filter and shows historical completions)
  // Recently revived tasks (revivedAt within 10 min) are always shown regardless of completedDay.
  const REVIVE_WINDOW_MS = 10 * 60 * 1000;
  const visibleTasks = useMemo(() => {
    const today = todayISO();
    const now = Date.now();
    return tasks.filter((t) => {
      if (t.trashed) return false;
      if (t.clientId === PERSONAL_CLIENT_ID && !t.assignees.includes(currentUserShort)) return false;
      if (t.completed && t.completedDay && t.completedDay < today) {
        // Hide unless within the post-revive grace window (handles re-completion after revival).
        if (!t.revivedAt || now - t.revivedAt > REVIVE_WINDOW_MS) return false;
      }
      return true;
    });
  }, [tasks, currentUserShort]);

  // Calendar view bypasses the completedDay filter — historical completions stay visible there.
  const calendarTasks = useMemo(
    () => tasks.filter((t) => !t.trashed && (t.clientId !== PERSONAL_CLIENT_ID || t.assignees.includes(currentUserShort))),
    [tasks, currentUserShort]
  );

  // Settings → Trash column: every soft-deleted task (newest first by trashedAt). Personal
  // scoping still applies — other users don't see your trashed Personal items.
  const trashedTasks = useMemo(
    () => tasks
      .filter((t) => t.trashed && (t.clientId !== PERSONAL_CLIENT_ID || t.assignees.includes(currentUserShort)))
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
        if (t.clientId === PERSONAL_CLIENT_ID && !t.assignees.includes(currentUserShort)) return false;
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
    for (const k of Object.keys(m)) {
      if (k.endsWith(':milestones')) {
        // Sort milestones by deadline ascending; undated last; ties broken by title.
        m[k].sort((a, b) => {
          const ad = a.deadline || '\uffff';
          const bd = b.deadline || '\uffff';
          if (ad !== bd) return ad < bd ? -1 : 1;
          return a.title.localeCompare(b.title);
        });
      } else {
        // Sort by deadline ascending when dates are present; undated tasks fall to the bottom
        // and keep their existing manual order. Ties between two dated tasks fall back to order.
        m[k].sort((a, b) => {
          const ad = a.deadline;
          const bd = b.deadline;
          if (ad && bd) return ad === bd ? a.order - b.order : ad < bd ? -1 : 1;
          if (ad) return -1;
          if (bd) return 1;
          return a.order - b.order;
        });
      }
    }
    // Dashboard = aggregated view of work+projects+admin filtered to current user
    const dashBuckets = ['milestones', 'inbox', 'today', 'next'] as const;
    for (const s of dashBuckets) {
      const agg: Task[] = [];
      for (const l of ['work', 'projects', 'admin'] as ListId[]) {
        for (const t of (m[`${l}:${s}`] || [])) {
          if (t.assignees.includes(currentUserShort)) agg.push(t);
        }
      }
      if (s === 'milestones') {
        agg.sort((a, b) => {
          const ad = a.deadline || '\uffff';
          const bd = b.deadline || '\uffff';
          if (ad !== bd) return ad < bd ? -1 : 1;
          return a.title.localeCompare(b.title);
        });
      }
      m[`dashboard:${s}`] = agg;
    }
    // Per-list dashboard sub-sections under Today: each list's today tasks for the current user.
    // Order preserved from the underlying today bucket.
    for (const l of ['work', 'projects', 'admin'] as ListId[]) {
      const agg = (m[`${l}:today`] || []).filter((t) => t.assignees.includes(currentUserShort));
      m[`dashboard:list:${l}`] = agg;
    }
    return m;
  }, [visibleTasks, currentUserShort, effectiveListFor]);

  const activeTask = activeTaskId ? tasks.find((t) => t.id === activeTaskId) : null;
  // overId may carry a sortable prefix (e.g. "dash:work:taskId"). Strip it so we can resolve the
  // real task â€” otherwise hovering over a dashboard card returns null and displacement bails out.
  const overTask = useMemo(() => {
    if (!overId) return null;
    const s = String(overId);
    const i = s.lastIndexOf(':');
    const taskId = i >= 0 ? s.substring(i + 1) : s;
    return tasks.find((t) => t.id === taskId) ?? null;
  }, [overId, tasks]);
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
    // whose context the active drag actually originated in â€” otherwise picking up a dashboard task
    // also displaces the per-list column's copy of it (visual duplicates, overlaps).
    const prefixOf = (id: string | null | undefined) => {
      if (!id) return '';
      const i = id.lastIndexOf(':');
      return i >= 0 ? id.substring(0, i + 1) : '';
    };
    const activePrefix = prefixOf(activeId);
    if (activePrefix !== idPrefix) return { displacementOffset: 0, insertionGap: 0 };
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
            <SortableTaskItem key={`${idPrefix}${task.id}`} task={task} idPrefix={idPrefix} onToggle={() => toggleTask(task.id)} onRename={(title) => renameTask(task.id, title)} onDelete={() => deleteTask(task.id)} onEdit={(e) => openEdit(task, e)} onQuickEdit={(e) => openQuick(task, e)} onAddSibling={() => addSiblingTask(task)} onReschedule={(kind) => rescheduleTaskTo(task.id, kind)} onCancelPendingRename={() => cancelSentenceCaseTask(task.id)} autoFocus={task.id === newId} displacementOffset={displacementOffset} insertionGap={insertionGap} isAnyDragging={!!activeTask} collapsed={sourceCollapsed && `${idPrefix}${task.id}` === activeId} projects={projects} clients={clients} taskOrder={taskOrder} density={density} />
          );
        })}
      </AnimatePresence>
    </SortableContext>
  );

  // Milestones are read-only in the column: not draggable, sorted by deadline. Still rendered through
  // SortableTaskItem (with nonDraggable) so visuals stay identical to other rows. Inherits the
  // user's taskOrder + density just like regular tasks so the meta-slot order matches.
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
          isAnyDragging={!!activeTask}
          projects={projects}
          clients={clients}
          taskOrder={taskOrder}
          density={density}
          nonDraggable
        />
      ))}
    </>
  );

  const renderReadonlyBucket = (list: Task[]) => (
    <>
      {list.map((task) => {
        const project = task.projectId ? projects.find((p) => p.id === task.projectId) : undefined;
        const resolvedClientId = task.clientId ?? project?.clientId;
        const client = resolvedClientId ? clients.find((c) => c.id === resolvedClientId) : undefined;
        const isScheduled = task.type === 'scheduled';
        const isNext = task.section === 'next' || task.section === 'tomorrow';
        const isPersonal = resolvedClientId === PERSONAL_CLIENT_ID;
        const titleColor = isScheduled ? 'text-[#8465ff]' : task.completed ? 'text-[#383838]' : isNext ? 'text-[#a8a8a8]' : 'text-white';
        const metaColor = task.completed ? 'text-[#383838]' : isScheduled ? 'text-[#8465ff]' : 'text-[#656464]';
        return (
          <div key={`dash-${task.id}`} onDoubleClick={() => openEdit(task)} onContextMenu={(e) => { e.preventDefault(); openQuick(task); }} className="h-[37px] box-border flex flex-row gap-2 items-center px-[31px] w-full group hover:bg-white/[0.03]">
            {!isScheduled && <TaskCheckbox completed={task.completed} onToggle={() => toggleTask(task.id)} />}
            <div className="flex flex-row items-center gap-[4px]">
              {/* Use the shared taskOrderSlots so dashboard milestones honor the user's chosen
                  meta order (cpt / tcp / ptc, etc.) — same as regular task rows do. */}
              {(() => {
                const showClient = !!client;
                const showProject = !!project;
                const metaCls = `font-['Univers_BQ:55_Regular',sans-serif] text-[14px] whitespace-nowrap ${task.completed ? 'text-[#383838]' : 'text-[#656464]'}`;
                return taskOrderSlots(taskOrder, showProject, showClient).map((slot, i) => {
                  if (slot === 'project' && project) return <p key={`p-${i}`} className={metaCls}>{project.name}</p>;
                  if (slot === 'client' && client) return <p key={`c-${i}`} className={`font-['Univers_BQ:55_Regular',sans-serif] text-[14px] whitespace-nowrap ${metaColor}`}>{client.short}</p>;
                  if (slot === 'cp' && client && project) return <p key={`cp-${i}`} className={metaCls}>{client.short}<Arrowhead dim={task.completed} />{project.name}</p>;
                  if (slot === 'title') return <span key={`t-${i}`} className={`font-['Univers_BQ:55_Regular',sans-serif] text-[14px] whitespace-nowrap ${titleColor}`}>{task.title}</span>;
                  return null;
                });
              })()}
            </div>
            {task.assignees.map((a, i) => <AssigneeBadge key={`${a}-${i}`} letter={a} tone={isScheduled ? 'scheduled' : 'todo'} hollow={isPersonal} dim={task.completed} />)}
            {task.deadline && (
              <>
                {!isScheduled && <DeadlineArrow dim={task.completed} />}
                <p className={`font-['NB_International:Regular',sans-serif] text-[14.333px] whitespace-nowrap ${task.completed ? 'text-[#383838]' : isScheduled ? 'text-[#8465ff]' : isLateDeadline(task.deadline) ? 'text-[#FF7171]' : isNext ? 'text-[#a8a8a8]' : 'text-white'}`}>{formatDeadline(task.deadline)}</p>
              </>
            )}
            <button
              type="button"
              onClick={() => deleteTask(task.id)}
              className="ml-auto -mr-[22px] p-1 opacity-0 group-hover:opacity-100 text-[#5e5e5e] hover:text-white transition-opacity"
              aria-label="Delete task"
            >
              <Trash2 size={14} />
            </button>
          </div>
        );
      })}
    </>
  );

  const renderColumn = (listId: ListId) => {
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
      <div key={listId} className="flex-1 min-w-[280px]">
        <p className={`font-['NB_International:Regular',sans-serif] leading-[normal] not-italic text-[14.333px] px-[35px] mb-[74px] ${listId === 'dashboard' ? 'text-[#8465ff]' : 'text-white'}`}>
          {LIST_TITLES[listId]}
          {listId === 'dashboard' && (
            <span> ({people.find((p) => p.short === currentUserShort)?.name || currentUserShort})</span>
          )}
        </p>
        {milestones.length > 0 && wrap('milestones', milestoneBucket(milestones))}
        {(tasksByKey[`${listId}:inbox`] || []).length > 0 && wrap('inbox', bucket(tasksByKey[`${listId}:inbox`] || []))}
        {listId === 'dashboard' ? (
          // Categorize the dashboard's Today items by list. Inbox + Next are intentionally hidden here.
          <>
            <SectionHeader title="Today" />
            {(['admin', 'work', 'projects'] as ListId[]).map((l) => {
              const items = tasksByKey[`dashboard:list:${l}`] || [];
              if (items.length === 0) return null;
              return (
                <Fragment key={`dash-list-${l}`}>
                  <Spacer />
                  <SectionHeader title={LIST_TITLES[l]} />
                  {/* idPrefix isolates the dashboard's sortable ids from the per-list columns,
                      so the same task rendered in both places doesn't share a drag state. */}
                  {bucket(items, `dash:${l}:`)}
                </Fragment>
              );
            })}
          </>
        ) : (
          // Headers live INSIDE their section's droppable so dropping ON the "Today" / "Next"
          // label (or anywhere in that section's empty space) lands in that section. Previously
          // the headers were free-standing siblings â€” drops on them fell through.
          <>
            {wrap('today', (
              <>
                <SectionHeader title="Today" onAdd={() => addBlankTaskInSection(listId, 'today')} />
                {bucket(tasksByKey[`${listId}:today`] || [])}
              </>
            ))}
            {tomorrowEnabled && wrap('tomorrow', (
              <>
                <SectionHeader title="Tomorrow" onAdd={() => addBlankTaskInSection(listId, 'tomorrow')} />
                {bucket(tasksByKey[`${listId}:tomorrow`] || [])}
              </>
            ))}
            {wrap('next', (
              <>
                <SectionHeader title="Next" onAdd={() => addBlankTaskInSection(listId, 'next')} />
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
  const renderProjectGroupedColumn = (listId: ListId) => {
    // Render a sortable bucket of tasks with the project-view-2 visual flags. Same wiring as
    // list view's renderBucket. The third arg toggles the LIndent ⌐ prefix — true for tasks
    // under a project header, false for the orphan tasks at the column top (no parent to indent
    // under, so the indent reads as visual noise).
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
                /* Project View 2 deliberately omits onDelete on rows — keeps the project-focused
                   view visually clean. Right-click any task → Quick Edit panel still has Delete. */
                onEdit={(e) => openEdit(task, e)}
                onQuickEdit={(e) => openQuick(task, e)}
                onAddSibling={() => addSiblingTask(task)}
                onReschedule={(kind) => rescheduleTaskTo(task.id, kind)}
                onCancelPendingRename={() => cancelSentenceCaseTask(task.id)}
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
    // Gather all tasks visible in this list (across all sections — Project View 2 doesn't carve
    // by today/tomorrow/next, it carves by client > project).
    const allTasks = (tasksByKey[`${listId}:today`] || [])
      .concat(tasksByKey[`${listId}:tomorrow`] || [])
      .concat(tasksByKey[`${listId}:next`] || [])
      .concat(tasksByKey[`${listId}:inbox`] || []);
    // Map projectId → tasks (non-projected tasks go to orphans)
    const tasksByProject = new Map<string, Task[]>();
    const orphans: Task[] = [];
    for (const t of allTasks) {
      if (t.projectId && projects.find((p) => p.id === t.projectId)) {
        const arr = tasksByProject.get(t.projectId) || [];
        arr.push(t);
        tasksByProject.set(t.projectId, arr);
      } else {
        orphans.push(t);
      }
    }
    // Build the client > projects hierarchy. A client appears in this column if any of its
    // projects has tasks here OR is pinned to this list.
    const clientBlocks = proj2SortedClients
      .map((c) => {
        const clientProjects = projects
          .filter((p) => p.clientId === c.id)
          .filter((p) => {
            if (p.list) return p.list === listId;
            // Unpinned project: show in 'projects' list as default home, plus anywhere it has tasks here
            return listId === 'projects' || tasksByProject.has(p.id);
          });
        return { client: c, projects: clientProjects };
      })
      .filter((b) => b.projects.length > 0);
    return (
      <div key={listId} className="flex-1 min-w-[280px]">
        {/* Column header with the cascading add menu (HeaderAddMenu) for adding a client,
            project (optionally under a client), or blank task into THIS column. */}
        <div className="group h-[37px] w-full box-border flex flex-row gap-2 items-center px-[35px] mb-[74px]">
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
        {orphans.length > 0 && (
          <div className="mb-[37px]">
            {renderProjectBucket(orphans, `proj2:${listId}:none:`, false)}
          </div>
        )}
        {clientBlocks.map(({ client: c, projects: clientProjects }, ci) => (
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
            {clientProjects.map((p) => {
              const projTasks = tasksByProject.get(p.id) || [];
              return (
                <div key={p.id}>
                  {/* Project header — folder icon + EDITABLE project name + AddPlus to spawn
                      a new task under this project. The name uses EditableText so the user can
                      click-to-rename, with placeholder + autoFocus on freshly-created projects.
                      onDiscardIfEmpty deletes the project if the user blurs without typing
                      anything (matches the fresh-task fade behavior). */}
                  <div className="group h-[37px] w-full box-border flex flex-row gap-2 items-center px-[35px]">
                    <Folder size={12} className="text-[#656464]" />
                    <EditableText
                      value={p.name}
                      onChange={(v) => renameProject(p.id, v)}
                      autoFocus={p.id === newId}
                      placeholder="New Project"
                      onDiscardIfEmpty={() => deleteProject(p.id)}
                      className={`${proj2BodyFont} text-white`}
                    />
                    <AddPlus onClick={() => addTaskToProject(p.id, listId)} />
                    <div className="ml-auto">
                      <TrashBtn onClick={() => setPendingTrash({ kind: 'project', id: p.id, name: p.name || 'Untitled' })} />
                    </div>
                  </div>
                  {projTasks.length > 0 && renderProjectBucket(projTasks, `proj2:${listId}:${p.id}:`, true)}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    );
  };

  const calendarCollision = useCallback((args: Parameters<typeof pointerWithin>[0]) => {
    const collisions = pointerWithin(args);
    if (mode !== 'calendar') return collisions;
    const activeCellId = args.active.data.current?.calendarCellId as string | undefined;
    const activeTask = args.active.data.current?.task as Task | undefined;
    if (!activeCellId || !activeTask) return collisions;
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
    for (const c of collisions) {
      const id = String(c.id);
      if (id.startsWith('col:')) {
        if (!columnHit) columnHit = { id, date: id.split(':')[1] };
        continue;
      }
      if (id.startsWith('cal:')) {
        const [, date, list] = id.split(':');
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
      onDragEnd={handleDragEnd}
      measuring={measuringConfig}
      modifiers={activeType === 'task' || activeType === 'projTask' ? [restrictToVerticalAxis] : []}
    >
      <div className="relative min-h-screen bg-[#282828] overflow-x-auto">
        {mode === 'dashboard' && (
          <div className="pt-[106px] pb-[140px] flex gap-0">
            {LISTS.map(renderColumn)}
          </div>
        )}
        {mode === 'projectView' && (
          // PROJECT VIEW — built from list view's renderColumn, grouping tasks by project.
          // Inherits ALL of list view's working drag mechanics 1:1 (renderBucket, SortableTaskItem,
          // getAnimationProps, the existing DragOverlay path). The only diff is the column body
          // uses renderProjectGroupedColumn (with client > project hierarchy) instead of
          // renderColumn. The Dashboard column is replaced with a Resources + Clients sidebar.
          <div className="pt-[106px] pb-[140px] flex gap-0">
            {/* Sidebar: Resources (people) + Clients */}
            <div className="flex-1 min-w-[280px]">
              <div className="group h-[37px] w-full box-border flex flex-row gap-2 items-center px-[35px] mb-[74px]">
                <p className="font-['NB_International:Regular',sans-serif] text-white text-[14.333px]">Resources</p>
                <AddPlus onClick={addPerson} />
              </div>
              {people.map((p) => (
                <ResourceRow key={p.id} person={p} bodyFont={proj2BodyFont} onDelete={() => deletePerson(p.id)} />
              ))}
              <Spacer />
              <div className="group h-[37px] w-full box-border flex flex-row gap-2 items-center px-[35px] mb-[74px]">
                <p className="font-['NB_International:Regular',sans-serif] text-white text-[14.333px]">Clients</p>
                <AddPlus onClick={addBlankClient} />
              </div>
              {proj2SortedClients.map((c) => (
                <ClientRow
                  key={c.id}
                  client={c}
                  autoFocus={c.id === newId}
                  bodyFont={proj2BodyFont}
                  onRenameName={(v) => renameClient(c.id, v)}
                  onRenameShort={(v) => renameClientShort(c.id, v)}
                  onDelete={() => deleteClient(c.id)}
                  currentUserShort={currentUserShort}
                />
              ))}
            </div>
            {(['work', 'projects', 'admin'] as ListId[]).map((l) => renderProjectGroupedColumn(l))}
          </div>
        )}
        {/* Legacy ProjectViewMode removed — `mode === 'projectView'` now renders the new
            project view above (built off list view's drag tech). */}
        {mode === 'calendar' && (
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
            isAnyDragging={!!activeId}
            activeTask={activeTask}
            overTask={overTask}
            activeCellId={activeCalendarCellId}
            activeSlotHeight={(activeRectHeight ?? 50) + 4}
            taskOrder={taskOrder}
          />
        )}
        {mode === 'settings' && (
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
          />
        )}

        <BottomBar mode={mode} onSetMode={setMode} onAdd={addAndEditTask} />

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
              // Calendar drag: free-floating ghost that tracks the cursor 1:1 ï¿½ no column-snap spring
              // fighting the cursor (calendar columns are narrow, snapping makes it feel laggy).
              // Drop shadow restored at 1/4 size, 1/2 opacity vs. the original. Subtle enough that
              // the per-frame repaint cost is negligible while still conveying that the card is lifted.
              <motion.div
                initial={{ scale: 1 }}
                animate={{
                  scale: 1.02,
                  boxShadow: "0 1.875px 7.5px -0.625px rgba(0, 0, 0, 0.35), 0 1.25px 3.125px -0.3125px rgba(0, 0, 0, 0.25)",
                }}
                transition={{ scale: { type: "spring", stiffness: 600, damping: 30, mass: 0.4 } }}
                className="rounded-md bg-[#333333] overflow-hidden"
                style={{ width: activeRectWidth, height: activeRectHeight, willChange: 'transform' }}
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
                style={{ width: activeRectWidth, willChange: 'transform' }}
              >
                <SortableTaskItem task={activeTask} onToggle={() => {}} isDragOverlay projects={projects} clients={clients} />
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
              style={{ width: activeRectWidth, willChange: 'transform' }}
            >
              <Folder size={12} className="text-[#656464]" />
              <span className="font-['Univers_BQ:55_Regular',sans-serif] text-[14px] text-white whitespace-nowrap">{activeProject.name}</span>
            </motion.div>
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
              style={{ width: activeRectWidth, willChange: 'transform' }}
            >
              <LIndent />
              <TaskCheckbox completed={activeProjTask.completed} onToggle={() => {}} />
              <span className={`font-['Univers_BQ:55_Regular',sans-serif] text-[14px] whitespace-nowrap ${activeProjTask.completed ? 'text-[#383838]' : 'text-white'}`}>{activeProjTask.title}</span>
            </motion.div>
          ) : null}
        </DragOverlay>
      </div>
    </DndContext>
  );
}
