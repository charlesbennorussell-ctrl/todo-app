export type Assignee = string;
export type SectionId = 'inbox' | 'today' | 'tomorrow' | 'next';
export type ListId = 'dashboard' | 'work' | 'projects' | 'admin';
export type AppMode = 'dashboard' | 'projectView' | 'calendar' | 'focus' | 'settings';

export interface Task {
  id: string;
  title: string;
  type: 'scheduled' | 'todo';
  assignees: Assignee[];
  startDate?: string;
  deadline?: string;
  completed: boolean;
  list: ListId;
  section: SectionId;
  order: number;
  projectId?: string;
  // Optional explicit client link. Normally client is derived from projectId → project.clientId,
  // but a task can be linked directly to a client when it has no project (e.g. a milestone tied
  // to a client without a concrete project).
  clientId?: string;
  // Day (todayISO format) the task was last marked completed. Drives the "completed tasks clear
  // from list/project view at end of day" behavior — the list/project filters hide tasks whose
  // completedDay is < today's day boundary. Calendar view ignores this and shows all completions.
  // Cleared (set to undefined) when the user un-checks the task.
  completedDay?: string;
  // Epoch ms when the task was last marked completed. Used by the bucket sort to delay sinking
  // a freshly-checked task for ~15s — this gives the user a window to undo a misclick before the
  // row visibly drifts to the bottom of the section.
  completedAt?: number;
  // Day (todayISO format) the task was last revived from completion or trash. Within 10 minutes
  // of a revive, the task always shows in the list/project view even if it would otherwise be
  // filtered out (gives the user a window to undo a misclick).
  revivedAt?: number; // epoch ms
  // Soft-delete flag. trashTaskAction sets this true; the task is hidden from all main views but
  // still listed in Settings → Trash so the user can revive it.
  trashed?: boolean;
  trashedAt?: number; // epoch ms (used to sort the Trash column newest-first)
}

export interface Project { id: string; name: string; clientId?: string; list?: ListId; }
export interface Client { id: string; name: string; short: string; }
export interface Person { id: string; name: string; short: string; }

export const LIST_TITLES: Record<ListId, string> = { dashboard: 'Dashboard', work: 'Work', projects: 'Projects', admin: 'Admin' };
export const LISTS: ListId[] = ['dashboard', 'work', 'projects', 'admin'];

// Id of the special "Personal" client. Tasks under this client are scoped to their assignees
// only — they never show on anyone else's dashboard, list, or project view.
export const PERSONAL_CLIENT_ID = 'personal';

export const initialClients: Client[] = [
  { id: PERSONAL_CLIENT_ID, name: 'Personal', short: '' },
  { id: 'c1', name: 'Fear of God', short: 'FOG' },
  { id: 'c2', name: 'Rivington', short: 'Riv' },
  { id: 'c3', name: 'Fresh Start Pack', short: 'FSP' },
  { id: 'c4', name: 'Boulet Brothers', short: 'Boulet' },
  { id: 'c5', name: 'Expo', short: 'Expo' },
];

export const initialProjects: Project[] = [
  { id: 'p1', name: 'Essentialist', clientId: 'c1' },
  { id: 'p2', name: 'Web-Present', clientId: 'c2' },
  { id: 'p3', name: 'Fede Logo', clientId: 'c3' },
  { id: 'p4', name: 'Motion Tests', clientId: 'c4' },
  { id: 'p5', name: '3 Insta Posts', clientId: 'c5' },
  { id: 'p6', name: 'Portfolio', clientId: undefined },
  { id: 'p7', name: 'Mindmap', clientId: undefined },
  { id: 'p8', name: 'Dome-0', clientId: undefined },
  { id: 'p9', name: 'Vectron', clientId: undefined },
];

export const initialPeople: Person[] = [
  { id: 'pr1', name: 'Pawel', short: 'P' },
  { id: 'pr2', name: 'Benno', short: 'B' },
  { id: 'pr3', name: 'Delaney', short: 'D' },
];

