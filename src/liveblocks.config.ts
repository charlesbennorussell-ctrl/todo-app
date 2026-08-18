import type { Task, Project, Client, Person } from './data';

// Focus-mode persistence shapes. Keyed by either project id or task id depending on
// context — see App.tsx for the resolution logic.
// FocusImage stores only metadata + a hosted URL. The binary lives in Supabase Storage
// (see src/supabase.ts). `dataUrl` retained for backward compat with rooms that pre-date
// the Supabase migration — when present, the renderer falls back to it; new uploads only
// populate `url`.
export interface FocusImage { id: string; url?: string; dataUrl?: string; filename: string; width: number; height: number; favorited?: boolean }
export interface FocusSubtask { id: string; title: string; completed: boolean }
export interface FocusReference { label: string; url: string }

declare global {
  interface Liveblocks {
    Storage: {
      tasks: Task[];
      projects: Project[];
      clients: Client[];
      people: Person[];
      // Focus mode (project dashboard) data. Each map is keyed by project id OR task id.
      // Stored as plain Records so we can clone-and-set without LiveObject ceremony.
      focusBriefs: Record<string, string>;
      focusSubtasks: Record<string, FocusSubtask[]>;
      // Image METADATA only (id, filename, dimensions, favorited). Binary dataUrl lives
      // in browser localStorage to keep this Record under the per-key size ceiling.
      focusImages: Record<string, FocusImage[]>;
      focusReferences: Record<string, FocusReference[]>;
      // Theme colours (Settings → Colors). Stored in the ROOM, not localStorage, so the
      // desktop app, the PIP window and the phone all paint with the same background and
      // accent — localStorage is per-device and made the surfaces drift apart.
      // Optional: rooms created before this key existed simply have no `theme`, and the app
      // falls back to the localStorage cache and then to the index.css defaults.
      theme?: { bg?: string; accent?: string };
      // Auto-capitalisation mode (Settings → Text). In the ROOM for the same reason as `theme`:
      // localStorage is per-device, and the phone has no Settings UI at all — left in
      // localStorage the desktop toggle can never reach it and phone-typed titles sync back raw.
      // Absent on rooms predating this key → the surfaces fall back to their local value.
      caseMode?: 'off' | 'title';
      // Sub-grouping switches (Settings → Sub-grouping), one per scope. Same story again:
      // each surface kept its own localStorage copy, so a column could be grouped on the
      // desktop and flat on the phone. Every key is INDEPENDENTLY optional, and the readers
      // fall back per key with `??` rather than `||` — `false` is a real answer here, so a
      // room that has only ever written `next` must not drag the other two back to default.
      subGroup?: { today?: boolean; tomorrow?: boolean; next?: boolean };
    };
    Presence: {
      cursor: { x: number; y: number } | null;
    };
    UserMeta: {
      info: {
        name: string;
        color: string;
      };
    };
  }
}

export {};
