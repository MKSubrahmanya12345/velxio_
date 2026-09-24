import type { Health, Project } from '../types';
import ProviderStrip from './ProviderStrip';

const STATUS_LABEL: Record<string, string> = {
  init: 'no run yet',
  researching: 'working',
  awaiting_human: 'needs you',
  partial: 'partial',
  complete: 'complete',
  failed: 'failed',
};

export default function TopBar({
  project,
  health,
  onHome,
  onToggle,
  infoOpen,
  onRerun,
  rerunLabel,
}: {
  project: Project | null;
  health: Health | null;
  onHome: () => void;
  onToggle?: () => void;
  infoOpen?: boolean;
  onRerun?: () => void;
  rerunLabel?: string;
}) {
  const status = project?.status || 'init';
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
      <ProviderStrip health={health} />
      {onToggle && (
        <button className="ghost small only-narrow" onClick={onToggle}>
          {infoOpen ? 'Chat' : 'Info'}
        </button>
      )}
    </header>
  );
}
