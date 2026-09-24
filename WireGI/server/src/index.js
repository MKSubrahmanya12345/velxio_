// WireGI server entry. Express app + Forge provider/Jev wiring + optional static
// serving of the built client (production mode: client/dist).
//
// Import order matters: ./env.js must be evaluated before anything that reaches
// into ../forge, because Forge's config module loads forge/server/.env on
// import and keeps whatever is already in process.env. WireGI's own .env is
// applied first, so WireGI always wins — and the boot log says where each key
// came from.
import './env.js'; // ← first, deliberately
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
import { describeError, errorSummary } from './services/debug.js';

// Crash visibility: these two handlers turn a silent death into a logged,
// explainable one. They never swallow the error.
process.on('unhandledRejection', (reason) => {
  console.error('[wiregi] UNHANDLED REJECTION:', errorSummary(reason));
  console.error(describeError(reason).stack || '');
});
process.on('uncaughtException', (err) => {
  console.error('[wiregi] UNCAUGHT EXCEPTION:', errorSummary(err));
  console.error(err?.stack || '');
});

const cfg = loadConfig();
const store = await createStore(cfg);
await store.init();
const registry = await createProviderRegistry(cfg);
const indexer = createIndexer(cfg);
const jev = createJev(cfg);

const deps = { cfg, store, registry, jev, indexer };
const app = express();
app.disable('x-powered-by');
// Same-origin by default; CORS_ORIGIN in WireGI/server/.env can allow the Vite
// dev server (default http://localhost:5175) — and the preview proxy host that
// serves this app also works same-origin through the Vite proxy.
app.use(
  cors({
    // corsOrigins is an array (Velxio frontend + mobile + env extras). The
    // Vite dev proxy makes proxied calls same-origin, so this list only
    // matters for direct browser connections.
    origin: cfg.corsOrigins?.length ? cfg.corsOrigins : true,
    credentials: false,
  }),
);
app.use(express.json({ limit: '2mb' }));
app.use(createRouter(deps));

// Serve the built client when present (same-origin deployment).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, '../../client/dist');
const mobileDir = path.resolve(__dirname, '../../mobile/dist');

if (fs.existsSync(mobileDir)) {
  // WhatsApp-style mobile chat app for the "needs your eyes" checkpoint.
  // Served at /m so a phone can open http://<host>:4322/m/ without another server.
  app.use('/m', express.static(mobileDir));
  app.get(/^\/m(?:\/.*)?$/, (req, res) => res.sendFile(path.join(mobileDir, 'index.html')));
}

if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get(/^(?!\/api\/).*/, (req, res) => res.sendFile(path.join(distDir, 'index.html')));
}

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const described = describeError(err);
  console.error('[wiregi] request error:', errorSummary(err));
  res.status(err.status || 500).json({
    error: described.message,
    name: described.name,
    where: described.where,
    detail: cfg.debug?.enabled ? described : undefined,
  });
});

app.listen(cfg.port, '0.0.0.0', () => {
  const active = registry.get(registry.activeId);
  const candidates = registry.candidates();
  console.log('');
  console.log('  WireGI ─ agentic build assistant');
  console.log(`  ────────────────────────────────────────────────────────────`);
  console.log(`  SERVER    http://localhost:${cfg.port}  (bind 0.0.0.0)`);
  console.log(`  CLIENT    http://localhost:${cfg.clientPort}  (vite dev, proxies /api)`);
  if (fs.existsSync(mobileDir)) console.log(`  MOBILE    http://localhost:${cfg.port}/m/  (checkpoint chat)`);
  console.log(`  JEV       ${jev.available ? 'typesafe (live)' : 'unconfigured — LLM answers the typed questions'}`);
  console.log(
    `  PROVIDERS ${candidates.length} key(s)${active ? ` · active: ${active.provider}/${active.model}` : ' · NONE configured'}`,
  );
  console.log(`  STORE     ${cfg.db.dataFile}`);
  for (const line of cfg.boot()) console.log(line);
  console.log(`  DEBUG     flow log: ${cfg.debug?.enabled ? 'stdout + UI' : 'UI only'} · level ${cfg.debug?.level}`);
  console.log(`            /api/health · /api/debug/env · /api/debug/llm-test`);
  if (!candidates.length) {
    console.log('');
    console.log('  ⚠ No LLM provider key found. WireGI still runs and streams everything,');
    console.log('    but the first LLM call will fail — with a precise error in the');
    console.log('    Flow panel. Fix: add a key to WireGI/server/.env (see .env.example)');
    console.log('    or set WIREGI_INHERIT_FORGE_ENV=true to fall back to forge/server/.env.');
  }
  console.log('');
});
