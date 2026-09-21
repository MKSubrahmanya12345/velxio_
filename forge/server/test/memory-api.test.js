import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRouter } from '../src/routes.js';
import { loadConfig } from '../src/config.js';
import { createJevMock } from './fixtures/jevMock.js';
import { createPlannerMock } from './fixtures/plannerMock.js';
import { createDemoReasoner } from './fixtures/demo.js';
import { FileStore } from '../src/store.js';
import { createProviderRegistry } from '../src/providers/registry.js';

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'forge-api-'));
  const cfg = loadConfig({});
  const store = new FileStore(join(dir, 'projects.json')); await store.init();
  const registry = await createProviderRegistry({ ...cfg, providers: { ...cfg.providers, dataFile: join(dir, 'providers.json') } });
  const deps = { cfg, store, registry, jev: createJevMock(), planner: createPlannerMock(), reasoner: createDemoReasoner() };
  const app = express(); app.use(express.json()); app.use(createRouter(deps));
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, stream = false) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(stream ? { Accept: 'application/x-ndjson' } : {}) }, body: JSON.stringify(body) });
  return { deps, base, post };
}

test('JSON remains default; streaming events finish with a persisted memory-bearing result', async t => {
  const { base, post } = await setup(t);
  const created = await post('/api/chat', { goal: 'I want to make a horror film. Only me, no crew.' });
  assert.equal(created.status, 201);
  assert.match(created.headers.get('content-type'), /application\/json/);
  const first = await created.json();
  const id = first.conversation.id;
  const response = await post(`/api/chat/${id}/messages`, { text: 'I have a phone' }, true);
  assert.match(response.headers.get('content-type'), /application\/x-ndjson/);
  const packets = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(packets.some(p => p.type === 'progress' && p.event.stage === 'check'));
  assert.equal(packets.at(-1).type, 'result');
  const saved = await (await fetch(`${base}/api/chat/${id}`)).json();
  assert.deepEqual(saved.memory, packets.at(-1).result.conversation.memory);
  assert.equal(saved.messages.length, 4);
});

test('failed streamed turn emits an error and leaves the stored project untouched', async t => {
  const { deps, base, post } = await setup(t);
  const first = await (await post('/api/chat', { goal: 'Make a film. Only me, no crew.' })).json();
  deps.jev = async () => { throw new Error('JEV unavailable'); };
  const response = await post(`/api/chat/${first.conversation.id}/messages`, { text: 'I have a camera' }, true);
  const packets = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(packets.at(-1).type, 'error');
  assert.ok(!packets.some(p => p.type === 'result'));
  const saved = await (await fetch(`${base}/api/chat/${first.conversation.id}`)).json();
  assert.deepEqual(saved, first.conversation);
});

test('concurrent turns, delete, and legacy writes cannot overwrite an in-flight memory turn', async t => {
  const { deps, base, post } = await setup(t);
  const first = await (await post('/api/chat', { goal: 'Make a film. Only me, no crew.' })).json();
  const id = first.conversation.id;
  const proposer = deps.reasoner.propose;
  let release;
  let started;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  deps.reasoner.propose = async input => { started(); await gate; return proposer(input); };
  const pending = post(`/api/chat/${id}/messages`, { text: 'I have a phone' });
  await entered;
  try {
    assert.equal((await post(`/api/chat/${id}/messages`, { text: 'Second turn' })).status, 409);
    assert.equal((await fetch(`${base}/api/chat/${id}`, { method: 'DELETE' })).status, 409);
    assert.equal((await post(`/api/projects/${id}/messages`, { text: 'Other endpoint' })).status, 409);
  } finally { release(); }
  assert.equal((await pending).status, 200);
  assert.equal((await fetch(`${base}/api/chat/${id}`, { method: 'DELETE' })).status, 200);
});

test('invalid messages are rejected before a progress stream begins', async t => {
  const { post } = await setup(t);
  for (const goal of ['', {}, 'a'.repeat(12001)]) {
    const response = await post('/api/chat', { goal }, true);
    assert.equal(response.status, 400);
    assert.match(response.headers.get('content-type'), /application\/json/);
  }
});
