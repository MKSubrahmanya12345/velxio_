// Forge — persistence.
//
// MERN with a practical twist: MongoDB when MONGODB_URI is configured,
// otherwise a zero-dependency JSON file store (atomic writes, survives
// restarts). Both expose the same tiny contract, so routes never know which
// one is live.

import fs from 'node:fs';
import path from 'node:path';
import { normalizeProject } from './schema.js';

export async function createStore(cfg) {
  const store = cfg.db.kind === 'mongo' ? new MongoStore(cfg.db.mongoUri) : new FileStore(cfg.db.dataFile);
  await store.init();
  return store;
}

// ── File store (default) ─────────────────────────────────────────────────────

export class FileStore {
  constructor(file) {
    this.file = path.resolve(file);
    this.data = {};
    this.listOrder = [];
  }

  async init() {
    try {
      const raw = await fs.promises.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      const source = parsed.projects || {};
      this.data = {};
      for (const [key, value] of Object.entries(source)) {
        const project = normalizeProject(value, key);
        if (project) this.data[project.id] = project;
      }
      this.listOrder = (Array.isArray(parsed.listOrder) ? parsed.listOrder : Object.keys(source))
        .map((id) => this.data[id]?.id || normalizeProject(source[id], id)?.id)
        .filter(Boolean);
      // Keep old files usable while ensuring the next write uses the canonical
      // { id, createdAt, updatedAt, state } envelope.
    } catch {
      // first run — nothing to load
    }
  }

  async _persist() {
    const dir = path.dirname(this.file);
    await fs.promises.mkdir(dir, { recursive: true });
    const tmp = this.file + '.tmp';
    await fs.promises.writeFile(tmp, JSON.stringify({ projects: this.data, listOrder: this.listOrder }, null, 2));
    await fs.promises.rename(tmp, this.file);
  }

  async create(project) {
    const normalized = normalizeProject(project);
    if (!normalized) throw new Error('invalid project');
    this.data[normalized.id] = normalized;
    this.listOrder = [normalized.id, ...this.listOrder.filter((id) => id !== normalized.id)];
    await this._persist();
    return normalized;
  }

  async get(id) {
    return this.data[id] || null;
  }

  async save(project) {
    const normalized = normalizeProject(project, project?.id);
    if (!normalized) throw new Error('invalid project');
    this.data[normalized.id] = normalized;
    if (!this.listOrder.includes(normalized.id)) this.listOrder.unshift(normalized.id);
    await this._persist();
    return normalized;
  }

  async list() {
    return this.listOrder.map((id) => this.data[id]).filter(Boolean);
  }

  async remove(id) {
    delete this.data[id];
    this.listOrder = this.listOrder.filter((x) => x !== id);
    await this._persist();
  }
}

// ── Mongo store (MONGODB_URI set) ────────────────────────────────────────────

export class MongoStore {
  constructor(uri) {
    this.uri = uri;
    this.col = null;
  }

  async init() {
    const { MongoClient } = await import('mongodb');
    const client = new MongoClient(this.uri);
    await client.connect();
    const db = client.db();
    this.col = db.collection('forge');
  }

  async create(project) {
    const normalized = normalizeProject(project);
    if (!normalized) throw new Error('invalid project');
    await this.col.insertOne({ _id: normalized.id, ...normalized });
    return normalized;
  }

  async get(id) {
    const doc = await this.col.findOne({ $or: [{ _id: id }, { id }] });
    return normalizeProject(doc, id);
  }

  async save(project) {
    const normalized = normalizeProject(project, project?.id);
    if (!normalized) throw new Error('invalid project');
    await this.col.replaceOne(
      { _id: normalized.id },
      { _id: normalized.id, ...normalized, updatedAt: new Date().toISOString() },
      { upsert: true },
    );
    return normalized;
  }

  async list() {
    const docs = await this.col.find({}).sort({ createdAt: -1 }).limit(100).toArray();
    return docs.map((doc) => normalizeProject(doc)).filter(Boolean);
  }

  async remove(id) {
    await this.col.deleteMany({ $or: [{ _id: id }, { id }] });
  }
}
