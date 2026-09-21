// Forge — persistence (chat-first).
// Stores Conversations + legacy Projects in same JSON file / Mongo collection.

import fs from 'node:fs';
import path from 'node:path';
import { normalizeProject, normalizeConversation, makeConversation } from './schema.js';

export async function createStore(cfg) {
  const store = cfg.db.kind === 'mongo' ? new MongoStore(cfg.db.mongoUri) : new FileStore(cfg.db.dataFile);
  await store.init();
  return store;
}

// ── File store ────────────────────────────────────────────────────────────────
export class FileStore {
  constructor(file) {
    this.file = path.resolve(file);
    this.data = {}; // conversations
    this.projects = {}; // legacy
    this.listOrder = [];
  }

  async init() {
    try {
      const raw = await fs.promises.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      const convSource = parsed.conversations || parsed.projects || {};
      this.data = {};
      this.projects = {};
      for (const [key, value] of Object.entries(convSource)) {
        const conv = normalizeConversation(value, key);
        if (conv) {
          this.data[conv.id] = conv;
          continue;
        }
        const proj = normalizeProject(value, key);
        if (proj) {
          this.projects[proj.id] = proj;
          // Also convert to conversation for unified listing
          const converted = normalizeConversation(proj, key);
          if (converted) this.data[converted.id] = converted;
        }
      }
      // New format also has listOrder
      this.listOrder = (Array.isArray(parsed.listOrder) ? parsed.listOrder : Object.keys(convSource))
        .map((id) => this.data[id]?.id || this.projects[id]?.id)
        .filter(Boolean);
      // Deduplicate, conversations first
      this.listOrder = [...new Set(this.listOrder)];
    } catch {
      // first run
    }
  }

  async _persist() {
    const dir = path.dirname(this.file);
    await fs.promises.mkdir(dir, { recursive: true });
    const tmp = this.file + '.tmp';
    await fs.promises.writeFile(tmp, JSON.stringify({ conversations: this.data, projects: this.projects, listOrder: this.listOrder }, null, 2));
    await fs.promises.rename(tmp, this.file);
  }

  // ── Conversation API ────────────────────────────────────────────────────
  async createConversation(conv) {
    const normalized = normalizeConversation(conv);
    if (!normalized) throw new Error('invalid conversation');
    this.data[normalized.id] = normalized;
    this.listOrder = [normalized.id, ...this.listOrder.filter((id) => id !== normalized.id)];
    await this._persist();
    return normalized;
  }

  async getConversation(id) {
    return this.data[id] || null;
  }

  async saveConversation(conv) {
    const normalized = normalizeConversation(conv, conv?.id);
    if (!normalized) throw new Error('invalid conversation');
    this.data[normalized.id] = normalized;
    if (!this.listOrder.includes(normalized.id)) this.listOrder.unshift(normalized.id);
    await this._persist();
    return normalized;
  }

  async listConversations() {
    return this.listOrder.map((id) => this.data[id]).filter(Boolean);
  }

  async removeConversation(id) {
    delete this.data[id];
    this.listOrder = this.listOrder.filter((x) => x !== id);
    await this._persist();
  }

  // ── Legacy Project API (for /api/projects) ──────────────────────────────
  async create(project) {
    const normalized = normalizeProject(project);
    if (!normalized) throw new Error('invalid project');
    this.projects[normalized.id] = normalized;
    // Also mirror as conversation
    const conv = normalizeConversation(normalized);
    if (conv) {
      this.data[conv.id] = conv;
      this.listOrder = [conv.id, ...this.listOrder.filter((id) => id !== conv.id)];
    }
    await this._persist();
    return normalized;
  }

  async get(id) {
    if (this.data[id]) return { id: this.data[id].id, createdAt: this.data[id].createdAt, updatedAt: this.data[id].updatedAt, state: this.data[id].projectState };
    return this.projects[id] || null;
  }

  async save(project) {
    const normalized = normalizeProject(project, project?.id);
    if (!normalized) throw new Error('invalid project');
    this.projects[normalized.id] = normalized;
    const conv = this.data[normalized.id];
    if (conv) {
      conv.projectState = normalized.state;
      conv.updatedAt = normalized.updatedAt;
      this.data[normalized.id] = conv;
    }
    if (!this.listOrder.includes(normalized.id)) this.listOrder.unshift(normalized.id);
    await this._persist();
    return normalized;
  }

