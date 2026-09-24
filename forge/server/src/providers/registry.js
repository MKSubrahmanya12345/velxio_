// Forge — provider key registry.
//
// Keys added from the Providers page live here, next to the project store, so
// the memory pipeline can switch between them at runtime without a restart.
// Credentials are stored exactly as entered (this server has no authentication —
// see README "Providers and keys" before exposing an instance).
//
// `.env` credentials are merged in as read-only entries with stable ids
// (`env:llm`, `env:bedrock`) so an existing setup keeps working and stays
// visible in the UI. Their note/enabled/model/base can be overridden here; the
// secret material always comes from the environment.

import fs from 'node:fs';
import path from 'node:path';

import { describeCatalog, envEntries, providerDefinition, validateCredentials } from './catalog.js';
import { createPlanner } from './planner.js';
import { createReasoner } from '../memory/reasoner.js';

export const DEFAULT_FAILOVER = { enabled: true, maxRounds: 10, retryRejected: false };
const LOG_LIMIT = 40;
const NOTE_LIMIT = 240;

export function newStats() {
  return { calls: 0, ok: 0, failures: 0, consecutiveFailures: 0, lastStatus: null, lastError: '', lastErrorAt: null, lastUsedAt: null, lastLatencyMs: null };
}

function clampRounds(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_FAILOVER.maxRounds;
  return Math.min(25, Math.max(1, Math.round(n)));
}

function normalizeStats(raw) {
  const base = newStats();
  if (!raw || typeof raw !== 'object') return base;
  return {
    calls: Number(raw.calls) || 0,
    ok: Number(raw.ok) || 0,
    failures: Number(raw.failures) || 0,
    consecutiveFailures: Number(raw.consecutiveFailures) || 0,
    lastStatus: raw.lastStatus === null || raw.lastStatus === undefined ? null : Number(raw.lastStatus),
    lastError: String(raw.lastError || ''),
    lastErrorAt: raw.lastErrorAt ? String(raw.lastErrorAt) : null,
    lastUsedAt: raw.lastUsedAt ? String(raw.lastUsedAt) : null,
    lastLatencyMs: raw.lastLatencyMs === null || raw.lastLatencyMs === undefined ? null : Number(raw.lastLatencyMs),
  };
}

// A stored key entry. `origin: 'env'` entries are derived from the environment
// on every load and carry only an overlay of user-editable fields.
function normalizeKey(raw, id) {
  const provider = String(raw?.provider || '');
  const def = providerDefinition(provider);
  const origin = raw?.origin === 'env' ? 'env' : 'user';
  return {
    id: String(raw?.id || id),
    provider,
    providerLabel: def.label,
    note: String(raw?.note || '').slice(0, NOTE_LIMIT),
    apiKey: String(raw?.apiKey || ''),
    secret: String(raw?.secret || ''),
    sessionToken: String(raw?.sessionToken || ''),
    region: String(raw?.region || ''),
    baseUrl: String(raw?.baseUrl ?? def.defaultBase ?? ''),
    model: String(raw?.model || def.defaultModel),
    enabled: raw?.enabled !== false,
    origin,
    createdAt: String(raw?.createdAt || new Date().toISOString()),
    updatedAt: String(raw?.updatedAt || new Date().toISOString()),
    stats: normalizeStats(raw?.stats),
  };
}

export class ProviderRegistry {
  constructor(cfg = {}) {
    const providers = cfg.providers || {};
    this.file = path.resolve(providers.dataFile || './data/providers.json');
    this.cfg = cfg;
    this.keys = [];          // user-added entries, in insertion order
    this.overlays = {};      // id → { note, enabled, model, baseUrl } for env entries
    this.envStats = {};      // id → stats for env entries
    this.removedEnv = [];    // env ids the user deleted from the list
    this.activeId = '';
    this.failover = { ...DEFAULT_FAILOVER };
    this.log = [];
    this.writeQueue = Promise.resolve();
  }

