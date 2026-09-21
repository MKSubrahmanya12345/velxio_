import type { Conversation, MessageResult, HumanToolCall } from '../types';

export const conversation = (id: string, title = `Build ${id}`): Conversation => ({
  id, title, createdAt: '2026-09-21T10:00:00Z', updatedAt: '2026-09-21T10:00:00Z',
  messages: [{ id: `message-${id}`, role: 'assistant', at: '2026-09-21T10:00:00Z', content: `Plan for ${title}` }],
  projectState: null, pendingHumanTools: [], counters: { messages: 1, jevCalls: 0, humanCalls: 0, plans: 0 },
});
export const result = (c: Conversation): MessageResult => ({ conversation: c, response: c.messages[0], decisions: [] });
export const humanTool: HumanToolCall = {
  id: 'tool-1', name: 'human', status: 'requires_action', at: '2026-09-21T10:00:00Z',
  arguments: { task: 'Check the circuit', instructions: 'Inspect connections.', materials: [], tools: [], safety: [], definition_of_done: ['Connections match the diagram.'], track: 'physical', phase: 'Assembly', stepId: 'step-1' },
};
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
