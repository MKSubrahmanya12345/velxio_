import { useState } from 'react';
import type { Part } from '../types';

export default function PartCard({ part }: { part: Part }) {
  const [open, setOpen] = useState(false);
  const d = part.current?.data;
  return (
    <div className="part-card">
      <div className="part-head" onClick={() => setOpen(!open)}>
        <span className="name">{part.name}</span>
        <span className="badge">{part.domain}</span>
        <span className={`badge ${part.status}`}>{part.status}</span>
        {part.humanCheckpoint && <span className="badge human">⚠ eyes</span>}
        <span style={{ flex: 1 }} />
        <span className="badge">{open ? '▾' : '▸'}</span>
      </div>
      {open && (
        <div className="part-body">
          {part.current?.gathered?.length ? (
            <div>
              <b style={{ color: 'var(--muted)' }}>Gathered:</b>
              <ul className="tight">
                {part.current.gathered.map((g: any, i: number) => (
                  <li key={i}>
                    {g.field}: <code>{g.value}</code> {g.source ? `— ${g.source}` : ''}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {d?.bomRow && (
            <div className="kv">
              <b>BOM:</b> {d.bomRow}
            </div>
          )}
          {d?.wiring && (
            <div className="kv">
              <b>Wiring:</b> {d.wiring}
            </div>
          )}
          {d?.config && <div className="code">{d.config}</div>}
          {part.checklist?.length ? (
            <div>
              <b style={{ color: 'var(--muted)' }}>Checklist:</b>
              <ul className="tight">
                {part.checklist.map((c: string, i: number) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {part.openQuestions?.length ? (
            <div>
              <b style={{ color: 'var(--warn)' }}>Open questions:</b>
              <ul className="tight">
                {part.openQuestions.map((q: string, i: number) => (
                  <li key={i}>{q}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
