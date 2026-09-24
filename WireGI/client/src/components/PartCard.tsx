import { useState } from 'react';
import type { Part } from '../types';
import { stackLines } from '../lib/events';

const STATUS_LABEL: Record<string, string> = {
  pending: 'pending',
  researching: 'researching…',
  data_ready: 'researched',
  awaiting_human: 'needs your eyes',
  verified: 'verified',
  failed: 'failed',
};

/**
 * One part, from IDEA to VERIFIED: live status, which tier the gate chose, who
 * answered, how long it took, the research output, the evidence ladder — and,
 * when it failed, the actual error (name + message + where + stack), not a blank.
 */
export default function PartCard({ part, defaultOpen }: { part: Part; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(Boolean(defaultOpen));
  const d = part.current?.data;
  const err = part.errorDetail;
  const live = part.live;

  return (
    <article className={`part-card status-${part.status}`}>
      <button className="part-head" onClick={() => setOpen((o) => !o)}>
        <span className="name">{part.name}</span>
        <span className="badge subtle">{part.domain}</span>
        <span className={`badge ${part.status}`}>{STATUS_LABEL[part.status] || part.status}</span>
        {part.tier && <span className={`badge tier-${part.tier}`}>tier {part.tier}</span>}
        {part.humanCheckpoint && !part.verified && <span className="badge awaiting_human">⚠ eyes</span>}
        {part.verified && <span className="badge verified">✓ human</span>}
        {part.attempts && part.attempts > 1 ? <span className="badge">try {part.attempts}</span> : null}
        {live && <span className="badge live">live</span>}
        <span className="spacer" />
        {part.meta?.provider && (
          <span className="muted small">
            {part.meta.provider}
            {part.meta.latencyMs ? ` · ${part.meta.latencyMs}ms` : ''}
          </span>
        )}
        <span className="caret">{open ? '▾' : '▸'}</span>
      </button>

      {part.status === 'failed' && (
        <div className="err-block">
          <div className="err-line">
            <b>✖ {err?.name || 'Failed'}</b>: {err?.message || part.error || 'no message'}
            {err?.where ? ` · at ${err.where}` : ''}
            {err?.status ? ` · HTTP ${err.status}` : ''}
          </div>
          {err?.attempts?.length ? (
            <details>
              <summary className="muted small">{err.attempts.length} provider attempt(s)</summary>
              <table className="attempts">
                <tbody>
                  {err.attempts.map((a, i) => (
                    <tr key={i}>
                      <td>{a.provider}</td>
                      <td>{a.model}</td>
                      <td>{a.status ?? '—'}</td>
                      <td className="ellipsis" title={a.message}>
                        {a.message}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          ) : null}
          <div className="muted small">Siblings kept going — use “Retry failed parts” in the chat to re-run this one.</div>
        </div>
      )}

      {(part.status === 'researching' || (!open && part.status === 'pending')) && (
        <div className="part-progress">
          <div className="progress indeterminate">
            <span />
          </div>
          <span className="muted small">
            {part.triageReason ? `gate: ${part.triageReason}` : 'waiting for its turn…'}
          </span>
        </div>
      )}

      {open && (
        <div className="part-body">
          {part.triageReason && (
            <div className="kv">
              <b>gate</b> {part.triageReason}
            </div>
          )}
          {part.meta && (
            <div className="kv muted small">
              {part.meta.provider ? `${part.meta.provider}${part.meta.model ? `/${part.meta.model}` : ''}` : 'no model'}
              {part.meta.webEngine ? ` · web: ${part.meta.webEngine}` : ''}
              {part.meta.llmMs ? ` · llm ${part.meta.llmMs}ms` : ''}
              {part.meta.totalMs ? ` · total ${part.meta.totalMs}ms` : ''}
              {part.attempts ? ` · attempts ${part.attempts}` : ''}
            </div>
          )}
          {part.current?.gathered?.length ? (
            <div>
              <b className="muted">Gathered</b>
              <ul className="tight">
                {part.current.gathered.map((g: any, i: number) => (
                  <li key={i}>
                    {g.field}: <code>{g.value}</code> {g.source ? <span className="muted">— {g.source}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {d?.bomRow && (
            <div className="kv">
              <b>BOM</b> {d.bomRow}
            </div>
          )}
          {d?.wiring && (
            <div className="kv">
              <b>Wiring</b> {d.wiring}
            </div>
          )}
          {d?.config && <pre className="code small">{d.config}</pre>}
          {part.checklist?.length ? (
            <div>
              <b className="muted">Checklist</b>
              <ul className="tight">
                {part.checklist.map((c: string, i: number) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {part.humanInput?.length ? (
            <div>
              <b className="muted">Your input</b>
              <ul className="tight">
                {part.humanInput.map((h, i) => (
                  <li key={i}>
                    <span className="muted small">{new Date(h.at).toLocaleTimeString()}</span> {h.text}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {part.openQuestions?.length ? (
            <div>
              <b className="warn">Open questions</b>
              <ul className="tight">
                {part.openQuestions.map((q: string, i: number) => (
                  <li key={i}>{q}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {part.evidence?.length ? (
            <div>
              <b className="muted">Evidence (verification ladder)</b>
              <ul className="tight">
                {part.evidence.map((e, i) => (
                  <li key={i}>
                    <code>{e.rung}</code> {e.by ? `by ${e.by} ` : ''}
                    {e.detail ? <span className="muted">— {e.detail}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {part.research?.length ? (
            <details>
              <summary className="muted small">research notes ({part.research.length})</summary>
              <ul className="tight">
                {part.research.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </details>
          ) : null}
          {err?.stack && (
            <details>
              <summary className="muted small">stack</summary>
              <pre className="code small">{stackLines(err, 12).join('\n')}</pre>
            </details>
          )}
        </div>
      )}
    </article>
  );
}
