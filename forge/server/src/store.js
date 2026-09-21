// Forge — persistence.
//
// MERN with a practical twist: MongoDB when MONGODB_URI is configured,
// otherwise a zero-dependency JSON file store (atomic writes, survives
// restarts). Both expose the same tiny contract, so routes never know which
// one is live.

import fs from 'node:fs';
import path from 'node:path';

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
      this.data = parsed.projects || {};
      this.listOrder = parsed.listOrder || Object.keys(this.data);
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
    this.data[project.id] = project;
    this.listOrder.unshift(project.id);
    await this._persist();
    return project;
  }

  async get(id) {
    return this.data[id] || null;
  }

  async save(project) {
    this.data[project.id] = project;
    await this._persist();
    return project;
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
    await this.col.insertOne(project);
    return project;
  }

  async get(id) {
    return (await this.col.findOne({ _id: id })) ?? null;
  }

  async save(project) {
    await this.col.replaceOne(
      { _id: project._id ?? project.id },
      { $set: { ...project, updatedAt: new Date().toISOString() } },
      { upsert: true },
    );
    return project;
  }

  async list() {
    return (await this.col.find({}).sort({ createdAt: -1 }).limit(100).toArray());
  }

  async remove(id) {
    await this.col.deleteOne({ _id: id });
  }
}
