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

/** Active run metadata, set by requestRun() so sendFeedback() can POST mid-run
 * notes without the caller having to thread run_id through the UI. */
interface ActiveRun {
  runId: string;
  token: string;
}
let _active: ActiveRun | null = null;

/** Send a mid-run clarification. Silently no-ops if no run is active or if the
 * run has already finished (the server returns 404). */
export async function sendFeedback(note: string): Promise<boolean> {
  const active = _active;
  if (!active) return false;
  try {
    const res = await fetch(`${getApiBase()}/agent/runs/${encodeURIComponent(active.runId)}/feedback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(active.token ? { Authorization: `Bearer ${active.token}` } : {}),
      },
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

/** One backend run ends in exactly one of these. */
type TerminalEvent = Extract<AgentEvent, { type: 'answer' | 'result' }>;

/** One backend run. Returns the terminal event ('answer' or 'result'). */
async function requestRun(
  prompt: string,
  messages: ChatMessage[],
  project: ReturnType<typeof toAgentProject>,
  options: {
    token: string;
    provider: string;
    signal: AbortSignal;
    onEvent: (event: AgentEvent) => void;
  },
): Promise<TerminalEvent> {
  const { signal, onEvent } = options;
  const response = await fetch(`${getApiBase()}/agent/runs`, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    body: JSON.stringify({
      prompt,
      project,
      provider: options.provider,
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
    } catch {
      /* Non-JSON proxy error */
    }
    throw new Error(message);
  }
  if (!response.body) throw new Error('Streaming responses are not available in this browser.');
  let terminal: TerminalEvent | null = null;
  _active = null;
  try {
    for await (const event of readEvents(response.body)) {
      signal.throwIfAborted();
      if (event.type === 'run_started') {
        _active = { runId: event.run_id, token: options.token };
        continue; // internal event, no user-visible handling
      }
      onEvent(event);
      if (event.type === 'error')
        throw new Error([event.message, event.diagnostics].filter(Boolean).join('\n\n'));
      if (event.type === 'compile') {
        useCompileLogsStore.getState().appendLogs([
          {
            timestamp: new Date(),
            type: event.success ? 'success' : 'error',
            message: event.success
              ? 'Agent: firmware compiled for Arduino Uno.'
              : 'Agent: compile failed; evaluating repair.',
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
  token: string;
  provider: string;
  signal: AbortSignal;
  onEvent: (event: AgentEvent) => void;
}): Promise<string> {
  const { signal, onEvent } = options;
  const scope = scopeKey();
  const before = captureWorkspace();
  const expected = fingerprint(before);
  const project = toAgentProject(before);

  // Behavioural verification can send ONE repair round back to the model with
  // the failure report, mirroring how compile errors repair server-side.
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
    // Solve the candidate without replacing the live workspace. A solver
    // failure is surfaced as a warning, never as "electrically verified".
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
    try {
      loadWorkspace(after);
      useSimulatorStore.getState().compileBoardProgram(after.boards[0].id, event.hex);
    } catch (error) {
      loadWorkspace(before);
      throw error;
    }
    // Record before starting: runtime failures must still have an undo point.
    useAgentJournal
      .getState()
      .addRevision({
        scope,
        label: options.prompt,
        before,
        after: captureWorkspace(),
        changes: describeChanges(before, after),
      });
    onEvent({
      type: 'stage',
      stage: 'validating',
      message: 'Applied checkpoint · starting simulator',
    });
    // Parts need to mount and register their pins before the first MCU edge.
    await delay(150, signal);
    const revision = useAgentJournal.getState().revisions.at(-1)!;
    assertFresh(fingerprint(revision.after), scope);
    useSimulatorStore.getState().startBoard(after.boards[0].id);
    runEditorCommand('view.reset');

    if (event.expectations) {
      // --- live behavioural verification against the running firmware ------
      onEvent({
        type: 'stage',
        stage: 'verifying',
        message: `Verifying behaviour for ${event.expectations.observe_ms} ms `
          + `(${event.expectations.pins.length} pin check(s), ${event.expectations.interactions.length} interaction(s), ${event.expectations.serial.length} serial check(s))`,
      });
      const run = await runExpectations(event.expectations, after.boards[0].id, signal);
      if (scopeKey() !== scope)
        throw new Error('Workspace changed during observation. No further agent actions taken.');
      const lines = run.results.map((r) => `${r.passed ? '✓' : '✗'} ${r.label}: ${r.detail}`);
      if (run.passed) {
        const current = useSimulatorStore.getState();
        const serial = current.boards
          .find((b) => b.id === after.boards[0].id)
          ?.serialOutput.slice(-1800);
        const warnings = verification.warnings.map((w) => w.message);
        return `${event.summary}\n\n✓ Design validated · firmware compiled · behaviour verified against the live simulation.\n`
          + lines.join('\n')
          + `${warnings.length ? '\n\nPre-flight notes:\n' + warnings.join('\n') : ''}`
          + `${serial ? '\n\nObserved serial output:\n' + serial : ''}`;
      }
      if (!runtimeRepairUsed) {
        runtimeRepairUsed = true;
        onEvent({
          type: 'stage',
          stage: 'repairing',
          message: 'Behaviour verification failed · asking the agent to repair',
        });
        // Repair against the ORIGINAL project, like a compile repair: revert
        // what was applied so the workspace never shows an unverified state.
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
      // Second failure: be honest instead of looping forever. The applied
      // checkpoint stays, with undo available.
      return `${event.summary}\n\n⚠ Behaviour verification FAILED after a repair attempt. The circuit is applied (undo available), but it does not do what was declared:\n`
        + lines.join('\n');
    }

    // No expectations declared: keep the honest (weak) guarantee.
    try {
      await delay(1200, signal);
    } catch (error) {
      if (scopeKey() === scope) useSimulatorStore.getState().stopBoard(after.boards[0].id);
      throw error;
    }
    const current = useSimulatorStore.getState();
    const running = current.boards.find((b) => b.id === after.boards[0].id)?.running;
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
      .find((b) => b.id === after.boards[0].id)
      ?.serialOutput.slice(-1800);
    const warnings = verification.warnings.map((w) => w.message);
    return `${event.summary}\n\n✓ Design validated · firmware compiled · simulation running.\nBehaviour is not automatically verified — the proposal declared no expectations. Interact with the circuit to test it.${warnings.length ? '\n\nPre-flight notes:\n' + warnings.join('\n') : ''}${serial ? '\n\nObserved serial output:\n' + serial : '\n\nNo serial output observed during the 1.2-second startup check.'}`;
  }
}
