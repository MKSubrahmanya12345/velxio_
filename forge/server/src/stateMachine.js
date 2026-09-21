// Forge — pure state-machine helpers (the "skeleton").
//
// No I/O here. The pipeline calls these to move the ProjectState after each
// Jev verdict; the confidence gating rules (J5) decide WHETHER to call them.

import { phaseIdOf, nextIncompleteStep } from './schema.js';

export function markStepComplete(state, step) {
  step.status = 'done';
  state.counters.stepsCompleted += 1;
}

// Advance to the next incomplete step, or null out the pointer when the plan
// is exhausted.
export function advanceStep(state) {
  const next = nextIncompleteStep(state);
  if (next) {
    state.current = { phaseId: phaseIdOf(state, next.id), stepId: next.id };
    return next;
  }
  state.current = { phaseId: null, stepId: null };
  return null;
}

export function skillOutcome(state, step, ok) {
  for (const sk of step.skills) {
    const e = state.skill[sk] ?? (state.skill[sk] = { successes: 0, fails: 0 });
    if (ok) e.successes += 1;
    else e.fails += 1;
  }
}

// A step needs a human safety acknowledgment when a high-severity hazard is
// present (per the latest J6 gate, or the plan metadata as fallback) and has
// not yet been acknowledged. Fail-safe: unknown `present` counts as present.
export function needsAck(state, step) {
  const gate = state.safetyGate?.stepId === step.id ? state.safetyGate.flags : step.safety;
  const highPresent = gate.some((f) => f.severity === 'high' && f.present !== false);
  return highPresent && !state.safetyAcks[step.id];
}
