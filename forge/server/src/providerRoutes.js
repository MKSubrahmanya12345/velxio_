// Forge — provider management API (the Providers page).
//
// Keys are stored exactly as entered and returned exactly as stored: the UI
// shows full plain-text credentials with their notes, never dots. This server
// has no authentication, so anyone who can reach it can read these keys — keep
// it on localhost or a trusted network (see README "Providers and keys").

import { Router } from 'express';

import { PROVIDER_IDS } from './providers/catalog.js';
import { testProviderEntry } from './providers/failover.js';

const bad = (message, status = 400) => Object.assign(new Error(message), { status });

export function createProviderRouter(deps) {
  const r = Router();
  const registry = deps.registry;
  if (!registry) throw new Error('createProviderRouter needs deps.registry');

  const wrap = fn => async (req, res, next) => {
    try { res.json(await fn(req, res)); } catch (e) { next(e); }
  };

  // Full state: catalog metadata for the form, every key (plain text), the
  // selected one, failover settings, loop order, and the recent attempt log.
  r.get('/api/providers', wrap(async () => registry.state()));

  r.post('/api/providers/keys', wrap(async req => {
    const body = req.body || {};
    const provider = String(body.provider || '').trim();
    if (!PROVIDER_IDS.includes(provider)) throw bad(`Choose a provider: ${PROVIDER_IDS.join(', ')}.`);
    const note = String(body.note ?? '').trim();
    if (note.length > 240) throw bad('Note must be 240 characters or fewer.');
    const entry = await registry.add({
      provider,
      note,
      apiKey: body.apiKey,
      secret: body.secret,
      sessionToken: body.sessionToken,
      region: body.region,
      baseUrl: body.baseUrl,
      model: body.model,
      enabled: body.enabled !== false,
    });
    return { ok: true, key: entry, state: registry.state() };
  }));

  r.patch('/api/providers/keys/:id', wrap(async req => {
    const body = req.body || {};
    const allowed = ['note', 'enabled', 'model', 'baseUrl', 'apiKey', 'secret', 'sessionToken', 'region'];
    const patch = Object.fromEntries(Object.entries(body).filter(([k]) => allowed.includes(k)));
    if (!Object.keys(patch).length) throw bad('Nothing to update.');
    if (patch.note !== undefined && String(patch.note).length > 240) throw bad('Note must be 240 characters or fewer.');
    const key = await registry.update(req.params.id, patch);
    return { ok: true, key, state: registry.state() };
  }));

  r.delete('/api/providers/keys/:id', wrap(async req => {
    const result = await registry.remove(req.params.id);
    return { ...result, state: registry.state() };
  }));

  // Select which key runs first. Failover still covers the others on error.
  r.post('/api/providers/active', wrap(async req => {
    const id = String(req.body?.id || '');
    if (!id) throw bad('id is required.');
    const key = await registry.setActive(id);
    return { ok: true, activeId: registry.activeId, key, state: registry.state() };
  }));

  // Live probe of exactly one credential — no failover, no switching.
  r.post('/api/providers/keys/:id/test', wrap(async req => {
    const entry = registry.get(req.params.id);
    if (!entry) throw bad('No such key.', 404);
    const result = await testProviderEntry(entry, { timeoutMs: Number(req.body?.timeoutMs) || 20000, fetchImpl: deps.fetch });
    if (result.ok) await registry.recordSuccess(entry.id, { latencyMs: result.latencyMs, operation: 'test' });
    else await registry.recordFailure(entry.id, { status: result.status, message: result.error, permanent: [401, 403, 404].includes(result.status), operation: 'test' });
    return { ...result, state: registry.state() };
  }));

  // Failover policy: on/off, round budget (10 by default), and whether keys
  // rejected with 401/403/404 are retried in later rounds.
  r.patch('/api/providers/failover', wrap(async req => {
    const body = req.body || {};
    if (body.maxRounds !== undefined) {
      const rounds = Number(body.maxRounds);
      if (!Number.isFinite(rounds) || rounds < 1 || rounds > 25) throw bad('maxRounds must be a number between 1 and 25.');
    }
    const failover = await registry.setFailover({
      enabled: body.enabled,
      maxRounds: body.maxRounds,
      retryRejected: body.retryRejected,
    });
    return { ok: true, failover, state: registry.state() };
  }));

  // Bring back .env-derived entries the user removed from the list.
  r.post('/api/providers/restore-env', wrap(async () => {
    await registry.restoreEnv();
    return { ok: true, state: registry.state() };
  }));

  r.get('/api/providers/log', wrap(async () => ({ log: registry.log, failover: registry.failover, order: registry.candidates().map(k => k.id) })));

  return r;
}
