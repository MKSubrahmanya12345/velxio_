// The debugger: one place where every event is labelled, timed, contextualised
// and made non-lossy.
//
// Why this exists. Before this layer the run stream was a handful of ad-hoc
// strings plus raw provider events. Two things fell out of that:
//
//   1. Errors could arrive with no message at all. Forge's failover emits
//      `{type:'error', …provider…, message}` for a single failed provider
//      ATTEMPT, while this app emitted `{type:'error', error}` for a terminal
//      failure — the UI read `ev.error` on both and printed "ERROR undefined".
//      A provider attempt is not a run failure, and neither is allowed to print
//      as `undefined` ever again.
//   2. Nothing carried *when*, *where in the pipeline*, or *how long*. Debugging
//      meant re-reading code. Now every event carries seq / ts / elapsed time /
//      run id / level / part context, and errors carry name+message+where+stack.
//
// Contract (the UI depends on it):
//   { seq, ts, t, runId, level, type, stage, message, partId?, part?, …payload }
// `message` is ALWAYS a non-empty string. `level` is one of the LEVELS below.

export const LEVELS = ['debug', 'info', 'success', 'warn', 'error'];

const LEVEL_RANK = { debug: 0, info: 1, success: 1, warn: 2, error: 3 };

export function levelRank(level) {
  return LEVEL_RANK[level] ?? 1;
}

// ── errors ───────────────────────────────────────────────────────────────────

/**
 * Turn ANY thrown thing into a complete, human-readable record.
 * Never returns an empty message — that is the whole point.
 */
export function describeError(err, { depth = 2, seen = new Set() } = {}) {
  if (err === null || err === undefined) {
    return { name: 'Error', message: 'Unknown error (nothing was thrown — this is a bug)', stack: '' };
  }
  if (typeof err === 'string') {
    return { name: 'Error', message: err, stack: '' };
  }
  if (typeof err !== 'object') {
    return { name: 'Error', message: `Non-error thrown: ${String(err)}`, stack: '' };
  }
  if (seen.has(err)) return { name: 'Error', message: '[circular error cause]', stack: '' };
  seen.add(err);

  const out = {
    name: err.name || err.constructor?.name || 'Error',
    message: err.message || err.error_description || err.error?.message || err.reason || '',
    stack: typeof err.stack === 'string' ? err.stack : '',
  };
  if (!out.message) {
    // Last resorts: an object with no message is still debuggable.
    try {
      const json = JSON.stringify(err, Object.getOwnPropertyNames(err));
      out.message = json && json !== '{}' ? json.slice(0, 500) : String(err);
    } catch {
      out.message = String(err);
    }
  }
  if (!out.message) out.message = `${out.name} thrown with no message`;

  for (const k of ['status', 'statusCode', 'code', 'provider', 'keyId', 'permanent', 'operation', 'where', 'partId', 'part', 'attempt']) {
    if (err[k] !== undefined && err[k] !== null) out[k] = err[k];
  }
  if (Array.isArray(err.attempts) && err.attempts.length) {
    out.attempts = err.attempts.map((a) => ({
      provider: a.provider,
      model: a.model,
      keyId: a.keyId,
      status: a.status ?? null,
      latencyMs: a.latencyMs ?? null,
      message: a.message || '(no message)',
    }));
  }
  if (err.cause && depth > 0) out.cause = describeError(err.cause, { depth: depth - 1, seen });
  return out;
}

/** A one-line version for logs and banners. */
export function errorSummary(err) {
  const d = describeError(err);
  const parts = [`${d.name}: ${d.message}`];
  if (d.status) parts.push(`HTTP ${d.status}`);
  if (d.provider) parts.push(`provider=${d.provider}`);
  if (d.cause?.message && d.cause.message !== d.message) parts.push(`cause: ${d.cause.message}`);
  return parts.join(' · ').replace(/\s+/g, ' ').slice(0, 600);
}

/** Wrap an error with pipeline context, preserving the original as `cause`. */
export function withContext(err, context = {}) {
  const described = describeError(err);
  const error = new Error(described.message);
  error.name = described.name;
  error.cause = err;
  error.status = described.status;
  Object.assign(error, context);
  // Keep the original stack readable in the UI: ours, then the cause.
  error.stack = `${error.name}: ${described.message}\n    at ${context.where || 'wiregi'}${context.part ? ` (part: ${context.part})` : ''}\n${described.stack || ''}`;
  return error;
}

