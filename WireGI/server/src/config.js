// WireGI server config.
//
// WireGI now owns its configuration: `WireGI/server/.env` is loaded first (see
// ./env.js), and forge/server/.env is only an optional fallback. Everything
// Forge-specific that we still reuse (provider registry, Jev client, failover)
// is imported from ../forge/server/src and fed this config object.
//
// Port rule — the three apps in this repo live side by side:
//   Velxio (frontend/) :5173 · Forge (forge/client) :5174 · WireGI :5175
// and WireGI's own API server stays on 4322 (Forge's is 4321). The client port
// is published to the UI so the Debug tab can show the whole map. PORT is
// deliberately NOT inherited from Forge's .env.

import path from 'node:path';
import { reassertEnv, envReport, envBootLines, wiregiValue, SERVER_DIR, WIREGI_ENV_FILE } from './env.js';
// Import order matters: ./env.js above is evaluated before this line, so
// WireGI's values are in process.env before Forge's loader runs (it skips keys
// that already exist). reassertEnv() below covers direct-service imports.
import { loadConfig as forgeLoadConfig } from '../../../forge/server/src/config.js';

const bool = (v, fallback = false) =>
  v === undefined ? fallback : ['1', 'true', 'on', 'yes'].includes(String(v).toLowerCase());

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

// Paths in WireGI's .env are relative to WireGI/server/, not the shell's CWD —
// starting the server from the repo root must not scatter data elsewhere.
const resolveDataPath = (value, fallback) =>
  path.resolve(SERVER_DIR, String(value || fallback).replace(/^\.\//, ''));

export function loadConfig(env = process.env) {
  reassertEnv(); // WireGI's .env wins over anything an import chain applied late

  const cfg = forgeLoadConfig(env);

  const port = num(env.WIREGI_PORT, 4322);
  const clientPort = num(env.WIREGI_CLIENT_PORT, 5175);

  cfg.port = port;
  cfg.clientPort = clientPort;
  cfg.corsOrigin = env.CORS_ORIGIN || `http://localhost:${clientPort}`;
  cfg.label = 'wiregi-server';
  cfg.version = '0.2.0';

  // WireGI's own runtime files, always inside WireGI/server/data/. Only the
  // WireGI .env may point them elsewhere; Forge's DATA_FILE must never leak in
  // (writing into Forge's store would be a very bad day).
  cfg.db.dataFile = resolveDataPath(wiregiValue('DATA_FILE'), './data/wiregi-projects.json');
  cfg.providers.dataFile = resolveDataPath(wiregiValue('PROVIDERS_FILE'), './data/wiregi-providers.json');
  cfg.globalRules.dataFile = resolveDataPath(wiregiValue('GLOBAL_RULES_FILE'), './data/wiregi-rules.json');

  // Debugger knobs — what turns the flow log from "something failed" into
  // "key X got HTTP 429 on attempt 3 after 1.4s, here is the stack".
  cfg.debug = {
    enabled: bool(env.WIREGI_DEBUG, false),
    level: ['debug', 'info', 'warn', 'error'].includes(String(env.WIREGI_LOG_LEVEL))
      ? String(env.WIREGI_LOG_LEVEL)
      : 'debug',
    runLogLimit: Math.max(100, num(env.WIREGI_RUNLOG_LIMIT, 2000)),
    logProviderAttempts: bool(env.WIREGI_LOG_PROVIDER_ATTEMPTS, true),
  };

  cfg.throughput = {
    concurrency: Math.max(1, num(env.WIREGI_CONCURRENCY, 8)),
    rpm: Math.max(0, num(env.WIREGI_RPM, 0)),
    retries: Math.max(0, num(env.WIREGI_RETRIES, 4)),
  };

  cfg.webSearch = {
    engine: env.TAVILY_API_KEY ? 'tavily' : env.BRAVE_API_KEY ? 'brave' : null,
  };

  cfg.env = envReport();
  cfg.envFile = WIREGI_ENV_FILE;
  cfg.serverDir = SERVER_DIR;
  cfg.boot = () => envBootLines();

  return cfg;
}

export { envReport, envBootLines };
