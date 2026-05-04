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
