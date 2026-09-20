/**
 * Live behavioural verification — the piece that was entirely missing.
 *
 * A compiled sketch proves nothing about behaviour: the pre-flight forces
 * every wired GPIO HIGH, so "the LED lit during pre-flight" is true of any
 * wiring. This module runs the agent's own declared `expectations` against
 * the real AVR runtime: it watches pin transitions (with simulated time),
 * drives the declared interactions (press a button, set a potentiometer) at
 * the declared moments, and matches serial output against regexes.
 *
 * Fail-closed on purpose: if the runtime cannot be observed (non-AVR board),
 * expectations are reported as failed so the repair loop can drop or fix
 * them rather than the UI claiming a green "verified".
 */
import { getBoardPinManager, getBoardSimulator, useSimulatorStore } from '../store/useSimulatorStore';
import { traceBoardGpio } from '../simulation/PinTrace';
import { dispatchSensorUpdate } from '../simulation/SensorUpdateRegistry';
import { setAdcVoltage } from '../simulation/parts/partUtils';
import { AVRSimulator } from '../simulation/AVRSimulator';
import { boardPinToNumber } from '../utils/boardPinMapping';
import { partSpec, pinsFor } from './catalog';
import type { AgentExpectations } from './protocol';

export interface ExpectationResult {
  label: string;
  passed: boolean;
  detail: string;
}

export interface ExpectationRun {
  passed: boolean;
  supported: boolean;
  results: ExpectationResult[];
  serial: string;
}

export interface Transition {
  pin: number;
  state: boolean;
  atMs: number;
}

export type PinLevelReader = (pin: number) => boolean | null;

interface ExpectationDeps {
  getSim?: (boardId: string) => unknown;
  getState?: () => ReturnType<typeof useSimulatorStore.getState>;
  resolvePin?: (
    state: ReturnType<typeof useSimulatorStore.getState>,
    componentId: string,
    pinName: string,
    boardId: string,
  ) => number | null;
  /** Push a sensor-model value into the live simulation (default: the registry). */
  dispatchSensor?: (componentId: string, values: Record<string, number | boolean>) => void;
}

/** Actions the run loop applies at a simulated time. */
type Action =
  | { atMs: number; kind: 'level'; pin: number; high: boolean }
  | { atMs: number; kind: 'pot'; pin: number; volts: number }
  | { atMs: number; kind: 'sensor'; componentId: string; values: Record<string, number | boolean> };

/**
 * Which part pin an interaction acts on when the model did not name one.
 * Ordered by "most likely to be the pin a human would touch".
 */
const INTERACTION_PINS: Record<string, string[]> = {
  press: ['1.l', '2.l', '1', 'SW', 'SEL', 'OUT', 'A'],
  pot: ['SIG', 'VERT', 'HORZ', 'AO', 'OUT', 'A'],
  switch: ['2', '1', 'OUT', 'A'],
  rotary: ['CLK', 'PULSE', 'A', 'DT'],
};

function componentPins(
  state: ReturnType<typeof useSimulatorStore.getState>,
  componentId: string,
): string[] {
  const component = state.components.find((c) => c.id === componentId);
  if (!component) return [];
  return pinsFor(component.metadataId, component.properties ?? {});
}

/**
 * The part pin an interaction should drive, given the request and the circuit.
 * Returns null (and the caller reports why) when the part is unknown or has no
 * usable pin — never a silent no-op, because a verification that skipped its
 * own stimulus would report "verified" for behaviour that never happened.
 */
