import { useEffect, useState, type ReactNode } from 'react';
import { listProjects, deleteProject } from '../api';
import type { ProjectSummary } from '../types';
import TopBar from '../components/TopBar';
import HowItWorks from '../components/HowItWorks';
import FlowPanel from '../components/FlowPanel';
import type { Health, FlowEntry } from '../types';

const SUGGESTIONS = [
  { text: 'make me a drone', icon: 'rocket' },
  { text: 'design a weather station with an ESP32', icon: 'thermometer' },
  { text: 'build a 3D-printed camera gimbal', icon: 'camera' },
  { text: 'plan a home server rack', icon: 'server' },
] as const;

/** 13px stroke icons — stroke SVG (no icon lib in this client). */
const Svg =
  (paths: ReactNode) =>
  ({ w = 13, className }: { w?: number; className?: string } = {}) => (
    <svg
      width={w}
      height={w}
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths}
    </svg>
  );

const RocketIcon = Svg(
  <>
    <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
    <path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
    <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
    <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
  </>,
);
const ThermometerIcon = Svg(
  <>
    <path d="M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0z" />
    <path d="M12 10a1.5 1.5 0 0 0 1.5 1.5 1.5 1.5 0 0 0 0-3 1.5 1.5 0 0 0-1.5 1.5z" />
  </>,
);
const CameraIcon = Svg(
  <>
    <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
    <circle cx="12" cy="13" r="3" />
  </>,
);
const ServerIcon = Svg(
  <>
    <rect x="2" y="3" width="20" height="7" rx="2" />
    <rect x="2" y="14" width="20" height="7" rx="2" />
    <path d="M6 6.5h.01M6 17.5h.01" />
  </>,
);
const BoltIcon = Svg(<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />);
const ArrowIcon = Svg(<path d="M5 12h14M12 5l7 7-7 7" />);
const ChevronIcon = Svg(<path d="M9 18l6-6-6-6" />);
const XIcon = Svg(
  <>
    <path d="M18 6 6 18M6 6l12 12" />
  </>,
);

const SUGGESTION_ICONS: Record<string, typeof RocketIcon> = {
  rocket: RocketIcon,
  thermometer: ThermometerIcon,
  camera: CameraIcon,
  server: ServerIcon,
};

/**
 * Landing page — a chat, not a form. Type the goal and the run starts; the
 * project page takes over from there with the live chat + inspector.
 *
 * The six-step "How WireGI works" explainer, the debugging bullet list and the
 * .env precedence paragraph used to be rendered in full at the bottom of this
 * page, on every visit — roughly 250 words of documentation sitting between
 * the user and the projects they came back for. It is a collapsed <details>
 * now. The same component is reachable from `?` in the header on a project.
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
            <span className="hero-badge">
              <BoltIcon w={12} />
              agentic hardware copilot
            </span>
            <h1>
              What do you want to <span className="grad">build?</span>
            </h1>
            <p className="muted">
              One line is enough. WireGI decomposes it, researches every part in
              parallel, integrates them, and shows you the entire trace while it
              works.
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
            <div className="composer-footer">
              <div className="chips">
                {SUGGESTIONS.map((s) => {
                  const Ico = SUGGESTION_ICONS[s.icon];
                  return (
                    <button
                      key={s.text}
                      className="chip"
                      onClick={() => setGoal(s.text)}
                      disabled={busy}
                    >
                      <Ico w={13} />
                      {s.text}
                    </button>
                  );
                })}
              </div>
              <div className="composer-actions">
                <span className="enter-hint">
                  <kbd>↵</kbd> Enter to fire
                </span>
                <button className="primary build-btn" onClick={submit} disabled={busy || !goal.trim()}>
                  {busy ? (
                    <>
                      <span className="spinner" /> starting…
                    </>
                  ) : (
                    <>
                      Build it <ArrowIcon w={15} />
                    </>
                  )}
                </button>
              </div>
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

          {showLive && !busy && (
            <div className="panel">
              <h3>Live flow</h3>
              <FlowPanel flow={flow} project={null} health={health} onClear={() => {}} />
            </div>
          )}

          {projects.length > 0 && (
            <div className="panel">
              <div className="panel-title-row">
                <h3>Recent projects</h3>
                <span className="muted tiny">{projects.length}</span>
              </div>
              <ul className="project-list">
                {projects.map((p) => (
                  <li key={p.id}>
                    <button className="project-open" onClick={() => onOpen(p.id)}>
                      <span className={`dot status-${p.status}`} />
                      <span className="goal">{p.goal}</span>
                      <span className={`pill status-${p.status}`}>{p.status}</span>
                      {p.parts > 0 && <span className="muted small">{p.parts} parts</span>}
                      {p.failed > 0 && <span className="bad small">{p.failed} failed</span>}
                      <span className="muted small when">{new Date(p.updatedAt).toLocaleString()}</span>
                      <ChevronIcon w={14} className="chevron" />
                    </button>
                    <button
                      className="ghost tiny delete"
                      title="delete project"
                      onClick={async () => {
                        await deleteProject(p.id);
                        refresh();
                      }}
                    >
                      <XIcon w={11} />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <details className="panel collapsible">
            <summary>How WireGI works</summary>
            <HowItWorks />
          </details>
        </div>
      </div>
    </div>
  );
}