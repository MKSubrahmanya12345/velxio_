import type { Reconciliation } from '../types';

// Integration panel — the answer to "fragmentation of a single project into
// parts". Parts researched independently can each be locally right and still
// disagree globally; this is where they are forced to agree.
export default function ReconcileLog({ passes }: { passes: Reconciliation[] }) {
  const real = (passes || []).filter((p) => !p.skipped);
  return (
    <div className="panel">
      <h3>Integration</h3>
      {real.length === 0 ? (
        <div style={{ color: 'var(--muted)' }}>not run yet</div>
      ) : (
        real.map((p, i) => {
          if (p.failed) {
            return (
              <div className="decision" key={i} style={{ borderLeftColor: 'var(--bad)' }}>
                <div className="label">
                  failed <span className="src">· {new Date(p.at).toLocaleTimeString()}</span>
                </div>
                <div className="q">{p.reason}</div>
              </div>
            );
          }
          const conflicts = p.conflicts || [];
          const blocking = conflicts.filter((c) => c.severity === 'blocking').length;
          return (
            <div className="decision" key={i} style={{ borderLeftColor: p.coherent ? 'var(--good)' : 'var(--warn)' }}>
              <div className="label">
                {p.coherent ? '✅ coherent' : `⚠ ${conflicts.length} conflict(s)`}
                <span className="src">
                  {blocking ? ` · ${blocking} blocking` : ''}
                  {p.patchesApplied ? ` · ${p.patchesApplied} patched` : ''} ·{' '}
                  {new Date(p.at).toLocaleTimeString()}
                </span>
              </div>
              {p.summary && <div className="q">{p.summary}</div>}
              {conflicts.map((c, j) => (
                <div className="q" key={j}>
                  <span className="id">[{c.severity}]</span> {(c.parts || []).join(' ↔ ')} — {c.issue}
                  {c.resolution && <div style={{ color: 'var(--muted)' }}>→ {c.resolution}</div>}
                  {c.patchesApplied?.length ? (
                    <div style={{ color: 'var(--accent)', fontSize: 11 }}>
                      patched: {c.patchesApplied.join(', ')}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          );
        })
      )}
    </div>
  );
}