function pickPin(
  state: ReturnType<typeof useSimulatorStore.getState>,
  componentId: string,
  kind: string,
  requested: string | null | undefined,
  resolve: ExpectationDeps['resolvePin'],
  boardId: string,
): { pinName: string; pin: number } | null {
  const component = state.components.find((c) => c.id === componentId);
  const pins = componentPins(state, componentId);
  const spec = component
    ? partSpec(component.metadataId)
    : undefined;
  const preferred = requested ? [requested] : (INTERACTION_PINS[kind] ?? []);
  if (pins.length) {
    // Known part: only its real pins are candidates, preferred ones first.
    for (const candidate of INTERACTION_PINS[kind] ?? []) {
      if (pins.includes(candidate) && !preferred.includes(candidate)) preferred.push(candidate);
    }
    if (kind === 'rotary' && spec?.rotary && !requested) {
      for (const candidate of Object.values(spec.rotary as Record<string, string>)) {
        if (pins.includes(candidate) && !preferred.includes(candidate)) preferred.push(candidate);
      }
    }
  }
  const ordered = [...preferred, ...pins];
  for (const candidate of ordered) {
    const pin = (resolve ?? traceBoardGpio)(state, componentId, candidate, boardId);
    if (pin !== null && pin !== undefined) return { pinName: candidate, pin };
  }
  return null;
}

/** Union-find over the wire graph: every pin name on the same net as (id, pin). */
function netOf(
  state: ReturnType<typeof useSimulatorStore.getState>,
  componentId: string,
  pinName: string,
): Set<string> {
  const parent = new Map<string, string>();
  const find = (key: string): string => {
    if (!parent.has(key)) parent.set(key, key);
    let root = key;
    while (parent.get(root) !== root) root = parent.get(root) as string;
    parent.set(key, root);
    return root;
  };
  const union = (a: string, b: string) => {
    parent.set(find(a), find(b));
  };
  for (const wire of state.wires) {
    union(`${wire.start.componentId}:${wire.start.pinName}`, `${wire.end.componentId}:${wire.end.pinName}`);
  }
  const root = find(`${componentId}:${pinName}`);
  return new Set([...parent.keys()].filter((key) => find(key) === root));
}

/**
 * Whether closing a switch pulls its signal low: a switch wired to GND closes to
 * LOW, one wired to 5V closes to HIGH. When the other contact does not reach a
 * rail, the caller falls back to toggling the pin.
 */
function closesLow(
  state: ReturnType<typeof useSimulatorStore.getState>,
  componentId: string,
  pinName: string,
  boardId: string,
): boolean | null {
  const component = state.components.find((c) => c.id === componentId);
  const spec = component ? partSpec(component.metadataId) : undefined;
  if (!component || !spec) return null;
  const pairs = (spec.tracePairs as Array<[string, string]> | undefined) ?? [];
  const pins = pinsFor(component.metadataId, component.properties ?? {});
  for (const [a, b] of pairs) {
    if (!pins.includes(a) || !pins.includes(b)) continue;
    const other = pinName === a ? b : pinName === b ? a : null;
    if (!other) continue;
    const net = netOf(state, componentId, other);
    if ([...net].some((key) => key.startsWith(`${boardId}:GND`))) return true;
    if (
      [...net].some((key) => {
        const pin = key.split(':')[1] ?? '';
        return key.startsWith(`${boardId}:`) && /^(5V|3\.3V|VIN|VCC)$/.test(pin);
      })
    )
      return false;
  }
  return null;
}

const POLL_MS = 30;
/** Rolling window per pin: exact counts stay in `counts`, timestamps capped. */
const RECENT_EVENTS = 2000;

