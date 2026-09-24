import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMsg, FlowEntry, Project } from './types';
import { checkpointPartsOf, statusLabel } from './types';
import { getProject, respondHuman, sendMessage } from './api';
import type { HumanDecision } from './types';
import { Markdown } from './markdown';
import Avatar from './Avatar';
import CheckpointCard from './CheckpointCard';
import { timeOf } from './ChatsList';

const POLL_MS = 4000;

interface RunErr {
  name: string;
  message: string;
  where?: string;
}

function sigOf(p: Project): string {
  return `${p.status}|${p.updatedAt}|${p.state.chat.length}|${p.state.parts.length}`;
}

function dayLabel(d: Date): string {
  const now = new Date();
  const yest = new Date(now.getTime() - 86400000);
  if (d.toDateString() === now.toDateString()) return 'Today';
  if (d.toDateString() === yest.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { day: 'numeric', month: 'long', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
}

export default function Thread({
  projectId,
  onBack,
}: {
  projectId: string;
  onBack: () => void;
}) {
  const [project, setProject] = useState<Project | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [runErr, setRunErr] = useState<RunErr | null>(null);
  const [live, setLive] = useState<FlowEntry[]>([]);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);
  const lastRef = useRef<Project | null>(null);

  const apply = useCallback((p: Project) => {
    if (!lastRef.current || sigOf(lastRef.current) !== sigOf(p)) {
      lastRef.current = p;
      setProject(p);
    } else {
      lastRef.current = p;
    }
  }, []);

  const load = useCallback(async () => {
    try {
      apply(await getProject(projectId));
      setLoadErr('');
    } catch (e) {
      setLoadErr((e as { message?: string })?.message || String(e));
    }
  }, [projectId, apply]);

  useEffect(() => {
    lastRef.current = null;
    setProject(null);
    setRunErr(null);
    setLive([]);
    void load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [projectId, load]);

  useEffect(() => () => abortRef.current?.abort(), []);

  // Drop the optimistic bubble once the server's copy of the chat contains it.
  useEffect(() => {
    if (pending && project) {
      const found = project.state.chat.some((m) => m.role === 'user' && m.content.trim() === pending.trim());
      if (found) setPending(null);
    }
  }, [project, pending]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [project?.state.chat.length, live.length, pending, busy]);

  const startStream = () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setBusy(true);
    setRunErr(null);
    setLive([]);
    return ctrl;
  };

  const finishStream = (p: Project, ctrl: AbortController) => {
    if (abortRef.current === ctrl) {
      apply(p);
      setBusy(false);
      setLive([]);
    }
  };

  const failStream = (e: unknown, ctrl: AbortController) => {
    if (abortRef.current !== ctrl) return;
    setBusy(false);
    setLive([]);
    setPending(null);
    const err = e as { message?: string };
    setRunErr({ name: (e as { name?: string })?.name || 'Error', message: err?.message || String(e) });
    void load();
  };

  const fire = (text: string) => {
    const t = text.trim();
    if (!t || busy) return;
    setDraft('');
    setPending(t);
    stickRef.current = true;
    const ctrl = startStream();
    sendMessage(projectId, t, (ev) => {
      if (abortRef.current === ctrl) setLive((l) => [...l.slice(-4), ev]);
    }, ctrl.signal)
      .then((p) => {
        if (abortRef.current === ctrl) {
          apply(p);
          setBusy(false);
          setLive([]);
          setPending(null);
        }
      })
      .catch((e) => failStream(e, ctrl));
  };

  const submit = () => fire(draft);

  const onRespond = (payload: { partId?: string | null; decision: HumanDecision; text?: string }) => {
    if (busy) return;
    const ctrl = startStream();
    respondHuman(
      projectId,
      { partId: payload.partId ?? null, decision: payload.decision, text: payload.text || '' },
      (ev) => {
        if (abortRef.current === ctrl) setLive((l) => [...l.slice(-4), ev]);
      },
      ctrl.signal,
    )
      .then((p) => finishStream(p, ctrl))
      .catch((e) => failStream(e, ctrl));
  };

  const messages: ChatMsg[] = project?.state.chat || [];
  const checkpointParts = checkpointPartsOf(project);
  const needsYou = checkpointParts.length;
  const researching = project?.status === 'researching' || busy;

  // Insert day dividers between messages that fall on different dates.
  const rendered: React.ReactNode[] = [];
  let prevDay = '';
  messages.forEach((m, i) => {
    const day = dayLabel(m.ts ? new Date(m.ts) : new Date());
    if (day !== prevDay) {
      rendered.push(
        <div className="day-chip" key={`day-${i}`}>
          {day}
        </div>,
      );
      prevDay = day;
    }
    rendered.push(<Bubble m={m} key={i} />);
  });

  const activity = live.slice(-4);

  return (
    <div className="thread">
      <header className="wa-header thread-header">
        <button className="icon-btn" onClick={onBack} aria-label="Back">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <Avatar name={project?.goal || '…'} status={project?.status} size={36} />
        <div className="thread-head-body">
          <div className="thread-head-title">{project?.goal || '…'}</div>
          <div className={`thread-head-sub${needsYou > 0 ? ' sub--need' : ''}`}>
            {needsYou > 0
              ? `needs your eyes · ${needsYou} part${needsYou === 1 ? '' : 's'}`
              : project
                ? statusLabel(project.status)
                : loadErr || '…'}
          </div>
        </div>
        <button className="icon-btn" onClick={() => void load()} aria-label="Refresh" title="Refresh">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" />
          </svg>
        </button>
      </header>

      <div className="chat-body" ref={scrollRef} onScroll={onScroll}>
        {loadErr && !project && (
          <div className="centered-err">
            <p>Couldn't load this build.</p>
            <p className="muted">{loadErr}</p>
            <button className="ck-btn" onClick={() => void load()}>
              Try again
            </button>
          </div>
        )}

        {rendered}

        {pending && (
          <div className="bubble bubble--mine bubble--pending">
            <div className="plain">{pending}</div>
            <span className="bubble-meta">
              sending…
            </span>
          </div>
        )}

        {(researching || busy) && (
          <div className="bubble bubble--them bubble--working">
            <span className="spinner" /> {project?.status === 'researching' ? 'WireGI is working' : 'processing your reply…'}
            {activity.length > 0 && (
              <ul className="activity">
                {activity.map((ev, i) => (
                  <li key={i}>
                    <span className="activity-dot" /> {ev.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {runErr && !busy && (
          <div className="bubble bubble--them bubble--err">
            <b>{runErr.name}:</b> {runErr.message}
            {runErr.where ? ` — at ${runErr.where}` : ''}
          </div>
        )}

        {!busy && checkpointParts.length > 0 && (
          <CheckpointCard
            parts={checkpointParts}
            busy={busy}
            onRespond={onRespond}
            onApproveAll={() => onRespond({ decision: 'approve', text: '' })}
          />
        )}
      </div>

      <div className="composer">
        <div className="quick-chips">
          <button className="chip" onClick={() => fire('approve all')} disabled={busy}>
            approve all
          </button>
          <button className="chip" onClick={() => fire("what's still missing?")} disabled={busy}>
            what's missing?
          </button>
        </div>
        <div className="composer-row">
          <textarea
            rows={1}
            placeholder="Message WireGI…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            disabled={busy}
          />
          <button className="send-btn" onClick={submit} disabled={busy || !draft.trim()} aria-label="Send">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M3.4 20.4l17.45-7.48a1 1 0 0 0 0-1.84L3.4 3.6a.993.993 0 0 0-1.39.91L2 9.12c0 .5.37.93.87.99L17 12 2.87 13.88c-.5.07-.87.5-.87 1l.01 4.61c0 .71.73 1.2 1.39.91z" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

function Bubble({ m }: { m: ChatMsg }) {
  if (m.role === 'system') {
    return (
      <div className="sys-chip">
        {m.content}
        {m.ts ? <span className="sys-chip-time">{timeOf(m.ts)}</span> : null}
      </div>
    );
  }
  const mine = m.role === 'user';
  return (
    <div className={`bubble ${mine ? 'bubble--mine' : 'bubble--them'}`}>
      {mine ? <p className="plain">{m.content}</p> : <Markdown text={m.content} />}
      {m.ts && <span className="bubble-meta">{mine ? '✓ ' : ''}{timeOf(m.ts)}</span>}
    </div>
  );
}