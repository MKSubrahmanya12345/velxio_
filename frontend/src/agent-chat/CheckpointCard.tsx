import { useState } from 'react';
import type { HumanDecision, Part } from './types';

interface Props {
  parts: Part[];
  busy: boolean;
  onRespond: (payload: { partId?: string | null; decision: HumanDecision; text?: string }) => void;
  onApproveAll: () => void;
}

/**
 * "Needs your eyes" — the human checkpoint, rendered as a chat card.
 * Same four deterministic actions as the desktop app: approve, answer &
 * re-research, note only, reject & re-run.
 */
export default function CheckpointCard({ parts, busy, onRespond, onApproveAll }: Props) {
  const [openId, setOpenId] = useState<string | null>(parts.length === 1 ? parts[0].id : null);
  const [input, setInput] = useState<Record<string, string>>({});

  if (!parts.length) return null;
  // needsInput parts can only be ANSWERED, never approved — the agent won't
  // ask a human to verify data it flagged as insufficient itself.
  const needsEyes = parts.filter((p) => !p.needsInput);
  const needsAnswers = parts.filter((p) => p.needsInput);

  return (
    <div className="ck-card">
      <div className="ck-head">
        <span className="ck-eyes-badge">needs you</span>
        <div className="ck-tally">
          {needsEyes.length > 0 && `${needsEyes.length} for your eyes`}
          {needsEyes.length > 0 && needsAnswers.length > 0 && ' · '}
          {needsAnswers.length > 0 && `${needsAnswers.length} for your answer`}
        </div>
      </div>

      <div className="ck-list">
        {parts.map((p) => {
          const open = openId === p.id;
          const qs = p.openQuestions || [];
          const value = input[p.id] || '';
          return (
            <div key={p.id} className={`ck-item${open ? ' ck-item--open' : ''}`}>
              <button className="ck-row" onClick={() => setOpenId(open ? null : p.id)}>
                <span className="ck-name">{p.name}</span>
                <span className="ck-tag">{p.domain}</span>
                {p.needsInput && <span className="ck-tag ck-tag--warn">your answer</span>}
                {qs.length > 0 && <span className="ck-tag ck-tag--warn">{qs.length} question{qs.length === 1 ? '' : 's'}</span>}
                <Chevron up={open} />
              </button>

              {open && (
                <div className="ck-body">
                  {qs.length > 0 && (
                    <ul className="ck-questions">
                      {qs.map((q, i) => (
                        <li key={i}>{q}</li>
                      ))}
                    </ul>
                  )}
                  {p.current?.data?.wiring && (
                    <div className="ck-kv">
                      <b>wiring</b> {p.current.data.wiring}
                    </div>
                  )}
                  {p.current?.data?.bomRow && (
                    <div className="ck-kv">
                      <b>bom</b> {p.current.data.bomRow}
                    </div>
                  )}
                  {p.humanInput?.length ? (
                    <div className="ck-kv ck-kv--note">you: {p.humanInput[p.humanInput.length - 1].text}</div>
                  ) : null}

                  <textarea
                    rows={2}
                    placeholder={qs.length ? 'Answer the questions above…' : 'Anything to correct or confirm? (optional)'}
                    value={value}
                    onChange={(e) => setInput((v) => ({ ...v, [p.id]: e.target.value }))}
                    disabled={busy}
                  />

                  <div className="ck-actions">
                    {p.needsInput ? (
                      <>
                        <button
                          className="ck-btn ck-btn--primary"
                          onClick={() => onRespond({ partId: p.id, decision: 'provide', text: value || '' })}
                          disabled={busy || !value.trim()}
                        >
                          Answer &amp; continue
                        </button>
                        <button
                          className="ck-btn ck-btn--danger"
                          onClick={() => onRespond({ partId: p.id, decision: 'reject', text: value || '' })}
                          disabled={busy}
                        >
                          Reject &amp; re-run
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          className="ck-btn ck-btn--primary"
                          onClick={() => onRespond({ partId: p.id, decision: 'approve', text: value || '' })}
                          disabled={busy}
                        >
                          Approve
                        </button>
                        <button
                          className="ck-btn"
                          onClick={() => onRespond({ partId: p.id, decision: 'rerun', text: value || '' })}
                          disabled={busy}
                        >
                          Answer &amp; re-research
                        </button>
                        <button
                          className="ck-btn"
                          onClick={() => onRespond({ partId: p.id, decision: 'provide', text: value || '' })}
                          disabled={busy || !value.trim()}
                        >
                          Note only
                        </button>
                        <button
                          className="ck-btn ck-btn--danger"
                          onClick={() => onRespond({ partId: p.id, decision: 'reject', text: value || '' })}
                          disabled={busy}
                        >
                          Reject &amp; re-run
                        </button>
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {needsEyes.length > 1 && (
        <button className="ck-approve-all" onClick={onApproveAll} disabled={busy}>
          Approve all {needsEyes.length}
        </button>
      )}
    </div>
  );
}

function Chevron({ up }: { up: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      style={{ transform: up ? 'rotate(180deg)' : undefined, marginLeft: 'auto', flex: 'none' }}
      aria-hidden="true"
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}