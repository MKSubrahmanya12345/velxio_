// Lightweight research index for speed-up: avoids re-searching similar topics.
// Persisted to data/wiregi-index.json so findings survive restarts.
import fs from 'node:fs';
import path from 'node:path';

export function createIndexer() {
  const file = path.resolve('./data/wiregi-index.json');
  let store = {};
  try {
    store = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    store = {};
  }

  function tokens(s) {
    return new Set(
      String(s)
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 3),
    );
  }

  function add(entry) {
    store[entry.topic.toLowerCase()] = { ...entry, ts: new Date().toISOString() };
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(store, null, 2));
    } catch {
      /* best-effort persistence */
    }
  }

  // Returns the best prior finding when keyword overlap is high.
  function find(query, minOverlap = 2) {
    const qt = tokens(query);
    let best = null;
    let bestScore = 0;
    for (const key of Object.keys(store)) {
      const ot = tokens(key + ' ' + (store[key].summary || ''));
      let overlap = 0;
      for (const w of qt) if (ot.has(w)) overlap += 1;
      if (overlap > bestScore) {
        bestScore = overlap;
        best = store[key];
      }
    }
    return bestScore >= minOverlap ? { ...best, overlap: bestScore } : null;
  }

  return { add, find, all: () => store };
}
