import { progressOf } from '../state';
import type { Project } from '../types';

export function ProjectList({ projects, onOpen }: { projects: Project[]; onOpen: (p: Project) => void }) {
  if (!projects.length) return null;
  return (
    <section className="fg-section">
      <h2 className="fg-section-title">Projects</h2>
      <div className="fg-cards">
        {projects.map((p) => {
          const pr = progressOf(p.state);
          return (
            <button key={p.id} className="fg-card fg-card-btn" onClick={() => onOpen(p)}>
              <div className="fg-card-top">
                <strong className="fg-card-goal">{p.state.goal}</strong>
                <span className={`fg-status fg-status-${p.state.status}`}>{p.state.status}</span>
              </div>
              <div className="fg-progress fg-progress-sm">
                <div className="fg-progress-bar" style={{ width: `${Math.round(pr.pct * 100)}%` }} />
              </div>
              <div className="fg-card-meta">
                <span>{pr.completed}/{pr.total} steps</span>
                <span>{p.state.feasibility.category}</span>
                <span>
                  {new Date(p.updatedAt).toLocaleDateString()}{' '}
                  {new Date(p.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}
