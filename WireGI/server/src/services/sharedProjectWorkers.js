import { newId } from '../models/project.js';

function now() { return new Date().toISOString(); }

/**
 * Shared-state worker coordinator.
 * Workers never own a project; they contribute patches to one shared project.
 * Independent workers may run concurrently. Integration happens once after both
 * workers settle, so hardware and software decisions remain visible to each other.
 */
export function createSharedProjectWorkers({ store, emit }) {
  const save = async (project) => {
    project.updatedAt = now();
    await store.save(project);
  };

  const patch = async (project, worker, changes) => {
    project.state.workers ||= {};
    project.state.workers[worker] = {
      ...(project.state.workers[worker] || {}),
      ...changes,
      updatedAt: now(),
    };
    await save(project);
    emit?.({ type: 'worker', worker, ...changes, ts: now() });
  };

  async function run({ project, hardware, coding, integrate }) {
    project.state.workers ||= {};
    const runId = newId('workers');
    project.state.workersRunId = runId;

    emit?.({ type: 'workers', stage: 'start', runId, message: 'Hardware and coding workers started.', ts: now() });

    const [hardwareResult, codingResult] = await Promise.allSettled([
      (async () => {
        await patch(project, 'hardware', { status: 'working', runId, message: 'Designing hardware and wiring.' });
        const result = await hardware({ project, runId, shared: project.state });
        await patch(project, 'hardware', { status: 'complete', result });
        return result;
      })(),
      (async () => {
        await patch(project, 'coding', { status: 'working', runId, message: 'Building firmware/software.' });
        const result = await coding({ project, runId, shared: project.state });
        await patch(project, 'coding', { status: 'complete', result });
        return result;
      })(),
    ]);

    project.state.workers.hardware = {
      ...project.state.workers.hardware,
      settled: hardwareResult.status,
      error: hardwareResult.status === 'rejected' ? String(hardwareResult.reason?.message || hardwareResult.reason) : null,
    };
    project.state.workers.coding = {
      ...project.state.workers.coding,
      settled: codingResult.status,
      error: codingResult.status === 'rejected' ? String(codingResult.reason?.message || codingResult.reason) : null,
    };
    await save(project);

    emit?.({ type: 'workers', stage: 'integrate', runId, message: 'Workers finished; integrating shared state.', ts: now() });
    const integrated = await integrate({
      project,
      runId,
      shared: project.state,
      hardware: hardwareResult.status === 'fulfilled' ? hardwareResult.value : null,
      coding: codingResult.status === 'fulfilled' ? codingResult.value : null,
    });

    project.state.workers.integration = { status: 'complete', runId, result: integrated, updatedAt: now() };
    await save(project);
    emit?.({ type: 'workers', stage: 'complete', runId, message: 'Shared project integrated.', result: integrated, ts: now() });
    return { runId, hardware: hardwareResult, coding: codingResult, integrated };
  }

  return { run };
}
