import type { Project, StreamEvent } from './types';

const API = '/api';

export async function health() {
  const r = await fetch(`${API}/health`);
  return r.json();
}

export async function listProjects(): Promise<Project[]> {
  const r = await fetch(`${API}/projects`);
  return r.json();
}

export async function getProject(id: string): Promise<Project> {
  const r = await fetch(`${API}/projects/${id}`);
  if (!r.ok) throw new Error('project not found');
  return r.json();
}

export async function research(query: string) {
  const r = await fetch(`${API}/research`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  return r.json();
}

// Stream a project request (create or message). Emits ndjson events live.
function streamRequest(path: string, body: any, onEvent: (e: StreamEvent) => void): Promise<Project> {
  return new Promise((resolve, reject) => {
    fetch(`${API}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
      body: JSON.stringify(body),
    })
      .then((r) => {
        if (!r.ok) {
          r.json()
            .then((j) => reject(new Error(j.error || 'request failed')))
            .catch(() => reject(new Error('request failed')));
          return;
        }
        if (!r.body) {
          r.json().then((j) => resolve(j)).catch(reject);
          return;
        }
        let lastResult: Project | null = null;
        const reader = r.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        const pump = () =>
          reader.read().then(({ done, value }) => {
            if (done) {
              resolve(lastResult as Project);
              return;
            }
            buf += decoder.decode(value, { stream: true });
            let nl;
            while ((nl = buf.indexOf('\n')) >= 0) {
              const line = buf.slice(0, nl).trim();
              buf = buf.slice(nl + 1);
              if (!line) continue;
              try {
                const ev = JSON.parse(line) as StreamEvent;
                onEvent(ev);
                if (ev.type === 'result') lastResult = ev.result;
                if (ev.type === 'error') reject(new Error(ev.error));
              } catch {
                /* ignore malformed line */
              }
            }
            return pump();
          });
        pump().catch(reject);
      })
      .catch(reject);
  });
}

export function createProject(goal: string, constraints: any, onEvent: (e: StreamEvent) => void) {
  return streamRequest('/projects', { goal, constraints }, onEvent);
}

export function sendMessage(id: string, text: string, onEvent: (e: StreamEvent) => void) {
  return streamRequest(`/projects/${id}/messages`, { text }, onEvent);
}
