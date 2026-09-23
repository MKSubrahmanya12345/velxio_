// Forge — environment config + provider selection.
//
// Real providers only. There is no mock fallback: a provider that is not
// fully configured is simply absent from the registry. A turn that asks for a
// missing provider is rejected with a clear error, so a "mock" run can never
// be mistaken for a live AI run.
//
// forge/server/.env is loaded on import (real environment variables win).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadDotEnv(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1];
    if (process.env[key] !== undefined) continue; // real env wins over .env
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
loadDotEnv(path.join(serverDir, '.env'));

export function loadConfig(env = process.env) {
  const port = Number(env.PORT || 4321);

  const db = {
    kind: env.MONGODB_URI ? 'mongo' : 'file',
    mongoUri: env.MONGODB_URI || '',
    dataFile: env.DATA_FILE || './data/projects.json',
  };

  // JEV is live only when a TypeSafe API key is present. An explicit
  // JEV_PROVIDER=typesafe without the key is still refused below.
  const jev = {
    provider: env.TYPESAFE_API_KEY ? 'typesafe' : env.JEV_PROVIDER === 'typesafe' ? 'typesafe' : '',
    apiKey: env.TYPESAFE_API_KEY || '',
    model: env.TYPESAFE_MODEL || 'jev-latest',
    baseUrl: (env.TYPESAFE_BASE_URL || 'https://api.typesafe.ai').replace(/\/$/, ''),
  };

  const bedrock = {
    region: env.AWS_REGION || '',
    accessKeyId: env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY || '',
    sessionToken: env.AWS_SESSION_TOKEN || '',
    model: env.BEDROCK_MODEL || 'anthropic.claude-sonnet-4-5',
    endpoint: (env.BEDROCK_ENDPOINT || '').replace(/\/$/, ''),
  };
  const bedrockReady = Boolean(bedrock.region && bedrock.accessKeyId && bedrock.secretAccessKey);

  // Every generation provider Forge can start from, read from the environment.
  // `ready` is exactly "has the credentials/Ollama model needed to make a real
  // request" — never mocked. Ready entries are seeded into the key registry as
  // read-only `.env` keys, so an existing setup works without touching the UI.
  // Order is the failover preference when no key is selected.
  const strip = (v) => (v || '').replace(/\/$/, '');
  const generators = [
    { id: 'opencode', name: 'OpenCode Zen', type: 'llm', ready: Boolean(env.OPENCODE_API_KEY), apiKey: env.OPENCODE_API_KEY || '', model: env.OPENCODE_MODEL || 'servo', apiBase: strip(env.OPENCODE_BASE || 'https://opencode.ai/zen/v1') },
    { id: 'gemini', name: 'Google Gemini', type: 'llm', ready: Boolean(env.GEMINI_API_KEY), apiKey: env.GEMINI_API_KEY || '', model: env.GEMINI_MODEL || 'gemini-2.0-flash', apiBase: strip(env.GEMINI_BASE || 'https://generativelanguage.googleapis.com/v1beta/openai') },
    { id: 'openrouter', name: 'OpenRouter', type: 'llm', ready: Boolean(env.OPENROUTER_API_KEY), apiKey: env.OPENROUTER_API_KEY || '', model: env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct', apiBase: strip(env.OPENROUTER_BASE || 'https://openrouter.ai/api/v1') },
    { id: 'ollama', name: 'Ollama (local)', type: 'llm', ready: Boolean(env.OLLAMA_MODEL), apiKey: '', model: env.OLLAMA_MODEL || '', apiBase: strip(env.OLLAMA_BASE || 'http://localhost:11434/v1') },
    { id: 'groq', name: 'Groq', type: 'llm', ready: Boolean(env.GROQ_API_KEY), apiKey: env.GROQ_API_KEY || '', model: env.GROQ_MODEL || 'llama-3.3-70b-versatile', apiBase: strip(env.GROQ_BASE || 'https://api.groq.com/openai/v1') },
    { id: 'llm', name: 'OpenAI-compatible', type: 'llm', ready: Boolean(env.LLM_API_KEY), apiKey: env.LLM_API_KEY || '', model: env.LLM_MODEL || 'gpt-4o', apiBase: strip(env.LLM_API_BASE || 'https://api.openai.com/v1') },
    { id: 'bedrock', name: 'AWS Bedrock', type: 'bedrock', ready: bedrockReady, apiKey: '', model: bedrock.model, apiBase: bedrock.endpoint },
  ];

  // PLANNER_PROVIDER is a hint. An explicitly requested provider that is not
  // ready resolves to nothing (''), never a fallback. With no hint, the first
  // ready provider becomes the default.
  const requestedPlanner = (env.PLANNER_PROVIDER || '').toLowerCase();
  const defaultProvider = requestedPlanner
    ? generators.find((p) => p.id === requestedPlanner && p.ready)
    : generators.find((p) => p.ready);

  const planner = {
    provider: defaultProvider ? defaultProvider.id : '',
    apiKey: defaultProvider ? defaultProvider.apiKey : '',
    model: defaultProvider ? defaultProvider.model : (env.LLM_MODEL || 'gpt-4o'),
    apiBase: defaultProvider ? defaultProvider.apiBase : strip(env.LLM_API_BASE || 'https://api.openai.com/v1'),
  };

  // Provider registry (keys added on the Providers page) + failover defaults.
  // `envDefaults` seeds the registry with the .env credentials above so an
  // existing setup keeps working and stays visible/editable in the UI.
  const providers = {
    dataFile: env.PROVIDERS_FILE || './data/providers.json',
    failover: {
      enabled: !['false', '0', 'off'].includes(String(env.FAILOVER_ENABLED || '').toLowerCase()),
      maxRounds: Math.min(25, Math.max(1, Number(env.FAILOVER_MAX_ROUNDS) || 10)),
      retryRejected: ['true', '1', 'on'].includes(String(env.FAILOVER_RETRY_REJECTED || '').toLowerCase()),
    },
    envDefaults: { planner, bedrock },
  };

  // The user-authored, cross-project rule set behind the JEV pre-turn gate.
  const globalRules = {
    dataFile: env.GLOBAL_RULES_FILE || './data/global-rules.json',
  };

  return { port, db, jev, planner, bedrock, generators, providers, globalRules, corsOrigin: env.CORS_ORIGIN || '' };
}