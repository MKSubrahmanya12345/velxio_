import { useState } from 'react';
import type { Part } from '../types';
import type { HumanDecision } from '../api';

interface Props {
  parts: Part[];
  busy: boolean;
  onRespond: (payload: { partId?: string | null; decision: HumanDecision; text?: string }) => void;
  onApproveAll: () => void;
}

/**
 * The human checkpoint, in the chat.
 *
 * `awaiting_human` is not a dead end: every part waiting on you gets a card with
 * the open questions and the researched answer, plus four actions —
 *
 *   answer   → saved as human input and folded into the next research pass
 *   approve  → verified, with a `human-eyes` evidence record
 *   re-run   → re-research this part with your input
 *   reject   → recorded, then re-researched
 *
 * All four are deterministic on the server (no LLM call), so this works even
 * when no provider key is configured.
 */
export default function HumanCheckpoint({ parts, busy, onRespond, onApproveAll }: Props) {
  const [openId, setOpenId] = useState<string | null>(parts.length === 1 ? parts[0].id : null);
  const [input, setInput] = useState<Record<string, string>>({});

  if (!parts.length) return null;
  const first = parts[0];

  return (
    <div className="bubble system checkpoint">
      <div className="checkpoint-head">
        <span className="badge awaiting_human">⚠ needs you</span>
        <b>
          {parts.length} part{parts.length === 1 ? '' : 's'} waiting on your eyes
        </b>
        <div className="spacer" />
        {parts.length > 1 && (
          <button className="primary small" onClick={onApproveAll} disabled={busy}>
            ✓ Approve all {parts.length}
          </button>
        )}
      </div>
      <p className="muted small">
        The ladder's top rung is human: solder joints, fit, finish and taste have no machine check. Approve to mark
        verified, answer to correct it, or send it back to be re-researched with your input.
      </p>

      <div className="checkpoint-list">
        {parts.map((p) => {
          const open = openId === p.id;
          const qs = p.openQuestions || [];
          const hasOpenQuestions = qs.length > 0;
          return (
            <div className={`checkpoint-item ${open ? 'open' : ''}`} key={p.id}>
              <button className="checkpoint-row" onClick={() => setOpenId(open ? null : p.id)}>
                <span className="name">{p.name}</span>
                <span className="badge subtle">{p.domain}</span>
                {hasOpenQuestions && <span className="badge awaiting_human">{qs.length} question(s)</span>}
                {p.current?.data?.bomRow && <span className="muted small ellipsis">{p.current.data.bomRow}</span>}
                <span className="caret">{open ? '▾' : '▸'}</span>
              </button>
              {open && (
                <div className="checkpoint-body">
                  {hasOpenQuestions && (
                    <ul className="tight small">
                      {qs.map((q, i) => (
                        <li key={i}>{q}</li>
                      ))}
                    </ul>
                  )}
                  {p.current?.data?.wiring && (
                    <div className="kv small">
                      <b>wiring</b> {p.current.data.wiring}
                    </div>
                  )}
                  {p.current?.data?.bomRow && (
                    <div className="kv small">
                      <b>bom</b> {p.current.data.bomRow}
                    </div>
                  )}
                  {p.humanInput?.length ? (
                    <div className="muted small">you said: {p.humanInput[p.humanInput.length - 1].text}</div>
                  ) : null}
                  <textarea
                    rows={2}
                    placeholder={
                      hasOpenQuestions ? 'Answer the questions above…' : 'Anything to correct or confirm? (optional)'
                    }
                    value={input[p.id] || ''}
                    onChange={(e) => setInput((v) => ({ ...v, [p.id]: e.target.value }))}
                    disabled={busy}
                  />
                  <div className="checkpoint-actions">
                    <button
                      className="primary small"
                      onClick={() => onRespond({ partId: p.id, decision: 'approve', text: input[p.id] || '' })}
                      disabled={busy}
                    >
                      ✓ Approve
                    </button>
                    <button
                      className="ghost small"
                      onClick={() => onRespond({ partId: p.id, decision: 'rerun', text: input[p.id] || '' })}
                      disabled={busy}
                      title="Re-research this part using your answer"
                    >
                      ↻ Answer &amp; re-research
                    </button>
                    <button
                      className="ghost small"
                      onClick={() => onRespond({ partId: p.id, decision: 'provide', text: input[p.id] || '' })}
                      disabled={busy || !(input[p.id] || '').trim()}
                      title="Just save my note, don't re-run anything"
                    >
                      note only
                    </button>
                    <button
                      className="ghost small danger"
                      onClick={() => onRespond({ partId: p.id, decision: 'reject', text: input[p.id] || '' })}
                      disabled={busy}
                      title="This is wrong — record it and re-research"
                    >
                      ✕ Reject &amp; re-run
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {first && (
        <div className="muted small">
          Tip: you can also just type “approve all” or “change the ESC to 50A — re-research it” in the box below.
        </div>
      )}
    </div>
  );
}
