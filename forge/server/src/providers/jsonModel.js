// One configured model for memory extraction, response generation, and repair.
// JEV is a separate structured-decision provider, never a prose generator.
import { signV4 } from './sigv4.js';
export function parseJson(text) {
  return JSON.parse(String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
}
export function createJsonModel(cfg) {
  return async (system, input) => {
    const user = JSON.stringify(input);
    let res;
    if (cfg.planner.provider === 'bedrock') {
      const b = cfg.bedrock;
      const url = `${b.endpoint || `https://bedrock-runtime.${b.region}.amazonaws.com`}/model/${b.model}/converse`;
      const body = JSON.stringify({ system: [{ text: system }], messages: [{ role: 'user', content: [{ text: user }] }], inferenceConfig: { maxTokens: 8192, temperature: 0.2 } });
      const headers = signV4({ method: 'POST', url, region: b.region, service: 'bedrock', accessKeyId: b.accessKeyId, secretAccessKey: b.secretAccessKey, sessionToken: b.sessionToken || undefined, payload: body, headers: { 'content-type': 'application/json' } });
      res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(90000) });
    } else {
      res = await fetch(`${cfg.planner.apiBase}/chat/completions`, {
        method: 'POST', signal: AbortSignal.timeout(90000),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.planner.apiKey}` },
        body: JSON.stringify({ model: cfg.planner.model, temperature: 0.2, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
      });
    }
    if (!res.ok) {
      let detail = '';
      try { detail = ` — ${(await res.text()).slice(0, 500)}`; } catch { /* body already consumed or unreadable */ }
      throw new Error(`Generation provider returned HTTP ${res.status}${detail}. No project changes were saved.`);
    }
    const data = await res.json();
    const text = cfg.planner.provider === 'bedrock' ? data.output?.message?.content?.filter(c => c.text).map(c => c.text).join('\n') : data.choices?.[0]?.message?.content;
    return parseJson(text);
  };
}
