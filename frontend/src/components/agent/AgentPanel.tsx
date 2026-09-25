import { useEffect, useRef, useState, useCallback } from 'react';
import {
  Bot,
  Brain,
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
  AtSign,
  Zap,
  Layers,
  Code2,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { getApiBase } from '../../lib/apiBase';
import { useProjectStore } from '../../store/useProjectStore';
import { useSimulatorStore } from '../../store/useSimulatorStore';
import { useEditorStore } from '../../store/useEditorStore';
import { CATALOG_SIZE, PLACEABLE_SIZE, catalog } from '../../agent/catalog';
import { useAgentJournal, type Revision } from '../../agent/journal';
import { forgeSession, newForgeSession, runAgent, sendFeedback as sendFeedbackApi } from '../../agent/runner';
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
import { CreativePanel } from '../creative/CreativePanel';
import './AgentPanel.css';

interface ProviderInfo {
  id: string;
  label: string;
  model: string;
  configured: boolean;
}
interface Status {
  configured: boolean;
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

interface ForgeStatus {
  enabled: boolean;
  live: boolean;
  autostart: boolean;
  forge_present: boolean;
  base_url: string;
  providers: { jev?: string; planner?: string };
  sessions: number;
}
interface ForgeMemory {
  enabled: boolean;
  conversation_id: string | null;
  notes: { kind: string; status: string; domain?: string; text: string; reason?: string }[];
  checks?: { stage: string; status: string; label: string }[];
  error?: string;
  message?: string;
}
async function fetchForgeStatus(signal?: AbortSignal): Promise<ForgeStatus | null> {
  try {
    const response = await fetch(`${getApiBase()}/agent/forge`, { signal });
    if (!response.ok) return null;
    return (await response.json()) as ForgeStatus;
  } catch {
    return null;
  }
}

interface RunRecord {
  run_id: string;
  started_at: number;
  duration_s: number;
  outcome: string;
  provider: string;
  attempts: number;
  provider_calls: number;
  tool_calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  provider_ms: number;
  compile_ms: number;
  error: string;
}

async function fetchAgentRuns(signal?: AbortSignal): Promise<RunRecord[]> {
  const response = await fetch(`${getApiBase()}/agent/runs/records`, { signal });
  if (!response.ok) throw new Error('Could not read the server run log.');
  const body = await response.json();
  return body.runs ?? [];
}

// Cursor-like suggestions with all boards and components
const suggestions = [
  {
    icon: '◉',
    title: 'Make something blink',
    prompt:
      'Build an Arduino Uno circuit with a red LED blinking every half second. Include a series resistor and serial diagnostics.',
    board: 'arduino-uno',
  },
  {
    icon: '⌁',
    title: 'Turn a dial into light',
    prompt:
      'Build a potentiometer-controlled LED dimmer with Arduino Uno. Read the potentiometer on A0 and drive the LED using PWM with a series resistor.',
    board: 'arduino-uno',
  },
  {
    icon: '⌘',
    title: 'ESP32 WiFi Blink',
    prompt:
      'Build an ESP32 DevKit circuit with built-in LED blinking and WiFi status print. Use GPIO 2 for LED, include WiFi scan and connect to Velxio-GUEST.',
    board: 'esp32',
  },
  {
    icon: '⚡',
    title: 'Pico Sensor Dashboard',
    prompt:
      'Build a Raspberry Pi Pico circuit with DHT22 temperature sensor and SSD1306 OLED display. Show temperature and humidity on display with I2C.',
    board: 'raspberry-pi-pico',
  },
  {
    icon: '🤖',
    title: 'Give a button a voice',
    prompt:
      'Build a button-controlled buzzer with Arduino Uno. Play a tone while the button is pressed, using INPUT_PULLUP. Print button changes to Serial.',
    board: 'arduino-uno',
  },
  {
    icon: '🔌',
    title: 'STM32 Servo Control',
    prompt:
      'Build an STM32 BluePill circuit with servo on PA0 and potentiometer on PA1. Control servo angle with pot, use PWM.',
    board: 'stm32-bluepill',
  },
];

export function AgentPanel() {
  const [open, setOpen] = useState(true);
  const [tab, setTab] = useState<'chat' | 'history' | 'create'>('chat');
  const [prompt, setPrompt] = useState('');
  const [providerId, setProviderId] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [statusError, setStatusError] = useState('');
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState('');
  const [plan, setPlan] = useState<string[]>([]);
  const [diagnostics, setDiagnostics] = useState<string[]>([]);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [notice, setNotice] = useState('');
  const [pendingRestore, setPendingRestore] = useState<Revision | null>(null);
  const [lastUserPrompt, setLastUserPrompt] = useState('');
  const [lastRunFailed, setLastRunFailed] = useState(false);
  const [forge, setForge] = useState<ForgeStatus | null>(null);
  const [forgeBusy, setForgeBusy] = useState(false);
  const [forgeNote, setForgeNote] = useState('');
  const [forgeMemory, setForgeMemory] = useState<ForgeMemory | null>(null);
  const [forgeClarification, setForgeClarification] = useState<string | null>(null);
  const [forgeQuestions, setForgeQuestions] = useState<string[]>([]);
  const [showClarification, setShowClarification] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const feedbackSent = useRef<Set<string>>(new Set());
  const [fastMode, setFastMode] = useState(false); // Default OFF now - real compile like Cursor
  const [startTime, setStartTime] = useState(0);
  const [activities, setActivities] = useState<string[]>([]);
  const [elapsed, setElapsed] = useState('0.0');
  const [showMentions, setShowMentions] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [cursorMode, setCursorMode] = useState<'chat' | 'composer' | 'agent'>('agent'); // Cursor modes

  useEffect(() => {
    if (!busy) return;
    const interval = setInterval(() => {
      setElapsed(((Date.now() - startTime) / 1000).toFixed(1));
    }, 100);
    return () => clearInterval(interval);
  }, [busy, startTime]);
  
  useProjectStore((s) => s.currentProject?.id ?? s.currentExampleId);
  const journal = useAgentJournal();
  const scope = scopeKey();
  const messages = journal.messages.filter((m) => m.scope === scope);
  const revisions = journal.revisions.filter((r) => r.scope === scope);
  const running = useSimulatorStore((s) => s.running);
  const editorFiles = useEditorStore((s) => s.files);
  const components = useSimulatorStore((s) => s.components);
  const boards = useSimulatorStore((s) => s.boards);

  // Cursor-like event listeners for inline edit
  useEffect(() => {
    const handleInlineEdit = (e: any) => {
      const { prompt: p, selectedText, fileName } = e.detail;
      const context = selectedText ? `File ${fileName} selection:\n\`\`\`\n${selectedText}\n\`\`\`\n\nRequest: ${p}` : p;
      setPrompt(context);
      input.current?.focus();
      setNotice(`⌘K inline edit: ${p} ${fileName ? `in ${fileName}` : ''}`);
    };
    const handleFocusChat = (e: any) => {
      const { prompt: p, context } = e.detail || {};
      if (p) setPrompt(p);
      setOpen(true);
      setTab('chat');
      setTimeout(() => input.current?.focus(), 100);
      if (context) setNotice(`⌘L added to chat: ${context.slice(0,60)}...`);
    };
    const handleComposer = (e: any) => {
      setCursorMode('composer');
      setOpen(true);
      setTab('chat');
      setNotice('⌘I Composer mode: multi-file circuit+code edits enabled');
    };
    
    window.addEventListener('velxio-cursor-inline-edit', handleInlineEdit);
    window.addEventListener('velxio-cursor-focus-chat', handleFocusChat);
    window.addEventListener('velxio-cursor-composer', handleComposer);
    return () => {
      window.removeEventListener('velxio-cursor-inline-edit', handleInlineEdit);
      window.removeEventListener('velxio-cursor-focus-chat', handleFocusChat);
      window.removeEventListener('velxio-cursor-composer', handleComposer);
    };
  }, []);

  async function checkStatus(signal?: AbortSignal) {
    try {
      const s = await fetchAgentStatus(signal);
      setStatus(s);
      setStatusError('');
      if (s.configured) void loadRuns();
    } catch (error) {
      if (!signal?.aborted)
        setStatusError(error instanceof Error ? error.message : 'Could not connect to agent.');
    }
  }

  async function loadRuns() {
    try {
      setRuns(await fetchAgentRuns());
    } catch {}
  }
  async function checkForge() {
    setForge(await fetchForgeStatus());
  }
  async function toggleForgeMemory(enabled: boolean) {
    setForgeBusy(true);
    try {
      const response = await fetch(`${getApiBase()}/agent/forge/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      if (response.ok) setForge((await response.json()) as ForgeStatus);
      else setForge((await fetchForgeStatus()) ?? forge);
    } catch {} finally {
      setForgeBusy(false);
    }
  }
  async function showForgeMemory() {
    try {
      const response = await fetch(
        `${getApiBase()}/agent/forge/memory?session=${encodeURIComponent(forgeSession())}`,
      );
      if (response.ok) setForgeMemory((await response.json()) as ForgeMemory);
      else setForgeMemory({ enabled: false, conversation_id: null, notes: [], message: 'Forge memory is unavailable right now.' });
    } catch {
      setForgeMemory({ enabled: false, conversation_id: null, notes: [], message: 'Could not reach forge memory.' });
    }
  }
  useEffect(() => {
    void checkForge();
  }, []);
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

  // @ mentions handler
  const handlePromptChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setPrompt(val);
    
    // Check for @ trigger
    const cursorPos = e.target.selectionStart;
    const textBefore = val.slice(0, cursorPos);
    const atMatch = textBefore.match(/@([a-zA-Z0-9_-]*)$/);
    if (atMatch) {
      setMentionQuery(atMatch[1].toLowerCase());
      setShowMentions(true);
    } else {
      setShowMentions(false);
    }
  };
  
  const insertMention = (name: string) => {
    const textarea = input.current;
    if (!textarea) return;
    const cursorPos = textarea.selectionStart;
    const textBefore = prompt.slice(0, cursorPos);
    const textAfter = prompt.slice(cursorPos);
    const atIndex = textBefore.lastIndexOf('@');
    if (atIndex >= 0) {
      const newText = textBefore.slice(0, atIndex) + `@${name} ` + textAfter;
      setPrompt(newText);
      setShowMentions(false);
      setTimeout(() => {
        textarea.focus();
        textarea.setSelectionRange(atIndex + name.length + 2, atIndex + name.length + 2);
      }, 0);
    }
  };

  async function submit(text = prompt) {
    if (!text.trim() || controller.current) return;
    if (!status?.configured) {
      setSettingsOpen(true);
      return;
    }
    const content = text.trim();
    const requestScope = scope;
    const context = messages.slice(-12);
    journal.addMessage({ role: 'user', content, scope: requestScope });
    setLastUserPrompt(content);
    setLastRunFailed(false);
    setPrompt('');
    setBusy(true);
    setStartTime(Date.now());
    setActivities([]);
    setNotice('');
    setPlan([]);
    setDiagnostics([]);
    setTab('chat');
    setStage('Reading current code and circuit');
    feedbackSent.current = new Set();
    const abort = new AbortController();
    controller.current = abort;
    const timeout = setTimeout(() => abort.abort(), 260000);
    let failed = false;
    try {
      const answer = await runAgent({
        prompt: content,
        messages: context,
        provider: providerId || 'bedrock',
        fastMode,
        signal: abort.signal,
        onEvent: (event: AgentEvent) => {
          if (event.type === 'stage') {
            const msg = `${event.message}${event.attempt ? ` · attempt ${event.attempt}` : ''}`;
            setStage(msg);
            setActivities((prev) => [...prev, `⚙️ ${msg}`]);
          }
          if (event.type === 'heartbeat') {
            // Ticks every few seconds while a provider call is in flight.
            // The stage line carries the live detail; the feed keeps ONE
            // heartbeat row (updated in place) so real actions are not pushed
            // out of the 4-line window by noise.
            const msg = `⏳ ${event.message}`;
            setStage(msg);
            setActivities((prev) =>
              prev.length > 0 && prev[prev.length - 1].startsWith('⏳')
                ? [...prev.slice(0, -1), msg]
                : [...prev, msg],
            );
          }
          if (event.type === 'retry') {
            const msg = `⟳ ${event.message}`;
            setStage(msg);
            setActivities((prev) => [...prev, msg]);
          }
          if (event.type === 'canvas_update') {
            const msg = event.label || '🧩 Updating canvas live...';
            setStage(msg);
            setActivities((prev) => [...prev, msg]);
          }
          if (event.type === 'tools') {
            const msg = `Consulted ${event.calls.map((c) => c.tool).join(', ')}`;
            setStage(msg);
            setActivities((prev) => [...prev, `🛠️ ${msg}`]);
          }
          if (event.type === 'plan') setPlan(event.plan);
          if (event.type === 'forge') {
            const summary = event.summary ?? {} as any;
            const evAny = event as any;
            const clar = evAny.clarification as string | undefined;
            const pqs = (evAny.pending_questions as string[] | undefined) || [];
            if (evAny.status === 'ok' && (clar || pqs.length)) {
              const hasQuestionMark = !!(clar && clar.includes('?'));
              const hasQuestions = pqs.length > 0 || hasQuestionMark;
              if (hasQuestions && clar && clar.trim().length > 20) {
                setForgeClarification(clar);
                setForgeQuestions(pqs);
                setShowClarification(true);
                journal.addMessage({ role: 'assistant', content: `**JEV Clarification (Forge):**\n\n${clar}`, scope: requestScope });
              } else if (pqs.length) {
                const combined = pqs.map((q, i) => `${i+1}. ${q}`).join('\n');
                const content = `**JEV has ${pqs.length} open question(s) for this build:**\n\n${combined}\n\nAnswer in chat, or skip to coding.`;
                setForgeClarification(content);
                setForgeQuestions(pqs);
                setShowClarification(true);
                journal.addMessage({ role: 'assistant', content, scope: requestScope });
              }
            }
            setForgeNote(
              event.status === 'ok'
                ? `forge memory · ${Number(summary.active_notes ?? 0)} active note(s) · ${
                    (summary as any).withheld ? 'draft held by JEV check' : 'JEV-checked'
                  }`
                : `forge memory unavailable: ${event.message || 'service offline'} — the agent continues without it`,
            );
            void checkForge();
          }
          if (event.type === 'diagnostic') setDiagnostics((v) => [...v, event.message]);
          if (event.type === 'compile' && !event.success && event.stderr)
            setDiagnostics((v) => [...v, event.stderr]);
          if (event.type === 'note') {
            if (!feedbackSent.current.has(event.message)) {
              feedbackSent.current.add(event.message);
              journal.addMessage({ role: 'user', content: event.message, scope: requestScope });
            }
          }
          if (event.type === 'error' && event.diagnostics)
            setDiagnostics((v) => [...v, event.diagnostics!]);
        },
      });
      journal.addMessage({ role: 'assistant', content: answer, scope: requestScope });
    } catch (error) {
      failed = true;
      const message = abort.signal.aborted
        ? 'Agent stopped. No further edits will be applied. If a compiled checkpoint was already applied, it remains available in Checkpoints for undo.'
        : error instanceof Error
          ? error.message
          : 'Something went wrong. Please retry.';
      journal.addMessage({ role: 'assistant', content: message, scope: requestScope, error: true });
    } finally {
      clearTimeout(timeout);
      controller.current = null;
      setBusy(false);
      setStage('');
      setLastRunFailed(failed && !abort.signal.aborted);
      void loadRuns();
    }
  }

  async function sendNote(text: string) {
    const note = text.trim();
    if (!note) return;
    feedbackSent.current.add(note);
    journal.addMessage({ role: 'user', content: note, scope });
    const ok = await sendFeedbackApi(note);
    if (!ok && busy) {}
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
          title="Open circuit agent (Ctrl+Shift+L) - Velxio = Cursor"
          aria-label="Open circuit agent"
        >
          <MessageSquare size={21} />
          <span>CURSOR</span>
        </button>
        {busy && <LoaderCircle size={16} className="agent-spin" />}
      </aside>
    );

  // Filter mentions
  const allMentionables = [
    ...editorFiles.map(f => ({ id: f.name, label: f.name, type: 'file', icon: '📄' })),
    ...components.map(c => ({ id: c.id, label: `${c.id} (${c.metadataId})`, type: 'component', icon: '🔌' })),
    ...boards.map(b => ({ id: b.id, label: `${b.id} - ${b.boardKind}`, type: 'board', icon: '💻' })),
    ...Object.keys(catalog.parts).filter(id => id.toLowerCase().includes(mentionQuery)).slice(0,8).map(id => ({ id, label: id, type: 'part', icon: '🧩' })),
  ].filter(m => !mentionQuery || m.id.toLowerCase().includes(mentionQuery) || m.label.toLowerCase().includes(mentionQuery)).slice(0,12);

  return (
    <aside className="agent-panel" aria-label="Circuit agent - Velxio = Cursor">
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
          <button
            role="tab"
            aria-selected={tab === 'create'}
            onClick={() => setTab('create')}
            className={tab === 'create' ? 'active' : ''}
            title="Wireup Create"
          >
            <Sparkles size={14} /> CREATE
          </button>
        </div>
        <div className="agent-header-actions">
          <button
            title="New conversation (new forge session)"
            aria-label="New conversation"
            disabled={busy}
            onClick={() => {
              journal.clearMessages(scope);
              newForgeSession();
              setForgeClarification(null);
              setForgeQuestions([]);
              setShowClarification(false);
              setForgeNote('');
              setNotice('New chat started — new forge session created');
              setPlan([]);
              setDiagnostics([]);
              setLastRunFailed(false);
              setLastUserPrompt('');
              void checkForge();
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
      {tab === 'create' ? (
        <CreativePanel />
      ) : (
        <>
      <div className="agent-context" style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Cpu size={13} />
          <span>VELXIO = CURSOR</span>
          <strong>{boards[0]?.boardKind || 'Arduino Uno'}</strong>
          <span
            className="agent-scope-badge"
            title={`${PLACEABLE_SIZE} placeable parts, ${CATALOG_SIZE} documented, ${Object.keys(catalog.boards).length} boards`}
          >
            {PLACEABLE_SIZE} parts · {Object.keys(catalog.boards).length} boards
          </span>
        </div>
        {/* Cursor mode selector */}
        <div style={{ display: 'flex', gap: '4px' }}>
          <button 
            onClick={() => setCursorMode('chat')}
            style={{ 
              padding: '2px 8px', 
              borderRadius: '4px', 
              border: '1px solid',
              borderColor: cursorMode === 'chat' ? '#007acc' : '#333',
              background: cursorMode === 'chat' ? '#007acc22' : 'transparent',
              color: cursorMode === 'chat' ? '#007acc' : '#888',
              fontSize: '10px',
              cursor: 'pointer',
            }}
          >
            <MessageSquare size={10} style={{ display: 'inline', marginRight: '3px' }} />CHAT ⌘L
          </button>
          <button 
            onClick={() => setCursorMode('composer')}
            style={{ 
              padding: '2px 8px', 
              borderRadius: '4px', 
              border: '1px solid',
              borderColor: cursorMode === 'composer' ? '#007acc' : '#333',
              background: cursorMode === 'composer' ? '#007acc22' : 'transparent',
              color: cursorMode === 'composer' ? '#007acc' : '#888',
              fontSize: '10px',
              cursor: 'pointer',
            }}
          >
            <Layers size={10} style={{ display: 'inline', marginRight: '3px' }} />COMPOSER ⌘I
          </button>
          <button 
            onClick={() => setCursorMode('agent')}
            style={{ 
              padding: '2px 8px', 
              borderRadius: '4px', 
              border: '1px solid',
              borderColor: cursorMode === 'agent' ? '#007acc' : '#333',
              background: cursorMode === 'agent' ? '#007acc22' : 'transparent',
              color: cursorMode === 'agent' ? '#007acc' : '#888',
              fontSize: '10px',
              cursor: 'pointer',
            }}
          >
            <Zap size={10} style={{ display: 'inline', marginRight: '3px' }} />AGENT
          </button>
        </div>
      </div>

      {settingsOpen && (
        <section className="agent-settings">
          <div className="agent-section-title">
            <Settings2 size={14} /> CONNECTION{' '}
            <button onClick={() => setSettingsOpen(false)} aria-label="Close settings">
              <X size={14} />
            </button>
          </div>
          <p><strong>Velxio = Cursor for Hardware</strong> — Full Cursor IDE experience for electronics.</p>
          <p>• <b>⌘K</b> Inline Edit in editor • <b>⌘L</b> Add selection to Chat • <b>⌘I</b> Composer (multi-file) • <b>Tab</b> Accept autocomplete • <b>@</b> Mention files/components</p>
          <p className="agent-muted">
            Providers are configured on the server. Pick one in the dropdown next to the composer.
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
          <div className="agent-section-title">
            <Brain size={14} /> FORGE · PROJECT MEMORY (JEV)
          </div>
          <p className="agent-muted">
            Opt-in governed memory: the same LLM proposes project notes, JEV reviews grounding, conflicts and rule changes.
          </p>
          <label className="agent-forge-toggle">
            <input
              type="checkbox"
              checked={!!forge?.enabled}
              disabled={forgeBusy}
              onChange={(e) => void toggleForgeMemory(e.target.checked)}
            />
            <span>Use forge project memory in agent runs</span>
          </label>
          {forge && (
            <p className="agent-muted">
              <Circle
                size={9}
                style={{ color: forge.live ? '#3fb950' : forge.enabled ? '#d29922' : '#8b949e' }}
              />{' '}
              {forge.live
                ? `connected to ${forge.base_url} · JEV: ${forge.providers.jev ?? 'unknown'}`
                : forge.enabled
                  ? 'not reachable yet — starting/watching forge/server'
                  : 'disabled — agent runs without project memory'}
            </p>
          )}
          {forge?.enabled && (
            <button className="agent-secondary" onClick={() => void showForgeMemory()}>
              {forgeMemory?.notes?.length
                ? `Refresh memory (${forgeMemory.notes.length} note${forgeMemory.notes.length === 1 ? '' : 's'})`
                : 'Show active project memory'}
            </button>
          )}
          {forgeMemory && (
            <details open className="agent-forge-memory">
              <summary>Project memory {forgeMemory.conversation_id ? `· ${forgeMemory.conversation_id}` : ''}</summary>
              {forgeMemory.message && <p className="agent-muted">{forgeMemory.message}</p>}
              {forgeMemory.error && <p className="agent-muted">{forgeMemory.error}</p>}
              {forgeMemory.notes.map((n, i) => (
                <p key={i} className="agent-muted">
                  [{n.status === 'active' ? n.kind : `${n.kind}?`}] {n.text}
                </p>
              ))}
              {(forgeMemory.checks ?? []).slice(-3).map((c, i) => (
                <p key={`c${i}`} className="agent-muted">
                  JEV · {c.stage}: {c.label}
                </p>
              ))}
            </details>
          )}
          <button className="agent-secondary" onClick={() => void checkStatus()}>
            Check connection
          </button>
          <details>
            <summary>All Supported Boards ({Object.keys(catalog.boards).length})</summary>
            <pre style={{ fontSize: '11px', maxHeight: '200px', overflow: 'auto' }}>
              {Object.entries(catalog.boards).map(([id, b]: any) => `${id}: ${b.label} (${b.pins?.length || 0} pins)`).join('\n')}
            </pre>
          </details>
          <details>
            <summary>Server setup</summary>
            <pre>
              AGENT_ENABLED=true{'\n'}AGENT_OPENCODE_BASE_URL=http://127.0.0.1:4096{'\n'}AGENT_OPENCODE_MODEL=big-pickle{'\n'}
              BEDROCK_MODEL_ID=your-bedrock-model-id{'\n'}AWS_REGION=us-east-1{'\n'}
            </pre>
          </details>
        </section>
      )}

      {(statusError || status?.configured === false) && (
        <div className="agent-connection-note">
          <AlertCircle size={15} />
          <span>
            {statusError || 'Connect a model to bring your ideas to life.'}{' '}
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
                <div className="agent-eyebrow">VELXIO = CURSOR FOR HARDWARE</div>
                <h2>
                  From an idea
                  <br />
                  to a running circuit.
                </h2>
                <p>
                  <strong>Cursor features now in Velxio:</strong><br/>
                  <code>⌘K</code> Inline Edit • <code>⌘L</code> Chat • <code>⌘I</code> Composer • <code>Tab</code> Complete • <code>@</code> Mentions
                  <br/><br/>
                  Describe what you want to build.
                  <br />
                  I'll wire it, write the code, and run it — any board, any component.
                </p>
                <div className="agent-suggestions">
                  {suggestions.map((s) => (
                    <button
                      key={s.title}
                      onClick={() => {
                        setPrompt(s.prompt);
                        input.current?.focus();
                      }}
                      style={{ position: 'relative' }}
                    >
                      <span>{s.icon}</span>
                      <strong>{s.title}</strong>
                      <span style={{ fontSize: '9px', opacity: 0.6, marginLeft: 'auto' }}>{s.board}</span>
                      <ChevronRight size={14} />
                    </button>
                  ))}
                </div>
                <div className="agent-capabilities">
                  <span>
                    <Check size={12} /> 30 boards (Uno, ESP32, Pico, STM32, Pi)
                  </span>
                  <span>
                    <Check size={12} /> 157 components (all Velxio parts)
                  </span>
                  <span>
                    <Check size={12} /> Cursor: ⌘K, ⌘L, ⌘I, Tab, @mentions
                  </span>
                  <span>
                    <Check size={12} /> Real compilation (no fake hex)
                  </span>
                  <span>
                    <Check size={12} /> Undo any checkpoint
                  </span>
                </div>
                <p className="agent-small">
                  Velxio is now Cursor for hardware. Works with Arduino, ESP32, RP2040, STM32, Pi. 
                  Select code and press ⌘K for inline edit, ⌘L to add to chat, ⌘I for composer multi-file edits.
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
                    <strong>{message.role === 'user' ? 'You' : cursorMode === 'composer' ? 'Composer' : cursorMode === 'agent' ? 'Agent' : 'Chat'}</strong>
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
              <div className="agent-progress-dashboard" role="status" aria-live="polite">
                <div className="agent-progress-banner">
                  <div className="agent-banner-title">
                    <Sparkles size={14} className="agent-spin" />
                    <strong>⚡ CURSOR AGENT BUILDING</strong>
                  </div>
                  <span className="agent-timer-chip">
                    <Clock3 size={11} /> {elapsed}s
                  </span>
                </div>

                <div className="agent-stepper">
                  <div className={`agent-step ${stage.includes('Reading') || stage.includes('planning') ? 'is-active' : 'is-done'}`}>
                    <span>1</span> Think
                  </div>
                  <div className={`agent-step ${stage.includes('Dropping') || stage.includes('validating') ? 'is-active' : stage.includes('Routing') || stage.includes('compiling') || stage.includes('Compiling') ? 'is-done' : ''}`}>
                    <span>2</span> Parts
                  </div>
                  <div className={`agent-step ${stage.includes('Routing') ? 'is-active' : stage.includes('compiling') || stage.includes('Compiling') ? 'is-done' : ''}`}>
                    <span>3</span> Wires
                  </div>
                  <div className={`agent-step ${stage.includes('compiling') || stage.includes('Compiling') ? 'is-active' : ''}`}>
                    <span>4</span> Code
                  </div>
                </div>

                <div className="agent-stage-msg">
                  <LoaderCircle size={14} className="agent-spin" />
                  <span>{stage}</span>
                </div>

                {activities.length > 0 && (
                  <div className="agent-activity-feed">
                    <div className="agent-feed-title">Live Actions (Cursor-style):</div>
                    <ul>
                      {activities.slice(-4).map((act, i) => (
                        <li key={i}>{act}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {plan.length > 0 && (
                  <ol className="agent-plan-list">
                    {plan.map((p, i) => (
                      <li key={`${i}-${p}`}>
                        <span>{i + 1}</span>
                        {p}
                      </li>
                    ))}
                  </ol>
                )}
                <small>
                  {cursorMode === 'composer' ? 'Composer: editing multiple files...' : 'Components drop onto canvas immediately (Cursor-like)'}
                </small>
              </div>
            )}
            {showClarification && forgeClarification && (
              <div className="agent-forge-clarify" style={{border:'1px solid #3fb950', borderRadius:8, padding:12, margin:'8px 0', background:'rgba(63,185,80,0.08)'}}>
                <div style={{display:'flex', alignItems:'center', gap:8, marginBottom:8}}>
                  <Brain size={14} />
                  <strong>JEV is asking for clarification</strong>
                  <span style={{marginLeft:'auto', fontSize:11, opacity:0.7}}>{forgeQuestions.length} question(s)</span>
                </div>
                <div style={{maxHeight:200, overflowY:'auto', marginBottom:10, fontSize:13}}>
                  <ReactMarkdown>{forgeClarification}</ReactMarkdown>
                </div>
                {forgeQuestions.length>0 && (
                  <ul style={{margin:'0 0 10px 18px', fontSize:13}}>
                    {forgeQuestions.map((q,i)=><li key={i}>{q}</li>)}
                  </ul>
                )}
                <div style={{display:'flex', gap:8, flexWrap:'wrap'}}>
                  <button className="agent-secondary" onClick={() => { input.current?.focus(); }} style={{fontSize:13}}>
                    Answer in chat
                  </button>
                  <button className="agent-primary" onClick={() => {
                    const skipNote = 'Skip clarification — proceed to coding with best assumptions. Use sensible defaults for any open questions.';
                    if (busy) { void sendNote(skipNote); } else { setPrompt(skipNote); }
                    setShowClarification(false);
                    setNotice('Skipped clarification — coding with best assumptions');
                  }} style={{fontSize:13, background:'#3fb950', color:'#000', border:'none', padding:'6px 12px', borderRadius:6, cursor:'pointer'}}>
                    Skip to coding →
                  </button>
                  <button className="agent-secondary" onClick={() => setShowClarification(false)} style={{fontSize:12}}>
                    Dismiss
                  </button>
                </div>
              </div>
            )}
            {!busy && forgeNote && (
              <p className="agent-muted" role="status">
                <Brain size={12} /> {forgeNote}
              </p>
            )}
            {diagnostics.length > 0 && (
              <details className="agent-diagnostics" open={busy}>
                <summary>
                  Repair log ({diagnostics.length})
                  {busy && <span className="agent-diagnostics-hint">self-repairing…</span>}
                </summary>
                <pre>{diagnostics.slice(-6).join('\n\n')}</pre>
              </details>
            )}
            {runs.length > 0 && (
              <details className="agent-diagnostics">
                <summary>Server log ({runs.length} run{runs.length === 1 ? '' : 's'})</summary>
                <table className="agent-run-table">
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Outcome</th>
                      <th>Provider</th>
                      <th>Dur</th>
                      <th>Calls</th>
                      <th>Tokens</th>
                      <th>Prov ms</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.slice(0, 10).map((r) => (
                      <tr key={r.run_id}>
                        <td>{new Date(r.started_at * 1000).toLocaleTimeString()}</td>
                        <td className={`agent-run-outcome ${r.outcome}`}>{r.outcome}</td>
                        <td>{r.provider}</td>
                        <td>{r.duration_s}s</td>
                        <td>{r.provider_calls}</td>
                        <td>{r.prompt_tokens}→{r.completion_tokens}</td>
                        <td>{r.provider_ms}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {runs[0]?.error && <pre className="agent-runs-error">{runs[0].error}</pre>}
              </details>
            )}
            {!busy && lastRunFailed && lastUserPrompt && (
              <button
                className="agent-retry"
                onClick={() => void submit(lastUserPrompt)}
              >
                <RotateCcw size={13} /> Retry last request
              </button>
            )}
          </>
        ) : (
          <section className="agent-history">
            <div className="agent-history-heading">
              <h3>Project checkpoints (Cursor-like)</h3>
              <button
                title="Download current project"
                aria-label="Download current project"
                onClick={() => triggerDownloadVlx()}
              >
                <Download size={16} />
              </button>
            </div>
            <p>
              Code and circuit, saved together. Last 10 checkpoints; download for permanent storage. Like Cursor's timeline.
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
              Restores this checkpoint's code and circuit and stops the simulation.
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
          if (busy) void sendNote(prompt);
          else void submit();
        }}
      >
        {/* @ mentions dropdown - Cursor-like */}
        {showMentions && allMentionables.length > 0 && (
          <div style={{
            background: '#1e1e1e',
            border: '1px solid #333',
            borderRadius: '6px',
            maxHeight: '150px',
            overflow: 'auto',
            marginBottom: '6px',
            fontSize: '12px',
          }}>
            <div style={{ padding: '4px 8px', color: '#666', fontSize: '10px', borderBottom: '1px solid #222' }}>
              <AtSign size={10} style={{ display: 'inline', marginRight: '4px' }} />@ MENTIONS — files, components, boards, parts
            </div>
            {allMentionables.map((m) => (
              <button
                key={`${m.type}-${m.id}`}
                type="button"
                onClick={() => insertMention(m.id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  width: '100%',
                  textAlign: 'left',
                  padding: '4px 8px',
                  background: 'transparent',
                  border: 'none',
                  color: '#ccc',
                  cursor: 'pointer',
                  fontSize: '12px',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = '#2a2a2a')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                <span>{m.icon}</span>
                <span>{m.label}</span>
                <span style={{ marginLeft: 'auto', fontSize: '9px', opacity: 0.5 }}>{m.type}</span>
              </button>
            ))}
          </div>
        )}
        
        <div className={`agent-input-box ${busy ? 'is-busy' : ''}`}>
          <textarea
            ref={input}
            aria-label={busy ? 'Send a note to the running agent' : 'Describe a circuit or request a change - @ to mention files'}
            value={prompt}
            maxLength={6000}
            rows={busy ? 2 : 3}
            placeholder={
              busy
                ? 'Add a note or correction — sent to the agent mid-run…'
                : cursorMode === 'composer'
                  ? 'Composer: describe multi-file changes... Use @ to mention files'
                  : messages.length
                    ? 'What should we change next? @ to mention files/components'
                    : 'Describe a circuit to build… @ for files • ⌘K inline • ⌘I composer'
            }
            onChange={handlePromptChange}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                if (showMentions) {
                  // If mentions open, first mention selected on Enter? For simplicity, close and submit
                  setShowMentions(false);
                }
                e.preventDefault();
                if (busy) {
                  void sendNote(prompt);
                  setPrompt('');
                } else {
                  void submit();
                }
              }
              if (e.key === 'Escape' && showMentions) {
                setShowMentions(false);
              }
            }}
          />
          <div className="agent-input-toolbar">
            <span>
              {cursorMode === 'chat' && <MessageSquare size={12} />}
              {cursorMode === 'composer' && <Layers size={12} />}
              {cursorMode === 'agent' && <Zap size={12} />}
              {cursorMode.toUpperCase()} <ChevronRight size={11} />
              <button
                type="button"
                className={`agent-fast-badge ${!fastMode ? 'active' : ''}`}
                title="Real compilation (Cursor-like, no fake hex) - recommended"
                onClick={() => setFastMode(!fastMode)}
                style={{ 
                  background: !fastMode ? '#2ea04322' : 'transparent',
                  borderColor: !fastMode ? '#2ea043' : '#333',
                  color: !fastMode ? '#2ea043' : '#666',
                }}
              >
                ✓ Real Compile
              </button>
              <button
                type="button"
                className={`agent-fast-badge ${fastMode ? 'active' : ''}`}
                title="Fast Mode: quicker but may timeout"
                onClick={() => setFastMode(!fastMode)}
                style={{ marginLeft: '4px' }}
              >
                ⚡ Fast
              </button>
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
                <span>{busy ? 'Steer me' : 'Velxio = Cursor'}</span>
              )}
            </span>
            {busy ? (
              <div className="agent-busy-actions">
                <button
                  type="submit"
                  className="agent-note-send"
                  disabled={!prompt.trim()}
                  aria-label="Send note to agent"
                  title="Send note (Enter)"
                >
                  <Send size={13} /> Note
                </button>
                <button
                  type="button"
                  className="agent-stop"
                  onClick={() => controller.current?.abort()}
                  title="Stop agent"
                >
                  <Square size={12} fill="currentColor" /> Stop
                </button>
              </div>
            ) : (
              <button
                type="submit"
                className="agent-send"
                disabled={!prompt.trim()}
                aria-label="Send prompt"
                title="Send (Enter) - @ to mention files"
              >
                <Send size={15} />
              </button>
            )}
          </div>
        </div>
        <div className="agent-composer-hint">
          <span>
            {busy
              ? 'Enter to send a note · notes steer the next repair turn'
              : `⌘K edit · ⌘L chat · ⌘I composer · Tab complete · @ mentions · ${cursorMode} mode`}
          </span>
          <span>
            {prompt.length > 5000 ? `${prompt.length}/6000` : `${Object.keys(catalog.boards).length} boards · ${PLACEABLE_SIZE} parts`}
          </span>
        </div>
      </form>
      <footer className="agent-footer">
        <span>
          <Circle size={7} fill="currentColor" className={status?.configured ? 'connected' : ''} />
          {status?.configured
            ? configuredProviders.find((p) => p.id === providerId)?.model
              ?? status.model
            : 'Model not connected'} · {cursorMode}
        </span>
        <span>
          {busy ? (
            <>
              <Clock3 size={11} /> Working · {elapsed}s
            </>
          ) : running ? (
            <>
              <span className="agent-live-dot" /> Simulation running
            </>
          ) : (
            'Velxio = Cursor • Ready'
          )}
        </span>
      </footer>
        </>
      )}
    </aside>
  );
}
