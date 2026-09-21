import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { ProviderCatalogEntry, ProviderId, ProviderKey, ProvidersState, ProviderTestResult } from '../types';

// The four providers the page offers first, then the generic OpenAI-compatible
// endpoint (any /chat/completions base) for everything else.
const TILE_ORDER: ProviderId[] = ['gemini', 'openrouter', 'bedrock', 'ollama', 'openai'];

const TILE_BLURB: Record<ProviderId, string> = {
  gemini: 'Google AI Studio keys. gemini-2.5-flash / pro.',
  openrouter: 'One key, hundreds of models. OpenAI-compatible.',
  bedrock: 'SigV4-signed Converse calls. No AWS SDK needed.',
  ollama: 'Local models at http://localhost:11434. No key required.',
  openai: 'Any OpenAI-compatible /chat/completions endpoint.',
};

interface Draft {
  provider: ProviderId;
  apiKey: string;
  secret: string;
  sessionToken: string;
  region: string;
  baseUrl: string;
  model: string;
  note: string;
}

function emptyDraft(provider: ProviderId, catalog: ProviderCatalogEntry[] = []): Draft {
  const def = catalog.find(c => c.id === provider);
  return {
    provider,
    apiKey: '',
    secret: '',
    sessionToken: '',
    region: '',
    baseUrl: def?.defaultBase || '',
    model: def?.defaultModel || '',
    note: '',
  };
}

function relativeTime(iso: string | null): string {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return 'never';
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(iso).toLocaleString();
}

