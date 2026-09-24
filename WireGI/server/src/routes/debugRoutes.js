// Debug routes — the server side of the debugger.
//
// Everything here exists to answer "why is it doing that?" without reading
// code or restarting with a print statement:
//   GET  /api/debug/env      which .env files are in play, which keys are set,
//                            where each key came from (never the secret itself)
//   GET  /api/debug/health   the same picture the UI header shows + uptime
//   POST /api/debug/llm-test one real generation through the failover loop, and
//                            a per-attempt report (key, provider, model,
//                            status, latency, error) — or a success record
//   POST /api/debug/web-test one real web search, reporting engine + items
//   GET  /api/debug/index    what the research index has learned so far
import { Router } from 'express';
import { generateWithMeta } from '../services/llm.js';
import { webSearch } from '../services/research.js';
import { describeError, errorSummary } from '../services/debug.js';

export function createDebugRouter(deps) {
  const r = Router();

  r.get('/env', (req, res) => {
    res.json({
      env: deps.cfg?.env || null,
      ports: { server: deps.cfg?.port, client: deps.cfg?.clientPort, cors: deps.cfg?.corsOrigin },
      debug: deps.cfg?.debug || {},
      throughput: deps.cfg?.throughput || {},
      files: {
        data: deps.cfg?.db?.dataFile,
        providers: deps.cfg?.providers?.dataFile,
        globalRules: deps.cfg?.globalRules?.dataFile,
      },
      time: new Date().toISOString(),
    });
  });

  r.get('/health', (req, res) => {
    const registry = deps.registry;
    const candidates = typeof registry?.candidates === 'function' ? registry.candidates() : [];
    res.json({
      ok: true,
      service: 'wiregi-server',
      version: deps.cfg?.version,
      uptimeSec: Math.round(process.uptime()),
      ports: { server: deps.cfg?.port, client: deps.cfg?.clientPort, cors: deps.cfg?.corsOrigin },
      jev: {
        available: Boolean(deps.jev?.available),
        mode: deps.jev?.available ? 'typesafe (live)' : 'llm-fallback',
      },
      providers: {
        count: candidates.length,
        active: candidates[0] ? `${candidates[0].provider}/${candidates[0].model}` : null,
        keys: candidates.map((c) => ({ provider: c.provider, model: c.model, id: c.id })),
      },
      webSearch: { engine: deps.cfg?.webSearch?.engine || null },
      env: deps.cfg?.env || null,
      process: { node: process.version, pid: process.pid, cwd: process.cwd() },
      time: new Date().toISOString(),
    });
  });

  // One real call, through the same failover loop a run uses. This is the
  // fastest way to tell "no keys" from "bad key" from "model is down".
  r.post('/llm-test', async (req, res) => {
    const started = Date.now();
    try {
      const call = await generateWithMeta({
        registry: deps.registry,
        system: 'You are a connectivity probe. Reply with JSON only: {"ok":true}',
        user: '{"probe":true}',
        maxTokens: 64,
        temperature: 0,
        operation: 'debug:llm-test',
      });
      res.json({
        ok: true,
        ms: Date.now() - started,
        used: call.used,
        attempts: call.attempts,
        reply: call.text.slice(0, 400),
      });
    } catch (err) {
      const described = describeError(err);
      res.status(502).json({
        ok: false,
        ms: Date.now() - started,
        error: described,
        message: errorSummary(err),
        hint: /no generation providers/i.test(described.message)
          ? 'No provider key is configured. Add one to WireGI/server/.env (see .env.example) or turn the Forge fallback on (WIREGI_INHERIT_FORGE_ENV=true).'
          : undefined,
      });
    }
  });

  r.post('/web-test', async (req, res) => {
    const query = String(req.body?.query || 'test').slice(0, 200);
    const out = await webSearch(query, { emit: () => {} });
    res.json({
      ok: Boolean(out),
      engine: out?.engine || null,
      count: out?.items?.length || 0,
      error: out?.error || null,
      items: (out?.items || []).slice(0, 5),
      configured: Boolean(process.env.TAVILY_API_KEY || process.env.BRAVE_API_KEY),
    });
  });

  r.get('/index', (req, res) => {
    const all = deps.indexer?.all?.() || {};
    const entries = Object.values(all);
    res.json({
      entries: entries.length,
      topics: entries.slice(-50).map((e) => ({ topic: e.topic, ts: e.ts, sources: e.sources?.length || 0 })),
    });
  });

  return r;
}
