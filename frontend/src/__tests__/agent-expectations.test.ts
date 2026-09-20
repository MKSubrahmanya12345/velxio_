/**
 * Behavioural-verification tests — the check that did not exist before.
 *
 * The important one is the end-to-end: a REAL AVRSimulator running real AVR
 * machine code that toggles pin 13, observed through runExpectations. Before
 * this module, "compiles + pre-flight" was reported as verified no matter
 * what the firmware actually did.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AVRSimulator } from '../simulation/AVRSimulator';
import { PinManager } from '../simulation/PinManager';
import { evaluateExpectations, runExpectations, type Transition } from '../agent/expectations';
import type { AgentExpectations } from '../agent/protocol';
import type { SimulatorState } from '../store/useSimulatorStore';

// ─── Minimal Intel HEX builder (words → records with checksums) ──────────────
function record(type: number, addr: number, data: number[]): string {
  const payload = [data.length, (addr >> 8) & 0xff, addr & 0xff, type, ...data];
  const checksum = (~payload.reduce((a, b) => a + b, 0) + 1) & 0xff;
  return ':' + [...payload, checksum].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join('');
}
function ihex(words: number[]): string {
  const bytes: number[] = [];
  for (const w of words) bytes.push(w & 0xff, (w >> 8) & 0xff);
  const lines = [];
  for (let i = 0; i < bytes.length; i += 16) lines.push(record(0, i, bytes.slice(i, i + 16)));
  lines.push(record(1, 0, []));
  return lines.join('\n') + '\n';
}

// toggle loop: DDRB=out, r17=0x20, loop { PORTB ^= r17 } — pin 13 toggles flat out
// LDI r16,0xFF (EF0F) · OUT DDRB,r16 (B904) · LDI r17,0x20 (E210) · OUT PORTB,r16 (B905)
// EOR r16,r17 (2701) · OUT PORTB,r16 (B905) · RJMP.-3 (CFFD)
const TOGGLE_HEX = ihex([0xef0f, 0xb904, 0xe210, 0xb905, 0x2701, 0xb905, 0xcffd]);
const EMPTY_HEX = ihex([]);

const baseExpectations: AgentExpectations = {
  observe_ms: 600,
  pins: [{ pin: '13', expect: 'toggles', min_transitions: 100, period_ms: null }],
  serial: [],
  interactions: [],
};

describe('evaluateExpectations — pure evaluation', () => {
  const noLevel = () => null;
  const trans = (pin: number, times: number[]): Transition[] =>
    times.map((atMs, i) => ({ pin, state: i % 2 === 0, atMs }));

  it('fails toggles when too few transitions were observed', () => {
    const results = evaluateExpectations(
      { ...baseExpectations, pins: [{ pin: '13', expect: 'toggles', min_transitions: 4, period_ms: null }] },
      new Map([[13, 2]]),
      new Map([[13, trans(13, [0, 5])]]),
      '',
      noLevel,
    );
    expect(results[0].passed).toBe(false);
    expect(results[0].detail).toContain('observed 2');
  });

  it('checks the median period against the declared range', () => {
    const counts = new Map([[13, 4]]);
    const recent = new Map([[13, trans(13, [0, 100, 200, 300])]]);
    const inRange = evaluateExpectations(
      { ...baseExpectations, pins: [{ pin: '13', expect: 'toggles', min_transitions: 2, period_ms: [80, 120] }] },
      counts, recent, '', noLevel,
    );
    expect(inRange[0].passed).toBe(true);
    const outOfRange = evaluateExpectations(
      { ...baseExpectations, pins: [{ pin: '13', expect: 'toggles', min_transitions: 2, period_ms: [500, 900] }] },
      counts, recent, '', noLevel,
    );
    expect(outOfRange[0].passed).toBe(false);
    expect(outOfRange[0].detail).toContain('outside the declared');
  });

  it('confirms high/low from the live electrical level even with zero transitions', () => {
    const expectations = { ...baseExpectations, pins: [{ pin: '13', expect: 'high' as const, min_transitions: 2, period_ms: null }] };
    const high = evaluateExpectations(expectations, new Map(), new Map(), '', () => true);
    const low = evaluateExpectations(expectations, new Map(), new Map(), '', () => false);
    const unreadable = evaluateExpectations(expectations, new Map(), new Map(), '', () => null);
    expect(high[0].passed).toBe(true);
    expect(low[0].passed).toBe(false);
    expect(unreadable[0].passed).toBe(false);
  });

  it('matches serial output against regexes', () => {
    const expectations = { ...baseExpectations, pins: [], serial: [{ matches: 'blink (started|ready)' }] };
    const hit = evaluateExpectations(expectations, new Map(), new Map(), '14:02 blink started\n', noLevel);
    const miss = evaluateExpectations(expectations, new Map(), new Map(), 'no such line\n', noLevel);
    expect(hit[0].passed).toBe(true);
    expect(miss[0].passed).toBe(false);
  });

  it('rejects pin names that are not Uno GPIOs', () => {
    const results = evaluateExpectations(
      { ...baseExpectations, pins: [{ pin: 'ZZ', expect: 'high', min_transitions: 1, period_ms: null }] },
      new Map(), new Map(), '', noLevel,
    );
    expect(results[0].passed).toBe(false);
  });
});

describe('runExpectations — against a real AVR runtime', () => {
  let pm: PinManager;
  let sim: AVRSimulator;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    pm = new PinManager();
    sim = new AVRSimulator(pm);
    // Wall-paced frames so the CPU executes in real time under vitest.
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) =>
      setTimeout(() => cb(performance.now()), 16));
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
  });
  afterEach(() => {
    sim.stop();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // A minimal store: runExpectations only reads `boards[].serialOutput`,
  // `components` and `wires`, so the fixture carries exactly those.
  const deps = () => ({
    getSim: () => sim,
    getState: () =>
      ({
        boards: [{ id: 'agent-board', serialOutput: '' }],
        components: [],
        wires: [],
      }) as unknown as SimulatorState,
  });

  it('verifies real firmware toggling pin 13', { timeout: 15000 }, async () => {
    sim.loadHex(TOGGLE_HEX);
    sim.start();
    const run = await runExpectations(baseExpectations, 'agent-board', new AbortController().signal, deps());
    expect(run.supported).toBe(true);
    expect(run.passed).toBe(true);
    expect(run.results[0].detail).toMatch(/transitions observed/);
  });

  it('fails a pin expectation when the firmware never touches the pin', { timeout: 15000 }, async () => {
    sim.loadHex(EMPTY_HEX);
    sim.start();
    const run = await runExpectations(baseExpectations, 'agent-board', new AbortController().signal, deps());
    expect(run.passed).toBe(false);
    expect(run.results[0].detail).toContain('observed 0');
  });

  it('drives interactions: a press pulls the button pin LOW, release returns it HIGH', { timeout: 15000 }, async () => {
    sim.loadHex(EMPTY_HEX);
    sim.start();
    const setPin = vi.spyOn(sim, 'setPinState');
    const run = await runExpectations(
      {
        ...baseExpectations,
        pins: [],
        interactions: [{ kind: 'press', componentId: 'btn1', at_ms: 100, hold_ms: 200, value: 512 }],
      },
      'agent-board',
      new AbortController().signal,
      { ...deps(), resolvePin: () => 2 },
    );
    const presses = setPin.mock.calls.filter(([pin]) => pin === 2);
    expect(presses).toEqual([[2, false], [2, true]]);
    expect(run.results.every((r) => r.passed)).toBe(true);
  });

  it('fails loudly when an interaction cannot be traced to a GPIO', async () => {
    const run = await runExpectations(
      {
        ...baseExpectations,
        pins: [],
        interactions: [{ kind: 'press', componentId: 'btn1', at_ms: 10, hold_ms: 10, value: 512 }],
      },
      'agent-board',
      new AbortController().signal,
      { ...deps(), resolvePin: () => null },
    );
    expect(run.passed).toBe(false);
    expect(run.results[0].label).toContain('interaction press btn1');
  });

  it('is fail-closed when the runtime cannot be observed', async () => {
    const run = await runExpectations(baseExpectations, 'agent-board', new AbortController().signal, {
      getSim: () => ({ notAnAvr: true }),
      getState: deps().getState,
    });
    expect(run.supported).toBe(false);
    expect(run.passed).toBe(false);
  });
});
