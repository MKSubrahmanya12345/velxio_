import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig } from '../src/config.js';
import { createProviderRegistry } from '../src/providers/registry.js';
import { buildRequest, describeCatalog } from '../src/providers/catalog.js';
import { callProviderEntry, runWithFailover, testProviderEntry } from '../src/providers/failover.js';
import { createReasoner } from '../src/memory/reasoner.js';
import { runMemoryTurn } from '../src/memory/turn.js';
import { createRouter } from '../src/routes.js';
import { makeConversation } from '../src/schema.js';
import { FileStore } from '../src/store.js';
import { createJevMock } from './fixtures/jevMock.js';

// Explicit env objects only — never process.env — so a local forge/server/.env
// cannot change what these tests assert.
async function makeRegistry(t, { env = {}, failover } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'forge-providers-'));
  const cfg = loadConfig({ PROVIDERS_FILE: join(dir, 'providers.json'), ...env });
  cfg.providers.dataFile = join(dir, 'providers.json');
  if (failover) Object.assign(cfg.providers.failover, failover);
  const registry = await createProviderRegistry(cfg);
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { registry, cfg, dir, file: cfg.providers.dataFile };
}

const gemini = (note, extra = {}) => ({ provider: 'gemini', apiKey: `AIza-${note}`, note, model: 'gemini-2.5-flash', ...extra });
const openrouter = (note, extra = {}) => ({ provider: 'openrouter', apiKey: `sk-or-${note}`, note, model: 'openai/gpt-4o-mini', ...extra });

// A fetch stub that answers per provider, so a switch is observable.
//
// node:test restores a mocked property once per test, so mocking global fetch a
// second time inside the same test would leave a stub behind for later tests.
// One mock per test, with a swappable handler and a shared call log.
const fetchStubs = new WeakMap();
function stubFetch(t, handler) {
  const existing = fetchStubs.get(t);
  if (existing) { existing.handler = handler; return existing.calls; }
  const stub = { handler, calls: [] };
  fetchStubs.set(t, stub);
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    stub.calls.push({ url: String(url), options });
    return stub.handler(String(url), options, stub.calls.length);
  });
  return stub.calls;
}

const openAiReply = text => new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status: 200 });
const geminiReply = text => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200 });

