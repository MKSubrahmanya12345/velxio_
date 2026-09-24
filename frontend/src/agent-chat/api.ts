// WireGI server client for the Velxio-hosted chat UI.
//
// Base URL: relative `/wiregi` by default — the Vite dev server proxies it to
// the WireGI server (localhost:4322), so the browser never talks to another
// origin (works in remote/preview setups too). VITE_WIREGI_URL overrides for
// direct connections in production.
import type { FlowEntry, Health, HumanDecision, Project, ProjectSummary } from './types';

const RAW_BASE = (import.meta.env.VITE_WIREGI_URL as string | undefined) || '/wiregi';
const API = RAW_BASE.replace(/\/+$/, '') + '/api';

async function jsonOrThrow<T>(p: Promise<Response>, what: string): Promise<T> {
  const r = await p;
  if (!r.ok) {
    let message = `${what} failed (HTTP ${r.status})`;
    try {
      const j = await r.json();
      if (j?.error) message = typeof j.error === 'string' ? j.error : JSON.stringify(j.error);
    } catch {
      /* keep the status-only message */
    }
    throw new Error(message);
  }
  return r.json() as Promise<T>;
}

export const health = () => jsonOrThrow<Health>(fetch(`${API}/health`), 'health');
export const listProjects = () =>
  jsonOrThrow<ProjectSummary[]>(fetch(`${API}/projects`), 'list chats');
export const getProject = (id: string) =>
  jsonOrThrow<Project>(fetch(`${API}/projects/${id}`), 'load chat');
export const deleteProject = (id: string) =>
  jsonOrThrow<{ ok: boolean }>(fetch(`${API}/projects/${id}`, { method: 'DELETE' }), 'delete chat');

/**
 * Stream an ndjson trace (create / message / human). Same contract as the
 * WireGI clients: heartbeats and malformed lines are skipped, only a terminal
 * `error` (or a failed HTTP response) rejects, and a rejection always carries
 * a real message. Terminal payload is the updated project.
 */
function streamRequest(
  path: string,
  body: unknown,
  onEvent: (e: FlowEntry) => void,
  signal?: AbortSignal,
): Promise<Project> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let lastResult: Project | null = null;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const succeed = (project: Project) => {
      if (settled) return;
      settled = true;
      resolve(project);
    };

    fetch(`${API}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
      body: JSON.stringify(body),
      signal,
    })
      .then((r) => {
        if (!r.ok) {
          r.json()
            .then((j) => {
              const detail =
                typeof j?.error === 'string' ? j.error : j?.error ? JSON.stringify(j.error) : '';
              fail(new Error(detail || `request failed with HTTP ${r.status}`));
            })
            .catch(() => fail(new Error(`request failed with HTTP ${r.status}`)));
          return;
        }
        if (!r.body) {
          r.json().then(succeed).catch((e) => fail(new Error(String(e?.message || e))));
          return;
        }
        const reader = r.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        const pump = (): Promise<void> =>
          reader.read().then(({ done, value }) => {
            if (done) {
              if (lastResult) succeed(lastResult);
              else
                fail(
                  new Error(
                    'the stream ended without a result — the agent may still be running; refresh in a moment',
                  ),
                );
              return;
            }
            buf += decoder.decode(value, { stream: true });
            let nl: number;
            while ((nl = buf.indexOf('\n')) >= 0) {
              const line = buf.slice(0, nl).trim();
              buf = buf.slice(nl + 1);
              if (!line || line.startsWith(':')) continue; // heartbeat
              let ev: FlowEntry;
              try {
                ev = JSON.parse(line);
              } catch {
                continue;
              }
              onEvent(ev);
              if (ev.type === 'result') lastResult = (ev.result as Project) || null;
              if (ev.type === 'error' && ev.fatal !== false) {
                const errObj = ev.error as { message?: string } | string | undefined;
                const message =
                  (errObj && typeof errObj === 'object' && errObj.message) ||
                  (typeof errObj === 'string' ? errObj : '') ||
                  ev.message ||
                  'the run failed (no message was provided by the server)';
                fail(new Error(message));
              }
            }
            return pump();
          });
        pump().catch((e) => fail(new Error(String(e?.message || e))));
      })
      .catch((e) => fail(new Error(e?.name === 'AbortError' ? 'cancelled' : String(e?.message || e))));
  });
}

/** Create a chat from a prompt — the "new chat" flow. Runs the full agent. */
export function createProject(
  goal: string,
  onEvent: (e: FlowEntry) => void,
  signal?: AbortSignal,
) {
  return streamRequest(`/projects`, { goal }, onEvent, signal);
}

export function sendMessage(id: string, text: string, onEvent: (e: FlowEntry) => void, signal?: AbortSignal) {
  return streamRequest(`/projects/${id}/messages`, { text }, onEvent, signal);
}

export function respondHuman(
  id: string,
  payload: { partId?: string | null; decision: HumanDecision; text?: string },
  onEvent: (e: FlowEntry) => void,
  signal?: AbortSignal,
) {
  return streamRequest(`/projects/${id}/human`, payload, onEvent, signal);
}