  async init() {
    let parsed = null;
    try {
      parsed = JSON.parse(await fs.promises.readFile(this.file, 'utf8'));
    } catch (error) {
      // A missing file just means "no keys added yet". Anything else is refused:
      // silently dropping a registry would delete working credentials.
      if (error.code !== 'ENOENT') throw error;
    }
    if (parsed && typeof parsed === 'object') {
      const rawKeys = Array.isArray(parsed.keys) ? parsed.keys : [];
      this.keys = [];
      for (const raw of rawKeys) {
        try {
          if (raw?.origin === 'env') continue; // env entries are always re-derived
          if (raw?.provider) this.keys.push(normalizeKey(raw));
        } catch { /* an entry for a provider this build no longer knows is skipped */ }
      }
      this.overlays = parsed.overlays && typeof parsed.overlays === 'object' ? parsed.overlays : {};
      this.envStats = parsed.envStats && typeof parsed.envStats === 'object' ? parsed.envStats : {};
      this.removedEnv = Array.isArray(parsed.removedEnv) ? parsed.removedEnv.map(String) : [];
      this.activeId = String(parsed.activeId || '');
      this.failover = {
        enabled: parsed.failover?.enabled !== false,
        maxRounds: clampRounds(parsed.failover?.maxRounds ?? DEFAULT_FAILOVER.maxRounds),
        retryRejected: Boolean(parsed.failover?.retryRejected),
      };
      this.log = Array.isArray(parsed.log) ? parsed.log.slice(-LOG_LIMIT) : [];
    }
    // Select the first enabled credential when nothing is selected yet (or the
    // stored selection no longer exists / was disabled).
    if (!this.get(this.activeId)?.enabled) {
      this.activeId = this.candidates()[0]?.id || '';
    }
    return this;
  }

  /**
   * Credentials sidelined by a permanent failure (401/403/404) — see
   * `permanentRejections()` in failover.js. Clearing them makes the next call
   * retry everything, which is what you want after fixing a key or a model name.
   */
  clearPermanentRejections() {
    this.permanentRejections = new Map();
    return this;
  }

  async _commit(update) {
    const write = this.writeQueue.catch(() => {}).then(async () => {
      const snapshot = {
        version: 1,
        activeId: this.activeId,
        failover: { ...this.failover },
        keys: this.keys,
        overlays: this.overlays,
        envStats: this.envStats,
        removedEnv: this.removedEnv,
        log: this.log.slice(-LOG_LIMIT),
      };
      const result = update ? update(snapshot) : snapshot;
      await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      await fs.promises.writeFile(tmp, JSON.stringify(result, null, 2));
      await fs.promises.rename(tmp, this.file);
      return result;
    });
    this.writeQueue = write;
    return write;
  }

  // Everything the UI shows: user keys first, then live .env entries.
  entries() {
    const env = providersFromEnv(this.cfg)
      .filter(entry => !this.removedEnv.includes(entry.id))
      .map(entry => {
        const overlay = this.overlays[entry.id] || {};
        return {
          ...entry,
          note: overlay.note ?? entry.note,
          enabled: overlay.enabled ?? entry.enabled,
          model: overlay.model || entry.model,
          baseUrl: overlay.baseUrl ?? entry.baseUrl,
          stats: normalizeStats(this.envStats[entry.id]),
        };
      });
    return [...this.keys, ...env];
  }

  get(id) {
    return this.entries().find(k => k.id === id) || null;
  }

  // Failover order: the selected key first, then its provider's other keys, then
  // every remaining enabled key. The runner loops this list, round after round.
  candidates() {
    const enabled = this.entries().filter(k => k.enabled);
    const active = enabled.find(k => k.id === this.activeId);
    if (!active) return enabled;
    const siblings = enabled.filter(k => k.id !== active.id && k.provider === active.provider);
    const rest = enabled.filter(k => k.id !== active.id && k.provider !== active.provider);
    return [active, ...siblings, ...rest];
  }

  async add(input = {}) {
    const provider = String(input.provider || '').trim();
    providerDefinition(provider);
    const creds = validateCredentials(provider, input);
    const note = String(input.note ?? '').trim().slice(0, NOTE_LIMIT);
    const now = new Date().toISOString();
    const entry = normalizeKey({
      id: `pk_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`,
      provider,
      note,
      ...creds,
      enabled: input.enabled !== false,
      origin: 'user',
      createdAt: now,
      updatedAt: now,
      stats: newStats(),
    });
    this.keys.push(entry);
    // The first working credential becomes the selected one automatically.
    if (!this.activeId || !this.get(this.activeId)) this.activeId = entry.id;
    await this._commit();
    return entry;
  }

