import { createAgent } from '../services/agent.js';
import { createAgentOrchestrator } from '../services/agentOrchestrator.js';
import { createAutonomousAgent } from '../services/autonomousAgent.js';

export function createProjectController({ cfg, registry, jev, store, indexer }) {
  // Keep the mature deterministic recovery/human paths, but make the normal
  // build path the autonomous controller.
  const legacy = createAgent({ cfg, registry, jev, store, indexer });
  const autonomous = createAutonomousAgent({ cfg, registry, store, indexer, fallbackAgent: legacy });
  const orchestrator = createAgentOrchestrator({ agent: autonomous, registry, store, cfg });

  return {
    start: ({ goal, constraints, prefer, emit }) => autonomous.runProject(goal, constraints || {}, { emit, prefer }),
    message: ({ projectId, text, prefer, emit }) =>
      orchestrator.message({ projectId, text, prefer, emit }),
    resume: ({ projectId, emit }) => legacy.resumeProject(projectId, { emit }),
    human: ({ projectId, partId, decision, text, emit }) =>
      legacy.respondHuman(projectId, { partId, decision, text }, { emit }),
  };
}
