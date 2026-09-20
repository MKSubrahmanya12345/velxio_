import { useEffect, useRef, useState } from 'react';
import {
  Bot,
  Check,
  ChevronRight,
  Circle,
  Clock3,
  Cpu,
  History,
  MessageSquare,
  Plus,
  RotateCcw,
  Send,
  Settings2,
  Sparkles,
  Square,
  X,
  AlertCircle,
  LoaderCircle,
  FileCode2,
  Download,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { getApiBase } from '../../lib/apiBase';
import { useProjectStore } from '../../store/useProjectStore';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { CATALOG_SIZE, PLACEABLE_SIZE } from '../../agent/catalog';
import { useAgentJournal, type Revision } from '../../agent/journal';
import { runAgent } from '../../agent/runner';
import {
  assertFresh,
  captureWorkspace,
  describeChanges,
  fingerprint,
  loadWorkspace,
  scopeKey,
} from '../../agent/workspace';
import type { AgentEvent } from '../../agent/protocol';
import { triggerDownloadVlx } from '../../utils/vlxFile';
import './AgentPanel.css';

interface ProviderInfo {
  id: string;
  label: string;
  model: string;
  configured: boolean;
}
interface Status {
  configured: boolean;
  requires_token: boolean;
  model: string | null;
  providers: ProviderInfo[];
  scope: string;
}
async function fetchAgentStatus(signal?: AbortSignal): Promise<Status> {
  const response = await fetch(`${getApiBase()}/agent/status`, { signal });
  if (!response.ok)
    throw new Error('Agent backend is unavailable. Start the API server and retry.');
  return response.json();
}

const suggestions = [
  {
    icon: '◉',
    title: 'Make something blink',
    prompt:
      'Build an Arduino Uno circuit with a red LED blinking every half second. Include a series resistor and serial diagnostics.',
  },
  {
    icon: '⌁',
    title: 'Turn a dial into light',
    prompt:
      'Build a potentiometer-controlled LED dimmer with Arduino Uno. Read the potentiometer on A0 and drive the LED using PWM with a series resistor.',
  },
  {
    icon: '⌘',
    title: 'Give a button a voice',
    prompt:
      'Build a button-controlled buzzer with Arduino Uno. Play a tone while the button is pressed, using INPUT_PULLUP. Print button changes to Serial.',
  },
];

export function AgentPanel() {
  const [open, setOpen] = useState(true);
  const [tab, setTab] = useState<'chat' | 'history'>('chat');
  const [prompt, setPrompt] = useState('');
  const [token, setToken] = useState(''); // Never persist provider or access credentials.
  const [providerId, setProviderId] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [statusError, setStatusError] = useState('');
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState('');
  const [plan, setPlan] = useState<string[]>([]);
  const [diagnostics, setDiagnostics] = useState<string[]>([]);
  const [notice, setNotice] = useState('');
  const [pendingRestore, setPendingRestore] = useState<Revision | null>(null);
  const controller = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const journal = useAgentJournal();
  // Re-render on named project/example switches; don't send another project's chat.
  useProjectStore((s) => s.currentProject?.id ?? s.currentExampleId);
  const scope = scopeKey();
  const messages = journal.messages.filter((m) => m.scope === scope);
  const revisions = journal.revisions.filter((r) => r.scope === scope);
  const running = useSimulatorStore((s) => s.running);

  async function checkStatus(signal?: AbortSignal) {
    try {
      setStatus(await fetchAgentStatus(signal));
      setStatusError('');
    } catch (error) {
      if (!signal?.aborted)
        setStatusError(error instanceof Error ? error.message : 'Could not connect to agent.');
    }
  }
  useEffect(() => {
    const abort = new AbortController();
    fetchAgentStatus(abort.signal)
      .then((data) => {
        if (!abort.signal.aborted) setStatus(data);
      })
      .catch((error) => {
        if (!abort.signal.aborted)
          setStatusError(error instanceof Error ? error.message : 'Could not connect to agent.');
      });
    return () => {
      abort.abort();
      controller.current?.abort();
    };
  }, []);
  // Keep the selected provider one of the server-configured list, defaulting
  // to the first one (Groq). Switches are per-session and never persisted.
  const configuredProviders = (status?.providers ?? []).filter((p) => p.configured);
  useEffect(() => {
    if (!configuredProviders.length) return;
    if (!configuredProviders.some((p) => p.id === providerId)) {
      setProviderId(configuredProviders[0].id);
    }
  }, [status, providerId]);
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [journal.messages.length, stage, tab]);
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);

  async function submit(text = prompt) {
    if (!text.trim() || busy || controller.current) return;
    if (!status?.configured || (status.requires_token && !token)) {
      setSettingsOpen(true);
      return;
    }
    const content = text.trim();
    const requestScope = scope;
    const context = messages.slice(-12);
    journal.addMessage({ role: 'user', content, scope: requestScope });
    setPrompt('');
    setBusy(true);
    setNotice('');
    setPlan([]);
    setDiagnostics([]);
    setTab('chat');
    setStage('Reading current code and circuit');
    const abort = new AbortController();
    controller.current = abort;
    // Client bound also handles a hung proxy/stream, not only server work.
    const timeout = setTimeout(() => abort.abort(), 260000);
    try {
      const answer = await runAgent({
        prompt: content,
        messages: context,
        token,
        provider: providerId || 'groq',
        signal: abort.signal,
        onEvent: (event: AgentEvent) => {
          if (event.type === 'stage')
            setStage(`${event.message}${event.attempt ? ` · attempt ${event.attempt}` : ''}`);
          if (event.type === 'tools')
            setStage(
              `Consulted ${event.calls.map((c) => c.tool).join(', ')}`
                + `${event.calls.some((c) => !c.ok) ? ' (some tools failed)' : ''}`,
            );
          if (event.type === 'plan') setPlan(event.plan);
          if (event.type === 'diagnostic') setDiagnostics((v) => [...v, event.message]);
        },
      });
      journal.addMessage({ role: 'assistant', content: answer, scope: requestScope });
    } catch (error) {
      const content = abort.signal.aborted
        ? 'Agent stopped. No further edits will be applied. If a compiled checkpoint was already applied, it remains available in Checkpoints for undo.'
        : error instanceof Error
          ? error.message
          : 'Something went wrong. Please retry.';
      journal.addMessage({ role: 'assistant', content, scope: requestScope, error: true });
    } finally {
      clearTimeout(timeout);
      controller.current = null;
      setBusy(false);
      setStage('');
    }
  }

  function undo(revision: Revision) {
    try {
      assertFresh(fingerprint(revision.after), revision.scope);
      loadWorkspace(revision.before);
      journal.addRevision({
        scope,
        label: `Undo: ${revision.label}`,
        before: revision.after,
        after: captureWorkspace(),
        changes: describeChanges(revision.after, revision.before),
      });
      setNotice('Checkpoint undone. Simulation stopped; previous code and wiring restored.');
    } catch {
      setNotice(
        'Your workspace has changed since this checkpoint. Undo is blocked to protect your edits. You can explicitly restore a checkpoint instead.',
      );
    }
  }
  function restore(revision: Revision) {
    try {
      const before = captureWorkspace();
      loadWorkspace(revision.after);
      journal.addRevision({
        scope,
        label: `Restore: ${revision.label}`,
        before,
        after: captureWorkspace(),
        changes: describeChanges(before, revision.after),
      });
      setNotice('Checkpoint restored. Use Run to compile and restart the simulation.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Checkpoint could not be restored.');
    }
    setPendingRestore(null);
  }

  if (!open)
    return (
      <aside className="agent-rail">
        <button
          onClick={() => setOpen(true)}
          title="Open circuit agent (Ctrl+Shift+L)"
          aria-label="Open circuit agent"
        >
          <MessageSquare size={21} />
          <span>AGENT</span>
        </button>
        {busy && <LoaderCircle size={16} className="agent-spin" />}
      </aside>
    );

  return (
    <aside className="agent-panel" aria-label="Circuit agent">
      <header className="agent-header">
        <div className="agent-tabs" role="tablist" aria-label="Agent views">
          <button
            role="tab"
            aria-selected={tab === 'chat'}
            onClick={() => setTab('chat')}
            className={tab === 'chat' ? 'active' : ''}
          >
            <MessageSquare size={14} /> CHAT
          </button>
          <button
            role="tab"
            aria-selected={tab === 'history'}
            onClick={() => setTab('history')}
            className={tab === 'history' ? 'active' : ''}
          >
            <History size={14} /> CHECKPOINTS {revisions.length > 0 && <b>{revisions.length}</b>}
          </button>
        </div>
        <div className="agent-header-actions">
          <button
            title="New conversation (keeps checkpoints)"
            aria-label="New conversation"
            disabled={busy}
            onClick={() => {
              journal.clearMessages(scope);
              setNotice('');
              setPlan([]);
              setDiagnostics([]);
            }}
          >
            <Plus size={16} />
          </button>
          <button
            title="Agent settings"
            aria-label="Agent settings"
            onClick={() => setSettingsOpen((v) => !v)}
          >
            <Settings2 size={16} />
          </button>
          <button title="Collapse agent" aria-label="Collapse agent" onClick={() => setOpen(false)}>
            <X size={16} />
          </button>
        </div>
      </header>
      <div className="agent-context">
        <Cpu size={13} />
        <span>SUPPORTS</span>
        <strong>Arduino Uno</strong>
        <span
          className="agent-scope-badge"
          title={`${PLACEABLE_SIZE} placeable parts, ${CATALOG_SIZE} documented in the catalog`}
        >
          {PLACEABLE_SIZE} parts
        </span>
      </div>

      {settingsOpen && (
        <section className="agent-settings">
          <div className="agent-section-title">
            <Settings2 size={14} /> CONNECTION{' '}
            <button onClick={() => setSettingsOpen(false)} aria-label="Close settings">
              <X size={14} />
            </button>
          </div>
          <p>The model runs through your backend. Provider keys never enter the browser.</p>
          {status?.requires_token && (
            <label>
              Workspace access token
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Token from your administrator"
                autoComplete="off"
              />
            </label>
          )}
          <p className="agent-muted">
            Providers are configured on the server. Pick one in the dropdown
            next to the composer; the current model is shown in the footer.
            <span>Token held in memory only.</span>
          </p>
          {(status?.providers ?? []).length > 0 && (
            <ul className="agent-provider-list" aria-label="Configured providers">
              {status!.providers.map((p) => (
                <li key={p.id} className={p.id === providerId ? 'active' : ''}>
                  <span>{p.label}</span>
                  <code>{p.model}</code>
                  {p.configured ? <em>ready</em> : <em className="off">needs key</em>}
                </li>
              ))}
            </ul>
          )}
          <button className="agent-secondary" onClick={() => void checkStatus()}>
            Check connection
          </button>
          <details>
            <summary>Server setup</summary>
            <pre>
              AGENT_ENABLED=true{'\n'}AGENT_API_KEY=your-groq-api-key{'\n'}AGENT_MODEL=openai/gpt-oss-120b{'\n'}
              AGENT_GEMINI_API_KEY=your-google-ai-studio-key{'\n'}AGENT_GEMINI_MODEL=gemini-2.5-flash{'\n'}
              BEDROCK_MODEL_ID=moonshotai.kimi-k2.5{'\n'}AWS_REGION=eu-north-1{'\n'}BEDROCK_API_KEY=your-mantle-key{'\n'}
              AGENT_ACCESS_TOKEN=your-private-token
            </pre>
            <p>
              Set these in backend/.env and restart the API. Groq and Gemini
              both expose OpenAI-compatible endpoints; Bedrock uses native
              Converse (or Bedrock Mantle for Kimi K2.5 — that model needs
              BEDROCK_API_KEY). Any configured provider appears in the chat
              dropdown.
            </p>
          </details>
        </section>
      )}

      {(statusError || status?.configured === false || (status?.requires_token && !token)) && (
        <div className="agent-connection-note">
          <AlertCircle size={15} />
          <span>
            {statusError ||
              (status?.configured
                ? 'Enter your workspace token to start building.'
                : 'Connect a model to bring your ideas to life.')}{' '}
            <button onClick={() => setSettingsOpen(true)}>
              Configure agent <ChevronRight size={12} />
            </button>
          </span>
        </div>
      )}

      <div className="agent-scroll" role="tabpanel">
        {tab === 'chat' ? (
          <>
            {!messages.length && (
              <div className="agent-welcome">
                <div className="agent-mark">
                  <Sparkles size={24} />
                </div>
                <div className="agent-eyebrow">YOUR CIRCUIT COPILOT</div>
                <h2>
                  From an idea
                  <br />
                  to a running circuit.
                </h2>
                <p>
                  Describe what you want to build.
                  <br />
                  I’ll wire it, write the code, and run it.
                </p>
                <div className="agent-suggestions">
                  {suggestions.map((s) => (
                    <button
                      key={s.title}
                      onClick={() => {
                        setPrompt(s.prompt);
                        input.current?.focus();
                      }}
                    >
                      <span>{s.icon}</span>
                      <strong>{s.title}</strong>
                      <ChevronRight size={14} />
                    </button>
                  ))}
                </div>
                <div className="agent-capabilities">
                  <span>
                    <Check size={12} /> Automatic wiring
                  </span>
                  <span>
                    <Check size={12} /> Compile & repair
                  </span>
                  <span>
                    <Check size={12} /> Undo any checkpoint
                  </span>
                </div>
                <p className="agent-small">
                  Start with Uno, LEDs, resistors, buttons, potentiometers, and buzzers. Your
                  existing manual edits stay part of the conversation.
                </p>
              </div>
            )}
            <div className="agent-messages" role="log" aria-label="Conversation">
              {messages.map((message) => (
                <article
                  key={message.id}
                  className={`agent-message ${message.role} ${message.error ? 'is-error' : ''}`}
                >
                  <div className="agent-message-label">
                    {message.role === 'user' ? (
                      <span className="agent-avatar">Y</span>
                    ) : (
                      <Bot size={16} />
                    )}
                    <strong>{message.role === 'user' ? 'You' : 'Circuit agent'}</strong>
                    {message.error && <span>Needs attention</span>}
                  </div>
                  <ReactMarkdown
                    components={{
                      a: ({ children, href }) => (
                        <a href={href} target="_blank" rel="noopener noreferrer">
                          {children}
                        </a>
                      ),
                    }}
                  >
                    {message.content}
                  </ReactMarkdown>
                </article>
              ))}
            </div>
            {busy && (
              <div className="agent-progress" role="status" aria-live="polite">
                <div>
                  <LoaderCircle size={15} className="agent-spin" />
                  <strong>{stage}</strong>
                </div>
                {plan.length > 0 && (
                  <ol>
                    {plan.map((p, i) => (
                      <li key={`${i}-${p}`}>
                        <span>{i + 1}</span>
                        {p}
                      </li>
                    ))}
                  </ol>
                )}
                <small>
                  Your workspace stays editable. Conflicting changes won’t be overwritten.
                </small>
              </div>
            )}
            {diagnostics.length > 0 && (
              <details className="agent-diagnostics">
                <summary>Repair diagnostics ({diagnostics.length})</summary>
                <pre>{diagnostics.join('\n\n')}</pre>
              </details>
            )}
            {!busy && messages.at(-1)?.error && (
              <button
                className="agent-retry"
                onClick={() => {
                  const last = [...messages].reverse().find((m) => m.role === 'user');
                  if (last) void submit(last.content);
                }}
              >
                <RotateCcw size={13} /> Retry with current workspace
              </button>
            )}
          </>
        ) : (
          <section className="agent-history">
            <div className="agent-history-heading">
              <h3>Project checkpoints</h3>
              <button
                title="Download current project"
                aria-label="Download current project"
                onClick={() => triggerDownloadVlx()}
              >
                <Download size={16} />
              </button>
            </div>
            <p>
              Code and circuit, saved together. Last 10 checkpoints in this browser tab; download
              your project for permanent storage.
            </p>
            {!revisions.length && (
              <div className="agent-empty-history">
                <History size={28} />
                <h4>A safety net for every build.</h4>
                <p>Your first successful agent edit will appear here.</p>
              </div>
            )}
            {[...revisions].reverse().map((revision, index) => (
              <article key={revision.id} className="agent-revision">
                <div className="agent-revision-top">
                  <span>
                    <FileCode2 size={14} /> {index === 0 ? 'LATEST CHECKPOINT' : 'CHECKPOINT'}
                  </span>
                  <time>
                    {new Date(revision.time).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </time>
                </div>
                <h4>{revision.label}</h4>
                <div className="agent-change-list">
                  {revision.changes.map((c, i) => (
                    <span key={`${i}-${c}`}>{c}</span>
                  ))}
                </div>
                <div className="agent-revision-actions">
                  {index === 0 && (
                    <button disabled={busy} onClick={() => undo(revision)}>
                      <RotateCcw size={13} /> Undo edit
                    </button>
                  )}
                  <button disabled={busy} onClick={() => setPendingRestore(revision)}>
                    <History size={13} /> Restore
                  </button>
                </div>
              </article>
            ))}
          </section>
        )}
        {pendingRestore && (
          <div className="agent-confirm" role="alertdialog" aria-label="Restore checkpoint">
            <strong>Replace the current workspace?</strong>
            <p>
              Restores this checkpoint’s code and circuit and stops the simulation. Your current
              workspace will be saved as an undo checkpoint.
            </p>
            <div>
              <button onClick={() => setPendingRestore(null)}>Cancel</button>
              <button
                className="agent-primary"
                disabled={busy}
                onClick={() => restore(pendingRestore)}
              >
                Restore checkpoint
              </button>
            </div>
          </div>
        )}
        {notice && (
          <div className="agent-notice" role="status">
            {notice}
            <button onClick={() => setNotice('')} aria-label="Dismiss notice">
              <X size={12} />
            </button>
          </div>
        )}
        <div ref={end} />
      </div>

      <form
        className="agent-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className={`agent-input-box ${busy ? 'is-busy' : ''}`}>
          <textarea
            ref={input}
            aria-label="Describe a circuit or request a change"
            value={prompt}
            maxLength={6000}
            rows={3}
            placeholder={
              messages.length ? 'What should we change next?' : 'Describe a circuit to build…'
            }
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void submit();
              }
            }}
          />
          <div className="agent-input-toolbar">
            <span>
              <Sparkles size={12} /> Agent <ChevronRight size={11} />
              {configuredProviders.length > 0 ? (
                <label className="agent-provider-select">
                  <Cpu size={11} />
                  <select
                    value={providerId}
                    disabled={busy}
                    aria-label="Model provider"
                    onChange={(e) => setProviderId(e.target.value)}
                  >
                    {configuredProviders.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label} · {p.model}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <span>Auto-build</span>
              )}
            </span>
            {busy ? (
              <button
                type="button"
                className="agent-stop"
                onClick={() => controller.current?.abort()}
                title="Stop agent"
              >
                <Square size={12} fill="currentColor" /> Stop
              </button>
            ) : (
              <button
                type="submit"
                className="agent-send"
                disabled={!prompt.trim()}
                aria-label="Send prompt"
                title="Send (Enter)"
              >
                <Send size={15} />
              </button>
            )}
          </div>
        </div>
        <div className="agent-composer-hint">
          <span>Enter to send · Shift+Enter for a new line</span>
          <span>
            {prompt.length > 5000 ? `${prompt.length}/6000` : 'Code + circuit in context'}
          </span>
        </div>
      </form>
      <footer className="agent-footer">
        <span>
          <Circle size={7} fill="currentColor" className={status?.configured ? 'connected' : ''} />
          {status?.configured
            ? configuredProviders.find((p) => p.id === providerId)?.model
              ?? status.model
            : 'Model not connected'}
        </span>
        <span>
          {busy ? (
            <>
              <Clock3 size={11} /> Working
            </>
          ) : running ? (
            <>
              <span className="agent-live-dot" /> Simulation running
            </>
          ) : (
            'Ready when you are'
          )}
        </span>
      </footer>
    </aside>
  );
}
