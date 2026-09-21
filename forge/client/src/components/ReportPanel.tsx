import { useState } from 'react';
import type { Decision, Project, ResponsePayload } from '../types';
import { ConfidenceMeter } from './ConfidenceMeter';

const CHIPS: { chip: string; label: string }[] = [
  { chip: 'done', label: '✅ Done' },
  { chip: 'failed', label: '✗ It failed' },
  { chip: 'substitute', label: '⇄ I have X, not Y' },
  { chip: 'question', label: '? Question' },
  { chip: 'claim_done', label: '🏁 I think it’s done' },
];

export function ReportPanel({
  project, onSend, busy, lastResponse, lastDecisions,
}: {
  project: Project;
  onSend: (text: string, chip?: string) => void;
  busy: boolean;
  lastResponse: ResponsePayload | null;
  lastDecisions: Decision[];
}) {
  const [text, setText] = useState('');
  const [pendingChip, setPendingChip] = useState<string | null>(null);
  const st = project.state;

  const send = () => {
    if (busy) return;
    onSend(text.trim(), pendingChip || undefined);
    setText('');
    setPendingChip(null);
  };

  return (
    <section className="fg-card fg-report">
      {lastResponse && (
        <div className={lastResponse.safety ? 'fg-response fg-response-safety' : 'fg-response'}>
          <div className="fg-response-head">
            <span className="fg-avatar" aria-hidden>⚒</span>
            <span className="fg-speaker">Forge</span>
          </div>
          <div className="fg-response-text">{lastResponse.text}</div>
          {lastResponse.suggestions?.length ? (
            <div className="fg-suggestions">
              {lastResponse.suggestions.map((s, i) => (
                <span key={i} className="fg-suggestion">{s}</span>
              ))}
            </div>
          ) : null}
        </div>
      )}

      {st.proposal && (
        <div className="fg-proposal">
          <div className="fg-proposal-title">Proposal</div>
          <div className="fg-proposal-text">
            {st.proposal.type === 'substitute'
              ? `Use "${st.proposal.item?.name}" in place of "${st.proposal.need}" — ${
                  (st.proposal.compatibility ?? 0) >= 2 ? 'drop-in equivalent' : 'works with changes'
                }.`
              : st.proposal.text}
          </div>
          {st.proposal.confidence !== undefined && (
            <ConfidenceMeter value={st.proposal.confidence} label="confidence" />
          )}
          <div className="fg-row fg-row-tight">
            <button className="fg-btn fg-btn-primary" disabled={busy} onClick={() => onSend('', 'accept_proposal')}>
              Accept
            </button>
            <button className="fg-btn fg-btn-secondary" disabled={busy} onClick={() => onSend('', 'decline_proposal')}>
              Decline
            </button>
          </div>
        </div>
      )}

      <div className="fg-chips">
        {CHIPS.map((c) => (
          <button
            key={c.chip}
            type="button"
            className={pendingChip === c.chip ? 'fg-chip fg-chip-active' : 'fg-chip'}
            disabled={busy}
            onClick={() => setPendingChip(c.chip)}
          >
            {c.label}
          </button>
        ))}
      </div>

      <div className="fg-row fg-report-row">
        <textarea
          className="fg-input fg-textarea"
          rows={2}
          placeholder="Report back — what happened? (a chip plus a short sentence works best)"
          value={text}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send();
          }}
        />
        <button className="fg-btn fg-btn-primary" onClick={send} disabled={busy || (!text.trim() && !pendingChip)}>
          {busy ? '…' : 'Send'}
        </button>
      </div>

      <footer className="fg-report-foot">
        {lastDecisions.length > 0 ? (
          <div className="fg-decisions">
            {lastDecisions.map((d, i) => (
              <span key={i} className="fg-decision" title={d.summary}>
                <span className="fg-dec-id">{d.id}</span>
                <span className={`fg-dec-${d.confidence >= 0.85 ? 'high' : d.confidence >= 0.6 ? 'med' : 'low'}`}>
                  {d.summary}
                </span>
              </span>
            ))}
          </div>
        ) : (
          <span className="fg-muted">Jev decisions from your last message appear here.</span>
        )}
      </footer>
    </section>
  );
}
