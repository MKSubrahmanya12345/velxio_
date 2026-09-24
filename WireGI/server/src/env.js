// WireGI server — environment loading, with provenance.
//
// WireGI owns its own .env now (server/.env). Forge's .env is still readable as
// an optional fallback so an existing setup keeps working, but nothing depends
// on it: WireGI's own file — and the real environment — always win.
//
// Precedence (highest first):
//   1. real environment (shell / docker / CI)
//   2. WireGI/server/.env
//   3. forge/server/.env            (only when WIREGI_INHERIT_FORGE_ENV != false)
//
// IMPORTANT — import order: this module must be evaluated BEFORE any module
// that reaches into ../forge, because forge's config.js loads forge/server/.env
// on import and its loader keeps whatever is already in process.env. By
// applying WireGI's values first we win that race by construction; reassert()
// is the belt-and-braces pass for direct service imports.
//
// Every key that is applied is remembered together with WHERE it came from, so
// the boot log, /api/health and the UI's Debug tab can answer "why is this key
// not working?" without guessing. Secrets are never printed — only a mask.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WIREGI_DIR = path.resolve(SERVER_DIR, '..');
export const REPO_DIR = path.resolve(WIREGI_DIR, '..');

export const WIREGI_ENV_FILE = process.env.WIREGI_ENV_FILE
  ? path.resolve(process.env.WIREGI_ENV_FILE)
  : path.join(SERVER_DIR, '.env');
export const FORGE_ENV_FILE = process.env.WIREGI_FORGE_ENV_FILE
  ? path.resolve(process.env.WIREGI_FORGE_ENV_FILE)
  : path.join(REPO_DIR, 'forge', 'server', '.env');

// Snapshot of the real environment BEFORE anything of ours mutates it. A key in
// here can never be overridden by a file — that is what "real env wins" means.
const REAL_ENV = new Set(Object.keys(process.env));

// Parse a dotenv-style file. Returns { exists, file, values } — never throws.
export function parseEnvFile(file) {
  const out = { exists: false, file, values: {} };
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  out.exists = true;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let value = m[2].trim();
    // strip an inline comment only when the value is not quoted
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));
    if (quoted) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    out.values[key] = value;
  }
  return out;
}

export const wiregiEnvFile = parseEnvFile(WIREGI_ENV_FILE);

const inheritRaw =
  process.env.WIREGI_INHERIT_FORGE_ENV ??
  wiregiEnvFile.values.WIREGI_INHERIT_FORGE_ENV ??
  'true';
export const INHERIT_FORGE_ENV = !['false', '0', 'off', 'no'].includes(String(inheritRaw).toLowerCase());

const forgeEnvFile = parseEnvFile(FORGE_ENV_FILE);

// KEY -> 'environment' | 'wiregi/.env' | 'forge/.env (fallback)' | 'blocked'
const sources = {};

function setIfFree(key, value, source) {
  if (REAL_ENV.has(key)) {
    sources[key] = 'environment';
    return false;
  }
  if (key in wiregiEnvFile.values && source !== 'wiregi/.env') return false; // WireGI's own file wins
  process.env[key] = value;
  sources[key] = source;
  return true;
}

function applyWiregi() {
  for (const [key, value] of Object.entries(wiregiEnvFile.values)) {
    if (REAL_ENV.has(key)) {
      sources[key] = 'environment';
      continue;
    }
    process.env[key] = value;
    sources[key] = 'wiregi/.env';
  }
}

function applyForgeFallback() {
  for (const [key, value] of Object.entries(forgeEnvFile.values)) {
    if (INHERIT_FORGE_ENV) setIfFree(key, value, 'forge/.env (fallback)');
    else if (!REAL_ENV.has(key) && !(key in wiregiEnvFile.values) && process.env[key] === undefined) {
      // Fallback disabled: pre-block the key with an empty value so forge's own
      // loader (which skips keys already present) cannot smuggle it in.
      process.env[key] = '';
      sources[key] = 'blocked (fallback off)';
    }
  }
}

// Forge's loader skips keys that are already set — so load order decides who
// wins. WireGI applies first; forge's .env then fills only the gaps.
applyWiregi();
applyForgeFallback();

/**
 * Re-apply WireGI's own values over anything a later import may have written.
 * Safe to call as often as you like — real environment variables are untouched.
 */
export function reassertEnv() {
  applyWiregi();
  return true;
}

export function envSource(key) {
  if (sources[key]) return sources[key];
  if (REAL_ENV.has(key)) return 'environment';
  if (key in wiregiEnvFile.values) return 'wiregi/.env';
  if (key in forgeEnvFile.values) return INHERIT_FORGE_ENV ? 'forge/.env (fallback)' : 'blocked (fallback off)';
  return 'unset';
}

/** Read a value that must come from WireGI's own config, never from Forge. */
export function wiregiValue(key, fallback = undefined) {
  if (REAL_ENV.has(key)) return process.env[key];
  if (key in wiregiEnvFile.values) return wiregiEnvFile.values[key];
  return fallback;
}

