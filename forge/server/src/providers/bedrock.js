// Forge — Bedrock planner (AWS Bedrock Converse API).
//
// Converse is model-agnostic (Claude, Nova, Llama, …) — one request shape,
// unified response. Requests are SigV4-signed locally (providers/sigv4.js),
// so there is no AWS SDK dependency.

import { signV4 } from './sigv4.js';
import { PLANNER_SYSTEM_PROMPT, plannerUserPrompt } from './plannerPrompt.js';
import { parsePlanText } from './failover.js';

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
    if (!res.ok) {
      const text = await res.text();
      // Native Converse answers 400 "Operation not allowed" for models it does
      // not serve (Moonshot/Kimi ids exist only on the Mantle gateway, which
      // Forge deliberately does not speak). Name the fix, not just the body.
      if (res.status === 400 && (/not allowed/i.test(text) || /kimi|moonshot/i.test(modelId))) {
        throw new Error(`Bedrock Converse does not serve "${modelId}" in ${b.region} (HTTP 400: ${text.slice(0, 160)}). ` +
          'Kimi/Moonshot models are Mantle-gateway-only and unsupported here — set BEDROCK_MODEL to a Converse-served id (anthropic.claude-*, amazon.nova-*).');
      }
      throw new Error(`Bedrock converse ${res.status}: ${text}`);
    }
    const data = await res.json();
    return parsePlanText(String(data?.output?.message?.content?.[0]?.text ?? ''));
  };
}
