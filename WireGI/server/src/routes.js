import { Router } from 'express';
import { createProjectRouter } from './routes/projectRoutes.js';
import { createResearchRouter } from './routes/researchRoutes.js';
import { createDecisionRouter } from './routes/decisionRoutes.js';
import { createDebugRouter } from './routes/debugRoutes.js';
// Reuse Forge's provider management backend (reads the same registry we build
// from WireGI's own .env — see config.js / env.js).
import { createProviderRouter } from '../../../forge/server/src/providerRoutes.js';
import { createVerifyRouter } from './verifyRoutes.js';

export function createRouter(deps) {
  const r = Router();
  if (deps.registry) r.use(createProviderRouter(deps));
  r.use('/api/projects', createProjectRouter(deps));
  r.use('/api/research', createResearchRouter(deps));
  r.use('/api/decisions', createDecisionRouter(deps));
  r.use('/api/debug', createDebugRouter(deps));
  r.use('/api/verify/:id', createVerifyRouter(deps));

  // Compact summary the UI header + Debug tab read on load.
  r.get('/api/health', (req, res) => {
    const candidates = typeof deps.registry?.candidates === 'function' ? deps.registry.candidates() : [];
    // Credentials sidelined by a permanent failure (401/403/404). Surfaced so a
    // dead key is visible instead of merely felt as a slower run: with one key
    // left, every "light tier" part silently falls back to the slow provider.
    const rejected = deps.registry?.permanentRejections;
    const sidelined =
      rejected instanceof Map
        ? [...rejected.entries()].map(([id, v]) => ({
            id,
            status: v?.status ?? null,
            message: String(v?.message || '').slice(0, 200),
            at: v?.at,
          }))
        : [];
    res.json({
      ok: true,
      service: 'wiregi-server',
      version: deps.cfg?.version,
      ports: { server: deps.cfg?.port, client: deps.cfg?.clientPort },
      jev: deps.jev?.available ? 'typesafe' : 'llm-fallback',
      providers: candidates.length,
      sidelined,
      activeProvider: candidates[0] ? `${candidates[0].provider}/${candidates[0].model}` : null,
      webSearch: deps.cfg?.webSearch?.engine || null,
      env: {
        files: deps.cfg?.env?.files || [],
        inheritForge: deps.cfg?.env?.inheritForge,
        llmConfigured: Boolean(deps.cfg?.env?.llm?.configured),
        llmKeys: deps.cfg?.env?.llm?.keys || [],
      },
      debug: deps.cfg?.debug || {},
      time: new Date().toISOString(),
    });
  });

  return r;
}
