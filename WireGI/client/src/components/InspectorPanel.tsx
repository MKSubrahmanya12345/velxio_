import { useMemo } from 'react';
import type { FlowEntry, Health, Part, Project } from '../types';
import type { RunState } from '../lib/useProject';
import { levelOf } from '../lib/events';
import OverviewPanel from './OverviewPanel';
import PartCard from './PartCard';
import FlowPanel from './FlowPanel';
import DecisionLog from './DecisionLog';
import ResearchLog from './ResearchLog';
import ReconcileLog from './ReconcileLog';
import DebugPanel from './DebugPanel';
import HowItWorks from './HowItWorks';

export type InspectorTab =
  | 'overview'
  | 'parts'
  | 'flow'
  | 'decisions'
  | 'research'
  | 'integration'
  | 'debug'
  | 'help';

/**
 * The right-hand side: all of the *information*. Chat is for talking; this is
 * where the work is inspected — parts, the live flow (the debugger), decisions,
 * research, integration, and the environment.
 */
export default function InspectorPanel({
  tab,
  setTab,
  project,
  parts,
  run,
  flow,
  health,
  busy,
  onResume,
  onClearFlow,
}: {
  tab: InspectorTab;
  setTab: (t: InspectorTab) => void;
  project: Project | null;
  parts: Part[];
  run: RunState;
  flow: FlowEntry[];
  health: Health | null;
  busy: boolean;
  onResume: () => void;
  onClearFlow: () => void;
}) {
  const errorCount = useMemo(() => flow.filter((e) => levelOf(e) === 'error').length, [flow]);
  const failed = parts.filter((p) => p.status === 'failed');
  const needsEyes = parts.filter((p) => p.humanCheckpoint && !p.verified);
  const decisions = project?.state.decisions || [];
  const researchLog = project?.state.researchLog || [];
  const reconciliations = project?.state.reconciliations || [];

  const tabs: Array<{ id: InspectorTab; label: string; badge?: number | string; tone?: 'bad' | 'warn' }> = [
    { id: 'overview', label: 'Overview' },
    { id: 'parts', label: 'Parts', badge: parts.length || undefined },
    { id: 'flow', label: 'Flow', badge: errorCount || flow.length || undefined, tone: errorCount ? 'bad' : undefined },
    { id: 'decisions', label: 'Decisions', badge: decisions.length || undefined },
    { id: 'research', label: 'Research', badge: researchLog.length || undefined },
    { id: 'integration', label: 'Integration', badge: reconciliations.filter((r) => !r.skipped).length || undefined },
    {
      id: 'debug',
      label: 'Debug',
      badge: health && health.providers === 0 ? '!' : undefined,
      tone: health && health.providers === 0 ? 'warn' : undefined,
    },
    { id: 'help', label: 'Help' },
  ];

  return (
    <section className="inspector">
      <nav className="tabs">
        {tabs.map((t) => (
          <button
            key={t.id}
            className={`tab ${tab === t.id ? 'active' : ''} ${t.tone ? `tone-${t.tone}` : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {t.badge !== undefined && <span className={`tab-badge ${t.tone || ''}`}>{t.badge}</span>}
          </button>
        ))}
      </nav>

      <div className="inspector-body">
        {tab === 'overview' && <OverviewPanel project={project} parts={parts} run={run} />}

        {tab === 'parts' && (
          <>
            <div className="panel sticky-head">
              <div className="row">
                <span className="muted small">
                  {parts.length} part(s) · {parts.filter((p) => p.verified).length} verified ·{' '}
                  {needsEyes.length} need eyes · {failed.length} failed
                </span>
                <div className="spacer" />
                <button className="ghost small" onClick={onResume} disabled={busy || !project}>
                  ↻ Resume / retry
                </button>
              </div>
            </div>
            {!parts.length && <div className="muted pad">No parts yet — send a build request in the chat.</div>}
            {parts.map((p) => (
              <PartCard key={p.id} part={p} defaultOpen={p.status === 'failed'} />
            ))}
          </>
        )}

        {tab === 'flow' && <FlowPanel flow={flow} project={project} health={health} onClear={onClearFlow} />}
        {tab === 'decisions' && <DecisionLog decisions={decisions} />}
        {tab === 'research' && <ResearchLog log={researchLog} />}
        {tab === 'integration' && <ReconcileLog passes={reconciliations} />}
        {tab === 'debug' && <DebugPanel project={project} health={health} flow={flow} />}
        {tab === 'help' && <HowItWorks />}
      </div>
    </section>
  );
}
