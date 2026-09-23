import { Router } from 'express';
import { createDecisionController } from '../controllers/decisionController.js';

export function createDecisionRouter(deps) {
  const ctrl = createDecisionController(deps);
  const r = Router();

  // Run a Jev (or fallback) decision directly — used by the UI's decision panel.
  r.post('/', async (req, res, next) => {
    try {
      const { state, questions } = req.body || {};
      if (!questions || typeof questions !== 'object') return res.status(400).json({ error: 'questions required' });
      res.json(await ctrl.decide({ state, questions }));
    } catch (e) {
      next(e);
    }
  });

  return r;
}
