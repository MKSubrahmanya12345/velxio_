// One configured model for memory extraction, response generation, and repair.
// JEV is a separate structured-decision provider, never a prose generator.
//
// When a provider registry is supplied, every call is resolved through it: the
// selected key runs first and any error switches to the next provider/key,
// looping until one succeeds or the round budget is exhausted (providers/
// failover.js). Without a registry the original .env-only path is used.
import { signV4 } from './sigv4.js';
import { callProviderEntry, runWithFailover } from './failover.js';

export function parseJson(text) {
  return JSON.parse(String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
}

export function createJsonModel(cfg, { registry, emit, operation = 'generate', fetchImpl } = {}) {
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
        work: async entry => parseJson(await callProviderEntry(entry, { system, user, fetchImpl })),
      });
      return result;
    }

    let res;
    if (cfg.planner.provider === 'bedrock') {
      const b = cfg.bedrock;
      const url = `${b.endpoint || `https://bedrock-runtime.${b.region}.amazonaws.com`}/model/${encodeURIComponent(b.model)}/converse`;
      const body = JSON.stringify({ system: [{ text: system }], messages: [{ role: 'user', content: [{ text: user }] }], inferenceConfig: { maxTokens: 8192, temperature: 0.2 } });
      const headers = signV4({ method: 'POST', url, region: b.region, service: 'bedrock', accessKeyId: b.accessKeyId, secretAccessKey: b.secretAccessKey, sessionToken: b.sessionToken || undefined, payload: body, headers: { 'content-type': 'application/json' } });
      res = await (fetchImpl || fetch)(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(90000) });
    } else {
      res = await (fetchImpl || fetch)(`${cfg.planner.apiBase}/chat/completions`, {
        method: 'POST', signal: AbortSignal.timeout(90000),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.planner.apiKey}` },
        body: JSON.stringify({ model: cfg.planner.model, temperature: 0.2, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
      });
    }
    if (!res.ok) throw new Error(`Generation provider returned HTTP ${res.status}. No project changes were saved.`);
    const data = await res.json();
    const text = cfg.planner.provider === 'bedrock' ? data.output?.message?.content?.filter(c => c.text).map(c => c.text).join('\n') : data.choices?.[0]?.message?.content;
    return parseJson(text);
  };
}

// Which generation provider a turn actually used, for badges and message meta.
export function activeGeneratorLabel(registry, cfg) {
  const active = registry?.get?.(registry.activeId);
  if (active) return `${active.provider}${active.note ? `:${active.note}` : ''}`;
  return cfg?.planner?.provider || 'unconfigured';
}
