// Forge — API layer (chat-first)

import type { Conversation, Health, MessageResult, CreateResult } from './types';

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
      pendingHumanTools: Array.isArray(v.pendingHumanTools) ? v.pendingHumanTools : [],
      counters: v.counters || { messages: 0, jevCalls: 0, humanCalls: 0, plans: 0 },
    };
  }
  throw new Error('API returned invalid conversation');
}

export const api = {
  health: () => http<Health>('/health'),
  list: async () => (await http<unknown[]>('/chat')).map(normalizeConversation),
  get: async (id: string) => normalizeConversation(await http<unknown>(`/chat/${id}`)),
  create: async (goal: string) => {
    const result = await http<CreateResult>('/chat', {
      method: 'POST',
      body: JSON.stringify({ goal }),
    });
    return { ...result, conversation: normalizeConversation(result.conversation) };
  },
  message: async (id: string, body: { text?: string; chip?: string }) => {
    const result = await http<MessageResult>(`/chat/${id}/messages`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return { ...result, conversation: normalizeConversation(result.conversation) };
  },
  remove: (id: string) => http<{ ok: boolean }>(`/chat/${id}`, { method: 'DELETE' }),

  // legacy aliases
  listProjects: async () => (await http<unknown[]>('/projects')).map(normalizeConversation),
};
