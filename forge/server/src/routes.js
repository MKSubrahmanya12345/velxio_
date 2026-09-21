// Forge — REST API (chat-first + legacy compatibility)

import { Router } from 'express';
import { synthesizeChatProject, handleChatMessage, synthesizeProject, handleMessage } from './pipeline.js';
import { makeConversation, makeProject, nowIso, log } from './schema.js';

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
      mode: 'chat-first, human as tool',
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
      const goal = String(req.body?.goal || req.body?.message || '').trim();
      if (!goal) return res.status(400).json({ error: 'goal or message is required — e.g. "I wanna build an MP3 player"' });

      const conv = makeConversation({ title: goal.slice(0, 60) });
      // If goal looks like build request, directly synthesize
      const { conversation, response, decisions } = await synthesizeChatProject(deps, conv, goal, req.body?.constraints || {});
      await deps.store.createConversation(conversation);
      res.status(201).json({ conversation, response, decisions });
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
      if (deps.store.removeConversation) await deps.store.removeConversation(req.params.id);
      else await deps.store.remove(req.params.id);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  r.post('/api/chat/:id/messages', async (req, res, next) => {
    try {
      let conv = deps.store.getConversation ? await deps.store.getConversation(req.params.id) : null;
      if (!conv) {
        const proj = await deps.store.get(req.params.id);
        if (!proj) return res.status(404).json({ error: 'conversation not found' });
        conv = makeConversation({ id: proj.id, createdAt: proj.createdAt, updatedAt: proj.updatedAt, title: proj.state.goal, projectState: proj.state, messages: [] });
      }
      const { conversation, response, decisions } = await handleChatMessage(deps, conv, req.body || {});
      await deps.store.saveConversation(conversation);
      res.json({ conversation, response, decisions });
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
      const { conversation, response, decisions } = await synthesizeChatProject(deps, conv, goal, req.body?.constraints || {});
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
      if (deps.store.removeConversation) await deps.store.removeConversation(req.params.id);
      await deps.store.remove(req.params.id);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  r.post('/api/projects/:id/messages', async (req, res, next) => {
    try {
      let conv = deps.store.getConversation ? await deps.store.getConversation(req.params.id) : null;
      if (!conv) {
        const proj = await deps.store.get(req.params.id);
        if (!proj) return res.status(404).json({ error: 'project not found' });
        conv = makeConversation({ id: proj.id, createdAt: proj.createdAt, updatedAt: proj.updatedAt, title: proj.state.goal, projectState: proj.state, messages: [] });
      }
      const { conversation, response, decisions } = await handleChatMessage(deps, conv, req.body || {});
      await deps.store.saveConversation(conversation);
      const project = { id: conversation.id, createdAt: conversation.createdAt, updatedAt: conversation.updatedAt, state: conversation.projectState };
      res.json({ project, response: { text: response.content, suggestions: [] }, decisions, conversation });
    } catch (e) { next(e); }
  });

  r.post('/api/projects/:id/inventory', async (req, res, next) => {
    try {
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
    } catch (e) { next(e); }
  });

  return r;
}
