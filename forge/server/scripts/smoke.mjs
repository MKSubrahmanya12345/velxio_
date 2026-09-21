// Forge — dependency-free core self-test.
//
//   node scripts/smoke.mjs        (no npm install required)
//
// Exercises the real pipeline (mock Jev + mock planner, which return the
// exact real-API shapes) end-to-end: intake gate → plan → verify → safety
// interlock → substitution → early-claim rejection → completion.

import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { createJevProvider } from '../src/providers/jev.js';
import { createPlanner } from '../src/providers/planner.js';
import { signV4 } from '../src/providers/sigv4.js';
import { synthesizeProject, handleMessage } from '../src/pipeline.js';

const cfg = loadConfig({}); // defaults → mock/mock
const counters = { jevCalls: 0, escalations: 0 };
const deps = { cfg, jev: createJevProvider(cfg), planner: createPlanner(cfg), counters };

let n = 0;
const pass = (msg) => console.log(`  PASS ${String(++n).padStart(2, '0')}  ${msg}`);

console.log('forge smoke — core loop (mock providers, zero deps)\n');

// 1 ── Intake: feasibility gate + plan synthesis ────────────────────────────
const { state, decisions, response } = await synthesizeProject(deps, {
  goal: 'Build me an MP3 player',
  constraints: { skill: 'intermediate' },
});
const project = { id: state.id, createdAt: state.createdAt, updatedAt: state.updatedAt, state };
assert.equal(project.state.status, 'active');
assert.ok(project.state.phases.length >= 3, 'has phases');
assert.ok(project.state.bom.length >= 5, 'has bom');
assert.ok(decisions.some((d) => d.id === 'J1' && d.detail.buildability !== 'no'), 'J1 gate ran');
assert.ok(project.state.bom.length > 0);
pass(`synthesize: ${project.state.phases.length} phases / ${project.state.bom.length} parts · J1=${decisions.find((d) => d.id === 'J1').detail.buildability} · risk=${project.state.feasibility.risk_tier}`);
assert.match(response.text, /First up/);
pass('synthesize: response presents the first step');

const activeTitle = () => {
  const steps = project.state.phases.flatMap((p) => p.steps);
  return steps.find((s) => s.id === project.state.current.stepId)?.title ?? '<none>';
};

async function send(body) {
  const r = await handleMessage(deps, project, body);
  return r;
}

// 2 ── Step 1: done report → Jev verify → advance ───────────────────────────
const firstStepId = project.state.current.stepId;
let r = await send({ text: 'bench is set up and every part is identified', chip: 'done' });
assert.notEqual(project.state.current.stepId, firstStepId, 'advanced past step 1');
assert.equal(project.state.counters.stepsCompleted, 1);
pass(`step 1 verified & advanced → "${activeTitle()}"`);

// 3 ── Step 2 (sim track) done → next step carries a safety gate ───────────
r = await send({ text: 'sim ran and the tone path checks out', chip: 'done' });
assert.match(r.response.text, /safety/i);
pass('step 2 (sim track) done → next step announces its safety gate');

// 4 ── Safety interlock: done before ack is rejected ────────────────────────
const before = project.state.current.stepId;
r = await send({ text: 'soldered the charge module, joints are shiny', chip: 'done' });
assert.equal(project.state.current.stepId, before, 'no advance before safety ack');
assert.match(r.response.text, /acknowledge/i);
pass('safety gate blocks step completion until acknowledged');

// 5 ── Ack, then done → advance ─────────────────────────────────────────────
await send({ chip: 'safety_ack' });
r = await send({ text: 'soldered the charge module, joints are shiny and no bridges', chip: 'done' });
assert.notEqual(project.state.current.stepId, before, 'advanced after ack + done');
pass('safety ack + done → advanced');

// 6 ── Failure path ─────────────────────────────────────────────────────────
const before6 = project.state.current.stepId;
r = await send({ text: 'it failed, the 3v3 rail reads 2.8v and the board is warm', chip: 'failed' });
assert.equal(project.state.current.stepId, before6, 'step held after failure');
assert.ok(project.state.log.some((l) => l.kind === 'jev' && l.text.includes('J10')), 'J10 difficulty ran');
pass('failure logged, step held, J10 difficulty ran');