// ── event labels ─────────────────────────────────────────────────────────────

/** Deterministic level per event, so the UI can colour the flow without rules. */
export function levelFor(ev) {
  if (ev.level && LEVELS.includes(ev.level)) return ev.level;
  switch (ev.type) {
    case 'error':
      return 'error';
    case 'done':
      return ev.status === 'complete' ? 'success' : ev.status === 'partial' ? 'warn' : 'info';
    case 'part':
      if (ev.stage === 'failed') return 'error';
      if (ev.stage === 'done') return ev.humanCheckpoint ? 'warn' : 'success';
      return 'info';
    case 'human':
      if (ev.stage === 'reject') return 'warn';
      return ev.stage === 'approve' ? 'success' : 'info';
    case 'provider':
      if (ev.stage === 'fail') return 'warn';
      if (ev.stage === 'round') return 'warn';
      return 'debug';
    case 'retry':
      return 'warn';
    case 'reconcile':
      if (ev.stage === 'failed') return 'error';
      if (ev.stage === 'conflict' || (ev.stage === 'done' && !ev.coherent)) return 'warn';
      return 'info';
    case 'phase':
      return ev.stage === 'start' ? 'debug' : 'info';
    case 'log':
      return LEVELS.includes(ev.level) ? ev.level : 'info';
    case 'run':
      return ev.stage === 'end' && ev.status === 'failed' ? 'error' : 'info';
    default:
      return 'info';
  }
}

/** Every event has a human sentence. Missing one is a bug, not a blank line. */
export function defaultMessage(ev) {
  if (typeof ev.message === 'string' && ev.message.trim()) return ev.message;
  const part = ev.part || ev.partId;
  const ms = Number.isFinite(ev.ms) ? ` (${ev.ms}ms)` : '';
  switch (ev.type) {
    case 'run':
      return ev.stage === 'start' ? `Run started — ${ev.goal || ''}`.trim() : `Run ${ev.status || 'ended'}${ms}`;
    case 'phase':
      return `${ev.stage === 'start' ? 'Started' : 'Finished'} ${ev.name}${ms}`;
    case 'part':
      return `${part || 'part'} ${ev.stage}${ms}`;
    case 'provider':
      return `${ev.provider || 'provider'}/${ev.model || '?'} ${ev.stage}${ms}${
        ev.status ? ` — HTTP ${ev.status}` : ''
      }`;
    case 'decision':
      return `Decision ${ev.label || ''} (${ev.source || '?'})`.trim();
    case 'batch':
      return `Batch ${ev.stage}: ${ev.ok ?? 0} ok / ${ev.failed ?? 0} failed of ${ev.total ?? 0}`;
    case 'reconcile':
      return `Integration ${ev.stage}${ms}${ev.reason ? ` — ${ev.reason}` : ''}`;
    case 'research':
      return `${part ? `${part}: ` : ''}${ev.stage || 'research'}`;
    case 'project':
      return `Project ${ev.stage}`;
    case 'human':
      return `${part || 'checkpoint'} ${ev.stage}`;
    case 'chat':
      return `Message from ${ev.role}`;
    case 'done':
      return `Run finished — ${ev.status}`;
    case 'log':
      return ev.text || '(log)';
    case 'error':
      return `Failed${ev.where ? ` in ${ev.where}` : ''}: ${
        (ev.error && (ev.error.message || ev.error.name)) || 'see details'
      }`;
    default:
      return ev.type || 'event';
  }
}

// ── ring buffer for the durable run log ──────────────────────────────────────

export const trimText = (v, n) => (typeof v === 'string' && v.length > n ? `${v.slice(0, n)}…` : v);

/** Compact an event for persistence (the live stream keeps the full payload). */
export function toLogEntry(ev, limit = 900) {
  const entry = {
    seq: ev.seq,
    ts: ev.ts,
    t: ev.t,
    runId: ev.runId,
    level: ev.level,
    type: ev.type,
    stage: ev.stage,
    partId: ev.partId,
    part: ev.part,
    message: trimText(String(ev.message || ''), 500),
  };
  const data = {};
  for (const k of ['error', 'decision', 'answers', 'provider', 'model', 'keyId', 'status', 'latencyMs',
                   'attempt', 'attempts', 'retries', 'waitMs', 'ok', 'failed', 'total', 'ms', 'profile',
                   'conflicts', 'blocking', 'patchesApplied', 'reason', 'tier', 'note', 'action', 'engine',
                   'count', 'results', 'name', 'coherent', 'summary', 'text']) {
    if (ev[k] === undefined) continue;
    const v = ev[k];
    if (typeof v === 'object' && v !== null) {
      let json = '';
      try {
        json = JSON.stringify(v);
      } catch {
        json = '[unserialisable]';
      }
      data[k] = json.length > limit ? trimText(json, limit) : v;
    } else {
      data[k] = trimText(v, limit);
    }
  }
  if (Object.keys(data).length) entry.data = data;
  return entry;
}

