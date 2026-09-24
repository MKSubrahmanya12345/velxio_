import type { Health, Project } from '../types';

const STATUS_LABEL: Record<string, string> = {
  init: 'no run yet',
  researching: 'working',
  awaiting_human: 'needs you',
  partial: 'partial',
  complete: 'complete',
  failed: 'failed',
};

/**
 * The header: where you are, whether it is working, and a way out.
 *
 * The JEV / web-search pills moved into the Debug tab. They were plumbing
 * status on every screen that only ever mattered when something was broken —
 * and when something *is* broken, Debug is where you go anyway. One pill
 * remains, because "no LLM key" is the one piece of plumbing status that
 * explains a dead run.
 */
export default function TopBar({
  project,
  health,
  onHome,
  onToggle,
  infoOpen,
  onRerun,
  rerunLabel,
  onHelp,
}: {
  project: Project | null;
  health: Health | null;
  onHome: () => void;
  onToggle?: () => void;
  infoOpen?: boolean;
  onRerun?: () => void;
  rerunLabel?: string;
  onHelp?: () => void;
}) {
  const status = project?.status || 'init';
  const llmOk = (health?.providers ?? 0) > 0;

  return (
    <header className="topbar">
      <button className="brand" onClick={onHome} title="All projects">
        <span className="brand-mark">◈</span>
        <span className="brand-name">WireGI</span>
      </button>
      {project && (
        <div className="topbar-project">
          <span className="goal" title={project.goal}>
            {project.goal}
          </span>
          <span className={`pill status-${status}`}>{STATUS_LABEL[status] || status}</span>
          {project.profileLabel && <span className="pill subtle">{project.profileLabel}</span>}
        </div>
      )}
      <div className="spacer" />
      {onRerun && rerunLabel && (
        <button className="ghost small" onClick={onRerun} title="Re-run only the parts that are missing or failed">
          ↻ {rerunLabel}
        </button>
      )}
      <span
        className={`pill ${llmOk ? 'good' : 'bad'}`}
        title={
          llmOk
            ? `Active: ${health?.activeProvider || '?'}`
            : 'No provider key configured — runs will fail at the first LLM call. Fix it in the Debug tab.'
        }
      >
        {llmOk ? `${health?.providers} key${health?.providers === 1 ? '' : 's'}` : 'no LLM key'}
      </span>
      {onToggle && (
        <button className="ghost small only-narrow" onClick={onToggle}>
          {infoOpen ? 'Chat' : 'Info'}
        </button>
      )}
      {onHelp && (
        <button className="ghost tiny" onClick={onHelp} title="How WireGI works">
          ?
        </button>
      )}
    </header>
  );
}
