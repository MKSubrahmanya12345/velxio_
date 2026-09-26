import { createAgent } from '../services/agent.js';
import { createAgentOrchestrator } from '../services/agentOrchestrator.js';
import { createAutonomousAgent } from '../services/autonomousAgent.js';
import { createFastBuildAgent } from '../services/fastBuildAgent.js';
import { createMinimalBuildAgent } from '../services/minimalBuildAgent.js';

export function createProjectController({ cfg, registry, jev, store, indexer }) {
  const legacy = createAgent({ cfg, registry, jev, store, indexer });
  const autonomous = createAutonomousAgent({ cfg, registry, store, indexer, fallbackAgent: legacy });
  const fast = createFastBuildAgent({ cfg, registry, store, indexer });
  const minimal = createMinimalBuildAgent({ cfg, registry, store, indexer });
  const orchestrator = createAgentOrchestrator({ agent: autonomous, registry, store, cfg });

  return {
    start: ({ goal, constraints, prefer, emit }) => minimal.runProject(goal, constraints || {}, { emit, prefer }),
    message: ({ projectId, text, prefer, emit }) => orchestrator.message({ projectId, text, prefer, emit }),
    resume: ({ projectId, emit }) => legacy.resumeProject(projectId, { emit }),
    human: ({ projectId, partId, decision, text, emit }) => legacy.respondHuman(projectId, { partId, decision, text }, { emit }),
  };
}
