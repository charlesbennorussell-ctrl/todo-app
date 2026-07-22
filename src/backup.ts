// Local backup of Liveblocks Storage. TWO snapshots, NOT a Time Machine:
//
//   • LIVE     — refreshed on every auto-tick (~5 min). Mirror of "now."
//                Use this when you just messed something up minutes ago.
//   • DAILY    — refreshed only once per 24 hours. Holds a snapshot that's
//                between 0 and 24 hours old. Use this when you need to roll
//                back further than the live mirror covers (catastrophic
//                deletion you didn't notice immediately).
//
// Both slots are key-named in IndexedDB and OVERWRITTEN in place — there is
// no accumulating history. Manual download still produces a JSON file the
// user can stash externally if they want a permanent off-machine copy.
//
// What's covered: all Liveblocks Storage records (tasks/projects/clients/
// people + all focus* records). Supabase image BLOBS are not in the JSON;
// only their URLs. Full disaster recovery = keep this JSON safe + don't wipe
// the Supabase bucket.

import type { Task, Project, Client, Person } from './data';
import type { FocusImage, FocusSubtask, FocusReference } from './liveblocks.config';

// Bumped only when the snapshot SHAPE changes. Restore refuses mismatched majors.
export const BACKUP_SCHEMA_VERSION = 1;

// Identifier embedded in every snapshot so a stray JSON from another app fails
// fast on import. Restore checks this exact value and rejects anything else.
export const APP_ID = 'ctrl-project';

export type SnapshotSlot = 'live' | 'daily';

export interface BackupSnapshot {
  schemaVersion: number;
  takenAt: string;          // ISO 8601 timestamp
  takenAtMs: number;        // epoch ms
  app: typeof APP_ID;
  slot?: SnapshotSlot;      // which named slot this snapshot occupies (omitted on user-downloaded JSON)
  data: BackupSlice;
}

export interface BackupSlice {
  tasks: Task[];
  projects: Project[];
  clients: Client[];
  people: Person[];
  focusBriefs: Record<string, string>;
  focusSubtasks: Record<string, FocusSubtask[]>;
  focusImages: Record<string, FocusImage[]>;
  focusReferences: Record<string, FocusReference[]>;
}

export const DAILY_REFRESH_MS = 24 * 60 * 60 * 1000;

export function buildSnapshot(slice: BackupSlice, slot?: SnapshotSlot): BackupSnapshot {
  const now = Date.now();
  return {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    takenAt: new Date(now).toISOString(),
    takenAtMs: now,
    app: APP_ID,
    slot,
    data: {
      tasks: slice.tasks ?? [],
      projects: slice.projects ?? [],
      clients: slice.clients ?? [],
      people: slice.people ?? [],
      focusBriefs: slice.focusBriefs ?? {},
      focusSubtasks: slice.focusSubtasks ?? {},
      focusImages: slice.focusImages ?? {},
      focusReferences: slice.focusReferences ?? {},
    },
  };
}

// --- IndexedDB: two named slots ---------------------------------------------

const DB_NAME = 'ctrl-project-backups';
const STORE = 'snapshots';
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;
function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // Two named slots stored by string key ('live' / 'daily'). No keyPath —
      // we pass the slot name explicitly on put().
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export async function getSlot(slot: SnapshotSlot): Promise<BackupSnapshot | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(slot);
    req.onsuccess = () => resolve((req.result as BackupSnapshot | undefined) ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function putSlot(slot: SnapshotSlot, snapshot: BackupSnapshot): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({ ...snapshot, slot }, slot);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// --- Download / Upload helpers ----------------------------------------------

export function downloadSnapshot(snapshot: BackupSnapshot): void {
  const json = JSON.stringify(snapshot, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const d = new Date(snapshot.takenAtMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  a.href = url;
  a.download = `ctrl-project-backup-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Validates + parses an uploaded JSON file.
export async function readSnapshotFile(file: File): Promise<BackupSnapshot> {
  if (!file) throw new Error('No file selected.');
  const text = await file.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('File is not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('Snapshot must be a JSON object.');
  const snap = parsed as Partial<BackupSnapshot>;
  if (snap.app !== APP_ID) {
    throw new Error('This file is not a Ctrl-Project backup.');
  }
  if (typeof snap.schemaVersion !== 'number') throw new Error('Missing schemaVersion.');
  if (Math.floor(snap.schemaVersion) !== BACKUP_SCHEMA_VERSION) {
    throw new Error(`Schema version mismatch (file: v${snap.schemaVersion}, app: v${BACKUP_SCHEMA_VERSION}).`);
  }
  if (!snap.data || typeof snap.data !== 'object') throw new Error('Missing data section.');
  const d = snap.data as Partial<BackupSlice>;
  return {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    takenAt: snap.takenAt ?? new Date().toISOString(),
    takenAtMs: snap.takenAtMs ?? Date.now(),
    app: APP_ID,
    data: {
      tasks: Array.isArray(d.tasks) ? d.tasks : [],
      projects: Array.isArray(d.projects) ? d.projects : [],
      clients: Array.isArray(d.clients) ? d.clients : [],
      people: Array.isArray(d.people) ? d.people : [],
      focusBriefs: (d.focusBriefs && typeof d.focusBriefs === 'object') ? d.focusBriefs : {},
      focusSubtasks: (d.focusSubtasks && typeof d.focusSubtasks === 'object') ? d.focusSubtasks : {},
      focusImages: (d.focusImages && typeof d.focusImages === 'object') ? d.focusImages : {},
      focusReferences: (d.focusReferences && typeof d.focusReferences === 'object') ? d.focusReferences : {},
    },
  };
}
