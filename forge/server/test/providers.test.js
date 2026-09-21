import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { createReasoner } from '../src/memory/reasoner.js';
import { createJevProvider } from '../src/providers/jev.js';

// Request-shape tests, not claims that paid providers have been exercised.
test('one configured LLM handles proposals, generation, and repair with project memory', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, ...options, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ choices: [{ message: { content: requests.length === 1 ? '{"notes":[]}' : '{"content":"A grounded response"}' } }] }), { status: 200 });
  });
  const reasoner = createReasoner(loadConfig({ PLANNER_PROVIDER: 'llm', LLM_API_KEY: 'test', LLM_MODEL: 'configured-model' }));
  const context = { message: 'Make a film', memory: { notes: [{ id: 'note_1', text: 'Only me' }] }, history: [] };
  await reasoner.propose(context);
  await reasoner.respond(context);
  await reasoner.respond({ ...context, repair: { checks: [{ noteId: 'note_1', verdict: 'conflict' }] } });
  assert.equal(requests.length, 3);
  assert.ok(requests.every(r => r.body.model === 'configured-model'));
  assert.ok(requests.every(r => JSON.parse(r.body.messages[1].content).memory.notes[0].text === 'Only me'));
  assert.match(requests[0].body.messages[0].content, /proposer/);
  assert.deepEqual(JSON.parse(requests[2].body.messages[1].content).repair.checks[0], { noteId: 'note_1', verdict: 'conflict' });
});

test('Bedrock uses the same memory prompts and a signed Converse request', async t => {
  let request;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    request = { url, ...options };
    return new Response(JSON.stringify({ output: { message: { content: [{ text: '{"content":"A response"}' }] } } }));
  });
  const reasoner = createReasoner(loadConfig({ PLANNER_PROVIDER: 'bedrock', AWS_REGION: 'us-east-1', AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test', BEDROCK_MODEL: 'test-model' }));
  assert.equal((await reasoner.respond({ memory: { notes: [] } })).content, 'A response');
  assert.match(request.url, /model\/test-model\/converse$/);
  assert.match(request.headers.Authorization, /^AWS4-HMAC-SHA256/);
  assert.ok(JSON.parse(request.body).system[0].text.includes('project collaborator'));
});

test('JEV receives serialized state and typed questions, not a prose-generation prompt', async t => {
  let request;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    request = { url, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ answers: { respect_0: { type: 'noul', noul: .98 } } }));
  });
  const jev = createJevProvider(loadConfig({ JEV_PROVIDER: 'typesafe', TYPESAFE_API_KEY: 'test' }));
  const result = await jev({ state: { notes: [{ text: 'Only me' }] }, questions: { respect_0: { type: 'noul', instructions: 'Does this response respect the rule?' } } });
  assert.match(request.url, /v1\/systemone$/);
  assert.equal(typeof request.body.state, 'string');
  assert.equal(request.body.questions.respect_0.type, 'noul');
  assert.equal(result.provider, 'typesafe');
});
