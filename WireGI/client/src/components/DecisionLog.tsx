import type { Decision } from '../types';
import ConfidenceMeter from './ConfidenceMeter';

export default function DecisionLog({ decisions }: { decisions: Decision[] }) {
  return (
    <div className="panel">
      <h3>Jev decisions</h3>
      {decisions.length === 0 ? (
        <div style={{ color: 'var(--muted)' }}>none yet</div>
      ) : (
        decisions.map((d, i) => (
          <div className="decision" key={i}>
            <div className="label">
              {d.label}{' '}
              <span className="src">
                · {d.source || '?'} · {new Date(d.at).toLocaleTimeString()}
              </span>
            </div>
            {d.answers &&
              Object.entries(d.answers).map(([id, a]: any) => {
                const val = a?.value ?? a?.probability ?? a?.score ?? a;
                const conf = a?.confidence ?? a?.probability ?? null;
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
