import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import type { GlobalRule, GlobalRuleKind } from '../types';

// Global rules — the cross-project, user-authored rule set that feeds the JEV
// pre-turn gate. Hand-managed here: add, edit, enable/disable, delete. No LLM
// is involved in this panel; these rules steer every conversation's turn
// BEFORE any generation happens.

const KINDS: { id: GlobalRuleKind; label: string; hint: string }[] = [
  { id: 'rule', label: 'Rule', hint: 'Binding. A draft that breaks it is held back.' },
  { id: 'preference', label: 'Preference', hint: 'Steers choices when nothing binding decides.' },
  { id: 'goal', label: 'Goal', hint: 'What every project should move toward.' },
  { id: 'fact', label: 'Fact', hint: 'Context that is true about you or your setup.' },
];
const kindLabel = (k: GlobalRuleKind) => KINDS.find(x => x.id === k)?.label || k;

const EXAMPLES: { text: string; kind: GlobalRuleKind }[] = [
  { text: 'Keep every build under ₹500 in parts.', kind: 'rule' },
  { text: 'Never suggest mains-voltage (230 V) wiring.', kind: 'rule' },
  { text: 'Prefer parts I can buy locally in Bengaluru.', kind: 'preference' },
  { text: 'I have an ESP32 DevKit, a breadboard, and jumper wires.', kind: 'fact' },
  { text: 'Explain every step for a beginner.', kind: 'preference' },
];

type Filter = 'all' | 'enabled' | 'disabled';

interface Edit { id: string; text: string; kind: GlobalRuleKind; note: string }

function relative(iso: string | null): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(iso).toLocaleDateString();
}

