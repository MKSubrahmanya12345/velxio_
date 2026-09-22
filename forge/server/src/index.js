// Forge — server entry. Express app + provider wiring + optional static
// serving of the built client (production mode: `client/dist`).
//
// Providers are resolved lazily. The server boots even when nothing is
// configured yet — that is the state a fresh install is in, and the Providers
// page is how credentials get added. An unconfigured provider reports the exact
// reason on the first call instead of a silent mock; /api/health says what is
// actually configured.

import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from './config.js';
import { createStore } from './store.js';
import { createJevProvider } from './providers/jev.js';
import { createPlanner } from './providers/planner.js';
import { createReasoner } from './memory/reasoner.js';
import { createProviderRegistry } from './providers/registry.js';
import { createRouter } from './routes.js';
import { createCreativeRouter } from './creative/routes.js';

const cfg = loadConfig();
const store = await createStore(cfg);
const registry = await createProviderRegistry(cfg);
const counters = { jevCalls: 0, escalations: 0 };

// JEV stays a live-only provider. Without credentials the factory throws; keep
// that exact message for the first call so the UI can show why a turn failed.
let jev;
try {
  jev = createJevProvider(cfg);
} catch (error) {
  jev = () => { throw error; };
  console.warn(`[forge] JEV unavailable at boot: ${error.message}`);
}

const deps = {
  cfg,
  store,
  registry,
  jev,
  planner: createPlanner(cfg, { registry }),
  // Per-request provider overrides (`provider` in the chat body). They choose
  // where the failover loop starts; the rest of the keys stay as fallbacks.
  reasonerFor: provider => createReasoner(cfg, { registry, prefer: provider }),
  plannerFor: provider => createPlanner(cfg, { registry, prefer: provider }),
  counters,
};

const app = express();
app.use(cors(cfg.corsOrigin ? { origin: cfg.corsOrigin } : {}));
app.use(express.json({ limit: '1mb' }));
app.use(createRouter(deps));
app.use(createCreativeRouter(deps));

// Serve the built client when present (same-origin deployment).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, '../../client/dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get(/^(?!\/api\/).*/, (req, res) => res.sendFile(path.join(distDir, 'index.html')));
}

app.use((err, req, res, next) => {
  console.error('[forge] error:', err.message);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: err.message, ...(err.attempts ? { attempts: err.attempts, rounds: err.rounds, maxRounds: err.maxRounds } : {}) });
});

app.listen(cfg.port, '0.0.0.0', () => {
  const keys = registry.entries();
  const active = registry.get(registry.activeId);
  console.log(`Velxio Forge server → http://localhost:${cfg.port}`);
  console.log(`  JEV:     ${cfg.jev.provider || 'unconfigured (set TYPESAFE_API_KEY)'}${cfg.jev.provider ? ` (${cfg.jev.model} @ ${cfg.jev.baseUrl})` : ''}`);
  console.log(`  PROVIDERS: ${keys.length} key${keys.length === 1 ? '' : 's'} registered · active: ${active ? `${active.provider}${active.note ? ` “${active.note}”` : ''}` : 'none'}`);
  console.log(`  FAILOVER: ${registry.failover.enabled ? `on — loops every provider/key, max ${registry.failover.maxRounds} rounds` : 'off — selected key only'}`);
  console.log(`  STORE:   ${cfg.db.kind}${cfg.db.kind === 'mongo' ? ' (mongodb)' : ` (${cfg.db.dataFile})`}`);
  console.log(`  KEYS:    ${registry.file}`);
});
