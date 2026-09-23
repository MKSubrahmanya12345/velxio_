import { useEffect, useState } from 'react';
import { createProject, listProjects } from '../api';
import HowItWorks from '../components/HowItWorks';

export default function HomePage({ onOpen }: { onOpen: (id: string) => void }) {
  const [goal, setGoal] = useState('');
  const [log, setLog] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [projects, setProjects] = useState<any[]>([]);

  const refresh = async () => {
    try {
      setProjects(await listProjects());
    } catch {
      /* ignore */
    }
  };
  useEffect(() => {
    refresh();
  }, []);

  const run = async () => {
    if (!goal.trim() || running) return;
    setRunning(true);
    setLog([]);
    const onEvent = (e: any) => {
      const msg =
        e.type === 'decision'
          ? `DECISION ${e.label} (${e.source || '?'})`
          : e.type === 'research'
            ? `RESEARCH ${e.part}: ${e.message}`
            : e.type === 'part'
              ? `PART ${e.part} → ${e.stage}`
              : e.type === 'project'
                ? `DECOMPOSED ${e.parts?.length} parts`
                : e.type === 'done'
                  ? `DONE ${e.status}`
                  : e.type === 'error'
                    ? `ERROR ${e.error}`
                    : '';
      if (msg) setLog((l) => [...l, msg]);
    };
    try {
      const proj = await createProject(goal, {}, onEvent);
      onOpen(proj.id);
    } catch (err: any) {
      setLog((l) => [...l, 'ERROR ' + (err?.message || 'failed')]);
    } finally {
      setRunning(false);
      refresh();
    }
  };

  return (
    <div className="home">
      <h1>WireGI — agentic build assistant</h1>
      <p style={{ color: 'var(--muted)' }}>
        Describe something buildable. The agent decomposes it, researches each part (web + model), and streams
        every decision and finding back to you.
      </p>
      <textarea
        rows={3}
        placeholder='e.g. "make me a drone"'
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
      />
      <div className="btn-row">
        <button onClick={run} disabled={running || !goal.trim()}>
          {running ? 'Running…' : 'Build it'}
        </button>
      </div>
      {log.length > 0 && (
        <div className="panel" style={{ marginTop: 14 }}>
          <h3>Live run</h3>
          <div className="event-log">{log.join('\n')}</div>
        </div>
      )}
      {projects.length > 0 && (
        <div className="panel" style={{ marginTop: 14 }}>
          <h3>Past projects</h3>
          <ul className="tight">
            {projects.map((p: any) => (
              <li key={p.id}>
                <a onClick={() => onOpen(p.id)} style={{ cursor: 'pointer' }}>
                  {p.goal}
                </a>{' '}
                <span className="badge">{p.status}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div style={{ marginTop: 18 }}>
        <HowItWorks />
      </div>
    </div>
  );
}
