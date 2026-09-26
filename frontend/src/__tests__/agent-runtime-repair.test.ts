// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { projectSchema, type AgentProject } from '../agent/protocol';
import type { Snapshot } from '../agent/workspace';

const mocks = vi.hoisted(() => {
  const sim = {
    boards: [] as unknown[],
    components: [] as unknown[],
    wires: [] as unknown[],
    activeBoardId: null as string | null,
    burntComponents: new Set(),
    stopSimulation: vi.fn(),
    loadProjectState: vi.fn(),
    clearHistory: vi.fn(),
    compileBoardProgram: vi.fn(),
    startBoard: vi.fn(),
    stopBoard: vi.fn(),
  };
  const editor = { fileGroups: {}, folderGroups: {} };
  const project = { currentProject: null as { id: string } | null, currentExampleId: null };
  const verify = vi.fn();
  return { sim, editor, project, verify };
});

vi.mock('../store/useSimulatorStore', () => ({ useSimulatorStore: { getState: () => mocks.sim } }));
vi.mock('../store/useEditorStore', () => ({ useEditorStore: { getState: () => mocks.editor } }));
vi.mock('../store/useProjectStore', () => ({ useProjectStore: { getState: () => mocks.project } }));
vi.mock('../store/useCompileLogsStore', () => ({
  useCompileLogsStore: { getState: () => ({ appendLogs: vi.fn() }) },
}));
vi.mock('../simulation/verify/verifyFromStore', () => ({
  buildPreflightSnapshot: (s: unknown) => ({ snap: s, synthesizedPins: new Set() }),
}));
vi.mock('../simulation/spice/storeAdapter', () => ({ buildInputFromStore: (s: unknown) => s }));
vi.mock('../simulation/verify/circuitVerifier', () => ({ verifyCircuit: mocks.verify }));
vi.mock('../agent/expectations', () => ({ runExpectations: vi.fn() }));

import { runExpectations } from '../agent/expectations';
import { runAgent } from '../agent/runner';
import { useAgentJournal } from '../agent/journal';

const empty: Snapshot = {
  boards: [],
  components: [],
  wires: [],
  fileGroups: {},
  folderGroups: {},
  activeBoardId: null,
};
const design: AgentProject = {
  board: { id: 'uno', x: 100, y: 150 },
  components: [{ id: 'r1', metadataId: 'resistor', x: 450, y: 100, properties: { value: '330' } }],
  wires: [],
  files: [
    {
      name: 'sketch.ino',
      content: 'void setup(){pinMode(13,OUTPUT);}\nvoid loop(){digitalWrite(13,HIGH);delay(500);}',
    },
  ],
};
const expectations = {
  observe_ms: 2000,
  pins: [
    { pin: '13', expect: 'toggles', min_transitions: 2, period_ms: [800, 1200] as [number, number] },
  ],
  serial: [],
  interactions: [],
};
const result = {
  type: 'result',
  project: projectSchema.parse(design),
  hex: ':00000001FF',
  summary: 'Built it',
  attempts: 1,
  expectations,
};
const options = () => ({
  prompt: 'blink',
  messages: [] as { role: 'user' | 'assistant'; content: string }[],
  provider: 'bedrock',
  signal: new AbortController().signal,
  onEvent: vi.fn(),
});
function response(events: unknown[]) {
  return new Response(events.map((e) => JSON.stringify(e)).join('\n') + '\n', {
    headers: { 'Content-Type': 'application/x-ndjson' },
  });
}
function setSnapshot(s: Snapshot) {
  Object.assign(mocks.sim, {
    boards: structuredClone(s.boards),
    components: structuredClone(s.components),
    wires: structuredClone(s.wires),
    activeBoardId: s.activeBoardId,
  });
  mocks.editor.fileGroups = structuredClone(s.fileGroups);
  mocks.editor.folderGroups = structuredClone(s.folderGroups ?? {});
}

beforeEach(() => {
  vi.clearAllMocks();
  setSnapshot(empty);
  mocks.sim.loadProjectState.mockImplementation(setSnapshot);
  mocks.sim.startBoard.mockImplementation((id: string) => {
    for (const b of mocks.sim.boards as Snapshot['boards']) if (b.id === id) b.running = true;
  });
  mocks.verify.mockResolvedValue({ errors: [], warnings: [] });
  useAgentJournal.setState({ messages: [], revisions: [] });
});

describe('agent runtime verification loop', () => {
  it('reports verified behaviour when expectations pass', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response([result])));
    vi.mocked(runExpectations).mockResolvedValue({
      passed: true,
      supported: true,
      results: [{ label: 'pin 13 toggles', passed: true, detail: '5 transitions observed.' }],
      serial: 'blink started',
    });
    const done = runAgent(options());
    await vi.advanceTimersByTimeAsync(1500);
    const answer = await done;
    expect(answer).toContain('behaviour verified');
    expect(answer).toContain('pin 13 toggles');
    expect(mocks.sim.startBoard).toHaveBeenCalledWith('uno');
    expect(runExpectations).toHaveBeenCalledTimes(1);
  });

  it('sends one repair round with the failure report against the ORIGINAL project', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response([result]))
      .mockResolvedValueOnce(response([result]));
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(runExpectations)
      .mockResolvedValueOnce({
        passed: false,
        supported: true,
        results: [{ label: 'pin 13 toggles', passed: false, detail: 'observed 0.' }],
        serial: '',
      })
      .mockResolvedValueOnce({
        passed: true,
        supported: true,
        results: [{ label: 'pin 13 toggles', passed: true, detail: '5 transitions observed.' }],
        serial: '',
      });
    const done = runAgent(options());
    await vi.advanceTimersByTimeAsync(4000);
    const answer = await done;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body as string);
    expect(secondBody.prompt).toContain('RUNTIME VERIFICATION FAILED');
    expect(secondBody.prompt).toContain('observed 0');
    // Repairs regenerate the patch from the ORIGINAL project, like compile repairs.
    expect(secondBody.project.components).toEqual([]);
    expect(secondBody.messages.at(-1).role).toBe('assistant');
    expect(answer).toContain('behaviour verified');
    // The failed apply was reverted before repairing.
    expect(mocks.sim.stopSimulation).toHaveBeenCalled();
  });

  it('stops honestly after a failed repair instead of looping forever', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(async () => response([result]));
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(runExpectations).mockResolvedValue({
      passed: false,
      supported: true,
      results: [{ label: 'pin 13 toggles', passed: false, detail: 'observed 0.' }],
      serial: '',
    });
    const done = runAgent(options());
    await vi.advanceTimersByTimeAsync(4000);
    const answer = await done;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(answer).toContain('verification FAILED');
    expect(answer).toContain('observed 0');
  });
});
