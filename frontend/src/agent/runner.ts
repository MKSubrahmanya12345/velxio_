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
import { useAgentJournal } from './journal';

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

export async function runAgent(options: {
  prompt: string;
  messages: ChatMessage[];
  token: string;
  signal: AbortSignal;
  onEvent: (event: AgentEvent) => void;
}): Promise<string> {
  const { signal, onEvent } = options;
  const scope = scopeKey();
  const before = captureWorkspace();
  const expected = fingerprint(before);
  const project = toAgentProject(before);
  const response = await fetch(`${getApiBase()}/agent/runs`, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    body: JSON.stringify({
      prompt: options.prompt,
      project,
      messages: options.messages
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
  for await (const event of readEvents(response.body)) {
    signal.throwIfAborted();
    onEvent(event);
    if (event.type === 'error')
      throw new Error([event.message, event.diagnostics].filter(Boolean).join('\n\n'));
    if (event.type === 'compile') {
      useCompileLogsStore
        .getState()
        .appendLogs([
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
    if (event.type === 'answer') return event.summary;
    if (event.type !== 'result') continue;
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
    return `${event.summary}\n\n✓ Design validated · firmware compiled · simulation running.\nBehaviour is not automatically verified. Interact with the circuit to test it.${warnings.length ? '\n\nPre-flight notes:\n' + warnings.join('\n') : ''}${serial ? '\n\nObserved serial output:\n' + serial : '\n\nNo serial output observed during the 1.2-second startup check.'}`;
  }
  throw new Error('Agent connection ended before a final result. Your workspace was not replaced.');
}
