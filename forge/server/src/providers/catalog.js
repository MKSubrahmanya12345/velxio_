// Forge — provider catalog.
//
// One definition per supported generation provider: what credentials it needs,
// which request shape it speaks, and how to read text back out of a response.
// The registry stores entries; the failover runner calls buildRequest()/
// extractText() so a switch between providers is just a different entry — the
// prompts and the JSON contract upstream never change.
//
// Real providers only. Nothing here fabricates a completion.

import { signV4 } from './sigv4.js';

// `openai` is the .env-era OpenAI-compatible provider (LLM_API_KEY / LLM_API_BASE).
// It stays in the catalog so existing .env setups keep working as registry entries.
export const PROVIDER_IDS = ['gemini', 'openrouter', 'bedrock', 'ollama', 'openai', 'opencode', 'groq'];

// Legacy/config ids that mean a catalog provider. `llm` is the historical
// PLANNER_PROVIDER value for "any OpenAI-compatible endpoint".
const ALIASES = { llm: 'openai' };

export const CATALOG = {
  gemini: {
    id: 'gemini',
    label: 'Google Gemini',
    short: 'Gemini',
    kind: 'gemini',
    credentialLabel: 'Gemini API key',
    credentialPlaceholder: 'AIzaSy…',
    requiresKey: true,
    defaultModel: 'gemini-2.5-flash',
    modelPlaceholder: 'gemini-2.5-flash · gemini-2.5-pro',
    defaultBase: 'https://generativelanguage.googleapis.com/v1beta',
    baseLabel: 'API base',
    timeoutMs: 90000,
    docs: 'https://aistudio.google.com/apikey',
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    short: 'OpenRouter',
    kind: 'openai',
    credentialLabel: 'OpenRouter API key',
    credentialPlaceholder: 'sk-or-v1-…',
    requiresKey: true,
    defaultModel: 'openai/gpt-4o-mini',
    modelPlaceholder: 'openai/gpt-4o-mini · anthropic/claude-sonnet-4.5',
    defaultBase: 'https://openrouter.ai/api/v1',
    baseLabel: 'API base',
    timeoutMs: 90000,
    docs: 'https://openrouter.ai/settings/keys',
  },
  bedrock: {
    id: 'bedrock',
    label: 'AWS Bedrock',
    short: 'Bedrock',
    kind: 'bedrock',
    credentialLabel: 'AWS access key ID',
    credentialPlaceholder: 'AKIA…',
    requiresKey: true,
    extraCredentials: [
      { field: 'secret', label: 'AWS secret access key', required: true, placeholder: 'wJalrXUtnFEMI/…' },
      { field: 'sessionToken', label: 'AWS session token (optional)', required: false, placeholder: 'only for temporary credentials' },
      { field: 'region', label: 'AWS region', required: true, placeholder: 'us-east-1' },
    ],
    defaultModel: 'anthropic.claude-sonnet-4-5',
    modelPlaceholder: 'anthropic.claude-sonnet-4-5 · amazon.nova-pro-v1:0',
    defaultBase: '',
    baseLabel: 'Endpoint override (optional)',
    timeoutMs: 90000,
    docs: 'https://console.aws.amazon.com/iam/',
  },
  ollama: {
    id: 'ollama',
    label: 'Ollama (local)',
    short: 'Ollama',
    kind: 'ollama',
    credentialLabel: 'API key (Ollama needs none — leave empty)',
    credentialPlaceholder: 'leave empty for a local server',
    requiresKey: false,
    defaultModel: 'llama3.2',
    modelPlaceholder: 'llama3.2 · qwen2.5:14b',
    defaultBase: 'http://localhost:11434',
    baseLabel: 'Ollama URL',
    timeoutMs: 120000,
    docs: 'https://ollama.com/blog',
  },
  openai: {
    id: 'openai',
    label: 'OpenAI-compatible (.env)',
    short: 'OpenAI-compatible',
    kind: 'openai',
    credentialLabel: 'API key',
    credentialPlaceholder: 'sk-…',
    requiresKey: true,
    defaultModel: 'gpt-4o',
    modelPlaceholder: 'gpt-4o · any model your endpoint serves',
    defaultBase: 'https://api.openai.com/v1',
    baseLabel: 'API base',
    timeoutMs: 90000,
    docs: 'https://platform.openai.com/docs/api-reference/chat',
  },
  opencode: {
    id: 'opencode',
    label: 'OpenCode Zen',
    short: 'OpenCode Zen',
    kind: 'openai',
    credentialLabel: 'OpenCode API key',
    credentialPlaceholder: 'zen_…',
    requiresKey: true,
    defaultModel: 'servo',
    modelPlaceholder: 'servo · any model your plan serves',
    defaultBase: 'https://opencode.ai/zen/v1',
    baseLabel: 'API base',
    timeoutMs: 90000,
    docs: 'https://opencode.ai/docs/zen',
  },
  groq: {
    id: 'groq',
    label: 'Groq',
    short: 'Groq',
    kind: 'openai',
    credentialLabel: 'Groq API key',
    credentialPlaceholder: 'gsk_…',
    requiresKey: true,
    defaultModel: 'llama-3.3-70b-versatile',
    modelPlaceholder: 'llama-3.3-70b-versatile · openai/gpt-oss-120b',
    defaultBase: 'https://api.groq.com/openai/v1',
    baseLabel: 'API base',
    timeoutMs: 90000,
    docs: 'https://console.groq.com/keys',
  },
};

