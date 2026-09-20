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
import { setAdcVoltage } from '../simulation/parts/partUtils';
import { AVRSimulator } from '../simulation/AVRSimulator';
import { boardPinToNumber } from '../utils/boardPinMapping';
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

  // Resolve interactions to board pins BEFORE the window opens, so wiring the
  // trace cannot see fails loudly instead of silently doing nothing.
  const driven: Array<{ atMs: number; kind: 'press' | 'release' | 'pot'; pin: number; volts?: number }> = [];
  const resolve = deps.resolvePin ?? traceBoardGpio;
  for (const interaction of expectations.interactions) {
    const pinName = interaction.kind === 'press' ? '1.l' : 'SIG';
    const pin = resolve(state, interaction.componentId, pinName, boardId);
    if (pin === null) {
      results.push({
        label: `interaction ${interaction.kind} ${interaction.componentId}`,
        passed: false,
        detail: `Could not trace ${interaction.componentId}.${pinName} to a board GPIO; the interaction never happened electrically.`,
      });
      continue;
    }
    if (interaction.kind === 'press') {
      // Pushbuttons are active LOW (see the pushbutton part registration).
      driven.push({ atMs: interaction.at_ms, kind: 'press', pin });
      driven.push({ atMs: interaction.at_ms + interaction.hold_ms, kind: 'release', pin });
    } else {
      driven.push({ atMs: interaction.at_ms, kind: 'pot', pin, volts: (interaction.value / 1023) * 5 });
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
        if (action.kind === 'pot') setAdcVoltage(sim, action.pin, action.volts ?? 0);
        else sim.setPinState(action.pin, action.kind !== 'press');
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
