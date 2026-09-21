import { useState } from 'react';
import { api } from '../api';
import type { Project } from '../types';

const KIND_ICON: Record<string, string> = {
  user: '❯', system: '•', jev: '⚡', plan: '▤', ai: '◆',
};

export function SidePanel({ project, onProject }: { project: Project; onProject: (p: Project) => void }) {
  const st = project.state;
  const [invName, setInvName] = useState('');
  const [invNote, setInvNote] = useState('');
  const [busy, setBusy] = useState(false);

  const addInventory = async () => {
    if (!invName.trim() || busy) return;
    setBusy(true);
    try {
      const p = await api.addInventory(project.id, [{ name: invName.trim(), note: invNote.trim() || undefined }]);
      onProject(p);
      setInvName('');
      setInvNote('');
    } finally {
      setBusy(false);
    }
  };

  const est = st.bom.reduce((s, b) => s + b.cost_usd, 0);

  return (
    <div className="fg-side">
      <section className="fg-side-sec">
        <h3 className="fg-side-title">Phases</h3>
        <div className="fg-phases">
          {st.phases.map((ph) => (
            <div key={ph.id} className="fg-phase">
              <div className="fg-phase-head">
                <span>{ph.name}</span>
                <span className="fg-muted">
                  {ph.steps.filter((s) => s.status === 'done').length}/{ph.steps.length}
                </span>
              </div>
              {ph.steps.map((s) => (
                <div
                  key={s.id}
                  className={
                    'fg-steprow' +
                    (s.id === st.current.stepId ? ' fg-steprow-current' : '') +
                    (s.status === 'done' ? ' fg-steprow-done' : '')
                  }
                >
                  <span className="fg-steprow-icon">
                    {s.status === 'done' ? '✓' : s.id === st.current.stepId ? '▶' : '·'}
                  </span>
                  <span className="fg-steprow-title">{s.title}</span>
                  {s.track === 'sim' && <span className="fg-track-dot" title="sim track" />}
                </div>
              ))}
            </div>
          ))}
        </div>
      </section>

      <section className="fg-side-sec">
        <h3 className="fg-side-title">
          Bill of materials <span className="fg-muted">est. ${est.toFixed(0)}</span>
        </h3>
        <div className="fg-bom">
          {st.bom.map((b) => (
            <div key={b.id} className="fg-bom-row">
              <span className={`fg-bom-status fg-bom-${b.status}`}>{b.status}</span>
              <span className="fg-bom-name">{b.name}</span>
              <span className="fg-muted">×{b.qty}</span>
              <span className="fg-muted">${b.cost_usd.toFixed(2)}</span>
            </div>
          ))}
        </div>

        <h3 className="fg-side-title fg-side-title-sub">Your inventory</h3>
        {st.inventory.length === 0 && (
          <div className="fg-muted">Empty — add what you actually have; Jev scores substitutes against it.</div>
        )}
        <div className="fg-inventory">
          {st.inventory.map((i) => (
            <div key={i.id} className="fg-inv-row">
              <span className="fg-inv-name">{i.name}</span>
              {i.note && <span className="fg-muted">{i.note}</span>}
            </div>
          ))}
        </div>
        <div className="fg-row fg-row-tight">
          <input
            className="fg-input"
            placeholder="Part name (e.g. 10k potentiometer)"
            value={invName}
            onChange={(e) => setInvName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addInventory()}
          />
          <input
            className="fg-input"
            placeholder="note (optional)"
            value={invNote}
            onChange={(e) => setInvNote(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addInventory()}
          />
          <button className="fg-btn fg-btn-secondary" onClick={addInventory} disabled={busy || !invName.trim()}>
            Add
          </button>
        </div>
      </section>

      <section className="fg-side-sec">
        <h3 className="fg-side-title">Skill profile</h3>
        {Object.keys(st.skill).length === 0 && <div className="fg-muted">Learns as steps complete.</div>}
        <div className="fg-skills">
          {Object.entries(st.skill).map(([name, e]) => {
            const level = (e.successes + 1) / (e.successes + e.fails + 2); // smoothed
            return (
              <div key={name} className="fg-skill">
                <span className="fg-skill-name">{name}</span>
                <div className="fg-conf-bar">
                  <div className="fg-conf-fill fg-conf-med" style={{ width: `${Math.round(level * 100)}%` }} />
                </div>
                <span className="fg-muted">{e.successes}✓ {e.fails}✗</span>
              </div>
            );
          })}
        </div>
      </section>

      <section className="fg-side-sec">
        <h3 className="fg-side-title">Log</h3>
        <div className="fg-log">
          {[...st.log].reverse().slice(0, 60).map((l, i) => (
            <div key={i} className={`fg-log-row fg-log-${l.kind}`}>
              <span className="fg-log-icon">{KIND_ICON[l.kind] || '·'}</span>
              <span className="fg-log-text">{l.text}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
