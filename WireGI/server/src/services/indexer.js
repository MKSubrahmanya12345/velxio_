// Research index — the speed-up layer.
//
// Two jobs:
//   1. find()  — retrieve prior findings for a similar topic so a part does not
//                re-search what we already know (cheaper AND better grounded).
//   2. enrich() — after a research pass, store what was actually LEARNED, not
//                just the search-result titles. Titles alone are useless as
//                prior context; the gathered fields are what make reuse real.
//
// Zero-dep, file-backed, keyword-scored (no embeddings — same choice Forge made
// in creative/notes.js).
import fs from 'node:fs';
import path from 'node:path';

export function createIndexer(cfg) {
  const file = path.resolve(cfg?.db?.dataFile ? indexFileFor(cfg.db.dataFile) : './data/wiregi-index.json');
  let store = {};

  try {
    store = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    store = {};
  }

  function persist() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
      fs.renameSync(tmp, file); // atomic, so a crash cannot corrupt the index
    } catch {
      /* the index is an optimisation — never let it break a build */
    }
  }

  const key = (topic) => String(topic || '').trim().toLowerCase();
  const tokens = (s) =>
    new Set(
      String(s || '')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 3),
    );

  return {
    // Record a fresh topic (called as soon as we search for it).
    add(entry) {
      const k = key(entry.topic);
      if (!k) return;
      store[k] = { ...(store[k] || {}), ...entry, ts: new Date().toISOString() };
      persist();
    },

    // Merge what the research pass actually learned into an existing entry.
    enrich(topic, patch = {}) {
      const k = key(topic);
      if (!k || !store[k]) return;
      store[k] = {
        ...store[k],
        ...patch,
        sources: patch.sources?.length ? patch.sources : store[k].sources,
        ts: new Date().toISOString(),
      };
      persist();
    },

    // Best prior finding for a query, by keyword overlap.
    // Returns null when nothing clears the bar — never a weak guess.
    find(query, minOverlap = 2) {
      const qt = tokens(query);
      if (!qt.size) return null;
      let best = null;
      let bestScore = 0;
      for (const k of Object.keys(store)) {
        const ot = tokens(`${k} ${store[k].summary || ''}`);
        let overlap = 0;
        for (const w of qt) if (ot.has(w)) overlap += 1;
        if (overlap > bestScore) {
          bestScore = overlap;
          best = store[k];
        }
      }
      return best && bestScore >= minOverlap ? { ...best, overlap: bestScore } : null;
    },

    all() {
      return store;
    },
  };
}

// Keep the index beside the project store it belongs to.
function indexFileFor(dataFile) {
  const dir = path.dirname(path.resolve(dataFile));
  return path.join(dir, 'wiregi-index.json');
}
