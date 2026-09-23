import { useCallback, useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { api } from '../api';
import type { GlobalRule, GlobalRuleKind } from '../types';

// Global rules — the cross-project, user-authored rule set that feeds the JEV
// pre-turn gate. Hand-managed here: add, edit, enable/disable, delete. No LLM
// is involved in this panel; these rules steer every conversation's turn
// BEFORE any generation happens.
const KINDS: { id: GlobalRuleKind; label: string }[] = [
  { id: 'rule', label: 'Rule (binding)' },
  { id: 'preference', label: 'Preference' },
  { id: 'goal', label: 'Goal' },
  { id: 'fact', label: 'Fact' },
];

const card: React.CSSProperties = { border: '1px solid rgba(127,127,127,.35)', borderRadius: 8, padding: '10px 12px', display: 'flex', gap: 10, alignItems: 'flex-start' };
const row: React.CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' };
const grow: React.CSSProperties = { flex: 1 };
const input: React.CSSProperties = { flex: 1, minWidth: 220, padding: '7px 9px', borderRadius: 6, border: '1px solid rgba(127,127,127,.45)', background: 'transparent', color: 'inherit' };

export function GlobalRulesPanel({ onBack }: { onBack: () => void }) {
  const [rules, setRules] = useState<GlobalRule[]>([]);
  const [file, setFile] = useState('');
  const [text, setText] = useState('');
  const [kind, setKind] = useState<GlobalRuleKind>('rule');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const state = await api.globalRules.list();
      setRules(state.rules);
      setFile(state.file);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const run = async (work: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      await work();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const add = () => {
    if (!text.trim()) return;
    void run(async () => {
      await api.globalRules.add({ text: text.trim(), kind, note: note.trim() || undefined });
      setText('');
      setNote('');
    });
  };

  return (
    <div style={{ maxWidth: 880, margin: '0 auto', padding: '18px 16px 60px', display: 'grid', gap: 14 }}>
      <div style={row}>
        <button className="fg-btn fg-btn-secondary" onClick={onBack}>← Back</button>
        <h2 style={{ margin: 0, flex: 1 }}>Global rules</h2>
        <button className="fg-btn fg-btn-secondary" onClick={() => void load()} disabled={loading || busy}>Refresh</button>
      </div>
      <p style={{ margin: 0, opacity: 0.75, fontSize: 14 }}>
        Binding across <strong>every</strong> project and conversation. Before each turn, JEV decides — before any
        generation — which of these rules govern the message, and the turn is steered accordingly. Add or remove
        rules here and they apply on the very next message. {file && <span style={{ opacity: 0.6 }}>({file})</span>}
      </p>

      {error && (
        <div className="fg-banner fg-banner-error" role="alert">
          {error}
          <button className="fg-back" aria-label="Dismiss error" onClick={() => setError('')}>×</button>
        </div>
      )}

      <div style={{ ...card, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <label style={{ ...grow, display: 'grid', gap: 6 }}>
          <span style={{ fontSize: 13, opacity: 0.8 }}>Rule text</span>
          <input
            style={input}
            value={text}
            placeholder="e.g. Never spend more than ₹500 per build"
            onChange={e => setText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') add(); }}
            maxLength={2000}
          />
        </label>
        <label style={{ display: 'grid', gap: 6 }}>
          <span style={{ fontSize: 13, opacity: 0.8 }}>Kind</span>
          <select style={input} value={kind} onChange={e => setKind(e.target.value as GlobalRuleKind)}>
            {KINDS.map(k => <option key={k.id} value={k.id}>{k.label}</option>)}
          </select>
        </label>
        <label style={{ display: 'grid', gap: 6 }}>
          <span style={{ fontSize: 13, opacity: 0.8 }}>Note (optional)</span>
          <input style={input} value={note} placeholder="why / context" onChange={e => setNote(e.target.value)} maxLength={300} />
        </label>
        <button className="fg-btn fg-btn-primary" onClick={add} disabled={busy || !text.trim()}>+ Add rule</button>
      </div>

      {loading ? (
        <p style={{ opacity: 0.6 }}>Loading…</p>
      ) : rules.length === 0 ? (
        <p style={{ opacity: 0.6 }}>No global rules yet. Add one above — it steers the very next turn of every project.</p>
      ) : (
        <div style={{ display: 'grid', gap: 8 }}>
          {rules.map(r => (
            <div key={r.id} style={{ ...card, opacity: r.enabled ? 1 : 0.55 }}>
              <input
                type="checkbox"
                aria-label={r.enabled ? 'Disable rule' : 'Enable rule'}
                checked={r.enabled}
                onChange={() => void run(() => api.globalRules.update(r.id, { enabled: !r.enabled }))}
                disabled={busy}
              />
              <div style={{ ...grow, display: 'grid', gap: 4 }}>
                <span>{r.text}</span>
                <span style={{ fontSize: 12, opacity: 0.65 }}>
                  {r.kind}{r.note ? ` · ${r.note}` : ''}{r.disabledBy ? ` · disabled: ${r.disabledBy}` : ''}
                </span>
              </div>
              <button
                className="fg-btn fg-btn-secondary"
                onClick={() => {
                  const next = window.prompt('Edit rule text', r.text);
                  if (next !== null && next.trim() && next.trim() !== r.text) {
                    void run(() => api.globalRules.update(r.id, { text: next.trim() }));
                  }
                }}
                disabled={busy}
              >
                Edit
              </button>
              <button
                className="fg-btn fg-btn-secondary"
                onClick={() => { if (window.confirm('Delete this global rule?')) void run(() => api.globalRules.remove(r.id)); }}
                disabled={busy}
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
