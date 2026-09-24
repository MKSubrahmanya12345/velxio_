import { useEffect, useMemo, useRef, useState } from 'react';
import type { FlowEntry, Health, Project } from '../types';
import { detailOf, formatClock, levelOf, stackLines, titleOf, type Level } from '../lib/events';
import { exportTrace } from '../api';

const LEVELS: Array<{ id: 'all' | Level; label: string }> = [
  { id: 'all', label: 'all' },
  { id: 'info', label: 'info+' },
  { id: 'warn', label: 'warn+' },
  { id: 'error', label: 'errors' },
];

const RANK: Record<string, number> = { debug: 0, info: 1, success: 1, warn: 2, error: 3 };

function payloadOf(ev: FlowEntry): Record<string, unknown> {
  const skip = new Set(['message', 'receivedAt', 'result', 'level', 'seq', 'ts', 't', 'runId', 'type', 'stage']);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ev)) {
    if (skip.has(k) || v === undefined || v === null || v === '') continue;
    out[k] = v;
  }
  return out;
}

/**
 * The flow/debug view: every event of the run, in order, with the fields that
 * make a failure explainable (level, timing, part, provider, status, stack).
 * This is the panel that replaces "ERROR undefined" with an actual answer.
 */
export default function FlowPanel({
  flow,
  project,
  health,
  onClear,
}: {
  flow: FlowEntry[];
  project: Project | null;
  health: Health | null;
  onClear: () => void;
}) {
  const [minLevel, setMinLevel] = useState<'all' | Level>('all');
  const [query, setQuery] = useState('');
  const [unit, setUnit] = useState('all');
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const [follow, setFollow] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);

  const units = useMemo(() => {
    const set = new Set<string>();
    for (const ev of flow) if (ev.part) set.add(ev.part);
    return [...set];
  }, [flow]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const floor = minLevel === 'all' ? -1 : RANK[minLevel] ?? 0;
    return flow.filter((ev) => {
      if (floor >= 0 && (RANK[levelOf(ev)] ?? 1) < floor) return false;
      if (unit !== 'all' && (ev.part || '') !== unit) return false;
      if (!q) return true;
      return (
        (ev.message || '').toLowerCase().includes(q) ||
        (ev.part || '').toLowerCase().includes(q) ||
        (ev.type || '').includes(q) ||
        (ev.where || '').toLowerCase().includes(q) ||
        (ev.provider || '').toLowerCase().includes(q) ||
        JSON.stringify(ev.error || '').toLowerCase().includes(q)
      );
    });
  }, [flow, minLevel, query, unit]);

  const errorCount = flow.filter((e) => levelOf(e) === 'error').length;
  const warnCount = flow.filter((e) => levelOf(e) === 'warn').length;
  const runs = project?.state.runs || [];

  useEffect(() => {
    if (!follow) return;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [filtered.length, follow]);

  return (
    <div className="flow">
      {runs.length > 0 && (
        <div className="runs">
          {runs
            .slice()
            .reverse()
            .slice(0, 6)
            .map((r) => (
              <div className="run-row" key={r.id}>
                <span className={`dot lvl-${r.status === 'failed' ? 'error' : r.status === 'running' ? 'info' : 'success'}`} />
                <b>{r.kind}</b>
                <span className="muted small">
                  {new Date(r.startedAt).toLocaleTimeString()} · {r.ms ? `${(r.ms / 1000).toFixed(1)}s` : 'running'} ·{' '}
                  {r.events ?? 0} events · {r.status}
                  {r.error ? ` — ${r.error}` : ''}
                </span>
              </div>
            ))}
        </div>
      )}

      <div className="flow-toolbar">
        <div className="seg">
          {LEVELS.map((l) => (
            <button
              key={l.id}
              className={minLevel === l.id ? 'seg-btn active' : 'seg-btn'}
              onClick={() => setMinLevel(l.id)}
              title={`show ${l.label}`}
            >
              {l.label}
            </button>
          ))}
        </div>
        <select value={unit} onChange={(e) => setUnit(e.target.value)} title="filter by part">
          <option value="all">all parts</option>
          {units.map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
        </select>
        <input
          className="search"
          placeholder="filter text / provider / status…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className={follow ? 'ghost small active' : 'ghost small'} onClick={() => setFollow((f) => !f)}>
          {follow ? 'following' : 'paused'}
        </button>
        <div className="spacer" />
        <button className="ghost small" onClick={() => exportTrace(project, flow)} title="download the trace as JSON">
          export
        </button>
        <button className="ghost small" onClick={onClear} title="clear the in-memory view (the project keeps its own log)">
          clear
        </button>
      </div>

      <div className="flow-meta muted small">
        {flow.length} events · {errorCount} error(s) · {warnCount} warning(s) · showing {filtered.length}
        {health?.debug?.level ? ` · server level ${health.debug.level}` : ''}
      </div>

      <div className="flow-list" ref={listRef}>
        {!filtered.length && <div className="muted pad">No events yet — start a run.</div>}
        {filtered.map((ev, i) => {
          const lvl = levelOf(ev);
          const isOpen = open[ev.seq ?? i] ?? lvl === 'error';
          const err = typeof ev.error === 'object' ? ev.error : null;
          const payload = payloadOf(ev);
          return (
            <div className={`flow-row lvl-${lvl}`} key={ev.seq ?? `${i}-${ev.receivedAt ?? 0}`}>
              <button
                className="flow-head"
                onClick={() => setOpen((o) => ({ ...o, [ev.seq ?? i]: !isOpen }))}
                title={isOpen ? 'collapse' : 'expand payload'}
              >
                <span className={`dot lvl-${lvl}`} />
                <span className="t">{formatClock(ev)}</span>
                <span className="seq">#{ev.seq ?? i}</span>
                <span className="title">{titleOf(ev)}</span>
                <span className="detail">{detailOf(ev)}</span>
                <span className="caret">{isOpen ? '▾' : '▸'}</span>
              </button>
              {isOpen && (
                <div className="flow-body">
                  {ev.message && <div className="flow-message">{ev.message}</div>}
                  {err && (
                    <div className="err-block">
                      <div className="err-line">
                        <b>{err.name || 'Error'}</b>: {err.message || '(no message)'}
                        {err.where ? ` · at ${err.where}` : ''}
                        {err.status ? ` · HTTP ${err.status}` : ''}
                        {err.provider ? ` · ${err.provider}` : ''}
                      </div>
                      {err.attempts?.length ? (
                        <table className="attempts">
                          <thead>
                            <tr>
                              <th>key</th>
                              <th>model</th>
                              <th>status</th>
                              <th>ms</th>
                              <th>message</th>
                            </tr>
                          </thead>
                          <tbody>
                            {err.attempts.map((a, ai) => (
                              <tr key={ai}>
                                <td>{a.provider || a.keyId || '?'}</td>
                                <td>{a.model || '?'}</td>
                                <td>{a.status ?? '—'}</td>
                                <td>{a.latencyMs ?? '—'}</td>
                                <td className="ellipsis" title={a.message}>
                                  {a.message || '—'}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      ) : null}
                      {err.cause?.message && <div className="muted small">cause: {err.cause.message}</div>}
                      {stackLines(err).length > 0 && (
                        <details>
                          <summary className="muted small">stack</summary>
                          <pre className="code small">{stackLines(err, 12).join('\n')}</pre>
                        </details>
                      )}
                    </div>
                  )}
                  {Object.keys(payload).length > 0 && (
                    <details>
                      <summary className="muted small">payload</summary>
                      <pre className="code small">{JSON.stringify(payload, null, 2)}</pre>
                    </details>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
