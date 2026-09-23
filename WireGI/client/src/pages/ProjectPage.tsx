import { useEffect, useState } from 'react';
import { getProject, resumeProject, sendMessage, research } from '../api';
import type { Project, StreamEvent } from '../types';
import ChatView from '../components/ChatView';
import PartCard from '../components/PartCard';
import DecisionLog from '../components/DecisionLog';
import ResearchLog from '../components/ResearchLog';
import ProviderStrip from '../components/ProviderStrip';
import HowItWorks from '../components/HowItWorks';
import ReconcileLog from '../components/ReconcileLog';

export default function ProjectPage({ projectId, onHome }: { projectId: string; onHome: () => void }) {
  const [project, setProject] = useState<Project | null>(null);
  const [events, setEvents] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [researchQ, setResearchQ] = useState('');
  const [researchOut, setResearchOut] = useState<any>(null);

  const refresh = async () => {
    try {
      setProject(await getProject(projectId));
    } catch {
      /* ignore */
    }
  };
  useEffect(() => {
    refresh();
  }, [projectId]);

  const feed = (e: StreamEvent) => {
    const ev = e as any;
    let msg = '';
    if (ev.type === 'decision') msg = `DECISION ${ev.label}`;
    else if (ev.type === 'research') msg = `RESEARCH ${ev.part}: ${ev.message}`;
    else if (ev.type === 'part') msg = `PART ${ev.part} → ${ev.stage}${ev.error ? `: ${ev.error}` : ''}`;
    else if (ev.type === 'retry') msg = `RETRY ${ev.part} (${ev.attempt}/${ev.retries}) in ${ev.waitMs}ms`;
    else if (ev.type === 'batch') msg = `BATCH ${ev.stage}${ev.note ? ` [${ev.note}]` : ''} ${ev.ok ?? ''}/${ev.total}`;
    else if (ev.type === 'reconcile')
      msg =
        ev.stage === 'done'
          ? `RECONCILE done — ${ev.conflicts ?? 0} conflict(s), ${ev.patchesApplied ?? 0} patch(es)${ev.coherent ? ' · coherent' : ''}`
          : ev.stage === 'skipped'
            ? `RECONCILE skipped — ${ev.reason || ''}`
            : `RECONCILE ${ev.stage}${ev.conflict ? `: [${ev.conflict.severity}] ${(ev.conflict.parts || []).join(' ↔ ')}` : ''}`;
    else if (ev.type === 'done') msg = `DONE ${ev.status}`;
    else if (ev.type === 'error') msg = `ERROR ${ev.error}`;
    if (msg) setEvents((l) => [...l, msg]);
  };

  const act = async (fn: (onEvent: (e: StreamEvent) => void) => Promise<Project>) => {
    if (busy) return;
    setBusy(true);
    try {
      setProject(await fn(feed));
    } catch (err: any) {
      setEvents((l) => [...l, 'ERROR ' + (err?.message || 'failed')]);
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const onSend = () => {
    const t = draft.trim();
    if (!t) return;
    setDraft('');
    act((onEvent) => sendMessage(projectId, t, onEvent));
  };
  const doResearch = async () => {
    const q = researchQ.trim();
    if (!q) return;
    try {
      setResearchOut(await research(q));
    } catch (e: any) {
      setResearchOut({ error: e.message });
    }
  };

  // Gap B: anything failed, pending, mid-flight (stale after a crash), or
  // simply without data yet can be resumed.
  const resumable = (project?.state.parts || []).filter(
    (p) => p.status === 'failed' || p.status === 'pending' || p.status === 'researching' || !p.current?.data,
  );
  const onResume = () => act((onEvent) => resumeProject(projectId, onEvent));

  return (
    <div className="app">
      <div className="topbar">
        <h1>WireGI</h1>
        <span className="status-pill">{project?.status || '…'}</span>
        <div className="spacer" />
        <ProviderStrip />
        <button className="ghost" onClick={onHome}>
          ← Home
        </button>
      </div>
      <div className="three-col">
        {/* Left: chat + live event stream */}
        <div className="col">
          <div className="panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <h3>Communication</h3>
            <div style={{ flex: 1, overflowY: 'auto' }}>{project && <ChatView project={project} />}</div>
            <div className="btn-row">
              <textarea
                rows={2}
                placeholder='Approve, add a constraint, or ask…'
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
            </div>
            <button onClick={onSend} disabled={busy || !draft.trim()}>
              {busy ? 'Working…' : 'Send'}
            </button>
          </div>
          <div className="panel">
            <h3>Live event stream</h3>
            <div className="event-log">{events.join('\n') || '—'}</div>
          </div>
        </div>

        {/* Middle: parts (IDEA → CURRENT → VERIFIED) */}
        <div className="col">
          <div className="panel">
            <h3>Project: {project?.goal}</h3>
            <div className="kv">
              <b>Classification:</b> {project?.state.idea.classification} · <b>Domains:</b>{' '}
              {(project?.state.idea.domains || []).join(', ')}
            </div>
            {project?.profileLabel && (
              <div className="kv">
                <b>Profile:</b> <span className="badge">{project.profileLabel}</span>
                {project?.state.idea?.profile?.ladder?.length ? (
                  <span style={{ color: 'var(--muted)', fontSize: 12 }}>
                    {' '}
                    · {project.state.idea.profile.ladder.join(' → ')}
                  </span>
                ) : null}
              </div>
            )}
            {project?.state.idea?.revisions?.length ? (
              <div className="kv" style={{ color: 'var(--muted)', fontSize: 12 }}>
                IDEA revision {project.state.idea.revisions.length} ·{' '}
                {new Date(project.state.idea.revisions[project.state.idea.revisions.length - 1].at).toLocaleString()}
              </div>
            ) : null}
            {resumable.length > 0 && (
              <div className="resume-bar" style={{ marginTop: 8 }}>
                <button onClick={onResume} disabled={busy}>
                  {busy ? 'Working…' : `Resume ${resumable.length} part(s)`}
                </button>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                  {resumable.filter((p) => p.status === 'failed').length} failed ·{' '}
                  {resumable.filter((p) => p.status !== 'failed').length} incomplete
                </span>
              </div>
            )}
          </div>
          {(project?.state.parts || []).map((p) => (
            <PartCard key={p.id} part={p} />
          ))}
        </div>

        {/* Right: decisions + research log + research tool */}
        <div className="col">
          <ReconcileLog passes={project?.state.reconciliations || []} />
          <DecisionLog decisions={project?.state.decisions || []} />
          <ResearchLog log={project?.state.researchLog || []} />
          <div className="panel">
            <h3>Research tool</h3>
            <div className="research-input">
              <input
                type="text"
                placeholder='web search query'
                value={researchQ}
                onChange={(e) => setResearchQ(e.target.value)}
              />
              <button onClick={doResearch}>Search</button>
            </div>
            {researchOut && (
              <div style={{ marginTop: 8 }}>
                <div className="kv">
                  <b>Engine:</b>{' '}
                  {researchOut.web ? `${researchOut.web.engine} (${researchOut.web.count})` : 'model knowledge'}
                </div>
                <pre className="code">{researchOut.summary}</pre>
              </div>
            )}
          </div>
          <div className="panel">
            <HowItWorks />
          </div>
        </div>
      </div>
    </div>
  );
}