export const initialTasks: Task[] = [
  { id: 'w-i1', title: 'Web-Present Draft', type: 'scheduled', assignees: ['P', 'B'], deadline: '2026-04-24', completed: false, list: 'work', section: 'inbox', order: 0, projectId: 'p2' },
  { id: 'w-i2', title: 'Essentialist-Launch', type: 'scheduled', assignees: ['P', 'B'], deadline: '2026-04-27', completed: false, list: 'work', section: 'inbox', order: 1, projectId: 'p1' },
  { id: 'w-i3', title: 'Protest DTLA', type: 'todo', assignees: [], completed: false, list: 'work', section: 'inbox', order: 2 },
  { id: 'w-t0', title: 'Send AI Comps to Jerry', type: 'todo', assignees: ['P'], completed: false, list: 'work', section: 'today', order: 0, projectId: 'p1' },
  { id: 'w-t1', title: 'Motion Tests', type: 'todo', assignees: ['P'], completed: false, list: 'work', section: 'today', order: 1, projectId: 'p4' },
  { id: 'w-t2', title: 'Web-Start Figma (Framer?)', type: 'todo', assignees: ['P'], completed: false, list: 'work', section: 'today', order: 2, projectId: 'p2' },
  { id: 'w-t3', title: 'Essentialist-Strategy', type: 'todo', assignees: ['P', 'B'], deadline: '2026-04-28', completed: false, list: 'work', section: 'today', order: 3, projectId: 'p1' },
  { id: 'w-t4', title: 'Web-Research', type: 'todo', assignees: ['P'], completed: false, list: 'work', section: 'today', order: 4, projectId: 'p2' },
  { id: 'w-t5', title: '3 Insta Posts', type: 'todo', assignees: ['D'], deadline: '2026-04-27', completed: false, list: 'work', section: 'today', order: 5, projectId: 'p5' },
  { id: 'w-n0', title: '12:00 Working Session with Rivington', type: 'scheduled', assignees: ['P', 'B'], deadline: '2026-04-26', completed: false, list: 'work', section: 'next', order: 0, projectId: 'p2' },
  { id: 'w-n1', title: 'Talk to Rivington About Retainer', type: 'todo', assignees: ['P'], completed: false, list: 'work', section: 'next', order: 1, projectId: 'p2' },
  { id: 'w-n2', title: 'Essentialist-Deal', type: 'todo', assignees: ['P', 'B'], deadline: '2026-04-29', completed: false, list: 'work', section: 'next', order: 2, projectId: 'p1' },
  { id: 'w-n3', title: 'Essentialist-Design', type: 'todo', assignees: ['P', 'B'], deadline: '2026-05-01', completed: false, list: 'work', section: 'next', order: 3, projectId: 'p1' },
  { id: 'w-n4', title: 'Web-Talk To Onda', type: 'todo', assignees: [], completed: false, list: 'work', section: 'next', order: 4, projectId: 'p2' },

  { id: 'pr-t1', title: 'First Draft Figma', type: 'todo', assignees: ['P'], completed: true, list: 'projects', section: 'today', order: 0, projectId: 'p7' },
  { id: 'pr-t2', title: 'UI Research', type: 'todo', assignees: ['P'], completed: false, list: 'projects', section: 'today', order: 1, projectId: 'p7' },
  { id: 'pr-t3', title: 'Remix w Design Research', type: 'todo', assignees: ['P'], completed: false, list: 'projects', section: 'today', order: 2, projectId: 'p7' },
  { id: 'pr-t4', title: 'Flesh Out Portfolio', type: 'todo', assignees: ['P'], completed: false, list: 'projects', section: 'today', order: 3, projectId: 'p6' },
  { id: 'pr-t5', title: 'Finalize Design', type: 'todo', assignees: [], completed: false, list: 'projects', section: 'today', order: 4, projectId: 'p7' },
  { id: 'pr-n1', title: 'Build The Actual App', type: 'todo', assignees: [], completed: false, list: 'projects', section: 'next', order: 0, projectId: 'p7' },
  { id: 'pr-n2', title: 'Develop Branding', type: 'todo', assignees: [], completed: false, list: 'projects', section: 'next', order: 1, projectId: 'p7' },
  { id: 'pr-n3', title: 'Get Basic Functions Working', type: 'todo', assignees: [], completed: false, list: 'projects', section: 'next', order: 2, projectId: 'p7' },
  { id: 'pr-n4', title: 'Merge UI + Map', type: 'todo', assignees: [], completed: false, list: 'projects', section: 'next', order: 3, projectId: 'p7' },
  { id: 'pr-n5', title: 'Add In LLM Integration', type: 'todo', assignees: [], completed: false, list: 'projects', section: 'next', order: 4, projectId: 'p7' },
  { id: 'pr-n6', title: 'Re-Render Dome-0 (Wheel Texturing)', type: 'todo', assignees: [], completed: false, list: 'projects', section: 'next', order: 5, projectId: 'p8' },
  { id: 'pr-n7', title: 'Resolve Claude Blockage', type: 'todo', assignees: [], completed: false, list: 'projects', section: 'next', order: 6, projectId: 'p9' },
  { id: 'pr-n8', title: 'Design UI', type: 'todo', assignees: [], completed: false, list: 'projects', section: 'next', order: 7, projectId: 'p9' },

  { id: 'a-i1', title: 'Fede Logo', type: 'todo', assignees: ['P'], completed: false, list: 'admin', section: 'inbox', order: 0, projectId: 'p3' },
  { id: 'a-t1', title: 'File Quarterly Taxes', type: 'todo', assignees: ['P'], completed: false, list: 'admin', section: 'today', order: 0 },
  { id: 'a-t2', title: 'Renew Business License', type: 'scheduled', assignees: ['P'], deadline: '2026-05-04', completed: false, list: 'admin', section: 'today', order: 1 },
  { id: 'a-n1', title: 'Update Contractor Agreement', type: 'todo', assignees: [], completed: false, list: 'admin', section: 'next', order: 0 },
  { id: 'a-n2', title: 'Archive 2025 Invoices', type: 'todo', assignees: [], completed: false, list: 'admin', section: 'next', order: 1 },
];

