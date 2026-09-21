// Forge — environment config + provider selection.
//
// Real providers only. There is no mock fallback: a provider that is asked
// for but not fully configured throws at factory time (the server refuses to
// boot), so a "mock" run can never be mistaken for a live AI run.
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
  const llmReady = Boolean(env.LLM_API_KEY);

  // PLANNER_PROVIDER is a hint: a requested provider that is not fully
  // configured never falls back — it resolves to nothing and the factory throws.
  const requestedPlanner = env.PLANNER_PROVIDER || '';
  const planner = {
    provider:
      (requestedPlanner === 'bedrock' || !requestedPlanner) && bedrockReady
        ? 'bedrock'
        : (requestedPlanner === 'llm' || !requestedPlanner) && llmReady
          ? 'llm'
          : '',
    apiKey: env.LLM_API_KEY || '',
    model: env.LLM_MODEL || 'gpt-4o',
    apiBase: (env.LLM_API_BASE || 'https://api.openai.com/v1').replace(/\/$/, ''),
  };

  return { port, db, jev, planner, bedrock, corsOrigin: env.CORS_ORIGIN || '' };
}