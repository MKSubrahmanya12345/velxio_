import { useEffect, useState } from 'react';
import { listProjects, deleteProject } from '../api';
import type { ProjectSummary } from '../types';
import TopBar from '../components/TopBar';
import HowItWorks from '../components/HowItWorks';
import FlowPanel from '../components/FlowPanel';
import type { Health, FlowEntry } from '../types';

const SUGGESTIONS = [
  'make me a drone',
  'design a weather station with an ESP32',
  'build a 3D-printed camera gimbal',
  'plan a home server rack',
];

/**
 * Landing page — a chat, not a form. Type the goal and the run starts; the
 * project page takes over from there with the live chat + inspector.
 */
export default function HomePage({
  onOpen,
  health,
  onStart,
  busy,
  flow,
}: {
  onOpen: (id: string) => void;
  health: Health | null;
  onStart: (goal: string) => void;
  busy: boolean;
  flow: FlowEntry[];
}) {
  // While the first run is in flight the landing page doubles as a live view —
  // the same Flow panel the workspace uses, so the very first run is debuggable.
  const showLive = busy || flow.length > 0;
  const [goal, setGoal] = useState('');
  const [projects, setProjects] = useState<ProjectSummary[]>([]);

  const refresh = () =>
    listProjects()
      .then(setProjects)
      .catch(() => {});

  useEffect(() => {
    refresh();
  }, [busy]);

  const submit = () => {
    const g = goal.trim();
    if (!g || busy) return;
    setGoal('');
    onStart(g);
  };

  const lastFew = flow.slice(-6);

  return (
    <div className="app">
      <TopBar project={null} health={health} onHome={() => {}} />
      <div className="home-wrap">
        <div className="home-chat">
          <div className="hero">
            <h1>What do you want to build?</h1>
            <p className="muted">
              One line is enough. WireGI decomposes it, researches every part in parallel, integrates them, and shows
              you the entire trace while it works.
            </p>
          </div>

          <div className="home-composer">
            <textarea
              rows={2}
              placeholder='e.g. "make me a drone"'
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
              disabled={busy}
              autoFocus
            />
            <div className="row">
              <div className="chips">
                {SUGGESTIONS.map((s) => (
                  <button key={s} className="chip" onClick={() => setGoal(s)} disabled={busy}>
                    {s}
                  </button>
                ))}
              </div>
              <div className="spacer" />
              <button className="primary" onClick={submit} disabled={busy || !goal.trim()}>
                {busy ? 'starting…' : 'Build it'}
              </button>
            </div>
          </div>

          {busy && (
            <div className="bubble agent working">
              <div className="bubble-role">
                <span className="spinner" /> working — the workspace opens when this run settles
              </div>
              <ul className="activity">
                {lastFew.map((ev, i) => (
                  <li key={i} className={`lvl-${ev.level || 'info'}`}>
                    <span className="title">{ev.message}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {showLive && (
            <div className="panel">
              <h3>Live flow</h3>
              <FlowPanel flow={flow} project={null} health={health} onClear={() => {}} />
            </div>
          )}

          {projects.length > 0 && (
            <div className="panel">
              <h3>Recent projects</h3>
              <ul className="project-list">
                {projects.map((p) => (
                  <li key={p.id}>
                    <button className="project-open" onClick={() => onOpen(p.id)}>
                      <span className="goal">{p.goal}</span>
                      <span className={`pill status-${p.status}`}>{p.status}</span>
                      {p.parts > 0 && <span className="muted small">{p.parts} parts</span>}
                      {p.failed > 0 && <span className="bad small">{p.failed} failed</span>}
                      {p.errors > 0 && <span className="muted small">{p.errors} error(s)</span>}
                      <span className="muted small">{new Date(p.updatedAt).toLocaleString()}</span>
                    </button>
                    <button
                      className="ghost tiny"
                      title="delete project"
                      onClick={async () => {
                        await deleteProject(p.id);
                        refresh();
                      }}
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <HowItWorks />
        </div>
      </div>
    </div>
  );
}
