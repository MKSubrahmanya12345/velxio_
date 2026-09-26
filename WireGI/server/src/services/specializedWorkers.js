import { researchPart } from './research.js';
import { newId } from '../models/project.js';
import { describeError } from './debug.js';

const now = () => new Date().toISOString();

function isCodePart(part) {
  const text = `${part.name} ${part.domain} ${part.idea?.summary || ''}`.toLowerCase();
  return /(firmware|software|code|web|server|frontend|backend|api|protocol|wifi|bluetooth|mqtt|websocket)/.test(text);
}

async function runWorker({ worker, parts, project, registry, indexer, emit, prefer, guidance }) {
  const workerRunId = newId(worker);
  project.state.workers ||= {};
  project.state.workers[worker] = {
    id: workerRunId,
    status: 'working',
    partIds: parts.map((p) => p.id),
    startedAt: now(),
  };
  emit?.({ type: 'worker', worker, stage: 'start', message: `${worker === 'hardware' ? 'Hardware' : 'Coding'} worker started.`, workerRunId, ts: now() });

  const results = await Promise.all(parts.map(async (part) => {
    part.status = 'researching';
    part.attempts = (part.attempts || 0) + 1;
    part.startedAt = now();
    try {
      const result = await researchPart({
        part,
        project,
        registry,
        indexer,
        emit,
        prefer,
        guidance,
      });
      part.current = { gathered: result.gathered, understand: result.understand, data: result.data };
      part.data = result.data;
      part.gathered = result.gathered || [];
      part.research = result.research || [];
      part.openQuestions = result.understand?.openQuestions || [];
      part.humanCheckpoint = Boolean(result.humanCheckpoint);
      part.status = part.humanCheckpoint ? 'awaiting_human' : 'data_ready';
      part.updatedAt = now();
      part.finishedAt = part.updatedAt;
      part.error = null;
      part.errorDetail = null;
      part.evidence = [...(part.evidence || []), {
        rung: 'research',
        at: part.updatedAt,
        by: worker,
        detail: result.web?.engine || 'research synthesis',
      }];
      return { ok: true, part };
    } catch (err) {
      const d = describeError(err);
      part.status = 'failed';
      part.error = d.message;
      part.errorDetail = d;
      return { ok: false, part, error: d };
    }
  }));

  project.state.workers[worker] = {
    ...project.state.workers[worker],
    status: results.some((r) => !r.ok) ? 'partial' : 'complete',
    finishedAt: now(),
    results: results.map((r) => ({ partId: r.part.id, ok: r.ok, error: r.error || null })),
  };
  emit?.({ type: 'worker', worker, stage: 'complete', message: `${worker === 'hardware' ? 'Hardware' : 'Coding'} worker finished.`, workerRunId, results: project.state.workers[worker].results, ts: now() });
  return results;
}

export function createSpecializedWorkers({ registry, indexer }) {
  async function run({ project, emit, prefer }) {
    project.state.workers ||= {};
    const parts = project.state.parts || [];
    const hardwareParts = parts.filter((p) => !isCodePart(p));
    const codingParts = parts.filter((p) => isCodePart(p));

    // The two workers share the exact same project object and execute their
    // independent work concurrently. They use the existing evidence pipeline;
    // they do not invent wiring or code facts from an LLM-only wrapper.
    const [hardware, coding] = await Promise.all([
      runWorker({
        worker: 'hardware',
        parts: hardwareParts,
        project,
        registry,
        indexer,
        emit,
        prefer,
        guidance: 'Act as the hardware engineer. Focus on exact component identity, electrical properties, board pinout, wiring, power, interfaces, and compatibility. Do not invent specifications.',
      }),
      runWorker({
        worker: 'coding',
        parts: codingParts,
        project,
        registry,
        indexer,
        emit,
        prefer,
        guidance: 'Act as the software/firmware engineer. Focus on exact firmware libraries, protocols, host/server interfaces, API behavior, runtime dependencies, and implementation requirements. Do not invent APIs or library behavior.',
      }),
    ]);

    project.state.current.parts = parts
      .filter((p) => p.current?.data)
      .map((p) => ({ id: p.id, name: p.name, domain: p.domain, data: p.current.data }));
    project.state.researchLog.push(...[...hardware, ...coding].filter((r) => r.ok).map((r) => ({
      part: r.part.name,
      worker: r.part.evidence?.at(-1)?.by || null,
      ts: now(),
    })));
    return { hardware, coding };
  }

  return { run };
}
