import type { DebugBundle, FlowEntry, Health, Project, ProjectSummary } from './types';

const API = '/api';

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
export const debugHealth = () => jsonOrThrow<any>(fetch(`${API}/debug/health`), 'debug health');
export const debugEnv = () => jsonOrThrow<any>(fetch(`${API}/debug/env`), 'debug env');

export const listProjects = () => jsonOrThrow<ProjectSummary[]>(fetch(`${API}/projects`), 'list projects');
export const getProject = (id: string) => jsonOrThrow<Project>(fetch(`${API}/projects/${id}`), 'load project');
export const getDebugBundle = (id: string) =>
  jsonOrThrow<DebugBundle>(fetch(`${API}/projects/${id}/debug`), 'load debug bundle');
export const deleteProject = (id: string) =>
  fetch(`${API}/projects/${id}`, { method: 'DELETE' }).then((r) => r.json());

export const research = (query: string) =>
  fetch(`${API}/research`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  }).then((r) => r.json());

export const llmTest = () =>
  fetch(`${API}/debug/llm-test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(
    async (r) => ({ status: r.status, body: await r.json() }),
  );

export const webTest = (query: string) =>
  fetch(`${API}/debug/web-test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  }).then((r) => r.json());

/**
 * Stream an ndjson trace (create / message / resume).
 *
 * Rules this function exists to enforce:
 *   · a `provider` event is informational — it never fails the request
 *   · only a terminal `error` event (or a failed HTTP response) rejects
 *   · a rejection always carries a real message (never `undefined`)
 *   · `: hb` heartbeat lines and malformed lines are skipped, not fatal
 */
function streamRequest(
  path: string,
  body: any,
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
              const detail = typeof j?.error === 'string' ? j.error : j?.error ? JSON.stringify(j.error) : '';
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
              else fail(new Error('the stream ended without a result — check the Flow panel for the last event'));
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
                continue; // a broken line must not kill the stream
              }
              ev.receivedAt = Date.now();
              onEvent(ev);
              if (ev.type === 'result') lastResult = ev.result || null;
              if (ev.type === 'error' && ev.fatal !== false) {
                const message =
                  (typeof ev.error === 'object' && ev.error?.message) ||
                  (typeof ev.error === 'string' ? ev.error : '') ||
                  ev.message ||
                  'the run failed (no message was provided by the server)';
                const err = new Error(message);
                err.name = (typeof ev.error === 'object' && ev.error?.name) || 'RunError';
                (err as any).where = (typeof ev.error === 'object' && ev.error?.where) || ev.where;
                (err as any).flow = ev;
                fail(err);
              }
            }
            return pump();
          });
        pump().catch((e) => fail(new Error(String(e?.message || e))));
      })
      .catch((e) => fail(new Error(e?.name === 'AbortError' ? 'run cancelled' : String(e?.message || e))));
  });
}

export function createProject(goal: string, constraints: any, onEvent: (e: FlowEntry) => void, signal?: AbortSignal) {
  return streamRequest('/projects', { goal, constraints }, onEvent, signal);
}

export function sendMessage(id: string, text: string, onEvent: (e: FlowEntry) => void, signal?: AbortSignal) {
  return streamRequest(`/projects/${id}/messages`, { text }, onEvent, signal);
}

export function resumeProject(id: string, onEvent: (e: FlowEntry) => void, signal?: AbortSignal) {
  return streamRequest(`/projects/${id}/resume`, {}, onEvent, signal);
}

export type HumanDecision = 'approve' | 'provide' | 'rerun' | 'reject';

/**
 * The human checkpoint → the same ndjson trace as any other run.
 * `partId` may be null (all parts at the checkpoint). No LLM is involved, so
 * this works even when no provider key is configured.
 */
export function respondHuman(
  id: string,
  payload: { partId?: string | null; decision: HumanDecision; text?: string },
  onEvent: (e: FlowEntry) => void,
  signal?: AbortSignal,
) {
  return streamRequest(`/projects/${id}/human`, payload, onEvent, signal);
}

/** Download the trace of a project as a file (flow panel → "Export"). */
export function exportTrace(project: Project | null, flow: FlowEntry[]) {
  const payload = {
    exportedAt: new Date().toISOString(),
    project: project
      ? { id: project.id, goal: project.goal, status: project.status, profile: project.profileLabel }
      : null,
    runs: project?.state?.runs || [],
    errors: project?.state?.errors || [],
    events: flow,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `wiregi-trace-${project?.id || 'project'}-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
