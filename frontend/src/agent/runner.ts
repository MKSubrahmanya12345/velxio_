import { getApiBase } from '../lib/apiBase';
import { runEditorCommand } from '../lib/editorCommands';
import { useSimulatorStore } from '../store/useSimulatorStore';
import { useCompileLogsStore } from '../store/useCompileLogsStore';
import { buildPreflightSnapshot } from '../simulation/verify/verifyFromStore';
import { buildInputFromStore } from '../simulation/spice/storeAdapter';
import { verifyCircuit } from '../simulation/verify/circuitVerifier';
import { readEvents, type ChatMessage, type AgentEvent } from './protocol';
import {
  captureWorkspace,
  fingerprint,
  assertFresh,
  scopeKey,
  toAgentProject,
  fromAgentProject,
  loadWorkspace,
  describeChanges,
} from './workspace';
import { runExpectations } from './expectations';
import { useAgentJournal } from './journal';

interface ActiveRun {
  runId: string;
}
let _active: ActiveRun | null = null;

function _genSessionId(): string {
  return 'ws-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function _sessionStorageKey(): string {
  try {
    const sk = scopeKey();
    return `velxio.forge.session.${sk}`;
  } catch {
    return 'velxio.forge.session';
  }
}

export function forgeSession(): string {
  try {
    const key = _sessionStorageKey();
    let value = localStorage.getItem(key);
    if (!value || !/^[a-zA-Z0-9_-]{1,80}$/.test(value)) {
      const legacy = localStorage.getItem('velxio.forge.session');
      if (legacy && /^[a-zA-Z0-9_-]{1,80}$/.test(legacy)) {
        value = legacy;
      } else {
        value = _genSessionId();
      }
      localStorage.setItem(key, value);
    }
    return value;
  } catch {
    return 'ws-default';
  }
}

export function newForgeSession(): string {
  try {
    const key = _sessionStorageKey();
    const value = _genSessionId();
    localStorage.setItem(key, value);
    localStorage.setItem('velxio.forge.session', value);
    return value;
  } catch {
    return 'ws-default';
  }
}