function median(values: number[]): number {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** Pure evaluation: given observed transitions, serial and live levels. */
export function evaluateExpectations(
  expectations: AgentExpectations,
  counts: Map<number, number>,
  recent: Map<number, Transition[]>,
  serial: string,
  levelOf: PinLevelReader,
): ExpectationResult[] {
  const results: ExpectationResult[] = [];
  for (const expectation of expectations.pins) {
    const pin = boardPinToNumber('arduino-uno', expectation.pin);
    if (pin === null || pin < 0) {
      results.push({ label: `pin ${expectation.pin}`, passed: false, detail: 'Not a valid Uno GPIO name.' });
      continue;
    }
    const label = `pin ${expectation.pin} ${expectation.expect}`;
    const count = counts.get(pin) ?? 0;
    const events = recent.get(pin) ?? [];
    if (expectation.expect === 'toggles') {
      if (count < expectation.min_transitions) {
        results.push({
          label,
          passed: false,
          detail: `Expected at least ${expectation.min_transitions} transitions in ${expectations.observe_ms} ms, observed ${count}. The sketch may drive a different pin, delay too long, or never configure the pin as an output.`,
        });
        continue;
      }
      if (expectation.period_ms) {
        const intervals = events.slice(1).map((e, i) => e.atMs - events[i].atMs);
        const mid = median(intervals);
        const [low, high] = expectation.period_ms;
        if (intervals.length === 0 || mid < low || mid > high) {
          results.push({
            label,
            passed: false,
            detail: `Median transition period ${Math.round(mid)} ms is outside the declared ${low}–${high} ms range.`,
          });
          continue;
        }
      }
      results.push({ label, passed: true, detail: `${count} transitions observed.` });
    } else {
      const wanted = expectation.expect === 'high';
      // Zero transitions can still be a valid level (set once in setup); ask
      // the live electrical level in that case.
      const level = levelOf(pin) ?? (events.length ? events[events.length - 1].state : null);
      if (level === null) {
        results.push({
          label,
          passed: false,
          detail: `No transition was ever observed on pin ${expectation.pin} and its level could not be read, so ${expectation.expect.toUpperCase()} could not be confirmed.`,
        });
        continue;
      }
      const ended = `pin ${expectation.pin} ended ${level ? 'HIGH' : 'LOW'} after ${count} transition(s)`;
      results.push({
        label,
        passed: level === wanted,
        detail: level === wanted ? `${ended}, as expected.` : `${ended}; expected ${wanted ? 'HIGH' : 'LOW'}.`,
      });
    }
  }
  for (const expectation of expectations.serial) {
    let matched = false;
    try {
      matched = new RegExp(expectation.matches).test(serial);
    } catch {
      results.push({ label: `serial /${expectation.matches}/`, passed: false, detail: 'Invalid regex.' });
      continue;
    }
    results.push({
      label: `serial /${expectation.matches}/`,
      passed: matched,
      detail: matched ? 'Matched observed serial output.' : `Did not match any of the ${serial.length} chars of serial output.`,
    });
  }
  return results;
}

export async function runExpectations(
  expectations: AgentExpectations,
  boardId: string,
  signal: AbortSignal,
  deps: ExpectationDeps = {},
): Promise<ExpectationRun> {
  const sim = (deps.getSim ?? getBoardSimulator)(boardId);
  const state = (deps.getState ?? useSimulatorStore.getState)();
  const results: ExpectationResult[] = [];

  if (!(sim instanceof AVRSimulator)) {
    return {
      passed: false,
      supported: false,
      results: [
        {
          label: 'runtime',
          passed: false,
          detail:
            'The simulator runtime for this board does not expose pin-level observation, so declared expectations could not be checked.',
        },
      ],
      serial: '',
    };
  }

  // Resolve interactions to board pins BEFORE the window opens, so a wiring
  // mistake fails loudly instead of silently doing nothing.
  const driven: Action[] = [];
  const resolve = deps.resolvePin ?? traceBoardGpio;
  const dispatchSensor = deps.dispatchSensor ?? dispatchSensorUpdate;
  for (const interaction of expectations.interactions) {
    const label = `interaction ${interaction.kind} ${interaction.componentId}`;
    const atMs = interaction.at_ms ?? 500;
    if (interaction.kind === 'stimulus') {
      const values = Object.entries(interaction.values ?? {});
      if (!values.length) {
        results.push({ label, passed: false, detail: 'A stimulus needs at least one sensor value.' });
        continue;
      }
      driven.push({
        atMs,
        kind: 'sensor',
        componentId: interaction.componentId,
        values: Object.fromEntries(values),
      });
      continue;
    }
    const hit = pickPin(
      state,
      interaction.componentId,
      interaction.kind,
      interaction.pin,
      resolve,
      boardId,
    );
    if (!hit) {
      const pins = componentPins(state, interaction.componentId);
      results.push({
        label,
        passed: false,
        detail: `Could not trace ${interaction.componentId}${
          interaction.pin ? `.${interaction.pin}` : ''
        } (pins: ${pins.join(', ') || 'unknown'}) to a board GPIO; the interaction never happened electrically. The part is probably not wired to the board.`,
      });
      continue;
    }
    if (interaction.kind === 'press') {
      // Momentary switches are active LOW in this canvas (see the pushbutton
      // registration): pressed pulls the pin down, release lets it float up.
      driven.push({ atMs, kind: 'level', pin: hit.pin, high: false });
      driven.push({
        atMs: atMs + (interaction.hold_ms ?? 500),
        kind: 'level',
        pin: hit.pin,
        high: true,
      });
    } else if (interaction.kind === 'switch') {
      const low = closesLow(state, interaction.componentId, hit.pinName, boardId);
      if (low === null) {
        results.push({
          label,
          passed: false,
          detail: `${interaction.componentId}.${hit.pinName} is not wired to a rail, so toggling it has no defined electrical effect and was not attempted.`,
        });
        continue;
      }
      driven.push({
        atMs,
        kind: 'level',
        pin: hit.pin,
        high: (interaction.closed ?? true) ? !low : low,
      });
    } else if (interaction.kind === 'rotary') {
      const delta = interaction.delta ?? 1;
      const steps = Math.min(40, Math.abs(delta));
      for (let step = 0; step < steps; step += 1) {
        driven.push({ atMs: atMs + step * 2, kind: 'level', pin: hit.pin, high: true });
        driven.push({ atMs: atMs + step * 2 + 1, kind: 'level', pin: hit.pin, high: false });
      }
    } else {
      driven.push({
        atMs,
        kind: 'pot',
        pin: hit.pin,
        volts: ((interaction.value ?? 512) / 1023) * 5,
      });
    }
  }
  driven.sort((a, b) => a.atMs - b.atMs);

  // Observe every pin transition with simulated timestamps, chaining to any
  // existing consumer (e.g. a scope) instead of replacing it.
  const counts = new Map<number, number>();
  const recent = new Map<number, Transition[]>();
  const previous = sim.onPinChangeWithTime;
  sim.onPinChangeWithTime = (pin, level, atMs) => {
    counts.set(pin, (counts.get(pin) ?? 0) + 1);
    let window = recent.get(pin);
    if (!window) recent.set(pin, (window = []));
    window.push({ pin, state: level, atMs });
    if (window.length > RECENT_EVENTS) window.shift();
    previous?.(pin, level, atMs);
  };

  const started = Date.now();
  let next = 0;
  try {
    while (Date.now() - started < expectations.observe_ms) {
      signal.throwIfAborted();
      const elapsed = Date.now() - started;
      while (next < driven.length && driven[next].atMs <= elapsed) {
        const action = driven[next++];
        if (action.kind === 'pot') setAdcVoltage(sim, action.pin, action.volts);
        else if (action.kind === 'sensor') dispatchSensor(action.componentId, action.values);
        else sim.setPinState(action.pin, action.high);
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  } finally {
    sim.onPinChangeWithTime = previous;
  }
  signal.throwIfAborted();

  // Re-read AFTER the window: serial (and burnt state) accumulated during it.
  const serial = (deps.getState ?? useSimulatorStore.getState)().boards.find(
    (b) => b.id === boardId,
  )?.serialOutput ?? '';
  const levelOf: PinLevelReader = (pin) => getBoardPinManager(boardId)?.getPinState(pin) ?? null;
  results.push(...evaluateExpectations(expectations, counts, recent, serial, levelOf));

  return {
    passed: results.every((r) => r.passed),
    supported: true,
    results,
    serial: serial.slice(-1800),
  };
}