export function pushRunLog(project, entry, limit = 2000) {
  const log = project.state.runLog || (project.state.runLog = []);
  log.push(entry);
  if (log.length > limit) log.splice(0, log.length - limit);
  return log;
}

// ── tracer ───────────────────────────────────────────────────────────────────

const nowIso = () => new Date().toISOString();

/**
 * Wrap a raw stream `emit` so every event becomes a labelled, timed, contextual
 * trace event — and so a `null`/`undefined` field can never reach the UI.
 */
export function createTracer({
  emit = () => {},
  project,
  runId,
  limit = 2000,
  debug = false,
  baseContext = {},
  // One session per run: seq + elapsed time stay global even for child tracers.
  session = { startedAt: Date.now(), seq: 0 },
}) {
  const { startedAt } = session;
  const nextSeq = () => (session.seq += 1);

  function publish(payload, context) {
    const ev = { ...baseContext, ...(context || {}), ...payload };
    const seq = nextSeq();
    const full = {
      ...ev,
      seq,
      ts: nowIso(),
      t: Date.now() - startedAt,
      runId,
      level: levelFor(ev),
      type: ev.type || 'log',
      stage: ev.stage,
    };
    full.message = defaultMessage(full);
    if (full.error && typeof full.error === 'object' && !full.error.message) {
      full.error = describeError(full.error);
    }
    // Keep the durable copy small, but always log it.
    if (project) pushRunLog(project, toLogEntry(full), limit);
    if (debug) console.log(formatConsoleLine(full));
    try {
      emit(full);
    } catch (err) {
      // A broken consumer must never take a run down.
      console.error('[wiregi] emit failed:', errorSummary(err));
    }
    return full;
  }

  const tracer = {
    runId,
    startedAt,
    get seq() {
      return session.seq;
    },
    emit: (payload) => publish(payload, null),
    /** An emitter bound to a part/phase — the context then rides every event. */
    child: (context) =>
      createTracer({ emit, project, runId, limit, debug, session, baseContext: { ...baseContext, ...context } }),
    log: (level, message, data = {}) => publish({ type: 'log', level, message, text: message, ...data }, null),
    debug: (message, data) => publish({ type: 'log', level: 'debug', message, text: message, ...data }, null),
    info: (message, data) => publish({ type: 'log', level: 'info', message, text: message, ...data }, null),
    warn: (message, data) => publish({ type: 'log', level: 'warn', message, text: message, ...data }, null),
    error: (err, context = {}) =>
      publish({ type: 'error', error: describeError(err), where: context.where, ...context }, null),
    /** Time a step: returns done(detail) → ms, emitted as a phase event. */
    phase: (name, context) => {
      const t0 = Date.now();
      const scoped = tracer.child({ ...context, phase: name });
      scoped.emit({ type: 'phase', stage: 'start', name, message: `▸ ${name}` });
      let done = false;
      return (detail = {}) => {
        if (done) return 0;
        done = true;
        const ms = Date.now() - t0;
        scoped.emit({ type: 'phase', stage: 'end', name, ms, ...detail });
        return ms;
      };
    },
  };
  return tracer;
}

function formatConsoleLine(ev) {
  const level = String(ev.level || 'info').toUpperCase().padEnd(7);
  const t = `+${String(((ev.t ?? 0) / 1000).toFixed(2)).padStart(7)}s`;
  const where = [ev.part, ev.phase].filter(Boolean).join('/');
  const line = `[wiregi ${t}] ${level} ${ev.type}${ev.stage ? `.${ev.stage}` : ''} ${where ? `(${where}) ` : ''}${ev.message}`;
  if (ev.error?.stack && ev.level === 'error') {
    return `${line}\n${String(ev.error.stack)
      .split('\n')
      .slice(0, 6)
      .map((l) => `            ${l.trim()}`)
      .join('\n')}`;
  }
  return line;
}