// Helper: shift an ISO date by N days (negative = earlier).
function shiftIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// Day offset between two ISO dates (today → iso). Negative = past, 0 = today, positive = future.
function dayOffset(isoFrom: string, isoTo: string): number {
  const [y1, m1, d1] = isoFrom.split('-').map(Number);
  const [y2, m2, d2] = isoTo.split('-').map(Number);
  const t1 = new Date(y1, m1 - 1, d1).getTime();
  const t2 = new Date(y2, m2 - 1, d2).getTime();
  return Math.round((t2 - t1) / 86400000);
}

// Map an offset (in days) to a human-friendly label, or null if no rename applies.
//   0          → Today
//   +1 / -1    → Tomorrow / Yesterday
//   +2..+13    → "N Days" (linear day count up to 13)
//   +14..+49   → "N Weeks" (rounded to the nearest whole week, max "7 Weeks")
//   +50..+364  → "N Months" (rounded to nearest 30 days)
//   +365+      → "N Years"  (rounded to nearest 365 days)
//   past beyond -1 → calendar date.
function relativeLabel(offset: number): string | null {
  if (offset === 0) return 'Today';
  if (offset === 1) return 'Tomorrow';
  if (offset === -1) return 'Yesterday';
  if (offset < -1) return null;
  if (offset >= 2 && offset <= 13) return `${offset} Days`;
  if (offset >= 14 && offset <= 49) {
    const weeks = Math.round(offset / 7);
    return weeks === 1 ? '1 Week' : `${weeks} Weeks`;
  }
  if (offset >= 50 && offset <= 364) {
    const months = Math.round(offset / 30);
    return months === 1 ? '1 Month' : `${months} Months`;
  }
  if (offset >= 365) {
    const years = Math.round(offset / 365);
    return years === 1 ? '1 Year' : `${years} Years`;
  }
  return null;
}

export function formatDeadline(iso?: string): string {
  if (!iso) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const rel = relativeLabel(dayOffset(todayISO(), iso));
  if (rel) return rel;
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  if (isNaN(date.getTime())) return iso;
  const day = date.toLocaleDateString('en-US', { weekday: 'short' });
  const mon = date.toLocaleDateString('en-US', { month: 'short' });
  return `${day}-${mon} ${String(d).padStart(2, '0')}`;
}

// Compact MM-DD form used when columns are squeezed (responsive truncation cascade).
// Relative labels (Today / Tomorrow / N Days / weeks) still substitute — they're more useful
// than the literal date even at narrow widths.
export function formatDeadlineShort(iso?: string): string {
  if (!iso) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const rel = relativeLabel(dayOffset(todayISO(), iso));
  if (rel) return rel;
  const [, m, d] = iso.split('-');
  return `${m}-${d}`;
}

// True when the deadline ISO is strictly before today (used to color late dates).
export function isLateDeadline(iso?: string): boolean {
  if (!iso) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  return iso < todayISO();
}

// "Today" rolls over at 4 AM, not midnight. Anything done between 12:00 AM and 3:59 AM is
// still considered the previous day's work. Shifting `new Date()` back 4 hours before
// extracting the calendar date achieves this for every consumer (formatDeadline, isLateDeadline,
// midnight-refill comparisons, etc.).
export function todayISO(): string {
  const d = new Date();
  d.setHours(d.getHours() - 4);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
