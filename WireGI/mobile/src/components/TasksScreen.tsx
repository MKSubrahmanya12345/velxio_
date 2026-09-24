import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Project, ProjectSummary } from '../lib/types';
import { statusLabel } from '../lib/types';
import { getProject } from '../lib/api';
import { loadTicks, saveTicks, tasksOf, type TaskItem } from '../lib/tasks';
import Avatar from './Avatar';

type Filter = 'all' | 'blocking' | 'question' | 'check';

/**
 * Tasks — the aggregated action list. WireGI spreads what needs you across
 * three surfaces (integration conflicts, per-part open questions, per-part
 * verification checklists); this flattens all three into one checkable list,
 * grouped by build. Ticks are local; conflicts/questions deep-link into the
 * thread where the real answer happens.
 */
export default function TasksScreen({
  projects,
  onOpenThread,
  onCountChange,
}: {
  projects: ProjectSummary[];
  onOpenThread: (id: string) => void;
  onCountChange: (open: number) => void;
}) {
  const [cache, setCache] = useState<Record<string, Project>>({});
  const [ticks, setTicks] = useState<Record<string, boolean>>(() => loadTicks());
  const [filter, setFilter] = useState<Filter>('all');
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    if (!projects.length) return;
    const settled = await Promise.allSettled(projects.map((p) => getProject(p.id)));
    const next: Record<string, Project> = { ...cache };
    let changed = false;
    settled.forEach((r) => {
      if (r.status === 'fulfilled') {
        const p = r.value;
        if (next[p.id]?.updatedAt !== p.updatedAt) {
          next[p.id] = p;
          changed = true;
        }
      }
    });
    if (changed) {
      setCache(next);
    } else {
      setCache((prev) => {
        const grew = Object.keys(next).length !== Object.keys(prev).length;
        return grew ? next : prev;
      });
    }
    setLoaded(true);
  }, [projects, cache]);

  useEffect(() => {
    setLoaded(false);
    void refresh();
    const id = setInterval(refresh, 8000);
    return () => clearInterval(id);
  }, [refresh]);

  const allTasks = useMemo(() => Object.values(cache).flatMap((p) => tasksOf(p)), [cache]);
  const openCount = useMemo(() => allTasks.filter((t) => !ticks[t.key]).length, [allTasks, ticks]);

  useEffect(() => {
    onCountChange(openCount);
  }, [openCount, onCountChange]);

  const toggle = (key: string) => {
    setTicks((prev) => {
      const next = { ...prev };
      if (next[key]) delete next[key];
      else next[key] = true;
      saveTicks(next);
      return next;
    });
  };

  const grouped = useMemo(() => {
    const byProject = new Map<string, TaskItem[]>();
    for (const t of allTasks) {
      if (ticks[t.key]) continue;
      const list = byProject.get(t.projectId) || [];
      list.push(t);
      byProject.set(t.projectId, list);
    }
    const out: Array<{ projectId: string; goal: string; tasks: TaskItem[] }> = [];
    for (const p of projects) {
      const list = byProject.get(p.id);
      if (list?.length) out.push({ projectId: p.id, goal: p.goal, tasks: list });
    }
    // any project still missing from the summaries list (loaded later) appended
    for (const [projectId, tasks] of byProject) {
      if (!out.some((g) => g.projectId === projectId)) {
        out.push({ projectId, goal: tasks[0].projectGoal, tasks });
      }
    }
    return out;
  }, [allTasks, ticks, projects]);

  const shown = useMemo(() => {
    if (filter === 'all') return grouped;
    return grouped
      .map((g) => ({
        ...g,
        tasks: g.tasks.filter((t) =>
          filter === 'blocking' ? t.kind === 'conflict' && t.severity === 'blocking' : t.kind === filter,
        ),
      }))
      .filter((g) => g.tasks.length > 0);
  }, [grouped, filter]);

  const counts = useMemo(() => {
    const blocking = allTasks.filter(
      (t) => !ticks[t.key] && t.kind === 'conflict' && t.severity === 'blocking',
    ).length;
    const questions = allTasks.filter((t) => !ticks[t.key] && t.kind === 'question').length;
    const checks = allTasks.filter((t) => !ticks[t.key] && t.kind === 'check').length;
    return { blocking, questions, checks };
  }, [allTasks, ticks]);

  return (
    <div className="tasks">
      <header className="wa-header">
        <div className="wa-header-title">
          <h1>Tasks</h1>
          <span className="wa-header-sub">
            {openCount > 0 ? `${openCount} open · ${counts.blocking} blocking` : 'all clear'}
          </span>
        </div>
        {openCount > 0 && <span className="needs-badge">{openCount}</span>}
      </header>

      <div className="tasks-filters">
        {(
          [
            ['all', 'All', openCount],
            ['blocking', 'Blocking', counts.blocking],
            ['question', 'Questions', counts.questions],
            ['check', 'Checks', counts.checks],
          ] as Array<[Filter, string, number]>
        ).map(([key, label, n]) => (
          <button
            key={key}
            className={`task-filter${filter === key ? ' active' : ''}`}
            onClick={() => setFilter(key)}
          >
            {label}
            {n > 0 ? <span className="task-filter-n">{n}</span> : null}
          </button>
        ))}
      </div>

      <div className="tasks-scroll">
        {!loaded && projects.length === 0 && (
          <div className="empty">
            <p className="empty-title">Nothing to do yet</p>
            <p className="empty-sub">Start a build on your computer and the tasks it surfaces appear here.</p>
          </div>
        )}

        {loaded && shown.length === 0 && (
          <div className="empty">
            <p className="empty-title">
              <span className="ok-check">✓</span> {filter === 'all' ? 'All caught up' : 'Nothing here'}
            </p>
            <p className="empty-sub">
              {filter === 'all'
                ? 'No open conflicts, questions or checklist steps. Everything needing your eyes is done.'
                : 'No tasks of this kind in the open list right now.'}
            </p>
          </div>
        )}

        {shown.map((g) => {
          const summary = projects.find((p) => p.id === g.projectId);
          const needsYou = summary?.needsYou ?? 0;
          return (
            <section className="task-group" key={g.projectId}>
              <div className="task-group-head">
                <Avatar name={g.goal} status={summary?.status} size={38} />
                <button className="task-group-meta" onClick={() => onOpenThread(g.projectId)}>
                  <div className="task-group-goal">{g.goal}</div>
                  <div className="task-group-sub">
                    {summary ? statusLabel(summary.status) : '…'}
                    {needsYou > 0 ? ` · ${needsYou} awaiting` : ''} · {g.tasks.length} open
                  </div>
                </button>
                <button className="circle-btn" onClick={() => onOpenThread(g.projectId)} aria-label="Open" title="Open in chat">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9 6l6 6-6 6" />
                  </svg>
                </button>
              </div>

              <div className="task-list">
                {g.tasks.map((t) => (
                  <TaskRow key={t.key} task={t} onToggle={() => toggle(t.key)} onOpen={() => onOpenThread(g.projectId)} />
                ))}
              </div>
            </section>
          );
        })}

        <div className="tasks-foot">Ticks live on this device only.</div>
      </div>
    </div>
  );
}

