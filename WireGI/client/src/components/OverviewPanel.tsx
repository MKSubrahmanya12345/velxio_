import type { Part, Project } from '../types';
import type { RunState } from '../lib/useProject';

function Bar({ parts }: { parts: Part[] }) {
  const total = parts.length || 1;
  const groups = [
    { key: 'verified', label: 'verified', cls: 'verified' },
    { key: 'awaiting_human', label: 'needs you', cls: 'awaiting_human' },
    { key: 'data_ready', label: 'researched', cls: 'data_ready' },
    { key: 'researching', label: 'in progress', cls: 'researching' },
    { key: 'pending', label: 'pending', cls: 'pending' },
    { key: 'failed', label: 'failed', cls: 'failed' },
  ];
  return (
    <div className="bar">
      <div className="bar-track">
        {groups.map((g) => {
          const n = parts.filter((p) => p.status === g.key).length;
          if (!n) return null;
          return <span key={g.key} className={`bar-seg ${g.cls}`} style={{ width: `${(n / total) * 100}%` }} />;
        })}
      </div>
      <div className="bar-legend">
        {groups.map((g) => {
          const n = parts.filter((p) => p.status === g.key).length;
          if (!n) return null;
          return (
            <span key={g.key} className={`legend ${g.cls}`}>
              {n} {g.label}
            </span>
          );
        })}
      </div>
    </div>
  );
}

export default function OverviewPanel({
  project,
  parts,
  run,
}: {
  project: Project | null;
  parts: Part[];
  run: RunState;
}) {
  if (!project) return <div className="muted pad">No project loaded.</div>;
  const idea = project.state.idea || {};
  const profile = idea.profile || {};
  const revisions = idea.revisions || [];

  return (
    <div className="overview">
      <section className="panel">
        <h3>Goal</h3>
        <p className="goal-text">{project.goal}</p>
        <Bar parts={parts} />
        {run.running && (
          <div className="muted small">
            running · phase {run.currentPhase || '—'} · {run.done} done / {run.total}
          </div>
        )}
      </section>

      <section className="panel">
        <h3>Classification</h3>
        <table className="kvtable">
          <tbody>
            <tr>
              <td>kind</td>
              <td>{idea.classification || '—'}</td>
            </tr>
            <tr>
              <td>domains</td>
              <td>{(idea.domains || []).join(', ') || '—'}</td>
            </tr>
            <tr>
              <td>profile</td>
              <td>
                {project.profileLabel || '—'}
                {profile.ladder?.length ? <span className="muted small"> · {profile.ladder.join(' → ')}</span> : null}
              </td>
            </tr>
            <tr>
              <td>constraints</td>
              <td>{Object.keys(project.constraints || {}).length ? JSON.stringify(project.constraints) : '—'}</td>
            </tr>
            <tr>
              <td>parts</td>
              <td>
                {parts.length} · {parts.filter((p) => p.verified).length} verified by you
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      {revisions.length > 0 && (
        <section className="panel">
          <h3>IDEA revisions ({revisions.length})</h3>
          {revisions
            .slice()
            .reverse()
            .map((r: any, i: number) => (
              <div className="revision" key={i}>
                <div>
                  <b>r{r.revision}</b> <span className="muted small">{r.kind}</span>
                </div>
                <div className="muted small">{r.note}</div>
                <time className="muted small">{new Date(r.at).toLocaleString()}</time>
              </div>
            ))}
        </section>
      )}
    </div>
  );
}
