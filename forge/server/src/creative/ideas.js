// Velxio Create — idea generation with JEV cross-compare.
//
// The LLM proposes idea candidates grounded in the collection's retrieved
// notes; JEV then scores each idea against those notes (support, conflicts).
// Scoring is advisory — every idea is returned, ranked — because the user
// asked for no interruptions. Filtering happens only if the UI asks for it.

import { createJsonModel } from '../providers/jsonModel.js';
import { probability, choiceInfo, T } from '../memory/decisions.js';
import { retrieveNotes, logCreativeEvent } from './notes.js';
import { creativeError } from './youtube.js';

export const IDEA_PROMPT = `You are a content strategist for a maker/creator channel. Given the user's request and their learned collection notes (ground truth from videos/articles they ingested), propose distinct content ideas.

Return JSON only: {"ideas":[{"title":"...","pitch":"2-3 sentences: what the piece is and why it works","hooks":["opening hook line 1","opening hook line 2"],"sourceNoteIds":["note id from the supplied notes that backs this idea"]}]}

Rules: every idea must be backed by at least one supplied note id (never invent note ids); pitches must reuse concrete facts/numbers/names from the notes; ideas must differ from each other in angle, not just wording; never contradict the notes.`;

export function ideaQuestions(ideas, notes) {
  const questions = {};
  const targets = {
    none: 'No contradiction — the idea is compatible with the retrieved notes',
    unclear: 'Uncertainty without one specific contradicting note (this is NOT a contradiction)',
    ...Object.fromEntries(notes.map(n => [n.id, `[${n.kind}] ${n.text}`.slice(0, 300)])),
  };
  ideas.forEach((idea, i) => {
    const brief = `Idea ${i} — ${idea.title}: ${idea.pitch}`;
    questions[`support_${i}`] = { type: 'noul', instructions: `Is this idea actually supported by the retrieved collection notes (concrete facts, claims, numbers it reuses)? ${brief}. Answer high only for specific grounding; low when the idea floats free of the notes or invents facts.` };
    questions[`compatible_${i}`] = { type: 'noul', instructions: `Is this idea compatible with the retrieved collection notes? ${brief}. Answer low ONLY for an actual contradiction you can point at; a middle value means genuine uncertainty, which is not a contradiction.` };
    questions[`conflicts_with_${i}`] = { type: 'choice', instructions: `If the idea contradicts the retrieved notes, which note does it contradict? ${brief}. Choose 'none' when compatible, 'unclear' when uncertain without one specific note.`, criteria: targets };
  });
  return questions;
}

export function scoreIdeas(ideas, answers, notes) {
  const activeIds = new Set(notes.map(n => n.id));
  const byId = new Map(notes.map(n => [n.id, n]));
  return ideas.map((idea, i) => {
    const support = probability(answers?.[`support_${i}`]);
    const compatible = probability(answers?.[`compatible_${i}`]);
    const conflict = choiceInfo(answers?.[`conflicts_with_${i}`], ['none', 'unclear', ...activeIds]);
    const conflictsWith = conflict.trusted && activeIds.has(conflict.choice) ? conflict.choice : null;
    let verdict = 'unknown';
    if (support !== null) {
      if (conflictsWith || (compatible !== null && compatible <= T.contradiction)) verdict = 'conflict';
      else if (support >= T.support) verdict = 'supported';
      else if (support <= T.contradiction) verdict = 'unsupported';
      else verdict = 'uncertain';
    }
    return {
      ...idea,
      jev: {
        support,
        compatible,
        conflictsWith,
        conflictsText: conflictsWith ? byId.get(conflictsWith)?.text || null : null,
        verdict,
      },
    };
  });
}

function normalizeIdeas(raw, noteIds, count) {
  const list = Array.isArray(raw?.ideas) ? raw.ideas : [];
  const ids = new Set(noteIds);
  const ideas = [];
  for (const item of list) {
    if (ideas.length >= count) break;
    if (!item || typeof item.title !== 'string' || typeof item.pitch !== 'string') continue;
    const title = item.title.trim().slice(0, 160);
    const pitch = item.pitch.trim().slice(0, 1200);
    if (!title || !pitch) continue;
    ideas.push({
      title,
      pitch,
      hooks: Array.isArray(item.hooks) ? item.hooks.map(h => String(h).trim()).filter(Boolean).slice(0, 3) : [],
      sourceNoteIds: Array.isArray(item.sourceNoteIds) ? item.sourceNoteIds.map(String).filter(id => ids.has(id)).slice(0, 5) : [],
    });
  }
  if (!ideas.length) throw creativeError('The model returned no usable ideas. Try again or rephrase the prompt.', 'bad_ideas');
  return ideas;
}

const VERDICT_RANK = { supported: 0, uncertain: 1, unknown: 2, unsupported: 3, conflict: 4 };

export async function generateIdeas(deps, conversation, prompt, count = 5, emit = () => {}) {
  const clean = String(prompt || '').trim();
  if (!clean || clean.length > 2000) throw creativeError('Prompt must be 1–2000 characters.', 'bad_prompt', 400);
  const n = Math.min(8, Math.max(3, Number(count) || 5));
  const memory = conversation.memory;
  const context = retrieveNotes(memory, clean, 12);
  if (!context.length) {
    throw creativeError('Nothing in this collection matches the prompt yet. Ingest a link first, or broaden the prompt.', 'no_context', 400);
  }
  const model = createJsonModel(deps.cfg, { registry: deps.registry, operation: 'creative_ideas', emit });
  const raw = await model(IDEA_PROMPT, {
    request: clean,
    ideaCount: n,
    notes: context.map(({ _score, ...note }) => note),
  });
  const noteIds = context.map(n => n.id);
  const ideas = normalizeIdeas(raw, noteIds, n);
  let jevStatus = 'reviewed';
  let scored = ideas.map(idea => ({ ...idea, jev: { support: null, compatible: null, conflictsWith: null, conflictsText: null, verdict: 'unknown' } }));
  try {
    const questions = ideaQuestions(ideas, context);
    const response = await deps.jev({ state: { operation: 'creative_ideas', request: clean, ideas, notes: context }, questions });
    scored = scoreIdeas(ideas, response.answers || {}, context);
    conversation.counters.jevCalls += 1;
    if (deps.counters) deps.counters.jevCalls += 1;
  } catch (error) {
    jevStatus = 'unavailable';
    logCreativeEvent(memory, 'review', 'complete', `JEV unavailable for idea scoring (${String(error.message || error).slice(0, 120)}) — ideas returned unscored`, {});
  }
  scored.sort((a, b) => (VERDICT_RANK[a.jev.verdict] ?? 2) - (VERDICT_RANK[b.jev.verdict] ?? 2) || (b.jev.support ?? -1) - (a.jev.support ?? -1));
  logCreativeEvent(memory, 'ideas', 'complete', `Generated ${scored.length} ideas for: ${clean.slice(0, 80)}`, { jev: jevStatus });
  return { ideas: scored, contextNoteIds: noteIds, jev: jevStatus };
}