  async update(id, patch = {}) {
    const existing = this.get(id);
    if (!existing) throw Object.assign(new Error('No such key.'), { status: 404 });

    if (existing.origin === 'env') {
      // Credentials stay in .env; everything else is an overlay here.
      const rejected = ['apiKey', 'secret', 'sessionToken', 'region'].filter(f => patch[f] !== undefined && String(patch[f]).trim() !== existing[f]);
      if (rejected.length) {
        throw Object.assign(new Error(`This key comes from .env — edit forge/server/.env to change ${rejected.join(', ')}. Note, model, base URL, and enabled can be changed here.`), { status: 400 });
      }
      const overlay = { ...(this.overlays[id] || {}) };
      if (patch.note !== undefined) overlay.note = String(patch.note).trim().slice(0, NOTE_LIMIT);
      if (patch.enabled !== undefined) overlay.enabled = Boolean(patch.enabled);
      if (patch.model !== undefined) overlay.model = String(patch.model).trim() || providerDefinition(existing.provider).defaultModel;
      if (patch.baseUrl !== undefined) overlay.baseUrl = String(patch.baseUrl).trim().replace(/\/+$/, '');
      this.overlays[id] = overlay;
      if (overlay.enabled === false && this.activeId === id) this.activeId = this.candidates().find(k => k.id !== id)?.id || '';
      await this._commit();
      return this.get(id);
    }

    const index = this.keys.findIndex(k => k.id === id);
    const next = { ...existing };
    if (patch.note !== undefined) next.note = String(patch.note).trim().slice(0, NOTE_LIMIT);
    if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled);
    const touchedCredentials = ['apiKey', 'secret', 'sessionToken', 'region', 'baseUrl', 'model'].some(f => patch[f] !== undefined);
    if (touchedCredentials) {
      const merged = validateCredentials(next.provider, {
        apiKey: patch.apiKey ?? next.apiKey,
        secret: patch.secret ?? next.secret,
        sessionToken: patch.sessionToken ?? next.sessionToken,
        region: patch.region ?? next.region,
        baseUrl: patch.baseUrl ?? next.baseUrl,
        model: patch.model ?? next.model,
      });
      Object.assign(next, merged);
    }
    next.updatedAt = new Date().toISOString();
    if (next.enabled === false && this.activeId === id) this.activeId = this.candidates().find(k => k.id !== id)?.id || '';
    this.keys[index] = next;
    await this._commit();
    return next;
  }

  async remove(id) {
    const existing = this.get(id);
    if (!existing) throw Object.assign(new Error('No such key.'), { status: 404 });
    if (existing.origin === 'env') {
      // The overlay (note/model/enabled) is kept: restoring the .env entry
      // brings it back the way the user left it.
      this.removedEnv = [...new Set([...this.removedEnv, id])];
    } else {
      this.keys = this.keys.filter(k => k.id !== id);
    }
    if (this.activeId === id) this.activeId = this.candidates()[0]?.id || '';
    await this._commit();
    return { ok: true, activeId: this.activeId };
  }

  async setActive(id) {
    const entry = this.get(id);
    if (!entry) throw Object.assign(new Error('No such key.'), { status: 404 });
    if (!entry.enabled) throw Object.assign(new Error('That key is disabled. Enable it before selecting it.'), { status: 400 });
    this.activeId = entry.id;
    await this._commit();
    return entry;
  }

  async setFailover(patch = {}) {
    if (patch.enabled !== undefined) this.failover.enabled = Boolean(patch.enabled);
    if (patch.maxRounds !== undefined) this.failover.maxRounds = clampRounds(patch.maxRounds);
    if (patch.retryRejected !== undefined) this.failover.retryRejected = Boolean(patch.retryRejected);
    await this._commit();
    return { ...this.failover };
  }

  async restoreEnv() {
    this.removedEnv = [];
    await this._commit();
    return this.entries();
  }

  async recordSuccess(id, { latencyMs = null, operation = 'generate' } = {}) {
    this._applyStats(id, stats => {
      stats.calls += 1;
      stats.ok += 1;
      stats.consecutiveFailures = 0;
      stats.lastStatus = 200;
      stats.lastError = '';
      stats.lastUsedAt = new Date().toISOString();
      stats.lastLatencyMs = latencyMs;
    });
    await this.pushLog({ at: new Date().toISOString(), keyId: id, outcome: 'ok', operation, latencyMs });
  }

  async recordFailure(id, { status = null, message = '', permanent = false, round = 0, attempt = 0, operation = 'generate' } = {}) {
    this._applyStats(id, stats => {
      stats.calls += 1;
      stats.failures += 1;
      stats.consecutiveFailures += 1;
      stats.lastStatus = status;
      stats.lastError = String(message || '').slice(0, 400);
      stats.lastErrorAt = new Date().toISOString();
    });
    await this.pushLog({ at: new Date().toISOString(), keyId: id, outcome: 'error', status, message: String(message || '').slice(0, 400), permanent, round, attempt, operation });
  }

  _applyStats(id, mutate) {
    const key = this.keys.find(k => k.id === id);
    if (key) { mutate(key.stats); key.stats = { ...key.stats }; return; }
    const stats = normalizeStats(this.envStats[id]);
    mutate(stats);
    this.envStats[id] = stats;
  }

  async pushLog(record) {
    const entry = this.get(record.keyId);
    this.log = [...this.log, { ...record, provider: entry?.provider || '', note: entry?.note || '' }].slice(-LOG_LIMIT);
    await this._commit();
  }

  state() {
    const keys = this.entries();
    const active = keys.find(k => k.id === this.activeId) || null;
    const order = this.candidates();
    return {
      catalog: describeCatalog(),
      keys,
      activeId: this.activeId,
      active: active ? { id: active.id, provider: active.provider, label: providerDefinition(active.provider).label, model: active.model, note: active.note } : null,
      failover: { ...this.failover },
      order: order.map(k => ({ id: k.id, provider: k.provider, note: k.note, model: k.model })),
      log: this.log,
      storage: { file: this.file },
      configured: order.length > 0,
      env: {
        llm: Boolean(this.cfg.providers?.envDefaults?.planner?.apiKey),
        bedrock: Boolean(this.cfg.providers?.envDefaults?.bedrock?.accessKeyId),
      },
    };
  }
}