export function ProvidersView({ onBack, onChanged }: { onBack: () => void; onChanged?: () => void }) {
  const [state, setState] = useState<ProvidersState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [draft, setDraft] = useState<Draft>(emptyDraft('gemini'));
  const [tests, setTests] = useState<Record<string, ProviderTestResult>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editNote, setEditNote] = useState('');
  const [copied, setCopied] = useState('');

  const load = useCallback(async () => {
    try {
      const next = await api.providers.get();
      setState(next);
      // The catalog arrives with the state: fill in this provider's default
      // model/base for a draft the user has not touched yet.
      setDraft(d => (d.apiKey || d.note || d.model || d.baseUrl ? d : emptyDraft(d.provider, next.catalog)));
      setError('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const catalog = state?.catalog || [];
  const def = useMemo(() => catalog.find(c => c.id === draft.provider), [catalog, draft.provider]);
  const keys = state?.keys || [];

  // Any change goes through the server, then the returned state is authoritative.
  const run = async (label: string, action: () => Promise<{ state?: ProvidersState } | void>, done?: string) => {
    setBusy(label);
    setError('');
    setNotice('');
    try {
      const result = await action();
      const next = (result as { state?: ProvidersState } | void)?.state;
      if (next) setState(next);
      else await load();
      if (done) setNotice(done);
      onChanged?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };

  const pickProvider = (provider: ProviderId) => {
    // Credentials do not carry over between providers; the note does.
    setDraft(d => ({ ...emptyDraft(provider, catalog), note: d.note }));
    setTests({});
  };

  const missingFields = (): string[] => {
    if (!def) return ['provider'];
    const problems: string[] = [];
    if (def.requiresKey && !draft.apiKey.trim()) problems.push(def.credentialLabel);
    for (const extra of def.extraCredentials) {
      const value = draft[extra.field as keyof Draft];
      if (extra.required && !String(value || '').trim()) problems.push(extra.label);
    }
    return problems;
  };

  const addKey = async () => {
    const problems = missingFields();
    if (problems.length) {
      setError(`Add ${problems.join(', ')} before saving this key.`);
      return;
    }
    await run('add', () => api.providers.addKey({
      provider: draft.provider,
      apiKey: draft.apiKey.trim(),
      secret: draft.secret.trim(),
      sessionToken: draft.sessionToken.trim(),
      region: draft.region.trim(),
      baseUrl: draft.baseUrl.trim(),
      model: draft.model.trim(),
      note: draft.note.trim(),
    }), `Saved ${def?.label || draft.provider} key${draft.note.trim() ? ` “${draft.note.trim()}”` : ''}. It is now in the failover loop.`);
    setDraft(d => emptyDraft(d.provider, catalog));
  };

  const copy = async (key: ProviderKey) => {
    try {
      await navigator.clipboard?.writeText(key.apiKey);
      setCopied(key.id);
      setTimeout(() => setCopied(c => (c === key.id ? '' : c)), 1500);
    } catch {
      setNotice('Copy blocked by the browser — select the key text instead.');
    }
  };

  const testKey = async (key: ProviderKey) => {
    setBusy(`test:${key.id}`);
    setError('');
    try {
      const result = await api.providers.testKey(key.id);
      setTests(t => ({ ...t, [key.id]: result }));
      setState(result.state);
      onChanged?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };

  const saveNote = async (key: ProviderKey) => {
    await run('note', () => api.providers.updateKey(key.id, { note: editNote.trim() }), 'Note saved.');
    setEditingId(null);
  };

  const removeKey = (key: ProviderKey) => {
    const label = key.note ? `${key.providerLabel} “${key.note}”` : key.providerLabel;
    if (!confirm(`Remove ${label}? This deletes the stored key${key.origin === 'env' ? ' from the list (it stays in .env and can be restored)' : ''}.`)) return;
    void run('remove', () => api.providers.removeKey(key.id), `Removed ${label}.`);
  };

  if (loading) return <div className="fg-empty" role="status">Loading providers…</div>;

  const failover = state?.failover || { enabled: true, maxRounds: 10, retryRejected: false };
  const order = state?.order || [];
  const log = [...(state?.log || [])].reverse();

  return (
    <div className="fg-empty fg-providers-page">
      <div className="fg-providers">
        <header className="fg-providers-head">
          <button className="fg-back" onClick={onBack} aria-label="Back to builds">←</button>
          <div>
            <div className="fg-eyebrow">MODEL PROVIDERS</div>
            <h1>Keys, notes, and <em>automatic switching</em></h1>
            <p className="fg-sub">
              Add a key for each provider you have, write a note so you know which is which, and select the one that runs first.
              On any error Forge switches to the next key or provider and keeps looping — {failover.maxRounds} rounds across all of them, then it stops and reports every attempt.
            </p>
          </div>
        </header>

        {error && <div className="fg-banner fg-banner-error" role="alert">{error}<button className="fg-back" aria-label="Dismiss error" onClick={() => setError('')}>×</button></div>}
        {notice && <div className="fg-banner fg-banner-ok" role="status">{notice}<button className="fg-back" aria-label="Dismiss notice" onClick={() => setNotice('')}>×</button></div>}

        <div className="fg-providers-grid">
          {/* ── Add a key ─────────────────────────────────────────────── */}
          <section className="fg-card fg-provider-form" aria-labelledby="add-key-title">
            <h2 id="add-key-title">Add a key</h2>

            <div className="fg-provider-tiles" role="group" aria-label="Provider">
              {[...catalog].sort((a, b) => TILE_ORDER.indexOf(a.id) - TILE_ORDER.indexOf(b.id)).map(entry => (
                <button
                  key={entry.id}
                  type="button"
                  className={`fg-provider-tile${draft.provider === entry.id ? ' is-selected' : ''}`}
                  aria-pressed={draft.provider === entry.id}
                  onClick={() => pickProvider(entry.id)}
                >
                  <strong>{entry.label}</strong>
                  <small>{TILE_BLURB[entry.id] || entry.credentialLabel}</small>
                </button>
              ))}
            </div>

            <div className="fg-field">
              <label htmlFor="provider-key">{def?.credentialLabel || 'API key'}</label>
              <input
                id="provider-key"
                className="fg-input fg-input-mono"
                type="text"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                placeholder={def?.credentialPlaceholder || ''}
                value={draft.apiKey}
                onChange={e => setDraft(d => ({ ...d, apiKey: e.target.value }))}
                aria-describedby="provider-key-hint"
              />
              <small id="provider-key-hint" className="fg-field-hint">
                Typed and stored in plain text — never dotted out, so you can read back exactly what is saved.
              </small>
            </div>

            {def?.extraCredentials.map(extra => (
              <div className="fg-field" key={extra.field}>
                <label htmlFor={`provider-${extra.field}`}>{extra.label}</label>
                <input
                  id={`provider-${extra.field}`}
                  className="fg-input fg-input-mono"
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={extra.placeholder}
                  value={String(draft[extra.field as keyof Draft] || '')}
                  onChange={e => setDraft(d => ({ ...d, [extra.field]: e.target.value }))}
                />
              </div>
            ))}

            <div className="fg-field">
              <label htmlFor="provider-note">Note</label>
              <input
                id="provider-note"
                className="fg-input"
                type="text"
                maxLength={240}
                placeholder="what this key is for — e.g. “main key · free tier”"
                value={draft.note}
                onChange={e => setDraft(d => ({ ...d, note: e.target.value }))}
                aria-describedby="provider-note-hint"
              />
              <small id="provider-note-hint" className="fg-field-hint">Shown on the key card and in the failover log, so a switch tells you which key took over.</small>
            </div>

            <div className="fg-field-row">
              <div className="fg-field">
                <label htmlFor="provider-model">Model</label>
                <input
                  id="provider-model"
                  className="fg-input fg-input-mono"
                  type="text"
                  spellCheck={false}
                  placeholder={def?.modelPlaceholder || ''}
                  value={draft.model}
                  onChange={e => setDraft(d => ({ ...d, model: e.target.value }))}
                />
              </div>
              <div className="fg-field">
                <label htmlFor="provider-base">{def?.baseLabel || 'API base'}</label>
                <input
                  id="provider-base"
                  className="fg-input fg-input-mono"
                  type="text"
                  spellCheck={false}
                  placeholder={def?.defaultBase || ''}
                  value={draft.baseUrl}
                  onChange={e => setDraft(d => ({ ...d, baseUrl: e.target.value }))}
                />
              </div>
            </div>

            <div className="fg-provider-form-actions">
              <button className="fg-btn fg-btn-primary" disabled={Boolean(busy)} onClick={() => void addKey()}>
                {busy === 'add' ? 'Saving key…' : 'Add key'}
              </button>
              {def?.docs && <a className="fg-link" href={def.docs} target="_blank" rel="noreferrer">Get a {def.short} key ↗</a>}
            </div>
          </section>

          {/* ── Failover policy ───────────────────────────────────────── */}
          <section className="fg-card fg-failover" aria-labelledby="failover-title">
            <h2 id="failover-title">Auto-switch on error</h2>
            <p className="fg-muted">
              Every generation call walks the order below. Any error — HTTP status, timeout, unreachable host, malformed
              answer — switches to the next key or provider and tries again. One round is a full pass over all of them.
            </p>

            <label className="fg-check">
              <input
                type="checkbox"
                checked={failover.enabled}
                disabled={Boolean(busy)}
                onChange={e => void run('failover', () => api.providers.setFailover({ enabled: e.target.checked }))}
              />
              <span>Switch providers and keys automatically</span>
            </label>

            <div className="fg-field-row">
              <div className="fg-field">
                <label htmlFor="failover-rounds">Rounds before stopping</label>
                <input
                  id="failover-rounds"
                  className="fg-input fg-input-mono"
                  type="number"
                  min={1}
                  max={25}
                  value={failover.maxRounds}
                  disabled={Boolean(busy)}
                  onChange={e => {
                    const maxRounds = Math.min(25, Math.max(1, Number(e.target.value) || 1));
                    setState(s => (s ? { ...s, failover: { ...s.failover, maxRounds } } : s));
                  }}
                  onBlur={e => void run('failover', () => api.providers.setFailover({ maxRounds: Number(e.target.value) || 10 }), `Failover budget set to ${failover.maxRounds} rounds.`)}
                />
                <small className="fg-field-hint">
                  {failover.maxRounds} round{failover.maxRounds === 1 ? '' : 's'} × {order.length || 0} enabled key{order.length === 1 ? '' : 's'} = up to {(failover.maxRounds * (order.length || 0)) || 0} attempts, then the turn stops and reports each failure.
                </small>
              </div>
              <div className="fg-field">
                <label className="fg-check" htmlFor="failover-retry">
                  <input
                    id="failover-retry"
                    type="checkbox"
                    checked={failover.retryRejected}
                    disabled={Boolean(busy)}
                    onChange={e => void run('failover', () => api.providers.setFailover({ retryRejected: e.target.checked }))}
                  />
                  <span>Retry keys rejected with 401/403/404</span>
                </label>
                <small className="fg-field-hint">Off: a credential that is refused outright is left out of later rounds. On: every key is retried in every round.</small>
              </div>
            </div>

            <h3>Loop order</h3>
            {order.length ? (
              <ol className="fg-loop-order" aria-label="Failover loop order">
                {order.map((item, index) => (
                  <li key={item.id} className={index === 0 ? 'is-first' : ''}>
                    <span className="fg-loop-index">{index + 1}</span>
                    <span className="fg-loop-provider">{item.provider}</span>
                    <span className="fg-loop-note">{item.note || 'no note'}</span>
                    <code>{item.model}</code>
                    {index === 0 && <em className="fg-pill fg-pill-selected">selected</em>}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="fg-muted">No enabled keys yet — add one to start the loop.</p>
            )}

            <h3>Recent attempts</h3>
            {log.length ? (
              <ul className="fg-attempt-log">
                {log.slice(0, 12).map((entry, index) => (
                  <li key={`${entry.at}-${index}`} className={entry.outcome === 'ok' ? 'is-ok' : 'is-error'}>
                    <span className="fg-attempt-dot" aria-hidden="true" />
                    <div>
                      <strong>
                        {entry.outcome === 'ok' ? 'Succeeded' : 'Failed'} · {entry.provider || 'provider'}{entry.note ? ` “${entry.note}”` : ''}
                        {entry.operation && entry.operation !== 'generate' ? ` · ${entry.operation}` : ''}
                        {entry.round ? ` · round ${entry.round}` : ''}
                      </strong>
                      <small>
                        {relativeTime(entry.at)}
                        {typeof entry.latencyMs === 'number' ? ` · ${entry.latencyMs}ms` : ''}
                        {entry.status ? ` · HTTP ${entry.status}` : ''}
                        {entry.permanent ? ' · credential rejected' : ''}
                        {entry.message ? ` — ${entry.message}` : ''}
                      </small>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="fg-muted">Nothing has been called yet. Attempts appear here as turns run.</p>
            )}
          </section>
        </div>

        {/* ── Saved keys ──────────────────────────────────────────────── */}
        <section className="fg-card fg-key-list" aria-labelledby="keys-title">
          <div className="fg-key-list-head">
            <h2 id="keys-title">Your keys</h2>
            <span className="fg-muted">{keys.length} stored · {keys.filter(k => k.enabled).length} in the loop</span>
          </div>

          {!keys.length && (
            <p className="fg-muted">
              No keys yet. Add one above — Gemini, OpenRouter, AWS Bedrock, or a local Ollama.
              {state?.env.llm || state?.env.bedrock ? '' : ' Credentials in forge/server/.env would also show up here.'}
            </p>
          )}

          <ul className="fg-keys" aria-label="Stored keys">
            {keys.map(key => {
              const selected = key.id === state?.activeId;
              const test = tests[key.id];
              return (
                <li key={key.id} className={`fg-key${selected ? ' is-selected' : ''}${key.enabled ? '' : ' is-disabled'}`}>
                  <div className="fg-key-main">
                    <div className="fg-key-head">
                      <span className="fg-prov fg-prov-live">{key.providerLabel}</span>
                      {selected && <em className="fg-pill fg-pill-selected">selected</em>}
                      {!key.enabled && <em className="fg-pill fg-pill-off">out of the loop</em>}
                      {key.origin === 'env' && <em className="fg-pill fg-pill-env">.env</em>}
                      <span className="fg-key-note">{key.note || <em className="fg-muted">no note</em>}</span>
                    </div>

                    <div className="fg-key-row">
                      <label>Key</label>
                      {/* Plain text on purpose: this is the value that will be sent. */}
                      <code className="fg-key-plain" title="Stored and shown in plain text">{key.apiKey || '— no key —'}</code>
                      {key.apiKey && (
                        <button className="fg-btn fg-btn-ghost" onClick={() => void copy(key)} aria-label={`Copy ${key.providerLabel} key`}>
                          {copied === key.id ? 'Copied' : 'Copy'}
                        </button>
                      )}
                    </div>

                    {key.provider === 'bedrock' && (
                      <>
                        <div className="fg-key-row">
                          <label>Secret</label>
                          <code className="fg-key-plain">{key.secret}</code>
                        </div>
                        <div className="fg-key-row">
                          <label>Region</label>
                          <code className="fg-key-plain">{key.region}</code>
                          {key.sessionToken && <><label>Session</label><code className="fg-key-plain">{key.sessionToken}</code></>}
                        </div>
                      </>
                    )}

                    <div className="fg-key-row">
                      <label>Model</label>
                      <code className="fg-key-plain">{key.model}</code>
                      <label>{key.provider === 'ollama' ? 'URL' : 'Base'}</label>
                      <code className="fg-key-plain">{key.baseUrl || 'default'}</code>
                    </div>

                    <div className="fg-key-stats">
                      <span>{key.stats.ok} ok</span>
                      <span className={key.stats.failures ? 'is-bad' : ''}>{key.stats.failures} failed</span>
                      <span>used {relativeTime(key.stats.lastUsedAt)}</span>
                      {typeof key.stats.lastLatencyMs === 'number' && <span>{key.stats.lastLatencyMs}ms</span>}
                      {key.stats.lastError && <span className="fg-key-error" title={key.stats.lastError}>{key.stats.lastError}</span>}
                    </div>

                    {test && (
                      <div className={`fg-banner ${test.ok ? 'fg-banner-ok' : 'fg-banner-error'} fg-key-test`}>
                        {test.ok
                          ? `Reachable · replied in ${test.latencyMs}ms with ${test.model}: ${test.reply}`
                          : `Test failed${test.status ? ` (HTTP ${test.status})` : ''} after ${test.latencyMs}ms — ${test.error}`}
                      </div>
                    )}

                    {editingId === key.id ? (
                      <div className="fg-key-edit">
                        <label htmlFor={`note-${key.id}`}>Note</label>
                        <input
                          id={`note-${key.id}`}
                          className="fg-input"
                          type="text"
                          maxLength={240}
                          value={editNote}
                          autoFocus
                          onChange={e => setEditNote(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') void saveNote(key); }}
                        />
                        <button className="fg-btn fg-btn-primary" disabled={Boolean(busy)} onClick={() => void saveNote(key)}>Save note</button>
                        <button className="fg-btn fg-btn-secondary" onClick={() => setEditingId(null)}>Cancel</button>
                      </div>
                    ) : (
                      <div className="fg-key-actions">
                        <button className="fg-btn fg-btn-primary" disabled={selected || !key.enabled || Boolean(busy)} onClick={() => void run('select', () => api.providers.setActive(key.id), `${key.providerLabel}${key.note ? ` “${key.note}”` : ''} now runs first.`)}>
                          {selected ? 'Selected' : 'Select'}
                        </button>
                        <button className="fg-btn fg-btn-secondary" disabled={Boolean(busy)} onClick={() => void testKey(key)}>
                          {busy === `test:${key.id}` ? 'Testing…' : 'Test'}
                        </button>
                        <button className="fg-btn fg-btn-secondary" disabled={Boolean(busy)} onClick={() => { setEditingId(key.id); setEditNote(key.note); }}>Edit note</button>
                        <button className="fg-btn fg-btn-secondary" disabled={Boolean(busy)} onClick={() => void run('toggle', () => api.providers.updateKey(key.id, { enabled: !key.enabled }), key.enabled ? 'Key taken out of the loop.' : 'Key back in the loop.')}>
                          {key.enabled ? 'Disable' : 'Enable'}
                        </button>
                        <button className="fg-btn fg-btn-danger" disabled={Boolean(busy)} onClick={() => removeKey(key)}>Delete</button>
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>

          {state && !state.keys.some(k => k.origin === 'env') && (state.env.llm || state.env.bedrock) && (
            <button className="fg-btn fg-btn-secondary" disabled={Boolean(busy)} onClick={() => void run('restore', () => api.providers.restoreEnv(), '.env providers restored.')}>
              Restore .env providers
            </button>
          )}

          <p className="fg-muted fg-providers-warning">
            Keys are stored as plain text in <code>{state?.storage.file || 'forge/server/data/providers.json'}</code> and sent to this server without
            encryption at rest. Forge has no authentication, so keep it on localhost or a trusted network — anyone who can reach the API can read these keys.
          </p>
        </section>
      </div>
    </div>
  );
}
