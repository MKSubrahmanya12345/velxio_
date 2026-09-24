import { createAgent } from '../services/agent.js';

export function createProjectController({ cfg, registry, jev, store, indexer }) {
  const agent = createAgent({ cfg, registry, jev, store, indexer });
  return {
    start: ({ goal, constraints, prefer, emit }) => agent.runProject(goal, constraints || {}, { emit, prefer }),
    message: ({ projectId, text, prefer, emit }) =>
      agent.continueProject(projectId, text, { emit, prefer }),
    // Gap B: resume a stalled/partial run (pending, stale researching, failed).
    resume: ({ projectId, emit }) => agent.resumeProject(projectId, { emit }),
    // The human checkpoint: approve / provide an answer / send a part back for
    // re-research. Deterministic — works with no provider configured at all.
    human: ({ projectId, partId, decision, text, emit }) =>
      agent.respondHuman(projectId, { partId, decision, text }, { emit }),
  };
}
