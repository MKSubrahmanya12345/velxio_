import { useMemo } from 'react';
import type { FlowEntry, Health, Part, Project } from '../types';
import type { RunState } from '../lib/useProject';
import { levelOf } from '../lib/events';
import BuildPanel from './BuildPanel';
import EvidencePanel from './EvidencePanel';
import FlowPanel from './FlowPanel';
import DebugPanel from './DebugPanel';

export type InspectorTab = 'build' | 'flow' | 'evidence' | 'debug';

/**
 * The right-hand side: all of the *information*. Chat is for talking; this is
 * where the work is inspected.
 *
 * Four tabs, not eight. The old set was Overview · Parts · Flow · Decisions ·
 * Research · Integration · Debug · Help, and half of them rendered "none yet"
 * on a fresh project — a tab bar where most destinations are empty is not
 * navigation, it is a menu of disappointments. Overview merged into Parts
 * (Build), the three evidence views merged into Evidence, and Help moved to a
 * `?` in the top bar where it can be opened on demand instead of holding a
 * permanent slot.
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

  const tabs: Array<{ id: InspectorTab; label: string; badge?: number | string; tone?: 'bad' | 'warn' }> = [
    { id: 'build', label: 'Build', badge: parts.length || undefined },
    { id: 'flow', label: 'Flow', badge: errorCount || undefined, tone: errorCount ? 'bad' : undefined },
    { id: 'evidence', label: 'Evidence' },
    {
      id: 'debug',
      label: 'Debug',
      badge: health && health.providers === 0 ? '!' : undefined,
      tone: health && health.providers === 0 ? 'warn' : undefined,
    },
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
        {tab === 'build' && (
          <BuildPanel project={project} parts={parts} run={run} busy={busy} onResume={onResume} />
        )}
        {tab === 'flow' && <FlowPanel flow={flow} project={project} health={health} onClear={onClearFlow} />}
        {tab === 'evidence' && <EvidencePanel project={project} />}
        {tab === 'debug' && <DebugPanel project={project} health={health} flow={flow} />}
      </div>
    </section>
  );
}
