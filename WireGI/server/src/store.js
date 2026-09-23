// Minimal zero-dependency JSON file store for projects.
import fs from 'node:fs';
import path from 'node:path';

export function createStore(cfg) {
  const file = path.resolve(cfg.db.dataFile);
  let cache = new Map();

  async function load() {
    try {
      const raw = JSON.parse(await fs.promises.readFile(file, 'utf8'));
      cache = new Map(raw.map((p) => [p.id, p]));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      cache = new Map();
    }
  }

  async function commit() {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    await fs.promises.writeFile(tmp, JSON.stringify([...cache.values()], null, 2));
    await fs.promises.rename(tmp, file);
  }

  return {
    async init() { await load(); return this; },
    async list() {
      return [...cache.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    async get(id) { return cache.get(id) || null; },
    async create(project) { cache.set(project.id, project); await commit(); return project; },
    async save(project) {
      project.updatedAt = new Date().toISOString();
      cache.set(project.id, project);
      await commit();
      return project;
    },
    async remove(id) { cache.delete(id); await commit(); return { ok: true }; },
  };
}