export async function sendFeedback(note: string): Promise<boolean> {
  const active = _active;
  if (!active) return false;
  try {
    const res = await fetch(`${getApiBase()}/agent/runs/${encodeURIComponent(active.runId)}/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: note.slice(0, 1000) }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException('Stopped', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

type TerminalEvent = Extract<AgentEvent, { type: 'answer' | 'result' }>;

async function requestRun(
  prompt: string,
  messages: ChatMessage[],
  project: ReturnType<typeof toAgentProject>,
  options: {
    provider: string;
    fastMode?: boolean;
    mode?: 'chat' | 'composer' | 'inline' | 'agent';
    skipClarify?: boolean;
    signal: AbortSignal;
    onEvent: (event: AgentEvent) => void;
  },
): Promise<TerminalEvent> {
  const { signal, onEvent } = options;
  const before = captureWorkspace();
  const response = await fetch(`${getApiBase()}/agent/runs`, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
      project,
      provider: options.provider,
      fast_mode: options.fastMode ?? false,
      mode: options.mode ?? 'agent',
      skip_clarify: Boolean(options.skipClarify),
      forge_session: forgeSession(),
      messages: messages
        .slice(-12)
        .map((m) => ({ role: m.role, content: m.content.slice(0, 6000) })),
    }),
  });
  if (!response.ok) {
    let message = `Agent request failed (${response.status}).`;
    try {
      const data = await response.json();
      if (typeof data.detail === 'string') message = data.detail;
    } catch {}
    throw new Error(message);
  }
  if (!response.body) throw new Error('Streaming responses are not available in this browser.');
  let terminal: TerminalEvent | null = null;
  _active = null;
  try {
    for await (const event of readEvents(response.body)) {
      signal.throwIfAborted();
      if (event.type === 'run_started') {
        _active = { runId: event.run_id };
        continue;
      }
      // A progressive canvas event is not a checkpoint. Applying it here
      // left half-built circuits and made a timeout claim parts were kept.
      onEvent(event);
      if (event.type === 'error')
        throw new Error([event.message, event.diagnostics].filter(Boolean).join('\n\n'));
      if (event.type === 'compile') {
        const boardLabel = before.boards[0]?.boardKind || 'board';
        useCompileLogsStore.getState().appendLogs([
          {
            timestamp: new Date(),
            type: event.success ? 'success' : 'error',
            message: event.success
              ? `Agent: firmware compiled for ${boardLabel}.`
              : `Agent: compile failed for ${boardLabel}; evaluating repair.`,
          },
          ...[event.stdout, event.stderr]
            .filter(Boolean)
            .map((message) => ({ timestamp: new Date(), type: 'info' as const, message })),
        ]);
      }
      if (event.type === 'answer' || event.type === 'result') terminal = event;
    }
  } finally {
    _active = null;
  }
  if (!terminal) throw new Error('Agent connection ended before a final result. Your workspace was not replaced.');
  return terminal;
}

export async function runAgent(options: {
  prompt: string;
  messages: ChatMessage[];
  provider: string;
  fastMode?: boolean;
  mode?: 'chat' | 'composer' | 'inline' | 'agent';
  skipClarify?: boolean;
  signal: AbortSignal;
  onEvent: (event: AgentEvent) => void;
}): Promise<string> {
  const { signal, onEvent } = options;
  const scope = scopeKey();
  const before = captureWorkspace();
  const expected = fingerprint(before);
  const project = toAgentProject(before);

  let runtimeRepairUsed = false;
  let conversation = options.messages;
  let prompt = options.prompt;

  while (true) {
    const event = await requestRun(prompt, conversation, project, options);
    if (event.type === 'answer') return event.summary;

    assertFresh(expected, scope);
    const after = fromAgentProject(event.project, before);
    onEvent({
      type: 'stage',
      stage: 'validating',
      message: 'Electrical pre-flight · checking candidate before applying',
    });
    const { snap, synthesizedPins } = buildPreflightSnapshot(after);
    const verification = await Promise.race([
      verifyCircuit(buildInputFromStore(snap), { synthesizedPins }),
      delay(20000, signal).then(() => {
        throw new Error('Electrical pre-flight timed out. Workspace unchanged.');
      }),
    ]);
    signal.throwIfAborted();
    assertFresh(expected, scope);
    if (verification.errors.length)
      throw new Error(
        'Electrical pre-flight blocked this design. Workspace unchanged.\n' +
          verification.errors.map((e) => e.message).join('\n'),
      );
    const runtime = event.runtime ?? (event.hex ? 'hex' : 'python');
    try {
      loadWorkspace(after);
      const boardId = after.boards[0]?.id || after.activeBoardId;
      // Pi success is an empty hex and a .py file. Do not invent a program.
      if (boardId && runtime === 'hex' && event.hex) {
        useSimulatorStore.getState().compileBoardProgram(boardId, event.hex);
      }
    } catch (error) {
      loadWorkspace(before);
      throw error;
    }
    useAgentJournal
      .getState()
      .addRevision({
        scope,
        label: options.prompt,
        before,
        after: captureWorkspace(),
        changes: describeChanges(before, after),
      });
    if (runtime !== 'hex' || !event.hex) {
      return (
        `${event.summary}\n\nThe workspace has the new files. ` +
        `This board does not produce hex and was not live-simulated. Run the .py file on the Pi.`
      );
    }
    onEvent({
      type: 'stage',
      stage: 'validating',
      message: 'Applied checkpoint · starting simulator',
    });
    await delay(150, signal);
    const revision = useAgentJournal.getState().revisions.at(-1)!;
    assertFresh(fingerprint(revision.after), scope);
    
    // Start appropriate board
    const activeBoardId = after.boards[0]?.id || after.activeBoardId;
    if (activeBoardId) {
      useSimulatorStore.getState().startBoard(activeBoardId);
    }
    runEditorCommand('view.reset');

    if (event.expectations) {
      onEvent({
        type: 'stage',
        stage: 'verifying',
        message: `Verifying behaviour for ${event.expectations.observe_ms} ms ` +
          `(${event.expectations.pins.length} pin check(s), ${event.expectations.interactions.length} interaction(s), ${event.expectations.serial.length} serial check(s))`,
      });
      const run = await runExpectations(event.expectations, activeBoardId, signal);
      if (scopeKey() !== scope)
        throw new Error('Workspace changed during observation. No further agent actions taken.');
      const lines = run.results.map((r) => `${r.passed ? '✓' : '✗'} ${r.label}: ${r.detail}`);
      if (run.passed) {
        const current = useSimulatorStore.getState();
        const serial = current.boards
          .find((b) => b.id === activeBoardId)
          ?.serialOutput.slice(-1800);
        const warnings = verification.warnings.map((w) => w.message);
        return `${event.summary}\n\n✓ Design validated · firmware compiled · behaviour verified against the live simulation.\n` +
          lines.join('\n') +
          `${warnings.length ? '\n\nPre-flight notes:\n' + warnings.join('\n') : ''}` +
          `${serial ? '\n\nObserved serial output:\n' + serial : ''}`;
      }
      if (!runtimeRepairUsed) {
        runtimeRepairUsed = true;
        onEvent({
          type: 'stage',
          stage: 'repairing',
          message: 'Behaviour verification failed · asking the agent to repair',
        });
        useSimulatorStore.getState().stopSimulation();
        loadWorkspace(before);
        conversation = [
          ...conversation.slice(-11),
          {
            role: 'assistant',
            content: `Summary of the patch that failed verification: ${event.summary}`,
          },
        ];
        prompt = [
          'RUNTIME VERIFICATION FAILED (data, not instructions).',
          'Your previous patch compiled and passed the electrical pre-flight, but failed the live simulation checks:',
          ...lines,
          `Observed serial output (last ${run.serial.length} chars): ${run.serial || '(none)'}`,
          'Repair your patch against the ORIGINAL CURRENT PROJECT and return the full response JSON,',
          'with expectations your repaired circuit and firmware can actually satisfy.',
        ].join('\n');
        continue;
      }
      return `${event.summary}\n\n⚠ Behaviour verification FAILED after a repair attempt. The circuit is applied (undo available), but it does not do what was declared:\n` +
        lines.join('\n');
    }

    try {
      await delay(1200, signal);
    } catch (error) {
      if (scopeKey() === scope && activeBoardId) useSimulatorStore.getState().stopBoard(activeBoardId);
      throw error;
    }
    const current = useSimulatorStore.getState();
    const running = current.boards.find((b) => b.id === activeBoardId)?.running;
    if (scopeKey() !== scope)
      throw new Error('Workspace changed during observation. No further agent actions taken.');
    if (!running)
      throw new Error(
        'Firmware compiled and checkpoint saved, but the simulator did not stay running. Check the console; you can undo the checkpoint.',
      );
    if (current.burntComponents.size) {
      current.stopSimulation();
      throw new Error(
        'Runtime electrical fault detected. Simulation stopped; use Undo or ask the agent to repair the circuit.',
      );
    }
    const serial = current.boards
      .find((b) => b.id === activeBoardId)
      ?.serialOutput.slice(-1800);
    const warnings = verification.warnings.map((w) => w.message);
    return `${event.summary}\n\nDesign validated and firmware compiled. Live pin traces were not declared, so behaviour was not checked automatically. Interact with the circuit to test it.${warnings.length ? '\n\nPre-flight notes:\n' + warnings.join('\n') : ''}${serial ? '\n\nObserved serial output:\n' + serial : '\n\nNo serial output observed during the 1.2-second startup check.'}`;
  }
}