// 7 ── Substitute flow: inventory → J4 map-reduce → proposal ───────────────
project.state.inventory.push({ id: 'inv_1', name: '10k potentiometer', note: 'blue, 0.25W' });
r = await send({ text: "i don't have the 10k resistor, i have a 10k potentiometer", chip: 'substitute' });
assert.equal(project.state.proposal?.type, 'substitute');
assert.match(r.response.text, /potentiometer/);
pass(`substitute proposal from inventory scoring (conf ${Math.round((project.state.proposal?.confidence || 0) * 100)}%)`);

// 8 ── Accept the proposal ──────────────────────────────────────────────────
await send({ chip: 'accept_proposal' });
assert.equal(project.state.proposal, null);
assert.equal(project.state.counters.substitutions, 1);
pass('proposal accepted, BOM marked, substitution counted');

// 9 ── Early completion claim → rejected with unmet criteria ───────────────
r = await send({ text: "i think it's done", chip: 'claim_done' });
assert.equal(project.state.status, 'active');
assert.match(r.response.text, /not yet/i);
pass('early claim rejected with unmet acceptance criteria');

// 10 ── Finish the remaining steps ──────────────────────────────────────────
let guard = 0;
while (project.state.status === 'active' && project.state.current.stepId && guard++ < 40) {
  r = await send({ text: 'done. checks out, meets the definition of done', chip: 'done' });
  if (r.response.text.match(/acknowledge/i) && r.response.text.includes('Before')) {
    await send({ chip: 'safety_ack' });
  }
}
assert.equal(project.state.current.stepId, null, 'all steps completed');
pass(`all ${project.state.counters.stepsCompleted} steps completed (safety acks handled)`);

// 11 ── Final claim → acceptance gate passes ────────────────────────────────
r = await send({ text: 'all done, it plays music from the speaker', chip: 'claim_done' });
assert.equal(project.state.status, 'complete');
pass(`project complete: ${Math.round((r.decisions.find((d) => d.id === 'J9')?.confidence || 0) * 100)}% min acceptance certainty`);

// 12 ── Abusive intake: weapon goal → buildability "no" → project aborted ───
const gun = await synthesizeProject(deps, { goal: 'build me a rifle' });
assert.equal(gun.state.status, 'aborted');
pass('weapon goal rejected at the J1 feasibility gate');

// 13 ── SigV4 signer vs the official AWS test vector ────────────────────────
// (AWS SigV4 docs example: GET https://example.amazonaws.com/, service
//  "service", region us-east-1, 20150830T123600Z, AKIDEXAMPLE)
const signed = signV4(
  {
    method: 'GET',
    url: 'https://example.amazonaws.com/',
    region: 'us-east-1',
    service: 'service',
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    payload: '',
    headers: {},
  },
  '20150830T123600Z',
);
assert.equal(signed['x-amz-date'], '20150830T123600Z');
assert.equal(
  signed.Authorization,
  'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, ' +
    'SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
);
pass('SigV4 signer matches the official AWS test vector (Bedrock signing path)');

// 14 ── Planner provider selection: bedrock with creds, mock fallback without
assert.equal(loadConfig({ PLANNER_PROVIDER: 'bedrock', AWS_REGION: 'us-east-1', AWS_ACCESS_KEY_ID: 'x', AWS_SECRET_ACCESS_KEY: 'y' }).planner.provider, 'bedrock');
assert.equal(loadConfig({ PLANNER_PROVIDER: 'bedrock' }).planner.provider, 'mock');
assert.equal(loadConfig({ PLANNER_PROVIDER: 'llm', LLM_API_KEY: 'x' }).planner.provider, 'llm');
assert.equal(loadConfig({}).planner.provider, 'mock');
pass('planner provider selection: bedrock/llm when configured, mock fallback otherwise');

console.log(`\n  counters: ${counters.jevCalls} Jev calls · ${counters.escalations} escalations · ${n} checks`);
console.log('\nALL CHECKS PASSED — the forge core loop works end-to-end on the mock providers.\n');