export function GlobalRulesPanel({ onBack, onChanged }: { onBack: () => void; onChanged?: (enabledCount: number) => void }) {
  const [rules, setRules] = useState<GlobalRule[]>([]);
  const [file, setFile] = useState('');
  const [text, setText] = useState('');
  const [kind, setKind] = useState<GlobalRuleKind>('rule');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [edit, setEdit] = useState<Edit | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const addRef = useRef<HTMLTextAreaElement>(null);
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;

  const apply = useCallback((state: { rules: GlobalRule[]; file: string }) => {
    setRules(state.rules);
    setFile(state.file);
    onChangedRef.current?.(state.rules.filter(r => r.enabled).length);
  }, []);

  const load = useCallback(async () => {
    try {
      apply(await api.globalRules.list());
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [apply]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(''), 3200);
    return () => window.clearTimeout(t);
  }, [notice]);

  // Every mutation returns the full state, so the list never goes stale.
  const run = async (tag: string, work: () => Promise<{ rules: GlobalRule[]; file: string }>, done?: string) => {
    if (busy) return false;
    setBusy(tag);
    setError('');
    try {
      apply(await work());
      if (done) setNotice(done);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy('');
    }
  };

  const add = async () => {
    const clean = text.trim();
    if (!clean) return;
    const ok = await run('add', () => api.globalRules.add({ text: clean, kind, note: note.trim() || undefined }), 'Rule added. It applies from the next message in every chat.');
    if (ok) { setText(''); setNote(''); addRef.current?.focus(); }
  };

  const saveEdit = async () => {
    if (!edit) return;
    const rule = rules.find(r => r.id === edit.id);
    if (!rule || !edit.text.trim()) return;
    const patch: Partial<Pick<GlobalRule, 'text' | 'kind' | 'note'>> = {};
    if (edit.text.trim() !== rule.text) patch.text = edit.text.trim();
    if (edit.kind !== rule.kind) patch.kind = edit.kind;
    if (edit.note.trim() !== rule.note) patch.note = edit.note.trim();
    if (!Object.keys(patch).length) { setEdit(null); return; }
    if (await run(`edit:${edit.id}`, () => api.globalRules.update(edit.id, patch), 'Rule updated.')) setEdit(null);
  };

  const toggle = (r: GlobalRule) =>
    run(`toggle:${r.id}`, () => api.globalRules.update(r.id, { enabled: !r.enabled }), r.enabled ? 'Rule paused. JEV will ignore it until you turn it back on.' : 'Rule is active again.');

  const remove = async (r: GlobalRule) => {
    if (await run(`delete:${r.id}`, () => api.globalRules.remove(r.id), 'Rule deleted.')) setConfirmDelete(null);
  };

  const enabledCount = rules.filter(r => r.enabled).length;
  const disabledCount = rules.length - enabledCount;
  const duplicate = text.trim() && rules.some(r => r.text.toLowerCase() === text.trim().toLowerCase());

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rules
      .filter(r => (filter === 'all' ? true : filter === 'enabled' ? r.enabled : !r.enabled))
      .filter(r => !q || r.text.toLowerCase().includes(q) || r.note.toLowerCase().includes(q))
      // Active first, then newest first: what steers the next turn is on top.
      .sort((a, b) => Number(b.enabled) - Number(a.enabled) || b.createdAt.localeCompare(a.createdAt));
  }, [rules, filter, query]);

  return (
    <div className="fg-rules-page">
      <div className="fg-rules">
        <div className="fg-providers-head">
          <button className="fg-back" aria-label="Back to chat" onClick={onBack}>←</button>
          <div>
            <div className="fg-eyebrow">APPLIES TO EVERY PROJECT · CHECKED BEFORE ANY GENERATION</div>
            <h1>Global <em>JEV rules</em></h1>
            <p className="fg-sub">
              Write these once and they apply to every chat. Before each turn, JEV picks which of them apply to your
              message, tells the model to follow them, then checks the draft against the same rules. Changes apply
              from the next message.
            </p>
          </div>
        </div>

        <div className="fg-rules-stats" aria-label="Rule counts">
          <div><strong>{enabledCount}</strong><span>active</span></div>
          <div><strong>{disabledCount}</strong><span>paused</span></div>
          <div><strong>{rules.length}</strong><span>total</span></div>
        </div>

        {error && (
          <div className="fg-banner fg-banner-error" role="alert">
            {error}
            <button className="fg-back" aria-label="Dismiss error" onClick={() => setError('')}>×</button>
          </div>
        )}
        {notice && <div className="fg-banner fg-banner-ok" role="status">{notice}</div>}

        <section className="fg-card fg-rules-add" aria-label="Add a global rule">
          <h2>Add a rule</h2>
          <div className="fg-rules-kinds" role="radiogroup" aria-label="Kind">
            {KINDS.map(k => (
              <button
                key={k.id}
                type="button"
                role="radio"
                aria-checked={kind === k.id}
                className={`fg-rules-kind kind-${k.id}${kind === k.id ? ' is-selected' : ''}`}
                onClick={() => setKind(k.id)}
              >
                <strong>{k.label}</strong>
                <small>{k.hint}</small>
              </button>
            ))}
          </div>
          <div className="fg-field">
            <label htmlFor="grule-text">Rule text</label>
            <textarea
              id="grule-text"
              ref={addRef}
              className="fg-input fg-textarea"
              rows={2}
              value={text}
              maxLength={2000}
              placeholder="e.g. Keep every build under ₹500 in parts."
              onChange={e => setText(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void add(); } }}
            />
            <span className="fg-field-hint">
              {duplicate ? <span className="fg-rules-warn">This exact rule already exists.</span> : 'Be specific: “under ₹500” is easier to check than “cheap”. Press Enter to add, Shift+Enter for a new line.'}
              <span className="fg-rules-count">{text.length}/2000</span>
            </span>
          </div>
          <div className="fg-field">
            <label htmlFor="grule-note">Why (optional)</label>
            <input id="grule-note" className="fg-input" value={note} maxLength={300} placeholder="Only you see this. JEV ignores it." onChange={e => setNote(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void add(); }} />
          </div>
          <div className="fg-provider-form-actions">
            <button className="fg-btn fg-btn-primary" onClick={() => void add()} disabled={!!busy || !text.trim() || !!duplicate}>
              {busy === 'add' ? 'Adding…' : `+ Add ${kindLabel(kind).toLowerCase()}`}
            </button>
          </div>
          {rules.length < 3 && (
            <div className="fg-rules-examples">
              <span>Try one:</span>
              {EXAMPLES.filter(ex => !rules.some(r => r.text === ex.text)).slice(0, 4).map(ex => (
                <button key={ex.text} type="button" className="fg-rules-example" onClick={() => { setText(ex.text); setKind(ex.kind); addRef.current?.focus(); }}>
                  {ex.text}
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="fg-card" aria-label="Your global rules">
          <div className="fg-rules-toolbar">
            <h2>Your rules</h2>
            <div className="fg-rules-filters" role="tablist" aria-label="Filter rules">
              {(['all', 'enabled', 'disabled'] as Filter[]).map(f => (
                <button key={f} role="tab" aria-selected={filter === f} className={`fg-rules-filter${filter === f ? ' is-selected' : ''}`} onClick={() => setFilter(f)}>
                  {f === 'all' ? `All ${rules.length}` : f === 'enabled' ? `Active ${enabledCount}` : `Paused ${disabledCount}`}
                </button>
              ))}
            </div>
            {rules.length > 4 && (
              <input className="fg-input fg-rules-search" type="search" aria-label="Search rules" placeholder="Search…" value={query} onChange={e => setQuery(e.target.value)} />
            )}
          </div>

          {loading ? (
            <p className="fg-muted" role="status">Loading rules…</p>
          ) : rules.length === 0 ? (
            <div className="fg-rules-empty">
              <span aria-hidden="true">＋</span>
              <strong>No global rules yet.</strong>
              <p>Add one above. From then on, every message in every chat goes through the JEV gate with it.</p>
            </div>
          ) : visible.length === 0 ? (
            <p className="fg-muted">No rules match this filter.</p>
          ) : (
            <ul className="fg-rules-list">
              {visible.map(r => {
                const editing = edit?.id === r.id;
                const byGate = !r.enabled && r.disabledBy && r.disabledBy !== 'user';
                return (
                  <li key={r.id} className={`fg-rule kind-${r.kind}${r.enabled ? '' : ' is-disabled'}${editing ? ' is-editing' : ''}`}>
                    <label className="fg-switch" title={r.enabled ? 'Active: JEV checks this rule' : 'Paused: JEV ignores this rule'}>
                      <input type="checkbox" role="switch" aria-label={r.enabled ? `Pause rule: ${r.text}` : `Activate rule: ${r.text}`} checked={r.enabled} disabled={!!busy} onChange={() => void toggle(r)} />
                      <span aria-hidden="true" />
                    </label>
                    <div className="fg-rule-body">
                      {editing ? (
                        <div className="fg-rule-edit">
                          <textarea
                            className="fg-input fg-textarea"
                            aria-label="Rule text"
                            rows={2}
                            autoFocus
                            maxLength={2000}
                            value={edit.text}
                            onChange={e => setEdit({ ...edit, text: e.target.value })}
                            onKeyDown={e => {
                              if (e.key === 'Escape') setEdit(null);
                              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void saveEdit(); }
                            }}
                          />
                          <div className="fg-rule-edit-row">
                            <select className="fg-input" aria-label="Kind" value={edit.kind} onChange={e => setEdit({ ...edit, kind: e.target.value as GlobalRuleKind })}>
                              {KINDS.map(k => <option key={k.id} value={k.id}>{k.label}</option>)}
                            </select>
                            <input className="fg-input" aria-label="Note" placeholder="Why (optional)" maxLength={300} value={edit.note} onChange={e => setEdit({ ...edit, note: e.target.value })} onKeyDown={e => { if (e.key === 'Escape') setEdit(null); if (e.key === 'Enter') void saveEdit(); }} />
                          </div>
                          <div className="fg-key-actions">
                            <button className="fg-btn fg-btn-primary" onClick={() => void saveEdit()} disabled={!!busy || !edit.text.trim()}>{busy === `edit:${r.id}` ? 'Saving…' : 'Save'}</button>
                            <button className="fg-btn fg-btn-secondary" onClick={() => setEdit(null)}>Cancel</button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <div className="fg-rule-head">
                            <span className={`fg-pill fg-rule-kind kind-${r.kind}`}>{kindLabel(r.kind)}</span>
                            {!r.enabled && <span className="fg-pill fg-pill-off">{byGate ? 'Paused by JEV' : 'Paused'}</span>}
                            <small className="fg-rule-time" title={new Date(r.updatedAt).toLocaleString()}>edited {relative(r.updatedAt)}</small>
                          </div>
                          <p className="fg-rule-text">{r.text}</p>
                          {r.note && <p className="fg-rule-note">{r.note}</p>}
                          {byGate && (
                            <p className="fg-rule-gate">
                              {r.disabledBy}
                              <button className="fg-link-btn" disabled={!!busy} onClick={() => void toggle(r)}>Restore</button>
                            </p>
                          )}
                        </>
                      )}
                    </div>
                    {!editing && (
                      <div className="fg-rule-actions">
                        {confirmDelete === r.id ? (
                          <>
                            <button className="fg-btn fg-btn-danger" disabled={!!busy} onClick={() => void remove(r)}>{busy === `delete:${r.id}` ? 'Deleting…' : 'Delete'}</button>
                            <button className="fg-btn fg-btn-ghost" onClick={() => setConfirmDelete(null)}>Keep</button>
                          </>
                        ) : (
                          <>
                            <button className="fg-btn fg-btn-ghost" disabled={!!busy} aria-label={`Edit rule: ${r.text}`} onClick={() => { setConfirmDelete(null); setEdit({ id: r.id, text: r.text, kind: r.kind, note: r.note }); }}>Edit</button>
                            <button className="fg-btn fg-btn-ghost" disabled={!!busy} aria-label={`Delete rule: ${r.text}`} onClick={() => { setEdit(null); setConfirmDelete(r.id); }}>Delete</button>
                          </>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {file && <p className="fg-providers-warning fg-muted">Saved as plain JSON at <code>{file}</code>. Only this server reads it.</p>}
        </section>
      </div>
    </div>
  );
}
