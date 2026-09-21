import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createJevProvider } from '../src/providers/jev.js';
import { createPlanner } from '../src/providers/planner.js';
import { makeConversation, normalizeConversation } from '../src/schema.js';
import { runMemoryTurn } from '../src/memory/turn.js';
import { emptyMemory } from '../src/memory/model.js';
import { applyReview, evaluateOutput, memoryQuestions, outputQuestions } from '../src/memory/decisions.js';
import { FileStore } from '../src/store.js';

const cfg = loadConfig({});
const dependencies = () => ({ cfg, jev: createJevProvider(cfg), planner: createPlanner(cfg), counters: { jevCalls: 0 } });
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

test('user quotes alone cannot authorize unsupported, conflicting, or uncertain rules', () => {
  for (const result of [answers({ support_0: noul(.2) }), answers({ compatible_0: noul(.4) }), answers({ kind_0: choice('rule', .6) }), {}, answers({ kind_0: choice('made_up') }), answers({ support_0: { type: 'noul', noul: '1' } })]) {
    const m = emptyMemory(); accept(m, candidate(), result);
    assert.equal(m.notes[0].status, 'pending');
  }
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
  assert.equal(Object.keys(memoryQuestions(notes)).length, 8);
  assert.match(outputQuestions(notes).respect_1.instructions, /No paid tools/);
  for (const result of [{}, { disposition: choice('deliver'), respect_0: noul(1) }, { disposition: choice('deliver'), respect_0: noul(2), respect_1: noul(1) }]) assert.equal(evaluateOutput(notes, result).passed, false);
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
