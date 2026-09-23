import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGlobalRuleStore, normalizeGlobalRule, GLOBAL_RULE_KINDS } from '../src/memory/globalRules.js';
import {
  gateCandidates, preTurnQuestions, applyPreTurn, directivePrompt, directiveCheckNotes,
} from '../src/memory/preturn.js';

// ── store ───────────────────────────────────────────────────────────────────

async function tempStore() {
  const dir = await mkdtemp(join(tmpdir(), 'forge-grules-'));
  const cfg = { globalRules: { dataFile: join(dir, 'rules', 'global-rules.json') } };
  const store = createGlobalRuleStore(cfg);
  return { dir, store, file: join(dir, 'rules', 'global-rules.json') };
}

test('global rules: add, list, update, disable, remove with atomic persistence', async () => {
  const { dir, store, file } = await tempStore();
  try {
    assert.equal(store.list().length, 0);

    const rule = await store.add({ text: '  Never spend more than ₹500 per build.  ', kind: 'rule', note: 'budget' });
    assert.equal(rule.text, 'Never spend more than ₹500 per build.');
    assert.equal(rule.kind, 'rule');
    assert.equal(rule.enabled, true);
    assert.equal(store.enabledCount(), 1);

    // Exact duplicates are refused.
    await assert.rejects(() => store.add({ text: 'never spend more than ₹500 per build.' }), /already exists/);
    await assert.rejects(() => store.add({ text: '' }), /1–2000/);
    await assert.rejects(() => store.update('grule_missing', { enabled: false }), /No global rule/);

    await store.update(rule.id, { note: 'budget cap', kind: 'preference' });
    assert.equal(store.get(rule.id).kind, 'preference');

    // Disable keeps the record; enabled() drops it.
    await store.disable(rule.id, 'Removed by JEV pre-turn gate: your message explicitly authorized it.');
    assert.equal(store.enabledCount(), 0);
    assert.equal(store.get(rule.id).enabled, false);
    assert.match(store.get(rule.id).disabledBy, /authorized/);

    // Reversible.
    await store.update(rule.id, { enabled: true });
    assert.equal(store.enabledCount(), 1);

    await store.remove(rule.id);
    assert.equal(store.list().length, 0);

    // The file on disk reflects every mutation (atomic rename, pretty JSON).
    const onDisk = JSON.parse(await readFile(file, 'utf8'));
    assert.ok(Array.isArray(onDisk));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('global rules: a corrupt file throws instead of being reset', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forge-grules-'));
  try {
    const file = join(dir, 'global-rules.json');
    await writeFile(file, '{not json');
    const store = createGlobalRuleStore({ globalRules: { dataFile: file } });
    assert.throws(() => store.list(), /unreadable/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('normalizeGlobalRule: unknown kinds fall back to rule, disabled records survive', () => {
  const rule = normalizeGlobalRule({ id: 'grule_x', text: 'Only me on camera.', kind: 'banana', enabled: false, disabledAt: 't', disabledBy: 'gate' });
  assert.equal(rule.kind, 'rule');
  assert.equal(rule.enabled, false);
  assert.equal(rule.disabledBy, 'gate');
  assert.equal(normalizeGlobalRule({ id: '', text: 'x' }), null);
  assert.equal(normalizeGlobalRule(null), null);
  assert.deepEqual([...GLOBAL_RULE_KINDS].sort(), ['fact', 'goal', 'preference', 'rule']);
});

// ── gate candidates ─────────────────────────────────────────────────────────

const globalRule = (id, text, extra = {}) => ({ id, text, kind: 'rule', enabled: true, ...extra });
const chatRule = (id, text) => ({ id, text, kind: 'rule', status: 'active' });

test('gateCandidates: enabled globals first, active chat rules second, capped', () => {
  const candidates = gateCandidates(
    [globalRule('g1', 'A'), globalRule('g2', 'B', { enabled: false }), globalRule('g3', 'C')],
    [chatRule('c1', 'D'), { id: 'c2', text: 'pending', kind: 'rule', status: 'pending' }, { id: 'c3', text: 'fact', kind: 'fact', status: 'active' }],
  );
  assert.deepEqual(candidates.map(c => c.id), ['g1', 'g3', 'c1']);
  assert.equal(candidates[0].source, 'global');
  assert.equal(candidates[2].source, 'chat');
  const many = gateCandidates(Array.from({ length: 40 }, (_, i) => globalRule(`g${i}`, `r${i}`)), []);
  assert.equal(many.length, 25);
});

// ── questions ───────────────────────────────────────────────────────────────

test('preTurnQuestions: typed questions per candidate plus mode/op/target/authorize', () => {
  const candidates = gateCandidates([globalRule('g1', 'Stay under ₹500.')], [chatRule('c1', 'Only vanilla JS.')]);
  const q = preTurnQuestions(candidates, 'Build me a site for ₹100');
  assert.equal(q.applies_0.type, 'noul');
  assert.equal(q.applies_1.type, 'noul');
  assert.equal(q.applies_0.type, 'noul');
  assert.equal(q.turn_mode.type, 'choice');
  assert.ok(q.turn_mode.criteria.answer && q.turn_mode.criteria.clarify_first && q.turn_mode.criteria.out_of_scope && q.turn_mode.criteria.rule_change);
  assert.deepEqual(Object.keys(q.rule_op.criteria).sort(), ['add', 'modify', 'none', 'remove']);
  assert.ok(q.rule_target.criteria.g1.includes('global'));
  assert.ok(q.rule_target.criteria.c1.includes('chat'));
  assert.equal(q.rule_change_authorized.type, 'noul');
});

// ── applyPreTurn ────────────────────────────────────────────────────────────

const ans = noul => ({ type: 'noul', noul });
const choice = (c, confidence = 0.95) => ({ type: 'choice', choice: c, confidence });

test('applyPreTurn: applicability bands, fail-closed unknown, mode argmax', () => {
  const candidates = [globalRule('g1', 'A'), globalRule('g2', 'B'), globalRule('g3', 'C')];
  const d = applyPreTurn({
    applies_0: ans(0.97), // respected → in force
    applies_1: ans(0.1),  // clearly not governing → dropped
    applies_2: ans(null), // no usable value → KEPT in force, flagged
    turn_mode: choice('clarify_first', 0.6), // flat distribution still steers
  }, candidates);
  assert.deepEqual(d.applicableRules.map(r => r.id), ['g1', 'g3']);
  assert.equal(d.applicableRules[1].unresolved, true);
  assert.equal(d.mode, 'clarify_first');
  assert.match(d.gateSummary, /missing/);
});

test('applyPreTurn: malformed mode falls back to answer; post-check unaffected', () => {
  const d = applyPreTurn({ turn_mode: { type: 'choice', choice: 'banana', confidence: 0.9 } }, [globalRule('g1', 'A')]);
  assert.equal(d.mode, 'answer');
  assert.equal(d.modeTrusted, false);
});

test('applyPreTurn: only an explicit, named, authorized removal is autonomous', () => {
  const candidates = [globalRule('g1', 'A')];
  // Authorized removal → autonomous.
  const yes = applyPreTurn({
    rule_op: choice('remove'), rule_target: choice('g1'), rule_change_authorized: ans(0.95),
  }, candidates);
  assert.equal(yes.ruleChange.autonomous, true);
  assert.equal(yes.ruleChange.authorized, true);
  // Same removal below the authorization threshold → NOT autonomous.
  const weak = applyPreTurn({
    rule_op: choice('remove'), rule_target: choice('g1'), rule_change_authorized: ans(0.5),
  }, candidates);
  assert.equal(weak.ruleChange.autonomous, false);
  assert.equal(weak.ruleChange.authorized, false);
  // Removal with an unknown target names nothing → never autonomous.
  const ghost = applyPreTurn({
    rule_op: choice('remove'), rule_target: choice('none'), rule_change_authorized: ans(0.99),
  }, candidates);
  assert.equal(ghost.ruleChange, null);
  // Adds/modifies steer the generator but never auto-mutate the store.
  const add = applyPreTurn({ rule_op: choice('add') }, candidates);
  assert.equal(add.ruleChange.op, 'add');
  assert.equal(add.ruleChange.autonomous, undefined);
  const mod = applyPreTurn({ rule_op: choice('modify'), rule_target: choice('g1'), rule_change_authorized: ans(0.98) }, candidates);
  assert.equal(mod.ruleChange.op, 'modify');
  assert.equal(mod.ruleChange.autonomous, false);
  // No rule op at all.
  const none = applyPreTurn({ rule_op: choice('none') }, candidates);
  assert.equal(none.ruleChange, null);
});

test('applyPreTurn: empty answers produce an empty, harmless directive', () => {
  const d = applyPreTurn({}, [globalRule('g1', 'A')]);
  // Fail closed: the rule stays in force with an unresolved check.
  assert.equal(d.applicableRules.length, 1);
  assert.equal(d.mode, 'answer');
  assert.equal(d.ruleChange, null);
});

// ── directive compilation ───────────────────────────────────────────────────

test('directivePrompt: empty when nothing is in force, explicit when it is', () => {
  assert.equal(directivePrompt(null), '');
  assert.equal(directivePrompt({ applicableRules: [], mode: 'answer', ruleChange: null }), '');

  const text = directivePrompt({
    applicableRules: [{ id: 'g1', text: 'Stay under ₹500.', kind: 'rule', source: 'global', value: 0.97, unresolved: false }],
    mode: 'clarify_first',
    ruleChange: { op: 'remove', targetId: 'g9', authorized: false, autonomous: false },
  });
  assert.match(text, /TURN DIRECTIVE/);
  assert.match(text, /clarify_first/);
  assert.match(text, /Stay under ₹500\./);
  assert.match(text, /global/);
  assert.match(text, /NOT authorized/);
});

test('directiveCheckNotes: gate rules become checkable pseudo-notes', () => {
  const notes = directiveCheckNotes({
    applicableRules: [
      { id: 'g1', text: 'A', source: 'global' },
      { id: 'c1', text: 'B', source: 'chat' },
    ],
  });
  assert.deepEqual(notes.map(n => [n.id, n.kind, n.source]), [['g1', 'rule', 'global'], ['c1', 'rule', 'chat']]);
  assert.equal(directiveCheckNotes(null).length, 0);
});

// ── end-to-end shape: store feeds candidates ────────────────────────────────

test('enabled store rules flow into gate candidates', async () => {
  const { dir, store } = await tempStore();
  try {
    await mkdir(join(dir, 'rules'), { recursive: true });
    await store.add({ text: 'Respond in English only.' });
    await store.add({ text: 'Retired rule', note: '' }).then(r => store.disable(r.id, 'user'));
    const candidates = gateCandidates(store.enabled(), []);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].text, 'Respond in English only.');
    assert.equal(candidates[0].source, 'global');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
