// Velxio Create — memory bridge.
//
// Ingested content becomes governed memory notes (JEV-reviewed, same pipeline
// as chat turns). Manual node edits/deletes are user-authority operations:
// instant, logged, never gated by JEV — the user asked for no interruptions.
// Retrieval is a dependency-free keyword scorer (no embeddings in Forge).

import { nowIso } from '../schema.js';
import { id, normalizeProposals, activeNotes, KINDS, DOMAINS } from '../memory/model.js';
import { memoryQuestions, applyReview } from '../memory/decisions.js';
import { creativeError } from './youtube.js';

export const MAX_NOTES_PER_COLLECTION = 500;
export const MAX_NOTES_PER_INGEST = 8;

// Split a summary/transcript into atomic note-sized candidates. Summary
// bullets win (they are already atomic); else fall back to paragraphs.
export function candidateNotesFromText(summary, transcript, sourceLabel) {
  const bullets = String(summary || '')
    .split('\n')
    .map(l => l.replace(/^[\s*•\-–\d.)\]]+/, '').trim())
    .filter(l => l.length > 30);
  const paras = String(transcript || '')
    .split(/\n{2,}|\.\s+(?=[A-Z0-9"])/)
    .map(p => p.replace(/\s+/g, ' ').trim())
    .filter(p => p.length > 60);
  const picked = bullets.length >= 3 ? bullets : [...bullets, ...paras];
  return picked.slice(0, MAX_NOTES_PER_INGEST).map(text => ({
    kind: 'fact',
    domain: 'creative',
    text: text.slice(0, 1000),
    quote: text.slice(0, 200),
    supersedes: [],
    source: sourceLabel,
  }));
}

export function logCreativeEvent(memory, stage, status, label, extra = {}) {
  const item = { id: id('event'), stage, status, label, at: nowIso(), ...extra };
  memory.events = [...(memory.events || []), item].slice(-120);
  return item;
}

// Store ingest candidates as governed notes. JEV reviews when available;
// when JEV is down/unconfigured the import still lands — the user chose this
// content, so user authority applies (same rule as manual node edits).
export async function storeIngestedNotes(deps, conversation, candidates, source) {
  const memory = conversation.memory;
  if (memory.notes.length + candidates.length > MAX_NOTES_PER_COLLECTION) {
    throw creativeError('This collection reached its 500-note memory limit. Start a new collection.', 'memory_full', 400);
  }
  const message = `Ingested ${source.kind}: ${source.title || source.url}\n${(source.summary || source.transcript || '').slice(0, 4000)}`;
  const proposals = normalizeProposals({ notes: candidates }, message, memory);
  if (!proposals.length) return { notes: [], jev: 'duplicate' };
  let answers = null;
  let jevStatus = 'reviewed';
  try {
    const questions = memoryQuestions(proposals, memory);
    const response = await deps.jev({ state: { operation: 'creative_ingest', message, proposals, source: { kind: source.kind, url: source.url, title: source.title } }, questions });
    answers = response.answers || {};
    conversation.counters.jevCalls += 1;
    if (deps.counters) deps.counters.jevCalls += 1;
  } catch (error) {
    jevStatus = 'unavailable';
    logCreativeEvent(memory, 'review', 'complete', `JEV unavailable (${String(error.message || error).slice(0, 120)}) — import stored by user authority`, { sourceId: source.id });
  }
  let stored;
  if (answers) {
    stored = applyReview(proposals, answers, memory, source.id, nowIso());
  } else {
    stored = proposals.map(p => ({ ...p, status: 'active', origin: 'user-import', sourceId: source.id, reason: 'Stored by user authority; JEV was unavailable.' }));
    memory.notes.push(...stored);
    memory.revision += 1;
  }
  for (const note of stored) note.sourceId = source.id;
  logCreativeEvent(memory, 'ingest', 'complete', `Stored ${stored.length} notes from ${source.kind}: ${(source.title || source.url || '').slice(0, 80)}`, { sourceId: source.id, noteIds: stored.map(n => n.id), jev: jevStatus });
  return { notes: stored, jev: jevStatus };
}

function findNote(memory, noteId) {
  const note = (memory.notes || []).find(n => n.id === noteId);
  if (!note) throw creativeError('Node not found in this collection.', 'note_missing', 404);
  return note;
}

// Manual edit — instant, user authority, no JEV interruption.
export function updateNote(conversation, noteId, patch = {}) {
  const note = findNote(conversation.memory, noteId);
  if (patch.text !== undefined) {
    const text = String(patch.text || '').trim();
    if (!text || text.length > 2000) throw creativeError('Node text must be 1–2000 characters.', 'bad_text', 400);
    note.text = text;
  }
  if (patch.kind !== undefined) {
    if (!KINDS.includes(patch.kind)) throw creativeError(`Unknown kind. Use one of: ${KINDS.join(', ')}.`, 'bad_kind', 400);
    note.kind = patch.kind;
  }
  if (patch.domain !== undefined) {
    if (!DOMAINS.includes(patch.domain)) throw creativeError(`Unknown domain. Use one of: ${DOMAINS.join(', ')}.`, 'bad_domain', 400);
    note.domain = patch.domain;
  }
  note.editedBy = 'user';
  note.updatedAt = nowIso();
  // A manual edit settles the note: the user is the source of truth.
  if (note.status === 'pending' || note.status === 'proposed') {
    note.status = 'active';
    note.origin = 'user';
  }
  logCreativeEvent(conversation.memory, 'node', 'complete', `Node edited by user (${note.id})`, { noteId: note.id });
  return note;
}

// Manual delete — instant, logged with the removed text for the trail.
export function deleteNote(conversation, noteId) {
  const notes = conversation.memory.notes || [];
  const idx = notes.findIndex(n => n.id === noteId);
  if (idx === -1) throw creativeError('Node not found in this collection.', 'note_missing', 404);
  const [removed] = notes.splice(idx, 1);
  conversation.memory.revision += 1;
  logCreativeEvent(conversation.memory, 'node', 'complete', `Node deleted by user (${noteId})`, { noteId, removedText: String(removed.text || '').slice(0, 300) });
  return { deleted: noteId };
}

// Keyword retrieval over active notes. Scores term overlap with light length
// normalization; ties break toward newer notes.
export function retrieveNotes(memory, query, limit = 12) {
  const terms = String(query || '').toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 2);
  const unique = [...new Set(terms)];
  if (!unique.length) return [];
  const scored = activeNotes(memory).map((note, index) => {
    const hay = `${note.text} ${note.kind} ${note.domain || ''}`.toLowerCase();
    let hits = 0;
    for (const term of unique) {
      if (hay.includes(term)) hits += term.length >= 6 ? 2 : 1;
    }
    const lengthNorm = 1 + Math.log10(1 + hay.length / 400);
    return { note, score: hits / lengthNorm, index };
  }).filter(s => s.score > 0);
  scored.sort((a, b) => b.score - a.score || b.index - a.index);
  return scored.slice(0, Math.max(1, limit)).map(s => ({ ...s.note, _score: Math.round(s.score * 100) / 100 }));
}
