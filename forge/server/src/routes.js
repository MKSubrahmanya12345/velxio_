import { runMemoryTurn } from './memory/turn.js';
import { listProviders } from './providers/registry.js';
import { resolveProviderId } from './providers/catalog.js';
// Forge — REST API (chat-first + legacy compatibility)

import { Router } from 'express';
import { synthesizeChatProject, handleChatMessage } from './pipeline.js';
import { makeConversation, nowIso, log } from './schema.js';
import { createProviderRouter } from './providerRoutes.js';
import { createGlobalRuleRouter } from './globalRuleRoutes.js';

export function createRouter(deps) {
  const r = Router();
  // Provider/key management for the Providers page (see providerRoutes.js).
  // Mounted only when a registry exists, so hand-built dependency sets
  // (tests, scripts) keep working without one.
  if (deps.registry) r.use(createProviderRouter(deps));
  // Global rules: the cross-project, user-authored rule set behind the JEV
  // pre-turn gate (see memory/preturn.js). Mounted only when a store exists.
  if (deps.globalRules) r.use(createGlobalRuleRouter(deps));
  const busy = new Set();
  const withLock = async (id, work) => {
    if (busy.has(id)) throw Object.assign(new Error('A turn is already running for this project. Wait for it to finish.'), { status: 409 });
    busy.add(id);
    try { return await work(); } finally { busy.delete(id); }
  };
  const validateMessage = value => {
    if (typeof value !== 'string' || !value.trim() || value.length > 12000) throw Object.assign(new Error('Message must contain 1–12,000 characters.'), { status: 400 });
    return value.trim();
  };
  // `provider` is optional. It names either a stored key id or a provider id and
  // only decides where the failover loop STARTS — every other key stays behind
  // it as a fallback, so a per-request choice can never disable switching.
  const validateProvider = value => {
    if (!value) return undefined;
    if (typeof value !== 'string' || !value.trim()) throw Object.assign(new Error('provider must be a non-empty string'), { status: 400 });
    const provider = value.trim();
    const keys = deps.registry?.entries?.() || [];
    const known = [
      ...keys.filter(k => k.enabled).flatMap(k => [k.id, k.provider]),
      ...listProviders(deps.cfg).map(p => p.id),
    ];
    const wanted = resolveProviderId(provider);
    const ok = known.includes(provider) || (wanted ? known.some(id => resolveProviderId(id) === wanted) : false);
    if (!ok) {
      throw Object.assign(new Error(`Generation provider '${provider}' is not configured. Available: ${[...new Set(known)].join(', ') || 'none'}.`), { status: 400 });
    }
    return provider;
  };
  // The ordinary JSON API remains available. The UI opts into streamed progress;
  // no draft prose is sent before JEV review and the final result is persisted first.
  const respondToTurn = async (req, res, conv, message, create = false) => {
    const provider = validateProvider(req.body?.provider);
    const streamed = (req.get('accept') || '').includes('application/x-ndjson');
    if (streamed) {
      res.status(create ? 201 : 200).set({ 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
      res.flushHeaders();
    }
    const write = payload => { if (!res.destroyed) res.write(JSON.stringify(payload) + '\n'); };
    try {
      const result = await runMemoryTurn(deps, conv, message, event => { if (streamed) write({ type: 'progress', event }); }, provider);
      if (create) await deps.store.createConversation(result.conversation);
      else await deps.store.saveConversation(result.conversation);
      if (streamed) { write({ type: 'result', result }); res.end(); }
      else res.status(create ? 201 : 200).json(result);
    } catch (error) {
      if (!streamed) throw error;
      write({ type: 'error', error: error.message || 'Turn failed. No changes were saved.' });
      res.end();
    }
  };

  r.get('/api/health', (req, res) => {
    const registry = deps.registry;
    const active = registry?.get(registry.activeId) || null;
    res.json({
      ok: true,
      service: 'forge-server',
      time: new Date().toISOString(),
      providers: {
        // What is really configured: 'unconfigured' is reported as such rather
        // than as a provider name, so a badge can never imply a live model.
        jev: deps.cfg.jev.provider || 'unconfigured',
        planner: active ? active.provider : deps.cfg.planner.provider || 'unconfigured',
        store: deps.cfg.db.kind,
      },
      activeProvider: active
        ? { id: active.id, provider: active.provider, note: active.note, model: active.model, origin: active.origin }
        : null,
      failover: registry
        ? { ...registry.failover, keys: registry.candidates().length, configured: registry.candidates().length > 0 }
        : null,
      mode: 'memory-first, JEV-governed generation',
    });
  });

  // ── Chat API (primary) ───────────────────────────────────────────────────
  r.get('/api/chat', async (req, res, next) => {
    try {
      const list = deps.store.listConversations ? await deps.store.listConversations() : await deps.store.list();
      res.json(list);
    } catch (e) { next(e); }
  });

  r.post('/api/chat', async (req, res, next) => {
    try {
      const goal = validateMessage(req.body?.goal || req.body?.message);
      const conv = makeConversation({ title: goal.slice(0, 60) });
      const extra = req.body?.constraints;
      if (extra !== undefined && (!extra || typeof extra !== 'object' || Array.isArray(extra))) return res.status(400).json({ error: 'constraints must be an object' });
      const message = extra && Object.keys(extra).length ? validateMessage(`${goal}\nAdditional user-supplied constraints: ${JSON.stringify(extra)}`) : goal;
      await respondToTurn(req, res, conv, message, true);
    } catch (e) { next(e); }
  });

  r.get('/api/chat/:id', async (req, res, next) => {
    try {
      const conv = deps.store.getConversation ? await deps.store.getConversation(req.params.id) : null;
      if (!conv) {
        // Try legacy
        const proj = await deps.store.get(req.params.id);
        if (!proj) return res.status(404).json({ error: 'conversation not found' });
        // Convert
        return res.json(makeConversation({ id: proj.id, createdAt: proj.createdAt, updatedAt: proj.updatedAt, title: proj.state.goal, projectState: proj.state, messages: [] }));
      }
      res.json(conv);
    } catch (e) { next(e); }
  });

  r.delete('/api/chat/:id', async (req, res, next) => {
    try {
      await withLock(req.params.id, async () => {
        if (deps.store.removeConversation) await deps.store.removeConversation(req.params.id);
        else await deps.store.remove(req.params.id);
        res.json({ ok: true });
      });
    } catch (e) { next(e); }
  });

  r.post('/api/chat/:id/messages', async (req, res, next) => {
    try {
      const message = validateMessage(req.body?.text);
      await withLock(req.params.id, async () => {
        let conv = deps.store.getConversation ? await deps.store.getConversation(req.params.id) : null;
        if (!conv) {
          const proj = await deps.store.get(req.params.id);
          if (!proj) return res.status(404).json({ error: 'conversation not found' });
          conv = makeConversation({ id: proj.id, createdAt: proj.createdAt, updatedAt: proj.updatedAt, title: proj.state.goal, projectState: proj.state, messages: [] });
        }
        await respondToTurn(req, res, conv, message);
      });
    } catch (e) { next(e); }
  });

  // ── Legacy project API (kept for backward compat, maps to chat) ──────────
  r.get('/api/projects', async (req, res, next) => {
    try {
      res.json(await deps.store.list());
    } catch (e) { next(e); }
  });

  r.post('/api/projects', async (req, res, next) => {
    try {
      const goal = String(req.body?.goal || '').trim();
      if (!goal) return res.status(400).json({ error: 'goal is required' });
      const conv = makeConversation({ title: goal.slice(0, 60) });
      const { conversation, response, decisions } = await synthesizeChatProject(deps, conv, goal, req.body?.constraints || {}, validateProvider(req.body?.provider));
      await deps.store.createConversation(conversation);
      // Return legacy shape as well
      const project = { id: conversation.id, createdAt: conversation.createdAt, updatedAt: conversation.updatedAt, state: conversation.projectState };
      res.status(201).json({ project, response, decisions, conversation });
    } catch (e) { next(e); }
  });

  r.get('/api/projects/:id', async (req, res, next) => {
    try {
      const conv = deps.store.getConversation ? await deps.store.getConversation(req.params.id) : null;
      if (conv) {
        return res.json({ id: conv.id, createdAt: conv.createdAt, updatedAt: conv.updatedAt, state: conv.projectState, conversation: conv });
      }
      const project = await deps.store.get(req.params.id);
      if (!project) return res.status(404).json({ error: 'project not found' });
      res.json(project);
    } catch (e) { next(e); }
  });

  r.delete('/api/projects/:id', async (req, res, next) => {
    try {
      await withLock(req.params.id, async () => {
        if (deps.store.removeConversation) await deps.store.removeConversation(req.params.id);
        await deps.store.remove(req.params.id);
        res.json({ ok: true });
      });
    } catch (e) { next(e); }
  });

  r.post('/api/projects/:id/messages', async (req, res, next) => {
    try {
      await withLock(req.params.id, async () => {
        let conv = deps.store.getConversation ? await deps.store.getConversation(req.params.id) : null;
        if (!conv) {
          const proj = await deps.store.get(req.params.id);
          if (!proj) return res.status(404).json({ error: 'project not found' });
          conv = makeConversation({ id: proj.id, createdAt: proj.createdAt, updatedAt: proj.updatedAt, title: proj.state.goal, projectState: proj.state, messages: [] });
        }
        const { conversation, response, decisions } = conv.memory?.revision
          ? await runMemoryTurn(deps, conv, validateMessage(req.body?.text), undefined, validateProvider(req.body?.provider))
          : await handleChatMessage(deps, conv, { ...(req.body || {}), provider: validateProvider(req.body?.provider) });
        await deps.store.saveConversation(conversation);
        const project = { id: conversation.id, createdAt: conversation.createdAt, updatedAt: conversation.updatedAt, state: conversation.projectState };
        res.json({ project, response: { text: response.content, suggestions: [] }, decisions, conversation });
      });
    } catch (e) { next(e); }
  });

  r.post('/api/projects/:id/inventory', async (req, res, next) => {
    try {
      await withLock(req.params.id, async () => {
        let conv = deps.store.getConversation ? await deps.store.getConversation(req.params.id) : null;
        if (!conv) {
          const project = await deps.store.get(req.params.id);
          if (!project) return res.status(404).json({ error: 'project not found' });
          conv = makeConversation({ id: project.id, createdAt: project.createdAt, updatedAt: project.updatedAt, title: project.state.goal, projectState: project.state, messages: [] });
        }
        const items = Array.isArray(req.body?.items) ? req.body.items : [];
        if (!conv.projectState) return res.status(400).json({ error: 'no project state yet — create a plan first' });
        for (const it of items) {
          const name = String(it?.name || '').trim();
          if (!name) continue;
          conv.projectState.inventory.push({ id: crypto.randomUUID(), name, note: it.note ? String(it.note) : undefined });
        }
        if (items.length) {
          log(conv.projectState, 'system', `Inventory updated: ${items.map((i) => i.name).filter(Boolean).join(', ')}.`);
          conv.updatedAt = nowIso();
        }
        await deps.store.saveConversation(conv);
        res.json({ id: conv.id, createdAt: conv.createdAt, updatedAt: conv.updatedAt, state: conv.projectState, conversation: conv });
      });
    } catch (e) { next(e); }
  });

  return r;
}
