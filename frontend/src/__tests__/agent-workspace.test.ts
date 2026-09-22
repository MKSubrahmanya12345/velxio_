// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { projectSchema, readEvents, stableStringify, type AgentProject } from '../agent/protocol';
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

import {
  assertFresh,
  captureWorkspace,
  describeChanges,
  fingerprint,
  fromAgentProject,
  scopeKey,
  toAgentProject,
} from '../agent/workspace';
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
  wires: [
    {
      id: 'w1',
      start: { componentId: 'uno', pinName: '13' },
      end: { componentId: 'r1', pinName: '1' },
      color: '#44ff88',
    },
  ],
  files: [{ name: 'sketch.ino', content: 'void setup(){} void loop(){}' }],
};
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
function response(events: unknown[]) {
  return new Response(events.map((e) => JSON.stringify(e)).join('\n') + '\n', {
    headers: { 'Content-Type': 'application/x-ndjson' },
  });
}
const result = {
  type: 'result',
  project: design,
  hex: ':00000001FF',
  summary: 'Built it',
  attempts: 1,
};
const options = () => ({
  prompt: 'build',
  messages: [],
  provider: 'groq',
  signal: new AbortController().signal,
  onEvent: vi.fn(),
});

beforeEach(() => {
  vi.clearAllMocks();
  setSnapshot(empty);
  mocks.project.currentProject = null;
  mocks.sim.burntComponents.clear();
  mocks.sim.loadProjectState.mockImplementation(setSnapshot);
  mocks.sim.startBoard.mockImplementation((id: string) => {
    for (const b of mocks.sim.boards as Snapshot['boards']) if (b.id === id) b.running = true;
  });
  mocks.verify.mockResolvedValue({ errors: [], warnings: [] });
  useAgentJournal.setState({ messages: [], revisions: [] });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('agent protocol', () => {
  it('decodes arbitrary UTF-8 and line boundaries', async () => {
    const bytes = new TextEncoder().encode(
      '{"type":"answer","summary":"330 Ω ✓"}\n{"type":"answer","summary":"done"}',
    );
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (const b of bytes) c.enqueue(new Uint8Array([b]));
        c.close();
      },
    });
    const events = [];
    for await (const event of readEvents(stream)) events.push(event);
    expect(events).toEqual([
      { type: 'answer', summary: '330 Ω ✓' },
      { type: 'answer', summary: 'done' },
    ]);
  });
  it('rejects malformed response events', async () => {
    await expect(async () => {
      for await (const _ of readEvents(response([{ type: 'shell', command: 'rm' }]).body!)) {
        /* consume */
      }
    }).rejects.toThrow();
  });
  it('rejects unsupported parts and unsafe filenames', () => {
    expect(
      projectSchema.safeParse({ ...design, files: [{ name: '../bad.ino', content: '' }] }).success,
    ).toBe(false);
    expect(
      projectSchema.safeParse({
        ...design,
        components: [{ ...design.components[0], metadataId: 'invented' }],
      }).success,
    ).toBe(false);
  });
  it('canonicalizes object keys but not array order', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
  });
});

