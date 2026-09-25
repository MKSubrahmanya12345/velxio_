import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig } from '../src/config.js';
import { createProviderRegistry } from '../src/providers/registry.js';
import { buildRequest, extractText, isMantleModel } from '../src/providers/catalog.js';
import { callProviderEntry, runWithFailover } from '../src/providers/failover.js';
import { createReasoner } from '../src/memory/reasoner.js';
import { createPlanner } from '../src/providers/planner.js';

// Kimi/Moonshot ids are served only by the Bedrock Mantle gateway; native
// Converse answers HTTP 400 "Operation not allowed" for them.
const AWS = { AWS_REGION: 'us-east-1', AWS_ACCESS_KEY_ID: 'AKIATEST', AWS_SECRET_ACCESS_KEY: 'secret' };
const kimi = { provider: 'bedrock', apiKey: 'AKIATEST', secret: 'secret', region: 'us-east-1', model: 'moonshotai.kimi-k2.5', baseUrl: '' };
const mantleReply = text => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }] }), { status: 200 });

async function envRegistry(t, env) {
  const dir = await mkdtemp(join(tmpdir(), 'forge-mantle-'));
  const cfg = loadConfig({ ...env, PROVIDERS_FILE: join(dir, 'providers.json') });
  t.after(() => rm(dir, { recursive: true, force: true }));
  return createProviderRegistry(cfg);
}

test('kimi/moonshot ids are Mantle models; Converse-served ids are not', () => {
  for (const id of ['moonshotai.kimi-k2.5', 'MoonshotAI.Kimi-K2.5', 'moonshot.kimi-k2-thinking', 'us.moonshotai.kimi-k2.5:0']) assert.ok(isMantleModel(id), id);
  for (const id of ['anthropic.claude-sonnet-4-5', 'amazon.nova-pro-v1:0', '']) assert.ok(!isMantleModel(id), id);
});

test('a Kimi Bedrock entry is sent to the Mantle chat-completions gateway, signed for bedrock-mantle', () => {
  const r = buildRequest(kimi, { system: 'S', user: 'U', temperature: 0.2, maxTokens: 512 });
  assert.equal(r.url, 'https://bedrock-mantle.us-east-1.api.aws/v1/chat/completions');
  assert.match(r.headers.Authorization, /^AWS4-HMAC-SHA256 Credential=AKIATEST\/\d{8}\/us-east-1\/bedrock-mantle\/aws4_request/);
  assert.equal(r.headers.host, 'bedrock-mantle.us-east-1.api.aws');
  const body = JSON.parse(r.body);
  assert.equal(body.model, 'moonshotai.kimi-k2.5');
  assert.equal(body.max_tokens, 512);
  assert.deepEqual(body.messages, [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }]);

  // A bedrock-runtime / LocalStack override is not a Mantle base; an explicit Mantle base is honoured.
  assert.match(buildRequest({ ...kimi, baseUrl: 'http://localhost:4566' }, { system: 'S', user: 'U' }).url, /^https:\/\/bedrock-mantle\.us-east-1\.api\.aws\/v1\//);
  assert.equal(buildRequest({ ...kimi, baseUrl: 'https://bedrock-mantle.eu-west-1.api.aws/v1' }, { system: 'S', user: 'U' }).url, 'https://bedrock-mantle.eu-west-1.api.aws/v1/chat/completions');

  // Converse-served models keep the native Converse path and signing scope.
  const c = buildRequest({ ...kimi, model: 'anthropic.claude-sonnet-4-5' }, { system: 'S', user: 'U' });
  assert.match(c.url, /bedrock-runtime\.us-east-1\.amazonaws\.com\/model\/anthropic\.claude-sonnet-4-5\/converse$/);
  assert.match(c.headers.Authorization, /\/us-east-1\/bedrock\/aws4_request/);
});

test('Mantle replies are read as chat completions (reasoning prefix dropped)', () => {
  assert.equal(extractText(kimi, { choices: [{ message: { content: '{"ok":true}' } }] }), '{"ok":true}');
  assert.equal(extractText(kimi, { choices: [{ message: { content: '<think>plan</think>\n{"ok":true}' } }] }), '{"ok":true}');
  assert.throws(() => extractText(kimi, { choices: [{ message: { content: '' } }] }), /Mantle\) returned no text/);
});

test('the .env Bedrock entry with BEDROCK_MODEL=moonshotai.kimi-k2.5 generates through Mantle', async t => {
  const registry = await envRegistry(t, { ...AWS, BEDROCK_MODEL: 'moonshotai.kimi-k2.5' });
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url: String(url), options });
    return mantleReply('{"parts":[]}');
  });
  const { result, entry } = await runWithFailover({ registry, work: e => callProviderEntry(e, { system: 'S', user: 'U' }) });
  assert.equal(entry.id, 'env:bedrock');
  assert.equal(result, '{"parts":[]}');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://bedrock-mantle.us-east-1.api.aws/v1/chat/completions');
  assert.ok(!calls.some(c => c.url.includes('/converse')), 'never touches Converse for a Kimi id');
});

test('the legacy .env-only paths (reasoner + planner) route Kimi through Mantle too', async t => {
  const cfg = loadConfig({ ...AWS, PLANNER_PROVIDER: 'bedrock', BEDROCK_MODEL: 'moonshotai.kimi-k2.5' });
  const urls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    urls.push(String(url));
    return mantleReply(urls.length === 1 ? '{"content":"A response"}' : '{"phases":[],"bom":[],"acceptance":[]}');
  });
  assert.equal((await createReasoner(cfg).respond({ memory: { notes: [] } })).content, 'A response');
  assert.deepEqual(await createPlanner(cfg)('goal', {}, {}), { phases: [], bom: [], acceptance: [] });
  assert.deepEqual(urls, Array(2).fill('https://bedrock-mantle.us-east-1.api.aws/v1/chat/completions'));
});

test('Bedrock 400 "Operation not allowed" is a rejection: tried once, not for all 10 rounds', async t => {
  const registry = await envRegistry(t, { ...AWS, BEDROCK_MODEL: 'some.converse-refused-model', GROQ_API_KEY: 'gsk_test', GROQ_MODEL: 'openai/gpt-oss-120b' });
  const calls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    calls.push(String(url));
    return String(url).includes('amazonaws.com')
      ? new Response('{"message":"Operation not allowed"}', { status: 400 })
      : new Response('busy', { status: 503 });
  });
  const error = await runWithFailover({ registry, work: e => callProviderEntry(e, { system: 'S', user: 'U' }) }).then(() => null, e => e);
  assert.ok(error?.allProvidersFailed);
  assert.equal(calls.filter(u => u.includes('amazonaws.com')).length, 1, 'Bedrock refusal is not re-paid every round');
  assert.equal(calls.filter(u => u.includes('groq')).length, 2, 'the other provider still gets its full budget');
  assert.equal(error.attempts.find(a => a.keyId === 'env:bedrock').permanent, true);
});