// `.env` credentials → registry entries (read-only credential material).
// Every ready env provider is seeded, so an existing .env setup keeps working
// and takes part in the same failover loop as keys added in the UI.
function providersFromEnv(cfg = {}) {
  return envEntries(cfg).map(raw => normalizeKey({ ...raw, enabled: true }, raw.id));
}

export async function createProviderRegistry(cfg = {}) {
  const registry = new ProviderRegistry(cfg);
  await registry.init();
  return registry;
}


// ── Config-level helpers ─────────────────────────────────────────────────────
// The generation providers that are ready straight from the environment. These
// mirror the registry's `.env` entries for callers that only have a config
// object (tests, scripts, and per-request provider overrides).

export function listProviders(cfg) {
  return (cfg?.generators || []).filter(g => g.ready).map(({ id, name, model, type }) => ({ id, name, model, type }));
}

// A sub-config that points the shared LLM/Bedrock request path at one provider.
// Returns null for a provider that is not ready — never a fallback.
export function providerConfig(cfg, provider) {
  const g = (cfg?.generators || []).find(p => p.id === provider);
  if (!g || !g.ready) return null;
  return {
    ...cfg,
    planner: { provider: g.id, apiKey: g.apiKey, model: g.model, apiBase: g.apiBase },
  };
}

export function plannerFor(cfg, provider) {
  const sub = providerConfig(cfg, provider);
  return sub ? createPlanner(sub) : null;
}

export function reasonerFor(cfg, provider) {
  const sub = providerConfig(cfg, provider);
  return sub ? createReasoner(sub) : null;
}

export function unresolvedError(provider, cfg, keys = []) {
  const ids = keys.filter(k => k.enabled).map(k => k.id);
  const available = [...listProviders(cfg).map(p => p.id), ...ids];
  const avail = available.length ? [...new Set(available)].join(', ') : 'none';
  return (
    `Generation provider '${provider}' is not configured. Configured providers: ${avail}. ` +
    'Add its key on the Providers page, or set its API key (or OLLAMA_MODEL) in forge/server/.env.'
  );
}
