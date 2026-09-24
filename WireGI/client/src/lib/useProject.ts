import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createProject,
  getDebugBundle,
  getProject,
  research as researchApi,
  respondHuman,
  resumeProject,
  sendMessage,
  type HumanDecision,
} from '../api';
import type { ErrorRecord, FlowEntry, Part, Project } from '../types';

const FLOW_LIMIT = 2500;

export interface LivePart {
  id: string;
  name: string;
  domain?: string;
  status: string;
  stage?: string;
  tier?: string | null;
  attempts?: number;
  error?: string | null;
  errorDetail?: ErrorRecord | null;
  startedAt?: number;
  ms?: number;
  provider?: string;
  model?: string;
  humanCheckpoint?: boolean;
}

export interface PhaseTiming {
  name: string;
  ms: number;
  at: number;
}

export interface RunState {
  running: boolean;
  kind?: string;
  runId?: string;
  startedAt?: number;
  status?: string;
  currentPhase?: string;
  phases: PhaseTiming[];
  total: number;
  done: number;
  failed: number;
  error?: ErrorRecord | null;
  lastMessage?: string;
}

const emptyRun: RunState = { running: false, phases: [], total: 0, done: 0, failed: 0 };

/**
 * All project state in one place: the durable project, the live trace, the
 * per-part live overlay and the run summary. Everything the chat panel and the
 * inspector render comes from here.
 */
