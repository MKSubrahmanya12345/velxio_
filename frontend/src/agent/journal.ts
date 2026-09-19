import { create } from 'zustand';
import { generateUUID } from '../utils/uuid';
import type { Snapshot } from './workspace';
import type { ChatMessage } from './protocol';

export interface Revision {
  id: string;
  scope: string;
  label: string;
  time: string;
  before: Snapshot;
  after: Snapshot;
  changes: string[];
}
interface Journal {
  messages: (ChatMessage & { id: string; scope: string; error?: boolean })[];
  revisions: Revision[];
  addMessage: (message: ChatMessage & { scope: string; error?: boolean }) => void;
  addRevision: (revision: Omit<Revision, 'id' | 'time'>) => void;
  clearMessages: (scope: string) => void;
}
const KEY = 'velxio-agent-journal-v1';
function restore(): Pick<Journal, 'messages' | 'revisions'> {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw && raw.length < 2500000) {
      const data = JSON.parse(raw);
      // Stored locally by this module, never auto-applied to the workspace.
      if (Array.isArray(data.messages) && Array.isArray(data.revisions)) return data;
    }
  } catch {
    /* Private browsing / exhausted storage: keep an in-memory journal. */
  }
  return { messages: [], revisions: [] };
}
export const useAgentJournal = create<Journal>((set) => ({
  ...restore(),
  addMessage: (message) =>
    set((s) => ({ messages: [...s.messages, { ...message, id: generateUUID() }].slice(-60) })),
  addRevision: (revision) =>
    set((s) => ({
      revisions: [
        ...s.revisions,
        { ...revision, id: generateUUID(), time: new Date().toISOString() },
      ].slice(-10),
    })),
  clearMessages: (scope) => set((s) => ({ messages: s.messages.filter((m) => m.scope !== scope) })),
}));
useAgentJournal.subscribe(({ messages, revisions }) => {
  try {
    const data = JSON.stringify({ messages, revisions });
    if (data.length < 2500000) sessionStorage.setItem(KEY, data);
    else sessionStorage.removeItem(KEY);
  } catch {
    /* Never break project editing because storage is unavailable. */
  }
});
