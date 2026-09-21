import { makeConversation, makeMessage, nowIso } from '../schema.js';
import { createReasoner } from './reasoner.js';
import { normalizeMemory, normalizeProposals, activeNotes, id, COMMIT_KINDS } from './model.js';
import { memoryQuestions, outputQuestions, applyReview, evaluateOutput } from './decisions.js';
import { handleChatMessage } from '../pipeline.js';
import { unresolvedError } from '../providers/registry.js';

// All work happens on a clone. The route persists only after the guarded turn
// completes; extraction/generation/provider failures cannot mutate stored state.
// `requestedProvider` picks a named generator (from cfg.providers); absent, the
// default provider is used. A requested-but-unconfigured provider is a 400.
export async function runMemoryTurn(deps, original, text, emit = () => {}, requestedProvider) {
  const conversation = makeConversation(JSON.parse(JSON.stringify(original)));
  const message = String(text || '').trim();
  if (!message || message.length > 12000) throw Object.assign(new Error('Message must contain 1–12,000 characters.'), { status: 400 });
  const memory = conversation.memory = normalizeMemory(conversation.memory);
  if (memory.notes.length >= 500) throw Object.assign(new Error('This project has reached its memory limit. Start a new conversation; existing rules have not been removed.'), { status: 400 });
  const provider = resolveProvider(deps, requestedProvider);
  const turnId = id('turn');
  const userMessage = makeMessage('user', message);
  const events = [];
  const decisions = [];
  const generator = (provider && deps.reasonerFor ? deps.reasonerFor(provider) : null) || deps.reasoner || createReasoner(deps.cfg);
  const providers = { generator: provider || deps.cfg.planner.provider, jev: deps.cfg.jev.provider };
  const event = (stage, status, label, extra = {}) => {
    const item = { id: id('event'), turnId, stage, status, label, at: nowIso(), providers, ...extra };
    events.push(item);
    emit(item);
    return item;
  };
  // The raw JEV response is kept: exact failing values beat inferred ones.
  const ask = async (state, questions) => {
    const response = await deps.jev({ state, questions });
    conversation.counters.jevCalls += 1;
    if (deps.counters) deps.counters.jevCalls += 1;
    return { answers: response.answers || {}, raw: response };
  };
  const knowledge = () => ({ revision: memory.revision, notes: memory.notes.filter(n => !['superseded', 'rejected'].includes(n.status)) });
  // All active notes are supplied even when the transcript exceeds this window.
  const history = conversation.messages.slice(-20).map(({ role, content }) => ({ role, content }));
  event('extract', 'running', 'Generator is proposing project notes');
  const proposals = normalizeProposals(await generator.propose({ message, memory: knowledge(), history }), message, memory);
  if (memory.notes.length + proposals.length > 500) throw new Error('These updates exceed the project memory limit. No notes were discarded or saved.');
  event('extract', 'complete', `${proposals.length} candidate notes formed`, { proposals });
  event('review', 'running', 'JEV is evaluating origin, conflicts, and change authority');
  // Review also reconciles earlier pending notes/questions against this message,
  // so it runs even when the proposer formed no new candidates.
  const mQuestions = memoryQuestions(proposals, memory);
  const review = Object.keys(mQuestions).length
    ? await ask({ operation: 'memory_review', message, proposals, memory: knowledge() }, mQuestions)
    : { answers: {}, raw: null };
  const changed = applyReview(proposals, review.answers, memory, userMessage.id, nowIso());
  event('review', 'complete', changed.length ? 'Memory changes evaluated by JEV' : 'No new notes; existing memory retained', { noteIds: changed.map(n => n.id), notes: changed, raw: review.raw });
  event('context', 'complete', 'Project memory supplied to the same generator', { noteIds: activeNotes(memory).map(n => n.id), notes: memory.notes, revision: memory.revision });

  // Older structured build conversations keep their execution loop. Its result
  // is a draft and its state transition is committed ONLY if review passes.
  let legacyResult = null;
  let legacyCalls = 0;
  if (conversation.projectState) {
    const legacyPlanner = (provider && deps.plannerFor ? deps.plannerFor(provider) : null) || deps.planner;
    if (!legacyPlanner) throw Object.assign(new Error('No generation provider is configured for the structured-build path. Set at least one provider key in forge/server/.env.'), { status: 400 });
    const legacyDeps = { ...deps, planner: (goal, constraints, feasibility) => legacyPlanner(goal, { ...constraints, notes: `${constraints?.notes || ''}\nPROJECT MEMORY (binding): ${JSON.stringify(activeNotes(memory))}` }, feasibility) };
    legacyResult = await handleChatMessage(legacyDeps, makeConversation(JSON.parse(JSON.stringify(conversation))), { text: message, provider });
    legacyCalls = Math.max(0, legacyResult.conversation.counters.jevCalls - conversation.counters.jevCalls);
  }
  event('generate', 'running', legacyResult ? 'Preparing a structured-build response draft' : 'Generator is drafting with the current project memory');
  const context = { message, memory: knowledge(), history, projectState: legacyResult?.conversation.projectState || conversation.projectState };
  let draft = await generator.respond({ ...context, structuredBuildDraft: legacyResult?.response || null });
  const validateDraft = () => {
    if (typeof draft?.content !== 'string' || !draft.content.trim() || draft.content.length > 24000) throw new Error('Generator returned an invalid response. Nothing was saved.');
  };
  const notes = activeNotes(memory).filter(n => COMMIT_KINDS.includes(n.kind));
  let verdict;
  for (let attempt = 0; attempt < 2; attempt++) {
    validateDraft();
    event('generate', 'complete', attempt ? 'Revised draft ready' : 'Draft ready for rule checks');
    event('check', 'running', `JEV is checking ${notes.length} active notes`, { noteIds: notes.map(n => n.id), attempt });
    const output = await ask({ operation: 'output_review', message, notes, memory: knowledge(), draft: draft.content, proposedActions: legacyResult?.response.toolCalls || [], proposedPlan: legacyResult?.conversation.projectState || null }, outputQuestions(notes));
    verdict = evaluateOutput(notes, output.answers);
    event('check', verdict.passed ? 'complete' : 'blocked', verdict.passed ? 'Response passed the active-memory checks' : `Response held: ${heldHeadline(verdict)}`, { ...verdict, answers: output.answers, raw: output.raw, noteIds: notes.map(n => n.id), attempt });
    decisions.push({ id: 'MEMORY_CHECK', name: 'Project memory guard', kind: 'memory_guard', summary: checkSummary(verdict, notes.length, providers), confidence: verdict.checks.length ? Math.min(...verdict.checks.map(c => c.value ?? 0)) : (verdict.passed ? .9 : .1), detail: { ...verdict, answers: output.answers } });
    if (verdict.passed || attempt === 1) break;
    event('repair', 'running', 'Returning failed checks to the same generator for revision', { noteIds: verdict.blocking.filter(b => b.noteId).map(b => b.noteId) });
    // Never carry an unapproved legacy state change into a repaired prose reply.
    legacyResult = null;
    draft = await generator.respond({ ...context, projectState: conversation.projectState, repair: { draft: draft.content, checks: verdict.checks, disposition: verdict.disposition, blocking: verdict.blocking } });
    event('repair', 'complete', 'Generator revision received');
  }
  const content = verdict.passed ? draft.content : withheldNotice(verdict);
  const response = makeMessage('assistant', content, { decisions, meta: { turnId, memoryRevision: memory.revision, providers, guarded: true, withheld: !verdict.passed } });
  if (legacyResult && verdict.passed) {
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
  event('ready', 'complete', verdict.passed ? 'Checked response ready to save' : `Draft withheld: ${heldHeadline(verdict)}`);
  memory.events = [...memory.events, ...events].slice(-120);
  return { conversation, response, decisions };
}

// A requested provider must be in the ready set; otherwise the turn is a
// clear 400 (never a fallback). With no request, the default provider wins.
function resolveProvider(deps, requested) {
  const ready = (deps.cfg?.providers || []).filter((p) => p.ready).map((p) => p.id);
  if (requested && !ready.includes(requested)) throw Object.assign(new Error(unresolvedError(requested, deps.cfg)), { status: 400 });
  return requested || deps.cfg?.planner?.provider || '';
}

// A held draft always states the actual blocking reason. Evaluation gaps are
// labeled as such — never as "your requirements are wrong".
function heldHeadline(verdict) {
  const parts = [];
  const counts = {};
  for (const b of verdict.blocking) counts[b.type] = (counts[b.type] || 0) + 1;
  if (counts.contradiction) parts.push(`${counts.contradiction} contradiction${counts.contradiction > 1 ? 's' : ''}`);
  if (counts['rule-check-uncertain']) parts.push(`${counts['rule-check-uncertain']} uncertain rule check${counts['rule-check-uncertain'] > 1 ? 's' : ''}`);
  if (counts['check-missing']) parts.push(`${counts['check-missing']} check${counts['check-missing'] > 1 ? 's' : ''} returned no usable value`);
  if (counts.disposition) parts.push('output disposition: revise');
  return parts.join(' · ') || 'unresolved memory check';
}

function checkSummary(verdict, noteCount, providers) {
  const passed = verdict.checks.filter(c => c.verdict === 'pass').length;
  const label = 'JEV evaluation';
  const status = verdict.passed ? 'Passed' : 'Held';
  const scope = noteCount ? `${passed}/${noteCount} active notes passed` : 'no active notes to check';
  const detail = verdict.passed
    ? `disposition ${verdict.disposition || 'missing (delivered on checks alone)'}`
    : heldHeadline(verdict);
  return `${status} · ${scope} · ${detail} · ${label}`;
}

function withheldNotice(verdict) {
  const lines = [
    '**Project-memory check held this draft.** Your project memory was not changed.',
    '',
    '**What blocked it:**',
  ];
  for (const b of verdict.blocking) {
    if (b.type === 'contradiction') {
      lines.push(`- **Contradiction** with ${b.noteId ? `“${b.text}”` : 'an active note'}${b.value !== null ? ` (JEV ${b.value})` : ''}. Tell me which statement should win, or use **Change this note**.`);
    } else if (b.type === 'rule-check-uncertain') {
      lines.push(`- The check on rule “${b.text}” stayed **uncertain**${b.value !== null ? ` (JEV ${b.value})` : ''} — not a confirmed contradiction, but binding rules are checked strictly. Restate the requirement or narrow the task.`);
    } else if (b.type === 'check-missing') {
      lines.push(`- The JEV check for “${b.text}” returned **no usable value** — an evaluation failure, not a change to your rules.`);
    } else if (b.type === 'disposition') {
      lines.push('- Output disposition was **revise** — the draft itself was judged contradictory or unusable.');
    }
  }
  if (verdict.disposition === null) {
    lines.push(`- Output disposition returned ${verdict.dispositionMalformed ? '**an unusable value**' : '**no value**'} (the raw answers are in the decision trail). This is an evaluation gap, not a request to change your requirements.`);
  }
  lines.push('', 'Keep going — add detail or ask me anything. Only confirmed rules are binding; unresolved notes stay open until you settle them.');
  return lines.join('\n');
}
