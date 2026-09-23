// WireGI server entry. Express app + Forge provider/Jev wiring + optional static
// serving of the built client (production mode: client/dist).
import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from './config.js';
import { createStore } from './store.js';
import { createProviderRegistry } from '../../../forge/server/src/providers/registry.js';
import { createJev } from './services/jevClient.js';
import { createIndexer } from './services/indexer.js';
import { createRouter } from './routes.js';

const cfg = loadConfig();
const store = await createStore(cfg);
await store.init();
const registry = await createProviderRegistry(cfg);
const indexer = createIndexer();
const jev = createJev(cfg);

const deps = { cfg, store, registry, jev, indexer };
const app = express();
app.use(cfg.corsOrigin ? cors({ origin: cfg.corsOrigin }) : cors());
app.use(express.json({ limit: '2mb' }));
app.use(createRouter(deps));

// Serve the built client when present (same-origin deployment).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, '../../client/dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get(/^(?!\/api\/).*/, (req, res) => res.sendFile(path.join(distDir, 'index.html')));
}

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  console.error('[wiregi] error:', err.message);
  res.status(err.status || 500).json({ error: err.message });
});

app.listen(cfg.port, '0.0.0.0', () => {
  const active = registry.get(registry.activeId);
  console.log(`WireGI server → http://localhost:${cfg.port}`);
  console.log(`  JEV:      ${jev.available ? 'typesafe (live)' : 'unconfigured — LLM fallback active'}`);
  console.log(`  PROVIDERS: ${registry.entries().length} key(s); active: ${active ? active.provider : 'none'}`);
  console.log(`  STORE:    ${cfg.db.dataFile}`);
  console.log(`  NOTE:     provider keys reused from forge/server/.env (no new .env created)`);
});
