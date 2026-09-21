// Forge — server entry. Express app + provider wiring + optional static
// serving of the built client (production mode: `client/dist`).

import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from './config.js';
import { createStore } from './store.js';
import { createJevProvider } from './providers/jev.js';
import { listProviders, reasonerFor as buildReasoner, plannerFor as buildPlanner } from './providers/registry.js';
import { createRouter } from './routes.js';

const cfg = loadConfig();
const store = await createStore(cfg);
const counters = { jevCalls: 0, escalations: 0 };
// Per-provider resolution is lazy; boot never throws for a missing provider,
// and a turn asking for one is rejected with a clear 400 (no mock fallback).
const providerCache = new Map();
const madeBy = (kind) => (provider) => {
  if (!provider) return null;
  const key = `${kind}:${provider}`;
  if (!providerCache.has(key)) {
    const fn = kind === 'reasoner' ? buildReasoner(cfg, provider) : buildPlanner(cfg, provider);
    if (fn) providerCache.set(key, fn);
  }
  return providerCache.get(key) || null;
};
const deps = {
  cfg,
  store,
  jev: createJevProvider(cfg),
  reasonerFor: madeBy('reasoner'),
  plannerFor: madeBy('planner'),
  counters,
};

const app = express();
app.use(cors(cfg.corsOrigin ? { origin: cfg.corsOrigin } : {}));
app.use(express.json({ limit: '1mb' }));
app.use(createRouter(deps));

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
  res.status(err.status || 500).json({ error: err.message });
});

app.listen(cfg.port, () => {
  const ready = listProviders(cfg);
  console.log(`Velxio Forge server → http://localhost:${cfg.port}`);
  console.log(`  JEV:        ${cfg.jev.provider} (${cfg.jev.model} @ ${cfg.jev.baseUrl})`);
  const providers = ready.length ? ready.map((p) => `${p.id} (${p.model})`).join(' · ') : 'none configured';
  console.log(`  GENERATORS: ${providers}`);
  console.log(`  DEFAULT:    ${cfg.planner.provider || 'none — pick one in the UI or set a provider key in forge/server/.env'}`);
  console.log(`  STORE:      ${cfg.db.kind}${cfg.db.kind === 'mongo' ? ' (mongodb)' : ` (${cfg.db.dataFile})`}`);
});
