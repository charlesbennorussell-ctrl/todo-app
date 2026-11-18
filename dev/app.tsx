// DEV ONLY. The REAL app on fake, in-memory data — see dev/vite.mock.config.ts for how to serve
// it. Desktop by default; ?phone=1 mounts MobileApp instead. window.__lb.root() reads the store.
import { createRoot } from 'react-dom/client';
import App from '../src/App';
import MobileApp from '../src/MobileApp';
import '../src/index.css';
import { __seed, __root } from './lb-mock';
import { PERSONAL_CLIENT_ID, addDaysToDate, dateToISO } from '../src/data';
import type { Task, ListId, SectionId } from '../src/data';

const today = new Date(); today.setHours(0, 0, 0, 0);
const day = (n: number) => dateToISO(addDaysToDate(today, n));

let seq = 0;
const t = (title: string, list: ListId, section: SectionId, over: Partial<Task> = {}): Task => ({
  id: `t${++seq}`, title, type: 'todo', assignees: ['B'], completed: false,
  list, section, order: seq, createdAt: Date.now() - 86400000, ...over,
});

const tasks: Task[] = [
  // Today
  t('Send the Rivington site map', 'work', 'today', { projectId: 'p1' }),
  t('Review brand film cut', 'work', 'today', { projectId: 'p2' }),
  t('Call Hearst about the shoot', 'work', 'today', { clientId: 'c2' }),
  t('Overdue invoice follow-up', 'work', 'today', { deadline: day(-3) }),
  t('Rover lidar pass', 'projects', 'today', { projectId: 'p3' }),
  t('Model the landing gear', 'projects', 'today', { projectId: 'p3' }),
  t('Quarterly taxes', 'admin', 'today', { projectId: 'p4' }),
  t('Renew domain', 'admin', 'today'),
  t('Groceries', 'personal', 'today'),
  // Tomorrow
  t('Storyboard the second spot', 'work', 'tomorrow', { projectId: 'p2' }),
  t('Homepage copy pass', 'work', 'tomorrow', { projectId: 'p1' }),
  t('Hearst moodboard', 'work', 'tomorrow', { clientId: 'c2' }),
  t('Rover wheel test', 'projects', 'tomorrow', { projectId: 'p3' }),
  t('Expense report', 'admin', 'tomorrow'),
  t('Dentist', 'personal', 'tomorrow'),
  // Next
  t('Rivington launch email', 'work', 'next', { projectId: 'p1', deadline: day(3) }),
  t('Brand film color', 'work', 'next', { projectId: 'p2', deadline: day(5) }),
  t('Pitch deck outline', 'work', 'next'),
  t('Archive old renders', 'work', 'next'),
  t('Rover paint study', 'projects', 'next', { projectId: 'p3' }),
  t('Sculpture base', 'projects', 'next'),
  t('Lighting rig notes', 'projects', 'next'),
  t('Insurance renewal', 'admin', 'next'),
  t('Update contracts', 'admin', 'next'),
  t('Book flights', 'personal', 'next'),
  t('Fix the bike', 'personal', 'next'),
  // Hold
  t('Rebrand idea for Hearst', 'work', 'hold', { clientId: 'c2' }),
  t('Agency website v2', 'work', 'hold'),
  t('Rover documentary', 'projects', 'hold', { projectId: 'p3' }),
  t('Switch accountants', 'admin', 'hold'),
  // A milestone inside the Next window
  t('Rivington launch', 'work', 'next', { type: 'scheduled', projectId: 'p1', deadline: day(4) }),
];

__seed({
  tasks,
  projects: [
    { id: 'p1', name: 'Website', clientId: 'c1', list: 'work' },
    { id: 'p2', name: 'Brand film', clientId: 'c2', list: 'work' },
    { id: 'p3', name: 'Rover', clientId: 'c3', list: 'projects' },
    { id: 'p4', name: 'Taxes', list: 'admin' },
  ],
  clients: [
    { id: PERSONAL_CLIENT_ID, name: 'Personal', short: '' },
    { id: 'c1', name: 'Rivington', short: 'RIV' },
    { id: 'c2', name: 'Hearst', short: 'HRST' },
    { id: 'c3', name: 'JPL', short: 'JPL' },
  ],
  people: [
    { id: 'pr1', name: 'Benno', short: 'B' },
    { id: 'pr2', name: 'Sam', short: 'S' },
  ],
  focusBriefs: {}, focusSubtasks: {}, focusImages: {}, focusReferences: {}, focusImageFolders: {},
});
(window as unknown as { __lb: unknown }).__lb = { root: __root, seed: __seed };

const phone = new URLSearchParams(location.search).has('phone');
createRoot(document.getElementById('root')!).render(phone ? <MobileApp /> : <App />);
