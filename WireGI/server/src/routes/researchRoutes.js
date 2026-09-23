import { Router } from 'express';
import { createResearchController } from '../controllers/researchController.js';

export function createResearchRouter(deps) {
  const ctrl = createResearchController(deps);
  const r = Router();

  r.post('/', async (req, res, next) => {
    try {
      const q = String(req.body?.query || '').trim();
      if (!q) return res.status(400).json({ error: 'query required' });
      res.json(await ctrl.search({ query: q }));
    } catch (e) {
      next(e);
    }
  });

  r.get('/index', (req, res) => res.json(deps.indexer?.all() || {}));

  return r;
}
