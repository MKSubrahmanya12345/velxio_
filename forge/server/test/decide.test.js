import test from 'node:test';
import assert from 'node:assert/strict';
import { makeConversation } from '../src/schema.js';
import { runDecisionTurn } from '../src/memory/decide.js';

const choice = (value, confidence = 0.95) => ({ type: 'choice', choice: value, confidence });
const noul = value => ({ type: 'noul', noul: value });

function deps(answers, extra = {}) {
  const calls = [];
  return {
    calls,
    cfg: { jev: { apiKey: 'test-key' } },
    jev: async ({ state, questions }) => {
      calls.push({ state, questions });
      return { answers };
    },
    reasoner: {
      propose: async () => { throw new Error('generator must not run on a decision'); },
      respond: async () => { throw new Error('generator must not write the reply'); },
    },
    ...extra,
  };
}

test('a decision is one structured JEV call and does not generate a chat reply', async () => {
  const harness = deps({
    turn_mode: choice('answer'),
    rule_op: choice('none'),
    rule_target: choice('none'),
    rule_change_authorized: noul(0.1),
    new_rule: noul(0.1),
  });
  const result = await runDecisionTurn(harness, makeConversation({ title: 'blink' }), 'Blink an LED on pin 13');
  assert.equal(harness.calls.length, 1);
  assert.equal(typeof harness.calls[0].state, 'object');
  assert.equal(harness.calls[0].state.message, 'Blink an LED on pin 13');
  assert.equal(harness.calls[0].questions.new_rule.type, 'noul');
  assert.match(harness.calls[0].questions.new_rule.instructions, /`message`/);
  assert.ok(harness.calls[0].questions.new_rule.criteria.true);
  assert.equal(result.decision.clarify, false);
  assert.equal(result.decision.mode, 'answer');
  assert.equal(result.decision.question, '');
  assert.equal(result.conversation.memory.notes.length, 0);
});

test('clarify-first is a JEV mode, and the question is written by code', async () => {
  const harness = deps({
    applies_0: noul(0.96),
    turn_mode: choice('clarify_first'),
    rule_op: choice('none'),
    rule_target: choice('none'),
    rule_change_authorized: noul(0.1),
    new_rule: noul(0.99),
  }, {
    globalRules: { enabled: () => [{ id: 'g1', text: 'Never use pin 0.', kind: 'rule', enabled: true }] },
  });
  const result = await runDecisionTurn(harness, makeConversation({ title: 'blink' }), 'Drive pin 0.');
  assert.equal(result.decision.clarify, true);
  assert.match(result.decision.question, /^A decision is needed before designing/);
  assert.match(result.decision.question, /Never use pin 0/);
  assert.equal(result.conversation.memory.notes.length, 0, 'a clarify turn does not store a new rule');
  assert.equal(harness.calls[0].questions.applies_0.criteria.false.length > 0, true);
});

test('a standing constraint is stored from the user\'s words, not an LLM paraphrase', async () => {
  const harness = deps({
    turn_mode: choice('answer'),
    rule_op: choice('add'),
    rule_target: choice('none'),
    rule_change_authorized: noul(0.2),
    new_rule: noul(0.97),
  });
  const message = 'Never use pin 0 on this project.';
  const result = await runDecisionTurn(harness, makeConversation({ title: 'rules' }), message);
  const note = result.conversation.memory.notes[0];
  assert.equal(note.kind, 'rule');
  assert.equal(note.status, 'active');
  assert.equal(note.text, message);
  assert.equal(note.quote, message);
});
