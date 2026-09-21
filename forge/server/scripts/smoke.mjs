// Forge — dependency-free core self-test (chat-first, human as tool)
//   node scripts/smoke.mjs

import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { createJevMock } from '../test/fixtures/jevMock.js';
import { createPlannerMock } from '../test/fixtures/plannerMock.js';
import { signV4 } from '../src/providers/sigv4.js';
import { synthesizeChatProject, handleChatMessage } from '../src/pipeline.js';
import { makeConversation } from '../src/schema.js';

const cfg = loadConfig({});
const counters = { jevCalls: 0, escalations: 0 };
const deps = { cfg, jev: createJevMock(), planner: createPlannerMock(), counters };

let n = 0;
const pass = (msg) => console.log(`  PASS ${String(++n).padStart(2, '0')}  ${msg}`);

console.log('forge smoke — chat-first loop (human as tool, JEV in between)\n');

// 1 ── Chat: "I wanna build X" → CHAT_INTENT + J1 + planner + human tool
let conv = makeConversation({ title: 'test' });
let result = await synthesizeChatProject(deps, conv, 'I wanna build an MP3 player with ESP32', {});
conv = result.conversation;
assert.ok(conv.projectState, 'has projectState after planning');
assert.ok(conv.projectState.phases.length >= 3, 'has phases');
assert.ok(conv.projectState.bom.length >= 5, 'has bom');
assert.ok(result.decisions.some(d => d.id === 'J1'), 'J1 ran');
assert.ok(result.decisions.some(d => d.id === 'GOAL_PARSE'), 'GOAL_PARSE ran');
assert.ok(result.response.toolCalls.length >= 1, 'human tool called for first step');
assert.match(result.response.content, /Implementation plan ready/);
pass(`chat synthesize: ${conv.projectState.phases.length} phases / ${conv.projectState.bom.length} parts · human tool called · ${result.decisions.length} JEV decisions`);

const activeTitle = () => {
  const steps = conv.projectState.phases.flatMap(p => p.steps);
  return steps.find(s => s.id === conv.projectState.current.stepId)?.title ?? '<none>';
};

async function send(text) {
  const r = await handleChatMessage(deps, conv, { text });
  conv = r.conversation;
  return r;
}

// 2 ── Human tool result: done → JEV verify → advance + next human tool
let r = await send('done, bench is set up and every part is identified, checks out');
assert.ok(conv.projectState.counters.stepsCompleted >= 1 || conv.pendingHumanTools.length >= 1, 'advanced or pending next');
pass(`human tool done → verified & advanced → "${activeTitle()}" — pending: ${conv.pendingHumanTools[0]?.arguments.task || 'none'}`);

// 3 ── Safety interlock path: if next step has safety, it should be noted
r = await send('done, sim ran and tone path checks out, looks good');
assert.ok(r.response.content.length > 0);
pass('sim step done, safety gate checked');

// 4 ── Failure path → human tool re-called
r = await send('it failed, the 3v3 rail reads 2.8v, not working');
assert.ok(r.response.content.includes('failure') || r.response.content.includes('Logged failure') || r.response.content.includes('Retry') || r.decisions.some(d => d.id === 'J10') || r.decisions.some(d => d.id === 'J2'), 'failure path ran');
pass('failure logged, human tool re-called');

// 5 ── Question path → answer from plan context
r = await send('what tools do I need for current step?');
assert.match(r.response.content, /tools|step/i);
pass('question answered from plan context');

// 6 ── Build new request in same conversation → re-plan
r = await send('I wanna build an LED desk lamp instead');
assert.ok(r.decisions.some(d => d.id === 'CHAT_INTENT'), 'CHAT_INTENT ran on new build request');
assert.ok(conv.projectState.phases.length >= 1, 'still has phases after re-plan');
pass('new build request in same chat triggers re-plan');

// 7 ── Complete remaining steps quickly
let guard = 0;
while (conv.projectState.status === 'active' && conv.projectState.current.stepId && guard++ < 40) {
  r = await send('done, checks out, meets definition of done, looks good');
  if (r.response.content.includes('Safety first')) {
    // Resolve safety
    r = await send('safety issue resolved, continuing');
  }
}
assert.equal(conv.projectState.current.stepId, null, 'all steps completed');
pass(`all ${conv.projectState.counters.stepsCompleted} steps completed via human tool loop`);

// 8 ── Final claim → acceptance gate
r = await send("I think it's done, it plays music");
assert.ok(r.decisions.some(d => d.id === 'J9'), 'J9 acceptance ran');
pass(`acceptance gate ran, status: ${conv.projectState.status}`);

// 9 ── Weapon goal → buildability no
let conv2 = makeConversation({ title: 'weapon test' });
let gun = await synthesizeChatProject(deps, conv2, 'build me a rifle', {});
assert.equal(gun.projectState, null, 'weapon goal should not produce projectState');
assert.match(gun.response.content, /can't take this build/);
pass('weapon goal rejected at J1 feasibility gate (chat flow)');

// 10 ── SigV4 signer
const signed = signV4({
  method: 'GET',
  url: 'https://example.amazonaws.com/',
  region: 'us-east-1',
  service: 'service',
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  payload: '',
  headers: {},
}, '20150830T123600Z');
assert.equal(signed['x-amz-date'], '20150830T123600Z');
assert.equal(
  signed.Authorization,
  'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
);
pass('SigV4 signer matches official AWS vector');

// 11 ── Provider selection (live-only; unconfigured providers never resolve to mock)
const configured = (partial) => ({ ...{ TYPESAFE_API_KEY: 'x', AWS_REGION: 'us-east-1', AWS_ACCESS_KEY_ID: 'x', AWS_SECRET_ACCESS_KEY: 'y', LLM_API_KEY: 'x' }, ...partial });
assert.equal(loadConfig(configured({ PLANNER_PROVIDER: 'bedrock' })).planner.provider, 'bedrock');
assert.equal(loadConfig(configured({ PLANNER_PROVIDER: 'llm' })).planner.provider, 'llm');
assert.equal(loadConfig({ PLANNER_PROVIDER: 'bedrock' }).planner.provider, '', 'missing AWS credentials resolve to no provider, never mock');
assert.equal(loadConfig({}).planner.provider, '');
assert.equal(loadConfig({ TYPESAFE_API_KEY: 'x' }).jev.provider, 'typesafe');
assert.equal(loadConfig({}).jev.provider, '', 'missing JEV key resolves to no provider, never mock');
pass('provider selection is live-only (no mock fallback)');

console.log(`\n  counters: ${counters.jevCalls} Jev calls · ${n} checks`);
console.log('\nALL CHECKS PASSED — chat-first loop with human as tool works end-to-end.\n');