export function providerDefinition(id) {
  const def = CATALOG[ALIASES[String(id || '').toLowerCase()] || id];
  if (!def) throw Object.assign(new Error(`Unknown provider "${id}". Supported: ${PROVIDER_IDS.join(', ')}.`), { status: 400 });
  return def;
}

// The client renders its form from this — field labels live next to the request
// shape that consumes them, so the two cannot drift apart.
export function describeCatalog() {
  return PROVIDER_IDS.map(id => {
    const def = CATALOG[id];
    return {
      id: def.id,
      label: def.label,
      short: def.short,
      credentialLabel: def.credentialLabel,
      credentialPlaceholder: def.credentialPlaceholder,
      requiresKey: def.requiresKey,
      extraCredentials: def.extraCredentials || [],
      defaultModel: def.defaultModel,
      modelPlaceholder: def.modelPlaceholder,
      defaultBase: def.defaultBase,
      baseLabel: def.baseLabel,
      docs: def.docs,
    };
  });
}

const trim = value => String(value ?? '').trim();

// Bedrock model ids contain ':' (and '/' for inference profiles/ARNs). Percent
// encoding the colon breaks some gateways, leaving it raw breaks others — encode
// the unsafe characters and keep both separators readable.
export function bedrockModelPath(model) {
  return String(model || '').split('/').map(part => encodeURIComponent(part).replace(/%3A/gi, ':')).join('/');
}

// Validate + normalize one credential set. Every failure is a 400 that names the
// exact missing field, so the UI can point at it instead of guessing.
export function validateCredentials(provider, input = {}) {
  const def = providerDefinition(provider);
  const apiKey = trim(input.apiKey);
  const secret = trim(input.secret);
  const sessionToken = trim(input.sessionToken);
  const region = trim(input.region);
  const baseUrl = trim(input.baseUrl).replace(/\/+$/, '');
  const model = trim(input.model);

  if (def.requiresKey && !apiKey) {
    throw Object.assign(new Error(`${def.label}: ${def.credentialLabel} is required.`), { status: 400 });
  }
  if (def.id === 'bedrock') {
    if (!secret) throw Object.assign(new Error('AWS Bedrock: secret access key is required.'), { status: 400 });
    if (!region) throw Object.assign(new Error('AWS Bedrock: region is required (e.g. us-east-1).'), { status: 400 });
  }
  if (def.id === 'ollama' && !baseUrl && !def.defaultBase) {
    throw Object.assign(new Error('Ollama: a server URL is required.'), { status: 400 });
  }
  if (apiKey.length > 2000 || secret.length > 2000 || sessionToken.length > 4000) {
    throw Object.assign(new Error('Credential values look too long to be real keys (max 2,000 characters).'), { status: 400 });
  }

  return {
    apiKey,
    secret,
    sessionToken,
    region: def.id === 'bedrock' ? region : '',
    baseUrl: baseUrl || def.defaultBase || '',
    model: model || def.defaultModel,
  };
}

export function baseFor(entry) {
  return (trim(entry.baseUrl) || CATALOG[entry.provider]?.defaultBase || '').replace(/\/+$/, '');
}

