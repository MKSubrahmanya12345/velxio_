import { useState } from 'react';
import { api } from '../api';
import { activeStepRef, progressOf } from '../state';
import type { Decision, Project, ResponsePayload } from '../types';
import { StepCard } from './StepCard';
import { ReportPanel } from './ReportPanel';
import { SidePanel } from './SidePanel';
import { ConfidenceMeter } from './ConfidenceMeter';

export function BenchView({
  project, onProject, onBack,
}: {
  project: Project;
  onProject: (p: Project) => void;
  onBack: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [lastResponse, setLastResponse] = useState<ResponsePayload | null>(null);
  const [lastDecisions, setLastDecisions] = useState<Decision[]>([]);

  const st = project.state;
  const ref = activeStepRef(st);
  const pr = progressOf(st);

  const send = async (text: string, chip?: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await api.message(project.id, { text, chip });
      setLastResponse(r.response);
      setLastDecisions(r.decisions);
      onProject(r.project);
    } catch (e) {
      setLastResponse({ text: `Request failed: ${String((e as Error).message)}`, suggestions: [] });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fg-bench">
      <div className="fg-bench-head">
        <button className="fg-back" onClick={onBack}>← projects</button>
        <div className="fg-bench-goal">
          <strong>{st.goal}</strong>
          <span className={`fg-status fg-status-${st.status}`}>{st.status}</span>
        </div>
        <div className="fg-progress">
          <div className="fg-progress-bar" style={{ width: `${Math.round(pr.pct * 100)}%` }} />
        </div>
        <span className="fg-progress-label">{pr.completed}/{pr.total} steps</span>
        {st.confidence.triage !== undefined && ref && (
          <ConfidenceMeter value={st.confidence.triage} label="triage" />
        )}
      </div>

      <div className="fg-bench-grid">
        <section className="fg-col-main">
          {ref ? (
            <StepCard project={project} onSend={send} />
          ) : (
            <div className="fg-card fg-done-card">
              {st.status === 'complete'
                ? '🏁 Project complete. Back to the project list when you want to build something else.'
                : 'No active step — claim done to run the acceptance check.'}
            </div>
          )}
          <ReportPanel
            project={project}
            onSend={send}
            busy={busy}
            lastResponse={lastResponse}
            lastDecisions={lastDecisions}
          />
        </section>
        <aside className="fg-col-side">
          <SidePanel project={project} onProject={onProject} />
        </aside>
      </div>
    </div>
  );
}
