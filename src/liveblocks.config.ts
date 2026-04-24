import type { Task, Project, Client, Person } from './data';

declare global {
  interface Liveblocks {
    Storage: {
      tasks: Task[];
      projects: Project[];
      clients: Client[];
      people: Person[];
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
