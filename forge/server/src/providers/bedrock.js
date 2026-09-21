// Forge — Bedrock planner (AWS Bedrock Converse API).
//
// Converse is model-agnostic (Claude, Nova, Llama, …) — one request shape,
// unified response. Requests are SigV4-signed locally (providers/sigv4.js),
// so there is no AWS SDK dependency.

import { signV4 } from './sigv4.js';
import { PLANNER_SYSTEM_PROMPT, plannerUserPrompt } from './plannerPrompt.js';

export function createBedrockPlanner(cfg) {
  const b = cfg.bedrock;
  return async function plan(goal, constraints, feasibility) {
    const modelId = String(b.model || '').replace(/^\/+/, '');
    const base = b.endpoint || `https://bedrock-runtime.${b.region}.amazonaws.com`;
    const url = `${base}/model/${modelId}/converse`;

    const body = JSON.stringify({
      system: [{ text: PLANNER_SYSTEM_PROMPT }],
      messages: [
        { role: 'user', content: [{ text: plannerUserPrompt(goal, constraints, feasibility) }] },
      ],
      inferenceConfig: { maxTokens: 8192, temperature: 0.3 },
    });

    const headers = signV4({
      method: 'POST',
      url,
      region: b.region,
      service: 'bedrock',
      accessKeyId: b.accessKeyId,
      secretAccessKey: b.secretAccessKey,
      sessionToken: b.sessionToken || undefined,
      payload: body,
      headers: { 'content-type': 'application/json' },
    });

    const res = await fetch(url, { method: 'POST', headers, body });
    if (!res.ok) throw new Error(`Bedrock converse ${res.status}: ${await res.text()}`);
    const data = await res.json();
    let text = String(data?.output?.message?.content?.[0]?.text ?? '');
    text = text.replace(/^```(json)?/i, '').replace(/```$/, '').trim();
    return JSON.parse(text);
  };
}
