import { randomUUID } from 'node:crypto';
export const KINDS = ['goal', 'rule', 'fact', 'preference', 'assumption', 'suggestion', 'question'];
export const id = prefix => `${prefix}_${randomUUID().slice(0, 12)}`;
export const emptyMemory = () => ({ version: 1, revision: 0, notes: [], events: [] });
export function normalizeMemory(raw) {
  if (!raw || !Array.isArray(raw.notes) || !Array.isArray(raw.events)) return emptyMemory();
  return { version: 1, revision: Number(raw.revision) || 0, notes: raw.notes, events: raw.events.slice(-120) };
}
export const activeNotes = memory => memory.notes.filter(n => n.status === 'active');
export function normalizeProposals(raw, message, memory) {
  if (!raw || !Array.isArray(raw.notes)) throw new Error('Memory proposer returned invalid notes. Nothing was saved.');
  const known = new Set(memory.notes.map(n => n.id));
  return raw.notes.slice(0, 8).filter(n => n && typeof n.text === 'string' && KINDS.includes(n.kind)).map(n => ({
    id: id('note'), kind: n.kind, text: n.text.trim().slice(0, 1200),
    quote: typeof n.quote === 'string' && n.quote.trim() && message.includes(n.quote.trim()) ? n.quote.trim().slice(0, 1200) : '',
    supersedes: Array.isArray(n.supersedes) ? [...new Set(n.supersedes.filter(x => typeof x === 'string' && known.has(x)))].slice(0, 8) : [],
  })).filter(n => n.text && !memory.notes.some(old => old.status !== 'superseded' && old.text.toLowerCase() === n.text.toLowerCase()));
}
