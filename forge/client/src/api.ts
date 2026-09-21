// Forge client — API layer. Relative /api base: in dev the Vite proxy
// forwards to the server; in production Express serves the client itself.

import type {
  CreateResult, Health, MessageResult, Project,
} from './types';

const BASE =
  (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_API_URL ?? '/api';

async function http<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json() as { error?: string }).error || ''; } catch { /* not json */ }
    throw new Error(`API ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return res.json() as Promise<T>;
}

export interface ConstraintsIn {
  budget_usd?: number | null;
  time?: string;
  skill?: string;
  notes?: string;
}

export const api = {
  health: () => http<Health>('/health'),
  list: () => http<Project[]>('/projects'),
  get: (id: string) => http<Project>(`/projects/${id}`),
  create: (goal: string, constraints: ConstraintsIn) =>
    http<CreateResult>('/projects', { method: 'POST', body: JSON.stringify({ goal, constraints }) }),
  message: (id: string, body: { text?: string; chip?: string }) =>
    http<MessageResult>(`/projects/${id}/messages`, { method: 'POST', body: JSON.stringify(body) }),
  addInventory: (id: string, items: { name: string; note?: string }[]) =>
    http<Project>(`/projects/${id}/inventory`, { method: 'POST', body: JSON.stringify({ items }) }),
  remove: (id: string) => http<{ ok: boolean }>(`/projects/${id}`, { method: 'DELETE' }),
};
