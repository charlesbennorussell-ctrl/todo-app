// MobileApp — iPhone-first companion shell for the desktop App. Renders at
// viewport widths < 768px (see Shell() in main.tsx). The user gets four
// horizontally-swipeable pages, in order:
//   1. Dashboard   — today's tasks only (one section per list)
//   2. List        — every non-completed task, grouped by list → section
//   3. Project     — collapsible projects, each with its tasks
//   4. Calendar    — upcoming tasks grouped by date band (Today / Tomorrow
//                    / This week / Later)
// All four pages reuse the desktop's Liveblocks-backed tasks/projects/clients
// state, so checking a task on the iPhone shows up on the desktop instantly
// and vice-versa.

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useStorage, useMutation } from '@liveblocks/react/suspense';
import { ChevronDown, ChevronRight as ChevronRightIcon } from 'lucide-react';
import type { Task, Project, Client, ListId, SectionId } from './data';
import { LIST_TITLES } from './data';

// ── Helpers shared by every page ──────────────────────────────────────────

/** ISO day string (YYYY-MM-DD) in the local timezone. Matches the desktop
 *  app's `todayIso` convention so date comparisons line up. */
function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function isoOffset(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function formatDayLabel(iso: string): string {
  const today = todayIso();
  if (iso === today) return 'Today';
  if (iso === isoOffset(1)) return 'Tomorrow';
  const d = new Date(iso + 'T00:00:00');
  const today0 = new Date(todayIso() + 'T00:00:00');
  const diffDays = Math.round((d.getTime() - today0.getTime()) / 86400000);
  if (diffDays > 1 && diffDays <= 6) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

const SECTION_ORDER: SectionId[] = ['today', 'tomorrow', 'next', 'inbox'];
const LIST_ORDER: ListId[] = ['dashboard', 'work', 'projects', 'admin'];
const SECTION_LABEL: Record<SectionId, string> = { today: 'Today', tomorrow: 'Tomorrow', next: 'Next', inbox: 'Inbox' };

// ── Task row — shared atom across all four pages ──────────────────────────

function TaskRow({
  task,
  projectName,
  clientShort,
  onToggle,
}: {
  task: Task;
  projectName?: string;
  clientShort?: string;
  onToggle: () => void;
}) {
  // Compact, touch-friendly row. Minimum 44px height = iOS hit-target floor.
  // Title is two-line clamped; project/client breadcrumb sits below in a
  // muted second line. Tap the checkbox area to toggle complete; the title
  // area is reserved for a future detail/edit sheet (not wired in v1 — the
  // user can switch to desktop for editing).
  const breadcrumb = [clientShort, projectName].filter(Boolean).join(' › ');
  return (
    <div className="flex flex-row items-start gap-3 py-2 px-4 min-h-[44px] active:bg-white/[0.04]">
      <button
        type="button"
        onClick={onToggle}
        aria-label={task.completed ? 'Mark incomplete' : 'Mark complete'}
        className="shrink-0 mt-[2px] w-[18px] h-[18px] rounded-full border border-[#656464] flex items-center justify-center"
      >
        {task.completed && <div className="w-[8px] h-[8px] rounded-full bg-[#a8a8a8]" />}
      </button>
      <div className="flex-1 min-w-0">
        <div className={`leading-[1.3] ${task.completed ? 'text-[#474747] line-through' : 'text-white'}`}>{task.title || 'Untitled'}</div>
        {breadcrumb && (
          <div className="text-[#656464] text-[12px] leading-[1.2] mt-[2px]">{breadcrumb}</div>
        )}
      </div>
    </div>
  );
}

// ── Section header (sticky band on top of each task group) ────────────────

function SectionHeader({ label, count }: { label: string; count?: number }) {
  return (
    <div className="sticky top-0 z-10 bg-[#282828] px-4 py-2 text-[#a8a8a8] text-[12px] flex flex-row items-center justify-between border-b border-[#1f1f1f]">
      <span>{label}</span>
      {typeof count === 'number' && <span className="text-[#656464]">{count}</span>}
    </div>
  );
}

// ── Pages ─────────────────────────────────────────────────────────────────

type PageProps = {
  tasks: Task[];
  projects: Project[];
  clients: Client[];
  onToggleTask: (id: string) => void;
};

function projectLookup(projects: Project[], clients: Client[], projectId?: string): { projectName?: string; clientShort?: string } {
  if (!projectId) return {};
  const p = projects.find((pr) => pr.id === projectId);
  if (!p) return {};
  const c = p.clientId ? clients.find((cl) => cl.id === p.clientId) : undefined;
  return { projectName: p.name, clientShort: c?.short };
}

/** Dashboard page — only TODAY tasks, grouped by list (admin/work/projects).
 *  Mirrors the desktop's "Dashboard - Benno" intent: what am I doing today,
 *  across every category. */
function DashboardPage({ tasks, projects, clients, onToggleTask }: PageProps) {
  const active = tasks.filter((t) => !t.trashed && !t.completed && t.section === 'today' && t.type !== 'scheduled');
  const byList = useMemo(() => {
    const m = new Map<ListId, Task[]>();
    for (const l of LIST_ORDER) m.set(l, []);
    for (const t of active) (m.get(t.list) || []).push(t);
    for (const [, arr] of m) arr.sort((a, b) => a.order - b.order);
    return m;
  }, [active]);
  if (active.length === 0) {
    return <EmptyState label="Nothing on for today" />;
  }
  return (
    <>
      {LIST_ORDER.map((listId) => {
        const items = byList.get(listId) || [];
        if (items.length === 0) return null;
        return (
          <div key={listId}>
            <SectionHeader label={LIST_TITLES[listId]} count={items.length} />
            {items.map((t) => {
              const { projectName, clientShort } = projectLookup(projects, clients, t.projectId);
              return <TaskRow key={t.id} task={t} projectName={projectName} clientShort={clientShort} onToggle={() => onToggleTask(t.id)} />;
            })}
          </div>
        );
      })}
    </>
  );
}

/** List page — every non-completed task, grouped by list, then by section
 *  inside each list. The "fire-hose" view: scroll a single column and see
 *  what's queued everywhere. */
function ListPage({ tasks, projects, clients, onToggleTask }: PageProps) {
  const active = tasks.filter((t) => !t.trashed && !t.completed && t.type !== 'scheduled');
  if (active.length === 0) return <EmptyState label="Everything's clear" />;
  return (
    <>
      {LIST_ORDER.map((listId) => {
        const inList = active.filter((t) => t.list === listId);
        if (inList.length === 0) return null;
        return (
          <div key={listId}>
            <SectionHeader label={LIST_TITLES[listId]} count={inList.length} />
            {SECTION_ORDER.map((sec) => {
              const items = inList.filter((t) => t.section === sec).sort((a, b) => a.order - b.order);
              if (items.length === 0) return null;
              return (
                <div key={sec}>
                  <div className="px-4 py-1 text-[#656464] text-[11px] uppercase tracking-wider">{SECTION_LABEL[sec]}</div>
                  {items.map((t) => {
                    const { projectName, clientShort } = projectLookup(projects, clients, t.projectId);
                    return <TaskRow key={t.id} task={t} projectName={projectName} clientShort={clientShort} onToggle={() => onToggleTask(t.id)} />;
                  })}
                </div>
              );
            })}
          </div>
        );
      })}
    </>
  );
}

/** Project page — tasks bucketed by project, with collapsible sections.
 *  Tasks with no project ID land in an "Inbox" bucket at the bottom. */
function ProjectPage({ tasks, projects, clients, onToggleTask }: PageProps) {
  const active = tasks.filter((t) => !t.trashed && !t.completed && t.type !== 'scheduled');
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  // Group by projectId (or special "__noproject" bucket).
  const byProject = useMemo(() => {
    const m = new Map<string, Task[]>();
    for (const t of active) {
      const k = t.projectId || '__noproject';
      const arr = m.get(k) || [];
      arr.push(t);
      m.set(k, arr);
    }
    for (const [, arr] of m) arr.sort((a, b) => a.order - b.order);
    return m;
  }, [active]);
  if (active.length === 0) return <EmptyState label="No active tasks" />;
  const projectsWithTasks = projects.filter((p) => byProject.has(p.id));
  return (
    <>
      {projectsWithTasks.map((p) => {
        const items = byProject.get(p.id) || [];
        const isCollapsed = collapsed.has(p.id);
        const client = p.clientId ? clients.find((c) => c.id === p.clientId) : undefined;
        return (
          <div key={p.id}>
            <button
              type="button"
              onClick={() => setCollapsed((s) => { const n = new Set(s); if (n.has(p.id)) n.delete(p.id); else n.add(p.id); return n; })}
              className="sticky top-0 z-10 bg-[#282828] w-full px-4 py-2 flex flex-row items-center gap-2 border-b border-[#1f1f1f] active:bg-white/[0.04]"
            >
              {isCollapsed ? <ChevronRightIcon size={14} className="text-[#a8a8a8]" /> : <ChevronDown size={14} className="text-[#a8a8a8]" />}
              <span className="text-[#a8a8a8] text-[12px] flex-1 text-left truncate">
                {client?.short && <span className="text-[#656464]">{client.short} › </span>}
                {p.name}
              </span>
              <span className="text-[#656464] text-[12px]">{items.length}</span>
            </button>
            {!isCollapsed && items.map((t) => (
              <TaskRow key={t.id} task={t} onToggle={() => onToggleTask(t.id)} />
            ))}
          </div>
        );
      })}
      {(byProject.get('__noproject') || []).length > 0 && (
        <div>
          <SectionHeader label="No project" count={(byProject.get('__noproject') || []).length} />
          {(byProject.get('__noproject') || []).map((t) => (
            <TaskRow key={t.id} task={t} onToggle={() => onToggleTask(t.id)} />
          ))}
        </div>
      )}
    </>
  );
}

/** Calendar page — date-banded view. Bands:
 *    - Overdue   (deadline < today, not completed)
 *    - Today     (today's date OR section='today')
 *    - Tomorrow
 *    - This week (next 2-6 days)
 *    - Later     (anything dated > 7 days out)
 *    - No date   (everything else, but only if active)
 *  Tasks ride in the EARLIEST matching band, so a task with deadline today
 *  shows under Today regardless of its section. */
function CalendarPage({ tasks, projects, clients, onToggleTask }: PageProps) {
  const active = tasks.filter((t) => !t.trashed && !t.completed && t.type !== 'scheduled');
  if (active.length === 0) return <EmptyState label="Nothing scheduled" />;
  const today = todayIso();
  const tomorrow = isoOffset(1);
  const weekEnd = isoOffset(7);
  const bands: Array<{ key: string; label: string; items: Task[] }> = [
    { key: 'overdue', label: 'Overdue', items: [] },
    { key: 'today', label: 'Today', items: [] },
    { key: 'tomorrow', label: 'Tomorrow', items: [] },
    { key: 'thisweek', label: 'This week', items: [] },
    { key: 'later', label: 'Later', items: [] },
    { key: 'nodate', label: 'No date', items: [] },
  ];
  for (const t of active) {
    const dueIso = t.deadline || (t.section === 'today' ? today : t.section === 'tomorrow' ? tomorrow : undefined);
    if (!dueIso) {
      bands[5].items.push(t);
      continue;
    }
    if (dueIso < today) bands[0].items.push(t);
    else if (dueIso === today) bands[1].items.push(t);
    else if (dueIso === tomorrow) bands[2].items.push(t);
    else if (dueIso <= weekEnd) bands[3].items.push(t);
    else bands[4].items.push(t);
  }
  return (
    <>
      {bands.map((b) => {
        if (b.items.length === 0) return null;
        // Within "thisweek", sort by date so the days within the week
        // appear in order.
        b.items.sort((a, c) => (a.deadline || '').localeCompare(c.deadline || ''));
        return (
          <div key={b.key}>
            <SectionHeader label={b.label} count={b.items.length} />
            {b.items.map((t) => {
              const { projectName, clientShort } = projectLookup(projects, clients, t.projectId);
              // For thisweek + later bands, prepend the day label.
              const dateLabel = (b.key === 'thisweek' || b.key === 'later') && t.deadline ? formatDayLabel(t.deadline) : undefined;
              const breadcrumb = [dateLabel, clientShort, projectName].filter(Boolean).join(' › ');
              return (
                <TaskRow
                  key={t.id}
                  task={t}
                  projectName={breadcrumb ? undefined : projectName}
                  clientShort={breadcrumb ? breadcrumb : clientShort}
                  onToggle={() => onToggleTask(t.id)}
                />
              );
            })}
          </div>
        );
      })}
    </>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="flex-1 flex items-center justify-center text-[#656464] py-20">{label}</div>
  );
}

// ── Shell ─────────────────────────────────────────────────────────────────

const PAGE_TITLES = ['Dashboard', 'List', 'Project', 'Calendar'];

export default function MobileApp() {
  const tasks = (useStorage((root) => root.tasks) || []) as Task[];
  const projects = (useStorage((root) => root.projects) || []) as Project[];
  const clients = (useStorage((root) => root.clients) || []) as Client[];

  // Toggle a task's completed state. Mirrors the desktop toggle: also
  // stamps completedDay/completedAt so the end-of-day clear behavior
  // works consistently across both surfaces.
  const toggleTask = useMutation(({ storage }, id: string) => {
    const arr = (storage.get('tasks' as never) as Task[] | undefined) || [];
    const next = arr.map((t) => {
      if (t.id !== id) return t;
      const completed = !t.completed;
      return {
        ...t,
        completed,
        completedDay: completed ? todayIso() : undefined,
        completedAt: completed ? Date.now() : undefined,
      };
    });
    storage.set('tasks' as never, next as never);
  }, []);

  // Swipe shell — CSS scroll-snap container with four full-width pages.
  // Track the active page via scroll position so the bottom dot indicator
  // updates as the user drags between slides. Page is also clickable via
  // the bottom dot tray (tap to jump).
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const idx = Math.round(el.scrollLeft / el.clientWidth);
      if (idx !== pageIndex && idx >= 0 && idx < 4) setPageIndex(idx);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [pageIndex]);
  const goToPage = useCallback((i: number) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ left: i * el.clientWidth, behavior: 'smooth' });
  }, []);

  const pageProps: PageProps = { tasks, projects, clients, onToggleTask: toggleTask };

  return (
    // Full-viewport flex column. paddingTop/paddingBottom use env(safe-area-inset)
    // so the iPhone notch + home indicator don't crop our UI when running as
    // a standalone PWA.
    <div className="h-screen flex flex-col bg-[#282828]" style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}>
      {/* Header — current page title. Tap any dot to jump pages. */}
      <div className="shrink-0 flex flex-row items-center justify-center py-3 border-b border-[#1f1f1f] relative">
        <div className="text-white">{PAGE_TITLES[pageIndex]}</div>
      </div>
      {/* The swipe stack. Each child is a full-viewport-width snap-aligned
          page. Each page scrolls vertically on its own. Touch action set to
          pan-x so horizontal swipes don't accidentally trigger vertical
          rubber-banding on iOS. */}
      <div
        ref={scrollRef}
        className="flex-1 flex flex-row overflow-x-auto overflow-y-hidden snap-x snap-mandatory"
        style={{ scrollSnapType: 'x mandatory', WebkitOverflowScrolling: 'touch' }}
      >
        {[
          <DashboardPage key="d" {...pageProps} />,
          <ListPage key="l" {...pageProps} />,
          <ProjectPage key="p" {...pageProps} />,
          <CalendarPage key="c" {...pageProps} />,
        ].map((page, i) => (
          <div
            key={i}
            className="shrink-0 w-screen h-full overflow-y-auto snap-center"
            style={{ scrollSnapAlign: 'center' }}
          >
            {page}
            {/* Trailing slack so the last row isn't hard against the
                bottom inset — gives the page-dot tray breathing room. */}
            <div className="h-8" />
          </div>
        ))}
      </div>
      {/* Page-dot indicator + tap-to-jump nav. Active dot is brand purple,
          inactive dots fade to muted grey. */}
      <div className="shrink-0 flex flex-row items-center justify-center gap-2 py-3 border-t border-[#1f1f1f]">
        {PAGE_TITLES.map((label, i) => (
          <button
            key={label}
            type="button"
            onClick={() => goToPage(i)}
            aria-label={`Go to ${label}`}
            className="px-3 py-1"
          >
            <div className={`h-[6px] rounded-full transition-all ${pageIndex === i ? 'w-[24px] bg-[#7363FF]' : 'w-[6px] bg-[#3a3a3a]'}`} />
          </button>
        ))}
      </div>
    </div>
  );
}
