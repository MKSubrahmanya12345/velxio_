// Forge — API layer (chat-first)

import type {
  Conversation, Health, MessageResult, CreateResult, Project, ProjectState, MemoryEvent,
  ProvidersState, ProviderKey, ProviderKeyInput, ProviderTestResult, FailoverSettings,
  GlobalRule, GlobalRuleKind, GlobalRulesState,
} from './types';

const BASE = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_API_URL ?? '/api';

async function http<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json() as { error?: string }).error || ''; } catch {}
    throw new Error(`API ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return res.json() as Promise<T>;
}

function normalizeConversation(payload: unknown): Conversation {
  if (!payload || typeof payload !== 'object') throw new Error('invalid conversation');
  const v = payload as any;
  // If payload is legacy project
  if (v.state && !v.messages) {
    return {
      id: String(v.id),
      createdAt: String(v.createdAt),
      updatedAt: String(v.updatedAt),
      title: String(v.state.goal || 'Imported project'),
      messages: [],
      projectState: v.state,
      pendingHumanTools: [],
      counters: { messages: 0, jevCalls: 0, humanCalls: 0, plans: 1 },
    };
  }
  if (Array.isArray(v.messages)) {
    return {
      id: String(v.id),
      createdAt: String(v.createdAt),
      updatedAt: String(v.updatedAt || v.createdAt),
      title: String(v.title || 'New build chat'),
      messages: Array.isArray(v.messages) ? v.messages : [],
      projectState: v.projectState || v.state || null,
      memory: v.memory || { version: 1, revision: 0, notes: [], events: [] },
      pendingHumanTools: Array.isArray(v.pendingHumanTools) ? v.pendingHumanTools : [],
      counters: v.counters || { messages: 0, jevCalls: 0, humanCalls: 0, plans: 0 },
    };
  }
  throw new Error('API returned invalid conversation');
}

export async function streamTurn<T>(path: string, body: unknown, onProgress: (event: MemoryEvent) => void): Promise<T> {
  const response = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' }, body: JSON.stringify(body) });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail.error || `API ${response.status}`);
  }
  if (!response.headers.get('content-type')?.includes('application/x-ndjson')) return response.json() as Promise<T>;
  if (!response.body) throw new Error('No response stream. Reopen this project to check whether the turn was saved.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: T | undefined;
  const consume = (line: string) => {
    if (!line.trim()) return;
    const data = JSON.parse(line);
    if (data.type === 'progress') onProgress(data.event);
    if (data.type === 'result') result = data.result;
    if (data.type === 'error') throw new Error(data.error);
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        consume(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
      }
      if (done) { consume(buffer); break; }
    }
  } finally { reader.releaseLock(); }
  if (!result) throw new Error('Connection ended before confirmation. Reopen the project to check whether the turn was saved.');
  return result;
}

export const api = {
  health: () => http<Health>('/health'),
  list: async () => (await http<unknown[]>('/chat')).map(normalizeConversation),
  get: async (id: string) => normalizeConversation(await http<unknown>(`/chat/${id}`)),
  create: async (goal: string, constraints?: Partial<ProjectState['constraints']>, onProgress?: (event: MemoryEvent) => void, provider?: string) => {
    const body = { goal, constraints, provider };
    const result = onProgress ? await streamTurn<CreateResult>('/chat', body, onProgress) : await http<CreateResult>('/chat', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return { ...result, conversation: normalizeConversation(result.conversation) };
  },
  message: async (id: string, body: { text?: string; chip?: string; provider?: string }, onProgress?: (event: MemoryEvent) => void) => {
    const result = onProgress ? await streamTurn<MessageResult>(`/chat/${id}/messages`, body, onProgress) : await http<MessageResult>(`/chat/${id}/messages`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return { ...result, conversation: normalizeConversation(result.conversation) };
  },
  remove: (id: string) => http<{ ok: boolean }>(`/chat/${id}`, { method: 'DELETE' }),

  createProject: (goal: string, constraints?: Partial<ProjectState['constraints']>) => http<CreateResult>('/projects', { method: 'POST', body: JSON.stringify({ goal, constraints }) }),

  addInventory: (id: string, items: { name: string; note?: string }[]) => http<Project>(`/projects/${id}/inventory`, {
    method: 'POST',
    body: JSON.stringify({ items }),
  }),

  // legacy aliases
  listProjects: async () => (await http<unknown[]>('/projects')).map(normalizeConversation),

  // ── Providers page ────────────────────────────────────────────────────────
  // Keys are sent and returned as plain text: the UI shows what is stored.
  providers: {
    get: () => http<ProvidersState>('/providers'),
    addKey: (input: ProviderKeyInput) =>
      http<{ ok: boolean; key: ProviderKey; state: ProvidersState }>('/providers/keys', { method: 'POST', body: JSON.stringify(input) }),
    updateKey: (id: string, patch: Partial<ProviderKeyInput>) =>
      http<{ ok: boolean; key: ProviderKey; state: ProvidersState }>(`/providers/keys/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    removeKey: (id: string) =>
      http<{ ok: boolean; activeId: string; state: ProvidersState }>(`/providers/keys/${id}`, { method: 'DELETE' }),
    setActive: (id: string) =>
      http<{ ok: boolean; activeId: string; key: ProviderKey; state: ProvidersState }>('/providers/active', { method: 'POST', body: JSON.stringify({ id }) }),
    testKey: (id: string) =>
      http<ProviderTestResult>(`/providers/keys/${id}/test`, { method: 'POST', body: JSON.stringify({}) }),
    setFailover: (patch: Partial<FailoverSettings>) =>
      http<{ ok: boolean; failover: FailoverSettings; state: ProvidersState }>('/providers/failover', { method: 'PATCH', body: JSON.stringify(patch) }),
    restoreEnv: () => http<{ ok: boolean; state: ProvidersState }>('/providers/restore-env', { method: 'POST', body: JSON.stringify({}) }),
    log: () => http<{ log: ProvidersState['log']; failover: FailoverSettings; order: string[] }>('/providers/log'),
  },
  // Global rules — user-authored, cross-project; they feed the JEV pre-turn gate.
  globalRules: {
    list: () => http<GlobalRulesState>('/rules/global'),
    add: (input: { text: string; kind?: GlobalRuleKind; note?: string; enabled?: boolean }) =>
      http<{ ok: boolean; rule: GlobalRule } & GlobalRulesState>('/rules/global', { method: 'POST', body: JSON.stringify(input) }),
    update: (id: string, patch: Partial<Pick<GlobalRule, 'text' | 'kind' | 'note' | 'enabled'>>) =>
      http<{ ok: boolean; rule: GlobalRule } & GlobalRulesState>(`/rules/global/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    remove: (id: string) =>
      http<{ ok: boolean } & GlobalRulesState>(`/rules/global/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  },
};
