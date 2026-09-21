import { randomUUID } from 'node:crypto';
export const KINDS = ['goal', 'rule', 'fact', 'preference', 'assumption', 'suggestion', 'question'];
// Scopes of reality. A production constraint ("only me as crew") does not limit
// fictional characters, and a story-world fact does not authorize real-world
// resources. Mixing these scopes caused false conflicts (e.g. one actor vs two
// versions of a character), so every note carries a domain.
export const DOMAINS = ['production', 'fiction', 'creative', 'meta', 'unknown'];
export const COMMIT_KINDS = ['goal', 'rule', 'fact', 'preference'];
export const TENTATIVE_KINDS = ['assumption', 'suggestion', 'question'];
export const id = prefix => `${prefix}_${randomUUID().slice(0, 12)}`;
export const emptyMemory = () => ({ version: 1, revision: 0, notes: [], events: [] });
export function normalizeMemory(raw) {
  if (!raw || !Array.isArray(raw.notes) || !Array.isArray(raw.events)) return emptyMemory();
  return { version: 1, revision: Number(raw.revision) || 0, notes: raw.notes, events: raw.events.slice(-120) };
}
export const activeNotes = memory => memory.notes.filter(n => n.status === 'active');
// Notes still awaiting a decision: unconfirmed interpretations and open
// questions. They are revisited every turn (reconciliation) instead of being
// forgotten. The cap keeps one review call bounded; the newest are the most
// relevant to the latest message.
export const unresolvedNotes = memory => memory.notes
  .filter(n => n.status === 'pending' || (n.status === 'proposed' && n.kind === 'question'))
  .slice(-12);
export function normalizeProposals(raw, message, memory) {
  if (!raw || !Array.isArray(raw.notes)) throw new Error('Memory proposer returned invalid notes. Nothing was saved.');
  const known = new Set(memory.notes.map(n => n.id));
  // Duplicates are filtered against settled notes only. A pending note with the
  // same text must NOT swallow a re-statement: the fresh proposal is how that
  // declaration gets confirmed (applyReview merges it in place).
  const settled = new Set(memory.notes.filter(n => ['active', 'proposed', 'rejected'].includes(n.status)).map(n => n.text.toLowerCase()));
  return raw.notes.slice(0, 8).filter(n => n && typeof n.text === 'string' && KINDS.includes(n.kind)).map(n => ({
    id: id('note'), kind: n.kind, text: n.text.trim().slice(0, 1200),
    domain: DOMAINS.includes(n.domain) ? n.domain : 'unknown',
    quote: typeof n.quote === 'string' && n.quote.trim() && message.includes(n.quote.trim()) ? n.quote.trim().slice(0, 1200) : '',
    supersedes: Array.isArray(n.supersedes) ? [...new Set(n.supersedes.filter(x => typeof x === 'string' && known.has(x)))].slice(0, 8) : [],
  })).filter(n => n.text && !settled.has(n.text.toLowerCase()));
}
