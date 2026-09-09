// DEV ONLY. `npm run dev` then http://localhost:5173/dev/harness.html (add ?phone=1 for the phone
// variant). Mounts the compose sheet and the capsule controls with fake data and NO room, NO auth
// — so the controls can be driven and screenshotted without signing in. Not part of the build
// (Vite only builds index.html).
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MotionGlobalConfig, frameData, animate, motionValue, frame, motion } from 'motion/react';
import '../src/index.css';

// ?fakeraf=1 (see harness.html): motion runs on a MANUAL clock — frameData.timestamp is the
// only time it sees — so window.__tick can advance it frame by frame, deterministically,
// even in a browser pane that is not painting.
if (/[?&]fakeraf=1/.test(location.search)) {
  MotionGlobalConfig.useManualTiming = true;
  frameData.timestamp = 0;
  (window as unknown as { __frameData: typeof frameData }).__frameData = frameData;
  (window as unknown as { __m: unknown }).__m = { animate, motionValue, frame };
}
// A bare motion element on a plain motion value, for telling a harness artifact from a bug.
const probeX = motionValue(0);
const probeLeft = motionValue(0);
(window as unknown as { __probe: unknown }).__probe = { probeX, probeLeft };
function Probe() {
  return <motion.div data-probe style={{ x: probeX, left: probeLeft, position: 'relative', width: 8, height: 8, background: '#7666fc' }} />;
}
import { ComposeSheet, SheetShell } from '../src/ComposeSheet';
import { Capsule, CapsuleTrack } from '../src/Capsules';
import type { Client, Project, Person } from '../src/data';
import { LISTS, addDaysToDate, dateToISO } from '../src/data';

const params = new URLSearchParams(location.search);
const surface: 'phone' | 'desktop' = params.get('phone') ? 'phone' : 'desktop';

const clients = [
  { id: 'c1', name: 'Rivington', short: 'RIV' },
  { id: 'c2', name: 'Hearst', short: 'HRST' },
] as unknown as Client[];
const projects = [
  { id: 'p1', name: 'Website', clientId: 'c1', list: 'work' },
  { id: 'p2', name: 'Brand film', clientId: 'c2', list: 'work' },
  { id: 'p3', name: 'Taxes', list: 'admin' },
] as unknown as Project[];
const people = [
  { id: 'u1', name: 'Benno', short: 'B' },
  { id: 'u2', name: 'Sam', short: 'S' },
] as unknown as Person[];

// ?shell=1 — the bare SheetShell with BOTH gestures wired and a plain (control-free) body, so
// the card sheet's pull-up/pull-down engine can be driven with synthetic touches and the
// result read out of the log. This is the same code path TaskSheet uses.
function ShellProbe() {
  const [log, setLog] = useState<string[]>([]);
  const say = (what: string) => setLog((l) => [...l, what]);
  return (
    <>
      <p data-testid="shell-log" style={{ color: '#a8a8a8' }}>{log.join(',') || 'none'}</p>
      <SheetShell onClose={() => say('close')} onSwipeDown={() => say('down')} onSwipeUp={() => say('up')} handle>
        <div data-testid="probe-body" style={{ height: 220, paddingTop: 16 }}>
          <p style={{ color: '#656464' }}>plain body — the gesture's</p>
          <div data-chip-track="" style={{ marginTop: 16, padding: 3, background: 'black', borderRadius: 21, display: 'inline-flex' }}>
            <button type="button" data-testid="probe-chip" style={{ height: 36, padding: '0 16px', borderRadius: 999, color: 'white', background: 'transparent' }}>chip</button>
          </div>
        </div>
      </SheetShell>
    </>
  );
}

function Harness() {
  const [open, setOpen] = useState(true);
  const [v, setV] = useState('today');
  const anchor = new Date(); anchor.setHours(0, 0, 0, 0);
  const isos = [...Array(9)].map((_, i) => dateToISO(addDaysToDate(anchor, i)));
  const feel = surface === 'desktop' ? 'spring' : 'quintic';
  return (
    <div style={{ minHeight: '100vh', background: 'var(--app-bg)', color: 'white', padding: 24 }}>
      <p style={{ color: '#656464' }}>harness · {surface}</p>
      <Probe />
      <div style={{ marginTop: 24 }} data-testid="track">
        <CapsuleTrack feel={feel} knob="var(--app-bg)" className="inline-flex flex-row flex-wrap items-center gap-[4px] rounded-[21px] bg-black p-[3px] max-w-full">
          {['today', 'tomorrow', 'next', 'hold'].map((k) => <Capsule key={k} active={v === k} onClick={() => setV(k)}>{k}</Capsule>)}
        </CapsuleTrack>
      </div>
      <button type="button" onClick={() => setOpen(true)} style={{ marginTop: 24, color: '#a8a8a8' }}>open sheet</button>
      {params.get('shell') && <ShellProbe />}
      {open && !params.get('shell') && (
        <ComposeSheet
          listSequence={LISTS}
          projects={projects}
          clients={clients}
          people={people}
          currentUserShort="B"
          defaultSection="today"
          isos={isos}
          anchor={anchor}
          editingTask={null}
          onCreate={(p, keep) => { console.log('create', p); if (!keep) setOpen(false); }}
          onUpdate={() => { /* harness */ }}
          onAddClient={(n) => { console.log('client', n); return 'c-new'; }}
          onAddProject={(p) => { console.log('project', p); return 'p-new'; }}
          onClose={() => setOpen(false)}
          maxWidth={surface === 'desktop' ? 520 : undefined}
          surface={surface}
        />
      )}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
