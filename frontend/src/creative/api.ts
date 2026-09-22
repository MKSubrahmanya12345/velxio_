import { getApiBase } from '../lib/apiBase';

export interface CreativeFormat {
  id: string;
  label: string;
  hint: string;
}

export interface CreativeStatus {
  enabled: boolean;
  live: boolean;
  base_url: string;
  forge: Record<string, unknown>;
  formats: CreativeFormat[];
}

export interface CollectionSummary {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  noteCount: number;
  pendingCount: number;
  sourceCount: number;
  sources: SourceMeta[];
}

export interface SourceMeta {
  id: string;
  kind: string;
  url: string;
  title: string;
  source: string;
  fetchedAt: string;
  chars: number;
}

export interface MemoryNote {
  id: string;
  kind: string;
  domain?: string;
  text: string;
  status: string;
  origin?: string;
  sourceId?: string;
  quote?: string;
}

export interface CollectionDetail extends CollectionSummary {
  notes: MemoryNote[];
  sourcePreviews: (SourceMeta & { summary: string; preview: string })[];
}

export interface IngestResult {
  source: SourceMeta;
  transcriptChars: number;
  notes: MemoryNote[];
  jev: string;
  collection: CollectionSummary;
}

export interface IdeaVerdict {
  support: number | null;
  compatible: number | null;
  conflictsWith: string | null;
  conflictsText: string | null;
  verdict: 'supported' | 'uncertain' | 'unknown' | 'unsupported' | 'conflict';
}

export interface Idea {
  title: string;
  pitch: string;
  hooks: string[];
  sourceNoteIds: string[];
  jev: IdeaVerdict;
}

export interface IdeasResult {
  ideas: Idea[];
  contextNoteIds: string[];
  jev: string;
  activeNotes: number;
}

export interface ScriptPack {
  script: string;
  hooks: string[];
  titles: string[];
  thumbnails: string[];
  sourcesUsed: string[];
  needsCheck: string[];
  sources: { noteId: string; kind?: string; text?: string; sourceId?: string | null }[];
  format: string;
  idea: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${getApiBase()}/creative${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!response.ok) {
    let detail = `Request failed (HTTP ${response.status}).`;
    try {
      const body = await response.json();
      if (body && typeof body.detail === 'string') detail = body.detail;
      else if (body && typeof body.error === 'string') detail = body.error;
    } catch {
      /* keep default */
    }
    throw new Error(detail);
  }
  return response.json() as Promise<T>;
}

export const creativeApi = {
  status: () => request<CreativeStatus>('/status'),
  listCollections: () =>
    request<{ collections: CollectionSummary[] }>('/collections'),
  createCollection: (name: string) =>
    request<CollectionSummary>('/collections', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  collectionDetail: (id: string) =>
    request<CollectionDetail>(`/collections/${encodeURIComponent(id)}`),
  deleteCollection: (id: string) =>
    request<{ ok: boolean }>(`/collections/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  ingest: (id: string, body: { url?: string; text?: string; title?: string }) =>
    request<IngestResult>(`/collections/${encodeURIComponent(id)}/ingest`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  patchNote: (id: string, noteId: string, patch: { text?: string; kind?: string; domain?: string }) =>
    request<{ note: MemoryNote }>(
      `/collections/${encodeURIComponent(id)}/notes/${encodeURIComponent(noteId)}`,
      { method: 'PATCH', body: JSON.stringify(patch) },
    ),
  deleteNote: (id: string, noteId: string) =>
    request<{ deleted: string }>(
      `/collections/${encodeURIComponent(id)}/notes/${encodeURIComponent(noteId)}`,
      { method: 'DELETE' },
    ),
  ideas: (id: string, body: { prompt: string; count: number }) =>
    request<IdeasResult>(`/collections/${encodeURIComponent(id)}/ideas`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  script: (id: string, body: { idea: string; prompt?: string; format: string }) =>
    request<ScriptPack>(`/collections/${encodeURIComponent(id)}/script`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
};

export function describeVerdict(v: IdeaVerdict): { label: string; tone: string } {
  switch (v.verdict) {
    case 'supported':
      return { label: 'JEV · supported', tone: 'good' };
    case 'uncertain':
      return { label: 'JEV · uncertain', tone: 'warn' };
    case 'unsupported':
      return { label: 'JEV · unsupported', tone: 'warn' };
    case 'conflict':
      return { label: 'JEV · conflicts', tone: 'bad' };
    default:
      return { label: 'JEV · unscored', tone: 'muted' };
  }
}
