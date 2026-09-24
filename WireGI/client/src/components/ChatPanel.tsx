import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChatMsg, FlowEntry, Part, Project } from '../types';
import { Markdown } from '../lib/markdown';
import { levelOf, titleOf, detailOf, formatClock, isActivity } from '../lib/events';
import type { RunState } from '../lib/useProject';
import type { HumanDecision } from '../api';
import HumanCheckpoint from './HumanCheckpoint';

interface Props {
  project: Project | null;
  flow: FlowEntry[];
  run: RunState;
  parts: Part[];
  busy: boolean;
  /** parts that still need a human decision — drives the checkpoint card */
  checkpointParts: Part[];
  failedParts: Part[];
  pendingParts: Part[];
  onSend: (text: string) => void;
  onResume: () => void;
  onCancel: () => void;
  onOpenFlow: () => void;
  onRespond: (payload: { partId?: string | null; decision: HumanDecision; text?: string }) => void;
}

const SUGGESTIONS = [
  'make me a drone',
  'design a weather station with an ESP32',
  'build a 3D-printed camera gimbal',
  'plan a home server rack',
];

export default function ChatPanel({
  project,
  flow,
  run,
  parts,
  busy,
  checkpointParts,
  failedParts,
  pendingParts,
  onSend,
  onResume,
  onCancel,
  onOpenFlow,
  onRespond,
}: Props) {
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  const messages: ChatMsg[] = project?.state.chat || [];
  const activity = useMemo(() => flow.filter(isActivity).slice(-6), [flow]);
  const progress = run.total ? Math.min(1, (run.done + run.failed) / run.total) : 0;

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, activity.length, run.running]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const submit = () => {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft('');
    stickRef.current = true;
    onSend(text);
  };

  return (
    <section className="chat-panel">
      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
        {!project && (
          <div className="empty-chat">
            <h2>What do you want to build?</h2>
            <p>
              Describe it in one line. WireGI decomposes it into parts, researches each one, and streams every
              decision and finding here — the full trace is on the right.
            </p>
            <div className="chips">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="chip" onClick={() => setDraft(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <div key={`${m.role}-${i}-${m.ts || ''}`} className={`bubble ${m.role}`}>
            <div className="bubble-role">{m.role === 'user' ? 'You' : m.role === 'agent' ? 'WireGI' : 'system'}</div>
            {m.role === 'agent' ? <Markdown text={m.content} /> : <p className="plain">{m.content}</p>}
            {m.ts && <time>{new Date(m.ts).toLocaleTimeString()}</time>}
          </div>
        ))}

        {(run.running || busy) && (
          <div className="bubble agent working">
            <div className="bubble-role">
              <span className="spinner" /> WireGI is working
              {run.currentPhase ? ` — ${run.currentPhase}` : ''}
            </div>
            {run.total > 0 && (
              <>
                <div className="progress">
                  <span style={{ width: `${progress * 100}%` }} />
                </div>
                <div className="muted small">
                  {run.done} done · {run.failed} failed · {run.total} part(s)
                </div>
              </>
            )}
            <ul className="activity">
              {activity.map((ev, i) => (
                <li key={`${ev.seq ?? i}`} className={`lvl-${levelOf(ev)}`}>
                  <span className="t">{formatClock(ev)}</span>
                  <span className="title">{titleOf(ev)}</span>
                  {detailOf(ev) && <span className="detail">{detailOf(ev)}</span>}
                </li>
              ))}
              {!activity.length && <li className="muted">starting…</li>}
            </ul>
            <div className="row">
              <button className="ghost small" onClick={onOpenFlow}>
                open flow
              </button>
              <button className="ghost small" onClick={onCancel}>
                cancel
              </button>
            </div>
          </div>
        )}

        {!run.running && run.error && (
          <div className="bubble agent error">
            <div className="bubble-role">⚠ Run failed</div>
            <p className="plain">
              <b>{run.error.name || 'Error'}</b>: {run.error.message || 'no message'}
              {run.error.where ? ` — at ${run.error.where}` : ''}
            </p>
            <div className="row">
              <button className="ghost small" onClick={onOpenFlow}>
                see the flow
              </button>
            </div>
          </div>
        )}

        {!run.running && failedParts.length > 0 && (
          <div className="bubble system action">
            <span>
              {failedParts.length} part(s) failed: {failedParts.map((p) => p.name).join(', ')}
            </span>
            <button className="primary small" onClick={onResume} disabled={busy}>
              Retry failed parts
            </button>
          </div>
        )}

        {!run.running && checkpointParts.length > 0 && (
          <HumanCheckpoint
            parts={checkpointParts}
            busy={busy}
            onRespond={onRespond}
            onApproveAll={() => onRespond({ decision: 'approve', text: '' })}
          />
        )}

        {!run.running && failedParts.length === 0 && pendingParts.length > 0 && (
          <div className="bubble system action">
            <span>{pendingParts.length} part(s) still have no data.</span>
            <button className="ghost small" onClick={onResume} disabled={busy}>
              Resume
            </button>
          </div>
        )}
      </div>

      <div className="composer">
        <textarea
          rows={2}
          value={draft}
          placeholder={
            project
              ? 'Approve, add a constraint, ask a question… (Enter to send, Shift+Enter for a new line)'
              : 'Describe the build… (Enter to send)'
          }
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          disabled={busy}
        />
        <div className="composer-row">
          {project && (
            <div className="quick">
              <button className="chip" onClick={() => onSend('approve all')} disabled={busy}>
                approve all
              </button>
              <button className="chip" onClick={() => onSend('add constraint: budget under $400')} disabled={busy}>
                + budget
              </button>
              <button className="chip" onClick={() => onSend('what is still missing?')} disabled={busy}>
                what's missing?
              </button>
            </div>
          )}
          <div className="spacer" />
          <button className="primary" onClick={submit} disabled={busy || !draft.trim()}>
            {busy ? 'working…' : 'Send'}
          </button>
        </div>
      </div>
    </section>
  );
}
