// Forge — planner provider factory (legacy structured-build pipeline).
//
// Contract: plan(goal, constraints, feasibility) → RAW plan object
// { phases, bom, acceptance } — always coerced by sanitizePlan() downstream.
//
// Resolution order:
//   1. the provider registry (keys added on the Providers page, or seeded from
//      .env) — run through the same failover loop as generation, so a failing
//      provider/key switches to the next one instead of failing the build;
//   2. the .env-only path below (PLANNER_PROVIDER=llm|bedrock), kept for direct
//      config construction in scripts and tests.
//
// Providers are live only. When neither source has a usable credential the call
// throws with the exact reason — nothing fabricates a plan.

import { createBedrockPlanner } from './bedrock.js';
import { PLANNER_SYSTEM_PROMPT, plannerUserPrompt } from './plannerPrompt.js';
import { callProviderEntry, parsePlanText, runWithFailover } from './failover.js';

export function createPlanner(cfg, { registry, emit, fetchImpl, prefer } = {}) {
  return async function plan(goal, constraints, feasibility) {
    if (registry?.candidates?.().length) {
      const user = plannerUserPrompt(goal, constraints, feasibility);
      const { result } = await runWithFailover({
        registry,
        emit,
        operation: 'plan',
        fetchImpl,
        prefer,
        work: async entry => parsePlanText(await callProviderEntry(entry, { system: PLANNER_SYSTEM_PROMPT, user, temperature: 0.3, fetchImpl })),
      });
      return result;
    }
    return envPlanner(cfg)(goal, constraints, feasibility);
  };
}

// The original single-provider factory. Resolution is lazy so the server can
// boot with no credentials yet and report the precise reason on the first call.
export function envPlanner(cfg) {
  if (cfg.planner.provider === 'bedrock') return createBedrockPlanner(cfg);
  if (cfg.planner.provider === 'llm' && cfg.planner.apiKey) return llmPlanner(cfg);
  return () => {
    throw new Error(
      'Planner/generator: no live provider configured. Add a key on the Providers page (Gemini, OpenRouter, ' +
      'AWS Bedrock, or Ollama), or set PLANNER_PROVIDER=llm with LLM_API_KEY / PLANNER_PROVIDER=bedrock with AWS ' +
      'credentials in forge/server/.env. Mocks were removed — planning only runs against a real model.'
    );
  };
}

function llmPlanner(cfg) {
  return async function plan(goal, constraints, feasibility) {
    const res = await fetch(`${cfg.planner.apiBase}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.planner.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.planner.model,
        temperature: 0.3,
        messages: [
          { role: 'system', content: PLANNER_SYSTEM_PROMPT },
          { role: 'user', content: plannerUserPrompt(goal, constraints, feasibility) },
        ],
      }),
    });
    if (!res.ok) throw new Error(`LLM planner ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return parsePlanText(String(data.choices?.[0]?.message?.content || ''));
  };
}
