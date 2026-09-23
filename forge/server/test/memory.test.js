import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createJevMock } from './fixtures/jevMock.js';
import { createPlannerMock } from './fixtures/plannerMock.js';
import { createDemoReasoner } from './fixtures/demo.js';
import { makeConversation, normalizeConversation } from '../src/schema.js';
import { runMemoryTurn } from '../src/memory/turn.js';
import { emptyMemory } from '../src/memory/model.js';
import { applyReview, evaluateOutput, memoryQuestions, outputQuestions } from '../src/memory/decisions.js';
import { FileStore } from '../src/store.js';

const cfg = loadConfig({});
const dependencies = () => ({ cfg, jev: createJevMock(), planner: createPlannerMock(), reasoner: createDemoReasoner(), counters: { jevCalls: 0 } });
const noul = value => ({ type: 'noul', noul: value });
const choice = (value, confidence = .99) => ({ type: 'choice', choice: value, confidence });
const candidate = (extra = {}) => ({ id: 'note_1', kind: 'rule', text: 'Only me, no crew', quote: 'Only me, no crew', supersedes: [], ...extra });
const answers = (extra = {}) => ({ kind_0: choice('rule'), support_0: noul(.99), compatible_0: noul(.99), change_0: noul(.99), ...extra });
const accept = (memory, proposal = candidate(), result = answers()) => applyReview([proposal], result, memory, 'msg_user', '2026-09-21T00:00:00Z');

test('demo film: grounded rules, AI proposals, real events, and future-turn memory', async () => {
  const deps = dependencies();
  const original = makeConversation({ title: 'Solo horror' });
  const events = [];
  const first = await runMemoryTurn(deps, original, 'I want to make a horror film. Only me, no other actors or crew.', e => events.push(e));
  assert.equal(original.messages.length, 0, 'input remains untouched');
  assert.equal(original.memory.notes.length, 0);
  const rule = first.conversation.memory.notes.find(n => n.kind === 'rule');
  assert.equal(rule.status, 'active');
  assert.equal(rule.origin, 'user');
  assert.equal(rule.quote, 'Only me, no other actors or crew');
  assert.ok(first.conversation.memory.notes.some(n => n.kind === 'suggestion' && n.status === 'proposed'));
  assert.match(first.response.content, /Offline demo/);
  assert.ok(events.some(e => e.stage === 'context' && e.noteIds.includes(rule.id)));
  assert.ok(events.some(e => e.stage === 'check' && e.checks?.some(c => c.noteId === rule.id && c.verdict === 'pass')));
  const second = await runMemoryTurn(deps, first.conversation, 'I have a phone');
  assert.ok(second.conversation.memory.notes.some(n => n.id === rule.id && n.status === 'active'));
  assert.match(second.response.content, /one-person/);
  assert.equal(second.conversation.messages.length, 4);
});

test('user quotes alone cannot authorize unsupported, conflicting, or malformed rules', () => {
  for (const result of [answers({ support_0: noul(.2) }), answers({ compatible_0: noul(.4) }), {}, answers({ kind_0: choice('made_up') }), answers({ support_0: { type: 'noul', noul: '1' } }), answers({ kind_0: { type: 'choice', choice: 'rule', confidence: 'high' } })]) {
    const m = emptyMemory(); accept(m, candidate(), result);
    assert.equal(m.notes[0].status, 'pending');
  }
});

test('a split kind vote still remembers a grounded declaration', () => {
  const m = emptyMemory();
  accept(m, candidate(), answers({ kind_0: choice('rule', .6) }));
  assert.equal(m.notes[0].status, 'active');
  assert.equal(m.notes[0].kind, 'rule');
  assert.equal(m.notes[0].origin, 'user');
  assert.equal(m.notes[0].review.classification, null, 'the label was not a firm decision');
  assert.equal(m.notes[0].review.labelLean, 'rule', 'the lean is recorded');
  assert.match(m.notes[0].reason, /label/i);
  const firm = emptyMemory();
  accept(firm, candidate({ id: 'note_9' }), answers({ kind_0: choice('suggestion', .6) }));
  assert.equal(firm.notes[0].status, 'proposed', 'a tentative lean never becomes a binding rule');
});

test('compatibility uncertainty is reported as uncertainty, not conflict', () => {
  const m = emptyMemory();
  accept(m, candidate(), answers({ compatible_0: noul(.4) }));
  assert.equal(m.notes[0].status, 'pending');
  assert.match(m.notes[0].reason, /uncertain/i);
  assert.doesNotMatch(m.notes[0].reason, /Contradicts/i);
});

