import { createAgent } from '../services/agent.js';
import { createAgentOrchestrator } from '../services/agentOrchestrator.js';
import { createAutonomousAgent } from '../services/autonomousAgent.js';
import { createFastBuildAgent } from '../services/fastBuildAgent.js';

export function createProjectController({ cfg, registry, jev, store, indexer }) {
  // Legacy remains available for recovery/human checkpoints. Normal initial
  // builds use the fast evidence-first path: one planning call, concurrent
  // research only where exact facts are needed, then reconciliation/simulation.
  const legacy = createAgent({ cfg, registry, jev, store, indexer });
  const autonomous = createAutonomousAgent({ cfg, registry, store, indexer, fallbackAgent: legacy });
  const fast = createFastBuildAgent({ cfg, registry, store, indexer });
  const orchestrator = createAgentOrchestrator({ agent: autonomous, registry, store, cfg });

  return {
    start: ({ goal, constraints, prefer, emit }) => fast.runProject(goal, constraints || {}, { emit, prefer }),
    message: ({ projectId, text, prefer, emit }) =>
      orchestrator.message({ projectId, text, prefer, emit }),
    resume: ({ projectId, emit }) => legacy.resumeProject(projectId, { emit }),
    human: ({ projectId, partId, decision, text, emit }) =>
      legacy.respondHuman(projectId, { partId, decision, text }, { emit }),
  };
}
