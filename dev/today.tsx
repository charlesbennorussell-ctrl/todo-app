// DEV ONLY. http://localhost:5173/dev/today.html — exercises the real exported Today-sequencing
// helpers (src/App.tsx) against a task set shaped like the live Work band: a wall of months-old
// overdue tasks plus the undated section-'today' work underneath. Not part of the build.
import { todayBandOf, applyTodayOrder, computeCalendarDistribution } from '../src/App';
import type { Task, ListId } from '../src/data';

const TODAY = '2026-10-14';
const anchor = new Date(2026, 9, 14); anchor.setHours(0, 0, 0, 0);

const t = (id: string, over: Partial<Task> = {}): Task => ({
  id, title: id, type: 'todo', assignees: [], completed: false,
  list: 'work' as ListId, section: 'today', order: 0, ...over,
});

// Mirrors the live data: overdue dated tasks (which the column force-sorts to the top in date
// order) and undated section-'today' work below them.
const base: Task[] = [
  t('pr-launch', { deadline: '2026-04-27', order: 3 }),
  t('meet-site', { deadline: '2026-04-29', order: 1 }),
  t('lidar', { deadline: '2026-05-08', order: 2 }),
  t('zakynthos', { deadline: '2026-09-30', order: 0 }),
  t('sun-models', { order: 0 }),
  t('klaviyo', { order: 1 }),
  t('saban', { order: 2 }),
  // Not on Today: future deadline, and a task parked in another day/section.
  t('sculpture', { deadline: '2026-10-30', order: 9 }),
  t('tomorrow-job', { section: 'tomorrow', order: 0 }),
  // Overdue but sitting in Next — the column absorbs it, `order` can never compare it
  // against the section-'today' tasks beside it.
  t('jpl', { section: 'next', deadline: '2026-08-18', order: 4 }),
];

const ids = (list: Task[]) => list.map((x) => x.id).join(' → ');
const lines: string[] = [];
let failures = 0;
const check = (name: string, got: string, want: string) => {
  const ok = got === want;
  if (!ok) failures++;
  lines.push(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  lines.push(`        got  ${got}`);
  if (!ok) lines.push(`        want ${want}`);
};

// 1. An untouched band keeps the automatic order: overdue oldest-first, then undated.
const auto = todayBandOf(base, 'work', TODAY);
check('untouched band = automatic order (overdue by date, then undated)',
  ids(auto),
  // Date order, so jpl (due 08-18) sits between lidar (05-08) and zakynthos (09-30) — note it
  // lives in section 'next', which is exactly why `order` could never sequence this band.
  'pr-launch → meet-site → lidar → jpl → zakynthos → sun-models → klaviyo → saban');

// 2. Membership: future-dated and other-day tasks stay out.
check('future-dated and other-day tasks are not on Today',
  [base.find((x) => x.id === 'sculpture'), base.find((x) => x.id === 'tomorrow-job')]
    .map((x) => (auto.some((y) => y.id === x!.id) ? 'IN' : 'out')).join(' '),
  'out out');

// 3. The move the old engine could not express: lift an undated task above every overdue one.
const wanted = ['saban', 'jpl', 'sun-models', 'pr-launch', 'klaviyo', 'meet-site', 'lidar', 'zakynthos'];
const ranked = applyTodayOrder(base, wanted.map((id) => base.find((x) => x.id === id)!));
check('after a drag, the band reads exactly as arranged',
  ids(todayBandOf(ranked, 'work', TODAY)), wanted.join(' → '));

// 4. Every view agrees: the distribution's Today cell is the same sequence.
const cells = computeCalendarDistribution(ranked, anchor, 9, ['work'], [], [], false, 60, 30);
check('the distribution (Focus / Calendar / phone) renders that same sequence',
  ids(cells[`${TODAY}:work`] || []), wanted.join(' → '));

// 5. Sort-by-Client/Project must not override a hand-placed sequence.
const cp = computeCalendarDistribution(ranked, anchor, 9, ['work'], [], [], true, 60, 30);
check('Sort-by-Client/Project leaves a hand-placed sequence alone',
  ids(cp[`${TODAY}:work`] || []), wanted.join(' → '));

// 6. A task that arrives after the sequence was set lands at the bottom, not in the middle.
const withNew = [...ranked, t('brand-new', { order: 99 })];
check('a newly added task lands at the bottom of the arranged band',
  ids(todayBandOf(withNew, 'work', TODAY)), [...wanted, 'brand-new'].join(' → '));

// 7. Leaving Today clears the rank, so returning does not drag an old position back in.
const left = ranked.map((x) => (x.id === 'saban' ? { ...x, section: 'next' as const, todayRank: undefined } : x));
const back = left.map((x) => (x.id === 'saban' ? { ...x, section: 'today' as const } : x));
check('a task sent away and brought back returns unranked, at the bottom',
  ids(todayBandOf(back, 'work', TODAY)),
  [...wanted.filter((id) => id !== 'saban'), 'saban'].join(' → '));

// 8. The drop maths the handlers use: dropping ON a card puts you above it.
const band8 = todayBandOf(ranked, 'work', TODAY);
const src = band8.find((x) => x.id === 'zakynthos')!;
const without = ranked.filter((x) => x.id !== src.id);
const b8 = todayBandOf(without, 'work', TODAY);
const at = b8.findIndex((x) => x.id === 'sun-models');
const after = applyTodayOrder([...without, src], [...b8.slice(0, at), src, ...b8.slice(at)]);
check('dropping a card onto another puts it directly above that card',
  ids(todayBandOf(after, 'work', TODAY)),
  'saban → jpl → zakynthos → sun-models → pr-launch → klaviyo → meet-site → lidar');

// 9. Bands are independent — ranking Work must not touch Personal.
const mixed = [...base, t('p1', { list: 'personal', order: 0 }), t('p2', { list: 'personal', order: 1 })];
const rankedWork = applyTodayOrder(mixed, [mixed.find((x) => x.id === 'saban')!, mixed.find((x) => x.id === 'sun-models')!]);
check('ranking one category leaves the others untouched',
  ids(todayBandOf(rankedWork, 'personal', TODAY)), 'p1 → p2');

lines.push('', failures === 0 ? `ALL ${9} CHECKS PASSED` : `${failures} FAILURE(S)`);
document.getElementById('out')!.textContent = lines.join('\n');
(window as unknown as { __results: string }).__results = lines.join('\n');
(window as unknown as { __failures: number }).__failures = failures;
