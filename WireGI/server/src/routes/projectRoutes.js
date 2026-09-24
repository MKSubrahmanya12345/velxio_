import { Router } from 'express';
import { createProjectController } from '../controllers/projectController.js';
import { describeError, errorSummary, levelFor } from '../services/debug.js';

export function createProjectRouter(deps) {
  const ctrl = createProjectController(deps);
  const r = Router();

  // Stream ndjson progress events if the client asks for it; else return JSON.
  //
  // The stream contract (the UI depends on it):
  //   { seq, ts, t, runId, level, type, stage, message, …payload }
  //   · `message` is always a non-empty string
  //   · provider attempt failures are type 'provider' (never 'error')
  //   · a terminal failure is a single { type:'error', fatal:true, error:{…} }
  //     carrying name + message + where + stack, followed by the stream ending
  //   · `: hb` comment lines keep proxies from killing a long silence
  const stream = (res, req, status, work) => {
    const streamed = (req.get('accept') || '').includes('application/x-ndjson');
    let heartbeat = null;
    if (streamed) {
      res.status(status).set({
        'Content-Type': 'application/x-ndjson',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders();
      heartbeat = setInterval(() => {
        if (!res.destroyed) res.write(': hb\n');
      }, 15000);
    }
    const write = (p) => {
      if (!res.destroyed) res.write(JSON.stringify(p) + '\n');
    };
    const emit = (p) => {
      if (streamed) write(p);
    };
    const stop = () => {
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
    };

    return Promise.resolve(work(emit))
      .then((result) => {
        stop();
        if (streamed) {
          write({ type: 'result', result });
          res.end();
        } else {
          res.status(status).json(result);
        }
      })
      .catch((err) => {
        stop();
        // Any thrown value (including a bare string) becomes a full record —
        // an error event with no message is a bug we refuse to ship again.
        const described = describeError(err);
        if (streamed) {
          write({
            type: 'error',
            stage: 'run',
            where: described.where || 'request',
            fatal: true,
            error: described,
            message: errorSummary(err),
            level: levelFor({ type: 'error' }),
            ts: new Date().toISOString(),
          });
          res.end();
        } else {
          const e = Object.assign(err instanceof Error ? err : new Error(described.message), {
            status: err?.status || 500,
          });
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
      const list = await deps.store.list();
      // The list view only needs the headline — not every event of every run.
      // needsYou = parts the human still has to sign off (same filter the
      // desktop chat uses), so the mobile chat app can badge conversations
      // without downloading every project.
      res.json(
        list.map((p) => {
          const parts = p.state?.parts || [];
          const chat = p.state?.chat || [];
          const last = chat[chat.length - 1] || null;
          const needsYou = parts.filter(
            (x) =>
              !x.verified &&
              x.status !== 'failed' &&
              x.current?.data &&
              (x.humanCheckpoint || p.status === 'awaiting_human'),
          ).length;
          const preview = (content) =>
            String(content || '')
              .replace(/[#*`>_-]/g, '')
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 90);
          return {
            id: p.id,
            goal: p.goal,
            status: p.status,
            profileLabel: p.profileLabel,
            createdAt: p.createdAt,
            updatedAt: p.updatedAt,
            parts: parts.length,
            failed: parts.filter((x) => x.status === 'failed').length,
            runs: (p.state?.runs || []).length,
            errors: (p.state?.errors || []).length,
            needsYou,
            lastMessagePreview: last ? (last.role === 'user' ? `You: ${preview(last.content)}` : preview(last.content)) : '',
            lastMessageRole: last ? last.role : null,
            lastMessageAt: last?.ts || null,
          };
        }),
      );
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

  // Everything the Debug tab needs about one project, in a single call.
  r.get('/:id/debug', async (req, res, next) => {
    try {
      const p = await deps.store.get(req.params.id);
      if (!p) return res.status(404).json({ error: 'not found' });
      const limit = Math.max(10, Number(req.query.limit) || 500);
      res.json({
        projectId: p.id,
        status: p.status,
        runs: p.state.runs || [],
        errors: p.state.errors || [],
        parts: (p.state.parts || []).map((x) => ({
          id: x.id,
          name: x.name,
          status: x.status,
          tier: x.tier,
          attempts: x.attempts,
          startedAt: x.startedAt,
          finishedAt: x.finishedAt,
          meta: x.meta,
          error: x.error,
          errorDetail: x.errorDetail,
        })),
        runLog: (p.state.runLog || []).slice(-limit),
        env: deps.cfg?.env || null,
        debug: deps.cfg?.debug || {},
        time: new Date().toISOString(),
      });
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

  // Gap B: resume a stalled/partial run. Idempotent — no-op when nothing is left.
  r.post('/:id/resume', (req, res, next) => {
    return stream(res, req, 200, (emit) => ctrl.resume({ projectId: req.params.id, emit })).catch(next);
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

  // The human checkpoint (chat-driven, no LLM in the loop):
  //   POST /api/projects/:id/human { partId?, decision, text }
  //   decision: approve | provide | rerun | reject
  // Returns the same ndjson trace as the other run endpoints, additionally
  // emitting `{type:'human', stage, partId, part}` events.
  r.post('/:id/human', (req, res, next) => {
    const decision = String(req.body?.decision || 'provide').toLowerCase();
    const allowed = ['approve', 'provide', 'rerun', 'reject'];
    if (!allowed.includes(decision)) {
      return res.status(400).json({ error: `decision must be one of ${allowed.join(' | ')}` });
    }
    return stream(res, req, 200, (emit) =>
      ctrl.human({
        projectId: req.params.id,
        partId: req.body?.partId ? String(req.body.partId) : null,
        decision,
        text: String(req.body?.text || ''),
        emit,
      }),
    ).catch(next);
  });

  return r;
}
