// One configured model for memory extraction, response generation, and repair.
// JEV is a separate structured-decision provider, never a prose generator.
//
// When a provider registry is supplied, every call is resolved through it: the
// selected key runs first and any error switches to the next provider/key,
// looping until one succeeds or the round budget is exhausted (providers/
// failover.js). Without a registry the original .env-only path is used.
import { envEntries } from './catalog.js';
import { callProviderEntry, runWithFailover } from './failover.js';

export function parseJson(text) {
  return JSON.parse(String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
}

export function createJsonModel(cfg, { registry, emit, operation = 'generate', fetchImpl, prefer } = {}) {
  return async (system, input) => {
    const user = JSON.stringify(input);

    if (registry?.candidates?.().length) {
      // JSON parsing happens inside the attempt: a model that answers with prose
      // is a failed attempt, so the next provider/key gets the same prompt.
      const { result } = await runWithFailover({
        registry,
        emit,
        operation,
        fetchImpl,
        prefer,
        work: async entry => parseJson(await callProviderEntry(entry, { system, user, fetchImpl })),
      });
      return result;
    }

    if (cfg.planner.provider === 'bedrock') {
      // Same request/response shapes as the registry path: Converse, or the
      // Bedrock Mantle gateway for Kimi/Moonshot ids (catalog.js).
      const entry = envEntries(cfg).find(e => e.id === 'env:bedrock');
      if (!entry) throw new Error('Bedrock needs AWS_REGION, AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in forge/server/.env. No project changes were saved.');
      return parseJson(await callProviderEntry(entry, { system, user, fetchImpl }));
    }

    const res = await (fetchImpl || fetch)(`${cfg.planner.apiBase}/chat/completions`, {
      method: 'POST', signal: AbortSignal.timeout(90000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.planner.apiKey}` },
      body: JSON.stringify({ model: cfg.planner.model, temperature: 0.2, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
    });
    if (!res.ok) {
      let detail = '';
      try { detail = ` — ${(await res.text()).slice(0, 500)}`; } catch { /* body already consumed or unreadable */ }
      throw new Error(`Generation provider returned HTTP ${res.status}${detail}. No project changes were saved.`);
    }
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content;
    return parseJson(text);
  };
}

// Which generation provider a turn actually used, for badges and message meta.
export function activeGeneratorLabel(registry, cfg) {
  const active = registry?.get?.(registry.activeId);
  if (active) return `${active.provider}${active.note ? `:${active.note}` : ''}`;
  return cfg?.planner?.provider || 'unconfigured';
}