export function mask(value) {
  const v = String(value ?? '');
  if (!v) return '';
  if (v.length <= 8) return '••••';
  return `${v.slice(0, 4)}…${v.slice(-2)} (${v.length} chars)`;
}

// Keys the Debug tab reports on. `required` keys are the ones that make a live
// run possible at all — the boot log says so plainly when none is set.
export const TRACKED_KEYS = [
  { key: 'WIREGI_PORT', group: 'server' },
  { key: 'WIREGI_CLIENT_PORT', group: 'server' },
  { key: 'CORS_ORIGIN', group: 'server' },
  { key: 'VELXIO_URL', group: 'velxio' },
  { key: 'VELXIO_SIM_ROUNDS', group: 'velxio' },
  { key: 'DATA_FILE', group: 'server' },
  { key: 'WIREGI_DEBUG', group: 'debug' },
  { key: 'WIREGI_LOG_LEVEL', group: 'debug' },
  { key: 'WIREGI_LOG_PROVIDER_ATTEMPTS', group: 'debug' },
  { key: 'GEMINI_API_KEY', group: 'llm', secret: true },
  { key: 'OPENROUTER_API_KEY', group: 'llm', secret: true },
  { key: 'GROQ_API_KEY', group: 'llm', secret: true },
  { key: 'LLM_API_KEY', group: 'llm', secret: true },
  { key: 'OPENCODE_API_KEY', group: 'llm', secret: true },
  { key: 'OLLAMA_MODEL', group: 'llm' },
  { key: 'AWS_ACCESS_KEY_ID', group: 'llm', secret: true },
  { key: 'PLANNER_PROVIDER', group: 'llm' },
  { key: 'FAILOVER_MAX_ROUNDS', group: 'llm' },
  { key: 'TYPESAFE_API_KEY', group: 'jev', secret: true },
  { key: 'WIREGI_JEV_TIMEOUT_MS', group: 'jev' },
  { key: 'TAVILY_API_KEY', group: 'search', secret: true },
  { key: 'BRAVE_API_KEY', group: 'search', secret: true },
  { key: 'WIREGI_CONCURRENCY', group: 'throughput' },
  { key: 'WIREGI_RPM', group: 'throughput' },
  { key: 'WIREGI_RETRIES', group: 'throughput' },
  { key: 'WIREGI_INHERIT_FORGE_ENV', group: 'env' },
];

// The provider keys that make a live LLM run possible.
export const LLM_KEY_CANDIDATES = [
  'GEMINI_API_KEY',
  'OPENROUTER_API_KEY',
  'GROQ_API_KEY',
  'LLM_API_KEY',
  'OPENCODE_API_KEY',
  'OLLAMA_MODEL',
  'AWS_ACCESS_KEY_ID',
];

/** A machine-readable + UI-renderable picture of the environment. No secrets. */
export function envReport() {
  const keys = TRACKED_KEYS.map((t) => {
    const raw = process.env[t.key];
    const present = raw !== undefined && raw !== '';
    return {
      ...t,
      present,
      source: envSource(t.key),
      value: present ? (t.secret ? mask(raw) : String(raw)) : '',
    };
  });
  const llmPresent = LLM_KEY_CANDIDATES.filter((k) => process.env[k]);
  return {
    files: [
      {
        role: 'wiregi',
        path: WIREGI_ENV_FILE,
        relative: path.relative(REPO_DIR, WIREGI_ENV_FILE),
        exists: wiregiEnvFile.exists,
        keys: Object.keys(wiregiEnvFile.values).length,
      },
      {
        role: 'forge-fallback',
        path: FORGE_ENV_FILE,
        relative: path.relative(REPO_DIR, FORGE_ENV_FILE),
        exists: forgeEnvFile.exists,
        keys: INHERIT_FORGE_ENV ? Object.keys(forgeEnvFile.values).length : 0,
        enabled: INHERIT_FORGE_ENV,
      },
    ],
    inheritForge: INHERIT_FORGE_ENV,
    keys,
    llm: {
      configured: llmPresent.length > 0,
      keys: llmPresent,
      missing: llmPresent.length === 0,
    },
    webSearch: {
      engine: process.env.TAVILY_API_KEY ? 'tavily' : process.env.BRAVE_API_KEY ? 'brave' : null,
    },
    jev: { configured: Boolean(process.env.TYPESAFE_API_KEY) },
  };
}

/** One-line-per-file boot summary for humans reading the terminal. */
export function envBootLines() {
  const r = envReport();
  const lines = [];
  for (const f of r.files) {
    lines.push(
      `  ENV       ${f.role === 'wiregi' ? 'wiregi' : 'fallback'} ${f.relative} — ${
        f.exists ? (f.enabled === false ? 'present (fallback off)' : `${f.keys} key(s)`) : 'not found'
      }`,
    );
  }
  lines.push(
    `  KEYS      llm=${r.llm.configured ? r.llm.keys.join(',') : 'NONE — runs will fail at the first LLM call'} · jev=${
      r.jev.configured ? 'typesafe' : 'llm-fallback'
    } · web=${r.webSearch.engine || 'off (model knowledge)'}`,
  );
  return lines;
}