// ── Catalog request shapes ───────────────────────────────────────────────────
test('each supported provider gets its own native request shape', () => {
  const catalog = describeCatalog().map(c => c.id);
  assert.deepEqual(catalog, ['gemini', 'openrouter', 'bedrock', 'ollama', 'openai']);

  const g = buildRequest({ provider: 'gemini', apiKey: 'AIza-x', model: 'gemini-2.5-flash', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' }, { system: 'S', user: 'U' });
  assert.match(g.url, /\/models\/gemini-2\.5-flash:generateContent$/);
  assert.equal(g.headers['x-goog-api-key'], 'AIza-x');
  assert.equal(JSON.parse(g.body).systemInstruction.parts[0].text, 'S');

  const o = buildRequest({ provider: 'openrouter', apiKey: 'sk-or-x', model: 'openai/gpt-4o-mini', baseUrl: 'https://openrouter.ai/api/v1' }, { system: 'S', user: 'U' });
  assert.match(o.url, /openrouter\.ai\/api\/v1\/chat\/completions$/);
  assert.equal(o.headers.Authorization, 'Bearer sk-or-x');
  assert.equal(JSON.parse(o.body).model, 'openai/gpt-4o-mini');

  const b = buildRequest({ provider: 'bedrock', apiKey: 'AKIA', secret: 'sec', region: 'us-east-1', model: 'anthropic.claude-sonnet-4-5', baseUrl: '' }, { system: 'S', user: 'U' });
  assert.match(b.url, /bedrock-runtime\.us-east-1\.amazonaws\.com\/model\/anthropic\.claude-sonnet-4-5\/converse$/);
  assert.match(b.headers.Authorization, /^AWS4-HMAC-SHA256/);

  const l = buildRequest({ provider: 'ollama', apiKey: '', model: 'llama3.2', baseUrl: 'http://localhost:11434' }, { system: 'S', user: 'U' });
  assert.match(l.url, /localhost:11434\/api\/chat$/);
  assert.equal(JSON.parse(l.body).stream, false);
  assert.equal(JSON.parse(l.body).messages[0].role, 'system');
});

// ── Registry: keys, notes, selection ─────────────────────────────────────────
test('a key is stored exactly as typed — plain text, with its note', async t => {
  const { registry, file } = await makeRegistry(t);
  const entry = await registry.add(gemini('main key'));
  assert.equal(entry.apiKey, 'AIza-main key');
  assert.equal(entry.note, 'main key');
  assert.equal(entry.provider, 'gemini');
  assert.equal(registry.activeId, entry.id, 'the first credential becomes the selected one');

  const persisted = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(persisted.keys[0].apiKey, 'AIza-main key');
  assert.equal(persisted.keys[0].note, 'main key');

  // Keys survive a reload without being re-masked or dropped.
  const reloaded = await createProviderRegistry({ providers: { dataFile: file, envDefaults: {} } });
  assert.equal(reloaded.get(entry.id).apiKey, 'AIza-main key');
  assert.equal(reloaded.activeId, entry.id);
});

test('credential requirements are validated per provider', async t => {
  const { registry } = await makeRegistry(t);
  await assert.rejects(() => registry.add({ provider: 'gemini', note: 'no key' }), /Gemini API key is required/);
  await assert.rejects(() => registry.add({ provider: 'bedrock', apiKey: 'AKIA', note: 'no secret' }), /secret access key is required/);
  await assert.rejects(() => registry.add({ provider: 'bedrock', apiKey: 'AKIA', secret: 'sec', note: 'no region' }), /region is required/);
  await assert.rejects(() => registry.add({ provider: 'claude', apiKey: 'x' }), /Unknown provider/);
  // Ollama is local: no key required.
  const local = await registry.add({ provider: 'ollama', note: 'laptop', baseUrl: 'http://localhost:11434' });
  assert.equal(local.apiKey, '');
  assert.equal(local.model, 'llama3.2');
});

test('any one key can be selected and it runs first', async t => {
  const { registry } = await makeRegistry(t);
  const a = await registry.add(gemini('a'));
  const b = await registry.add(openrouter('b'));
  const c = await registry.add(gemini('c'));
  await registry.setActive(b.id);
  assert.equal(registry.activeId, b.id);
  assert.deepEqual(registry.candidates().map(k => k.id), [b.id, a.id, c.id], 'selected first, then the remaining enabled keys');

  await registry.update(a.id, { enabled: false });
  assert.deepEqual(registry.candidates().map(k => k.id), [b.id, c.id], 'disabled keys leave the loop');
  await assert.rejects(() => registry.setActive(a.id), /disabled/);

  await registry.remove(b.id);
  assert.equal(registry.activeId, c.id, 'removing the selected key promotes another one');
});

test('notes and models can be edited without touching credentials', async t => {
  const { registry } = await makeRegistry(t);
  const entry = await registry.add(gemini('first'));
  const updated = await registry.update(entry.id, { note: 'renamed note', model: 'gemini-2.5-pro' });
  assert.equal(updated.note, 'renamed note');
  assert.equal(updated.model, 'gemini-2.5-pro');
  assert.equal(updated.apiKey, 'AIza-first');
});

// ── .env credentials ─────────────────────────────────────────────────────────
test('.env credentials appear as entries and keep their secrets in .env', async t => {
  const { registry } = await makeRegistry(t, { env: { PLANNER_PROVIDER: 'llm', LLM_API_KEY: 'env-key', LLM_MODEL: 'gpt-4o', LLM_API_BASE: 'https://api.openai.com/v1' } });
  const envEntry = registry.get('env:llm');
  assert.ok(envEntry, 'the .env LLM key is listed');
  assert.equal(envEntry.origin, 'env');
  assert.equal(envEntry.apiKey, 'env-key');

  await assert.rejects(() => registry.update('env:llm', { apiKey: 'other' }), /comes from \.env/);
  const noted = await registry.update('env:llm', { note: 'shared team key', model: 'gpt-4o-mini' });
  assert.equal(noted.note, 'shared team key');
  assert.equal(noted.model, 'gpt-4o-mini');

  await registry.remove('env:llm');
  assert.equal(registry.get('env:llm'), null);
  await registry.restoreEnv();
  assert.equal(registry.get('env:llm').apiKey, 'env-key');
  assert.equal(registry.get('env:llm').note, 'shared team key', 'the note overlay survives a restore');
});

// ── Failover loop ────────────────────────────────────────────────────────────
test('any error switches to the next provider and key', async t => {
  const { registry } = await makeRegistry(t);
  const bad = await registry.add(gemini('rate limited'));
  const good = await registry.add(openrouter('backup'));
  await registry.setActive(bad.id);

  const events = [];
  const calls = stubFetch(t, url => url.includes('generativelanguage')
    ? new Response('{"error":{"message":"quota"}}', { status: 429 })
    : openAiReply('{"content":"answered"}'));

  const { result, attempts, switched, used } = await runWithFailover({
    registry,
    operation: 'respond',
    emit: e => events.push(e),
    work: async entry => JSON.parse(await callProviderEntry(entry, { system: 'S', user: 'U' })),
  });

  assert.deepEqual(result, { content: 'answered' });
  assert.equal(switched, true);
  assert.equal(used.keyId, good.id);
  assert.equal(attempts.length, 1);
  assert.equal(calls.length, 2, 'both providers were really called');
  assert.equal(registry.get(bad.id).stats.failures, 1);
  assert.equal(registry.get(bad.id).stats.lastStatus, 429);
  assert.equal(registry.get(good.id).stats.ok, 1);
  assert.ok(events.some(e => e.type === 'error' && e.status === 429));
  assert.ok(events.some(e => e.type === 'success' && e.switched));
  assert.ok(registry.log.some(entry => entry.outcome === 'error' && entry.keyId === bad.id));
});

test('the loop runs 10 rounds across every key and provider, then stops', async t => {
  const { registry } = await makeRegistry(t);
  const a = await registry.add(gemini('a'));
  const b = await registry.add(openrouter('b'));
  assert.equal(registry.failover.maxRounds, 10);

  const calls = stubFetch(t, () => new Response('boom', { status: 500 }));
  const error = await runWithFailover({ registry, work: async entry => callProviderEntry(entry, { system: 'S', user: 'U' }) })
    .then(() => null, e => e);

  assert.ok(error, 'it stops only after the round budget');
  assert.equal(error.allProvidersFailed, true);
  assert.equal(error.status, 502);
  assert.equal(calls.length, 20, '2 keys × 10 rounds');
  assert.equal(error.attempts.length, 20);
  assert.equal(error.rounds, 10);
  assert.match(error.message, /20 attempts across 10 of 10 rounds/);
  assert.match(error.message, /Gemini “a”/);
  assert.match(error.message, /OpenRouter “b”/);
  assert.match(error.message, /no project changes were saved/);
  assert.equal(registry.get(a.id).stats.consecutiveFailures, 10);
  assert.equal(registry.get(b.id).stats.failures, 10);
});

test('the round budget is configurable and auto-switch can be turned off', async t => {
  const three = await makeRegistry(t);
  await three.registry.add(gemini('a'));
  await three.registry.add(openrouter('b'));
  await three.registry.setFailover({ maxRounds: 3 });
  const calls = stubFetch(t, () => new Response('boom', { status: 503 }));
  await assert.rejects(() => runWithFailover({ registry: three.registry, work: entry => callProviderEntry(entry, { system: 'S', user: 'U' }) }), /6 attempts across 3 of 3 rounds/);
  assert.equal(calls.length, 6);

  const off = await makeRegistry(t);
  const selected = await off.registry.add(gemini('only'));
  await off.registry.add(openrouter('never'));
  await off.registry.setActive(selected.id);
  await off.registry.setFailover({ enabled: false });
  const before = calls.length;
  stubFetch(t, () => new Response('boom', { status: 500 }));
  await assert.rejects(() => runWithFailover({ registry: off.registry, work: entry => callProviderEntry(entry, { system: 'S', user: 'U' }) }), /1 attempt across 1 of 1 round/);
  assert.equal(calls.length - before, 1, 'only the selected key is called');
});

test('a rejected credential is skipped in later rounds unless retries are requested', async t => {
  const { registry } = await makeRegistry(t);
  const rejected = await registry.add(gemini('bad key'));
  const flaky = await registry.add(openrouter('flaky'));
  await registry.setActive(rejected.id);

  // One stub for both phases (mocking global fetch twice in a single test would
  // leave a mock behind): the credentials behave the same, only the policy changes.
  const calls = stubFetch(t, url => url.includes('generativelanguage')
    ? new Response('denied', { status: 401 })
    : new Response('busy', { status: 500 }));
  const work = entry => callProviderEntry(entry, { system: 'S', user: 'U' });

  const error = await runWithFailover({ registry, work }).then(() => null, e => e);
  assert.equal(calls.length, 11, '1 rejected attempt + the flaky key in all 10 rounds');
  assert.equal(error.attempts.filter(a => a.keyId === rejected.id).length, 1);
  assert.equal(error.attempts.filter(a => a.permanent).length, 1);

  await registry.setFailover({ retryRejected: true });
  const before = calls.length;
  await assert.rejects(() => runWithFailover({ registry, work }), /20 attempts across 10 of 10 rounds/);
  assert.equal(calls.length - before, 20, 'every key is retried in every round');
});

test('timeouts, network failures, and non-JSON answers all trigger a switch', async t => {
  const { registry } = await makeRegistry(t);
  const slow = await registry.add(gemini('slow'));
  const prose = await registry.add(openrouter('prose'));
  const good = await registry.add({ provider: 'ollama', note: 'local', baseUrl: 'http://localhost:11434' });
  await registry.setActive(slow.id);

  stubFetch(t, url => {
    if (url.includes('generativelanguage')) return new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' })), 5));
    if (url.includes('openrouter')) return openAiReply('Sure! Here is a long prose answer with no JSON.');
    return new Response(JSON.stringify({ message: { content: '{"content":"local answer"}' } }), { status: 200 });
  });

  const { result, used, attempts } = await runWithFailover({
    registry,
    work: async entry => JSON.parse((await callProviderEntry(entry, { system: 'S', user: 'U', timeoutMs: 20 })).replace(/^```(?:json)?\s*/i, '')),
  });
  assert.deepEqual(result, { content: 'local answer' });
  assert.equal(used.keyId, good.id);
  assert.equal(attempts.length, 2);
  assert.match(attempts[0].message, /timed out/);
  assert.match(attempts[1].message, /no JSON|Unexpected token|prose/i);
});

test('no configured provider reports the exact reason instead of guessing', async t => {
  const { registry } = await makeRegistry(t);
  const error = await runWithFailover({ registry, work: async () => 'never' }).then(() => null, e => e);
  assert.equal(error.status, 503);
  assert.equal(error.noProviders, true);
  assert.match(error.message, /No generation providers are configured/);
  assert.match(error.message, /Providers page/);
});

// ── Generation + memory pipeline wiring ──────────────────────────────────────
test('the memory pipeline keeps the same prompts across providers and switches mid-turn', async t => {
  const { registry } = await makeRegistry(t);
  const bad = await registry.add(gemini('primary'));
  const good = await registry.add(openrouter('fallback'));
  await registry.setActive(bad.id);

  const bodies = [];
  stubFetch(t, (url, options) => {
    bodies.push({ url, body: JSON.parse(options.body) });
    if (url.includes('generativelanguage')) return new Response('quota', { status: 429 });
    const system = JSON.parse(options.body).messages[0].content;
    return openAiReply(system.includes('proposer') ? '{"notes":[]}' : '{"content":"A grounded response"}');
  });

  const reasoner = createReasoner(loadConfig({}), { registry });
  const proposals = await reasoner.propose({ message: 'Only me', memory: { notes: [] }, history: [] });
  assert.deepEqual(proposals, { notes: [] });
  const response = await reasoner.respond({ message: 'Only me', memory: { notes: [] }, history: [] });
  assert.equal(response.content, 'A grounded response');

  const geminiCalls = bodies.filter(b => b.url.includes('generativelanguage'));
  const routerCalls = bodies.filter(b => b.url.includes('openrouter'));
  assert.equal(geminiCalls.length, 2, 'the selected provider is tried once per generation call');
  assert.equal(routerCalls.length, 2);
  assert.match(routerCalls[0].body.messages[0].content, /proposer/);
  assert.equal(JSON.parse(routerCalls[0].body.messages[1].content).message, 'Only me');
  assert.equal(registry.get(good.id).stats.ok, 2);
});

test('a guarded turn records the switch and saves nothing when every provider fails', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'forge-turn-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cfg = loadConfig({ PROVIDERS_FILE: join(dir, 'providers.json') });
  cfg.providers.dataFile = join(dir, 'providers.json');
  const registry = await createProviderRegistry(cfg);
  await registry.add(gemini('only key'));
  await registry.setFailover({ maxRounds: 2 });

  const store = new FileStore(join(dir, 'projects.json')); await store.init();
  const deps = { cfg, store, registry, jev: createJevMock(), counters: { jevCalls: 0 } };
  const conversation = makeConversation({ title: 'Only me' });

  stubFetch(t, () => new Response('down', { status: 503 }));
  const events = [];
  const error = await runMemoryTurn(deps, conversation, 'I want to make a horror film. Only me.', e => events.push(e)).then(() => null, e => e);

  assert.ok(error);
  assert.equal(error.allProvidersFailed, true);
  assert.ok(events.some(e => e.stage === 'provider' && e.status === 'blocked'), 'the switch is visible in the turn trace');
  assert.ok(events.some(e => e.stage === 'provider' && /Round 1 of 2 failed/.test(e.label)));
  assert.equal(conversation.messages.length, 0, 'the original conversation is untouched');
  assert.equal(conversation.memory.notes.length, 0);
});

// ── HTTP API ─────────────────────────────────────────────────────────────────
// `probe` is the fetch used by the live key test only, so the test's own HTTP
// calls to the API server keep using the real network stack.
async function apiServer(t, env = {}, probe = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'forge-provider-api-'));
  const cfg = loadConfig({ PROVIDERS_FILE: join(dir, 'providers.json'), ...env });
  cfg.providers.dataFile = join(dir, 'providers.json');
  const registry = await createProviderRegistry(cfg);
  const store = new FileStore(join(dir, 'projects.json')); await store.init();
  const app = express(); app.use(express.json());
  app.use(createRouter({ cfg, store, registry, jev: createJevMock(), counters: { jevCalls: 0 }, fetch: (url, options) => probe.fetch(url, options) }));
  // Express recognises error middleware by its 4-argument signature.
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = (method, path, body) => fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { base, send, registry, cfg, probe };
}

test('the Providers API adds, lists, selects, tests, updates, and deletes keys', async t => {
  const { send, registry, probe } = await apiServer(t);

  const health = await (await send('GET', '/api/health')).json();
  assert.equal(health.providers.planner, 'unconfigured');
  assert.equal(health.failover.configured, false);
  assert.equal(health.failover.maxRounds, 10);

  const empty = await (await send('GET', '/api/providers')).json();
  assert.deepEqual(empty.keys, []);
  assert.deepEqual(empty.catalog.map(c => c.id), ['gemini', 'openrouter', 'bedrock', 'ollama', 'openai']);

  const added = await send('POST', '/api/providers/keys', { provider: 'gemini', apiKey: 'AIza-plain', note: 'main key', model: 'gemini-2.5-flash' });
  assert.equal(added.status, 200);
  const addedBody = await added.json();
  assert.equal(addedBody.key.apiKey, 'AIza-plain', 'keys come back in plain text, never dotted');
  assert.equal(addedBody.key.note, 'main key');
  assert.equal(addedBody.state.activeId, addedBody.key.id);

  const second = await (await send('POST', '/api/providers/keys', { provider: 'openrouter', apiKey: 'sk-or-plain', note: 'backup' })).json();
  const select = await (await send('POST', '/api/providers/active', { id: second.key.id })).json();
  assert.equal(select.activeId, second.key.id);
  assert.deepEqual(select.state.order.map(o => o.id), [second.key.id, addedBody.key.id]);

  // A live probe of one key: no failover, result reported with latency.
  probe.fetch = () => openAiReply('{"ok":true}');
  const tested = await (await send('POST', `/api/providers/keys/${second.key.id}/test`, {})).json();
  assert.equal(tested.ok, true);
  assert.equal(typeof tested.latencyMs, 'number');
  assert.equal(registry.get(second.key.id).stats.ok, 1);

  const noted = await (await send('PATCH', `/api/providers/keys/${second.key.id}`, { note: 'renamed' })).json();
  assert.equal(noted.key.note, 'renamed');

  const policy = await (await send('PATCH', '/api/providers/failover', { maxRounds: 4, retryRejected: true })).json();
  assert.deepEqual(policy.failover, { enabled: true, maxRounds: 4, retryRejected: true });
  const badPolicy = await send('PATCH', '/api/providers/failover', { maxRounds: 0 });
  assert.equal(badPolicy.status, 400);

  const removed = await (await send('DELETE', `/api/providers/keys/${second.key.id}`)).json();
  assert.equal(removed.ok, true);
  assert.equal(removed.state.activeId, addedBody.key.id);

  const missing = await send('PATCH', '/api/providers/keys/nope', { note: 'x' });
  assert.equal(missing.status, 404);
  const invalid = await send('POST', '/api/providers/keys', { provider: 'gemini', note: 'no key' });
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /Gemini API key is required/);

  const afterHealth = await (await send('GET', '/api/health')).json();
  assert.equal(afterHealth.providers.planner, 'gemini');
  assert.equal(afterHealth.activeProvider.note, 'main key');
  assert.equal(afterHealth.failover.configured, true);
});

test('.env keys are served through the API, protected, and restorable', async t => {
  const { send } = await apiServer(t, { PLANNER_PROVIDER: 'llm', LLM_API_KEY: 'env-key', LLM_MODEL: 'gpt-4o', AWS_REGION: 'us-east-1', AWS_ACCESS_KEY_ID: 'AKIA', AWS_SECRET_ACCESS_KEY: 'sec', BEDROCK_MODEL: 'anthropic.claude-sonnet-4-5' });
  const state = await (await send('GET', '/api/providers')).json();
  assert.deepEqual(state.keys.map(k => k.id).sort(), ['env:bedrock', 'env:llm']);
  assert.equal(state.env.llm, true);
  assert.equal(state.env.bedrock, true);

  const denied = await send('PATCH', '/api/providers/keys/env:llm', { apiKey: 'other' });
  assert.equal(denied.status, 400);
  assert.match((await denied.json()).error, /comes from \.env/);

  const noted = await (await send('PATCH', '/api/providers/keys/env:llm', { note: 'team key' })).json();
  assert.equal(noted.key.note, 'team key');
  assert.equal(noted.key.apiKey, 'env-key');

  await send('DELETE', '/api/providers/keys/env:llm');
  const restored = await (await send('POST', '/api/providers/restore-env', {})).json();
  assert.ok(restored.state.keys.some(k => k.id === 'env:llm'));
});
