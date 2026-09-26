import { createAgent } from '../services/agent.js';
import { createAgentOrchestrator } from '../services/agentOrchestrator.js';

export function createProjectController({ cfg, registry, jev, store, indexer }) {
  const agent = createAgent({ cfg, registry, jev, store, indexer });
  const orchestrator = createAgentOrchestrator({ agent, registry, store });
  return {
    start: ({ goal, constraints, prefer, emit }) => agent.runProject(goal, constraints || {}, { emit, prefer }),
    // Route follow-up prompts before mutating the current project.
    // Similar hardware requests become a new IDEA; explicit changes stay on the current IDEA.
    message: ({ projectId, text, prefer, emit }) =>
      orchestrator.message({ projectId, text, prefer, emit }),
    // Gap B: resume a stalled/partial run (pending, stale researching, failed).
    resume: ({ projectId, emit }) => agent.resumeProject(projectId, { emit }),
    // The human checkpoint: approve / provide an answer / send a part back for
    // re-research. Deterministic — works with no provider configured at all.
    human: ({ projectId, partId, decision, text, emit }) =>
      agent.respondHuman(projectId, { partId, decision, text }, { emit }),
  };
}
