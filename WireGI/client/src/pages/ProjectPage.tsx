import { useEffect, useState } from 'react';
import type { Health } from '../types';
import { useProject } from '../lib/useProject';
import TopBar from '../components/TopBar';
import ChatPanel from '../components/ChatPanel';
import InspectorPanel, { type InspectorTab } from '../components/InspectorPanel';
import ProjectWorkspace from '../components/ProjectWorkspace';
import HowItWorks from '../components/HowItWorks';

export default function ProjectPage({ projectId, health, onHome }: { projectId: string; health: Health | null; onHome: () => void }) {
  const store = useProject(projectId);
  const [tab, setTab] = useState<InspectorTab>('build');
  const [narrowInfo, setNarrowInfo] = useState(false);
  const [help, setHelp] = useState(false);

  useEffect(() => { if (store.run.error) setTab('flow'); }, [store.run.error]);

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
      const part = store.parts.find((p) => p.name.toLowerCase() === needle) || store.parts.find((p) => p.name.toLowerCase().includes(needle));
      if (part) { store.human({ partId: part.id, decision: 'rerun', text: t }); return; }
    }
    store.send(t);
  };

  const resumeLabel = store.failedParts.length ? `Retry ${store.failedParts.length}` : store.pendingParts.length ? `Resume ${store.pendingParts.length}` : undefined;

  return (
    <div className="app">
      <TopBar project={store.project} health={health} onHome={onHome} onToggle={() => setNarrowInfo((v) => !v)} infoOpen={narrowInfo} onRerun={resumeLabel ? store.resume : undefined} rerunLabel={resumeLabel} onHelp={() => setHelp(true)} />
      {store.loadError && <div className="banner bad">Could not load the project: {store.loadError}</div>}
      {health && health.providers === 0 && <div className="banner warn">No LLM provider is configured — add a key to <code>WireGI/server/.env</code>.</div>}
      {store.project?.status === 'failed' && <div className="banner bad">The last run failed. <button className="link" onClick={() => setTab('flow')}>Open flow</button> to inspect it.</div>}

      <div className={`workspace wireup-workspace ${narrowInfo ? 'show-info' : ''}`}>
        <ChatPanel project={store.project} flow={store.flow} run={store.run} parts={store.parts} busy={store.busy} checkpointParts={store.checkpointParts} failedParts={store.failedParts} pendingParts={store.pendingParts} onSend={onSend} onResume={store.resume} onCancel={store.cancel} onOpenFlow={() => setTab('flow')} onRespond={store.human} />
        <ProjectWorkspace project={store.project} parts={store.parts} flow={store.flow} run={store.run} busy={store.busy} />
        <InspectorPanel tab={tab} setTab={setTab} project={store.project} parts={store.parts} run={store.run} flow={store.flow} health={health} busy={store.busy} onResume={store.resume} onClearFlow={store.clearFlow} />
      </div>

      {help && <div className="help-overlay" onClick={() => setHelp(false)}><div className="help-card" onClick={(e) => e.stopPropagation()}><div className="row"><h3 style={{ margin: 0 }}>How Wireup works</h3><div className="spacer" /><button className="ghost tiny" onClick={() => setHelp(false)}>✕</button></div><HowItWorks /><p className="muted small">Flow is the execution trace. Debug contains provider and runtime diagnostics.</p></div></div>}
    </div>
  );
}
