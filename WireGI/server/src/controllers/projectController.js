import { createAgent } from '../services/agent.js';

export function createProjectController({ cfg, registry, jev, store, indexer }) {
  const agent = createAgent({ cfg, registry, jev, store, indexer });
  return {
    start: ({ goal, constraints, prefer, emit }) => agent.runProject(goal, constraints || {}, { emit, prefer }),
    message: ({ projectId, text, prefer, emit }) =>
      agent.continueProject(projectId, text, { emit, prefer }),
  };
}