test('an identified contradiction names the affected note', () => {
  const m = emptyMemory();
  accept(m, candidate());
  accept(m, candidate({ id: 'note_2', text: 'Use a full crew' }), answers({ compatible_0: noul(.05), conflicts_with_0: choice('note_1') }));
  assert.equal(m.notes[1].status, 'pending');
  assert.match(m.notes[1].reason, /note_1/);
  const unnamed = emptyMemory();
  accept(unnamed, candidate());
  accept(unnamed, candidate({ id: 'note_2', text: 'Use a full crew' }), answers({ compatible_0: noul(.05), conflicts_with_0: choice('unclear') }));
  assert.match(unnamed.notes[1].reason, /contradiction/i);
  assert.doesNotMatch(unnamed.notes[1].reason, /note_1/);
});

test('AI proposals cannot become binding commitments without a grounded quote', () => {
  const m = emptyMemory();
  accept(m, candidate({ quote: '' }));
  assert.equal(m.notes[0].status, 'pending');
  assert.equal(m.notes[0].origin, 'ai');
  const other = emptyMemory();
  accept(other, candidate({ quote: '' }), answers({ kind_0: choice('suggestion') }));
  assert.equal(other.notes[0].status, 'proposed');
  assert.equal(other.notes[0].kind, 'suggestion');
});

test('explicit replacement keeps audit history; an ambiguous exception does not erase a rule', async () => {
  const deps = dependencies();
  let result = await runMemoryTurn(deps, makeConversation(), 'Make a horror film. Only me, no crew.');
  const rule = result.conversation.memory.notes.find(n => n.kind === 'rule');
  result = await runMemoryTurn(deps, result.conversation, 'My brother can help on Sunday');
  assert.equal(result.conversation.memory.notes.find(n => n.id === rule.id).status, 'active');
  const pending = result.conversation.memory.notes.find(n => n.status === 'pending');
  assert.ok(pending);
  result = await runMemoryTurn(deps, result.conversation, `Replace note ${rule.id}: Only me except my brother may operate the camera on Sunday.`);
  const old = result.conversation.memory.notes.find(n => n.id === rule.id);
  assert.equal(old.status, 'superseded');
  const replacement = result.conversation.memory.notes.find(n => n.id === old.supersededBy);
  assert.equal(replacement.status, 'active');
  assert.match(replacement.text, /Sunday/);
  assert.equal(result.conversation.memory.notes.find(n => n.id === pending.id).status, 'superseded');
});

test('low authorization cannot retire an established rule', () => {
  const m = emptyMemory(); accept(m);
  accept(m, candidate({ id: 'note_2', text: 'Use a crew', supersedes: ['note_1'] }), answers({ change_0: noul(.6) }));
  assert.equal(m.notes[0].status, 'active');
  assert.equal(m.notes[1].status, 'pending');
});

test('dynamic questions cover every active note; missing or malformed output answers block delivery', () => {
  const notes = [candidate(), candidate({ id: 'note_2', text: 'No paid tools' })];
  // Per proposal: kind, domain, support, compatible, conflicts_with, change.
  assert.equal(Object.keys(memoryQuestions(notes)).length, 12);
  assert.match(outputQuestions(notes).respect_1.instructions, /No paid tools/);
  for (const result of [{}, { disposition: choice('deliver'), respect_0: noul(1) }, { disposition: choice('deliver'), respect_0: noul(2), respect_1: noul(1) }]) assert.equal(evaluateOutput(notes, result).passed, false);
});

test('a revise disposition holds a clean draft; uncertain or missing dispositions do not', () => {
  const notes = [candidate()];
  const clean = { respect_0: noul(.99) };
  assert.equal(evaluateOutput(notes, { ...clean, disposition: choice('deliver', .5) }).passed, true, 'a split disposition vote still delivers');
  assert.equal(evaluateOutput(notes, { ...clean, disposition: choice('clarify', .55) }).passed, true, 'questions stay free — clarify is a normal outcome');
  assert.equal(evaluateOutput(notes, { ...clean, disposition: choice('deliver') }).passed, true);
  assert.equal(evaluateOutput(notes, clean).passed, true, 'checks are the guard when disposition is absent');
  assert.equal(evaluateOutput(notes, { ...clean, disposition: choice('revise', .5) }).passed, false, 'a revise lean holds and repairs');
});

