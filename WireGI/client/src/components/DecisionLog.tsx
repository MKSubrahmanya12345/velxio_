import type { Decision } from '../types';
import ConfidenceMeter from './ConfidenceMeter';

/**
 * The decision log: every typed question WireGI asked, who answered it (live
 * Jev or the LLM standing in), the answer, and — when the answer degrades — the
 * reason. `source: llm-fallback` with a note is the interesting case.
 */
export default function DecisionLog({ decisions }: { decisions: Decision[] }) {
  return (
    <div className="panel">
      <h3>Decisions ({decisions.length})</h3>
      {decisions.length === 0 ? (
        <div className="muted">none yet</div>
      ) : (
        decisions
          .slice()
          .reverse()
          .map((d, i) => (
            <div className="decision" key={i}>
              <div className="label">
                {d.label} <span className="src">· {d.source || '?'}</span>
                {d.model && d.model !== 'llm-fallback' ? <span className="src"> · {d.model}</span> : null}
                <span className="src"> · {new Date(d.at).toLocaleTimeString()}</span>
              </div>
              {d.note && <div className="q warn">↳ {d.note}</div>}
              {d.answers &&
                Object.entries(d.answers).map(([id, a]: any) => {
                  const val = a?.choice ?? a?.noul ?? a?.score ?? a?.value ?? a;
                  const conf =
                    a?.confidence ?? (typeof a?.noul === 'number' ? Math.max(a.noul, 1 - a.noul) : null);
                  return (
                    <div className="q" key={id}>
                      <span className="id">{id}</span>: {JSON.stringify(val)}
                      {conf != null && <ConfidenceMeter value={Number(conf)} />}
                    </div>
                  );
                })}
            </div>
          ))
      )}
    </div>
  );
}
