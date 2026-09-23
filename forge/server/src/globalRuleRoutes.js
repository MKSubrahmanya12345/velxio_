// Forge — global rules API.
//
// The user-authored, cross-project rule set behind the JEV pre-turn gate.
// Hand-managed: no LLM participates in these endpoints. Mounted only when a
// store exists, so hand-built dependency sets (tests, scripts) keep working.

import { Router } from 'express';

export function createGlobalRuleRouter(deps) {
  const r = Router();
  const store = () => {
    if (!deps.globalRules) {
      throw Object.assign(new Error('Global rules are not available in this deployment.'), { status: 503 });
    }
    return deps.globalRules;
  };
  const state = () => ({ rules: store().list(), file: store().file });

  r.get('/api/rules/global', (req, res) => {
    res.json(state());
  });

  r.post('/api/rules/global', async (req, res) => {
    const rule = await store().add(req.body || {});
    res.status(201).json({ ok: true, rule, ...state() });
  });

  r.patch('/api/rules/global/:id', async (req, res) => {
    const rule = await store().update(req.params.id, req.body || {});
    res.json({ ok: true, rule, ...state() });
  });

  r.delete('/api/rules/global/:id', async (req, res) => {
    await store().remove(req.params.id);
    res.json({ ok: true, ...state() });
  });

  return r;
}