test('uncertain checks on rules are strict; on softer notes they report without freezing conversation', () => {
  const ruleResult = evaluateOutput([candidate()], { disposition: choice('deliver'), respect_0: noul(.5) });
  assert.equal(ruleResult.passed, false);
  assert.equal(ruleResult.blocking[0].type, 'rule-check-uncertain');
  const factResult = evaluateOutput([candidate({ kind: 'fact', text: 'I have a phone' })], { disposition: choice('deliver'), respect_0: noul(.5) });
  assert.equal(factResult.passed, true);
  assert.equal(factResult.soft.length, 1);
  assert.equal(factResult.soft[0].verdict, 'uncertain', 'uncertainty stays labeled uncertainty');
  const conflict = evaluateOutput([candidate()], { disposition: choice('deliver'), respect_0: noul(.02) });
  assert.equal(conflict.passed, false);
  assert.equal(conflict.checks[0].verdict, 'conflict');
});

test('answering an open question needs no replacement authorization', () => {
  const m = emptyMemory();
  m.notes.push({ id: 'note_q', kind: 'question', text: 'Is the monitor a TV?', quote: '', supersedes: [], origin: 'ai', status: 'proposed', reason: 'Kept tentative. This is not a binding user rule.', sourceMessageId: 'msg_old', createdAt: '2026-09-20T00:00:00Z' });
  accept(m, candidate({ id: 'note_a', text: 'The monitor is a computer monitor', quote: 'The monitor is a computer monitor', supersedes: ['note_q'] }), answers({ change_0: noul(.05) }));
  assert.equal(m.notes[1].status, 'active');
  assert.equal(m.notes[0].status, 'superseded');
});

test('reconciliation confirms and resolves earlier notes against the latest message', () => {
  const m = emptyMemory();
  m.notes.push(
    { id: 'note_p', kind: 'rule', text: 'Only me, no crew', quote: 'Only me, no crew', supersedes: [], origin: 'user', status: 'pending', reason: 'old', sourceMessageId: 'msg_old', createdAt: '2026-09-20T00:00:00Z' },
    { id: 'note_q', kind: 'question', text: 'Is the monitor a TV?', quote: '', supersedes: [], origin: 'ai', status: 'proposed', reason: 'old', sourceMessageId: 'msg_old', createdAt: '2026-09-20T00:00:00Z' },
  );
  const questions = memoryQuestions([], m);
  assert.ok(questions.reconcile_note_p && questions.reconcile_note_q, 'unresolved notes are revisited every turn');
  applyReview([], { reconcile_note_p: choice('established'), reconcile_note_q: choice('answered') }, m, 'msg_new', '2026-09-21T00:00:00Z');
  assert.equal(m.notes[0].status, 'active');
  assert.match(m.notes[0].reason, /Confirmed/);
  assert.equal(m.notes[1].status, 'superseded');
  assert.match(m.notes[1].reason, /Resolved/);
  const left = emptyMemory();
  left.notes.push({ id: 'note_p', kind: 'rule', text: 'Only me, no crew', quote: 'Only me, no crew', supersedes: [], origin: 'user', status: 'pending', reason: 'old', sourceMessageId: 'msg_old', createdAt: '2026-09-20T00:00:00Z' });
  applyReview([], { reconcile_note_p: choice('open') }, left, 'msg_new', '2026-09-21T00:00:00Z');
  assert.equal(left.notes[0].status, 'pending', 'open stays open without penalty');
});

test('a re-stated pending declaration is confirmed in place, not duplicated', () => {
  const m = emptyMemory();
  m.notes.push({ id: 'note_old', kind: 'rule', text: 'Communication is bidirectional', quote: 'affects the past', supersedes: [], origin: 'user', status: 'pending', reason: 'old', sourceMessageId: 'msg_1', createdAt: '2026-09-20T00:00:00Z' });
  accept(m, candidate({ id: 'note_new', text: 'Communication is bidirectional', quote: 'Communication is bidirectional' }));
  assert.equal(m.notes.length, 1);
  assert.equal(m.notes[0].id, 'note_old');
  assert.equal(m.notes[0].status, 'active');
});

test('raw JEV answers are recorded so exact failing values are visible', async () => {
  const m = emptyMemory(); accept(m);
  const deps = { ...dependencies(), reasoner: { propose: async () => ({ notes: [] }), respond: async () => ({ content: 'A checked response.' }) }, jev: async ({ state }) => {
    if (state.operation === 'pre_turn_gate') return { answers: {} };
    assert.equal(state.operation, 'output_review');
    return { model: 'raw-model', provider: 'typesafe', answers: { disposition: choice('deliver', .4), respect_0: noul(.99) }, usage: { input_tokens: 1, output_tokens: 2 } };
  } };
  const result = await runMemoryTurn(deps, makeConversation({ memory: m }), 'Continue');
  assert.equal(result.response.meta.withheld, false);
  const check = result.conversation.memory.events.find(e => e.stage === 'check' && e.status !== 'running');
  assert.equal(check.raw.model, 'raw-model');
  assert.deepEqual(check.raw.answers.disposition, choice('deliver', .4));
  const guard = result.decisions.find(d => d.id === 'MEMORY_CHECK');
  assert.deepEqual(guard.detail.answers.disposition, choice('deliver', .4));
  assert.match(guard.summary, /Passed · 1\/1 active notes passed · disposition deliver/);
});

