import { useEffect, useState } from 'react';
import type { Health } from '../types';
import { useProject } from '../lib/useProject';
import TopBar from '../components/TopBar';
import ChatPanel from '../components/ChatPanel';
import InspectorPanel, { type InspectorTab } from '../components/InspectorPanel';
import HowItWorks from '../components/HowItWorks';

/**
 * The workspace: chat on the left, everything else on the right.
 *
 * Chat is the conversation and the run's live activity; the inspector is the
 * evidence — Build (goal, where it stands, every part), Flow (the full trace,
 * which doubles as the debugger), Evidence (do the parts agree, what was
 * decided, which sources) and Debug (keys, env, a live provider test).
 */
export default function ProjectPage({
  projectId,
  health,
  onHome,
}: {
  projectId: string;
  health: Health | null;
  onHome: () => void;
}) {
  const store = useProject(projectId);
  const [tab, setTab] = useState<InspectorTab>('build');
  const [narrowInfo, setNarrowInfo] = useState(false);
  // Help used to own a permanent tab. It is reference material you read once,
  // so it lives behind `?` and gets out of the way.
  const [help, setHelp] = useState(false);

  // Jump to the flow panel when a run fails — that is where the answer is.
  useEffect(() => {
    if (store.run.error) setTab('flow');
  }, [store.run.error]);

  /**
   * Typed shortcuts for the checkpoint. "approve all" and "re-research the ESC"
   * are unambiguous, so they go down the deterministic checkpoint path instead
   * of being guessed by a model — free, instant, and works with no provider.
   */
  const onSend = (text: string) => {
    const t = text.trim();
    const lower = t.toLowerCase();
    if (store.checkpointParts.length && /^(approve|approved|approve all|approve everything|all good|looks good|verified?|ok)$/.test(lower)) {
      store.human({ decision: 'approve', text: '' });
      return;
    }
    const m = t.match(/^(?:re-?run|redo|re-?research)\s+(.+)$/i);
    if (m) {
      const needle = m[1].trim().toLowerCase();
      const part =
        store.parts.find((p) => p.name.toLowerCase() === needle) ||
        store.parts.find((p) => p.name.toLowerCase().includes(needle));
      if (part) {
        store.human({ partId: part.id, decision: 'rerun', text: t });
        return;
      }
    }
    store.send(t);
  };

  const resumeLabel = store.failedParts.length
    ? `Retry ${store.failedParts.length}`
    : store.pendingParts.length
      ? `Resume ${store.pendingParts.length}`
      : undefined;

  return (
    <div className="app">
      <TopBar
        project={store.project}
        health={health}
        onHome={onHome}
        onToggle={() => setNarrowInfo((v) => !v)}
        infoOpen={narrowInfo}
        onRerun={resumeLabel ? store.resume : undefined}
        rerunLabel={resumeLabel}
        onHelp={() => setHelp(true)}
      />

      {store.loadError && <div className="banner bad">Could not load the project: {store.loadError}</div>}
      {health && health.providers === 0 && (
        <div className="banner warn">
          No LLM provider is configured — runs will fail at their first call. Add a key to{' '}
          <code>WireGI/server/.env</code> and restart, then use <b>Debug → Test LLM now</b>.
        </div>
      )}
      {store.project?.status === 'failed' && (
        <div className="banner bad">
          The last run failed.{' '}
          <button className="link" onClick={() => setTab('flow')}>
            Open the flow
          </button>{' '}
          to see exactly where.
        </div>
      )}

      <div className={`workspace ${narrowInfo ? 'show-info' : ''}`}>
        <ChatPanel
          project={store.project}
          flow={store.flow}
          run={store.run}
          parts={store.parts}
          busy={store.busy}
          checkpointParts={store.checkpointParts}
          failedParts={store.failedParts}
          pendingParts={store.pendingParts}
          onSend={onSend}
          onResume={store.resume}
          onCancel={store.cancel}
          onOpenFlow={() => setTab('flow')}
          onRespond={store.human}
        />
        <InspectorPanel
          tab={tab}
          setTab={setTab}
          project={store.project}
          parts={store.parts}
          run={store.run}
          flow={store.flow}
          health={health}
          busy={store.busy}
          onResume={store.resume}
          onClearFlow={store.clearFlow}
        />
      </div>

      {help && (
        <div className="help-overlay" onClick={() => setHelp(false)}>
          <div className="help-card" onClick={(e) => e.stopPropagation()}>
            <div className="row">
              <h3 style={{ margin: 0 }}>How WireGI works</h3>
              <div className="spacer" />
              <button className="ghost tiny" onClick={() => setHelp(false)}>
                ✕
              </button>
            </div>
            <HowItWorks />
            <p className="muted small">
              Stuck on a run? The <b>Flow</b> tab is the full trace, and <b>Debug</b> shows which keys are configured
              and can fire a live provider test.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