export function useProject(projectId: string | null) {
  const [project, setProject] = useState<Project | null>(null);
  const [flow, setFlow] = useState<FlowEntry[]>([]);
  const [live, setLive] = useState<Record<string, LivePart>>({});
  const [run, setRun] = useState<RunState>(emptyRun);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    if (!projectId) return null;
    try {
      const p = await getProject(projectId);
      setProject(p);
      setLoadError(null);
      return p;
    } catch (err: any) {
      setLoadError(String(err?.message || err));
      return null;
    }
  }, [projectId]);

  /** Fold a persisted run log into the live flow without duplicating events. */
  const mergeRestored = useCallback((entries: FlowEntry[]) => {
    if (!entries.length) return;
    const restored: FlowEntry[] = entries.map((e) => ({
      ...(e.data || {}),
      ...e,
      receivedAt: Date.parse(e.ts || '') || Date.now(),
    }));
    setFlow((prev) => {
      const maxSeq = prev.reduce((m, e) => Math.max(m, e.seq ?? 0), 0);
      const add = restored.filter((e) => (e.seq ?? 0) > maxSeq);
      if (!add.length) return prev;
      const next = [...prev, ...add];
      return next.length > FLOW_LIMIT ? next.slice(next.length - FLOW_LIMIT) : next;
    });
  }, []);

  // Load the project + its persisted trace (so a reload keeps the history).
  useEffect(() => {
    if (!projectId) {
      setProject(null);
      setFlow([]);
      setLive({});
      setRun(emptyRun);
      return;
    }
    let cancelled = false;
    setFlow([]);
    setLive({});
    setRun(emptyRun);
    (async () => {
      const p = await refresh();
      if (cancelled || !p) return;
      try {
        const dbg = await getDebugBundle(p.id);
        if (cancelled) return;
        mergeRestored((dbg.runLog || []).slice(-FLOW_LIMIT));
      } catch {
        /* the trace is optional — the project itself still renders */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, refresh, mergeRestored]);

  // A project that is being worked on *elsewhere* — or one opened mid-run after a
  // reload — still has to look alive. Poll the persisted project + trace while a
  // run is in flight, and stop the moment it settles.
  useEffect(() => {
    if (!projectId || busy) return;
    const inFlight = run.running || project?.status === 'init' || project?.status === 'researching';
    if (!inFlight) return;
    let cancelled = false;
    const tick = async () => {
      const p = await refresh();
      if (cancelled || !p) return;
      try {
        const dbg = await getDebugBundle(p.id);
        if (!cancelled) mergeRestored((dbg.runLog || []).slice(-FLOW_LIMIT));
      } catch {
        /* trace is best-effort */
      }
    };
    const id = setInterval(tick, 2500);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [projectId, busy, run.running, project?.status, refresh, mergeRestored]);

  const absorb = useCallback((ev: FlowEntry) => {
    setFlow((prev) => {
      const next = [...prev, ev];
      return next.length > FLOW_LIMIT ? next.slice(next.length - FLOW_LIMIT) : next;
    });

    setRun((prev) => {
      const r: RunState = { ...prev, lastMessage: ev.message || prev.lastMessage };
      switch (ev.type) {
        case 'run':
          if (ev.stage === 'start') {
            return {
              ...emptyRun,
              running: true,
              kind: ev.kind,
              runId: ev.runId,
              startedAt: Date.now(),
              currentPhase: 'starting',
            };
          }
          return { ...r, running: false, status: ev.status || r.status };
        case 'phase':
          if (ev.stage === 'start') return { ...r, currentPhase: ev.name };
          if (ev.stage === 'end' && ev.name) {
            return { ...r, phases: [...r.phases, { name: ev.name, ms: ev.ms || 0, at: Date.now() }].slice(-60) };
          }
          return r;
        case 'project':
          if (ev.stage === 'decomposed') return { ...r, total: ev.parts?.length || r.total, currentPhase: 'research' };
          return r;
        case 'batch':
          return ev.stage === 'start' ? { ...r, total: ev.total || r.total } : r;
        case 'done':
          return { ...r, status: ev.status || 'done', running: false, currentPhase: 'done' };
        case 'error':
          return {
            ...r,
            running: false,
            error: (typeof ev.error === 'object' && ev.error) || { message: ev.message },
          };
        default:
          return r;
      }
    });

    if (ev.type === 'project' && ev.stage === 'decomposed' && ev.parts) {
      setLive((prev) => {
        const next = { ...prev };
        for (const p of ev.parts || []) {
          next[p.id] = {
            id: p.id,
            name: p.name,
            domain: p.domain,
            status: prev[p.id]?.status && prev[p.id].status !== 'pending' ? prev[p.id].status : 'pending',
          };
        }
        return next;
      });
    }

    if (ev.type === 'part' && ev.partId) {
      setLive((prev) => {
        const cur: LivePart =
          prev[ev.partId!] || ({ id: ev.partId!, name: ev.part || ev.partId!, status: 'pending' } as LivePart);
        const patch: LivePart = { ...cur };
        if (ev.stage === 'start') {
          patch.status = 'researching';
          patch.startedAt = Date.now();
          patch.stage = 'research';
          if (ev.attempt) patch.attempts = ev.attempt;
          if (ev.tier) patch.tier = ev.tier;
        } else if (ev.stage === 'done') {
          patch.status = ev.humanCheckpoint ? 'awaiting_human' : 'data_ready';
          patch.stage = 'done';
          patch.ms = ev.ms ?? patch.ms;
          patch.humanCheckpoint = ev.humanCheckpoint;
          if (ev.provider) patch.provider = ev.provider;
          if (ev.model) patch.model = ev.model;
        } else if (ev.stage === 'failed') {
          patch.status = 'failed';
          patch.stage = 'failed';
          patch.error = typeof ev.error === 'object' ? ev.error?.message : (ev.error as string) || ev.message;
          patch.errorDetail = typeof ev.error === 'object' ? ev.error : { message: ev.message };
          patch.ms = ev.ms ?? patch.ms;
        }
        return { ...prev, [ev.partId!]: patch };
      });
      setRun((prev) => {
        if (ev.stage === 'done') return { ...prev, done: prev.done + 1 };
        if (ev.stage === 'failed') return { ...prev, failed: prev.failed + 1 };
        return prev;
      });
    }

    if (ev.type === 'research' && ev.partId && (ev.tier || ev.stage === 'gate')) {
      setLive((prev) => {
        const cur = prev[ev.partId!];
        if (!cur) return prev;
        return { ...prev, [ev.partId!]: { ...cur, tier: ev.tier || ev.action || cur.tier } };
      });
    }

    // The human checkpoint: reflect an approval immediately in the live overlay,
    // so the card stops saying "needs your eyes" the moment you say so.
    if (ev.type === 'human' && ev.partId) {
      setLive((prev) => {
        const cur = prev[ev.partId!];
        if (!cur) return prev;
        if (ev.stage === 'approve') {
          return { ...prev, [ev.partId!]: { ...cur, status: 'verified', humanCheckpoint: false, stage: 'verified' } };
        }
        // A blocked approval (needsInput) changes nothing — leave the card as is.
        if (ev.stage === 'approve-blocked') return prev;
        return { ...prev, [ev.partId!]: { ...cur, stage: 'research', status: 'researching' } };
      });
      setRun((prev) => (ev.stage === 'approve' ? { ...prev, done: prev.done + 1 } : prev));
    }
  }, []);

  const runStream = useCallback(
    async (
      executor: (onEvent: (e: FlowEntry) => void, signal: AbortSignal) => Promise<Project>,
      kind: string,
    ) => {
      if (!projectId && kind !== 'build') return null;
      setBusy(true);
      setRun({ ...emptyRun, running: true, kind, startedAt: Date.now() });
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const p = await executor(absorb, controller.signal);
        if (p) setProject(p);
        const fresh = await refresh();
        if (fresh) setProject(fresh);
        return p;
      } catch (err: any) {
        absorb({
          type: 'error',
          stage: 'client',
          where: kind,
          fatal: true,
          message: String(err?.message || err),
          error: { name: err?.name || 'Error', message: String(err?.message || err), where: err?.where },
        });
        return null;
      } finally {
        abortRef.current = null;
        setBusy(false);
        setRun((prev) => ({ ...prev, running: false }));
      }
    },
    [absorb, projectId, refresh],
  );

  const send = useCallback(
    (text: string) => runStream((onEvent, signal) => sendMessage(projectId!, text, onEvent, signal), 'message'),
    [projectId, runStream],
  );

  const resume = useCallback(
    () => runStream((onEvent, signal) => resumeProject(projectId!, onEvent, signal), 'resume'),
    [projectId, runStream],
  );

  /**
   * The human checkpoint, from the chat: approve / answer / send back / reject.
   * Deterministic on the server (no LLM), so it keeps working with zero keys.
   */
  const human = useCallback(
    (payload: { partId?: string | null; decision: HumanDecision; text?: string }) =>
      runStream((onEvent, signal) => respondHuman(projectId!, payload, onEvent, signal), 'human'),
    [projectId, runStream],
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const askResearch = useCallback(async (query: string) => researchApi(query), []);

  const parts: Part[] = useMemo(() => {
    const base = project?.state.parts || [];
    const merged = base.map((p) => (live[p.id] ? mergePart(p, live[p.id]) : p));
    // a part that only exists live (mid-decomposition) still shows up
    for (const lp of Object.values(live)) {
      if (!merged.some((m) => m.id === lp.id)) merged.push(liveToPart(lp));
    }
    return merged;
  }, [project, live]);

  const failedParts = parts.filter((p) => p.status === 'failed');
  const pendingParts = parts.filter((p) => p.status === 'pending' || p.status === 'researching');
  /**
   * Everything still waiting on the human: parts that asked for eyes, parts the
   * agent could not resolve on its own (needsInput — those want ANSWERS, and
   * the card will not offer approval for them), plus every researched part
   * whenever the project itself is `awaiting_human` (the D4–D6 gate can require
   * human verification even when no single part raised a checkpoint of its
   * own). This is what the chat's checkpoint card renders — an `awaiting_human`
   * project is never a dead end.
   */
  const checkpointParts = parts.filter(
    (p) =>
      !p.verified &&
      p.status !== 'failed' &&
      Boolean(p.current?.data) &&
      (p.humanCheckpoint || p.needsInput || project?.status === 'awaiting_human'),
  );

  return {
    project,
    flow,
    live,
    run,
    busy,
    loadError,
    parts,
    failedParts,
    pendingParts,
    checkpointParts,
    refresh,
    send,
    resume,
    human,
    cancel,
    askResearch,
    startBuild: (goal: string) =>
      runStream((onEvent, signal) => createProject(goal, {}, onEvent, signal), 'build'),
    clearFlow: () => setFlow([]),
  };
}

function mergePart(p: Part, l: LivePart): Part {
  return {
    ...p,
    status: l.status || p.status,
    attempts: l.attempts ?? p.attempts,
    error: l.error ?? p.error,
    errorDetail: l.errorDetail ?? p.errorDetail,
    tier: l.tier ?? p.tier,
    humanCheckpoint: l.humanCheckpoint ?? p.humanCheckpoint,
    live: true,
    meta: l.provider ? { ...(p.meta || {}), provider: l.provider, model: l.model } : p.meta,
  };
}

function liveToPart(l: LivePart): Part {
  return {
    id: l.id,
    name: l.name,
    domain: l.domain || '—',
    status: l.status,
    live: true,
    attempts: l.attempts,
    error: l.error,
    errorDetail: l.errorDetail,
    tier: l.tier,
    humanCheckpoint: l.humanCheckpoint,
    meta: l.provider ? { provider: l.provider, model: l.model } : null,
  };
}
