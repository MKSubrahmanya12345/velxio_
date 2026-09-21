// Forge — REST API. Thin wrappers over the pipeline; all logic lives in
// pipeline.js so it is testable without a server (see scripts/smoke.mjs).

import { Router } from 'express';
import { synthesizeProject, handleMessage } from './pipeline.js';
import { makeProject, nowIso, log } from './schema.js';

export function createRouter(deps) {
  const r = Router();

  r.get('/api/health', (req, res) => {
    res.json({
      ok: true,
      service: 'forge-server',
      time: new Date().toISOString(),
      providers: {
        jev: deps.cfg.jev.provider,
        planner: deps.cfg.planner.provider,
        store: deps.cfg.db.kind,
      },
    });
  });

  r.get('/api/projects', async (req, res, next) => {
    try {
      res.json(await deps.store.list());
    } catch (e) { next(e); }
  });

  r.post('/api/projects', async (req, res, next) => {
    try {
      const goal = String(req.body?.goal || '').trim();
      if (!goal) return res.status(400).json({ error: 'goal is required' });
      const { state, decisions, response } = await synthesizeProject(deps, {
        goal,
        constraints: req.body?.constraints || {},
      });
      const project = await deps.store.create(makeProject(state));
      res.status(201).json({ project, response, decisions });
    } catch (e) { next(e); }
  });

  r.get('/api/projects/:id', async (req, res, next) => {
    try {
      const project = await deps.store.get(req.params.id);
      if (!project) return res.status(404).json({ error: 'project not found' });
      res.json(project);
    } catch (e) { next(e); }
  });

  r.delete('/api/projects/:id', async (req, res, next) => {
    try {
      await deps.store.remove(req.params.id);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // The hot path: one human message (text and/or chip) → Jev decisions →
  // state transition. Everything the UI needs is in the response.
  r.post('/api/projects/:id/messages', async (req, res, next) => {
    try {
      const project = await deps.store.get(req.params.id);
      if (!project) return res.status(404).json({ error: 'project not found' });
      const { project: updated, response, decisions } = await handleMessage(deps, project, req.body || {});
      await deps.store.save(updated);
      res.json({ project: updated, response, decisions });
    } catch (e) { next(e); }
  });

  r.post('/api/projects/:id/inventory', async (req, res, next) => {
    try {
      const project = await deps.store.get(req.params.id);
      if (!project) return res.status(404).json({ error: 'project not found' });
      const items = Array.isArray(req.body?.items) ? req.body.items : [];
      for (const it of items) {
        const name = String(it?.name || '').trim();
        if (!name) continue;
        project.state.inventory.push({ id: crypto.randomUUID(), name, note: it.note ? String(it.note) : undefined });
      }
      if (items.length) {
        log(project.state, 'system', `Inventory updated: ${items.map((i) => i.name).filter(Boolean).join(', ')}.`);
        project.updatedAt = nowIso();
      }
      await deps.store.save(project);
      res.json(project);
    } catch (e) { next(e); }
  });

  return r;
}
