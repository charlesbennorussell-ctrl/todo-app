export type Assignee = string;
export type SectionId = 'inbox' | 'today' | 'next';
export type ListId = 'dashboard' | 'work' | 'projects' | 'admin';
export type AppMode = 'dashboard' | 'projectView' | 'calendar' | 'settings';

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

export function formatDeadline(iso?: string): string {
  if (!iso) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  if (isNaN(date.getTime())) return iso;
  const day = date.toLocaleDateString('en-US', { weekday: 'short' });
  const mon = date.toLocaleDateString('en-US', { month: 'short' });
  return `${day}-${mon} ${String(d).padStart(2, '0')}`;
}

export function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
