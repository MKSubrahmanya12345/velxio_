import { useEffect, useState } from 'react';
import type { DebugBundle, EnvInfo, Health, Project } from '../types';
import { debugEnv, exportTrace, getDebugBundle, health as healthApi, llmTest, webTest } from '../api';
import type { FlowEntry } from '../types';

/**
 * The debug tab: everything needed to answer "why did it fail?" without reading
 * code — which .env files are in play, which keys are present and where they came
 * from, a live provider test with the full attempt report, and the project's own
 * run/error history.
 *
 * No secret is ever shown: keys are masked by the server before they get here.
 */
export default function DebugPanel({
  project,
  health,
  flow,
}: {
  project: Project | null;
  health: Health | null;
  flow: FlowEntry[];
}) {
  const [env, setEnv] = useState<EnvInfo | null>(null);
  const [bundle, setBundle] = useState<DebugBundle | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<any>(null);
  const [query, setQuery] = useState('5 inch drone ESC rating');
  const [webResult, setWebResult] = useState<any>(null);

  useEffect(() => {
    debugEnv()
      .then((r) => setEnv(r.env))
      .catch(() => {});
    healthApi().catch(() => {});
  }, [project?.updatedAt]);

  useEffect(() => {
    if (!project) return;
    getDebugBundle(project.id)
      .then(setBundle)
      .catch(() => {});
  }, [project?.id, project?.updatedAt]);

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await llmTest());
    } catch (e: any) {
      setTestResult({ status: 0, body: { ok: false, message: String(e?.message || e) } });
    } finally {
      setTesting(false);
    }
  };

  const grouped = (env?.keys || []).reduce<Record<string, EnvInfo['keys']>>((acc, k) => {
    acc[k.group] = acc[k.group] || [];
    acc[k.group].push(k);
    return acc;
  }, {});

  return (
    <div className="debug">
      <section className="panel">
        <h3>Plumbing test</h3>
        <p className="muted small">
          One real generation through the same failover loop a run uses. This distinguishes “no keys” from “bad key”
          from “the model is down” — and lists every credential it tried.
        </p>
        <div className="row">
          <button className="primary small" onClick={runTest} disabled={testing}>
            {testing ? 'testing…' : 'Test LLM now'}
          </button>
        </div>
        {testResult && (
          <div className={`test-card ${testResult.body?.ok ? 'ok' : 'bad'}`}>
            {testResult.body?.ok ? (
              <>
                <div>
                  ✔ <b>{testResult.body.used?.providerLabel || testResult.body.used?.provider}</b> /{' '}
                  {testResult.body.used?.model} answered in {testResult.body.ms}ms
                  {testResult.body.used?.attempts > 1 ? ` after ${testResult.body.used.attempts} attempts` : ''}
                </div>
                <div className="muted small">{testResult.body.reply}</div>
              </>
            ) : (
              <>
                <div>
                  ✖ {testResult.body?.error?.name || 'Failed'}: {testResult.body?.error?.message || testResult.body?.message}
                </div>
                {testResult.body?.hint && <div className="hint">{testResult.body.hint}</div>}
                {testResult.body?.error?.attempts?.length ? (
                  <table className="attempts">
                    <thead>
                      <tr>
                        <th>provider</th>
                        <th>model</th>
                        <th>status</th>
                        <th>ms</th>
                        <th>message</th>
                      </tr>
                    </thead>
                    <tbody>
                      {testResult.body.error.attempts.map((a: any, i: number) => (
                        <tr key={i}>
                          <td>{a.provider}</td>
                          <td>{a.model}</td>
                          <td>{a.status ?? '—'}</td>
                          <td>{a.latencyMs ?? '—'}</td>
                          <td className="ellipsis" title={a.message}>
                            {a.message}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : null}
              </>
            )}
          </div>
        )}

        <div className="row wrap">
          <input type="text" value={query} onChange={(e) => setQuery(e.target.value)} />
          <button
            className="ghost small"
            onClick={async () => setWebResult(await webTest(query))}
            disabled={!query.trim()}
          >
            Test web search
          </button>
        </div>
        {webResult && (
          <div className="muted small">
            {webResult.ok ? (
              <>
                {webResult.engine} returned {webResult.count} result(s)
              </>
            ) : webResult.configured ? (
              <>search configured but failed: {webResult.error || 'unknown error'}</>
            ) : (
              <>no web-search key configured — research uses model knowledge (set TAVILY_API_KEY or BRAVE_API_KEY)</>
            )}
          </div>
        )}
      </section>

      <section className="panel">
        <h3>Environment</h3>
        {!env && <div className="muted small">loading…</div>}
        {env && (
          <>
            <table className="kvtable">
              <tbody>
                {env.files.map((f) => (
                  <tr key={f.path}>
                    <td>{f.role === 'wiregi' ? 'WireGI .env' : 'Forge fallback'}</td>
                    <td>
                      <code>{f.relative}</code>
                    </td>
                    <td>
                      {f.exists ? `${f.keys} key(s)` : 'not found'}
                      {f.role === 'forge-fallback' && !f.enabled ? ' · disabled' : ''}
                    </td>
                  </tr>
                ))}
                <tr>
                  <td>precedence</td>
                  <td colSpan={2}>
                    real environment → WireGI/server/.env → forge/server/.env
                    {env.inheritForge ? '' : ' (fallback off)'}
                  </td>
                </tr>
              </tbody>
            </table>
            {Object.entries(grouped).map(([group, keys]) => (
              <div key={group} className="key-group">
                <div className="key-group-title">{group}</div>
                <table className="kvtable">
                  <tbody>
                    {keys.map((k) => (
                      <tr key={k.key} className={k.present ? '' : 'missing'}>
                        <td>
                          <code>{k.key}</code>
                        </td>
                        <td>{k.present ? (k.secret ? k.value : k.value || 'set') : '—'}</td>
                        <td className="muted small">{k.source}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
            {!env.llm.configured && (
              <div className="hint">
                No LLM key is configured, so any run will fail at its first call. Add one to{' '}
                <code>WireGI/server/.env</code> (copy <code>.env.example</code>) and restart, or set{' '}
                <code>WIREGI_INHERIT_FORGE_ENV=true</code> to reuse <code>forge/server/.env</code>.
              </div>
            )}
          </>
        )}
      </section>

      <section className="panel">
        <h3>Ports</h3>
        <table className="kvtable">
          <tbody>
            <tr>
              <td>Velxio</td>
              <td>5173</td>
              <td className="muted small">repo root frontend</td>
            </tr>
            <tr>
              <td>Forge</td>
              <td>5174</td>
              <td className="muted small">forge/client</td>
            </tr>
            <tr>
              <td>
                <b>WireGI</b>
              </td>
              <td>
                <b>{health?.ports?.client || 5175}</b>
              </td>
              <td className="muted small">this app (vite dev, proxies /api → {health?.ports?.server || 4322})</td>
            </tr>
            <tr>
              <td>WireGI API</td>
              <td>{health?.ports?.server || 4322}</td>
              <td className="muted small">express</td>
            </tr>
          </tbody>
        </table>
      </section>

      {project && (
        <section className="panel">
          <h3>This project</h3>
          <div className="row">
            <button className="ghost small" onClick={() => exportTrace(project, flow)}>
              ↓ export trace (JSON)
            </button>
          </div>
          <div className="muted small" style={{ marginTop: 8 }}>
            {(bundle?.runs || project.state.runs || []).length} run(s) ·{' '}
            {(bundle?.runLog || project.state.runLog || []).length} events stored ·{' '}
            {(bundle?.errors || project.state.errors || []).length} error(s)
          </div>
          <table className="kvtable">
            <tbody>
              {(bundle?.runs || project.state.runs || [])
                .slice()
                .reverse()
                .map((r) => (
                  <tr key={r.id}>
                    <td>{r.kind}</td>
                    <td>{r.status}</td>
                    <td className="muted small">
                      {new Date(r.startedAt).toLocaleTimeString()} · {r.ms ? `${(r.ms / 1000).toFixed(1)}s` : '—'} ·{' '}
                      {r.events ?? 0} events
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
          {(bundle?.errors || project.state.errors || []).length > 0 && (
            <div className="errors-lite">
              {(bundle?.errors || project.state.errors || [])
                .slice(-6)
                .reverse()
                .map((e, i) => (
                  <div className="err-line" key={i}>
                    <b>{e.name || 'Error'}</b>: {e.message || '(no message)'}
                    <span className="muted small"> · {e.where || '?'}</span>
                  </div>
                ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