describe('workspace transactions', () => {
  it('round trips supported design and preserves unrelated files, folders and routing', () => {
    const first = fromAgentProject(design, empty);
    first.folderGroups = { 'group-uno': ['notes'] };
    first.wires[0].autoRouted = false;
    first.wires[0].waypoints = [{ x: 200, y: 20 }];
    const second = fromAgentProject(design, first);
    expect(second.folderGroups).toEqual(first.folderGroups);
    expect(second.wires[0].waypoints).toEqual(first.wires[0].waypoints);
    expect(toAgentProject(second)).toEqual(design);
  });
  it('ignores serial/firmware/LED runtime changes but detects code changes', () => {
    setSnapshot(fromAgentProject(design, empty));
    const before = fingerprint(captureWorkspace());
    const board = mocks.sim.boards[0] as Snapshot['boards'][number];
    board.running = true;
    board.serialOutput = 'runtime';
    board.serialLink = { source: 'uart', baud: 9600, dataBits: 8, parity: 'none', stopBits: 1 };
    board.compiledProgram = 'firmware';
    expect(fingerprint(captureWorkspace())).toBe(before);
    mocks.editor.fileGroups = { 'group-uno': [{ name: 'sketch.ino', content: '// hand edit' }] };
    expect(() => assertFresh(before, scopeKey())).toThrow('workspace changed');
  });
  it('ignores endpoint DOM coordinates but detects hand-routed wire edits', () => {
    const a = fromAgentProject(design, empty);
    a.wires[0].autoRouted = false;
    const b = structuredClone(a);
    b.wires[0].start.x = 222;
    expect(fingerprint(a)).toBe(fingerprint(b));
    b.wires[0].waypoints = [{ x: 100, y: 100 }];
    expect(fingerprint(a)).not.toBe(fingerprint(b));
  });
  it('blocks a project switch even when content is identical', () => {
    const before = fingerprint(captureWorkspace());
    const scope = scopeKey();
    mocks.project.currentProject = { id: 'new-project' };
    expect(() => assertFresh(before, scope)).toThrow('workspace changed');
  });
  it('rejects unsupported existing boards and unknown components without mutation', () => {
    const state = fromAgentProject(design, empty);
    state.boards[0].boardKind = 'esp32';
    expect(() => toAgentProject(state)).toThrow('Arduino Uno');
    state.boards[0].boardKind = 'arduino-uno';
    // An id no catalog entry knows is still refused (a typo must never silently
    // drop a part from the wire format).
    state.components[0].metadataId = 'wokwi-nonsense';
    expect(() => toAgentProject(state)).toThrow('wokwi-nonsense');
    expect(mocks.sim.loadProjectState).not.toHaveBeenCalled();
  });
  it('accepts every placeable catalog part, including the expanded set', () => {
    // The catalog is the scope: a part the canvas can place is a part the agent
    // can edit. These used to be rejected outright.
    for (const [metadataId, properties] of [
      ['lcd1602', { pins: 'i2c', color: 'black' }],
      ['dht22', {}],
      ['ic-74hc14', {}],
      ['servo', { angle: 45 }],
    ] as const) {
      const state = fromAgentProject(design, empty);
      state.components[0].metadataId = metadataId;
      state.components[0].properties = { ...properties };
      const project = toAgentProject(state);
      expect(project.components[0].metadataId).toBe(metadataId);
      expect(project.components[0].properties).toEqual(properties);
    }
  });
  it('drops runtime state and keeps the editable properties of a new part', () => {
    const state = fromAgentProject(design, empty);
    state.components[0].metadataId = 'lcd1602';
    state.components[0].properties = {
      pins: 'i2c',
      cursorX: 3,        // live cursor position: the canvas owns it
      characters: {},    // rendered frame buffer: not sent to the model
      rotation: 90,      // a real, agent-editable property
    };
    expect(toAgentProject(state).components[0].properties).toEqual({
      pins: 'i2c',
      rotation: 90,
    });
  });
  it('refuses dangling endpoints and board replacement', () => {
    expect(() =>
      fromAgentProject(
        {
          ...design,
          wires: [{ ...design.wires[0], end: { componentId: 'missing', pinName: '1' } }],
        },
        empty,
      ),
    ).toThrow('Dangling');
    expect(() =>
      fromAgentProject(
        { ...design, board: { ...design.board!, id: 'other' } },
        fromAgentProject(design, empty),
      ),
    ).toThrow('replace');
  });
  it('resets omitted editable properties while retaining out-of-scope settings', () => {
    const previous = fromAgentProject(design, empty);
    previous.components[0].properties = { value: '330', rotation: 90, tolerance: 5 };
    const after = fromAgentProject(design, previous);
    expect(after.components[0].properties).toEqual({ value: '330', tolerance: 5 });
  });
  it('creates a readable change summary', () => {
    expect(describeChanges(empty, fromAgentProject(design, empty))).toEqual([
      '+ Arduino Uno',
      '+1 part',
      '+1 wire',
      'sketch.ino',
    ]);
  });
});

describe('agent runner', () => {
  it('explanations never mutate or run the project', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(response([{ type: 'answer', summary: 'An LED' }])),
    );
    expect(await runAgent(options())).toBe('An LED');
    expect(mocks.sim.loadProjectState).not.toHaveBeenCalled();
  });
  it('applies, checkpoints and starts only compiled valid results', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response([result])));
    const done = runAgent(options());
    await vi.advanceTimersByTimeAsync(1500);
    expect(await done).toContain('Behaviour is not automatically verified');
    expect(mocks.sim.compileBoardProgram).toHaveBeenCalledWith('uno', ':00000001FF');
    expect(mocks.sim.startBoard).toHaveBeenCalledWith('uno');
    expect(useAgentJournal.getState().revisions).toHaveLength(1);
  });
  it('rejects stale results after a manual edit during generation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => {
        mocks.editor.folderGroups = { scratch: ['new-folder'] };
        return response([result]);
      }),
    );
    await expect(runAgent(options())).rejects.toThrow('workspace changed');
    expect(mocks.sim.loadProjectState).not.toHaveBeenCalled();
  });
  it('checks freshness again after asynchronous electrical validation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response([result])));
    mocks.verify.mockImplementation(async () => {
      mocks.editor.folderGroups = { scratch: ['manual'] };
      return { errors: [], warnings: [] };
    });
    await expect(runAgent(options())).rejects.toThrow('workspace changed');
    expect(mocks.sim.loadProjectState).not.toHaveBeenCalled();
  });
  it('does not apply an electrically invalid project', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response([result])));
    mocks.verify.mockResolvedValue({ errors: [{ message: 'Short circuit' }], warnings: [] });
    await expect(runAgent(options())).rejects.toThrow('Short circuit');
    expect(mocks.sim.loadProjectState).not.toHaveBeenCalled();
  });
  it('does not overwrite on exhausted repairs or disconnected streams', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(response([{ type: 'error', message: 'Stopped after 3 attempts' }])),
    );
    await expect(runAgent(options())).rejects.toThrow('3 attempts');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response([])));
    await expect(runAgent(options())).rejects.toThrow('connection ended');
    expect(mocks.sim.loadProjectState).not.toHaveBeenCalled();
  });
  it('aborting before apply leaves the workspace alone', async () => {
    const abort = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => {
        abort.abort();
        return response([result]);
      }),
    );
    await expect(runAgent({ ...options(), signal: abort.signal })).rejects.toThrow();
    expect(mocks.sim.loadProjectState).not.toHaveBeenCalled();
  });
  it('stops its simulation when cancelled during observation', async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response([result])));
    const done = runAgent({ ...options(), signal: abort.signal });
    const check = expect(done).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(160);
    abort.abort();
    await check;
    expect(mocks.sim.stopBoard).toHaveBeenCalledWith('uno');
    expect(useAgentJournal.getState().revisions).toHaveLength(1);
  });
});