  async list() {
    // Return conversations as projects for backward compat if needed, but prefer conversations
    const convs = this.listOrder.map((id) => this.data[id]).filter(Boolean);
    if (convs.length) {
      return convs.map((c) => ({ id: c.id, createdAt: c.createdAt, updatedAt: c.updatedAt, state: c.projectState || { goal: c.title, phases: [], bom: [], acceptance: [], status: 'active', current: {}, inventory: [], log: [], skill: {}, safetyAcks: {}, counters: c.counters, confidence: {}, proposal: null } }));
    }
    return this.listOrder.map((id) => this.projects[id]).filter(Boolean);
  }

  async remove(id) {
    delete this.data[id];
    delete this.projects[id];
    this.listOrder = this.listOrder.filter((x) => x !== id);
    await this._persist();
  }

  // Unified aliases
  async listProjects() { return this.list(); }
}

 // ── Mongo store ─────────────────────────────────────────────────────────────
export class MongoStore {
  constructor(uri) {
    this.uri = uri;
    this.col = null;
    this.convCol = null;
  }

  async init() {
    const { MongoClient } = await import('mongodb');
    const client = new MongoClient(this.uri);
    await client.connect();
    const db = client.db();
    this.col = db.collection('forge');
    this.convCol = db.collection('forge_conversations');
  }

  async createConversation(conv) {
    const normalized = normalizeConversation(conv);
    if (!normalized) throw new Error('invalid conversation');
    await this.convCol.insertOne({ _id: normalized.id, ...normalized });
    return normalized;
  }

  async getConversation(id) {
    const doc = await this.convCol.findOne({ $or: [{ _id: id }, { id }] });
    return normalizeConversation(doc, id);
  }

  async saveConversation(conv) {
    const normalized = normalizeConversation(conv, conv?.id);
    if (!normalized) throw new Error('invalid conversation');
    await this.convCol.replaceOne({ _id: normalized.id }, { _id: normalized.id, ...normalized, updatedAt: new Date().toISOString() }, { upsert: true });
    return normalized;
  }

  async listConversations() {
    const docs = await this.convCol.find({}).sort({ createdAt: -1 }).limit(100).toArray();
    return docs.map((d) => normalizeConversation(d)).filter(Boolean);
  }

  async removeConversation(id) {
    await this.convCol.deleteMany({ $or: [{ _id: id }, { id }] });
  }

  // Legacy
  async create(project) {
    const normalized = normalizeProject(project);
    if (!normalized) throw new Error('invalid project');
    await this.col.insertOne({ _id: normalized.id, ...normalized });
    return normalized;
  }

  async get(id) {
    const conv = await this.getConversation(id);
    if (conv) return { id: conv.id, createdAt: conv.createdAt, updatedAt: conv.updatedAt, state: conv.projectState };
    const doc = await this.col.findOne({ $or: [{ _id: id }, { id }] });
    return normalizeProject(doc, id);
  }

  async save(project) {
    const normalized = normalizeProject(project, project?.id);
    if (!normalized) throw new Error('invalid project');
    await this.col.replaceOne({ _id: normalized.id }, { _id: normalized.id, ...normalized, updatedAt: new Date().toISOString() }, { upsert: true });
    return normalized;
  }

  async list() {
    const convs = await this.listConversations();
    if (convs.length) {
      return convs.map((c) => ({ id: c.id, createdAt: c.createdAt, updatedAt: c.updatedAt, state: c.projectState || { goal: c.title, phases: [], bom: [], acceptance: [], status: 'active', current: {}, inventory: [], log: [], skill: {}, safetyAcks: {}, counters: c.counters, confidence: {}, proposal: null } }));
    }
    const docs = await this.col.find({}).sort({ createdAt: -1 }).limit(100).toArray();
    return docs.map((doc) => normalizeProject(doc)).filter(Boolean);
  }

  async remove(id) {
    await this.col.deleteMany({ $or: [{ _id: id }, { id }] });
    await this.convCol.deleteMany({ $or: [{ _id: id }, { id }] });
  }
}
