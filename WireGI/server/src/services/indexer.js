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
  // Goal text is deliberately repeated in every topic ("design a weather
  // station with an ESP32" in this example). Treating those words as equal to
  // the part name makes a cached Environmental Sensor Module look like a hit
  // for Power Supply, Button Interface, and firmware. Keep the scorer small,
  // but remove the words that carry no part identity.
  const STOP_WORDS = new Set([
    'about',
    'build',
    'design',
    'for',
    'from',
    'make',
    'module',
    'part',
    'project',
    'the',
    'this',
    'with',
  ]);
  const tokens = (s) =>
    new Set(
      String(s || '')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 2 && !STOP_WORDS.has(w)),
    );
  const overlap = (left, right) => {
    let score = 0;
    for (const token of left) if (right.has(token)) score += 1;
    return score;
  };

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
    //
    // `partName`/`profileId` are optional so old callers keep working. New
    // research calls pass them to prevent a shared project goal from making an
    // unrelated cached part look relevant. A known part name must overlap the
    // candidate's partName (or its topic for pre-metadata entries); otherwise
    // the result is rejected even if generic goal words match.
    // Returns null when nothing clears the bar — never a weak guess.
    find(query, minOverlap = 2, options = {}) {
      if (minOverlap && typeof minOverlap === 'object') {
        options = minOverlap;
        minOverlap = options.minOverlap ?? 2;
      }
      const qt = tokens(query);
      if (!qt.size) return null;
      const wantedPart = tokens(options.partName || options.required || '');
      const wantedProfile = String(options.profileId || '').trim();
      let best = null;
      let bestScore = 0;
      let bestPartScore = 0;
      for (const k of Object.keys(store)) {
        const entry = store[k] || {};
        if (wantedProfile && entry.profileId && entry.profileId !== wantedProfile) continue;
        const candidateText = `${k} ${entry.partName || ''} ${entry.domain || ''} ${entry.summary || ''}`;
        const ot = tokens(candidateText);
        const partScore = wantedPart.size ? overlap(wantedPart, tokens(entry.partName || k)) : 0;

        // If the entry has explicit part metadata, require the part identity to
        // match. For legacy rows without partName, use the topic key instead of
        // allowing the whole goal to satisfy the query.
        if (wantedPart.size && partScore === 0) {
          const legacyPartScore = overlap(wantedPart, tokens(k));
          if (legacyPartScore === 0) continue;
        }

        const score = overlap(qt, ot);
        if (
          score > bestScore ||
          (score === bestScore && partScore > bestPartScore)
        ) {
          bestScore = score;
          bestPartScore = partScore;
          best = entry;
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
