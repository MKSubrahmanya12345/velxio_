import { Router } from 'express';
import { createProjectRouter } from './projectRoutes.js';
import { createResearchRouter } from './researchRoutes.js';
import { createDecisionRouter } from './decisionRoutes.js';
// Reuse Forge's provider management backend (reads the same .env keys).
import { createProviderRouter } from '../../../forge/server/src/providerRoutes.js';

export function createRouter(deps) {
  const r = Router();
  if (deps.registry) r.use(createProviderRouter(deps));
  r.use('/api/projects', createProjectRouter(deps));
  r.use('/api/research', createResearchRouter(deps));
  r.use('/api/decisions', createDecisionRouter(deps));
  r.get('/api/health', (req, res) =>
    res.json({
      ok: true,
      service: 'wiregi-server',
      jev: deps.jev?.available ? 'typesafe' : 'unconfigured (llm fallback)',
      providers: deps.registry?.candidates().length || 0,
      time: new Date().toISOString(),
    }),
  );
  return r;
}
