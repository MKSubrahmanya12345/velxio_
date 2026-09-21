// Prints one raw memory-review response and one raw output-review response so
// exact failing values can be inspected instead of inferred. Runs against the
// real TypeSafe JEV provider when TYPESAFE_API_KEY is configured; otherwise it
// falls back to the deterministic test fixture (dev-only, never used by the server).
//
//   node scripts/raw-reviews.mjs
//
// The scenario mirrors the solo horror-film conversation: grounded user quotes,
// a fictional-world premise beside a production constraint, and a draft that
// asks clarifying questions (the case that used to be held at 0/0).

import { loadConfig } from '../src/config.js';
import { createJevProvider } from '../src/providers/jev.js';
import { createJevMock } from '../test/fixtures/jevMock.js';
import { emptyMemory, normalizeProposals, COMMIT_KINDS } from '../src/memory/model.js';
import { memoryQuestions, outputQuestions, applyReview, evaluateOutput, T } from '../src/memory/decisions.js';

const cfg = loadConfig();
const jev = cfg.jev.provider === 'typesafe' ? createJevProvider(cfg) : createJevMock();

const message = 'the movie is like a student doesnt study for an exam, and the future self finds a way to communicate with that past self. the mechanism is: past self has a moniter and the future self has a phone. its both ways, the communication. also undecidable elements, its supernatural';

// What a proposer plausibly extracted from the film conversation (including the
// over-reach JEV is supposed to catch: the invented "immediate" qualifier).
const rawProposals = { notes: [
  { kind: 'goal', domain: 'fiction', text: 'A student who does not study for an exam receives help from their future self', quote: 'a student doesnt study for an exam, and the future self finds a way to communicate with that past self', supersedes: [] },
  { kind: 'fact', domain: 'fiction', text: 'Past self has a monitor; future self has a phone; communication is bidirectional and immediate', quote: 'past self has a moniter and the future self has a phone', supersedes: [] },
  { kind: 'rule', domain: 'production', text: 'Only me — no other actors or crew', quote: '', supersedes: [] },
  { kind: 'preference', domain: 'creative', text: 'Undecidable elements stay unexplained — supernatural, never over-classified', quote: 'undecidable elements, its supernatural', supersedes: [] },
] };

const memory = emptyMemory();
const prior = { id: 'note_prior1', kind: 'rule', domain: 'production', text: 'Only me, no other actors or crew', quote: 'Only me, no other actors or crew', supersedes: [], origin: 'user', status: 'active', reason: 'Grounded in your message and accepted by JEV.', sourceMessageId: 'msg_0', createdAt: new Date().toISOString() };
const openQuestion = { id: 'note_prior2', kind: 'question', domain: 'unknown', text: "Is 'monitor' a computer monitor, TV, or other display device?", quote: '', supersedes: [], origin: 'ai', status: 'proposed', reason: 'Kept tentative. This is not a binding user rule.', sourceMessageId: 'msg_1', createdAt: new Date().toISOString() };
memory.notes.push(prior, openQuestion);

const proposals = normalizeProposals(rawProposals, message, memory);
const mQuestions = memoryQuestions(proposals, memory);
console.log('── memory_review questions (ids) ─────────────────────');
console.log(Object.keys(mQuestions).join(', '));
const mResponse = await jev({ state: { operation: 'memory_review', message, proposals, memory: { revision: 0, notes: memory.notes } }, questions: mQuestions });
console.log('\n── RAW memory-review response ────────────────────────');
console.log(JSON.stringify(mResponse, null, 2));
const changed = applyReview(proposals, mResponse.answers || {}, memory, 'msg_2', new Date().toISOString());
console.log('\n── applied note outcomes (thresholds %s) ─────────────', JSON.stringify(T));
console.log(JSON.stringify(changed.map(n => ({ id: n.id, kind: n.kind, domain: n.domain, status: n.status, reason: n.reason, review: n.review })), null, 2));

const draft = 'Understood: you play both selves, communication is two-way through the monitor and phone, and the supernatural connection stays unexplained. We will keep the production solo. What does the future self want to force the past self to do?';
const notes = memory.notes.filter(n => n.status === 'active' && COMMIT_KINDS.includes(n.kind));
const oQuestions = outputQuestions(notes);
console.log('\n── output_review questions (ids) ─────────────────────');
console.log(Object.keys(oQuestions).join(', '));
const oResponse = await jev({ state: { operation: 'output_review', message, notes, memory: { revision: 0, notes: memory.notes }, draft, proposedActions: [], proposedPlan: null }, questions: oQuestions });
console.log('\n── RAW output-review response ────────────────────────');
console.log(JSON.stringify(oResponse, null, 2));
console.log('\n── evaluated output gate ─────────────────────────────');
console.log(JSON.stringify(evaluateOutput(notes, oResponse.answers || {}), null, 2));
