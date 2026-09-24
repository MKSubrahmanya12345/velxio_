import { useState } from 'react';
import type { PartMeta } from '../types';
import { research as researchApi } from '../api';

interface LogRow {
  part: string;
  web: { engine: string; count: number };
  ts: string;
  error?: string;
  meta?: PartMeta;
}

/** Per-part research outcomes: which engine, how many sources, which model. */
export default function ResearchLog({ log }: { log: LogRow[] }) {
  const [q, setQ] = useState('');
  const [out, setOut] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  const search = async () => {
    if (!q.trim()) return;
    setBusy(true);
    try {
      setOut(await researchApi(q.trim()));
    } catch (e: any) {
      setOut({ error: String(e?.message || e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <h3>Research log ({log.length})</h3>
      {log.length === 0 ? (
        <div className="muted">none yet</div>
      ) : (
        <table className="kvtable">
          <tbody>
            {log
              .slice()
              .reverse()
              .map((r, i) => (
                <tr key={i}>
                  <td>{r.part}</td>
                  <td>
                    {r.error ? (
                      <span className="bad">failed</span>
                    ) : (
                      <code>{r.web?.engine || '—'}</code>
                    )}
                  </td>
                  <td className="muted small">
                    {r.error ? r.error : `${r.web?.count ?? 0} source(s)`}
                    {r.meta?.provider ? ` · ${r.meta.provider}` : ''}
                    {r.meta?.llmMs ? ` · ${r.meta.llmMs}ms` : ''}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      )}

      <div className="row" style={{ marginTop: 10 }}>
        <input type="text" placeholder="ad-hoc web search…" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="ghost small" onClick={search} disabled={busy || !q.trim()}>
          {busy ? '…' : 'Search'}
        </button>
      </div>
      {out && (
        <div className="muted small">
          {out.error ? (
            out.error
          ) : (
            <>
              <div>
                engine: <code>{out.web ? `${out.web.engine} (${out.web.count})` : 'model knowledge'}</code>
              </div>
              <pre className="code small">{String(out.summary || '').slice(0, 1500)}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}
