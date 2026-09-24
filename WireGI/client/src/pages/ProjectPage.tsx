import { useEffect, useState } from 'react';
import type { Health } from '../types';
import { useProject } from '../lib/useProject';
import TopBar from '../components/TopBar';
import ChatPanel from '../components/ChatPanel';
import InspectorPanel, { type InspectorTab } from '../components/InspectorPanel';

/**
 * The workspace: chat on the left, everything else on the right.
 * Chat is the conversation (and the run's live activity); the inspector is the
 * evidence — parts, flow (debugger), decisions, research, integration, env.
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
  const [tab, setTab] = useState<InspectorTab>('parts');
  const [narrowInfo, setNarrowInfo] = useState(false);

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
    </div>
  );
}
