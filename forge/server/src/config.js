// Forge — environment config + provider selection.
//
// Provider selection is deliberately fail-safe: asking for a real provider
// without the required credentials falls back to the mock so the loop
// always works.

export function loadConfig(env = process.env) {
  const port = Number(env.PORT || 4321);

  const db = {
    kind: env.MONGODB_URI ? 'mongo' : 'file',
    mongoUri: env.MONGODB_URI || '',
    dataFile: env.DATA_FILE || './data/projects.json',
  };

  const jev = {
    provider: env.JEV_PROVIDER === 'typesafe' && env.TYPESAFE_API_KEY ? 'typesafe' : 'mock',
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

  const planner = {
    provider:
      env.PLANNER_PROVIDER === 'bedrock' && bedrockReady
        ? 'bedrock'
        : env.PLANNER_PROVIDER === 'llm' && env.LLM_API_KEY
          ? 'llm'
          : 'mock',
    apiKey: env.LLM_API_KEY || '',
    model: env.LLM_MODEL || 'gpt-4o',
    apiBase: (env.LLM_API_BASE || 'https://api.openai.com/v1').replace(/\/$/, ''),
  };

  return { port, db, jev, planner, bedrock, corsOrigin: env.CORS_ORIGIN || '' };
}
