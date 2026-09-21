import { makeConversation, makeMessage, nowIso } from '../schema.js';
import { createReasoner } from './reasoner.js';
import { normalizeMemory, normalizeProposals, activeNotes, id } from './model.js';
import { memoryQuestions, outputQuestions, applyReview, evaluateOutput } from './decisions.js';
import { handleChatMessage } from '../pipeline.js';

// All work happens on a clone. The route persists only after the guarded turn
// completes; extraction/generation/provider failures cannot mutate stored state.
export async function runMemoryTurn(deps, original, text, emit = () => {}) {
  const conversation = makeConversation(JSON.parse(JSON.stringify(original)));
  const message = String(text || '').trim();
  if (!message || message.length > 12000) throw Object.assign(new Error('Message must contain 1–12,000 characters.'), { status: 400 });
  const memory = conversation.memory = normalizeMemory(conversation.memory);
  if (memory.notes.length >= 500) throw Object.assign(new Error('This project has reached its memory limit. Start a new conversation; existing rules have not been removed.'), { status: 400 });
  const turnId = id('turn');
  const userMessage = makeMessage('user', message);
  const events = [];
  const decisions = [];
  const generator = deps.reasoner || createReasoner(deps.cfg);
  const providers = { generator: deps.cfg.planner.provider, jev: deps.cfg.jev.provider };
  const event = (stage, status, label, extra = {}) => {
    const item = { id: id('event'), turnId, stage, status, label, at: nowIso(), providers, ...extra };
    events.push(item);
    emit(item);
    return item;
  };
  const ask = async (state, questions) => {
    const response = await deps.jev({ state, questions });
    conversation.counters.jevCalls += 1;
    if (deps.counters) deps.counters.jevCalls += 1;
    return response.answers || {};
  };
  const knowledge = () => ({ revision: memory.revision, notes: memory.notes.filter(n => !['superseded', 'rejected'].includes(n.status)) });
  // All active notes are supplied even when the transcript exceeds this window.
  const history = conversation.messages.slice(-20).map(({ role, content }) => ({ role, content }));
  event('extract', 'running', 'Generator is proposing project notes');
  const proposals = normalizeProposals(await generator.propose({ message, memory: knowledge(), history }), message, memory);
  if (memory.notes.length + proposals.length > 500) throw new Error('These updates exceed the project memory limit. No notes were discarded or saved.');
  event('extract', 'complete', `${proposals.length} candidate notes formed`, { proposals });
  event('review', 'running', 'JEV is evaluating origin, conflicts, and change authority');
  const answers = proposals.length ? await ask({ operation: 'memory_review', message, proposals, memory: knowledge() }, memoryQuestions(proposals)) : {};
  const changed = applyReview(proposals, answers, memory, userMessage.id, nowIso());
  event('review', 'complete', proposals.length ? 'Memory changes evaluated by JEV' : 'No new notes; existing memory retained', { noteIds: changed.map(n => n.id), notes: changed });
  event('context', 'complete', 'Project memory supplied to the same generator', { noteIds: activeNotes(memory).map(n => n.id), notes: memory.notes, revision: memory.revision });

  // Older structured build conversations keep their execution loop. Its result
  // is a draft and its state transition is committed ONLY if review passes.
  let legacyResult = null;
  let legacyCalls = 0;
  if (conversation.projectState) {
    const legacyDeps = { ...deps, planner: (goal, constraints, feasibility) => deps.planner(goal, { ...constraints, notes: `${constraints?.notes || ''}\nPROJECT MEMORY (binding): ${JSON.stringify(activeNotes(memory))}` }, feasibility) };
    legacyResult = await handleChatMessage(legacyDeps, makeConversation(JSON.parse(JSON.stringify(conversation))), { text: message });
    legacyCalls = Math.max(0, legacyResult.conversation.counters.jevCalls - conversation.counters.jevCalls);
  }
  event('generate', 'running', legacyResult && providers.generator === 'mock' ? 'Preparing a structured-build response (demo)' : 'Generator is drafting with the current project memory');
  const context = { message, memory: knowledge(), history, projectState: legacyResult?.conversation.projectState || conversation.projectState };
  let draft = legacyResult && providers.generator === 'mock' ? { content: legacyResult.response.content } : await generator.respond({ ...context, structuredBuildDraft: legacyResult?.response || null });
  const validateDraft = () => {
    if (typeof draft?.content !== 'string' || !draft.content.trim() || draft.content.length > 24000) throw new Error('Generator returned an invalid response. Nothing was saved.');
  };
  const notes = activeNotes(memory).filter(n => ['goal', 'rule', 'fact', 'preference'].includes(n.kind));
  let review;
  for (let attempt = 0; attempt < 2; attempt++) {
    validateDraft();
    event('generate', 'complete', attempt ? 'Revised draft ready' : 'Draft ready for rule checks');
    event('check', 'running', `JEV is checking ${notes.length} active notes`, { noteIds: notes.map(n => n.id), attempt });
    const output = await ask({ operation: 'output_review', message, notes, memory: knowledge(), draft: draft.content, proposedActions: legacyResult?.response.toolCalls || [], proposedPlan: legacyResult?.conversation.projectState || null }, outputQuestions(notes));
    review = evaluateOutput(notes, output);
    event('check', review.passed ? 'complete' : 'blocked', review.passed ? 'Response passed the active-memory checks' : 'Response held: conflict or uncertain rule check', { ...review, noteIds: notes.map(n => n.id), attempt });
    decisions.push({ id: 'MEMORY_CHECK', name: 'Project memory guard', kind: 'memory_guard', summary: `${review.passed ? 'Passed' : 'Held'} · ${review.checks.filter(c => c.verdict === 'pass').length}/${notes.length} active notes · ${providers.jev === 'mock' ? 'demo heuristics' : 'JEV evaluation'}`, confidence: review.checks.length ? Math.min(...review.checks.map(c => c.value ?? 0)) : 0, detail: review });
    if (review.passed || attempt === 1) break;
    event('repair', 'running', 'Returning failed checks to the same generator for revision', { noteIds: review.checks.filter(c => c.verdict !== 'pass').map(c => c.noteId) });
    // Never carry an unapproved legacy state change into a repaired prose reply.
    legacyResult = null;
    draft = await generator.respond({ ...context, projectState: conversation.projectState, repair: { draft: draft.content, checks: review.checks, disposition: review.disposition } });
    event('repair', 'complete', 'Generator revision received');
  }
  const content = review.passed ? draft.content : 'I held back a draft because it did not pass the project-memory checks. Your existing rules remain in force. Please clarify the requirement you want to change, or narrow the next task. No unapproved plan changes were applied.';
  const response = makeMessage('assistant', content, { decisions, meta: { turnId, memoryRevision: memory.revision, providers, guarded: true, withheld: !review.passed } });
  if (legacyResult && review.passed) {
    conversation.projectState = legacyResult.conversation.projectState;
    conversation.pendingHumanTools = legacyResult.conversation.pendingHumanTools;
    conversation.counters.humanCalls = legacyResult.conversation.counters.humanCalls;
    conversation.counters.plans = legacyResult.conversation.counters.plans;
    response.toolCalls = legacyResult.response.toolCalls || [];
  }
  conversation.messages.push(userMessage, response);
  conversation.counters.jevCalls += legacyCalls;
  conversation.counters.messages += 1;
  conversation.updatedAt = nowIso();
  event('ready', 'complete', review.passed ? 'Checked response ready to save' : 'Clarification response ready; conflicting draft withheld');
  memory.events = [...memory.events, ...events].slice(-120);
  return { conversation, response, decisions };
}
