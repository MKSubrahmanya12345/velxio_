// Extract Forge memory (decisions/model notes) into JSON for fusion
import fs from 'node:fs';
import path from 'node:path';

export function extractForgeMemory() {
  try {
    const file = path.resolve('forge/server/src/memory/decisions.js');
    const src = fs.readFileSync(file, 'utf8');
    // Extract unresolvedNotes references if exported
    const notes = [];
    // Simple regex for note patterns (approximate)
    for (const line of src.split('\n')) {
      const m = line.match(/(?:note|Note)\s*:?\s*['"](.+?)['"]/);
      if (m) notes.push({ text: m[1], source: 'forge/decisions', ts: new Date().toISOString() });
    }
    return notes.slice(0, 10);
  } catch { return []; }
}
