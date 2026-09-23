import { Router } from 'express';
import { createProjectController } from '../controllers/projectController.js';

export function createProjectRouter(deps) {
  const ctrl = createProjectController(deps);
  const r = Router();

  // Stream ndjson progress events if the client asks for it; else return JSON.
  const stream = (res, req, status, work) => {
    const streamed = (req.get('accept') || '').includes('application/x-ndjson');
    if (streamed) {
      res.status(status).set({
        'Content-Type': 'application/x-ndjson',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders();
    }
    const write = (p) => {
      if (!res.destroyed) res.write(JSON.stringify(p) + '\n');
    };
    const emit = (p) => {
      if (streamed) write(p);
    };
    return Promise.resolve(work(emit))
      .then((result) => {
        if (streamed) {
          write({ type: 'result', result });
          res.end();
        } else {
          res.status(status).json(result);
        }
      })
      .catch((err) => {
        if (streamed) {
          write({ type: 'error', error: err.message || 'failed' });
          res.end();
        } else {
          const e = Object.assign(err, { status: err.status || 500 });
          throw e;
        }
      });
  };

  r.post('/', (req, res, next) => {
    const goal = String(req.body?.goal || '').trim();
    if (!goal) return res.status(400).json({ error: 'goal is required' });
    return stream(
      res,
      req,
      201,
      (emit) => ctrl.start({ goal, constraints: req.body?.constraints || {}, prefer: req.body?.provider, emit }),
    ).catch(next);
  });

  r.get('/', async (req, res, next) => {
    try {
      res.json(await deps.store.list());
    } catch (e) {
      next(e);
    }
  });

  r.get('/:id', async (req, res, next) => {
    try {
      const p = await deps.store.get(req.params.id);
      if (!p) return res.status(404).json({ error: 'not found' });
      res.json(p);
    } catch (e) {
      next(e);
    }
  });

  r.delete('/:id', async (req, res, next) => {
    try {
      await deps.store.remove(req.params.id);
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  r.post('/:id/messages', (req, res, next) => {
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'text is required' });
    return stream(
      res,
      req,
      200,
      (emit) => ctrl.message({ projectId: req.params.id, text, prefer: req.body?.provider, emit }),
    ).catch(next);
  });

  return r;
}