test('same reasoner gets active memory and JEV failures, repairs once, and rechecks', async () => {
  const m = emptyMemory(); accept(m);
  const original = makeConversation({ memory: m });
  const seen = [];
  let attempts = 0;
  const deps = { ...dependencies(), reasoner: {
    propose: async input => { seen.push(input); return { notes: [] }; },
    respond: async input => { seen.push(input); return { content: attempts === 0 ? 'Ask a friend to hold the camera.' : 'Use a fixed, self-operated camera.' }; },
  }, jev: async ({ state }) => {
    if (state.operation === 'pre_turn_gate') return { answers: {} };
    assert.equal(state.notes[0].id, 'note_1');
    attempts++;
    return { answers: { disposition: choice(attempts === 1 ? 'revise' : 'deliver'), respect_0: noul(attempts === 1 ? .01 : .99) } };
  } };
  const result = await runMemoryTurn(deps, original, 'How should I film this?');
  assert.equal(attempts, 2);
  assert.match(result.response.content, /self-operated/);
  assert.ok(seen.every(input => input.memory.notes.some(n => n.id === 'note_1')));
  assert.ok(seen[2].repair.checks.some(c => c.verdict === 'conflict'));
  assert.ok(!JSON.stringify(result).includes('Ask a friend'), 'unapproved draft never persisted');
});

test('repeated conflicts withhold the draft; no silent rule removal', async () => {
  const m = emptyMemory(); accept(m);
  const deps = { ...dependencies(), reasoner: { propose: async () => ({ notes: [] }), respond: async () => ({ content: 'Unsafe conflicting draft' }) }, jev: async () => ({ answers: {} }) };
  const result = await runMemoryTurn(deps, makeConversation({ memory: m }), 'Continue');
  assert.equal(result.response.meta.withheld, true);
  assert.ok(!JSON.stringify(result).includes('Unsafe conflicting draft'));
  assert.equal(result.conversation.memory.notes[0].status, 'active');
});

test('provider failures do not mutate the original conversation', async () => {
  const original = makeConversation();
  const before = JSON.stringify(original);
  const deps = { ...dependencies(), jev: async () => { throw new Error('JEV unavailable'); } };
  await assert.rejects(runMemoryTurn(deps, original, 'Only me, no crew'), /unavailable/);
  assert.equal(JSON.stringify(original), before);
});

test('memory survives normalization and file-store reloads, including concurrent project writes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forge-memory-'));
  try {
    const store = new FileStore(join(dir, 'projects.json')); await store.init();
    const result = await runMemoryTurn(dependencies(), makeConversation(), 'Make a film. Only me, no crew.');
    assert.deepEqual(normalizeConversation(JSON.parse(JSON.stringify(result.conversation))).memory, result.conversation.memory);
    await Promise.all([store.createConversation(result.conversation), store.createConversation(makeConversation({ title: 'Other' }))]);
    const reopened = new FileStore(join(dir, 'projects.json')); await reopened.init();
    assert.equal((await reopened.listConversations()).length, 2);
    assert.deepEqual((await reopened.getConversation(result.conversation.id)).memory, result.conversation.memory);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('old conversations receive an empty memory without losing project data', () => {
  const old = { ...makeConversation(), memory: undefined };
  assert.deepEqual(normalizeConversation(old).memory, emptyMemory());
});

test('failed file commit cannot publish new rules and reads do not expose mutable store objects', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forge-atomic-'));
  try {
    const store = new FileStore(join(dir, 'projects.json')); await store.init();
    const original = makeConversation({ title: 'Original' }); await store.createConversation(original);
    const edited = await store.getConversation(original.id);
    edited.title = 'Unsaved';
    assert.equal((await store.getConversation(original.id)).title, 'Original');
    const originalPath = store.file;
    store.file = dir; // rename a file over a directory must fail on every platform
    await assert.rejects(store.saveConversation(edited));
    assert.equal((await store.getConversation(original.id)).title, 'Original');
    store.file = originalPath;
    await store.saveConversation(edited); // failed queue entries do not poison later writes
    assert.equal((await store.getConversation(original.id)).title, 'Unsaved');
  } finally { await rm(dir, { recursive: true, force: true }); await rm(dir + '.tmp', { force: true }); }
});
