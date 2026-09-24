import type { Part, Project } from '../types';
import type { RunState } from '../lib/useProject';
import PartCard from './PartCard';

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

/**
 * The Build tab: what you asked for, where it stands, and every part.
 *
 * This used to be two tabs — "Overview" (goal + a classification table + IDEA
 * revisions) and "Parts" (the list). Two tabs forced a click between the
 * question and the answer, and the classification table pushed the parts below
 * the fold on every single visit. Now it is one scroll, and the reference
 * detail that you read once is collapsed.
 */
export default function BuildPanel({
  project,
  parts,
  run,
  busy,
  onResume,
}: {
  project: Project | null;
  parts: Part[];
  run: RunState;
  busy: boolean;
  onResume: () => void;
}) {
  if (!project) return <div className="muted pad">No project loaded.</div>;

  const idea = project.state.idea || {};
  const profile = idea.profile || {};
  const revisions = idea.revisions || [];
  const verified = parts.filter((p) => p.verified).length;
  const needsEyes = parts.filter((p) => p.humanCheckpoint && !p.verified).length;
  const failed = parts.filter((p) => p.status === 'failed').length;

  return (
    <div className="build">
      <section className="panel">
        <p className="goal-text">{project.goal}</p>
        <Bar parts={parts} />
        <div className="row wrap">
          <span className="muted small">
            {parts.length} part{parts.length === 1 ? '' : 's'} · {verified} verified · {needsEyes} need eyes
            {failed ? ` · ${failed} failed` : ''}
          </span>
          <div className="spacer" />
          <button className="ghost small" onClick={onResume} disabled={busy || !project} title="Re-run the parts that are missing or failed">
            ↻ Resume / retry
          </button>
        </div>
        {run.running && (
          <div className="muted small">
            running · {run.currentPhase || '—'} · {run.done} done / {run.total}
          </div>
        )}
      </section>

      <details className="panel collapsible">
        <summary>
          Classification
          {project.profileLabel ? <span className="muted small"> · {project.profileLabel}</span> : null}
        </summary>
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
              <td>ladder</td>
              <td>{(profile.ladder || []).join(' → ') || '—'}</td>
            </tr>
            <tr>
              <td>constraints</td>
              <td>{Object.keys(project.constraints || {}).length ? JSON.stringify(project.constraints) : '—'}</td>
            </tr>
          </tbody>
        </table>
        {revisions.length > 0 && (
          <>
            <div className="key-group-title">IDEA revisions ({revisions.length})</div>
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
          </>
        )}
      </details>

      {!parts.length && <div className="muted pad">No parts yet — send a build request in the chat.</div>}
      {parts.map((p) => (
        <PartCard key={p.id} part={p} defaultOpen={p.status === 'failed'} />
      ))}
    </div>
  );
}
