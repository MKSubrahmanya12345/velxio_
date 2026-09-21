// Forge — named generation-provider registry (live only).
//
// Every provider in cfg.providers is either ready (real credentials/model set)
// or absent from resolution. There is no mock fallback anywhere.

import { createPlanner } from './planner.js';
import { createReasoner } from '../memory/reasoner.js';

export function providerConfig(cfg, provider) {
  const g = (cfg.providers || []).find((p) => p.id === provider);
  if (!g || !g.ready) return null;
  return {
    ...cfg,
    planner:
      g.type === 'bedrock'
        ? { provider: 'bedrock', apiKey: '', model: g.model, apiBase: g.apiBase }
        : { provider: g.id, apiKey: g.apiKey, model: g.model, apiBase: g.apiBase },
    bedrock: cfg.bedrock,
  };
}

export function listProviders(cfg) {
  return (cfg.providers || [])
    .filter((p) => p.ready)
    .map(({ id, name, model, type }) => ({ id, name, model, type }));
}

export function reasonerFor(cfg, provider) {
  const sub = providerConfig(cfg, provider);
  return sub ? createReasoner(sub) : null;
}

export function plannerFor(cfg, provider) {
  const sub = providerConfig(cfg, provider);
  return sub ? createPlanner(sub) : null;
}

export function unresolvedError(provider, cfg) {
  const available = listProviders(cfg);
  const avail = available.length ? available.map((p) => p.id).join(', ') : 'none';
  return (
    `Generation provider '${provider}' is not configured. Configured providers: ${avail}. ` +
    'Add its API key (or OLLAMA_MODEL) in forge/server/.env.'
  );
}