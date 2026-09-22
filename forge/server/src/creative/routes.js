// Velxio Create — REST API (collections, ingest, ideas, scripts, node edits).
//
// A collection is a Forge conversation flagged creative:true. Learned content
// lives in memory.notes (JEV-governed); full source texts live in
// creative.sources. All mutations run on a clone and persist only on success,
// mirroring the memory-turn contract. Manual node edits/deletes are instant
// user-authority operations — no review, no interruption.

import { Router } from 'express';
import { makeConversation } from '../schema.js';
import { activeNotes } from '../memory/model.js';
import { ingestUrl, ingestText } from './ingest.js';
import { updateNote, deleteNote, retrieveNotes } from './notes.js';
import { generateIdeas } from './ideas.js';
import { generateScript, FORMATS } from './script.js';
import { creativeError } from './youtube.js';

const clone = conv => makeConversation(JSON.parse(JSON.stringify(conv)));

function summarizeCollection(conv) {
  const notes = conv.memory?.notes || [];
  const sources = conv.creative?.sources || [];
  return {
    id: conv.id,
    name: conv.title,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    noteCount: notes.filter(n => n.status === 'active').length,
    pendingCount: notes.filter(n => n.status === 'pending' || n.status === 'proposed').length,
    sourceCount: sources.length,
    sources: sources.map(s => ({ id: s.id, kind: s.kind, url: s.url, title: s.title, source: s.source, fetchedAt: s.fetchedAt, chars: s.chars })),
  };
}

function detailCollection(conv) {
  return {
    ...summarizeCollection(conv),
    notes: [...(conv.memory?.notes || [])].reverse(),
    sourcePreviews: (conv.creative?.sources || []).map(s => ({
      id: s.id, kind: s.kind, url: s.url, title: s.title, source: s.source,
      fetchedAt: s.fetchedAt, chars: s.chars, summary: s.summary,
      preview: String(s.transcript || '').slice(0, 1500),
    })),
  };
}

export function createCreativeRouter(deps) {
  const r = Router();
  const busy = new Set();
  const withLock = async (id, work) => {
    if (busy.has(id)) throw Object.assign(new Error('This collection is busy. Wait for the running job to finish.'), { status: 409 });
    busy.add(id);
    try { return await work(); } finally { busy.delete(id); }
  };

  const getCollection = async (id) => {
    const conv = deps.store.getConversation ? await deps.store.getConversation(id) : null;
    if (!conv || !conv.creative) throw creativeError('Collection not found.', 'collection_missing', 404);
    return conv;
  };

  r.get('/api/creative/formats', (req, res) => {
    res.json({ formats: FORMATS });
  });

  r.post('/api/creative/collections', async (req, res, next) => {
    try {
      const name = String(req.body?.name || '').trim();
      if (!name || name.length > 80) throw creativeError('Collection name must be 1–80 characters.', 'bad_name', 400);
      const conv = makeConversation({ title: name });
      conv.creative = { collection: true, sources: [] };
      if (deps.store.createConversation) await deps.store.createConversation(conv);
      else await deps.store.saveConversation(conv);
      res.status(201).json(summarizeCollection(conv));
    } catch (e) { next(e); }
  });

  r.get('/api/creative/collections', async (req, res, next) => {
    try {
      const list = deps.store.listConversations ? await deps.store.listConversations() : [];
      res.json({ collections: list.filter(c => c.creative).map(summarizeCollection) });
    } catch (e) { next(e); }
  });

  r.get('/api/creative/collections/:id', async (req, res, next) => {
    try {
      res.json(detailCollection(await getCollection(req.params.id)));
    } catch (e) { next(e); }
  });

  r.delete('/api/creative/collections/:id', async (req, res, next) => {
    try {
      await withLock(req.params.id, async () => {
        await getCollection(req.params.id);
        if (deps.store.removeConversation) await deps.store.removeConversation(req.params.id);
        else await deps.store.remove(req.params.id);
        res.json({ ok: true });
      });
    } catch (e) { next(e); }
  });

  r.get('/api/creative/collections/:id/sources/:sourceId', async (req, res, next) => {
    try {
      const conv = await getCollection(req.params.id);
      const source = (conv.creative.sources || []).find(s => s.id === req.params.sourceId);
      if (!source) throw creativeError('Source not found.', 'source_missing', 404);
      res.json(source);
    } catch (e) { next(e); }
  });

  r.post('/api/creative/collections/:id/ingest', async (req, res, next) => {
    try {
      await withLock(req.params.id, async () => {
        const original = await getCollection(req.params.id);
        const conv = clone(original);
        const events = [];
        let result;
        if (req.body?.url) {
          result = await ingestUrl(deps, conv, req.body.url, e => events.push(e));
        } else if (req.body?.text) {
          result = await ingestText(deps, conv, { title: req.body.title, text: req.body.text });
        } else {
          throw creativeError('Provide a URL (url) or pasted content (text + optional title).', 'bad_ingest', 400);
        }
        await deps.store.saveConversation(conv);
        res.status(201).json({ ...result, events, collection: summarizeCollection(conv) });
      });
    } catch (e) { next(e); }
  });

  r.get('/api/creative/collections/:id/notes', async (req, res, next) => {
    try {
      const conv = await getCollection(req.params.id);
      const query = String(req.query?.q || '').trim();
      if (query) return res.json({ notes: retrieveNotes(conv.memory, query, 20), query });
      res.json({ notes: [...(conv.memory?.notes || [])].reverse() });
    } catch (e) { next(e); }
  });

  r.patch('/api/creative/collections/:id/notes/:noteId', async (req, res, next) => {
    try {
      await withLock(req.params.id, async () => {
        const conv = clone(await getCollection(req.params.id));
        const note = updateNote(conv, req.params.noteId, req.body || {});
        conv.updatedAt = new Date().toISOString();
        await deps.store.saveConversation(conv);
        res.json({ note });
      });
    } catch (e) { next(e); }
  });

  r.delete('/api/creative/collections/:id/notes/:noteId', async (req, res, next) => {
    try {
      await withLock(req.params.id, async () => {
        const conv = clone(await getCollection(req.params.id));
        const result = deleteNote(conv, req.params.noteId);
        conv.updatedAt = new Date().toISOString();
        await deps.store.saveConversation(conv);
        res.json(result);
      });
    } catch (e) { next(e); }
  });

  r.post('/api/creative/collections/:id/ideas', async (req, res, next) => {
    try {
      await withLock(req.params.id, async () => {
        const conv = clone(await getCollection(req.params.id));
        const result = await generateIdeas(deps, conv, req.body?.prompt, req.body?.count);
        conv.updatedAt = new Date().toISOString();
        await deps.store.saveConversation(conv);
        res.json({ ...result, activeNotes: activeNotes(conv.memory).length });
      });
    } catch (e) { next(e); }
  });

  r.post('/api/creative/collections/:id/script', async (req, res, next) => {
    try {
      await withLock(req.params.id, async () => {
        const conv = clone(await getCollection(req.params.id));
        const result = await generateScript(deps, conv, {
          idea: req.body?.idea,
          prompt: req.body?.prompt,
          format: req.body?.format,
        });
        conv.updatedAt = new Date().toISOString();
        await deps.store.saveConversation(conv);
        res.json(result);
      });
    } catch (e) { next(e); }
  });

  return r;
}