function TaskRow({
  task,
  onToggle,
  onOpen,
}: {
  task: TaskItem;
  onToggle: () => void;
  onOpen: () => void;
}) {
  const clickable = task.kind !== 'check';
  return (
    <div
      className={`task-row task-row--${task.kind}${task.severity === 'blocking' ? ' task-row--blocking' : ''}`}
      role="button"
      tabIndex={0}
      onClick={clickable ? onOpen : undefined}
      onKeyDown={(e) => {
        if (clickable && (e.key === 'Enter' || e.key === ' ')) onOpen();
      }}
    >
      <TaskGlyph kind={task.kind} severity={task.severity} />
      <div className="task-body">
        <div className="task-title">{task.title}</div>
        {task.ref && <div className="task-ref">{task.ref}</div>}
        {task.resolution && <div className="task-res">→ {task.resolution}</div>}
      </div>
      <button
        className={`task-check${task.kind === 'check' ? '' : ' task-check--soft'}`}
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        aria-label="Mark done"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 6L9 17l-5-5" />
        </svg>
      </button>
    </div>
  );
}

function TaskGlyph({ kind, severity }: { kind: TaskItem['kind']; severity?: 'blocking' | 'warning' }) {
  const cls = `task-glyph task-glyph--${kind}${severity === 'blocking' ? ' task-glyph--blocking' : ''}`;
  if (kind === 'conflict') {
    return (
      <span className={cls}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 9v4M12 17h.01" />
          <path d="M10.3 3.6L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.6a2 2 0 0 0-3.4 0z" />
        </svg>
      </span>
    );
  }
  if (kind === 'question') {
    return (
      <span className={cls}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 9a3 3 0 1 1 4 2.8c-.7.3-1 1-1 1.7V14M12 18h.01" />
        </svg>
      </span>
    );
  }
  return (
    <span className={cls}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 11l3 3L22 4" />
        <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
      </svg>
    </span>
  );
}