// ── Request shapes ────────────────────────────────────────────────────────────
// One JSON generation call: system prompt + a single user message holding the
// JSON payload. Each provider gets its native shape; callers stay provider-free.
export function buildRequest(entry, { system, user, temperature = 0.2, maxTokens = 8192 } = {}) {
  const def = providerDefinition(entry.provider);
  const model = trim(entry.model) || def.defaultModel;
  const base = baseFor(entry);

  if (def.kind === 'gemini') {
    return {
      url: `${base}/models/${encodeURIComponent(model)}:generateContent`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': entry.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { temperature, maxOutputTokens: maxTokens, responseMimeType: 'application/json' },
      }),
      timeoutMs: def.timeoutMs,
    };
  }

  if (def.kind === 'ollama') {
    return {
      url: `${base}/api/chat`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(entry.apiKey ? { Authorization: `Bearer ${entry.apiKey}` } : {}) },
      body: JSON.stringify({
        model,
        stream: false,
        format: 'json',
        options: { temperature },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
      timeoutMs: def.timeoutMs,
    };
  }

  if (def.kind === 'bedrock') {
    const url = `${base || `https://bedrock-runtime.${entry.region}.amazonaws.com`}/model/${bedrockModelPath(model)}/converse`;
    const body = JSON.stringify({
      system: [{ text: system }],
      messages: [{ role: 'user', content: [{ text: user }] }],
      inferenceConfig: { maxTokens, temperature },
    });
    return {
      url,
      method: 'POST',
      headers: signV4({
        method: 'POST',
        url,
        region: entry.region,
        service: 'bedrock',
        accessKeyId: entry.apiKey,
        secretAccessKey: entry.secret,
        sessionToken: entry.sessionToken || undefined,
        payload: body,
        headers: { 'content-type': 'application/json' },
      }),
      body,
      timeoutMs: def.timeoutMs,
    };
  }

  // OpenAI-compatible: OpenRouter and any /chat/completions endpoint.
  return {
    url: `${base}/chat/completions`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${entry.apiKey}` },
    body: JSON.stringify({
      model,
      temperature,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }),
    timeoutMs: def.timeoutMs,
  };
}

// Pull generated text out of a provider response. Missing shapes fail loudly —
// an empty string here would look like a valid model answer downstream.
export function extractText(entry, data) {
  const def = providerDefinition(entry.provider);
  const label = def.short;

  if (def.kind === 'gemini') {
    const parts = data?.candidates?.[0]?.content?.parts;
    const text = Array.isArray(parts) ? parts.map(p => p?.text ?? '').join('') : '';
    if (!text.trim()) {
      const blocked = data?.promptFeedback?.blockReason || data?.candidates?.[0]?.finishReason;
      throw new Error(`${label} returned no text${blocked ? ` (${blocked})` : ''}.`);
    }
    return text;
  }

  if (def.kind === 'ollama') {
    const text = String(data?.message?.content ?? '');
    if (!text.trim()) throw new Error(`${label} returned no text${data?.error ? `: ${data.error}` : ''}.`);
    return text;
  }

  if (def.kind === 'bedrock') {
    const content = data?.output?.message?.content;
    const text = Array.isArray(content) ? content.filter(c => c?.text).map(c => c.text).join('\n') : '';
    if (!text.trim()) throw new Error(`${label} returned no text${data?.message ? `: ${data.message}` : ''}.`);
    return text;
  }

  const text = String(data?.choices?.[0]?.message?.content ?? '');
  if (!text.trim()) throw new Error(`${label} returned no text.`);
  return text;
}

// Credentials that will never work again (bad key, denied, no such model/region).
// The failover loop can stop re-paying for these while it keeps looping the rest.
export function isPermanentStatus(status) {
  return status === 401 || status === 403 || status === 404;
}

// ── .env entries ──────────────────────────────────────────────────────────────
// Existing .env credentials become registry entries with stable ids so an
// upgrade keeps working and the UI can show what came from the environment.
export function envEntries(cfg) {
  const entries = [];
  const generators = Array.isArray(cfg?.generators) ? cfg.generators : [];

  // One entry per ready .env provider. Any credential already in the
  // environment takes part in the same failover loop as UI-added keys.
  for (const g of generators) {
    if (!g?.ready) continue;
    const provider = resolveProviderId(g.id);
    if (!provider) continue;
    const def = CATALOG[provider];
    entries.push({
      id: `env:${g.id}`,
      provider,
      note: `From .env (${envVarFor(g.id)})`,
      apiKey: g.apiKey || '',
      secret: '',
      sessionToken: '',
      region: provider === 'bedrock' ? String(cfg?.bedrock?.region || '') : '',
      baseUrl: nativeBase(provider, trim(g.apiBase) || def.defaultBase),
      model: trim(g.model) || def.defaultModel,
      origin: 'env',
    });
  }

  // AWS credentials need the secret material, which only cfg.bedrock carries.
  const b = cfg?.bedrock;
  if (b?.region && b?.accessKeyId && b?.secretAccessKey) {
    const entry = entries.find(e => e.id === 'env:bedrock');
    const credentials = {
      apiKey: b.accessKeyId,
      secret: b.secretAccessKey,
      sessionToken: b.sessionToken || '',
      region: b.region,
      baseUrl: trim(b.endpoint),
      model: b.model || CATALOG.bedrock.defaultModel,
    };
    if (entry) Object.assign(entry, credentials);
    else entries.push({ id: 'env:bedrock', provider: 'bedrock', note: 'From .env (AWS credentials)', origin: 'env', ...credentials });
  }
  return entries;
}

// `.env` bases are written for the OpenAI-compatible path (…/v1, …/v1beta/openai).
// Registry entries speak each provider's native API, so strip the compatibility
// prefix for the two providers that have their own request shape.
function nativeBase(provider, base) {
  const def = CATALOG[provider];
  if (!def) return base;
  if (def.kind === 'ollama') return base.replace(/\/v1\/?$/, '') || def.defaultBase;
  if (def.kind === 'gemini') return base.replace(/\/openai\/?$/, '') || def.defaultBase;
  return base;
}

// Canonical catalog id for a provider name, or null when unknown. `llm` (the
// historical PLANNER_PROVIDER value) resolves to the OpenAI-compatible entry.
export function resolveProviderId(id) {
  const resolved = ALIASES[String(id || '').toLowerCase()] || id;
  return CATALOG[resolved] ? resolved : null;
}

function envVarFor(id) {
  return ({
    opencode: 'OPENCODE_API_KEY',
    gemini: 'GEMINI_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
    ollama: 'OLLAMA_MODEL',
    groq: 'GROQ_API_KEY',
    llm: 'LLM_API_KEY',
    bedrock: 'AWS credentials',
  })[id] || `${String(id).toUpperCase()}_API_KEY`;
}
