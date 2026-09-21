// Forge — API layer. Relative /api base: in dev the Vite proxy
// forwards to the server; in production Express serves the client itself.

import type {
  CreateResult, Health, MessageResult, Project, ProjectState,
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

// Releases of Forge before the project envelope was wired into the REST
// routes returned ProjectState directly. Normalize both shapes at the API
// boundary so an old server or an old persisted project cannot take down the
// React tree while the server is being upgraded.
function normalizeProject(payload: unknown): Project {
  if (!payload || typeof payload !== 'object') {
    throw new Error('API returned an invalid project');
  }

  const value = payload as Record<string, unknown>;
  const nested = value.state;
  if (nested && typeof nested === 'object' && Array.isArray((nested as Record<string, unknown>).phases)) {
    const now = new Date().toISOString();
    return {
      id: String(value.id || `project-${Date.now()}`),
      createdAt: String(value.createdAt || now),
      updatedAt: String(value.updatedAt || value.createdAt || now),
      state: nested as ProjectState,
    };
  }

  if (Array.isArray(value.phases)) {
    const {
      id,
      createdAt,
      updatedAt,
      ...state
    } = value;
    const now = new Date().toISOString();
    return {
      id: String(id || `project-${Date.now()}`),
      createdAt: String(createdAt || now),
      updatedAt: String(updatedAt || createdAt || now),
      state: state as unknown as ProjectState,
    };
  }

  throw new Error('API returned a project without state');
}

export const api = {
  health: () => http<Health>('/health'),
  list: async () => (await http<unknown[]>('/projects')).map(normalizeProject),
  get: async (id: string) => normalizeProject(await http<unknown>(`/projects/${id}`)),
  create: async (goal: string, constraints: ConstraintsIn) => {
    const result = await http<CreateResult>('/projects', {
      method: 'POST',
      body: JSON.stringify({ goal, constraints }),
    });
    return { ...result, project: normalizeProject(result.project) };
  },
  message: async (id: string, body: { text?: string; chip?: string }) => {
    const result = await http<MessageResult>(`/projects/${id}/messages`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return { ...result, project: normalizeProject(result.project) };
  },
  addInventory: async (id: string, items: { name: string; note?: string }[]) =>
    normalizeProject(await http<unknown>(`/projects/${id}/inventory`, {
      method: 'POST',
      body: JSON.stringify({ items }),
    })),
  remove: (id: string) => http<{ ok: boolean }>(`/projects/${id}`, { method: 'DELETE' }),
};
