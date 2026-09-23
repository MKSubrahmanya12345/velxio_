// WireGI server config.
//
// Deliberately does NOT create a new .env. Provider keys (LLM_API_KEY,
// TYPESAFE_API_KEY, TAVILY_API_KEY, etc.) are loaded from Forge's own
// forge/server/.env by Forge's config loader (which we import below). WireGI
// only overrides its own runtime paths/ports so it never clobbers Forge data.

import { loadConfig as forgeLoadConfig } from '../../../forge/server/src/config.js';

export function loadConfig(env = process.env) {
  const cfg = forgeLoadConfig(env);

  // WireGI-specific runtime paths (separate from Forge's so we never overwrite).
  // Hard-pinned: the shared forge .env sets PORT=4321 (Forge's port), so we must
  // not inherit it — WireGI always listens on 4322 alongside Forge.
  cfg.port = Number(4322);
  cfg.corsOrigin = env.CORS_ORIGIN || 'http://localhost:5173';
  cfg.db.dataFile = env.DATA_FILE || './data/wiregi-projects.json';
  cfg.providers.dataFile = env.PROVIDERS_FILE || './data/wiregi-providers.json';
  cfg.globalRules.dataFile = env.GLOBAL_RULES_FILE || './data/wiregi-rules.json';
  cfg.label = 'wiregi-server';
  return cfg;
}
