import type { Project } from './types';

// Task synthesis for the mobile "Tasks" tab.
//
// A build produces work that is scattered across surfaces: blocking/review
// conflicts live on integration passes, questions live per part, and each part
// ships a verification checklist. This flattens all three into one checkable
// to-do list. Ticks are local-only (the server has no todo state); conflicts
// and questions get their key from the data that created them, so a fresh
// reconcile pass produces a fresh set — the old ones simply disappear.

export type TaskKind = 'conflict' | 'question' | 'check';

export interface TaskItem {
  /** Stable id used for tick persistence. */
  key: string;
  projectId: string;
  projectGoal: string;
  kind: TaskKind;
  severity?: 'blocking' | 'warning';
  /** For a conflict: "Board ↔ Firmware". For a question/check: the owning part. */
  ref?: string;
  title: string;
  /** Conflict resolution ("→ …") when the engine provided one. */
  resolution?: string;
  partId?: string;
  partName?: string;
}

export function tasksOf(project: Project): TaskItem[] {
  const items: TaskItem[] = [];
  const goal = project.goal;

  const latestPass = (project.state.reconciliations || [])
    .filter((r) => !r.skipped && !r.failed)
    .slice(-1)[0];
  if (latestPass && latestPass.conflicts?.length) {
    latestPass.conflicts.forEach((c, i) => {
      const ref = (c.parts || []).join(' ↔ ');
      items.push({
        key: `c:${project.id}:${latestPass.at}:${i}`,
        projectId: project.id,
        projectGoal: goal,
        kind: 'conflict',
        severity: c.severity,
        ref,
        title: c.issue,
        resolution: c.resolution,
      });
    });
  }

  for (const p of project.state.parts || []) {
    for (const q of p.openQuestions || []) {
      // The reconcile pass re-injects integration verdicts as ordinary open
      // questions; those are either covered by (real) conflict tasks or stale
      // once a later pass goes coherent — so keep only genuine human questions.
      if (/^integration (conflict|note):/i.test(q.trim())) continue;
      if (/^none[!\.,]?$|^none specific/i.test(q.trim())) continue;
      items.push({
        key: `q:${p.id}:${q}`,
        projectId: project.id,
        projectGoal: goal,
        kind: 'question',
        ref: p.name,
        title: q,
        partId: p.id,
        partName: p.name,
      });
    }
    const checklist = p.checklist || p.current?.data?.checklist || [];
    for (const c of checklist) {
      items.push({
        key: `k:${p.id}:${c}`,
        projectId: project.id,
        projectGoal: goal,
        kind: 'check',
        ref: p.name,
        title: c,
        partId: p.id,
        partName: p.name,
      });
    }
  }

  return items;
}

/* ── tick persistence (local only) ─────────────────────────────────────── */

const LS_KEY = 'wiregi.tasks.ticks.v1';

export function loadTicks(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

export function saveTicks(ticks: Record<string, boolean>): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(ticks));
  } catch {
    /* storage unavailable — ticks just won't persist */
  }
}

/** Counts for a project (used by the list row badge + tasks screen header). */
export function summarize(tasks: TaskItem[], ticks: Record<string, boolean>) {
  const open = tasks.filter((t) => !ticks[t.key]);
  return {
    total: tasks.length,
    done: tasks.length - open.length,
    open: open,
    blocking: open.filter((t) => t.kind === 'conflict' && t.severity === 'blocking').length,
    questions: open.filter((t) => t.kind === 'question').length,
    checks: open.filter((t) => t.kind === 'check').length,
  };
}