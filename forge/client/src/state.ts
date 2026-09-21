// Client-side mirror of the server's active-step lookup (schema.js).

import type { Phase, ProjectState, Step } from './types';

export interface StepRef {
  step: Step;
  index: number;
  total: number;
  phase: Phase;
}

export function activeStepRef(st: ProjectState | null | undefined): StepRef | null {
  if (!st || !Array.isArray(st.phases)) return null;
  const steps = st.phases.flatMap((p) => Array.isArray(p.steps) ? p.steps : []);
  let idx = steps.findIndex((s) => s.id === st.current?.stepId);
  if (idx < 0) idx = steps.findIndex((s) => s.status !== 'done');
  if (idx < 0) return null;
  const step = steps[idx];
  const phase = st.phases.find((p) => Array.isArray(p.steps) && p.steps.some((s) => s.id === step.id));
  return phase ? { step, index: idx, total: steps.length, phase } : null;
}

export function progressOf(st: ProjectState | null | undefined) {
  if (!st || !Array.isArray(st.phases)) return { completed: 0, total: 0, pct: 0 };
  const steps = st.phases.flatMap((p) => Array.isArray(p.steps) ? p.steps : []);
  const done = steps.filter((s) => s.status === 'done').length;
  return { completed: done, total: steps.length, pct: steps.length ? done / steps.length : 0 };
}
